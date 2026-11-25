import type { ModelPayload } from "./payload";
import type { CompactProseSizing, ProtectedTranslation } from "./translation-invariants";
import type {
	TranslationCandidate,
	TranslationCheck,
	TranslationOutput,
} from "@reactive-resume/schema/resume/variant-outputs";
import { z } from "zod";
import { translationCheckSchema } from "@reactive-resume/schema/resume/variant-outputs";
import { VerificationGateError } from "./verification-failure";

export const compactTranslationCheckTargetBytes = 8_000;
// Pack short Arabic labels more densely and cap combined prose for longer passages.
// Keep the limits of admitted plans so recovery preserves verifier call IDs.
export function compactTranslationLimits(
	sizing: CompactProseSizing | false,
	direction: TranslationCandidate["direction"],
) {
	if (sizing === "ar-en-dense") return { maxPairs: 18, proseBytes: 5_200 };
	return sizing === "measured"
		? { maxPairs: direction === "ar-en" ? 12 : 6, proseBytes: 3200 }
		: { maxPairs: 6, proseBytes: sizing ? 900 : Infinity };
}

export const translationVerifierCheckSchema = translationCheckSchema.extend({
	quality: z.strictObject({
		status: z.enum(["appropriate", "inappropriate", "unclear"]),
		reason: z.string().trim().min(1).max(600),
	}),
});

export function buildTranslationVerifierSchema(payload: ModelPayload) {
	const selection = payload.selections.find((entry) => "id" in entry && entry.id === "translation-check");
	const { batchId, requiredSourceIds } = z
		.object({ batchId: z.string(), requiredSourceIds: z.array(z.string()).min(1) })
		.parse(JSON.parse(selection?.text ?? "null"));
	const id = z.enum(requiredSourceIds);
	const count = requiredSourceIds.length;
	return translationVerifierCheckSchema.extend({
		batchId: z.literal(batchId),
		checkedSourceIds: z.array(id).length(count).describe("Every required source ID, exactly once."),
		supportedSourceIds: z.array(id).max(count),
		issues: z
			.array(translationVerifierCheckSchema.shape.issues.element.extend({ sourceIds: z.array(id).min(1).max(count) }))
			.max(count),
	});
}

// Previously recorded compact verdicts did not include a language assessment.
const storedTranslationCheckSchema = translationVerifierCheckSchema.partial({
	quality: true,
	supportedSourceIds: true,
});

export function buildTranslationCheck(
	prepared: ProtectedTranslation,
	candidate: TranslationCandidate,
	batchId: string,
): ModelPayload {
	const sourceById = new Map(prepared.maskedSegments.map((segment) => [segment.id, segment]));
	const pairs = candidate.segments.map(({ sourceId, text }) => {
		const source = sourceById.get(sourceId);
		if (!source) throw new Error("AI_SOURCE_BINDING");
		return { sourceId, section: source.section, source: source.text, target: text };
	});
	return {
		selections: [
			{
				id: "translation-check",
				kind: "confirmed_content",
				section: "summary",
				text: JSON.stringify({
					batchId,
					direction: candidate.direction,
					requiredSourceIds: pairs.map(({ sourceId }) => sourceId),
					pairs,
				}),
			},
		],
	};
}

export function planCompactTranslationChecks(
	prepared: ProtectedTranslation,
	candidate: TranslationCandidate,
	partId: string,
	sizing: CompactProseSizing | false = true,
) {
	const batches: Array<{ batchId: string; candidate: TranslationCandidate; payload: ModelPayload; itemIds: string[] }> =
		[];
	let current: TranslationCandidate["segments"] = [];
	let proseBytes = 0;
	const limits = compactTranslationLimits(sizing, candidate.direction);
	const sourceBytes = new Map(prepared.maskedSegments.map(({ id, text }) => [id, Buffer.byteLength(text)]));
	const build = (segments: TranslationCandidate["segments"]) => {
		const batchId = batches.length ? `${partId}-${batches.length + 1}` : partId;
		const batch = { ...candidate, segments };
		return {
			batchId,
			candidate: batch,
			payload: buildTranslationCheck(prepared, batch, batchId),
			itemIds: segments.map(({ sourceId }) => sourceId),
		};
	};
	for (const segment of candidate.segments) {
		const segmentBytes = (sourceBytes.get(segment.sourceId) ?? 0) + Buffer.byteLength(segment.text);
		const next = [...current, segment];
		if (
			current.length &&
			(next.length > limits.maxPairs ||
				proseBytes + segmentBytes > limits.proseBytes ||
				Buffer.byteLength(JSON.stringify(build(next).payload)) > compactTranslationCheckTargetBytes)
		) {
			batches.push(build(current));
			current = [];
			proseBytes = 0;
		}
		current.push(segment);
		proseBytes += segmentBytes;
	}
	if (current.length) batches.push(build(current));
	return batches;
}

export function assertTranslationCheck(
	candidate: TranslationCandidate,
	batchId: string,
	raw: unknown,
): TranslationCheck {
	const check = storedTranslationCheckSchema.parse(raw);
	const supportedSourceIds = check.supportedSourceIds ?? [];
	const expected = new Set(candidate.segments.map(({ sourceId }) => sourceId));
	const checked = new Set(check.checkedSourceIds);
	const decided = [...supportedSourceIds, ...check.issues.flatMap(({ sourceIds }) => sourceIds)];
	if (
		check.batchId !== batchId ||
		checked.size !== expected.size ||
		checked.size !== check.checkedSourceIds.length ||
		check.checkedSourceIds.some((id) => !expected.has(id)) ||
		new Set(decided).size !== decided.length ||
		decided.some((id) => !expected.has(id))
	)
		throw new VerificationGateError("AI_VERIFICATION_CLAIM_IDS", "AI_VERIFICATION_INCOMPLETE");
	return { ...check, supportedSourceIds };
}

export function adaptVerifiedTranslation(
	prepared: ProtectedTranslation,
	candidate: TranslationCandidate,
	check: TranslationCheck,
	deterministicWithheldIds: readonly string[],
): { output: TranslationOutput; withheldIds: string[]; unverifiedIds: string[] } {
	const rejected = new Set([...deterministicWithheldIds, ...check.issues.flatMap(({ sourceIds }) => sourceIds)]);
	const supported = new Set(check.supportedSourceIds);
	const unverifiedIds = candidate.segments
		.filter(({ sourceId }) => !supported.has(sourceId) && !rejected.has(sourceId))
		.map(({ sourceId }) => sourceId);
	for (const id of unverifiedIds) rejected.add(id);
	const sourceById = new Map(prepared.maskedSegments.map((segment) => [segment.id, segment.text]));
	return {
		output: {
			...candidate,
			segments: candidate.segments.map(({ sourceId, text }) => {
				if (rejected.has(sourceId)) {
					const source = sourceById.get(sourceId);
					if (!source) throw new Error("AI_SOURCE_BINDING");
					return { sourceId, text: source, claims: [] };
				}
				return { sourceId, text, claims: [{ id: "verified", text, evidenceIds: [sourceId], kind: "translation" }] };
			}),
			notes: [],
		},
		unverifiedIds,
		withheldIds: candidate.segments.filter(({ sourceId }) => rejected.has(sourceId)).map(({ sourceId }) => sourceId),
	};
}
