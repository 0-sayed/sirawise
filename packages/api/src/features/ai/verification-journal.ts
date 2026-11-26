import type { executeApprovedStep } from "./adapter";
import type { OwnerTransaction } from "@reactive-resume/db/owner-scope";
import type { OperationRequest } from "@reactive-resume/schema/ai-operation";
import { createHash } from "node:crypto";
import { z } from "zod";
import { dispatchFailureCodes } from "./adapter";
import { buildModelPayload, type ModelPayload } from "./payload";
import { canonicalJson, type OperationHandler } from "./route-policy";
import { VerificationGateError } from "./verification-failure";
import { isBackupVerifierFailure } from "./verifier-policy";

type Outcome = Awaited<ReturnType<typeof executeApprovedStep>>;
type VerificationCall = Omit<Outcome, "outcome"> & {
	batchIndex: number;
	outcome: Outcome["outcome"] | "pending";
};

const hashSchema = z.string().regex(/^[a-f0-9]{64}$/u);
const bindingSchema = z.strictObject({
	generationOrdinal: z.int().min(1).max(7),
	candidateSha256: hashSchema,
	batchPlanSha256: hashSchema,
	batchKeys: z.array(hashSchema),
});
export type VerificationPassBinding = Readonly<Omit<z.infer<typeof bindingSchema>, "batchKeys">> & {
	readonly batchKeys: readonly string[];
};
type DispatchIndex = 0 | 1 | 2;
export type BoundVerificationCall = Omit<VerificationCall, "batchIndex"> & {
	batchKey: string;
	endpointSlot: "primary" | "backup";
	dispatchIndex: DispatchIndex;
	boundMicros: number;
};
const callIdentity = z.object({
	batchKey: hashSchema,
	endpointSlot: z.enum(["primary", "backup"]),
	dispatchIndex: z.union([z.literal(0), z.literal(1), z.literal(2)]),
	boundMicros: z.int().positive(),
	costMicros: z.int().nonnegative().nullable(),
	outcome: z.enum([
		"pending",
		"valid",
		"invalid",
		"transient",
		"unknown",
		"refusal",
		"truncated",
		"unsupported",
		"ACCOUNT_ERROR",
		"PAYER_MISMATCH",
		"REQUEST_SCHEMA_ERROR",
	]),
	output: z.record(z.string(), z.unknown()).nullable(),
	responseId: z.string().nullable(),
	observedModel: z.string().nullable().optional(),
	observedProvider: z.string().nullable().optional(),
	inputTokens: z.int().nonnegative().nullable(),
	outputTokens: z.int().nonnegative().nullable(),
	cachedTokens: z.int().nonnegative().nullable(),
	failure: z
		.object({
			dispatchFailureCode: z.enum(dispatchFailureCodes).optional(),
			timedOut: z.boolean().optional(),
			abortCause: z.enum(["call_timeout", "operation_deadline", "cancelled"]).optional(),
			providerErrorCode: z.string().optional(),
			causes: z
				.array(z.object({ errorClass: z.string(), message: z.string(), code: z.string().optional() }))
				.optional(),
			errorClass: z.string(),
			code: z.string().optional(),
			httpStatus: z.int().nullable(),
			message: z.string(),
			bytesReceived: z.boolean(),
			generationId: z.string().nullable(),
			requestSent: z.boolean().optional(),
		})
		.optional(),
});
const journalSchema = z.object({
	_verifyJournalVersion: z.literal(1),
	_verifyBinding: bindingSchema,
	_verifyCalls: z.array(callIdentity),
});
const digest = (value: unknown) => createHash("sha256").update(canonicalJson(value)).digest("hex");

export function bindVerificationPass(
	writerOrdinal: number,
	output: Record<string, unknown>,
	batches: readonly { itemIds: string[]; payload: ModelPayload }[],
): VerificationPassBinding {
	const batchKeys = batches.map(({ itemIds, payload }, index) =>
		digest({ index, itemIds, payloadSha256: digest(payload) }),
	);
	return {
		generationOrdinal: writerOrdinal,
		candidateSha256: digest(output),
		batchPlanSha256: digest(batchKeys),
		batchKeys,
	};
}

export function makeVerificationCall(
	batchKey: string,
	dispatchIndex: DispatchIndex,
	boundMicros: number,
	endpointSlot: BoundVerificationCall["endpointSlot"] = "primary",
): BoundVerificationCall {
	return {
		batchKey,
		endpointSlot,
		dispatchIndex,
		boundMicros,
		outcome: "pending",
		output: null,
		responseId: null,
		costMicros: null,
		inputTokens: null,
		outputTokens: null,
		cachedTokens: null,
	};
}

export function createVerificationJournal(binding: VerificationPassBinding, calls: readonly BoundVerificationCall[]) {
	return { _verifyJournalVersion: 1, _verifyBinding: binding, _verifyCalls: calls };
}

export const truncatedVerificationBatch = Object.freeze({});

export function isVerificationTruncation(call: BoundVerificationCall): boolean {
	return call.outcome === "truncated" && call.output === null;
}

export function readVerificationJournal(raw: Record<string, unknown> | null) {
	const parsed = journalSchema.safeParse(raw);
	if (!parsed.success) return null;
	const { _verifyBinding: binding } = parsed.data;
	const calls = parsed.data._verifyCalls as BoundVerificationCall[];
	const keys = new Set(binding.batchKeys);
	if (keys.size !== binding.batchKeys.length || digest(binding.batchKeys) !== binding.batchPlanSha256) return null;
	const latest = new Map<string, BoundVerificationCall>();
	let usedPreResponseSlot = false;
	for (const call of calls) {
		const prior = latest.get(call.batchKey);
		const canRetryPrimary =
			prior &&
			(isVerificationTruncation(prior) ||
				(prior.outcome === "unknown" && prior.failure?.abortCause === "call_timeout") ||
				(prior.outcome === "transient" &&
					(prior.costMicros !== null || typeof prior.output?._verificationFailureRule === "string")));
		const canUseBackup =
			prior?.failure &&
			(prior.outcome === "transient" || prior.outcome === "unknown") &&
			!prior.output?._verificationFailureRule &&
			isBackupVerifierFailure(prior.failure);
		if (
			!keys.has(call.batchKey) ||
			(call.dispatchIndex === 0 && (prior || call.endpointSlot !== "primary")) ||
			(call.dispatchIndex === 1 &&
				(prior?.dispatchIndex !== 0 || (call.endpointSlot === "backup" ? !canUseBackup : !canRetryPrimary))) ||
			(call.dispatchIndex === 2 &&
				(usedPreResponseSlot ||
					prior?.dispatchIndex === 2 ||
					prior?.endpointSlot === "backup" ||
					prior?.outcome !== "transient" ||
					prior.costMicros !== null ||
					call.endpointSlot !== prior.endpointSlot)) ||
			(call.outcome === "pending" && call.output !== null) ||
			(call.outcome === "valid" && !call.output)
		)
			return null;
		usedPreResponseSlot ||= call.dispatchIndex === 2;
		latest.set(call.batchKey, call);
	}
	return { binding, calls, latest };
}

export function recoverVerificationPass(raw: Record<string, unknown>, expected: VerificationPassBinding) {
	const journal = readVerificationJournal(raw);
	if (!journal || canonicalJson(journal.binding) !== canonicalJson(expected))
		throw new Error("AI_VERIFICATION_REQUIRED");
	const remainingBatchKeys: string[] = [];
	const unknownBatchKeys: string[] = [];
	const verdictsByBatchKey = new Map<string, Record<string, unknown>>();
	for (const key of expected.batchKeys) {
		const call = journal.latest.get(key);
		if (!call) remainingBatchKeys.push(key);
		else if (call.outcome === "pending" || call.outcome === "unknown") unknownBatchKeys.push(key);
		else if (call.outcome === "valid" && call.output) verdictsByBatchKey.set(key, call.output);
	}
	return {
		remainingBatchKeys,
		verdictsByBatchKey,
		unknownBatchKeys,
		unknownMicros: journal.calls.reduce((sum, call) => sum + (call.costMicros === null ? call.boundMicros : 0), 0),
	};
}

export async function planOperationVerification(
	tx: OwnerTransaction,
	ownerId: string,
	request: OperationRequest,
	handler: OperationHandler,
	output: Record<string, unknown>,
	allowSegmentWithholding: boolean,
	writerPayload?: ModelPayload,
) {
	const verifier = handler.verifier;
	if (!verifier) throw new Error("AI_VERIFICATION_REQUIRED");
	const options = { allowSegmentWithholding };
	if (verifier.buildBatchesInContext) return verifier.buildBatchesInContext(tx, ownerId, request, output, options);
	const payload = verifier.buildInputInContext
		? await verifier.buildInputInContext(tx, ownerId, request, output, options)
		: verifier.buildInput(
				writerPayload ??
					(await (handler.buildPayload
						? handler.buildPayload(ownerId, request)
						: handler.buildInput(ownerId, request).then(buildModelPayload))),
				output,
			);
	return { batches: [{ output, payload, itemIds: [] }] };
}

export async function applyVerificationPass(
	tx: OwnerTransaction,
	ownerId: string,
	request: OperationRequest,
	verifier: NonNullable<OperationHandler["verifier"]>,
	output: Record<string, unknown>,
	verdicts: Record<string, unknown>[],
	allowSegmentWithholding: boolean,
) {
	const options = { allowSegmentWithholding };
	if (verifier.validateBatchesInContext)
		return await verifier.validateBatchesInContext(tx, ownerId, request, output, verdicts, options);
	const [verdict] = verdicts;
	if (!verdict || verdicts.length !== 1) throw new Error("AI_VERIFICATION_REQUIRED");
	return verifier.validateInContext
		? verifier.validateInContext(tx, ownerId, request, output, verdict, options)
		: verifier.validate(output, verdict);
}

export function verificationPassIncurred(output: Record<string, unknown> | null, perCallLimit: number): number {
	if (output?._verifyJournalVersion === undefined) return verificationPassCostLimit(output, perCallLimit);
	const journal = readVerificationJournal(output);
	return journal ? journal.calls.reduce((sum, call) => sum + (call.costMicros ?? call.boundMicros), 0) : perCallLimit;
}

/** Each physical call remains accountable inside its logical verification attempt. */
export function verificationPassCostLimit(output: Record<string, unknown> | null, perCallLimit: number): number {
	if (output?._verifyJournalVersion !== undefined) {
		const journal = readVerificationJournal(output);
		if (!journal || journal.calls.some((call) => call.costMicros !== null && call.costMicros > call.boundMicros))
			return 0;
		return journal.calls.reduce((sum, call) => sum + call.boundMicros, 0);
	}
	const calls = output?._verifyCalls;
	if (!Array.isArray(calls) || calls.length === 0) return perCallLimit;
	for (const call of calls) {
		if (
			!call ||
			typeof call !== "object" ||
			(call.costMicros !== null &&
				(!Number.isSafeInteger(call.costMicros) || call.costMicros < 0 || call.costMicros > perCallLimit))
		)
			return 0;
	}
	return calls.length * perCallLimit;
}

/** Delivery requires the latest response for every batch in this generation. */
export function verificationPassVerdicts(
	output: Record<string, unknown>,
	expected?: VerificationPassBinding,
	withholdTruncatedBatch = false,
): Record<string, unknown>[] {
	if (output._verifyJournalVersion !== undefined) {
		if (!expected) throw new Error("AI_VERIFICATION_REQUIRED");
		const { verdictsByBatchKey } = recoverVerificationPass(output, expected);
		const latest = withholdTruncatedBatch ? readVerificationJournal(output)?.latest : undefined;
		const verdicts = expected.batchKeys.map((key) => {
			const verdict = verdictsByBatchKey.get(key);
			const call = latest?.get(key);
			if (!verdict && call && isVerificationTruncation(call)) return truncatedVerificationBatch;
			if (!verdict) throw new Error("AI_VERIFICATION_REQUIRED");
			return verdict;
		});
		if (latest && verdicts.length && !verdictsByBatchKey.size)
			throw new VerificationGateError("AI_VERIFICATION_CLAIM_SUPPORT");
		return verdicts;
	}
	const total = output._verifyBatchTotal;
	const calls = output._verifyCalls;
	if (!Number.isSafeInteger(total) || Number(total) < 1 || !Array.isArray(calls))
		throw new Error("AI_VERIFICATION_REQUIRED");
	const latest = new Map<number, VerificationCall>();
	for (const call of calls) {
		if (!call || !Number.isInteger(call.batchIndex) || call.batchIndex < 0 || call.batchIndex >= Number(total))
			throw new Error("AI_VERIFICATION_REQUIRED");
		latest.set(call.batchIndex, call);
	}
	return Array.from({ length: Number(total) }, (_, index) => {
		const call = latest.get(index);
		if (call?.outcome !== "valid" || !call.output) throw new Error("AI_VERIFICATION_REQUIRED");
		const {
			_verifyBatchIndex: _index,
			_verifyBatchTotal: _total,
			_verificationFailureRule: _rule,
			...verdict
		} = call.output;
		return verdict;
	});
}

export function legacySplitVerificationVerdicts(
	attempts: readonly {
		ordinal: number;
		finishedAt: Date | null;
		outcome: string | null;
		output: Record<string, unknown> | null;
	}[],
	writerOrdinal: number,
	total: number,
): Record<string, unknown>[] {
	if (!Number.isSafeInteger(total) || total < 1) throw new Error("AI_VERIFICATION_REQUIRED");
	const byIndex = new Map<number, Record<string, unknown>>();
	for (const attempt of attempts) {
		if (attempt.ordinal <= writerOrdinal || !attempt.finishedAt || attempt.outcome !== "valid" || !attempt.output)
			continue;
		const { _verifyBatchIndex: index, _verifyBatchTotal: batchTotal, ...verdict } = attempt.output;
		if (batchTotal === total && typeof index === "number" && Number.isInteger(index) && index >= 0 && index < total)
			byIndex.set(index, verdict);
	}
	if (byIndex.size !== total) throw new Error("AI_VERIFICATION_REQUIRED");
	return Array.from({ length: total }, (_, index) => {
		const verdict = byIndex.get(index);
		if (!verdict) throw new Error("AI_VERIFICATION_REQUIRED");
		return verdict;
	});
}
