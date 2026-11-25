import type { VariantSnapshot } from "./variant-types";
import {
	jobEvidenceSchema,
	summaryOutputSchema,
	tailoringOutputSchema,
	translationOutputSchema,
	translationCandidateSchema,
	MAX_VARIANT_INPUT_CODE_POINTS,
	MAX_VARIANT_PASSAGES,
	MAX_TRANSLATION_TEXT_LENGTH,
} from "@reactive-resume/schema/resume/variant-outputs";
import { variantOperationParameters } from "@reactive-resume/schema/resume/variants";
import { MAX_TERRA_WRITER_PAYLOAD_BYTES, type ModelPayload } from "./payload";
import prompts from "./variant-prompts.json";

export const jobEvidenceCandidateContract = {
	promptVersion: "job-evidence-v8-explicit-verdict-scopes",
	schemaVersion: "job-evidence-v3-classified-verdicts",
	verifierPromptVersion: "job-evidence-verifier-v5-claim-scope",
	verifierPrompt: prompts["job-evidence-verifier"],
};

export const translationCandidateContract = {
	promptVersion: "translation-v8-compact-verifier",
	schemaVersion: "translation-v4-compact",
	translationPlanVersion: "compact-v1",
	systemPrompt: prompts["translation-compact"],
	verifierPrompt: prompts["translation-compact-verifier"],
	verifierPromptVersion: "translation-check-v4-pair-decisions",
	output: translationCandidateSchema,
	deliveryOutput: translationOutputSchema,
} as const;

export const variantOperationContracts = {
	"review.job-evidence": {
		category: "job-evidence",
		parameters: variantOperationParameters["review.job-evidence"],
		output: jobEvidenceSchema,
		systemPrompt: prompts["job-evidence"],
		promptVersion: "job-evidence-v6-selected-passage-scope",
		schemaVersion: "job-evidence-v2",
	},
	"review.tailoring": {
		category: "tailoring",
		parameters: variantOperationParameters["review.tailoring"],
		output: tailoringOutputSchema,
		systemPrompt: prompts.tailoring,
		promptVersion: "tailoring-v4-full-response-verification",
		schemaVersion: "tailoring-v2",
	},
	"review.translation": {
		category: "translation",
		parameters: variantOperationParameters["review.translation"],
		output: translationOutputSchema,
		systemPrompt: prompts.translation,
		promptVersion: "translation-v5-quota-batches",
		schemaVersion: "translation-v3-batches",
	},
	"review.summary": {
		category: "summary",
		parameters: variantOperationParameters["review.summary"],
		output: summaryOutputSchema,
		systemPrompt: prompts.summary,
		promptVersion: "summary-v5-clarification-no-change",
		schemaVersion: "summary-v2",
	},
} as const;

function writerPayload(snapshot: VariantSnapshot): ModelPayload {
	const { cv, jobAd, translationProtection: _local, ...task } = snapshot;
	const payload: ModelPayload = {
		selections: [
			{ id: "variant-task", kind: "user_supplied", section: "summary", text: JSON.stringify(task) },
			{ id: "variant-cv-evidence", kind: "confirmed_content", section: "summary", text: JSON.stringify(cv) },
			{
				id: "variant-job-context",
				kind: "user_supplied",
				section: "summary",
				text: JSON.stringify({ trust: "untrusted", segments: jobAd?.segments ?? [] }),
			},
		],
	};
	return payload;
}

export function buildCompactTranslationWriter(
	snapshot: VariantSnapshot,
	limit = MAX_VARIANT_INPUT_CODE_POINTS,
): ModelPayload {
	const continuationContext = Object.fromEntries(
		snapshot.cv.flatMap(({ id }) => {
			const neighbor = snapshot.translationProtection?.continuations?.get(id);
			return neighbor ? [[id, neighbor]] : [];
		}),
	);
	const payload: ModelPayload = {
		selections: [
			{
				id: "translation-source",
				kind: "confirmed_content",
				section: "summary",
				text: JSON.stringify({
					direction: snapshot.direction,
					sourceRevision: snapshot.sourceRevision,
					segments: snapshot.cv,
					...(Object.keys(continuationContext).length
						? {
								continuationContext,
								continuationRule:
									"Use neighboring text only to interpret each wrapped line. Translate each segment as a fragment where needed. Keep every word's meaning with its original source ID, including terms and connectors that naturally move across the line in translation.",
							}
						: {}),
				}),
			},
		],
	};
	if (
		snapshot.cv.length > MAX_VARIANT_PASSAGES ||
		snapshot.cv.some(({ text }) => text.length > MAX_TRANSLATION_TEXT_LENGTH) ||
		size(payload) > limit
	)
		throw new Error("AI_INPUT_LIMIT");
	return payload;
}

const size = (value: unknown) => [...JSON.stringify(value)].length;
const tokens = (text: string) =>
	new Set(
		text
			.normalize("NFKD")
			.replace(/\p{M}/gu, "")
			.toLowerCase()
			.match(/[\p{L}\p{N}+#]{2,}/gu) ?? [],
	);

/** Extractive selection keeps source IDs and complete sentences; it never invents evidence. */
export function selectVariantEvidence(
	snapshot: VariantSnapshot,
	maxInputCodePoints = MAX_VARIANT_INPUT_CODE_POINTS,
): VariantSnapshot {
	const limit = Math.min(maxInputCodePoints, MAX_VARIANT_INPUT_CODE_POINTS);
	if (snapshot.category === "translation" || snapshot.category === "summary") {
		if (
			snapshot.cv.length > MAX_VARIANT_PASSAGES ||
			snapshot.cv.some((fact) => fact.text.length > MAX_TRANSLATION_TEXT_LENGTH) ||
			size(writerPayload(snapshot)) > limit
		)
			throw new Error("AI_INPUT_LIMIT");
		return snapshot;
	}
	// Leave room for the complete response and independent verification in the same route budget.
	const contextLimit = Math.floor(limit / 2);
	const fits = (candidate: VariantSnapshot) => {
		const serialized = JSON.stringify(writerPayload(candidate));
		return [...serialized].length <= contextLimit && Buffer.byteLength(serialized) <= MAX_TERRA_WRITER_PAYLOAD_BYTES;
	};
	const jobTerms = tokens(snapshot.jobAd?.segments.map((segment) => segment.text).join(" ") ?? "");
	const score = (text: string) => [...tokens(text)].filter((token) => jobTerms.has(token)).length;
	const excerpt = (text: string) => {
		if ([...text].length <= 4000) return text;
		const sentences = text.split(/(?<=[.!?؟。])\s+|\n+/gu).map((text, index) => ({
			text: text.trim(),
			index,
		}));
		const selected: typeof sentences = [];
		let length = 0;
		for (const sentence of sentences.sort((a, b) => score(b.text) - score(a.text) || a.index - b.index)) {
			const next = [...sentence.text].length;
			if (!next || length + next + 1 > 2000) continue;
			selected.push(sentence);
			length += next + 1;
		}
		return selected
			.sort((a, b) => a.index - b.index)
			.map((sentence) => sentence.text)
			.join(" ");
	};
	const candidate = (cv: VariantSnapshot["cv"], excerptedPassageIds: string[]): VariantSnapshot => ({
		...snapshot,
		cv,
		...(snapshot.variant
			? {
					variant: {
						...snapshot.variant,
						fields: snapshot.variant.fields.filter(
							(field) =>
								field.text.length <= 4000 &&
								field.evidenceIds.every((id) => cv.some((fact) => fact.id === id) && !excerptedPassageIds.includes(id)),
						),
					},
				}
			: {}),
		...(snapshot.evidenceSelection || cv.length !== snapshot.cv.length || excerptedPassageIds.length
			? {
					evidenceSelection: {
						totalPassages: snapshot.evidenceSelection?.totalPassages ?? snapshot.cv.length,
						omittedPassages: (snapshot.evidenceSelection?.totalPassages ?? snapshot.cv.length) - cv.length,
						excerptedPassageIds: [
							...new Set([...(snapshot.evidenceSelection?.excerptedPassageIds ?? []), ...excerptedPassageIds]),
						].filter((id) => cv.some((fact) => fact.id === id)),
					},
				}
			: {}),
	});
	const full = candidate(snapshot.cv, []);
	if (
		snapshot.cv.length <= MAX_VARIANT_PASSAGES &&
		snapshot.cv.every((fact) => fact.text.length <= MAX_TRANSLATION_TEXT_LENGTH) &&
		fits(full)
	)
		return full;
	const ranked = snapshot.cv
		.map((fact, index) => ({ fact: { ...fact, text: excerpt(fact.text) }, original: fact.text, index }))
		.sort((a, b) => score(b.fact.text) - score(a.fact.text) || a.index - b.index);
	const selected: typeof ranked = [];
	for (const entry of ranked) {
		if (!entry.fact.text || selected.length >= MAX_VARIANT_PASSAGES) continue;
		const next = [...selected, entry].sort((a, b) => a.index - b.index);
		const bounded = candidate(
			next.map((entry) => entry.fact),
			next.filter((entry) => entry.fact.text !== entry.original).map((entry) => entry.fact.id),
		);
		if (fits(bounded)) selected.push(entry);
	}
	selected.sort((a, b) => a.index - b.index);
	const bounded = candidate(
		selected.map((entry) => entry.fact),
		selected.filter((entry) => entry.fact.text !== entry.original).map((entry) => entry.fact.id),
	);
	if ((snapshot.cv.length && !selected.length) || !fits(bounded)) throw new Error("AI_INPUT_LIMIT");
	return bounded;
}

/** Snapshot prose is minimized before this boundary; structural identifiers are never redacted. */
export function buildVariantWriterPayload(
	snapshot: VariantSnapshot,
	maxInputCodePoints = MAX_VARIANT_INPUT_CODE_POINTS,
): ModelPayload {
	return writerPayload(selectVariantEvidence(snapshot, maxInputCodePoints));
}
