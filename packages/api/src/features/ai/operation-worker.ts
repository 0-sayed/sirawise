import type { OwnerTransaction } from "@reactive-resume/db/owner-scope";
import { setTimeout as delay } from "node:timers/promises";
import { ORPCError } from "@orpc/client";
import { and, asc, eq, isNull } from "drizzle-orm";
import { sql } from "drizzle-orm";
import { lockAccountForAccounting } from "@reactive-resume/db/account-state";
import { withOwnerDatabase } from "@reactive-resume/db/owner-scope";
import { aiOperation, aiOperationAttempt } from "@reactive-resume/db/schema";
import { isUiLocale } from "@reactive-resume/utils/locale";
import { executeApprovedStep, translationWriterCallBound, verificationCallBound, type AttemptFailure } from "./adapter";
import { fitVerificationWave } from "./attempt-budget";
import { CONTENT_RETRY_STEP, currentContentAttempts, isContentRejection } from "./content-retry";
import {
	assertSourceRevisions,
	claimNextOperation,
	deliverOperation,
	discoverAiOwners,
	failOperation,
	heartbeatOperation,
	reconcileExpiredAccounting,
	operationRequest,
	withOperationLease,
	MAX_TRANSLATION_CONCURRENT_PARTS,
	observeJobEvidenceCancellation,
	type OperationLease,
} from "./operations";
import { buildModelPayload } from "./payload";
import { getOperationHandler, resolveApprovedRoute } from "./route-policy";
import {
	VerificationGateError,
	providerAccountFailureDetail,
	verificationFailureDetail,
	type TransportFailureDetail,
} from "./verification-failure";
import {
	applyVerificationPass,
	bindVerificationPass,
	createVerificationJournal,
	isVerificationTruncation,
	legacySplitVerificationVerdicts,
	makeVerificationCall,
	planOperationVerification,
	readVerificationJournal,
	recoverVerificationPass,
	verificationPassCostLimit,
	verificationPassIncurred,
	verificationPassVerdicts,
	type BoundVerificationCall,
} from "./verification-journal";
import { canFailOverVerifier, resolveReviewVerifierRoute, resolveReviewVerifierRoutes } from "./verifier-policy";

export const PRE_RESPONSE_TRANSIENT_MIN_DEADLINE_MS = 1000;
export const PRE_RESPONSE_TRANSIENT_DELAY_MIN_MS = 1000;
export const PRE_RESPONSE_TRANSIENT_DELAY_MAX_MS = 3000;

// Writer and verifier p95 in milliseconds from Planning/context/technical/ai.md.
const measuredCallP95: Readonly<Record<string, readonly [number, number]>> = {
	"review.cover-letter": [12400, 25800],
	"review.extraction": [23000, 22700],
	"review.job-evidence": [21000, 60200],
	"review.summary": [5700, 15600],
	"review.tailoring": [11200, 31500],
	"review.translation": [14200, 34900],
	"review.wording": [11800, 9800],
};

export function computePreResponseRetryDelayMs(
	nowMs: number,
	deadlineAtMs: number,
	random: () => number = Math.random,
): number {
	const availableForDelay = Math.max(0, deadlineAtMs - nowMs - PRE_RESPONSE_TRANSIENT_MIN_DEADLINE_MS);
	const jittered =
		PRE_RESPONSE_TRANSIENT_DELAY_MIN_MS +
		Math.floor(
			Math.min(1, Math.max(0, random())) * (PRE_RESPONSE_TRANSIENT_DELAY_MAX_MS - PRE_RESPONSE_TRANSIENT_DELAY_MIN_MS),
		);
	return Math.min(jittered, availableForDelay);
}

export function transportFailureDetail(failure?: AttemptFailure): TransportFailureDetail | undefined {
	if (!failure) return undefined;
	const causeCode = failure.code ?? failure.causes?.find((cause) => cause.code)?.code;
	return {
		errorClass: failure.errorClass,
		message: failure.message,
		...(failure.code ? { code: failure.code } : {}),
		...(causeCode ? { causeCode } : {}),
		httpStatus: failure.httpStatus,
		bytesReceived: failure.bytesReceived,
		requestSent: Boolean(failure.requestSent),
		...(failure.abortCause ? { abortCause: failure.abortCause } : {}),
		...(failure.timedOut ? { timedOut: true } : {}),
		...(failure.providerErrorCode ? { providerErrorCode: failure.providerErrorCode } : {}),
		...(failure.causes?.length ? { causes: failure.causes } : {}),
	};
}

export function canRetryPreResponseTransient(input: {
	outcome: {
		outcome: string;
		responseId: string | null;
		inputTokens: number | null;
		outputTokens: number | null;
		cachedTokens: number | null;
		costMicros: number | null;
		failure?: {
			timedOut?: boolean;
			abortCause?: AttemptFailure["abortCause"];
			httpStatus: number | null;
			bytesReceived: boolean;
			generationId: string | null;
		};
	};
	stepId: string;
	alreadyRetried: boolean;
	nowMs: number;
	deadlineAtMs: number;
	consumedMicros: number;
	maxCallCostMicros: number;
	reservedMicros: number;
}): boolean {
	const { outcome } = input;
	return (
		!input.alreadyRetried &&
		input.stepId !== "repair" &&
		outcome.outcome === "transient" &&
		outcome.costMicros === null &&
		outcome.responseId === null &&
		outcome.inputTokens === null &&
		outcome.outputTokens === null &&
		outcome.cachedTokens === null &&
		!outcome.failure?.timedOut &&
		!outcome.failure?.abortCause &&
		(outcome.failure?.httpStatus ?? null) === null &&
		!outcome.failure?.bytesReceived &&
		!outcome.failure?.generationId &&
		input.nowMs + PRE_RESPONSE_TRANSIENT_MIN_DEADLINE_MS < input.deadlineAtMs &&
		input.consumedMicros + input.maxCallCostMicros <= input.reservedMicros
	);
}

async function prepareInput<T>(signal: AbortSignal, work: () => Promise<T>): Promise<T> {
	signal.throwIfAborted();
	let abort: () => void = () => undefined;
	try {
		return await new Promise<T>((resolve, reject) => {
			abort = () => reject(signal.reason);
			signal.addEventListener("abort", abort, { once: true });
			work().then(resolve, reject);
		});
	} finally {
		signal.removeEventListener("abort", abort);
	}
}

async function recordLateVerificationCost(
	lease: OperationLease,
	attemptId: string,
	dispatch: BoundVerificationCall,
	costMicros: number,
) {
	await withOwnerDatabase(lease.ownerId, async (tx) => {
		if (!(await lockAccountForAccounting(tx, lease.ownerId))) return;
		const [operation] = await tx
			.select()
			.from(aiOperation)
			.where(and(eq(aiOperation.userId, lease.ownerId), eq(aiOperation.id, lease.operationId)))
			.for("update");
		if (!operation) return;
		const [attempt] = await tx
			.select()
			.from(aiOperationAttempt)
			.where(and(eq(aiOperationAttempt.operationId, operation.id), eq(aiOperationAttempt.id, attemptId)))
			.for("update");
		if (!attempt) return;
		const journal = readVerificationJournal(attempt.output);
		if (!journal) return;
		const index = journal.calls.findIndex(
			(call) =>
				call.batchKey === dispatch.batchKey &&
				call.endpointSlot === dispatch.endpointSlot &&
				call.dispatchIndex === dispatch.dispatchIndex &&
				call.boundMicros === dispatch.boundMicros &&
				call.outcome === "pending" &&
				call.costMicros === null,
		);
		if (index < 0) return;
		await tx
			.update(aiOperationAttempt)
			.set({
				output: sql`jsonb_set(${aiOperationAttempt.output}, ARRAY['_verifyCalls', ${String(index)}, 'costMicros'], to_jsonb(${costMicros}::bigint))`,
			})
			.where(eq(aiOperationAttempt.id, attemptId));
		if (operation.budgetClosed && operation.actualMicros === null)
			await tx.execute(sql`SELECT master_cv_ai_reconcile_budget(${operation.id})`);
	});
}

export async function executeLease(lease: OperationLease, shutdown?: AbortSignal): Promise<void> {
	const controller = new AbortController();
	let heartbeat = Promise.resolve();
	let deadlineAt: number | undefined;
	let preparingInput = false;
	let stopObservingCancellation: (() => void) | undefined;
	const timer = setInterval(() => {
		heartbeat = heartbeat
			.then(() => heartbeatOperation(lease))
			.catch(() => {
				controller.abort();
			});
	}, 15000);
	try {
		const operation = await withOperationLease(lease, (_tx, row) => Promise.resolve(row));
		if (operation.kind === "review.job-evidence") {
			stopObservingCancellation = observeJobEvidenceCancellation(lease.operationId, () =>
				controller.abort(new Error("AI_CANCELLED")),
			);
		}
		deadlineAt = operation.deadlineAt.getTime();
		const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(Math.max(1, deadlineAt - Date.now()))]);
		const request = operationRequest(operation);
		const handler = getOperationHandler(operation.kind, operation);
		const interfaceLocale = request.parameters.interfaceLocale;
		const writerPrompt =
			handler.systemPrompt && isUiLocale(interfaceLocale)
				? `${handler.systemPrompt}\nWrite questions, explanations and notes addressed to the user in ${interfaceLocale === "ar-SA" ? "Arabic (ar-SA)" : "English (en-US)"}. Keep CV text, letter text, extracted values and evidence in their required document or source language.`
				: handler.systemPrompt;
		const withDispatch = (send: () => Promise<void>) =>
			withOperationLease(lease, async (tx, current) => {
				if (current.state === "cancel_requested") throw new Error("AI_CANCELLED");
				if (current.deadlineAt.getTime() <= Date.now()) throw new Error("AI_DEADLINE");
				await assertSourceRevisions(tx, lease.ownerId, request);
				await resolveApprovedRoute(lease.ownerId, request, tx);
				const budget = await tx.execute<{ allowed: boolean }>(
					sql`SELECT master_cv_ai_can_dispatch(${lease.operationId}) AS allowed`,
				);
				if (!budget.rows[0]?.allowed) throw new Error("AI_REQUEST_COST_LIMIT");
				await send();
			});
		const translationRootId =
			request.kind === "review.translation"
				? (request.parameters.translationBatch as { rootId: string } | undefined)?.rootId
				: undefined;
		const sharesTranslationBudget = translationRootId !== undefined;
		const holdTranslationBudget = async (tx: OwnerTransaction, liability: number) => {
			const result = await tx.execute<{ status: string }>(
				sql`SELECT master_cv_ai_hold_translation(${lease.operationId}, ${liability}::bigint) AS status`,
			);
			return result.rows[0]?.status;
		};
		const withDispatchBudget = async <T>(liability: number, work: Parameters<typeof withOperationLease<T>>[1]) => {
			if (!sharesTranslationBudget) return withOperationLease(lease, work);
			while (true) {
				const result = await withOperationLease(lease, async (tx, current) => {
					const status = await holdTranslationBudget(tx, liability);
					if (status === "held") return { value: await work(tx, current) };
					if (status !== "wait") throw new Error("AI_REQUEST_COST_LIMIT");
					return null;
				});
				if (result) return result.value;
				await delay(25, undefined, { signal });
			}
		};
		const previous = await withOwnerDatabase(lease.ownerId, (tx) =>
			tx
				.select()
				.from(aiOperationAttempt)
				.where(eq(aiOperationAttempt.operationId, lease.operationId))
				.orderBy(asc(aiOperationAttempt.ordinal)),
		);
		const recoveryRoute = await resolveApprovedRoute(lease.ownerId, request);
		const requestBudget = sharesTranslationBudget ? recoveryRoute.requestCapMicros : operation.reservedMicros;
		let consumedMicros = previous.reduce(
			(sum, attempt) =>
				sum +
				(attempt.costMicros ??
					(attempt.stepId === "verify"
						? verificationPassIncurred(
								attempt.output,
								resolveReviewVerifierRoute(recoveryRoute, request.kind).maxCallCostMicros,
							)
						: recoveryRoute.maxCallCostMicros)),
			0,
		);
		if (
			recoveryRoute.requestCapMicros !== requestBudget ||
			consumedMicros > requestBudget ||
			previous.some(
				(attempt) =>
					(attempt.output?._verifyJournalVersion &&
						(!readVerificationJournal(attempt.output) ||
							(verificationPassCostLimit(
								attempt.output,
								resolveReviewVerifierRoute(recoveryRoute, request.kind).maxCallCostMicros,
							) === 0 &&
								readVerificationJournal(attempt.output)?.calls.length !== 0))) ||
					(attempt.costMicros !== null &&
						attempt.costMicros >
							(attempt.stepId === "verify"
								? verificationPassCostLimit(
										attempt.output,
										resolveReviewVerifierRoute(recoveryRoute, request.kind).maxCallCostMicros,
									)
								: recoveryRoute.maxCallCostMicros)),
			)
		) {
			await failOperation(lease, "AI_REQUEST_COST_LIMIT");
			return;
		}
		const currentAttempts = currentContentAttempts(previous);
		let contentRetried = previous.some((a) => a.stepId === CONTENT_RETRY_STEP);
		let retryRequested = false;
		const completed = currentAttempts.find(
			(a) => a.stepId !== "verify" && a.outcome === "valid" && a.finishedAt && a.output,
		);
		let generated = completed?.output ?? null;
		let writerOrdinal = completed?.ordinal;
		const verified = currentAttempts.findLast((a) => a.stepId === "verify");
		const closedJournal = verified?.finishedAt ? readVerificationJournal(verified.output) : null;
		if (closedJournal && verified?.outcome !== "valid") {
			// Per-batch retries were handled inside this pass. A closed failure cannot start a new pass.
			const failed = [...closedJournal.latest.values()].find((call) => call.outcome !== "valid");
			const rule = failed?.output?._verificationFailureRule;
			if (failed?.outcome === "ACCOUNT_ERROR")
				await failOperation(lease, "AI_PROVIDER_UNAVAILABLE", providerAccountFailureDetail(failed.failure));
			else if (failed?.failure?.abortCause === "operation_deadline")
				await failOperation(lease, "AI_DEADLINE", transportFailureDetail(failed.failure));
			else if (failed?.failure?.timedOut) await failOperation(lease, "AI_TIMEOUT");
			else if (failed?.outcome === "unknown" || failed?.outcome === "pending")
				await failOperation(lease, "AI_OUTCOME_UNKNOWN", transportFailureDetail(failed.failure));
			else if (typeof rule === "string") await failOperation(lease, "AI_VERIFICATION_INCOMPLETE", { rule });
			else await failOperation(lease, "AI_VERIFIER_UNAVAILABLE", transportFailureDetail(failed?.failure));
			return;
		}
		let resumable = verified && !verified.finishedAt ? verified : undefined;
		const transientRetryLimit = recoveryRoute.transientRetries ?? recoveryRoute.translationTransientRetries ?? 1;
		const transientFailures = new Map<string, number>();
		const retryStep = (step: string) => (step === "verify" ? "verify" : "writer");
		for (const attempt of previous) {
			if (attempt.outcome === "transient" && attempt.costMicros !== null && attempt.stepId !== "repair") {
				const key = retryStep(attempt.stepId);
				transientFailures.set(key, (transientFailures.get(key) ?? 0) + 1);
			}
		}
		const transientCallAllowance = () =>
			[...transientFailures.values()].reduce((sum, count) => sum + Math.min(count, transientRetryLimit), 0);
		// Owner decision 2026-11-22: at most one automatic retry per operation for a pre-response
		// transient transport error (no HTTP status, responseId, usage, or cost). That single retry
		// grants +1 call allowance on top of route.maxCalls while sharing the operation's reservation,
		// callTimeoutMs, deadlineMs, and single user credit charge.
		let preResponseRetried = previous.some(
			(attempt) =>
				readVerificationJournal(attempt.output)?.calls.some((call) => call.dispatchIndex === 2) ||
				(attempt.outcome === "transient" &&
					attempt.costMicros === null &&
					attempt.responseId === null &&
					attempt.inputTokens === null &&
					attempt.outputTokens === null &&
					attempt.cachedTokens === null &&
					attempt.stepId !== "repair"),
		);
		const preResponseCallAllowance = () => (preResponseRetried ? 1 : 0);
		const lastAttempt = currentAttempts.at(-1);
		let writerTimedOut = previous.some((attempt) => attempt.output?._writerCallTimedOut === true);
		const timing = measuredCallP95[request.kind];
		const hasTimeForTimeoutRetry = (step: "writer" | "verify") =>
			timing !== undefined && operation.deadlineAt.getTime() - Date.now() >= timing[step === "verify" ? 1 : 0];
		const recoveredWriterTimeout =
			lastAttempt?.outcome === "unknown" &&
			lastAttempt.output?._writerTimeoutRetryPending === true &&
			transientRetryLimit > 0 &&
			hasTimeForTimeoutRetry("writer");
		const recoveredTransient = !!(
			transientRetryLimit &&
			lastAttempt?.outcome === "transient" &&
			lastAttempt.costMicros !== null &&
			lastAttempt.stepId !== "repair" &&
			(transientFailures.get(retryStep(lastAttempt.stepId)) ?? 0) <= transientRetryLimit
		);
		if (
			transientRetryLimit &&
			lastAttempt?.outcome === "transient" &&
			lastAttempt.costMicros !== null &&
			!recoveredTransient
		) {
			await failOperation(
				lease,
				lastAttempt.output?._verificationFailureRule
					? "AI_VERIFICATION_INCOMPLETE"
					: lastAttempt.stepId === "verify"
						? "AI_VERIFIER_UNAVAILABLE"
						: "AI_TRANSIENT",
				lastAttempt.output?._verificationFailureRule
					? { rule: String(lastAttempt.output._verificationFailureRule) }
					: undefined,
			);

			return;
		}
		const backoff = () => delay(250 + Math.floor(Math.random() * 100), undefined, { signal });
		let nextStep =
			generated && handler.verifier
				? "verify"
				: currentAttempts.at(-1)?.outcome === "invalid"
					? "repair"
					: contentRetried
						? CONTENT_RETRY_STEP
						: "generate";
		const rejectContent = async (error: unknown, failureCode: string): Promise<void> => {
			if (!contentRetried && isContentRejection(error)) {
				contentRetried = true;
				retryRequested = true;
				generated = null;
				nextStep = CONTENT_RETRY_STEP;
				return;
			}
			await failOperation(lease, failureCode, verificationFailureDetail(error));
		};
		const incompleteVerificationRule = (error: unknown): string | undefined => {
			if (error instanceof VerificationGateError && error.message === "AI_VERIFICATION_INCOMPLETE") return error.rule;
			if (
				error instanceof Error &&
				(error.message === "AI_VERIFICATION_CITATION" || error.message === "LETTER_VERIFICATION_INCOMPLETE")
			)
				return error.message;
			return undefined;
		};
		const rejectVerification = async (
			error: unknown,
			attempt: (typeof previous)[number],
			allowPassRetry = true,
		): Promise<void> => {
			if (!incompleteVerificationRule(error)) {
				await rejectContent(error, "AI_VERIFICATION_FAILED");
				return;
			}
			const count = (transientFailures.get("verify") ?? 0) + 1;
			transientFailures.set("verify", count);
			if (allowPassRetry && attempt.costMicros !== null && count <= transientRetryLimit) {
				retryRequested = true;
				nextStep = "verify";
				await backoff();
			} else await failOperation(lease, "AI_VERIFICATION_INCOMPLETE", verificationFailureDetail(error));
		};

		const deliverContent = async (output: Record<string, unknown>): Promise<void> => {
			const result = await deliverOperation(lease, output);
			if (result.resultId)
				console.info("[ai-operation]", {
					event: "delivered",
					kind: operation.kind,
					operationId: lease.operationId,
					generationAttempt: contentRetried ? 2 : 1,
				});
		};
		const validateGenerated = async (output: Record<string, unknown>): Promise<boolean> => {
			try {
				const validateResult = handler.validateCandidate ?? handler.validateResult;
				if (validateResult)
					await withOperationLease(lease, (tx) =>
						validateResult(tx, lease.ownerId, request, output, { allowSegmentWithholding: contentRetried }),
					);
				return true;
			} catch (error) {
				await rejectContent(error, "AI_REVIEW_INVALID");
				return false;
			}
		};
		if (generated && !(await validateGenerated(generated)) && !retryRequested) return;
		if (!resumable && !retryRequested && !recoveredTransient && completed?.output && (!handler.verifier || verified)) {
			try {
				if (handler.verifier) {
					if (verified?.outcome !== "valid" || !verified.finishedAt || !verified.output) {
						await failOperation(lease, "AI_VERIFIER_UNAVAILABLE");
						return;
					}
					const verifier = handler.verifier;
					const validateInContext = verifier.validateInContext;
					const validateBatchesInContext = verifier.validateBatchesInContext;
					const completedOutput = completed.output;
					const verifiedOutput = verified.output;
					if (verifiedOutput._verifyJournalVersion !== undefined)
						await withOperationLease(lease, async (tx) => {
							const plan = await planOperationVerification(
								tx,
								lease.ownerId,
								request,
								handler,
								completedOutput,
								contentRetried,
							);
							const binding = bindVerificationPass(completed.ordinal, completedOutput, plan.batches);
							await applyVerificationPass(
								tx,
								lease.ownerId,
								request,
								verifier,
								completedOutput,
								verificationPassVerdicts(verifiedOutput, binding, verifier.withholdTruncatedBatch),
								contentRetried,
							);
						});
					else if (Array.isArray(verifiedOutput._verifyCalls) && validateBatchesInContext)
						await withOperationLease(lease, (tx) =>
							validateBatchesInContext(
								tx,
								lease.ownerId,
								request,
								completedOutput,
								verificationPassVerdicts(verifiedOutput),
								{ allowSegmentWithholding: contentRetried },
							),
						);
					else if (
						typeof verifiedOutput._verifyBatchIndex === "number" &&
						typeof verifiedOutput._verifyBatchTotal === "number" &&
						validateBatchesInContext
					) {
						const verdicts = legacySplitVerificationVerdicts(
							currentAttempts.filter((attempt) => attempt.stepId === "verify"),
							completed.ordinal,
							verifiedOutput._verifyBatchTotal,
						);
						await withOperationLease(lease, (tx) =>
							validateBatchesInContext(tx, lease.ownerId, request, completedOutput, verdicts, {
								allowSegmentWithholding: contentRetried,
							}),
						);
					} else if (validateInContext)
						await withOperationLease(lease, (tx) =>
							validateInContext(tx, lease.ownerId, request, completedOutput, verifiedOutput),
						);
					else verifier.validate(completed.output, verified.output);
				}
			} catch (error) {
				if (verified) await rejectVerification(error, verified, !closedJournal);
				else await rejectContent(error, "AI_VERIFICATION_FAILED");
				if (!retryRequested) return;
			}
			if (!retryRequested) {
				await deliverContent(completed.output);
				return;
			}
		}
		const last = currentAttempts.at(-1);
		if (
			!retryRequested &&
			last &&
			!generated &&
			!recoveredWriterTimeout &&
			!["invalid", "transient"].includes(last.outcome ?? "")
		) {
			await failOperation(lease, last.output?._writerCallTimedOut ? "AI_TIMEOUT" : "AI_RECOVERED_TERMINAL");
			return;
		}
		let repairs = previous.filter((a) => a.stepId === "repair").length;
		if (!retryRequested && !generated && last?.stepId === "repair") {
			await failOperation(lease, "AI_REPAIR_LIMIT");
			return;
		}
		if (recoveredTransient) await backoff();
		// A verifier pass owns one ordinal and journals every physical call, including batch retries.
		let logicalCalls = previous.filter(
			(attempt, index) =>
				attempt.stepId !== "verify" ||
				previous[index - 1]?.stepId !== "verify" ||
				attempt.output?._verifyBatchIndex === 0 ||
				!attempt.output?._verifyBatchTotal,
		).length;
		const maxAttempts = 7;
		for (let ordinal = resumable?.ordinal ?? previous.length + 1; ordinal <= maxAttempts; ordinal++) {
			const writerRoute = await resolveApprovedRoute(lease.ownerId, request);
			const verifierRoutes = nextStep === "verify" ? resolveReviewVerifierRoutes(writerRoute, request.kind) : null;
			const route = verifierRoutes?.primary ?? writerRoute;
			if (Date.now() >= operation.deadlineAt.getTime()) throw new Error("AI_DEADLINE");
			const callLimit =
				route.maxCalls +
				(contentRetried ? (handler.verifier ? 2 : 1) : 0) +
				transientCallAllowance() +
				preResponseCallAllowance();
			if (!resumable && logicalCalls >= callLimit) break;
			if (!resumable) logicalCalls++;
			retryRequested = false;
			if (route.requestCapMicros !== requestBudget) {
				await failOperation(lease, "AI_REQUEST_COST_LIMIT");
				return;
			}
			preparingInput = true;
			const inputSignal = shutdown ? AbortSignal.any([signal, shutdown]) : signal;
			const buildPayload = handler.buildPayload;
			const payload = buildPayload
				? await prepareInput(inputSignal, () => buildPayload(lease.ownerId, request, inputSignal))
				: buildModelPayload(
						await prepareInput(inputSignal, () => handler.buildInput(lease.ownerId, request, inputSignal)),
					);
			preparingInput = false;
			if (shutdown?.aborted) return;
			if (Date.now() >= operation.deadlineAt.getTime()) {
				await failOperation(lease, "AI_DEADLINE");
				return;
			}
			// Preparing input can await storage while consent is revoked in another request.
			await resolveApprovedRoute(lease.ownerId, request);
			const stepId = nextStep;
			if (stepId === "verify") {
				if (!handler.verifier || !generated || writerOrdinal === undefined) throw new Error("AI_VERIFIER_UNAVAILABLE");
				const verifier = handler.verifier;
				const draft = generated;
				const batchPlan = await withOperationLease(lease, (tx) =>
					planOperationVerification(tx, lease.ownerId, request, handler, draft, contentRetried, payload),
				);
				const binding = bindVerificationPass(writerOrdinal, draft, batchPlan.batches);
				const existingPass = resumable;
				resumable = undefined;
				const passAttempt =
					existingPass ??
					(await withOperationLease(lease, async (tx, current) => {
						if (current.state === "cancel_requested") throw new Error("AI_CANCELLED");
						await assertSourceRevisions(tx, lease.ownerId, request);
						const [row] = await tx
							.insert(aiOperationAttempt)
							.values({
								userId: lease.ownerId,
								operationId: lease.operationId,
								ordinal,
								stepId: "verify",
								leaseToken: lease.token,
								outcome: "unknown",
								output: createVerificationJournal(binding, []),
							})
							.returning();
						if (!row) throw new Error("AI_ATTEMPT_UNAVAILABLE");
						return row;
					}));
				const oldJournal = readVerificationJournal(passAttempt.output);
				if (!oldJournal || !passAttempt.output) throw new Error("AI_VERIFICATION_REQUIRED");
				const passCalls: BoundVerificationCall[] = [...oldJournal.calls];
				const beforePassMicros =
					consumedMicros - (existingPass ? verificationPassIncurred(existingPass.output, route.maxCallCostMicros) : 0);
				const incurredMicros = () =>
					beforePassMicros + passCalls.reduce((sum, call) => sum + (call.costMicros ?? call.boundMicros), 0);
				const persistPass = (finished = false, dispatch = false) => {
					const persist: Parameters<typeof withOperationLease<typeof passAttempt>>[1] = async (tx, current) => {
						if (dispatch) {
							if (current.state === "cancel_requested") throw new Error("AI_CANCELLED");
							if (shutdown?.aborted) throw shutdown.reason;
							if (current.deadlineAt.getTime() <= Date.now()) throw new Error("AI_DEADLINE");
							await resolveApprovedRoute(lease.ownerId, request);
							await assertSourceRevisions(tx, lease.ownerId, request);
						}
						const tokenSum = (key: "inputTokens" | "outputTokens" | "cachedTokens") =>
							passCalls.some((call) => call[key] !== null)
								? passCalls.reduce((sum, call) => sum + (call[key] ?? 0), 0)
								: null;
						const [updated] = await tx
							.update(aiOperationAttempt)
							.set({
								outcome: finished ? "valid" : "unknown",
								output: createVerificationJournal(binding, passCalls),
								costMicros:
									finished && passCalls.every((call) => call.costMicros !== null)
										? incurredMicros() - beforePassMicros
										: null,
								inputTokens: tokenSum("inputTokens"),
								outputTokens: tokenSum("outputTokens"),
								cachedTokens: tokenSum("cachedTokens"),
								finishedAt: finished ? new Date() : null,
							})
							.where(
								and(
									eq(aiOperationAttempt.userId, lease.ownerId),
									eq(aiOperationAttempt.operationId, lease.operationId),
									eq(aiOperationAttempt.id, passAttempt.id),
									isNull(aiOperationAttempt.finishedAt),
								),
							)
							.returning();
						if (!updated) throw new Error("AI_ATTEMPT_UNAVAILABLE");
						if (!dispatch && sharesTranslationBudget && incurredMicros() < current.reservedMicros)
							await holdTranslationBudget(tx, incurredMicros());
						return updated;
					};
					return dispatch ? withDispatchBudget(incurredMicros(), persist) : withOperationLease(lease, persist);
				};
				const recovered = recoverVerificationPass(passAttempt.output, binding);
				if (
					recovered.unknownBatchKeys.some((key) => oldJournal.latest.get(key)?.failure?.abortCause !== "call_timeout")
				) {
					await failOperation(lease, "AI_OUTCOME_UNKNOWN");
					return;
				}
				const planned = await Promise.all(
					batchPlan.batches.map(async (batch, batchIndex) => {
						const batchKey = binding.batchKeys[batchIndex];
						if (!batchKey) throw new Error("AI_VERIFICATION_REQUIRED");
						const input = {
							payload: batch.payload,
							outputSchema: verifier.outputForPayload?.(batch.payload) ?? verifier.output,
							systemPrompt: verifier.systemPrompt,
						};
						return { input, batchIndex, batchKey, boundMicros: await verificationCallBound(route, input) };
					}),
				);
				const verifyConcurrency = request.kind === "review.translation" ? 8 : 5;
				let singleBatchValidation: { error?: unknown } | undefined;
				type Dispatch = (typeof planned)[number] & { dispatchIndex: 0 | 1 | 2 };
				const backup = verifierRoutes?.backup;
				const isWithheldTruncation = (call: BoundVerificationCall) =>
					verifier.withholdTruncatedBatch && isVerificationTruncation(call);
				const recoveryFor = (call: BoundVerificationCall, boundMicros: number, spent: number) => {
					const nowMs = Date.now();
					const deadlineAtMs = operation.deadlineAt.getTime();
					if (
						transientRetryLimit > 0 &&
						call.dispatchIndex === 0 &&
						call.outcome === "unknown" &&
						call.failure?.abortCause === "call_timeout" &&
						hasTimeForTimeoutRetry("verify") &&
						spent + boundMicros <= requestBudget
					)
						return "timeout";
					if (
						call.dispatchIndex === 0 &&
						(call.outcome === "transient" || call.outcome === "unknown") &&
						call.failure &&
						!call.output?._verificationFailureRule &&
						canFailOverVerifier(
							call.failure,
							{ deadlineMs: deadlineAtMs - nowMs, budgetMicros: requestBudget - spent },
							backup,
						)
					)
						return "backup";
					if (
						call.dispatchIndex === 0 &&
						call.outcome === "transient" &&
						!call.failure?.timedOut &&
						!call.failure?.abortCause &&
						((call.costMicros !== null &&
							passCalls.filter((entry) => entry.dispatchIndex === 1).length < transientRetryLimit) ||
							(transientRetryLimit > 0 && typeof call.output?._verificationFailureRule === "string"))
					)
						return "primary";
					if (
						call.dispatchIndex < 2 &&
						call.endpointSlot === "primary" &&
						canRetryPreResponseTransient({
							outcome: call,
							stepId,
							alreadyRetried: preResponseRetried,
							nowMs,
							deadlineAtMs,
							consumedMicros: spent,
							maxCallCostMicros: boundMicros,
							reservedMicros: requestBudget,
						})
					)
						return "pre-response";
					return null;
				};
				let terminalBatchKey: string | undefined;
				const dispatchWave = async (
					wave: Dispatch[],
					dispatchRoute = route,
					endpointSlot: BoundVerificationCall["endpointSlot"] = "primary",
					timeoutRetry = false,
				) => {
					const start = passCalls.length;
					passCalls.push(
						...wave.map(({ batchKey, dispatchIndex, boundMicros }) =>
							makeVerificationCall(
								batchKey,
								dispatchIndex,
								endpointSlot === "primary" ? boundMicros : dispatchRoute.maxCallCostMicros,
								endpointSlot,
							),
						),
					);
					try {
						await persistPass(false, true);
					} catch (error) {
						passCalls.length = start;
						throw error;
					}
					const controller = new AbortController();
					const waveSignal = AbortSignal.any([inputSignal, controller.signal]);
					const results = await Promise.allSettled(
						wave.map(async ({ input, batchIndex }, offset) => {
							const call = passCalls[start + offset];
							if (!call) throw new Error("AI_ATTEMPT_UNAVAILABLE");
							const allowMissingDecisions =
								call.dispatchIndex === 1 && call.endpointSlot === "primary" && !timeoutRetry;
							const outputSchema = allowMissingDecisions
								? (verifier.outputForPayload?.(input.payload, { allowMissingDecisions }) ?? input.outputSchema)
								: input.outputSchema;
							let received = await executeApprovedStep(
								{
									route: dispatchRoute,
									operationId: lease.operationId,
									attemptId: passAttempt.id,
									stepId: "verify",
									...input,
									outputSchema,
									verificationBoundMicros: call.boundMicros,
									signal: waveSignal,
									withDispatch,
								},
								{
									retry: false,
									concurrencyLimit: verifyConcurrency,
									...(translationRootId ? { operationGroupId: translationRootId } : {}),
								},
							);
							try {
								const validateBatch = verifier.validateBatchInContext;
								let rule =
									received.outcome === "invalid" && received.failure?.code !== "AI_VERIFIER_IDENTITY_MISMATCH"
										? "AI_VERIFICATION_SCHEMA"
										: undefined;
								if (received.outcome === "valid" && received.output) {
									try {
										const output = received.output;
										if (validateBatch)
											await withOperationLease(lease, (tx) =>
												validateBatch(tx, lease.ownerId, request, draft, batchIndex, output, {
													allowSegmentWithholding: contentRetried,
													allowMissingDecisions,
												}),
											);
										else if (!verifier.validateBatchesInContext) {
											await withOperationLease(lease, (tx) =>
												applyVerificationPass(tx, lease.ownerId, request, verifier, draft, [output], contentRetried),
											);
											singleBatchValidation = {};
										}
									} catch (error) {
										rule = incompleteVerificationRule(error);
										if (!rule && !(error instanceof VerificationGateError) && !isContentRejection(error)) throw error;
										if (!rule && !verifier.validateBatchesInContext) singleBatchValidation = { error };
									}
								}
								if (rule)
									received = {
										...received,
										outcome: "transient",
										output: { ...received.output, _verificationFailureRule: rule },
									};
								const completed = { ...call, ...received };
								passCalls[start + offset] = completed;
								// Pending siblings can still settle below their reserved maximum.
								const minimumSpend =
									beforePassMicros +
									passCalls.reduce(
										(sum, item) => sum + (item.costMicros ?? (item.outcome === "pending" ? 0 : item.boundMicros)),
										0,
									);
								if (
									!waveSignal.aborted &&
									completed.outcome !== "valid" &&
									!isWithheldTruncation(completed) &&
									!(completed.dispatchIndex === 0 && transientRetryLimit && isVerificationTruncation(completed)) &&
									!recoveryFor(completed, wave[offset]?.boundMicros ?? call.boundMicros, minimumSpend)
								) {
									terminalBatchKey = completed.batchKey;
									controller.abort();
								}
								await persistPass();
							} catch (error) {
								if (
									received.costMicros !== null &&
									error instanceof ORPCError &&
									((error.code === "CONFLICT" &&
										(error.data as { reason?: string } | undefined)?.reason === "AI_LEASE_LOST") ||
										error.message === "ACCOUNT_DELETION_PENDING")
								)
									await recordLateVerificationCost(lease, passAttempt.id, call, received.costMicros);
								throw error;
							}
						}),
					);
					for (const result of results) if (result.status === "rejected") throw result.reason;
				};
				try {
					while (true) {
						if (shutdown?.aborted) return;
						const latest = new Map(passCalls.map((call) => [call.batchKey, call]));
						const spent = incurredMicros();
						if (spent > requestBudget || passCalls.some((call) => (call.costMicros ?? 0) > call.boundMicros)) {
							await failOperation(lease, "AI_REQUEST_COST_LIMIT");
							return;
						}
						const failures = planned.flatMap((batch) => {
							const call = latest.get(batch.batchKey);
							return call && call.outcome !== "valid" && !isWithheldTruncation(call)
								? [{ batch, call, recovery: recoveryFor(call, batch.boundMicros, spent) }]
								: [];
						});
						const terminal =
							failures.find(({ call }) => call.batchKey === terminalBatchKey) ??
							failures.find(
								({ call, recovery }) =>
									!recovery && !(call.dispatchIndex === 0 && transientRetryLimit && isVerificationTruncation(call)),
							);
						const timedOut = failures.find(({ recovery }) => recovery === "timeout");
						if (!terminal && timedOut) {
							await dispatchWave([{ ...timedOut.batch, dispatchIndex: 1 }], route, "primary", true);
							continue;
						}
						if (!terminal && transientRetryLimit) {
							const truncated = planned
								.filter(({ batchKey }) => {
									const call = latest.get(batchKey);
									return call?.dispatchIndex === 0 && isVerificationTruncation(call);
								})
								.sort((a, b) => a.boundMicros - b.boundMicros);
							const retryCount = fitVerificationWave(
								requestBudget,
								spent,
								truncated.map(({ boundMicros }) => boundMicros),
								5,
							);
							if (retryCount) {
								await backoff();
								await dispatchWave(truncated.slice(0, retryCount).map((batch) => ({ ...batch, dispatchIndex: 1 })));
								continue;
							}
						}
						const failed = terminal ?? failures[0];
						if (failed) {
							const { batch, call, recovery } = failed;
							if (recovery === "backup" && backup) {
								await dispatchWave([{ ...batch, dispatchIndex: 1 }], backup, "backup");
								continue;
							}
							if (recovery === "primary") {
								if (fitVerificationWave(requestBudget, spent, [batch.boundMicros], 1) !== 1) {
									await failOperation(lease, "AI_REQUEST_COST_LIMIT");
									return;
								}
								await backoff();
								await dispatchWave([{ ...batch, dispatchIndex: 1 }]);
								continue;
							}
							if (recovery === "pre-response") {
								preResponseRetried = true;
								await delay(computePreResponseRetryDelayMs(Date.now(), operation.deadlineAt.getTime()), undefined, {
									signal,
								});
								await dispatchWave([{ ...batch, dispatchIndex: 2 }]);
								continue;
							}
							const rule = call.output?._verificationFailureRule;
							if (call.outcome === "ACCOUNT_ERROR") {
								const detail = providerAccountFailureDetail(call.failure);
								await failOperation(lease, "AI_PROVIDER_UNAVAILABLE", detail);
								console.error("[ai-operation]", {
									event: "provider_account_error",
									kind: operation.kind,
									operationId: lease.operationId,
									stepId,
									attempt: ordinal,
									...detail,
								});
							} else if (call.failure?.abortCause === "operation_deadline") {
								await failOperation(lease, "AI_DEADLINE", transportFailureDetail(call.failure));
							} else if (call.failure?.timedOut) await failOperation(lease, "AI_TIMEOUT");
							else if (typeof rule === "string") await failOperation(lease, "AI_VERIFICATION_INCOMPLETE", { rule });
							else {
								const unknown = call.outcome === "unknown";
								const detail = transportFailureDetail(call.failure);
								await failOperation(lease, unknown ? "AI_OUTCOME_UNKNOWN" : "AI_VERIFIER_UNAVAILABLE", detail);
								console.info("[ai-operation]", {
									event: unknown ? "outcome_unknown" : "verifier_unavailable",
									kind: operation.kind,
									operationId: lease.operationId,
									stepId,
									attempt: ordinal,
									...(detail ? { failure: detail } : {}),
								});
							}
							return;
						}
						const unsent = planned.filter(({ batchKey }) => !latest.has(batchKey));
						if (!unsent.length) break;
						const fit = fitVerificationWave(
							requestBudget,
							spent,
							unsent.map(({ boundMicros }) => boundMicros),
							5,
						);
						if (!fit) {
							await failOperation(lease, "AI_REQUEST_COST_LIMIT");
							return;
						}
						await dispatchWave(unsent.slice(0, fit).map((batch) => ({ ...batch, dispatchIndex: 0 })));
					}
				} catch (error) {
					if (shutdown?.aborted) return;
					throw error;
				}
				const finishedPass = await persistPass(true);
				consumedMicros = incurredMicros();
				try {
					if (singleBatchValidation?.error) throw singleBatchValidation.error;
					if (!singleBatchValidation)
						await withOperationLease(lease, (tx) =>
							applyVerificationPass(
								tx,
								lease.ownerId,
								request,
								verifier,
								draft,
								verificationPassVerdicts(
									createVerificationJournal(binding, passCalls),
									binding,
									verifier.withholdTruncatedBatch,
								),
								contentRetried,
							),
						);
				} catch (error) {
					await rejectVerification(error, finishedPass);
					if (retryRequested) continue;
					return;
				}
				await deliverContent(draft);
				return;
			}
			if (stepId === "repair") {
				if (repairs >= route.maxRepairs) break;
				repairs++;
			}
			const callBoundMicros = sharesTranslationBudget
				? await translationWriterCallBound(route, {
						payload,
						outputSchema: handler.output,
						...(writerPrompt ? { systemPrompt: writerPrompt } : {}),
					})
				: route.maxCallCostMicros;
			if (consumedMicros + callBoundMicros > requestBudget) {
				await failOperation(lease, "AI_REQUEST_COST_LIMIT");
				return;
			}
			const attempt = await withDispatchBudget(consumedMicros + callBoundMicros, async (tx, current) => {
				if (current.state === "cancel_requested") throw new Error("AI_CANCELLED");
				if (Date.now() >= current.deadlineAt.getTime()) throw new Error("AI_DEADLINE");
				await assertSourceRevisions(tx, lease.ownerId, request);
				const [row] = await tx
					.insert(aiOperationAttempt)
					.values({ userId: lease.ownerId, operationId: lease.operationId, ordinal, stepId, leaseToken: lease.token })
					.returning();
				if (!row) throw new Error("AI_ATTEMPT_UNAVAILABLE");
				return row;
			});
			const outcome = await executeApprovedStep(
				{
					route,
					operationId: lease.operationId,
					attemptId: attempt.id,
					stepId,
					payload,
					outputSchema: handler.output,
					...(writerPrompt ? { systemPrompt: writerPrompt } : {}),
					...(sharesTranslationBudget ? { verificationBoundMicros: callBoundMicros } : {}),
					signal,
					withDispatch,
				},
				{
					retry: false,
					...(request.kind === "review.translation" ? { concurrencyLimit: MAX_TRANSLATION_CONCURRENT_PARTS } : {}),
					...(translationRootId ? { operationGroupId: translationRootId } : {}),
				},
			);
			const writerCallTimedOut =
				stepId !== "repair" && outcome.outcome === "unknown" && outcome.failure?.abortCause === "call_timeout";
			const retryWriterTimeout =
				writerCallTimedOut &&
				!writerTimedOut &&
				transientRetryLimit > 0 &&
				hasTimeForTimeoutRetry("writer") &&
				logicalCalls + (handler.verifier ? 1 : 0) < callLimit &&
				ordinal + (handler.verifier ? 1 : 0) < maxAttempts &&
				consumedMicros + (outcome.costMicros ?? callBoundMicros) + callBoundMicros <= requestBudget;
			// Late accounting may finish after cancellation/lease loss, but may never publish a result.
			await withOwnerDatabase(lease.ownerId, async (tx) => {
				const account = await lockAccountForAccounting(tx, lease.ownerId);
				if (!account) return;
				await tx
					.update(aiOperationAttempt)
					.set(
						account.deleting
							? {
									outcome: outcome.outcome,
									output: null,
									costMicros: outcome.costMicros,
									inputTokens: outcome.inputTokens,
									outputTokens: outcome.outputTokens,
									cachedTokens: outcome.cachedTokens,
									finishedAt: new Date(),
								}
							: {
									...outcome,
									output: writerCallTimedOut
										? { _writerCallTimedOut: true, _writerTimeoutRetryPending: retryWriterTimeout }
										: outcome.output,
									finishedAt: new Date(),
								},
					)
					.where(and(eq(aiOperationAttempt.id, attempt.id), eq(aiOperationAttempt.leaseToken, lease.token)));
				const [current] = await tx
					.select()
					.from(aiOperation)
					.where(eq(aiOperation.id, lease.operationId))
					.for("update");
				if (
					sharesTranslationBudget &&
					current?.state === "running" &&
					outcome.costMicros !== null &&
					consumedMicros + outcome.costMicros < current.reservedMicros
				)
					await holdTranslationBudget(tx, consumedMicros + outcome.costMicros);
				if (current?.budgetClosed && current.actualMicros === null) {
					await tx.execute(sql`SELECT master_cv_ai_reconcile_budget(${lease.operationId})`);
				}
			});
			consumedMicros += outcome.costMicros ?? callBoundMicros;
			if ((outcome.costMicros !== null && outcome.costMicros > callBoundMicros) || consumedMicros > requestBudget) {
				await failOperation(lease, "AI_REQUEST_COST_LIMIT");
				return;
			}
			if (outcome.outcome === "valid" && outcome.output) {
				if (!(await validateGenerated(outcome.output))) {
					if (retryRequested) continue;
					return;
				}
				if (handler.verifier) {
					generated = outcome.output;
					writerOrdinal = ordinal;
					nextStep = "verify";
					continue;
				}
				await deliverContent(outcome.output);
				return;
			}
			if (outcome.outcome === "ACCOUNT_ERROR") {
				const detail = providerAccountFailureDetail(outcome.failure);
				await failOperation(lease, "AI_PROVIDER_UNAVAILABLE", detail);
				console.error("[ai-operation]", {
					event: "provider_account_error",
					kind: operation.kind,
					operationId: lease.operationId,
					stepId,
					attempt: ordinal,
					...detail,
				});
				return;
			}
			if (
				transientRetryLimit &&
				outcome.outcome === "transient" &&
				outcome.costMicros !== null &&
				!outcome.failure?.timedOut &&
				stepId !== "repair"
			) {
				const key = retryStep(stepId);
				const count = (transientFailures.get(key) ?? 0) + 1;
				transientFailures.set(key, count);
				if (count <= transientRetryLimit) {
					await backoff();
					continue;
				}
				await failOperation(lease, "AI_TRANSIENT");
				return;
			}
			if (outcome.failure?.timedOut) {
				if (retryWriterTimeout) {
					writerTimedOut = true;
					continue;
				}
				await failOperation(lease, "AI_TIMEOUT");
				return;
			}
			if (
				canRetryPreResponseTransient({
					outcome,
					stepId,
					alreadyRetried: preResponseRetried,
					nowMs: Date.now(),
					deadlineAtMs: operation.deadlineAt.getTime(),
					consumedMicros,
					maxCallCostMicros: callBoundMicros,
					reservedMicros: requestBudget,
				})
			) {
				preResponseRetried = true;
				const retryDelayMs = computePreResponseRetryDelayMs(Date.now(), operation.deadlineAt.getTime());
				if (retryDelayMs > 0) await delay(retryDelayMs, undefined, { signal });
				continue;
			}
			// A dispatched request may have completed and billed even when its response was lost.
			if (outcome.outcome === "unknown" || (outcome.outcome === "transient" && outcome.costMicros === null)) {
				const detail = transportFailureDetail(outcome.failure);
				await failOperation(lease, "AI_OUTCOME_UNKNOWN", detail);
				console.info("[ai-operation]", {
					event: "outcome_unknown",
					kind: operation.kind,
					operationId: lease.operationId,
					stepId,
					attempt: ordinal,
					...(detail ? { failure: detail } : {}),
				});
				return;
			}
			if (outcome.outcome === "invalid" && repairs < route.maxRepairs) {
				// The final call is reserved for verification; no repair may consume it.
				if (
					handler.verifier &&
					logicalCalls + 1 >=
						route.maxCalls + (contentRetried ? 2 : 0) + transientCallAllowance() + preResponseCallAllowance()
				) {
					await failOperation(lease, "AI_CALL_LIMIT");
					return;
				}
				nextStep = "repair";
				continue;
			}
			await failOperation(lease, `AI_${outcome.outcome.toUpperCase()}`);
			return;
		}
		await failOperation(lease, "AI_CALL_LIMIT");
	} catch (error) {
		// Shutdown interrupts preparation before egress; the expired lease can safely be reclaimed.
		if (preparingInput && shutdown?.aborted && deadlineAt !== undefined && Date.now() < deadlineAt) return;
		// Public/diagnostic outcomes are bounded codes; never attach SDK exceptions or content.
		await failOperation(
			lease,
			error instanceof Error && error.message === "AI_REQUEST_COST_LIMIT"
				? error.message
				: deadlineAt !== undefined && Date.now() >= deadlineAt
					? "AI_DEADLINE"
					: "AI_EXECUTION_FAILED",
			verificationFailureDetail(error),
		).catch(() => {
			/* A recovered/cancelled worker owns the final state. */
		});
	} finally {
		stopObservingCancellation?.();
		clearInterval(timer);
		await heartbeat;
	}
}

export async function runAiOperations(signal?: AbortSignal, concurrency = 100): Promise<void> {
	if (!Number.isSafeInteger(concurrency) || concurrency < 1) throw new Error("AI_INVALID_CONCURRENCY");
	const running = new Set<Promise<void>>();
	const failures: unknown[] = [];
	try {
		while (!signal?.aborted) {
			const runningAtStart = running.size;
			let claimed = false;
			for (const ownerId of await discoverAiOwners()) {
				if (signal?.aborted || running.size >= concurrency) break;
				try {
					await reconcileExpiredAccounting(ownerId);
					const capacity = concurrency - running.size;
					for (let slot = 0; slot < capacity && !signal?.aborted; slot++) {
						const lease = await claimNextOperation(ownerId);
						if (!lease) break;
						claimed = true;
						const task = executeLease(lease, signal)
							.catch((error: unknown) => {
								failures.push(error);
							})
							.finally(() => {
								running.delete(task);
							});
						running.add(task);
					}
				} catch (error) {
					failures.push(error);
				}
			}
			if ((claimed || running.size < runningAtStart) && running.size < concurrency) continue;
			if (!running.size) break;
			// Refill finished slots immediately and discover new owners during slow provider calls.
			let refresh: ReturnType<typeof setTimeout> | undefined;
			try {
				await Promise.race([
					...running,
					new Promise<void>((resolve) => {
						refresh = setTimeout(resolve, 1000);
					}),
				]);
			} finally {
				clearTimeout(refresh);
			}
		}
	} catch (error) {
		failures.push(error);
	} finally {
		// A failed discovery or claim must not finish shutdown while other leases still run.
		await Promise.allSettled(running);
	}
	if (failures.length) throw new AggregateError(failures, "AI operation dispatch failed");
}
