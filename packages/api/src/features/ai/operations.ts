import type { OwnerTransaction } from "@reactive-resume/db/owner-scope";
import type { OperationPreflight, OperationRequest, OperationView } from "@reactive-resume/schema/ai-operation";
import type { WithheldReviewItems } from "@reactive-resume/schema/resume/ai-review";
import { ORPCError } from "@orpc/client";
import { and, asc, eq, inArray, isNull, lte, or, sql } from "drizzle-orm";
import { z } from "zod";
import { lockAccountForAccounting } from "@reactive-resume/db/account-state";
import { getPool } from "@reactive-resume/db/client";
import { withOwnerDatabase } from "@reactive-resume/db/owner-scope";
import {
	aiImportReviewSource,
	aiOperation,
	aiOperationAttempt,
	aiReviewDecision,
	aiTranslationBatch,
	aiProvider,
	aiUsageLedger,
	agentMessage,
	agentThread,
	application,
	coverLetter,
	careerProfile,
	resume,
} from "@reactive-resume/db/schema";
import { operationRequestSchema } from "@reactive-resume/schema/ai-operation";
import { allowanceFailureSchema } from "@reactive-resume/schema/ai-usage";
import {
	jobEvidenceSchema,
	translationOutputSchema,
	translationReviewOutputSchema,
} from "@reactive-resume/schema/resume/variant-outputs";
import { variantReviewResultSchema } from "@reactive-resume/schema/resume/variants";
import { generateId } from "@reactive-resume/utils/string";
import { lockDocumentOwner } from "../documents/ownership";
import { createResumeInTransaction, notifyResumeUpdated } from "../resume/service";
import { assertOperationConcurrency } from "./concurrency";
import { CONTENT_RETRY_STEP, currentContentAttempts } from "./content-retry";
import { validateReviewContinuation } from "./review-continuation";
import { loadReviewSource, lockReviewProfile, removeExpiredReviewSources } from "./review-sources";
import { getOperationHandler, canonicalJson, operationFingerprint, resolveApprovedRoute } from "./route-policy";
import {
	mergePartialTranslationBatches,
	persistTranslationPlan,
	type PartialTranslationPart,
	type TranslationBatchPlan,
} from "./translation-batches";
import {
	admitResumeCreation,
	resolveResumeCreation,
	denyAllowance,
	releaseOperation,
	reserveOperation,
	settleOperation,
} from "./usage";
import { translationCandidateContract, variantOperationContracts } from "./variant-contracts";
import { tryAutoApplyTranslationInTx } from "./variant-decisions";
import { loadTranslationPlan, loadVariantSnapshot } from "./variant-sources";
import { verificationFailureDetail, type OperationFailureDetail } from "./verification-failure";
import {
	applyVerificationPass,
	bindVerificationPass,
	legacySplitVerificationVerdicts,
	planOperationVerification,
	readVerificationJournal,
	verificationPassVerdicts,
} from "./verification-journal";

type Operation = typeof aiOperation.$inferSelect;
const jobEvidenceCancellationObservers = new Map<string, Set<() => void>>();

export function observeJobEvidenceCancellation(operationId: string, abort: () => void) {
	const observers = jobEvidenceCancellationObservers.get(operationId) ?? new Set();
	observers.add(abort);
	jobEvidenceCancellationObservers.set(operationId, observers);
	return () => {
		observers.delete(abort);
		if (!observers.size) jobEvidenceCancellationObservers.delete(operationId);
	};
}

export type OperationLease = { ownerId: string; operationId: string; token: string };
const operationView = (o: Operation): OperationView => ({
	id: o.id,
	state: o.state,
	resultId: o.deliveredAt ? o.id : null,
	failureCode: o.failureCode,
});
type Batch = {
	rootId: string;
	index: number;
	total: number;
	planHash: string;
	planVersion?: "compact-v1";
	retrySegmentIds?: string[];
};
type TranslationExecution = Pick<OperationRequest, "route" | "consentVersion">;
export const MAX_TRANSLATION_CONCURRENT_PARTS = 6;
export const AI_QUEUE_TTL_MS = 5 * 60 * 1000;
const activeStates = ["queued", "running", "cancel_requested"] as const;
const isActive = (operation: Operation) => activeStates.some((state) => state === operation.state);
const batchOf = (operation: Operation) =>
	operation.kind === "review.translation" ? (operation.parameters.translationBatch as Batch | undefined) : undefined;
const endedBeforeTranslationStarted = (root: Operation) =>
	!root.executionStartedAt && (root.failureCode === "AI_QUEUE_EXPIRED" || root.failureCode === "AI_CANCELLED");

function isStaleTranslationSource(error: unknown) {
	return (
		(error instanceof ORPCError && error.code === "CONFLICT" && error.data?.reason === "AI_SOURCE_CHANGED") ||
		(error instanceof Error && error.message === "TRANSLATION_BATCH_PLAN_CHANGED")
	);
}

function translationPartResult(part: Operation | undefined, failed: Operation | undefined): PartialTranslationPart {
	if (part?.result) {
		const { withheldSegmentIds, ...publicResult } = part.result;
		const parsed = variantReviewResultSchema.parse(publicResult);
		if (parsed.kind !== "review.translation") throw new Error("TRANSLATION_BATCH_INCOMPLETE");
		return {
			status: "delivered",
			output: translationOutputSchema.parse(parsed.output),
			...(parsed.withheld ? { withheld: parsed.withheld } : {}),
			...(withheldSegmentIds === undefined
				? {}
				: { withheldSegmentIds: z.array(z.string()).parse(withheldSegmentIds) }),
		};
	}
	const detail = failed?.failureDetail;
	const rule =
		detail && typeof detail === "object" && "rule" in detail && typeof detail.rule === "string"
			? detail.rule
			: (failed?.failureCode ?? "AI_VERIFICATION_CLAIM_SUPPORT");
	return { status: "failed", reason: rule };
}

function preserveVerifiedPartSegments(previous: Operation | undefined, latest: Operation): Operation {
	if (!previous || !latest.result || !batchOf(latest)?.planVersion) return latest;
	const before = translationPartResult(previous, undefined);
	const after = translationPartResult(latest, undefined);
	if (before.status !== "delivered" || after.status !== "delivered") return latest;
	const replaceable = new Set(before.withheldSegmentIds ?? []);
	const afterById = new Map(after.output.segments.map((segment) => [segment.sourceId, segment]));
	const updatedWithheld = new Set(after.withheldSegmentIds ?? []);
	const withheldSegmentIds = [...replaceable].filter((id) => !afterById.has(id) || updatedWithheld.has(id));
	const issues = new Map(
		[...(before.withheld?.items ?? []), ...(after.withheld?.items ?? [])].map((item) => [item.id, item]),
	);
	const { withheld: _withheld, withheldSegmentIds: _ids, ...result } = latest.result;
	return {
		...latest,
		result: {
			...result,
			output: {
				...after.output,
				segments: before.output.segments.map((segment) =>
					replaceable.has(segment.sourceId) ? (afterById.get(segment.sourceId) ?? segment) : segment,
				),
			},
			...(withheldSegmentIds.length
				? {
						withheldSegmentIds,
						withheld: {
							count: withheldSegmentIds.length,
							rules: [...new Set([...(before.withheld?.rules ?? []), ...(after.withheld?.rules ?? [])])],
							items: withheldSegmentIds.flatMap((id) => issues.get(id) ?? []),
						},
					}
				: {}),
		},
	};
}

async function translationState(tx: OwnerTransaction, ownerId: string, operation: Operation) {
	const batch = batchOf(operation);
	if (!batch) return null;
	const root = batch.rootId === operation.id ? operation : await getOwned(tx, ownerId, batch.rootId);
	const rootBatch = batchOf(root);
	const [session] = await tx
		.select()
		.from(aiTranslationBatch)
		.where(and(eq(aiTranslationBatch.userId, ownerId), eq(aiTranslationBatch.rootOperationId, root.id)));
	if (
		!rootBatch ||
		!session ||
		rootBatch.rootId !== root.id ||
		rootBatch.index !== 0 ||
		session.total !== rootBatch.total
	)
		throw new ORPCError("NOT_FOUND");
	const parts = await tx
		.select()
		.from(aiOperation)
		.where(
			and(
				eq(aiOperation.userId, ownerId),
				eq(aiOperation.kind, "review.translation"),
				sql`${aiOperation.parameters}->'translationBatch'->>'rootId' = ${root.id}`,
			),
		)
		.orderBy(asc(aiOperation.createdAt), asc(aiOperation.id));
	const retryIds = new Set(session.execution?.retryFailedOperationIds ?? []);
	const latestByIndex = Array.from({ length: rootBatch.total }, (_, index) =>
		parts.findLast((part) => batchOf(part)?.index === index),
	);
	const delivered = Array.from({ length: rootBatch.total }, (_, index) => {
		const latest = latestByIndex[index];
		if (latest && (isActive(latest) || retryIds.has(latest.id))) return undefined;
		const receipts = parts.filter(
			(part) => batchOf(part)?.index === index && part.deliveredAt && part.result && !retryIds.has(part.id),
		);
		return rootBatch.planVersion
			? receipts.reduce<Operation | undefined>(preserveVerifiedPartSegments, undefined)
			: receipts.at(-1);
	});
	const index = delivered.findIndex((part) => !part);
	const pending = delivered.map((part, index) => (part ? undefined : latestByIndex[index]));
	const active = pending.filter((part): part is Operation => !!part && isActive(part));
	const failed = pending.filter((part): part is Operation => !!part && ["failed", "cancelled"].includes(part.state));
	const withheldParts = delivered.filter((part): part is Operation => {
		if (!part?.result || typeof part.result !== "object" || !("withheld" in part.result)) return false;
		const withheld = (part.result as { withheld?: { count?: number } }).withheld;
		return Boolean(withheld && typeof withheld.count === "number" && withheld.count > 0);
	});
	const pendingRetry = [...failed, ...withheldParts].filter((part) => retryIds.has(part.id));
	const allPartsAttempted = delivered.every((part, idx) => Boolean(part) || Boolean(pending[idx]));
	const failedAreVerificationRejections = failed.every(
		(part) => part.failureCode === "AI_VERIFICATION_FAILED" || part.failureCode === "AI_REVIEW_INVALID",
	);
	const runningDespiteVerificationRejections =
		active.length > 0 &&
		failed.length > 0 &&
		failedAreVerificationRejections &&
		session.failureCode !== "AI_CANCELLED" &&
		session.failureCode !== "AI_PROVIDER_UNAVAILABLE" &&
		(session.failureCode === null ||
			session.failureCode === "AI_VERIFICATION_FAILED" ||
			session.failureCode === "AI_REVIEW_INVALID");
	const hasPartialVerifiedResult =
		session.state === "paused" &&
		session.failureCode !== "AI_CANCELLED" &&
		session.failureCode !== "AI_SOURCE_CHANGED" &&
		active.length === 0 &&
		pendingRetry.length === 0 &&
		allPartsAttempted &&
		delivered.some(Boolean) &&
		failedAreVerificationRejections &&
		(failed.length > 0 || withheldParts.length > 0);
	const current =
		active.find((part) => part.state === "cancel_requested") ??
		(runningDespiteVerificationRejections ? undefined : failed.find((part) => !pendingRetry.includes(part))) ??
		active.find((part) => part.state !== "queued") ??
		active[0] ??
		(index < 0 ? root : pending[index]);
	return {
		root,
		batch: rootBatch,
		session,
		parts,
		delivered,
		pending,
		active,
		failed,
		withheldParts,
		pendingRetry,
		runningDespiteVerificationRejections,
		hasPartialVerifiedResult,
		index,
		current,
	};
}

export async function assembleTranslationBatchResult(
	tx: OwnerTransaction,
	ownerId: string,
	operation: Operation,
): Promise<Record<string, unknown> | null> {
	const batch = await translationState(tx, ownerId, operation);
	if (!batch || batch.root.id !== operation.id) return null;
	if (batch.session.state === "complete" && batch.session.result) return batch.session.result;
	if (!batch.hasPartialVerifiedResult) return null;
	const execution = batch.session.execution ?? { route: batch.root.route, consentVersion: batch.root.consentVersion };
	const request = { ...operationRequest(batch.root), route: execution.route, consentVersion: execution.consentVersion };
	const full = await loadVariantSnapshot(tx, ownerId, request, { fullTranslation: true });
	const plan = await loadTranslationPlan(tx, ownerId, request, full, {
		maxInputCodePoints: 32000,
		maxOutputTokens: 4096,
	});
	const partEntries = batch.delivered.map((part, idx) => translationPartResult(part, batch.pending[idx]));
	const merged = mergePartialTranslationBatches(full, plan, partEntries);
	const output = translationReviewOutputSchema.parse(merged.output);
	return {
		schemaVersion: 1,
		sourceRevision: { kind: "resume", id: full.resumeId, revision: full.sourceRevision },
		kind: "review.translation",
		output,
		...(merged.withheld
			? {
					withheld: merged.withheld,
					withheldSegmentIds: merged.withheldSegmentIds,
					withheldSegmentParts: merged.withheldSegmentParts,
					withholdingIdsComplete: merged.withholdingIdsComplete,
				}
			: {}),
	};
}

async function publicOperationView(
	tx: OwnerTransaction,
	ownerId: string,
	operation: Operation,
	checkTranslationSource = false,
): Promise<OperationView> {
	const batch = await translationState(tx, ownerId, operation);
	let stale = batch?.session.failureCode === "AI_SOURCE_CHANGED";
	if (
		checkTranslationSource &&
		batch &&
		!stale &&
		batch.session.failureCode !== "AI_CANCELLED" &&
		!endedBeforeTranslationStarted(batch.root)
	) {
		try {
			await assertSourceRevisions(tx, ownerId, operationRequest(batch.root));
			if (batch.hasPartialVerifiedResult) await assembleTranslationBatchResult(tx, ownerId, batch.root);
		} catch (error) {
			if (!isStaleTranslationSource(error)) throw error;
			stale = true;
		}
	}
	const current = batch?.current ?? operation;
	const queuePosition =
		current.state === "queued"
			? (
					await tx.execute<{ position: number | null }>(
						sql`SELECT master_cv_ai_queue_position(${batch?.root.id ?? operation.id}) AS position`,
					)
				).rows[0]?.position
			: null;
	const [attempt] = await tx
		.select({ stepId: aiOperationAttempt.stepId })
		.from(aiOperationAttempt)
		.where(eq(aiOperationAttempt.operationId, current.id))
		.orderBy(sql`${aiOperationAttempt.ordinal} DESC`)
		.limit(1);
	const complete = batch?.session.state === "complete";
	const partialReady = Boolean(batch && !complete && batch.hasPartialVerifiedResult);
	const paused =
		batch &&
		!complete &&
		!partialReady &&
		!batch.runningDespiteVerificationRejections &&
		(batch.session.failureCode || ["failed", "cancelled"].includes(current.state));
	const charged =
		batch && paused
			? (
					await tx
						.select({ kind: aiUsageLedger.kind })
						.from(aiUsageLedger)
						.where(and(eq(aiUsageLedger.operationId, batch.root.id), eq(aiUsageLedger.kind, "settle")))
						.limit(1)
				).length > 0
			: undefined;
	return {
		...operationView(batch?.root ?? operation),
		...(queuePosition ? { queuePosition } : {}),
		...(batch && (complete || partialReady)
			? {
					state: batch.session.reviewState,
					resultId: batch.root.id,
					failureCode: null,
					retryable: partialReady,
				}
			: {}),
		...(batch && !complete && !partialReady
			? {
					state: paused
						? current.state === "cancel_requested"
							? "cancel_requested"
							: current.state === "cancelled"
								? "cancelled"
								: "failed"
						: (batch.current?.state ?? "queued"),
					resultId: null,
					failureCode: paused ? (batch.session.failureCode ?? current.failureCode) : null,
					charged,
					retryable:
						!!paused &&
						!endedBeforeTranslationStarted(batch.root) &&
						current.state !== "cancel_requested" &&
						batch.session.failureCode !== "AI_PROVIDER_UNAVAILABLE" &&
						current.failureCode !== "AI_PROVIDER_UNAVAILABLE",
				}
			: {}),
		...(stale ? { state: "failed" as const, resultId: null, failureCode: "AI_SOURCE_CHANGED", retryable: false } : {}),
		progress: {
			step:
				current.state === "cancel_requested"
					? "cancelling"
					: current.state === "queued"
						? "queued"
						: attempt?.stepId === "verify"
							? "checking"
							: "drafting",
			startedAt: ((batch?.root ?? current).executionStartedAt ?? (batch?.root ?? current).createdAt).toISOString(),
			...(batch
				? {
						part:
							complete || partialReady
								? batch.batch.total
								: ((batch.current ? batchOf(current)?.index : undefined) ?? batch.index) + 1,
						total: batch.batch.total,
						completedParts: batch.delivered.filter(Boolean).length - batch.withheldParts.length,
						failedParts: batch.failed.length,
						failedPartDetails: batch.failed.map((part) => ({
							part: (batchOf(part)?.index ?? 0) + 1,
							failureCode: part.failureCode,
						})),
						activeParts: batch.active.length,
						pendingRetryParts: batch.pendingRetry.length,
					}
				: {}),
		},
	};
}
export const operationRequest = (o: Operation): OperationRequest => ({
	requestKey: o.requestKey,
	kind: o.kind,
	sources: o.sources,
	route: o.route,
	consentVersion: o.consentVersion,
	parameters: o.parameters,
});

async function getOwned(tx: OwnerTransaction, userId: string, id: string): Promise<Operation> {
	const [operation] = await tx
		.select()
		.from(aiOperation)
		.where(and(eq(aiOperation.userId, userId), eq(aiOperation.id, id)))
		.for("update");
	if (!operation) throw new ORPCError("NOT_FOUND");
	return operation;
}

export async function assertSourceRevisions(
	tx: OwnerTransaction,
	userId: string,
	request: OperationRequest,
): Promise<void> {
	// Nested answer sources can reach a resume before a later career source.
	// Acquire the profile first regardless of request/source ordering.
	await lockReviewProfile(tx, userId);
	for (const source of [...request.sources].sort((a, b) => `${a.kind}:${a.id}`.localeCompare(`${b.kind}:${b.id}`))) {
		if (source.kind === "import" || source.kind === "answer" || source.kind === "job") {
			await loadReviewSource(tx, userId, source);
			continue;
		}
		let revision: string | undefined;
		if (source.kind === "resume") {
			const [row] = await tx
				.select()
				.from(resume)
				.where(and(eq(resume.userId, userId), eq(resume.id, source.id)))
				.for("share");
			if (row && !row.trashedAt) revision = row.updatedAt.toISOString();
		} else if (source.kind === "cover-letter") {
			const [row] = await tx
				.select()
				.from(coverLetter)
				.where(and(eq(coverLetter.userId, userId), eq(coverLetter.id, source.id)))
				.for("share");
			if (row && !row.trashedAt && !row.isLocked) revision = String(row.revision);
		} else if (source.kind === "career") {
			const [row] = await tx.select().from(careerProfile).where(eq(careerProfile.userId, userId)).for("share");
			if (row && source.id === userId) revision = String(row.profileRevision);
		} else {
			const [row] = await tx
				.select()
				.from(application)
				.where(and(eq(application.userId, userId), eq(application.id, source.id)))
				.for("share");
			if (row) revision = row.updatedAt.toISOString();
		}
		if (!revision) throw new ORPCError("NOT_FOUND", { data: { reason: "AI_SOURCE_UNAVAILABLE" } });
		if (revision !== source.revision) {
			let matchesOwnPartialAutoApply = false;
			if (source.kind === "resume" && request.kind === "review.translation") {
				const rootId = (request.parameters as { translationBatch?: { rootId?: string } }).translationBatch?.rootId;
				if (rootId) {
					const [autoApplied] = await tx
						.select({ id: aiReviewDecision.id })
						.from(aiReviewDecision)
						.where(
							and(
								eq(aiReviewDecision.userId, userId),
								eq(aiReviewDecision.operationId, rootId),
								eq(aiReviewDecision.resumeId, source.id),
								eq(aiReviewDecision.afterRevision, revision),
							),
						)
						.limit(1);
					if (autoApplied) matchesOwnPartialAutoApply = true;
				}
			}
			if (!matchesOwnPartialAutoApply) throw new ORPCError("CONFLICT", { data: { reason: "AI_SOURCE_CHANGED" } });
		}
	}
}

async function finishUnsuccessful(
	tx: OwnerTransaction,
	operation: Operation,
	failureCode: string,
	failureDetail?: OperationFailureDetail,
): Promise<OperationView> {
	const state =
		operation.state === "cancel_requested" || (operation.state === "queued" && failureCode === "AI_CANCELLED")
			? "cancelled"
			: "failed";
	if (operation.state !== "queued") {
		const unfinished = await tx
			.select()
			.from(aiOperationAttempt)
			.where(
				and(
					eq(aiOperationAttempt.userId, operation.userId),
					eq(aiOperationAttempt.operationId, operation.id),
					eq(aiOperationAttempt.stepId, "verify"),
					isNull(aiOperationAttempt.finishedAt),
				),
			);
		for (const pass of unfinished) {
			const journal = readVerificationJournal(pass.output);
			if (!journal) continue;
			const known = journal.calls.every((call) => call.costMicros !== null);
			const failed = [...journal.latest.values()].find((call) => call.outcome !== "valid");
			await tx
				.update(aiOperationAttempt)
				.set({
					outcome: failed?.outcome === "pending" ? "unknown" : (failed?.outcome ?? (known ? "unsupported" : "unknown")),
					costMicros: known ? journal.calls.reduce((total, call) => total + (call.costMicros ?? 0), 0) : null,
					finishedAt: new Date(),
				})
				.where(and(eq(aiOperationAttempt.id, pass.id), isNull(aiOperationAttempt.finishedAt)));
		}
	}
	const [updated] = await tx
		.update(aiOperation)
		.set({
			state,
			failureCode: state === "cancelled" ? "AI_CANCELLED" : failureCode,
			failureDetail: failureDetail ?? null,
			leaseToken: null,
			leaseUntil: null,
		})
		.where(eq(aiOperation.id, operation.id))
		.returning();
	await releaseOperation(tx, operation.userId, operation.id);
	await tx.execute(sql`SELECT master_cv_ai_reconcile_budget(${operation.id})`);
	const batch = batchOf(operation);
	if (batch)
		await tx
			.update(aiTranslationBatch)
			.set({
				state: state === "cancelled" || failureCode === "AI_PROVIDER_UNAVAILABLE" ? "paused" : "running",
				failureCode: state === "cancelled" ? "AI_CANCELLED" : failureCode,
			})
			.where(and(eq(aiTranslationBatch.rootOperationId, batch.rootId), eq(aiTranslationBatch.state, "running")));
	if (!updated) throw new ORPCError("NOT_FOUND");
	if (state === "failed" && failureCode === "AI_VERIFICATION_FAILED")
		console.warn("[ai-operation]", {
			id: operation.id,
			kind: operation.kind,
			code: failureCode,
			rule: failureDetail && "rule" in failureDetail ? failureDetail.rule : undefined,
		});
	if (batch?.rootId === operation.id && operation.state === "queued" && failureCode === "AI_QUEUE_EXPIRED") {
		const batchState = await translationState(tx, operation.userId, updated);
		for (const part of batchState?.active ?? []) {
			if (part.state === "queued") await finishUnsuccessful(tx, part, failureCode);
		}
		await tx
			.update(aiTranslationBatch)
			.set({ state: "paused" })
			.where(eq(aiTranslationBatch.rootOperationId, operation.id));
	} else if (batch && state !== "cancelled" && failureCode !== "AI_PROVIDER_UNAVAILABLE") {
		await advanceTranslation(tx, operation.userId, updated);
	}
	return operationView(updated);
}

async function bindThread(tx: OwnerTransaction, userId: string, operation: Operation, threadId?: string) {
	if (!threadId) return;
	const [thread] = await tx
		.select()
		.from(agentThread)
		.where(and(eq(agentThread.id, threadId), eq(agentThread.userId, userId)))
		.for("update");
	if (!thread || thread.status !== "active" || thread.deletedAt) throw new ORPCError("NOT_FOUND");
	if (thread.activeOperationId === operation.id) return;
	if (thread.activeOperationId) {
		const previous = await getOwned(tx, userId, thread.activeOperationId);
		if (["queued", "running", "cancel_requested"].includes(previous.state)) denyAllowance("AI_TARGET_BUSY");
	}
	const [provider] = thread.aiProviderId
		? await tx
				.select()
				.from(aiProvider)
				.where(and(eq(aiProvider.userId, userId), eq(aiProvider.id, thread.aiProviderId)))
				.for("share")
		: [];
	if (
		!provider ||
		!provider.enabled ||
		provider.testStatus !== "success" ||
		provider.configRevision !== operation.route.configRevision
	)
		denyAllowance("AI_PROVIDER_CHANGED");
	if (
		thread.workingResumeId &&
		!operation.sources.some((source) => source.kind === "resume" && source.id === thread.workingResumeId)
	)
		throw new ORPCError("BAD_REQUEST");
	await tx
		.update(agentThread)
		.set({ activeOperationId: operation.id, routeBinding: operation.route })
		.where(eq(agentThread.id, threadId));
}

async function startOperation(
	tx: OwnerTransaction,
	userId: string,
	rawRequest: OperationRequest,
	threadId?: string,
	internalBatch?: Batch,
): Promise<OperationView> {
	await lockDocumentOwner(tx, userId);
	if (
		rawRequest.kind === "review.translation" &&
		rawRequest.parameters.translationBatch !== undefined &&
		!internalBatch
	)
		throw new ORPCError("BAD_REQUEST");
	const [existing] = await tx
		.select()
		.from(aiOperation)
		.where(and(eq(aiOperation.userId, userId), eq(aiOperation.requestKey, rawRequest.requestKey)))
		.for("update");
	if (existing) {
		if (
			internalBatch &&
			(batchOf(existing)?.rootId !== internalBatch.rootId || batchOf(existing)?.index !== internalBatch.index)
		)
			throw new ORPCError("CONFLICT", { data: { reason: "AI_REQUEST_KEY_REUSED" } });
		if (operationFingerprint(rawRequest, existing) !== existing.fingerprint) throw new ORPCError("CONFLICT");
		await bindThread(tx, userId, existing, threadId);
		return batchOf(existing) && !internalBatch ? publicOperationView(tx, userId, existing) : operationView(existing);
	}
	const handler = getOperationHandler(
		rawRequest.kind,
		internalBatch ? await getOwned(tx, userId, internalBatch.rootId) : undefined,
	);
	// Bind replay to the original request, independent of defaults/transforms or later deployments.
	const fingerprint = operationFingerprint(rawRequest, handler);
	const request = {
		...rawRequest,
		parameters: handler.parameters.parse({
			...rawRequest.parameters,
			...(handler.parameters === variantOperationContracts["review.job-evidence"].parameters
				? { jobSpanVersion: "requirements-v2" }
				: {}),
			...(internalBatch ? { translationBatch: internalBatch } : {}),
		}),
	};
	const continued = await validateReviewContinuation(tx, userId, request);
	const route = await resolveApprovedRoute(userId, request);
	await assertSourceRevisions(tx, userId, request);
	if (handler.validateRequest) await handler.validateRequest(tx, userId, request);
	const id = generateId();
	let translationPlan: TranslationBatchPlan | undefined;
	if (request.kind === "review.translation" && !internalBatch) {
		const snapshot = await loadVariantSnapshot(tx, userId, request, {
			compactTranslation: Boolean(handler.translationPlanVersion),
			includeTranslationPlan: true,
		});
		translationPlan = snapshot.translationPlan;
		if (!translationPlan) throw new ORPCError("INTERNAL_SERVER_ERROR");
		request.parameters = {
			...request.parameters,
			translationBatch: {
				rootId: id,
				index: 0,
				total: translationPlan.batches.length,
				planHash: translationPlan.fingerprint,
				...(handler.translationPlanVersion ? { planVersion: handler.translationPlanVersion } : {}),
			},
		};
	}
	const active = await tx
		.select()
		.from(aiOperation)
		.where(and(eq(aiOperation.userId, userId), inArray(aiOperation.state, activeStates)));
	let importFlows: Map<string, string> | undefined;
	if (request.sources.some((source) => source.kind === "import")) {
		// An import can stage several selections. They share a lock for the original import flow.
		const ids = [request, ...active].flatMap(({ sources }) =>
			sources.filter((source) => source.kind === "import").map((source) => source.id),
		);
		const staged = await tx
			.select({ id: aiImportReviewSource.id, flowId: aiImportReviewSource.flowId })
			.from(aiImportReviewSource)
			.where(and(eq(aiImportReviewSource.userId, userId), inArray(aiImportReviewSource.id, ids)));
		importFlows = new Map(staged.map(({ id, flowId }) => [id, flowId]));
	}
	assertOperationConcurrency(request, active, {
		...(internalBatch ? { internalRootId: internalBatch.rootId } : {}),
		...(importFlows ? { importFlows } : {}),
	});
	if (
		internalBatch &&
		active.filter((part) => batchOf(part)?.rootId === internalBatch.rootId).length >= MAX_TRANSLATION_CONCURRENT_PARTS
	)
		denyAllowance("AI_PLATFORM_BUSY");
	const proposedCopy = handler.copyClaim?.(request);
	const copyClaim = proposedCopy ? await resolveResumeCreation(tx, userId, proposedCopy) : undefined;
	if (copyClaim) {
		if (copyClaim.variantKind === "base" || !handler.createCopy) throw new ORPCError("BAD_REQUEST");
		await admitResumeCreation(tx, userId, copyClaim);
	}
	const createdAt = new Date();
	const [created] = await tx
		.insert(aiOperation)
		.values({
			id,
			userId,
			...request,
			fingerprint,
			promptVersion: handler.promptVersion,
			schemaVersion: handler.schemaVersion,
			createdAt,
			queueExpiresAt: new Date(createdAt.getTime() + AI_QUEUE_TTL_MS),
			deadlineAt: new Date(createdAt.getTime() + route.deadlineMs),
			...(copyClaim ? { copyClaim } : {}),
		})
		.returning();
	if (!created) throw new ORPCError("INTERNAL_SERVER_ERROR");
	if (translationPlan) {
		await tx.insert(aiTranslationBatch).values({
			userId,
			rootOperationId: created.id,
			total: translationPlan.batches.length,
			state: "running",
			plan: persistTranslationPlan(translationPlan),
		});
	}
	// Queued work holds the allowance but cannot settle it. Internal parts share the request cap.
	if (!internalBatch && !continued) await reserveOperation(tx, userId, created.id);
	const admission = await tx.execute<{ status: "admitted" | "AI_PLATFORM_BUSY" | "AI_BUDGET_LIMIT" }>(
		sql`SELECT master_cv_ai_admit_operation(${created.id}, ${route.requestCapMicros}::bigint, ${route.dayCapMicros}::bigint) AS status`,
	);
	const status = admission.rows[0]?.status;
	if (status !== "admitted") denyAllowance(status ?? "AI_BUDGET_LIMIT");
	await bindThread(tx, userId, created, threadId);
	if (batchOf(created) && !internalBatch) await advanceTranslation(tx, userId, created);
	return batchOf(created) && !internalBatch ? publicOperationView(tx, userId, created) : operationView(created);
}

async function advanceTranslation(
	tx: OwnerTransaction,
	ownerId: string,
	operation: Operation,
	requestKey = generateId(),
	retryFailed = false,
	partIndex?: number,
	segmentId?: string,
) {
	const batch = await translationState(tx, ownerId, operation);
	if (
		!batch ||
		batch.session.state === "complete" ||
		batch.session.failureCode === "AI_SOURCE_CHANGED" ||
		endedBeforeTranslationStarted(batch.root)
	)
		return;
	try {
		await assertSourceRevisions(tx, ownerId, operationRequest(batch.root));
		return await advanceCurrentTranslation(tx, ownerId, batch, requestKey, retryFailed, partIndex, segmentId);
	} catch (error) {
		if (!isStaleTranslationSource(error)) throw error;
		await tx
			.update(aiTranslationBatch)
			.set({
				state: "paused",
				failureCode: "AI_SOURCE_CHANGED",
				result: null,
				...(batch.session.execution && { execution: { ...batch.session.execution, retryFailedOperationIds: [] } }),
			})
			.where(eq(aiTranslationBatch.rootOperationId, batch.root.id));
		for (const part of batch.active) {
			if (part.state === "queued") await finishUnsuccessful(tx, part, "AI_SOURCE_CHANGED");
			else if (part.state === "running")
				await tx.update(aiOperation).set({ state: "cancel_requested" }).where(eq(aiOperation.id, part.id));
		}
	}
}

async function advanceCurrentTranslation(
	tx: OwnerTransaction,
	ownerId: string,
	batch: NonNullable<Awaited<ReturnType<typeof translationState>>>,
	requestKey: string,
	retryFailed: boolean,
	partIndex?: number,
	segmentId?: string,
) {
	const execution = batch.session.execution ?? { route: batch.root.route, consentVersion: batch.root.consentVersion };
	const request = { ...operationRequest(batch.root), route: execution.route, consentVersion: execution.consentVersion };
	const finalizePartialOrCompleteBatch = async () => {
		const full = await loadVariantSnapshot(tx, ownerId, request, { fullTranslation: true });
		const plan = await loadTranslationPlan(tx, ownerId, request, full, {
			maxInputCodePoints: 32000,
			maxOutputTokens: 4096,
		});
		const partEntries = batch.delivered.map((part, idx) => translationPartResult(part, batch.pending[idx]));
		const merged = mergePartialTranslationBatches(full, plan, partEntries);
		const output = translationReviewOutputSchema.parse(merged.output);
		const previousWithheldIds = execution.reviewWithheldSegmentIds;
		const recoveredSegment =
			batch.root.promptVersion === translationCandidateContract.promptVersion &&
			previousWithheldIds?.some((id) => !merged.withheldSegmentIds?.includes(id));
		const reviewState = recoveredSegment ? "waiting_review" : batch.session.reviewState;
		const apply = () =>
			tryAutoApplyTranslationInTx(tx, ownerId, batch.root.id, {
				previousWithheldIds: previousWithheldIds ? new Set(previousWithheldIds) : undefined,
			});
		if (merged.withheld && merged.withheld.count > 0) {
			await tx
				.update(aiTranslationBatch)
				.set({ state: "paused", failureCode: null, reviewState })
				.where(eq(aiTranslationBatch.rootOperationId, batch.root.id));
			return apply();
		}
		await tx
			.update(aiTranslationBatch)
			.set({
				state: "complete",
				reviewState,
				failureCode: null,
				result: {
					schemaVersion: 1,
					sourceRevision: { kind: "resume", id: full.resumeId, revision: full.sourceRevision },
					kind: "review.translation",
					output,
				},
			})
			.where(eq(aiTranslationBatch.rootOperationId, batch.root.id));
		return apply();
	};
	if (batch.index < 0) {
		return finalizePartialOrCompleteBatch();
	}
	if (batch.session.failureCode === "AI_CANCELLED" && !retryFailed) return;
	const { translationBatch: _metadata, ...parameters } = batch.root.parameters;
	let active = batch.active.length;
	let scheduled = false;
	for (let index = 0; index < batch.batch.total && active < MAX_TRANSLATION_CONCURRENT_PARTS; index++) {
		if (partIndex !== undefined && index !== partIndex) continue;
		const pending = batch.pending[index];
		if (batch.delivered[index] || (pending && isActive(pending))) continue;
		if (pending && !retryFailed && !execution.retryFailedOperationIds?.includes(pending.id)) continue;
		let retrySegmentIds: string[] | undefined;
		if (batch.batch.planVersion && pending) {
			const prev = batch.parts
				.filter((part) => batchOf(part)?.index === index && part.deliveredAt && part.result)
				.reduce<Operation | undefined>(preserveVerifiedPartSegments, undefined);
			const receipt = translationPartResult(prev, undefined);
			if (receipt.status === "delivered") {
				retrySegmentIds = receipt.withheldSegmentIds;
				if (segmentId) {
					const full = await loadVariantSnapshot(tx, ownerId, request, { fullTranslation: true });
					const plan = await loadTranslationPlan(tx, ownerId, request, full, {
						maxInputCodePoints: 32000,
						maxOutputTokens: 4096,
					});
					const ids = new Set(plan.groups.find(({ id }) => id === segmentId)?.partIds);
					retrySegmentIds = retrySegmentIds?.filter((id) => ids.has(id));
					if (!retrySegmentIds?.length) throw new ORPCError("BAD_REQUEST");
				}
			}
		}
		try {
			await tx.transaction(async (nested) => {
				await startOperation(
					nested,
					ownerId,
					{ ...request, parameters, requestKey: scheduled ? generateId() : requestKey },
					undefined,
					{
						rootId: batch.root.id,
						index,
						total: batch.batch.total,
						planHash: batch.batch.planHash,
						...(batch.batch.planVersion ? { planVersion: batch.batch.planVersion } : {}),
						...(retrySegmentIds?.length ? { retrySegmentIds } : {}),
					},
				);
			});
			active++;
			scheduled = true;
			await tx
				.update(aiTranslationBatch)
				.set({
					state: "running",
					failureCode: null,
					...(execution.retryFailedOperationIds
						? {
								execution: {
									...execution,
									retryFailedOperationIds: execution.retryFailedOperationIds.filter((id) => id !== pending?.id),
								},
							}
						: {}),
				})
				.where(eq(aiTranslationBatch.rootOperationId, batch.root.id));
			if (execution.retryFailedOperationIds)
				execution.retryFailedOperationIds = execution.retryFailedOperationIds.filter((id) => id !== pending?.id);
		} catch (error) {
			if (isStaleTranslationSource(error)) throw error;
			if (!(error instanceof ORPCError)) throw error;
			// A retry must report admission failure rather than acknowledge a no-op.
			if (retryFailed && !scheduled) throw error;
			const reason =
				(error.data as { reason?: string } | undefined)?.reason ??
				(error.code === "NOT_FOUND" ? "AI_SOURCE_UNAVAILABLE" : "AI_UNAVAILABLE");
			// Existing parts can release platform capacity. Pause only when no part can make progress.
			if (!active)
				await tx
					.update(aiTranslationBatch)
					.set({ state: "paused", failureCode: reason })
					.where(eq(aiTranslationBatch.rootOperationId, batch.root.id));
			break;
		}
	}
	// Owner decision 2026-11-24: when every part is terminal, at least one part succeeded, and
	// remaining failed parts were rejected by content/verifier checks (not transport/cost/cancellation),
	// apply all verified parts and leave rejected parts unchanged with "Not translated" + "Retry this part".
	const allPartsAttempted = batch.delivered.every((part, idx) => Boolean(part) || Boolean(batch.pending[idx]));
	const failedAreVerificationRejections =
		batch.failed.length > 0 &&
		batch.failed.every(
			(part) => part.failureCode === "AI_VERIFICATION_FAILED" || part.failureCode === "AI_REVIEW_INVALID",
		);
	if (
		!scheduled &&
		active === 0 &&
		allPartsAttempted &&
		batch.delivered.some(Boolean) &&
		failedAreVerificationRejections &&
		batch.session.failureCode !== "AI_CANCELLED"
	) {
		return finalizePartialOrCompleteBatch();
	}
}

class PreflightResult extends Error {
	constructor(
		readonly operationCost: 0 | 1,
		readonly translationParts?: number,
	) {
		super();
	}
}
export const operationService = {
	async preflight(userId: string, value: OperationRequest): Promise<OperationPreflight> {
		const request = operationRequestSchema.parse(value);
		const handler = getOperationHandler(request.kind);
		const requestFingerprint = operationFingerprint(request, handler);
		try {
			// Run the exact admission path in a rolled-back transaction: no shadow quota policy.
			await withOwnerDatabase(userId, async (tx) => {
				const view = await startOperation(tx, userId, request);
				const [reservation] = await tx
					.select({ id: aiUsageLedger.id })
					.from(aiUsageLedger)
					.where(
						and(
							eq(aiUsageLedger.operationId, view.id),
							eq(aiUsageLedger.userId, userId),
							eq(aiUsageLedger.kind, "reserve"),
						),
					);
				throw new PreflightResult(
					reservation ? 1 : 0,
					request.kind === "review.translation" ? view.progress?.total : undefined,
				);
			});
		} catch (error) {
			if (error instanceof PreflightResult)
				return {
					operationCost: error.operationCost,
					...(error.translationParts !== undefined ? { translationParts: error.translationParts } : {}),
					available: true,
					reason: null,
					requestFingerprint,
				};
			if (
				error instanceof ORPCError &&
				["PRECONDITION_FAILED", "CONFLICT", "NOT_FOUND", "BAD_REQUEST", "RESUME_LOCKED"].includes(error.code)
			) {
				const data = error.data as { reason?: string } | undefined;
				const allowanceFailure = allowanceFailureSchema.safeParse(data);
				if (!data?.reason && error.code === "CONFLICT") throw error;
				return {
					operationCost: 1 as const,
					available: false,
					...(allowanceFailure.success && allowanceFailure.data.allowance
						? { allowance: allowanceFailure.data.allowance }
						: {}),
					reason:
						data?.reason ??
						(error.code === "RESUME_LOCKED"
							? "AI_SOURCE_LOCKED"
							: error.code === "NOT_FOUND"
								? "AI_SOURCE_UNAVAILABLE"
								: error.code === "BAD_REQUEST"
									? "AI_INVALID_REQUEST"
									: "AI_UNAVAILABLE"),
					requestFingerprint,
				};
			}
			throw error;
		}
		throw new Error("AI_PREFLIGHT_UNEXPECTED_COMMIT");
	},
	start(userId: string, value: OperationRequest, options?: { threadId: string }): Promise<OperationView> {
		return withOwnerDatabase(userId, (tx) =>
			startOperation(tx, userId, operationRequestSchema.parse(value), options?.threadId),
		);
	},
	get: (userId: string, id: string) =>
		withOwnerDatabase(userId, async (tx) => {
			await lockAccountForAccounting(tx, userId);
			return publicOperationView(tx, userId, await getOwned(tx, userId, id), true);
		}),
	retryTranslation: (
		userId: string,
		id: string,
		requestKey: string,
		execution?: TranslationExecution,
		scope?: "failed_parts" | { partIndex: number; segmentId?: string | undefined },
	) =>
		withOwnerDatabase(userId, async (tx) => {
			await lockDocumentOwner(tx, userId);
			const operation = await getOwned(tx, userId, id);
			const batch = await translationState(tx, userId, operation);
			if (!batch || batch.root.id !== id) throw new ORPCError("BAD_REQUEST");
			if (endedBeforeTranslationStarted(batch.root)) return publicOperationView(tx, userId, operation);
			if (batch.session.failureCode === "AI_SOURCE_CHANGED")
				throw new ORPCError("CONFLICT", { data: { reason: "AI_SOURCE_CHANGED" } });
			await assertSourceRevisions(tx, userId, operationRequest(batch.root));
			const partIndex = typeof scope === "object" ? scope.partIndex : undefined;
			const [replay] = await tx
				.select()
				.from(aiOperation)
				.where(and(eq(aiOperation.userId, userId), eq(aiOperation.requestKey, requestKey)));
			if (replay) {
				const replayPart = batchOf(replay);
				if (replayPart?.rootId !== id || (partIndex !== undefined && replayPart.index !== partIndex))
					throw new ORPCError("CONFLICT", { data: { reason: "AI_REQUEST_KEY_REUSED" } });
				return publicOperationView(tx, userId, operation);
			}
			const retryableParts = [...batch.failed, ...batch.withheldParts];
			const selected =
				partIndex === undefined ? undefined : batch.parts.findLast((part) => batchOf(part)?.index === partIndex);
			if (partIndex !== undefined && (!selected || !retryableParts.some((part) => batchOf(part)?.index === partIndex)))
				return publicOperationView(tx, userId, operation);
			const hasRetryableParts = retryableParts.length > 0;
			const canRetry = batch.session.state !== "complete" || hasRetryableParts;
			const { route, consentVersion } = execution ?? batch.session.execution ?? batch.root;
			if (execution && canRetry) {
				// New deployments can change policy, but current processing consent remains mandatory.
				if (
					execution.route.routeId !== batch.root.route.routeId ||
					execution.route.routeRevision !== batch.root.route.routeRevision
				)
					throw new ORPCError("PRECONDITION_FAILED", { data: { reason: "AI_PROVIDER_CHANGED" } });
				await resolveApprovedRoute(userId, { ...operationRequest(batch.root), ...execution });
				await tx
					.update(aiTranslationBatch)
					.set({
						execution: {
							...batch.session.execution,
							...execution,
						},
					})
					.where(eq(aiTranslationBatch.rootOperationId, id));
			}
			if ((scope || batch.withheldParts.length > 0) && canRetry) {
				const retryPartIds = selected
					? [...new Set([...(batch.session.execution?.retryFailedOperationIds ?? []), selected.id])]
					: retryableParts.map((part) => part.id);
				const priorReview = batch.hasPartialVerifiedResult
					? await assembleTranslationBatchResult(tx, userId, batch.root)
					: null;
				const previousWithheldIds = priorReview?.withheldSegmentIds;
				await tx
					.update(aiTranslationBatch)
					.set({
						state: "running",
						failureCode: null,
						execution: {
							...batch.session.execution,
							route,
							consentVersion,
							retryFailedOperationIds: retryPartIds,
							...(Array.isArray(previousWithheldIds) && { reviewWithheldSegmentIds: previousWithheldIds }),
						},
					})
					.where(eq(aiTranslationBatch.rootOperationId, id));
			}
			await advanceTranslation(
				tx,
				userId,
				batch.root,
				requestKey,
				true,
				partIndex,
				typeof scope === "object" ? scope.segmentId : undefined,
			);
			return publicOperationView(tx, userId, await getOwned(tx, userId, id));
		}),
	getResult: (userId: string, id: string) =>
		withOwnerDatabase(userId, async (tx) => {
			const operation = await getOwned(tx, userId, id);
			const batch = await translationState(tx, userId, operation);
			if (batch) {
				const assembled = await assembleTranslationBatchResult(tx, userId, batch.root);
				if (!assembled) throw new ORPCError("PRECONDITION_FAILED");
				const {
					withheldSegmentIds: _withheldIds,
					withheldSegmentParts: _withheldParts,
					withholdingIdsComplete: _complete,
					...publicResult
				} = assembled;
				return publicResult;
			}
			if (!operation.deliveredAt || !operation.result) throw new ORPCError("PRECONDITION_FAILED");
			return operation.result;
		}),
	cancel: async (userId: string, id: string) => {
		const view = await withOwnerDatabase(userId, async (tx) => {
			await lockDocumentOwner(tx, userId);
			const operation = await getOwned(tx, userId, id);
			const batch = await translationState(tx, userId, operation);
			if (batch?.session.failureCode === "AI_SOURCE_CHANGED") return publicOperationView(tx, userId, operation);
			if (batch && batch.session.state !== "complete") {
				await tx
					.update(aiTranslationBatch)
					.set({ state: "paused", failureCode: "AI_CANCELLED" })
					.where(eq(aiTranslationBatch.rootOperationId, batch.root.id));
				for (const part of batch.active) {
					if (part.state === "queued") await finishUnsuccessful(tx, part, "AI_CANCELLED");
					else if (part.state === "running")
						await tx.update(aiOperation).set({ state: "cancel_requested" }).where(eq(aiOperation.id, part.id));
				}
				return publicOperationView(tx, userId, await getOwned(tx, userId, batch.root.id));
			}
			if (operation.state === "queued") return finishUnsuccessful(tx, operation, "AI_CANCELLED");
			if (operation.kind === "review.job-evidence" && operation.state === "cancel_requested")
				return finishUnsuccessful(tx, operation, "AI_CANCELLED");
			if (operation.state !== "running") return operationView(operation);
			const [updated] = await tx
				.update(aiOperation)
				.set({ state: "cancel_requested" })
				.where(eq(aiOperation.id, operation.id))
				.returning();
			if (!updated) throw new ORPCError("NOT_FOUND");
			// Fence job-evidence delivery now while retaining any unknown provider liability.
			if (updated.kind === "review.job-evidence") return finishUnsuccessful(tx, updated, "AI_CANCELLED");
			return operationView(updated);
		});
		if (view.state === "cancelled") for (const abort of jobEvidenceCancellationObservers.get(id) ?? []) abort();
		return view;
	},
};

export function claimNextOperation(ownerId: string): Promise<OperationLease | null> {
	return withOwnerDatabase(ownerId, async (tx) => {
		const account = await lockAccountForAccounting(tx, ownerId);
		if (!account || account.deleting) return null;
		const {
			rows: [clock],
		} = await tx.execute<{ claimed_at_ms: number }>(
			sql`SELECT floor(extract(epoch from clock_timestamp()) * 1000)::float8 AS claimed_at_ms`,
		);
		if (!clock) throw new Error("AI_CLAIM_CLOCK_UNAVAILABLE");
		const claimedAt = new Date(clock.claimed_at_ms);
		const [operation] = await tx
			.select()
			.from(aiOperation)
			.where(
				and(
					eq(aiOperation.userId, ownerId),
					or(
						and(
							eq(aiOperation.state, "queued"),
							or(
								lte(aiOperation.queueExpiresAt, claimedAt),
								and(
									lte(aiOperation.dueAt, claimedAt),
									sql`NOT EXISTS (
										SELECT 1 FROM ai_operation AS root
										WHERE ${aiOperation.kind}='review.translation'
											AND root.id=${aiOperation.parameters}->'translationBatch'->>'rootId'
											AND root.id<>${aiOperation.id} AND root.state='queued'
									)`,
								),
							),
						),
						and(inArray(aiOperation.state, ["running", "cancel_requested"]), lte(aiOperation.leaseUntil, claimedAt)),
					),
				),
			)
			.orderBy(
				sql`CASE WHEN ${aiOperation.state}='queued' AND ${aiOperation.queueExpiresAt}>${claimedAt.toISOString()}::timestamptz
					THEN 1 ELSE 0 END`,
				sql`CASE WHEN ${aiOperation.state}='queued' AND ${aiOperation.kind}='review.translation' THEN (
					SELECT count(*) FROM ai_operation AS sibling
					WHERE sibling.user_id=${aiOperation.userId} AND sibling.kind=${aiOperation.kind}
						AND sibling.parameters->'translationBatch'->>'rootId'=${aiOperation.parameters}->'translationBatch'->>'rootId'
						AND sibling.state IN ('running','cancel_requested')
				) ELSE 0 END`,
				asc(aiOperation.createdAt),
				asc(aiOperation.id),
			)
			.limit(1)
			.for("update", { skipLocked: true });
		if (!operation) return null;
		if (operation.state === "cancel_requested" || (operation.state !== "queued" && operation.deadlineAt <= claimedAt)) {
			await finishUnsuccessful(tx, operation, operation.state === "cancel_requested" ? "AI_CANCELLED" : "AI_DEADLINE");
			return null;
		}
		if (operation.state === "queued" && operation.queueExpiresAt <= claimedAt) {
			await finishUnsuccessful(tx, operation, "AI_QUEUE_EXPIRED");
			return null;
		}
		if (operation.state === "queued") {
			const slot = await tx.execute<{ allowed: boolean }>(
				sql`SELECT master_cv_ai_claim_slot(${operation.id}) AS allowed`,
			);
			if (!slot.rows[0]?.allowed) return null;
		}
		const attempts = await tx.select().from(aiOperationAttempt).where(eq(aiOperationAttempt.operationId, operation.id));
		const activeAttempts = currentContentAttempts(attempts);
		const lastAttempt = activeAttempts.at(-1);
		const writer = activeAttempts.find(
			(attempt) => attempt.stepId !== "verify" && attempt.outcome === "valid" && attempt.finishedAt && attempt.output,
		);
		if (
			attempts.some((a) => {
				if (a.finishedAt) return a.outcome === "unknown" || (a.outcome === "transient" && a.costMicros === null);
				const journal = a.stepId === "verify" ? readVerificationJournal(a.output) : null;
				return (
					a !== lastAttempt ||
					a.outcome !== "unknown" ||
					!writer ||
					!journal ||
					journal.binding.generationOrdinal !== writer.ordinal
				);
			})
		) {
			await finishUnsuccessful(tx, operation, "AI_OUTCOME_UNKNOWN");
			return null;
		}
		const token = generateId();
		await tx
			.update(aiOperation)
			.set({
				state: "running",
				leaseToken: token,
				leaseUntil: new Date(claimedAt.getTime() + 60000),
				...(operation.state === "queued" ? { executionStartedAt: claimedAt } : {}),
			})
			.where(eq(aiOperation.id, operation.id));
		if (operation.state === "queued" && batchOf(operation)?.rootId === operation.id)
			await settleOperation(tx, ownerId, operation.id);
		return { ownerId, operationId: operation.id, token };
	});
}

export function withOperationLease<T>(
	lease: OperationLease,
	work: (tx: OwnerTransaction, operation: Operation) => Promise<T>,
): Promise<T> {
	return withOwnerDatabase(lease.ownerId, async (tx) => {
		await lockDocumentOwner(tx, lease.ownerId);
		const operation = await getOwned(tx, lease.ownerId, lease.operationId);
		if (
			operation.leaseToken !== lease.token ||
			!operation.leaseUntil ||
			operation.leaseUntil.getTime() <= Date.now() ||
			!["running", "cancel_requested"].includes(operation.state)
		)
			throw new ORPCError("CONFLICT", { data: { reason: "AI_LEASE_LOST" } });
		return work(tx, operation);
	});
}

export async function heartbeatOperation(lease: OperationLease): Promise<void> {
	await withOperationLease(lease, async (tx, operation) => {
		if (operation.state === "cancel_requested") throw new Error("AI_CANCELLED");
		if (Date.now() >= operation.deadlineAt.getTime()) throw new Error("AI_DEADLINE");
		await tx
			.update(aiOperation)
			.set({ leaseUntil: new Date(Date.now() + 60000) })
			.where(eq(aiOperation.id, lease.operationId));
	});
}

export async function failOperation(
	lease: OperationLease,
	code: string,
	detail?: OperationFailureDetail,
): Promise<void> {
	await withOperationLease(lease, async (tx, operation) => {
		await finishUnsuccessful(tx, operation, code, detail);
	});
}

export function mergeWithheldItems(...reports: (WithheldReviewItems | undefined)[]): WithheldReviewItems | undefined {
	return combineWithheldItems(reports, 50);
}

function combineWithheldItems(
	reports: (WithheldReviewItems | undefined)[],
	limit?: number,
): WithheldReviewItems | undefined {
	const items = new Map<string, NonNullable<WithheldReviewItems["items"]>[number]>();
	const rules = new Set<string>();
	const summaries = new Set<string>();
	let unlisted = 0;
	for (const report of reports) {
		if (!report) continue;
		const summary = canonicalJson(report);
		if (summaries.has(summary)) continue;
		summaries.add(summary);
		for (const rule of report.rules) rules.add(rule);
		const listed = new Set<string>();
		for (const item of report.items ?? []) {
			listed.add(item.id);
			const prior = items.get(item.id);
			items.set(item.id, { ...item, ...prior });
		}
		unlisted += Math.max(0, report.count - listed.size);
	}
	const count = unlisted + items.size;
	return count
		? { count, rules: [...rules], ...(items.size ? { items: [...items.values()].slice(0, limit) } : {}) }
		: undefined;
}

/** Only a registered handler's validated output may reach this fenced delivery boundary. */
export async function deliverOperation(lease: OperationLease, output: Record<string, unknown>): Promise<OperationView> {
	const autoApplied: { value: Awaited<ReturnType<typeof advanceTranslation>> } = { value: null };
	const view = await withOperationLease(lease, async (tx, operation) => {
		if (operation.state === "cancel_requested") return finishUnsuccessful(tx, operation, "AI_CANCELLED");
		if (operation.deadlineAt.getTime() <= Date.now()) return finishUnsuccessful(tx, operation, "AI_DEADLINE");
		await resolveApprovedRoute(lease.ownerId, operationRequest(operation));
		await assertSourceRevisions(tx, lease.ownerId, operationRequest(operation));
		const handler = getOperationHandler(operation.kind, operation);
		let verifiedOutputForValidation: Record<string, unknown> = output;
		let verifierWithheld: WithheldReviewItems | undefined;
		let verifyBatchCount = 1;
		if (handler.verifier) {
			const request = operationRequest(operation);
			const attempts = await tx
				.select()
				.from(aiOperationAttempt)
				.where(eq(aiOperationAttempt.operationId, operation.id));
			const currentAttempts = currentContentAttempts(attempts);
			const generated = currentAttempts.find(
				(a) => a.stepId !== "verify" && a.outcome === "valid" && a.finishedAt && a.output,
			);
			const verifyAttempts = currentAttempts
				.filter((a) => a.stepId === "verify" && a.outcome === "valid" && a.finishedAt && a.output)
				.sort((a, b) => a.ordinal - b.ordinal);
			try {
				if (!generated?.output || canonicalJson(generated.output) !== canonicalJson(output))
					throw new Error("AI_VERIFICATION_REQUIRED");
				const latest = currentAttempts.findLast((attempt) => attempt.stepId === "verify");
				const pass = verifyAttempts.at(-1);
				if (latest?.output?._verifyJournalVersion !== undefined) {
					if (latest !== pass || !latest.output || latest.ordinal <= generated.ordinal)
						throw new Error("AI_VERIFICATION_REQUIRED");
					const allowSegmentWithholding =
						generated.stepId === CONTENT_RETRY_STEP ||
						currentAttempts.some((attempt) => attempt.stepId === CONTENT_RETRY_STEP);
					const plan = await planOperationVerification(
						tx,
						lease.ownerId,
						request,
						handler,
						output,
						allowSegmentWithholding,
					);
					const binding = bindVerificationPass(generated.ordinal, generated.output, plan.batches);
					const filtered = await applyVerificationPass(
						tx,
						lease.ownerId,
						request,
						handler.verifier,
						output,
						verificationPassVerdicts(latest.output, binding, handler.verifier.withholdTruncatedBatch),
						allowSegmentWithholding,
					);
					if (filtered?.output) verifiedOutputForValidation = filtered.output as Record<string, unknown>;
					if (filtered?.withheld) verifierWithheld = filtered.withheld as NonNullable<typeof verifierWithheld>;
					if (typeof filtered?.batchCount === "number") verifyBatchCount = filtered.batchCount;
				} else if (
					pass?.output &&
					Array.isArray(pass.output._verifyCalls) &&
					handler.verifier.validateBatchesInContext
				) {
					if (pass.ordinal <= generated.ordinal) throw new Error("AI_VERIFICATION_REQUIRED");
					const filtered = await handler.verifier.validateBatchesInContext(
						tx,
						lease.ownerId,
						operationRequest(operation),
						output,
						verificationPassVerdicts(pass.output),
						{ allowSegmentWithholding: true },
					);
					verifiedOutputForValidation = filtered.output;
					verifierWithheld = filtered.withheld;
					verifyBatchCount = filtered.batchCount;
				} else if (
					typeof pass?.output?._verifyBatchIndex === "number" &&
					typeof pass.output._verifyBatchTotal === "number" &&
					handler.verifier.validateBatchesInContext
				) {
					const verdicts = legacySplitVerificationVerdicts(
						verifyAttempts,
						generated.ordinal,
						pass.output._verifyBatchTotal,
					);
					const filtered = await handler.verifier.validateBatchesInContext(
						tx,
						lease.ownerId,
						operationRequest(operation),
						output,
						verdicts,
						{ allowSegmentWithholding: true },
					);
					verifiedOutputForValidation = filtered.output;
					verifierWithheld = filtered.withheld;
					verifyBatchCount = filtered.batchCount;
				} else {
					const verified = verifyAttempts.at(-1);
					if (!verified?.output || verified.ordinal <= generated.ordinal) throw new Error("AI_VERIFICATION_REQUIRED");
					if (handler.verifier.validateInContext) {
						const filtered = await handler.verifier.validateInContext(
							tx,
							lease.ownerId,
							operationRequest(operation),
							output,
							verified.output,
							{ allowSegmentWithholding: true },
						);
						if (filtered && typeof filtered === "object" && "output" in filtered && filtered.output) {
							verifiedOutputForValidation = filtered.output as Record<string, unknown>;
						}
						if (filtered && typeof filtered === "object" && "withheld" in filtered && filtered.withheld) {
							verifierWithheld = filtered.withheld as {
								count: number;
								rules: string[];
								items?: Array<{ id: string; spanIds?: string[]; reason?: string; field?: string; section?: string }>;
							};
						}
					} else {
						const filtered = handler.verifier.validate(output, verified.output);
						if (filtered && typeof filtered === "object" && "output" in filtered && filtered.output) {
							verifiedOutputForValidation = filtered.output as Record<string, unknown>;
						}
						if (filtered && typeof filtered === "object" && "withheld" in filtered && filtered.withheld) {
							verifierWithheld = filtered.withheld as {
								count: number;
								rules: string[];
								items?: Array<{ id: string; spanIds?: string[]; reason?: string; field?: string; section?: string }>;
							};
						}
					}
				}
			} catch (error) {
				return finishUnsuccessful(tx, operation, "AI_VERIFICATION_FAILED", verificationFailureDetail(error));
			}
		}
		const internalWithheldIds =
			handler.translationPlanVersion && Array.isArray(verifiedOutputForValidation.withheldSegmentIds)
				? verifiedOutputForValidation.withheldSegmentIds
				: undefined;
		const { withheldSegmentIds: _internal, ...deliveryData } = verifiedOutputForValidation;
		let result = (handler.deliveryOutput ?? handler.output).parse(
			internalWithheldIds ? deliveryData : verifiedOutputForValidation,
		);
		const validateDelivery = handler.validateDelivery ?? handler.validateResult;
		if (validateDelivery) {
			try {
				result = await validateDelivery(tx, lease.ownerId, operationRequest(operation), result, {
					allowSegmentWithholding: true,
				});
			} catch (error) {
				return finishUnsuccessful(tx, operation, "AI_REVIEW_INVALID", verificationFailureDetail(error));
			}
		}
		const guardWithheld =
			"withheld" in result && result.withheld && typeof result.withheld === "object"
				? (result.withheld as WithheldReviewItems)
				: undefined;
		const mergedWithheld =
			operation.kind === "review.job-evidence"
				? combineWithheldItems([verifierWithheld, guardWithheld])
				: mergeWithheldItems(verifierWithheld, guardWithheld);
		if (mergedWithheld) {
			if (operation.kind === "review.job-evidence" && mergedWithheld.items) {
				const original = jobEvidenceSchema.parse(output);
				const findings = new Map([
					...original.requirements.map(({ id, explanation }) => [id, explanation] as const),
					...original.notes.map((note, index) => [`note:${index}`, note] as const),
				]);
				mergedWithheld.items = mergedWithheld.items.map((item) => {
					const text = item.text ?? findings.get(item.id);
					return text ? { ...item, text } : item;
				});
			}
			result = { ...result, withheld: mergedWithheld };
		}
		if (internalWithheldIds?.length) result = { ...result, withheldSegmentIds: internalWithheldIds };
		if (operation.copyClaim) {
			if (!handler.createCopy) throw new Error("AI_COPY_HANDLER_UNAVAILABLE");
			const id = await createResumeInTransaction(
				tx,
				{ ...handler.createCopy(result), userId: lease.ownerId, tags: [], creation: operation.copyClaim },
				{ reservationOperationId: operation.id },
			);
			result = { ...result, createdResumeId: id };
		}
		const [updated] = await tx
			.update(aiOperation)
			.set({
				state:
					operation.kind.startsWith("review.") &&
					Array.isArray(result.questions) &&
					result.questions.length === 0 &&
					(Array.isArray(result.proposals)
						? result.proposals.length === 0
						: Array.isArray(result.candidates) && result.candidates.length === 0)
						? "succeeded"
						: handler.resultState,
				result,
				...(mergedWithheld || verifyBatchCount > 1
					? {
							failureDetail: {
								...(mergedWithheld ? { withheldCount: mergedWithheld.count, withheldRules: mergedWithheld.rules } : {}),
								...(verifyBatchCount > 1 ? { verifyBatchCount } : {}),
							},
						}
					: {}),
				deliveredAt: new Date(),
				leaseToken: null,
				leaseUntil: null,
			})
			.where(eq(aiOperation.id, operation.id))
			.returning();
		await settleOperation(tx, lease.ownerId, operation.id);
		const threads = await tx
			.select()
			.from(agentThread)
			.where(eq(agentThread.activeOperationId, operation.id))
			.for("update");
		for (const thread of threads) {
			const [last] = await tx
				.select({ sequence: agentMessage.sequence })
				.from(agentMessage)
				.where(eq(agentMessage.threadId, thread.id))
				.orderBy(sql`${agentMessage.sequence} DESC`)
				.limit(1);
			const text = typeof result.text === "string" ? result.text : JSON.stringify(result);
			await tx.insert(agentMessage).values({
				userId: lease.ownerId,
				threadId: thread.id,
				role: "assistant",
				sequence: (last?.sequence ?? 0) + 1,
				uiMessage: {
					id: operation.id,
					role: "assistant",
					parts: operation.kind.startsWith("review.")
						? [{ type: "data-review", data: { operationId: operation.id } }]
						: [{ type: "text", text }],
				},
			});
			await tx.update(agentThread).set({ lastMessageAt: new Date() }).where(eq(agentThread.id, thread.id));
		}
		await tx.execute(sql`SELECT master_cv_ai_reconcile_budget(${operation.id})`);
		if (!updated) throw new ORPCError("NOT_FOUND");
		autoApplied.value = batchOf(updated) ? await advanceTranslation(tx, lease.ownerId, updated) : null;
		return operationView(updated);
	});
	if (autoApplied.value)
		await notifyResumeUpdated({
			type: "resume.updated",
			resumeId: autoApplied.value.resumeId,
			userId: lease.ownerId,
			updatedAt: autoApplied.value.updatedAt,
			mutation: "update",
		});
	return view;
}

export async function discoverAiOwners(): Promise<string[]> {
	const result = await getPool().query<{ user_id: string }>("SELECT user_id FROM master_cv_ai_queue_owners()");
	return result.rows.map((r) => r.user_id);
}

/** Owner discovery is bounded; unknown liability moves to conservative spend five minutes after deadline. */
export async function reconcileExpiredAccounting(ownerId: string): Promise<void> {
	await removeExpiredReviewSources(ownerId);
	await withOwnerDatabase(ownerId, async (tx) => {
		const account = await lockAccountForAccounting(tx, ownerId);
		if (!account) return;
		const operations = await tx
			.select({ id: aiOperation.id })
			.from(aiOperation)
			.where(
				and(
					eq(aiOperation.userId, ownerId),
					eq(aiOperation.budgetClosed, true),
					sql`${aiOperation.reservedMicros}>0`,
					sql`${aiOperation.deadlineAt} + interval '5 minutes' <= now()`,
				),
			)
			.limit(100);
		for (const operation of operations) await tx.execute(sql`SELECT master_cv_ai_reconcile_budget(${operation.id})`);
		if (account.deleting) return;
		// Recover missing children from durable state even when a prior worker left no queued operation.
		const sessions = await tx
			.select({ id: aiTranslationBatch.rootOperationId })
			.from(aiTranslationBatch)
			.where(
				and(
					eq(aiTranslationBatch.userId, ownerId),
					sql`${aiTranslationBatch.state} <> 'complete'`,
					sql`${aiTranslationBatch.failureCode} IS DISTINCT FROM 'AI_CANCELLED'`,
					sql`${aiTranslationBatch.failureCode} IS DISTINCT FROM 'AI_SOURCE_CHANGED'`,
					or(
						sql`${aiTranslationBatch.total} > (SELECT count(DISTINCT o.parameters->'translationBatch'->>'index') FROM ai_operation o WHERE o.user_id = ${ownerId} AND o.parameters->'translationBatch'->>'rootId' = ${aiTranslationBatch.rootOperationId})`,
						sql`jsonb_array_length(COALESCE(${aiTranslationBatch.execution}->'retryFailedOperationIds', '[]'::jsonb)) > 0`,
					),
				),
			)
			.limit(100);
		for (const session of sessions) await advanceTranslation(tx, ownerId, await getOwned(tx, ownerId, session.id));
	});
}
