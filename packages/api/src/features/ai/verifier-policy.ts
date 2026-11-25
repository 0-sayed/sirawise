import type { AttemptFailure } from "./adapter";
import type { ApprovedRoute, ReasoningEffort } from "./route-policy";
import type { OperationRequest } from "@reactive-resume/schema/ai-operation";
import { createHash } from "node:crypto";
import { togetherVerifierPrice } from "./attempt-budget";
import { canonicalJson, capVerifierCompletion, completionTokenLimit } from "./route-policy";

export const fixedProviderPolicy = {
	allow_fallbacks: false,
	require_parameters: true,
	data_collection: "deny",
	zdr: true,
} as const;

export function canonicalVerifierRouteSha256(route: ApprovedRoute): string {
	const maxPrice = togetherVerifierPrice(route);
	const effective = {
		endpoint: route.endpoint,
		model: route.model,
		downstreamProvider: route.downstreamProvider,
		reasoningEffort: route.reasoningEffort ?? "none",
		maxInputCodePoints: route.maxInputCodePoints,
		maxOutputTokens: route.maxOutputTokens,
		completionTokenLimit: completionTokenLimit(route),
		callTimeoutMs: route.callTimeoutMs,
		deadlineMs: route.deadlineMs,
		maxCalls: route.maxCalls,
		maxRepairs: route.maxRepairs,
		transientRetries: route.transientRetries ?? route.translationTransientRetries ?? 0,
		maxCallCostMicros: route.maxCallCostMicros,
		requestCapMicros: route.requestCapMicros,
		dayCapMicros: route.dayCapMicros,
		reasoningExcluded: true,
		provider: { ...fixedProviderPolicy, ...(maxPrice ? { max_price: maxPrice } : {}) },
		...(route.providerEndpoint ? { providerEndpoint: route.providerEndpoint, precision: route.precision } : {}),
	};
	return createHash("sha256").update(canonicalJson(effective)).digest("hex");
}

export type VerifierPolicy = { model: string; downstreamProvider: string; reasoningEffort: ReasoningEffort };
export function reviewVerifierPolicy(writerModel: string): VerifierPolicy {
	return writerModel.startsWith("deepseek/")
		? { model: "openai/gpt-6-luna", downstreamProvider: "azure", reasoningEffort: "low" }
		: { model: "deepseek/deepseek-v4.1-flash-1017", downstreamProvider: "together", reasoningEffort: "low" };
}

/** This is one consented, versioned route bundle, not an additional implicit route grant. */
export function resolveReviewVerifierRoute(writer: ApprovedRoute, kind?: OperationRequest["kind"]): ApprovedRoute {
	const approved = writer.verifier;
	if (
		!approved?.evidenceVersion ||
		!Number.isSafeInteger(approved.maxCallCostMicros) ||
		approved.maxCallCostMicros <= 0
	)
		throw new Error("AI_VERIFIER_ROUTE_UNAPPROVED");
	const policy = { ...reviewVerifierPolicy(writer.model), ...approved.policy };
	if (policy.model.split("/")[0] === writer.model.split("/")[0]) throw new Error("AI_VERIFIER_FAMILY_CONFLICT");
	const route = {
		...writer,
		...policy,
		maxOutputTokens: approved.maxOutputTokens ?? writer.maxOutputTokens,
		maxCallCostMicros: approved.maxCallCostMicros,
		boundByTogetherPricing: approved.boundByTogetherPricing === true,
		evidenceVersion: approved.evidenceVersion,
	};
	completionTokenLimit(route);
	return kind === "review.job-evidence" ? capVerifierCompletion(route, 12288) : route;
}

const backupModel = "deepseek/deepseek-v4.1-flash-1017";
const backupPurposes = ["review.translation", "review.job-evidence"] as const;
type BackupPurpose = (typeof backupPurposes)[number];

export type VerifierBackupBinding = {
	endpoint: string;
	model: string;
	downstreamProvider: string;
	providerEndpoint: string;
	precision: NonNullable<ApprovedRoute["precision"]>;
	evidenceVersion: string;
	maxCallCostMicros: number;
	processor: {
		availability: string;
		location: string;
		contract: string;
		retention: string;
		zdr: string;
		dataCollectionDenial: string;
		fullPrecision: string;
		structuredOutput: string;
		callBound: string;
		purposes: readonly BackupPurpose[];
	};
	qualified: readonly { kind: BackupPurpose; writerModel: string; verifierModel: string }[];
};

export function resolveReviewVerifierRoutes(
	writer: ApprovedRoute,
	kind: OperationRequest["kind"],
): { primary: ApprovedRoute; backup?: ApprovedRoute } {
	const primary = resolveReviewVerifierRoute(writer, kind);
	const backup = writer.verifier?.backup;
	if (
		!backup ||
		primary.model !== backupModel ||
		backup.model !== primary.model ||
		backup.downstreamProvider !== "parasail" ||
		backup.downstreamProvider === primary.downstreamProvider ||
		!/^parasail\/[a-z0-9][a-z0-9-]*$/u.test(backup.providerEndpoint) ||
		!["bf16", "fp16", "fp32"].includes(backup.precision) ||
		backup.endpoint !== primary.endpoint ||
		!backup.evidenceVersion?.trim() ||
		!Number.isSafeInteger(backup.maxCallCostMicros) ||
		backup.maxCallCostMicros <= 0 ||
		backup.maxCallCostMicros > writer.requestCapMicros
	)
		return { primary };
	const processor = backup.processor;
	if (
		!processor ||
		![
			processor.availability,
			processor.location,
			processor.contract,
			processor.retention,
			processor.zdr,
			processor.dataCollectionDenial,
			processor.fullPrecision,
			processor.structuredOutput,
			processor.callBound,
		].every((value) => typeof value === "string" && value.trim()) ||
		!backupPurposes.some((purpose) => purpose === kind && processor.purposes?.includes(purpose)) ||
		!backup.qualified?.some(
			(tuple) => tuple.kind === kind && tuple.writerModel === writer.model && tuple.verifierModel === primary.model,
		)
	)
		return { primary };
	return {
		primary,
		backup: {
			...primary,
			endpoint: backup.endpoint,
			downstreamProvider: backup.downstreamProvider,
			providerEndpoint: backup.providerEndpoint,
			precision: backup.precision,
			boundByTogetherPricing: false,
			maxCallCostMicros: backup.maxCallCostMicros,
			evidenceVersion: backup.evidenceVersion,
		},
	};
}

export function canFailOverVerifier(
	failure: AttemptFailure,
	remaining: { deadlineMs: number; budgetMicros: number },
	backup: ApprovedRoute | undefined,
): boolean {
	return Boolean(
		backup &&
		remaining.deadlineMs >= 1000 &&
		remaining.budgetMicros >= backup.maxCallCostMicros &&
		isBackupVerifierFailure(failure),
	);
}

export function isBackupVerifierFailure(failure: AttemptFailure): boolean {
	return (
		failure.code !== "AI_VERIFIER_IDENTITY_MISMATCH" &&
		(failure.abortCause === "call_timeout" ||
			(!failure.abortCause && [429, 500, 502, 503, 504].includes(failure.httpStatus ?? 0)))
	);
}
