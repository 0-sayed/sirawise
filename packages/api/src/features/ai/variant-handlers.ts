import type { OperationHandler } from "./route-policy";
import type { VariantSnapshot } from "./variant-types";
import type { VariantOperationKind } from "@reactive-resume/schema/resume/variants";
import { withOwnerDatabase } from "@reactive-resume/db/client";
import { translationCandidateSchema } from "@reactive-resume/schema/resume/variant-outputs";
import { classifyTranslationFacts } from "./translation-invariants";
import {
	adaptVerifiedTranslation,
	assertTranslationCheck,
	buildTranslationVerifierSchema,
	planCompactTranslationChecks,
	translationVerifierCheckSchema,
} from "./translation-verifier";
import {
	buildCompactTranslationWriter,
	buildVariantWriterPayload,
	variantOperationContracts,
	jobEvidenceCandidateContract,
	translationCandidateContract,
} from "./variant-contracts";
import { VerificationGateError } from "./verification-failure";
export { prepareTranslationFacts } from "./translation-invariants";
import { loadVariantSnapshot } from "./variant-sources";
import { validateAndFilterVariantOutput, validateCompactTranslationDelivery } from "./variant-validation";
import {
	buildVariantVerificationPayload,
	buildVariantVerifierSchema,
	filterVariantVerification,
	mergeBatchedVariantVerifications,
	planVariantVerificationBatches,
	variantVerifierPrompt,
	variantVerifierSchema,
	translationVerifierSchema,
	jobEvidenceVerifierSchema,
} from "./variant-verifier";

type WithheldItemSummary = {
	id: string;
	spanIds?: string[] | undefined;
	reason?: string | undefined;
	text?: string | undefined;
};
type WithheldSummary = {
	count: number;
	rules: string[];
	items?: WithheldItemSummary[] | undefined;
};

function mergeWithheldSummaries(a?: WithheldSummary, b?: WithheldSummary) {
	if (!a && !b) return undefined;
	const itemsById = new Map<string, WithheldItemSummary>();
	for (const item of [...(a?.items ?? []), ...(b?.items ?? [])]) {
		if (!itemsById.has(item.id)) {
			itemsById.set(item.id, item);
		}
	}
	const items = [...itemsById.values()];
	const count = items.length || (a?.count ?? 0) + (b?.count ?? 0);
	return {
		count,
		rules: [...new Set([...(a?.rules ?? []), ...(b?.rules ?? [])])],
		...(items.length ? { items } : {}),
	};
}

export function prepareJobEvidenceCandidate(
	snapshot: VariantSnapshot,
	output: Record<string, unknown>,
	limits: { maxInputCodePoints: number; maxOutputTokens: number },
) {
	const bound = { ...snapshot, jobEvidenceContract: limits };
	const filtered = validateAndFilterVariantOutput(bound, output);
	if (filtered.kind !== "review.job-evidence") throw new Error("AI_SOURCE_BINDING");
	const rejected = new Set(filtered.withheld?.items?.map((item) => item.id));
	const noteIds = Array.isArray(output.notes) ? output.notes.map((_, index) => `note:${index}`) : [];
	return {
		snapshot: { ...bound, jobNoteIds: noteIds.filter((id) => !rejected.has(id)) },
		output: filtered.output,
		guardWithheld: filtered.withheld,
	};
}

function makeHandler(
	kind: VariantOperationKind,
	jobEvidenceContract?: { maxInputCodePoints: number; maxOutputTokens: number },
): OperationHandler {
	const contract = { ...variantOperationContracts[kind], ...(jobEvidenceContract ? jobEvidenceCandidateContract : {}) };
	const loadSnapshot: typeof loadVariantSnapshot = async (tx, ownerId, request) => ({
		...(await loadVariantSnapshot(tx, ownerId, request)),
		...(jobEvidenceContract ? { jobEvidenceContract } : {}),
	});
	const prepareForVerification = (
		snapshot: Awaited<ReturnType<typeof loadVariantSnapshot>>,
		output: Record<string, unknown>,
		options?: { allowSegmentWithholding?: boolean },
	) => {
		if (kind === "review.job-evidence" && jobEvidenceContract) {
			return prepareJobEvidenceCandidate(snapshot, output, jobEvidenceContract);
		}
		if (kind !== "review.translation" || !options?.allowSegmentWithholding) {
			return { snapshot, output, guardWithheld: undefined };
		}
		const filtered = validateAndFilterVariantOutput(snapshot, output, options);
		if (filtered.kind !== "review.translation") return { snapshot, output, guardWithheld: undefined };
		return {
			snapshot,
			output: filtered.output as unknown as Record<string, unknown>,
			guardWithheld: filtered.withheld,
		};
	};
	return {
		...contract,
		resultState: "waiting_review",
		validateRequest: async (tx, ownerId, request) => {
			await loadVariantSnapshot(tx, ownerId, request);
		},
		buildInput: () => {
			throw new Error("AI_PREPARED_PAYLOAD_REQUIRED");
		},
		buildPayload: (ownerId, request) =>
			withOwnerDatabase(ownerId, async (tx) => {
				const snapshot = await loadVariantSnapshot(tx, ownerId, request);
				return buildVariantWriterPayload(snapshot);
			}),
		validateResult: async (tx, ownerId, request, output, options) =>
			validateAndFilterVariantOutput(await loadSnapshot(tx, ownerId, request), output, options),
		verifier: {
			output: jobEvidenceContract
				? jobEvidenceVerifierSchema
				: kind === "review.translation"
					? translationVerifierSchema
					: variantVerifierSchema,
			outputForPayload: buildVariantVerifierSchema,
			...(kind === "review.job-evidence" ? { withholdTruncatedBatch: true } : {}),
			systemPrompt: jobEvidenceContract ? jobEvidenceCandidateContract.verifierPrompt : variantVerifierPrompt,
			buildInput: () => {
				throw new Error("AI_VERIFICATION_CONTEXT_REQUIRED");
			},
			validate: () => {
				throw new Error("AI_VERIFICATION_CONTEXT_REQUIRED");
			},
			buildInputInContext: async (tx, ownerId, request, output, options) => {
				const snapshot = await loadSnapshot(tx, ownerId, request);
				const prepared = prepareForVerification(snapshot, output, options);
				return buildVariantVerificationPayload(prepared.snapshot, prepared.output);
			},
			validateInContext: async (tx, ownerId, request, output, verdict, options) => {
				const snapshot = await loadSnapshot(tx, ownerId, request);
				const prepared = prepareForVerification(snapshot, output, options);
				const filtered = filterVariantVerification(prepared.snapshot, prepared.output, verdict, options);
				const withheld = mergeWithheldSummaries(prepared.guardWithheld, filtered.withheld);
				return {
					output: filtered.output,
					...(withheld ? { withheld } : {}),
				};
			},
			...(kind === "review.job-evidence" || kind === "review.tailoring" || kind === "review.translation"
				? {
						buildBatchesInContext: async (tx, ownerId, request, output, options) => {
							const snapshot = await loadSnapshot(tx, ownerId, request);
							const prepared = prepareForVerification(snapshot, output, options);
							return planVariantVerificationBatches(prepared.snapshot, prepared.output);
						},
						validateBatchInContext: async (tx, ownerId, request, output, batchIndex, verdict, options) => {
							const snapshot = await loadSnapshot(tx, ownerId, request);
							const prepared = prepareForVerification(snapshot, output, options);
							const batch = planVariantVerificationBatches(prepared.snapshot, prepared.output).batches[batchIndex];
							if (!batch) throw new Error("AI_VERIFICATION_REQUIRED");
							filterVariantVerification(batch.snapshot, batch.output, verdict, {
								...options,
								...(kind === "review.job-evidence"
									? { allowEmptyJobBatch: true, allowMissingJobItems: options?.allowMissingDecisions === true }
									: {}),
							});
						},
						validateBatchesInContext: async (tx, ownerId, request, output, verdicts, options) => {
							const snapshot = await loadSnapshot(tx, ownerId, request);
							const prepared = prepareForVerification(snapshot, output, options);
							const plan = planVariantVerificationBatches(prepared.snapshot, prepared.output);
							if (verdicts.length !== plan.batches.length) throw new Error("AI_VERIFICATION_REQUIRED");
							const merged = mergeBatchedVariantVerifications(
								prepared.snapshot,
								prepared.output,
								plan.batches.map((batch, index) => ({
									snapshot: batch.snapshot,
									output: batch.output,
									verdict: verdicts[index],
								})),
								plan.oversizeWithheld,
								options,
							);
							const withheld = mergeWithheldSummaries(prepared.guardWithheld, merged.withheld);
							return {
								output: merged.output,
								...(withheld ? { withheld } : {}),
								batchCount: merged.batchCount,
							};
						},
					}
				: {}),
		},
	};
}

/** Server composition only. No approved routes are enabled by this registry. */
export const variantReviewHandlers = Object.fromEntries(
	Object.keys(variantOperationContracts).map((kind) => [kind, makeHandler(kind as VariantOperationKind)]),
) as Record<VariantOperationKind, OperationHandler>;

export const createJobEvidenceCandidateHandler = (limits: { maxInputCodePoints: number; maxOutputTokens: number }) =>
	makeHandler("review.job-evidence", limits);

export function prepareCompactTranslationVerification(snapshot: VariantSnapshot, raw: unknown, batchId: string) {
	const candidate = translationCandidateSchema.parse(raw);
	const prepared = snapshot.translationProtection;
	if (!prepared) throw new Error("AI_SOURCE_BINDING");
	const { keptIds, withheldIds } = classifyTranslationFacts(prepared, candidate);
	const kept = new Set(keptIds);
	const surviving = { ...candidate, segments: candidate.segments.filter(({ sourceId }) => kept.has(sourceId)) };
	// A saved plan keeps its original grouping and verifier journal across a restart.
	const batches = planCompactTranslationChecks(prepared, surviving, batchId, prepared.compactProseSizing ?? false).map(
		(batch) => ({ ...batch, schema: buildTranslationVerifierSchema(batch.payload) }),
	);
	const adapt = (check: ReturnType<typeof assertTranslationCheck>) => ({
		...adaptVerifiedTranslation(prepared, candidate, check, withheldIds),
		issues: check.issues,
	});
	const finishBatches = (verdicts: unknown[]) => {
		if (!batches.length || verdicts.length !== batches.length) throw new Error("AI_VERIFICATION_REQUIRED");
		const checks = batches.map((batch, index) =>
			assertTranslationCheck(batch.candidate, batch.batchId, batch.schema.parse(verdicts[index])),
		);
		return adapt({
			schemaVersion: 1,
			batchId,
			checkedSourceIds: checks.flatMap((entry) => entry.checkedSourceIds),
			supportedSourceIds: checks.flatMap((entry) => entry.supportedSourceIds),
			issues: checks.flatMap((entry) => entry.issues),
		});
	};
	return {
		keptIds,
		withheldIds,
		batches,
		payload: batches[0]?.payload ?? null,
		finish: (verdict: unknown) => adapt(assertTranslationCheck(surviving, batchId, verdict)),
		finishBatches,
	};
}

export function createTranslationCandidateHandler(): OperationHandler {
	const contract = { ...variantOperationContracts["review.translation"], ...translationCandidateContract };
	const loadSnapshot: typeof loadVariantSnapshot = (tx, ownerId, request) =>
		loadVariantSnapshot(tx, ownerId, request, { compactTranslation: true });
	const prepare = async (
		tx: Parameters<typeof loadSnapshot>[0],
		ownerId: string,
		request: Parameters<typeof loadSnapshot>[2],
		output: Record<string, unknown>,
	) => {
		const snapshot = await loadSnapshot(tx, ownerId, request);
		const batch = contract.parameters.parse(request.parameters).translationBatch;
		return prepareCompactTranslationVerification(snapshot, output, `part-${(batch?.index ?? 0) + 1}`);
	};
	const deliver = (
		adapted: ReturnType<Awaited<ReturnType<typeof prepare>>["finishBatches"]>,
		allowSegmentWithholding?: boolean,
	) => {
		if (
			adapted.withheldIds.length &&
			((!allowSegmentWithholding && adapted.withheldIds.length !== adapted.unverifiedIds.length) ||
				!adapted.output.segments.some(({ claims }) => claims.length))
		)
			throw new VerificationGateError(
				adapted.unverifiedIds.length ? "AI_VERIFICATION_CLAIM_IDS" : "AI_VERIFICATION_CLAIM_SUPPORT",
			);
		const unverified = new Set(adapted.unverifiedIds);
		const reasonFor = (id: string) =>
			unverified.has(id) ? "AI_VERIFICATION_CLAIM_IDS" : "AI_VERIFICATION_CLAIM_SUPPORT";
		return {
			output: { ...adapted.output, withheldSegmentIds: adapted.withheldIds },
			...(adapted.withheldIds.length
				? {
						withheld: {
							count: adapted.withheldIds.length,
							rules: [...new Set(adapted.withheldIds.map(reasonFor))],
							items: adapted.withheldIds.map((id) => ({ id, reason: reasonFor(id) })),
						},
					}
				: {}),
		};
	};
	return {
		...contract,
		resultState: "waiting_review",
		validateRequest: async (tx, ownerId, request) => {
			await loadSnapshot(tx, ownerId, request);
		},
		buildInput: () => {
			throw new Error("AI_PREPARED_PAYLOAD_REQUIRED");
		},
		buildPayload: (ownerId, request) =>
			withOwnerDatabase(ownerId, async (tx) => buildCompactTranslationWriter(await loadSnapshot(tx, ownerId, request))),
		validateCandidate: async (tx, ownerId, request, raw) => {
			const snapshot = await loadSnapshot(tx, ownerId, request);
			const candidate = translationCandidateSchema.parse(raw);
			if (!snapshot.translationProtection) throw new Error("AI_SOURCE_BINDING");
			classifyTranslationFacts(snapshot.translationProtection, candidate);
			return candidate;
		},
		validateDelivery: async (tx, ownerId, request, raw) =>
			validateCompactTranslationDelivery(await loadSnapshot(tx, ownerId, request), raw),
		verifier: {
			output: translationVerifierCheckSchema,
			outputForPayload: buildTranslationVerifierSchema,
			systemPrompt: contract.verifierPrompt,
			buildInput: () => {
				throw new Error("AI_VERIFICATION_CONTEXT_REQUIRED");
			},
			validate: () => {
				throw new Error("AI_VERIFICATION_CONTEXT_REQUIRED");
			},
			buildBatchesInContext: async (tx, ownerId, request, output, options) => {
				const plan = await prepare(tx, ownerId, request, output);
				if (!plan.batches.length || (plan.withheldIds.length && !options?.allowSegmentWithholding))
					throw new Error("AI_UNSUPPORTED_CLAIM");
				return {
					batches: plan.batches.map(({ candidate, payload, itemIds }) => ({ output: candidate, payload, itemIds })),
				};
			},
			validateBatchInContext: async (tx, ownerId, request, output, batchIndex, verdict, options) => {
				const plan = await prepare(tx, ownerId, request, output);
				const batch = plan.batches[batchIndex];
				if (!batch) throw new Error("AI_VERIFICATION_REQUIRED");
				const check = assertTranslationCheck(batch.candidate, batch.batchId, verdict);
				const decisionCount =
					check.supportedSourceIds.length + check.issues.flatMap(({ sourceIds }) => sourceIds).length;
				if (decisionCount < batch.itemIds.length && !options?.allowMissingDecisions)
					throw new VerificationGateError("AI_VERIFICATION_CLAIM_IDS", "AI_VERIFICATION_INCOMPLETE");
			},
			validateBatchesInContext: async (tx, ownerId, request, output, verdicts, options) => {
				const plan = await prepare(tx, ownerId, request, output);
				return {
					...deliver(plan.finishBatches(verdicts), options?.allowSegmentWithholding),
					batchCount: plan.batches.length,
				};
			},
			validateInContext: async (tx, ownerId, request, output, verdict, options) => {
				const plan = await prepare(tx, ownerId, request, output);
				return deliver(plan.finish(verdict), options?.allowSegmentWithholding);
			},
		},
	};
}
