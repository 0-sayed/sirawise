import type { CompactProseSizing } from "./translation-invariants";
import type { VariantSnapshot } from "./variant-types";
import type { TranslationOutput } from "@reactive-resume/schema/resume/variant-outputs";
import { createHash } from "node:crypto";
import { z } from "zod";
import {
	MAX_TRANSLATION_TEXT_LENGTH,
	MAX_VARIANT_INPUT_CODE_POINTS,
	MAX_VARIANT_PASSAGES,
} from "@reactive-resume/schema/resume/variant-outputs";
import { bindTranslationPart } from "./translation-invariants";
import {
	buildTranslationCheck,
	compactTranslationCheckTargetBytes,
	compactTranslationLimits,
} from "./translation-verifier";
import { buildCompactTranslationWriter, buildVariantWriterPayload } from "./variant-contracts";
import { buildVariantVerificationPayload } from "./variant-verifier";

export type TranslationBatchPlan = {
	batches: VariantSnapshot[];
	groups: Array<{ id: string; partIds: string[] }>;
	fingerprint: string;
	version?: "compact-v1";
	compactProseSizing?: CompactProseSizing;
};

const persistedPlanSchema = z.strictObject({
	fingerprint: z.string().regex(/^[a-f0-9]{64}$/u),
	version: z.literal("compact-v1").optional(),
	compactProseSizing: z.literal([true, "measured", "ar-en-dense"]).optional(),
	groups: z.array(z.strictObject({ id: z.string(), partIds: z.array(z.string()) })),
	batches: z.array(z.array(z.strictObject({ id: z.string(), section: z.string(), text: z.string() }))),
});

export function persistTranslationPlan(plan: TranslationBatchPlan): Record<string, unknown> {
	return { ...plan, batches: plan.batches.map((batch) => batch.cv) };
}

/** A deployed planner must not change the boundaries or identifiers of an admitted batch. */
export function restoreTranslationPlan(snapshot: VariantSnapshot, value: unknown): TranslationBatchPlan {
	const stored = persistedPlanSchema.parse(value);
	const { version, compactProseSizing, groups, batches } = stored;
	const facts = new Map(stored.batches.flat().map((fact) => [fact.id, fact]));
	if (
		Boolean(stored.version) !== Boolean(snapshot.translationProtection) ||
		(compactProseSizing && !version) ||
		facts.size !== stored.batches.flat().length ||
		facts.size !== new Set(stored.groups.flatMap(({ partIds }) => partIds)).size ||
		stored.groups.length !== snapshot.cv.length ||
		stored.groups.some((group, index) => {
			const source = snapshot.cv[index];
			return (
				group.id !== source?.id ||
				group.partIds.map((id) => facts.get(id)?.text).join("") !== source.text ||
				group.partIds.some((id) => facts.get(id)?.section !== source.section)
			);
		}) ||
		createHash("sha256").update(JSON.stringify({ version, groups, batches, compactProseSizing })).digest("hex") !==
			stored.fingerprint
	)
		throw new Error("TRANSLATION_BATCH_PLAN_CHANGED");
	return {
		...stored,
		batches: translationPartSnapshots(snapshot, batches, groups, compactProseSizing),
	} as TranslationBatchPlan;
}

function translationPartSnapshots(
	snapshot: VariantSnapshot,
	batches: VariantSnapshot["cv"][],
	groups: TranslationBatchPlan["groups"],
	compactProseSizing?: CompactProseSizing,
): VariantSnapshot[] {
	const protection = snapshot.translationProtection;
	if (!protection) return batches.map((cv) => ({ ...snapshot, cv }));
	const continuations = new Map(
		groups.flatMap(({ id, partIds }) => {
			const context = compactProseSizing ? protection.continuations?.get(id) : undefined;
			return context && partIds.length === 1 && partIds[0] ? [[partIds[0], context] as const] : [];
		}),
	);
	return batches.map((cv) => ({
		...snapshot,
		cv,
		translationProtection: bindTranslationPart(
			{ ...protection, continuations, ...(compactProseSizing ? { compactProseSizing } : {}) },
			cv,
		),
	}));
}

type TranslationBudget = { maxInputCodePoints: number; maxOutputTokens: number; verifierMaxInputBytes?: number };

function planCompactTranslation(
	snapshot: VariantSnapshot,
	budget: TranslationBudget,
	compactProseSizing: CompactProseSizing = snapshot.direction === "ar-en" ? "ar-en-dense" : "measured",
): TranslationBatchPlan {
	const prepared = snapshot.translationProtection;
	const direction = snapshot.direction;
	if (!prepared || !direction || !snapshot.cv.length) throw new Error("AI_INPUT_LIMIT");
	const writerLimit = Math.min(MAX_VARIANT_INPUT_CODE_POINTS, budget.maxInputCodePoints);
	const writerTokens = Math.min(1200, Math.floor(budget.maxOutputTokens * 0.75));
	const verifyLimits = compactTranslationLimits(compactProseSizing, direction);
	const verifierLimit = Math.min(
		compactTranslationCheckTargetBytes,
		budget.verifierMaxInputBytes ?? budget.maxInputCodePoints,
	);
	const fits = (cv: VariantSnapshot["cv"]) => {
		if (cv.length > verifyLimits.maxPairs) return false;
		const output = {
			direction,
			sourceRevision: snapshot.sourceRevision,
			segments: cv.map(({ id, text }) => ({ sourceId: id, text })),
		};
		const textLength = cv.reduce((total, { text }) => total + [...text].length, 0);
		const projectedTokens =
			([...JSON.stringify(output)].length - textLength) / 4 + textLength / (direction === "en-ar" ? 2 : 4);
		if (projectedTokens > writerTokens) return false;
		try {
			buildCompactTranslationWriter({ ...snapshot, cv }, writerLimit);
			const check = buildTranslationCheck({ ...prepared, maskedSegments: cv }, output, "part-999999");
			// Allow a second byte for each English letter projected into the Arabic target.
			const targetExtraBytes =
				direction === "en-ar" ? cv.reduce((total, { text }) => total + (text.match(/[A-Za-z]/gu)?.length ?? 0), 0) : 0;
			const proseBytes = cv.reduce((total, { text }) => total + 2 * Buffer.byteLength(text), targetExtraBytes);
			return (
				(cv.length === 1 || proseBytes <= verifyLimits.proseBytes) &&
				Buffer.byteLength(JSON.stringify(check)) + targetExtraBytes <= verifierLimit
			);
		} catch (error) {
			if (error instanceof Error && error.message === "AI_INPUT_LIMIT") return false;
			throw error;
		}
	};
	const segmenter = new Intl.Segmenter(direction === "en-ar" ? "en" : "ar", { granularity: "sentence" });
	const sentenceParts = (text: string) => {
		const parts: string[] = [];
		let buffered = "";
		for (const { segment } of segmenter.segment(text)) {
			if (!segment.trim() && !buffered && parts.length) {
				parts[parts.length - 1] += segment;
				continue;
			}
			buffered += segment;
			if (/(?:^|\s)(?:Dr|Mr|Mrs|Ms|Prof|[A-Z]|د|[\p{Nd}]+)\.\s*$/u.test(segment)) continue;
			parts.push(buffered);
			buffered = "";
		}
		if (buffered) {
			if (parts.length) parts[parts.length - 1] += buffered;
			else parts.push(buffered);
		}
		return parts;
	};
	let nextId = 0;
	const groups: TranslationBatchPlan["groups"] = [];
	const orderedParts: VariantSnapshot["cv"] = [];
	for (const fact of snapshot.cv) {
		const bounded = (text: string) => fits([{ ...fact, id: "szzzzzz", text }]);
		const texts = bounded(fact.text) ? [fact.text] : sentenceParts(fact.text);
		const parts: VariantSnapshot["cv"] = [];
		let current = "";
		for (const text of texts) {
			if (!bounded(text) || !text.trim()) throw new Error("AI_INPUT_LIMIT");
			if (current && !bounded(current + text)) {
				parts.push({ ...fact, id: `s${(nextId++).toString(36)}`, text: current });
				current = "";
			}
			current += text;
		}
		if (current) parts.push({ ...fact, id: `s${(nextId++).toString(36)}`, text: current });
		orderedParts.push(...parts);
		groups.push({ id: fact.id, partIds: parts.map(({ id }) => id) });
	}
	const batches: VariantSnapshot["cv"][] = [];
	let current: VariantSnapshot["cv"] = [];
	for (const part of orderedParts) {
		if (current.length && !fits([...current, part])) {
			batches.push(current);
			current = [];
		}
		current.push(part);
	}
	if (current.length) batches.push(current);
	const version = "compact-v1";
	const fingerprint = createHash("sha256")
		.update(JSON.stringify({ version, groups, batches, compactProseSizing }))
		.digest("hex");
	return {
		version,
		fingerprint,
		groups,
		compactProseSizing,
		batches: translationPartSnapshots(snapshot, batches, groups, compactProseSizing),
	};
}

/** Legacy rows have only a hash. Never replace their admitted plan with a newly sized plan. */
export function recoverTranslationPlan(
	snapshot: VariantSnapshot,
	budget: TranslationBudget,
	fingerprint: string,
): TranslationBatchPlan | null {
	for (const legacyBudget of [budget, { maxInputCodePoints: 32000, maxOutputTokens: 4096 }]) {
		for (const legacyQualityTask of [false, true]) {
			for (const legacySizing of [false, true]) {
				for (const legacyFullInventory of [false, true]) {
					const candidate = planTranslationBatches(
						snapshot,
						legacyBudget,
						legacyQualityTask,
						legacySizing,
						legacyFullInventory,
					);
					if (candidate.fingerprint === fingerprint) return candidate;
				}
			}
		}
	}
	return null;
}

/** Keep placeholders and graphemes whole, including when a paragraph has no sentence boundaries. */
function splitText(text: string, limit: number): string[] {
	const units = [...text.matchAll(/\[LOCAL_\d+\]|\[NAME_\d+\]|[^[]+|\[/gu)].flatMap(([value]) =>
		/^\[(?:LOCAL|NAME)_\d+\]$/u.test(value)
			? [value]
			: [...new Intl.Segmenter(undefined, { granularity: "word" }).segment(value)].flatMap((part) =>
					[...part.segment].length <= limit
						? [part.segment]
						: [...new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(part.segment)].map(
								(part) => part.segment,
							),
				),
	);
	const parts: string[] = [];
	let current = "";
	let currentLength = 0;
	for (const unit of units) {
		const unitLength = [...unit].length;
		if (current && currentLength + unitLength > limit) {
			parts.push(current);
			current = "";
			currentLength = 0;
		}
		current += unit;
		currentLength += unitLength;
	}
	if (current) parts.push(current);
	return parts;
}

/** Estimate the complete JSON response, including repeated claim text and evidence identifiers. */
function projectedOutput(snapshot: VariantSnapshot): TranslationOutput {
	return {
		direction: snapshot.direction ?? "en-ar",
		sourceRevision: snapshot.sourceRevision,
		segments: snapshot.cv.map((fact) => ({
			sourceId: fact.id,
			text: fact.text,
			claims: [{ id: "c", text: fact.text, evidenceIds: [fact.id], kind: "translation" }],
		})),
		notes: [],
	};
}

/** Smaller calls bound writer and verifier work; the provider still enforces the approved hard caps. */
export function planTranslationBatches(
	snapshot: VariantSnapshot,
	budget: TranslationBudget,
	legacyQualityTask = false,
	legacySizing = false,
	legacyFullInventory = false,
): TranslationBatchPlan {
	if (snapshot.translationProtection) return planCompactTranslation(snapshot, budget);
	const inputLimit = Math.min(MAX_VARIANT_INPUT_CODE_POINTS, budget.maxInputCodePoints);
	const outputTarget = Math.min(legacySizing ? 1200 : 900, Math.floor(budget.maxOutputTokens * 0.75));
	const verifierInputTarget = Math.min(legacySizing ? 12000 : 9000, Math.floor(inputLimit * 0.85));
	const fits = (cv: VariantSnapshot["cv"]) => {
		const candidate = { ...snapshot, cv };
		const output = projectedOutput(candidate);
		const textSize = cv.reduce((total, fact) => total + [...fact.text].length * 2, 0);
		// English JSON averages four characters per token; generated Arabic needs a larger allowance.
		const outputTokens = Math.ceil(
			([...JSON.stringify(output)].length - textSize) / 4 + textSize / (snapshot.direction === "en-ar" ? 2 : 4),
		);
		if (outputTokens > outputTarget) return false;
		try {
			buildVariantWriterPayload(candidate, inputLimit);
			const verification = buildVariantVerificationPayload(candidate, output, 32000, {
				legacyFullInventory: legacyFullInventory || legacyQualityTask,
			});
			if (legacyQualityTask) {
				// Restore pre-deploy boundaries only. Actual calls always use the current verifier task.
				const task = verification.selections.find(
					(selection) => "id" in selection && selection.id === "variant-verification-task",
				);
				if (task) {
					const value = JSON.parse(task.text);
					if (value.translationQuality) delete value.translationQuality.assessment;
					task.text = JSON.stringify(value);
				}
			}
			return [...JSON.stringify(verification)].length <= verifierInputTarget;
		} catch (error) {
			if (error instanceof Error && error.message === "AI_INPUT_LIMIT") return false;
			throw error;
		}
	};
	const batches: VariantSnapshot[] = [];
	const groups: TranslationBatchPlan["groups"] = [];
	const allParts: VariantSnapshot["cv"] = [];
	let nextId = 0;
	for (const fact of snapshot.cv) {
		const boundedTexts = (text: string): string[] => {
			const codePoints = [...text];
			if (text.length <= MAX_TRANSLATION_TEXT_LENGTH && fits([{ ...fact, id: "szzzz", text }])) return [text];
			let low = 1;
			let high = Math.min(MAX_TRANSLATION_TEXT_LENGTH, codePoints.length);
			// Find the largest individually bounded chunk before preserving word/grapheme boundaries.
			while (low < high) {
				const middle = Math.ceil((low + high) / 2);
				if (fits([{ ...fact, id: "szzzz", text: codePoints.slice(0, middle).join("") }])) low = middle;
				else high = middle - 1;
			}
			const pieces = splitText(text, low);
			if (pieces.length < 2) throw new Error("AI_INPUT_LIMIT");
			return pieces.flatMap(boundedTexts);
		};
		const parts = boundedTexts(fact.text).map((text) => ({
			...fact,
			id: `s${(nextId++).toString(36)}`,
			text,
		}));
		groups.push({ id: fact.id, partIds: parts.map((part) => part.id) });
		for (const part of parts) {
			if (!fits([part])) throw new Error("AI_INPUT_LIMIT");
			allParts.push(part);
		}
	}
	for (let start = 0; start < allParts.length;) {
		let low = 1;
		let high = Math.min(MAX_VARIANT_PASSAGES, allParts.length - start);
		// Search whole serialized candidates instead of rebuilding a growing payload for every segment.
		while (low < high) {
			const middle = Math.ceil((low + high) / 2);
			if (fits(allParts.slice(start, start + middle))) low = middle;
			else high = middle - 1;
		}
		batches.push({ ...snapshot, cv: allParts.slice(start, start + low) });
		start += low;
	}
	if (!batches.length) batches.push({ ...snapshot, cv: [] });
	return {
		batches,
		groups,
		fingerprint: createHash("sha256")
			.update(JSON.stringify({ groups, batches: batches.map((batch) => batch.cv) }))
			.digest("hex"),
	};
}

/** Only verified parts are supplied by the fenced delivery transaction. */
function joinTranslatedParts(
	parts: TranslationOutput["segments"],
	sourceParts: VariantSnapshot["cv"],
	compact: boolean,
) {
	return parts
		.map((part, index) => {
			if (index === 0) return part.text;
			const before = /\s+$/u.exec(sourceParts[index - 1]?.text ?? "")?.[0] ?? "";
			const after = /^\s+/u.exec(sourceParts[index]?.text ?? "")?.[0] ?? "";
			if (compact) return `${before}${after}${part.text}`;
			return (before || after) && !/\s$/u.test(parts[index - 1]?.text ?? "") && !/^\s/u.test(part.text)
				? ` ${part.text}`
				: part.text;
		})
		.join("");
}

export function mergeTranslationBatches(
	snapshot: VariantSnapshot,
	plan: TranslationBatchPlan,
	outputs: TranslationOutput[],
): TranslationOutput {
	if (!snapshot.direction || outputs.length !== plan.batches.length) throw new Error("TRANSLATION_BATCH_INCOMPLETE");
	const segments = outputs.flatMap((output, index) => {
		const expected = plan.batches[index]?.cv.map((fact) => fact.id) ?? [];
		if (
			output.direction !== snapshot.direction ||
			output.sourceRevision !== snapshot.sourceRevision ||
			output.segments.length !== expected.length ||
			new Set(output.segments.map((segment) => segment.sourceId)).size !== expected.length ||
			output.segments.some((segment) => !expected.includes(segment.sourceId))
		)
			throw new Error("TRANSLATION_BATCH_INCOMPLETE");
		return output.segments;
	});
	const byId = new Map(segments.map((segment) => [segment.sourceId, segment]));
	const sourcesById = new Map(plan.batches.flatMap((batch) => batch.cv).map((fact) => [fact.id, fact]));
	return {
		direction: snapshot.direction,
		sourceRevision: snapshot.sourceRevision,
		segments: plan.groups.map((group) => {
			const parts = group.partIds.map((id) => {
				const segment = byId.get(id);
				if (!segment) throw new Error("TRANSLATION_BATCH_INCOMPLETE");
				return segment;
			});
			const sourceParts = group.partIds.map((id) => {
				const source = sourcesById.get(id);
				if (!source) throw new Error("TRANSLATION_BATCH_INCOMPLETE");
				return source;
			});
			const text = joinTranslatedParts(parts, sourceParts, plan.version === "compact-v1");
			return {
				sourceId: group.id,
				text,
				claims: [{ id: "combined", text, evidenceIds: [group.id], kind: "translation" as const }],
			};
		}),
		notes: [...new Set(outputs.flatMap((output) => output.notes))],
	};
}

export type PartialTranslationPart =
	| {
			status: "delivered";
			output: TranslationOutput;
			withheldSegmentIds?: string[];
			withheld?:
				| {
						count: number;
						rules: string[];
						items?: Array<{ id: string; reason?: string | undefined }> | undefined;
				  }
				| undefined;
	  }
	| {
			status: "failed";
			reason: string;
	  };

/**
 * Combines delivered translation parts while keeping any failed part or withheld segment
 * unchanged at its original source text (never unverified AI text).
 */
export function mergePartialTranslationBatches(
	snapshot: VariantSnapshot,
	plan: TranslationBatchPlan,
	parts: PartialTranslationPart[],
): {
	output: TranslationOutput;
	withheldSegmentIds: string[];
	withholdingIdsComplete: boolean;
	withheld?: {
		count: number;
		rules: string[];
		items: Array<{ id: string; reason: string; partIndex: number }>;
	};
} {
	if (!snapshot.direction || parts.length !== plan.batches.length) throw new Error("TRANSLATION_BATCH_INCOMPLETE");
	const byId = new Map<string, TranslationOutput["segments"][number]>();
	const withheldPartBySegmentId = new Map<string, { reason: string; partIndex: number }>();
	const notes: string[] = [];
	let withholdingIdsComplete = true;

	parts.forEach((part, partIndex) => {
		const expected = plan.batches[partIndex]?.cv.map((fact) => fact.id) ?? [];
		if (part.status === "failed") {
			for (const id of expected) withheldPartBySegmentId.set(id, { reason: part.reason, partIndex });
			return;
		}
		const output = part.output;
		if (
			output.direction !== snapshot.direction ||
			output.sourceRevision !== snapshot.sourceRevision ||
			output.segments.length !== expected.length ||
			new Set(output.segments.map((segment) => segment.sourceId)).size !== expected.length ||
			output.segments.some((segment) => !expected.includes(segment.sourceId))
		)
			throw new Error("TRANSLATION_BATCH_INCOMPLETE");
		for (const segment of output.segments) byId.set(segment.sourceId, segment);
		const items = new Map(part.withheld?.items?.map(({ id, reason }) => [id, reason]));
		let ids = part.withheldSegmentIds ?? [...items.keys()];
		if (part.withheld && ids.length !== part.withheld.count && !part.withheldSegmentIds) {
			withholdingIdsComplete = false;
			ids = expected;
		}
		if (new Set(ids).size !== ids.length || ids.some((id) => !expected.includes(id)))
			throw new Error("TRANSLATION_BATCH_INCOMPLETE");
		for (const id of ids) {
			withheldPartBySegmentId.set(id, {
				reason: items.get(id) ?? "AI_VERIFICATION_CLAIM_SUPPORT",
				partIndex,
			});
		}
		notes.push(...output.notes);
	});

	const sourcesById = new Map(plan.batches.flatMap((batch) => batch.cv).map((fact) => [fact.id, fact]));
	const fullSourceById = new Map(snapshot.cv.map((fact) => [fact.id, fact.text]));
	const withheldItems: Array<{ id: string; reason: string; partIndex: number }> = [];
	const withheldRules = new Set<string>();

	const segments = plan.groups.map((group) => {
		const withheldInfo = group.partIds
			.map((id) => withheldPartBySegmentId.get(id))
			.find((entry): entry is { reason: string; partIndex: number } => Boolean(entry));
		if (withheldInfo) {
			const originalText = fullSourceById.get(group.id) ?? "";
			withheldRules.add(withheldInfo.reason);
			withheldItems.push({ id: group.id, reason: withheldInfo.reason, partIndex: withheldInfo.partIndex });
			return {
				sourceId: group.id,
				text: originalText,
				claims: [{ id: "unchanged", text: originalText, evidenceIds: [group.id], kind: "translation" as const }],
			};
		}
		const groupParts = group.partIds.map((id) => {
			const segment = byId.get(id);
			if (!segment) throw new Error("TRANSLATION_BATCH_INCOMPLETE");
			return segment;
		});
		const sourceParts = group.partIds.map((id) => {
			const source = sourcesById.get(id);
			if (!source) throw new Error("TRANSLATION_BATCH_INCOMPLETE");
			return source;
		});
		const text = joinTranslatedParts(groupParts, sourceParts, plan.version === "compact-v1");
		return {
			sourceId: group.id,
			text,
			claims: [{ id: "combined", text, evidenceIds: [group.id], kind: "translation" as const }],
		};
	});

	return {
		withheldSegmentIds: withheldItems.map(({ id }) => id),
		withholdingIdsComplete,
		output: {
			direction: snapshot.direction,
			sourceRevision: snapshot.sourceRevision,
			segments,
			notes: [...new Set(notes)],
		},
		...(withheldItems.length > 0
			? {
					withheld: {
						count: withheldItems.length,
						rules: [...withheldRules],
						items: withheldItems.slice(0, 50),
					},
				}
			: {}),
	};
}
