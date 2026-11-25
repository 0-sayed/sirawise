import type { ResumeCreateInput } from "../resume/service";
import type { ModelPayload, ModelPayloadInput } from "./payload";
import type { WriterRouteApproval } from "./writer-policy";
import type { OwnerTransaction } from "@reactive-resume/db/owner-scope";
import type { AiAvailability, OperationRequest, RouteBinding } from "@reactive-resume/schema/ai-operation";
import type { ResumeCreationKind } from "@reactive-resume/schema/ai-usage";
import type { WithheldReviewItems } from "@reactive-resume/schema/resume/ai-review";
import type { z } from "zod";
import { AsyncLocalStorage } from "node:async_hooks";
import { createHash } from "node:crypto";
import { ORPCError } from "@orpc/client";
import { and, eq, isNull } from "drizzle-orm";
import { withOwnerDatabase } from "@reactive-resume/db/owner-scope";
import { aiProcessingConsent } from "@reactive-resume/db/schema";
import { resolveReviewVerifierRoutes } from "./verifier-policy";
import { resolveWriterRoute } from "./writer-policy";

export type ReasoningEffort = "none" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

export const extendedReviewTiming = { callTimeoutMs: 90_000, deadlineMs: 240_000 } as const;
export const extendedTranslationDeadlineMs = 300_000;

export type ApprovedRoute = RouteBinding & {
	/** Additional exact writer/effort approvals in this same versioned consent/config bundle. */
	writers?: readonly WriterRouteApproval[];
	/** Explicitly approved cross-family verification in this consent/config bundle. */
	verifier?:
		| {
				evidenceVersion: string;
				maxCallCostMicros: number;
				maxOutputTokens?: number;
				boundByTogetherPricing?: boolean;
				policy?: import("./verifier-policy").VerifierPolicy;
				backup?: import("./verifier-policy").VerifierBackupBinding | null;
		  }
		| undefined;
	endpoint: string;
	model: string;
	downstreamProvider: string;
	providerEndpoint?: string;
	precision?: "bf16" | "fp16" | "fp32";
	apiKey: string;
	noticeVersion: string;
	evidenceVersion: string;
	maxCalls: number;
	maxRepairs: number;
	callTimeoutMs: number;
	extendJobAndTranslationTiming?: boolean;
	/** Resolved only for the approved Together verifier. */
	boundByTogetherPricing?: boolean;
	/** Reviewed translation writer/verifier allowance; other operation timeouts stay unchanged. */
	translationCallTimeoutMs?: number;
	/** One bounded, known-cost transient retry per writer/verifier step. */
	transientRetries?: number;
	/** Legacy translation configuration alias, retained for existing approved bundles. */
	translationTransientRetries?: number;
	deadlineMs: number;
	maxInputCodePoints: number;
	/** Visible-output allowance; completionTokenLimit includes reasoning overhead. */
	maxOutputTokens: number;
	/** Explicit completion allowance for a large verifier response; visible writer limits stay unchanged. */
	completionTokenCap?: number;
	reasoningEffort?: ReasoningEffort;
	requestCapMicros: number;
	/** Reviewed conservative per-call bound from exact model pricing and input/output limits. */
	maxCallCostMicros: number;
	dayCapMicros: number;
};

export function withMeasuredReviewExecution(route: ApprovedRoute): ApprovedRoute {
	return {
		...route,
		extendJobAndTranslationTiming: true,
		...(route.verifier ? { verifier: { ...route.verifier, boundByTogetherPricing: true } } : {}),
	};
}
const visiblePercent = { none: 100, minimal: 90, low: 80, medium: 50, high: 20, xhigh: 5, max: 5 };

/** Narrow both limits so reasoning cannot consume more than the completion ceiling. */
export function capVerifierCompletion(route: ApprovedRoute, ceiling: number): ApprovedRoute {
	if (completionTokenLimit(route) <= ceiling) return route;
	return {
		...route,
		maxOutputTokens: Math.min(
			route.maxOutputTokens,
			Math.floor((ceiling * visiblePercent[route.reasoningEffort ?? "none"]) / 100),
		),
		completionTokenCap: ceiling,
	};
}

/** Effort allocations are OpenRouter approximations, not a guarantee of visible output. */
export function completionTokenLimit(
	route: Pick<ApprovedRoute, "maxOutputTokens" | "reasoningEffort" | "completionTokenCap">,
): number {
	const effort = route.reasoningEffort ?? "none";
	if (
		!Object.hasOwn(visiblePercent, effort) ||
		!Number.isSafeInteger(route.maxOutputTokens) ||
		route.maxOutputTokens <= 0 ||
		route.maxOutputTokens > 16384
	)
		throw new Error("AI_INVALID_OUTPUT_LIMIT");
	const scaled = Math.ceil((route.maxOutputTokens * 100) / visiblePercent[effort]);
	if (
		route.completionTokenCap !== undefined &&
		(!Number.isSafeInteger(route.completionTokenCap) ||
			route.completionTokenCap < scaled ||
			route.completionTokenCap > 12288)
	)
		throw new Error("AI_INVALID_OUTPUT_LIMIT");
	return route.completionTokenCap ?? scaled;
}

export type OperationHandler = {
	verifier?: {
		output: z.ZodType<Record<string, unknown>>;
		/** Bind a structured verifier response to the IDs in the prepared task. */
		outputForPayload?: (
			payload: ModelPayload,
			options?: { allowMissingDecisions: boolean },
		) => z.ZodType<Record<string, unknown>>;
		/** A truncated batch contributes no decisions while other batches remain usable. */
		withholdTruncatedBatch?: true;
		systemPrompt: string;
		buildInput: (payload: ModelPayload, output: Record<string, unknown>) => ModelPayload;
		validate: (output: Record<string, unknown>, verdict: unknown) => Record<string, unknown> | void;
		/** Source-aware verification is reloaded inside the worker's fenced transaction. */
		validateInContext?: (
			tx: OwnerTransaction,
			ownerId: string,
			request: OperationRequest,
			output: Record<string, unknown>,
			verdict: unknown,
			options?: { allowSegmentWithholding?: boolean },
		) => Promise<Record<string, unknown> | void>;
		buildInputInContext?: (
			tx: OwnerTransaction,
			ownerId: string,
			request: OperationRequest,
			output: Record<string, unknown>,
			options?: { allowSegmentWithholding?: boolean },
		) => Promise<ModelPayload>;
		buildBatchesInContext?: (
			tx: OwnerTransaction,
			ownerId: string,
			request: OperationRequest,
			output: Record<string, unknown>,
			options?: { allowSegmentWithholding?: boolean },
		) => Promise<{
			batches: Array<{ output: Record<string, unknown>; payload: ModelPayload; itemIds: string[] }>;
			oversizeWithheld?: { count: number; rules: string[] } | undefined;
		}>;
		validateBatchInContext?: (
			tx: OwnerTransaction,
			ownerId: string,
			request: OperationRequest,
			output: Record<string, unknown>,
			batchIndex: number,
			verdict: unknown,
			options?: { allowSegmentWithholding?: boolean; allowMissingDecisions?: boolean },
		) => Promise<void>;
		validateBatchesInContext?: (
			tx: OwnerTransaction,
			ownerId: string,
			request: OperationRequest,
			output: Record<string, unknown>,
			verdicts: unknown[],
			options?: { allowSegmentWithholding?: boolean },
		) => Promise<{
			output: Record<string, unknown>;
			withheld?: WithheldReviewItems | undefined;
			batchCount: number;
		}>;
	};
	systemPrompt?: string;
	validateResult?: (
		tx: OwnerTransaction,
		ownerId: string,
		request: OperationRequest,
		output: Record<string, unknown>,
		options?: { allowSegmentWithholding?: boolean },
	) => Promise<Record<string, unknown>>;
	validateCandidate?: OperationHandler["validateResult"];
	validateDelivery?: OperationHandler["validateResult"];
	deliveryOutput?: OperationHandler["output"];
	translationPlanVersion?: "compact-v1";
	validateRequest?: (tx: OwnerTransaction, ownerId: string, request: OperationRequest) => Promise<void>;
	promptVersion: string;
	schemaVersion: string;
	parameters: z.ZodType<Record<string, unknown>>;
	output: z.ZodType<Record<string, unknown>>;
	buildInput: (ownerId: string, request: OperationRequest, signal?: AbortSignal) => Promise<ModelPayloadInput>;
	/** Already minimized structured input; never run a prose scrubber over serialized IDs. */
	buildPayload?: (ownerId: string, request: OperationRequest, signal?: AbortSignal) => Promise<ModelPayload>;
	copyClaim?: (request: OperationRequest) => ResumeCreationKind;
	createCopy?: (output: Record<string, unknown>) => Pick<ResumeCreateInput, "name" | "locale" | "data">;
	resultState: "waiting_review" | "succeeded";
};
export type AiRuntime = {
	/** Reviewed server composition only: model/effort overrides, never credentials or public request input. */
	writerConfig?: unknown;
	/** Local composition only; ignored in production. Never configured by a public request. */
	localOwnerAllowance?: { ownerId: string; limit: number } | undefined;
	routes: readonly ApprovedRoute[];
	handlers: Readonly<Record<string, OperationHandler>>;
	historicalHandlers?: Readonly<Record<string, readonly OperationHandler[]>>;
	workerAvailable: boolean;
	/** Composition-time test transport only. Never enabled by an HTTP flag or configuration credential. */
	fetch?: typeof globalThis.fetch;
};

const runtimeScope = new AsyncLocalStorage<AiRuntime>();
// Release has no approved manifest/consumer. A future register is reviewed server source, not client input.
const defaultRuntime: AiRuntime = { routes: [], handlers: {}, workerAvailable: false };
export const getAiRuntime = (): AiRuntime => runtimeScope.getStore() ?? defaultRuntime;
export const withAiRuntime = <T>(runtime: AiRuntime, work: () => T): T => runtimeScope.run(runtime, work);

export function getAiAvailability(): AiAvailability {
	const runtime = getAiRuntime();
	if (!runtime.routes.length) return { state: "not_enabled", reason: "NO_APPROVED_ROUTE" };
	if (!runtime.workerAvailable) return { state: "unavailable", reason: "WORKER_UNAVAILABLE" };
	return { state: "ready", reason: null };
}
function denyAiProcessing(): never {
	throw new ORPCError("PRECONDITION_FAILED", {
		message: "AI processing is not enabled.",
		data: { reason: "AI_NOT_ENABLED" },
	});
}
export const assertLegacyAiDenied: () => void = denyAiProcessing;
export function getOperationHandler(
	kind: string,
	versions?: Pick<OperationHandler, "promptVersion" | "schemaVersion">,
): OperationHandler {
	const handler = Object.hasOwn(getAiRuntime().handlers, kind) ? getAiRuntime().handlers[kind] : undefined;
	if (!handler) throw new ORPCError("PRECONDITION_FAILED", { data: { reason: "AI_NOT_ENABLED" } });
	if (!versions) return handler;
	const selected = [handler, ...(getAiRuntime().historicalHandlers?.[kind] ?? [])].find(
		(candidate) =>
			candidate.promptVersion === versions.promptVersion && candidate.schemaVersion === versions.schemaVersion,
	);
	if (!selected) throw new Error("AI_HANDLER_CHANGED");
	return selected;
}

export async function resolveApprovedRoute(
	userId: string,
	request: OperationRequest,
	dispatchTransaction?: OwnerTransaction,
): Promise<ApprovedRoute> {
	const runtime = getAiRuntime();
	let route = runtime.routes.find(
		(r) =>
			r.routeId === request.route.routeId &&
			r.routeRevision === request.route.routeRevision &&
			r.configRevision === request.route.configRevision,
	);
	if (!route || route.noticeVersion !== request.consentVersion || !route.evidenceVersion) denyAiProcessing();
	if (
		!Number.isSafeInteger(route.callTimeoutMs) ||
		route.callTimeoutMs <= 0 ||
		route.callTimeoutMs > 60000 ||
		(route.transientRetries !== undefined && ![0, 1].includes(route.transientRetries)) ||
		(route.translationTransientRetries !== undefined && ![0, 1].includes(route.translationTransientRetries)) ||
		(route.translationCallTimeoutMs !== undefined &&
			(!Number.isSafeInteger(route.translationCallTimeoutMs) ||
				route.translationCallTimeoutMs <= 0 ||
				route.translationCallTimeoutMs > 60000))
	)
		denyAiProcessing();
	try {
		route = resolveWriterRoute(route, request, runtime.writerConfig);
	} catch {
		denyAiProcessing();
	}
	if (runtime.handlers[request.kind]?.verifier) {
		try {
			const { primary: verifier } = resolveReviewVerifierRoutes(route, request.kind);
			completionTokenLimit(verifier);
			if ((route.maxCalls - 1) * route.maxCallCostMicros + verifier.maxCallCostMicros > route.requestCapMicros)
				denyAiProcessing();
		} catch {
			denyAiProcessing();
		}
	}
	try {
		completionTokenLimit(route);
	} catch {
		denyAiProcessing();
	}
	const positive = [
		route.maxCalls,
		route.callTimeoutMs,
		route.deadlineMs,
		route.maxInputCodePoints,
		route.maxOutputTokens,
		route.requestCapMicros,
		route.maxCallCostMicros,
		route.dayCapMicros,
	];
	const maxDeadlineMs =
		route.extendJobAndTranslationTiming && request.kind === "review.translation"
			? extendedTranslationDeadlineMs
			: extendedReviewTiming.deadlineMs;
	if (
		positive.some((v) => !Number.isSafeInteger(v) || v <= 0) ||
		route.maxCalls > 3 ||
		route.maxRepairs < 0 ||
		route.maxRepairs > 1 ||
		route.callTimeoutMs > extendedReviewTiming.callTimeoutMs ||
		route.deadlineMs > maxDeadlineMs ||
		route.maxInputCodePoints > 32000 ||
		route.maxOutputTokens > 16384 ||
		route.requestCapMicros > route.dayCapMicros ||
		!Number.isSafeInteger(route.maxCalls * route.maxCallCostMicros) ||
		route.maxCalls * route.maxCallCostMicros > route.requestCapMicros ||
		!route.model ||
		!route.downstreamProvider ||
		!Number.isSafeInteger(route.maxRepairs)
	)
		denyAiProcessing();
	if (!runtime.workerAvailable) throw new ORPCError("PRECONDITION_FAILED", { data: { reason: "AI_UNAVAILABLE" } });
	const selectConsent = (tx: OwnerTransaction) =>
		tx
			.select({ id: aiProcessingConsent.id })
			.from(aiProcessingConsent)
			.where(
				and(
					eq(aiProcessingConsent.userId, userId),
					eq(aiProcessingConsent.routeId, request.route.routeId),
					eq(aiProcessingConsent.routeRevision, request.route.routeRevision),
					eq(aiProcessingConsent.configRevision, request.route.configRevision),
					eq(aiProcessingConsent.noticeVersion, request.consentVersion),
					eq(aiProcessingConsent.purpose, request.kind),
					isNull(aiProcessingConsent.revokedAt),
				),
			);
	// A revocation updates this row and must wait for a dispatch that holds it.
	const [consent] = dispatchTransaction
		? await selectConsent(dispatchTransaction).for("share")
		: await withOwnerDatabase(userId, selectConsent);
	if (!consent) throw new ORPCError("PRECONDITION_FAILED", { data: { reason: "AI_CONSENT_REQUIRED" } });
	return route;
}

export function canonicalJson(value: unknown): string {
	if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
	if (value && typeof value === "object")
		return `{${Object.entries(value)
			.sort(([a], [b]) => a.localeCompare(b))
			.map(([key, v]) => `${JSON.stringify(key)}:${canonicalJson(v)}`)
			.join(",")}}`;
	return JSON.stringify(value);
}
export function operationFingerprint(
	request: OperationRequest,
	handler: Pick<OperationHandler, "promptVersion" | "schemaVersion">,
): string {
	const { requestKey: _key, ...binding } = request;
	return createHash("sha256")
		.update(canonicalJson({ ...binding, promptVersion: handler.promptVersion, schemaVersion: handler.schemaVersion }))
		.digest("hex");
}
