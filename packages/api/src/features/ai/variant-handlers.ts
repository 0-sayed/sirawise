import type { OperationHandler } from "./route-policy";
import type { VariantSnapshot } from "./variant-types";
import type { VariantOperationKind } from "@reactive-resume/schema/resume/variants";
import { and, eq } from "drizzle-orm";
import { withOwnerDatabase } from "@reactive-resume/db/client";
import { resume } from "@reactive-resume/db/schema";
import { readTarget } from "@reactive-resume/resume/proposals";
import { translationCandidateSchema } from "@reactive-resume/schema/resume/variant-outputs";
import { escapeHtml } from "@reactive-resume/utils/string";
import { classifyTranslationFacts } from "./translation-invariants";
import {
	buildCompactTranslationWriter,
	buildVariantWriterPayload,
	variantOperationContracts,
	jobEvidenceCandidateContract,
	translationCandidateContract,
} from "./variant-contracts";
export { prepareTranslationFacts } from "./translation-invariants";
import { hasOverbroadJobAbsence } from "./variant-guard";
import { loadVariantSnapshot } from "./variant-sources";
import {
	dominantScript,
	validateAndFilterVariantOutput,
	validateCompactTranslationDelivery,
} from "./variant-validation";
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
	const requirements = filtered.output.requirements.map((requirement) => {
		if (
			snapshot.jobAd?.version !== "requirements-v2" ||
			requirement.verdict !== "no_evidence" ||
			requirement.evidenceIds.length !== 0 ||
			!hasOverbroadJobAbsence(requirement.explanation)
		)
			return requirement;
		// Replace the whole unsupported explanation before verification. The verifier still
		// checks absence against the selected CV and independently verifies this new wording.
		const explanation =
			dominantScript(requirement.explanation) === "arabic"
				? "لا تثبت المقاطع المختارة من السيرة الذاتية هذا المتطلب."
				: "The selected CV passages do not establish this requirement.";
		return { ...requirement, explanation };
	});
	return {
		snapshot: { ...bound, jobNoteIds: noteIds.filter((id) => !rejected.has(id)) },
		output: { ...filtered.output, requirements },
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
			// Root translation admission validates the source while building the plan it persists.
			if (kind !== "review.translation" || request.parameters.translationBatch)
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
		validateResult: async (tx, ownerId, request, output, options) => {
			const result = validateAndFilterVariantOutput(await loadSnapshot(tx, ownerId, request), output, options);
			if (result.kind !== "review.summary" && result.kind !== "review.tailoring") return result;

			const [source] = await tx
				.select({ data: resume.data })
				.from(resume)
				.where(and(eq(resume.userId, ownerId), eq(resume.id, result.sourceRevision.id)));
			if (!source) throw new Error("AI_SOURCE_CHANGED");
			if (result.kind === "review.summary") {
				const text = result.output.summary.text.replaceAll("[NAME_1]", () => source.data.basics.name);
				if (text && source.data.summary.content === `<p>${escapeHtml(text)}</p>`)
					result.output.summary = { text: "", claims: [] };
			} else {
				result.output.patches = result.output.patches.filter(({ target, after }) => {
					const { sectionId, field, itemId, roleId } = target;
					const original = readTarget(source.data, {
						sectionId,
						field,
						itemId: itemId ?? undefined,
						roleId: roleId ?? undefined,
					});
					return original !== `<p>${escapeHtml(after)}</p>`;
				});
			}
			return result;
		},
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

export function checkTranslationCandidate(snapshot: VariantSnapshot, raw: unknown) {
	const candidate = translationCandidateSchema.parse(raw);
	const prepared = snapshot.translationProtection;
	if (!prepared) throw new Error("AI_SOURCE_BINDING");
	const { keptIds, issues, withheldIds } = classifyTranslationFacts(prepared, candidate, snapshot.translationAliases);
	const kept = new Set(keptIds);
	const translations = new Map(candidate.segments.map(({ sourceId, text }) => [sourceId, text]));
	const result = validateCompactTranslationDelivery(snapshot, {
		direction: candidate.direction,
		sourceRevision: candidate.sourceRevision,
		notes: [],
		segments: snapshot.cv.map(({ id, text: original }) => {
			const text = kept.has(id) ? translations.get(id) : undefined;
			return text === undefined
				? { sourceId: id, text: original.trim(), claims: [] }
				: { sourceId: id, text, claims: [{ id: "checked", text, kind: "translation", evidenceIds: [id] }] };
		}),
	});
	const rule = (kind: string) => "TRANSLATION_FACT_" + kind.toUpperCase();
	return {
		...result,
		...(withheldIds.length
			? {
					withheldSegmentIds: withheldIds,
					withheld: {
						count: withheldIds.length,
						rules: [...new Set(issues.map(({ kind }) => rule(kind)))],
						items: issues.slice(0, 50).map(({ id, kind, value }) => ({
							id,
							reason: rule(kind) + ((kind === "number" || kind === "term") && value ? ":" + value.slice(0, 75) : ""),
						})),
					},
				}
			: {}),
	};
}

export function createTranslationCandidateHandler(): OperationHandler {
	const contract = { ...variantOperationContracts["review.translation"], ...translationCandidateContract };
	const loadSnapshot: typeof loadVariantSnapshot = (tx, ownerId, request) =>
		loadVariantSnapshot(tx, ownerId, request, { compactTranslation: true });
	return {
		...contract,
		resultState: "waiting_review",
		validateRequest: async (tx, ownerId, request) => {
			if (request.parameters.translationBatch) await loadSnapshot(tx, ownerId, request);
		},
		buildInput: () => {
			throw new Error("AI_PREPARED_PAYLOAD_REQUIRED");
		},
		buildPayload: (ownerId, request) =>
			withOwnerDatabase(ownerId, async (tx) => buildCompactTranslationWriter(await loadSnapshot(tx, ownerId, request))),
		validateResult: async (tx, ownerId, request, raw) =>
			checkTranslationCandidate(await loadSnapshot(tx, ownerId, request), raw),
	};
}
