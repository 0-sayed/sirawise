import type { VariantSnapshot } from "./variant-types";
import type { VariantReviewResult } from "@reactive-resume/schema/resume/variants";
import { claimsCoverText, reviewTargetSchema } from "@reactive-resume/schema/resume/ai-review";
import {
	jobEvidenceSchema,
	summaryOutputSchema,
	tailoringOutputSchema,
	translationOutputSchema,
} from "@reactive-resume/schema/resume/variant-outputs";
import { unsupportedEvidenceClaims } from "./hard-facts";
import { buildModelPayload } from "./payload";
import { boundedEvidenceAbsence, assessmentText } from "./variant-guard";
import { assertPatchRetention, guardTaskClaims, guardJobEvidenceItem } from "./variant-guard";

const unique = (ids: readonly string[]) => ids.length === new Set(ids).size;
export function validateCompactTranslationDelivery(snapshot: VariantSnapshot, raw: unknown) {
	const output = translationOutputSchema.parse(raw);
	const sources = new Map(snapshot.cv.map(({ id, text }) => [id, text]));
	if (
		output.direction !== snapshot.direction ||
		output.sourceRevision !== snapshot.sourceRevision ||
		output.notes.length ||
		output.segments.length !== sources.size ||
		!unique(output.segments.map(({ sourceId }) => sourceId))
	)
		throw new Error("AI_SOURCE_BINDING");
	for (const { sourceId, text, claims } of output.segments) {
		const source = sources.get(sourceId);
		const [claim] = claims;
		if (
			source === undefined ||
			(claim
				? claims.length !== 1 ||
					claim.id !== "checked" ||
					claim.kind !== "translation" ||
					claim.text !== text ||
					claim.evidenceIds.length !== 1 ||
					claim.evidenceIds[0] !== sourceId
				: text !== source.trim())
		)
			throw new Error("AI_SOURCE_BINDING");
	}
	return {
		kind: "review.translation" as const,
		schemaVersion: 1 as const,
		sourceRevision: { kind: "resume" as const, id: snapshot.resumeId, revision: snapshot.sourceRevision },
		output,
	};
}

function fail(reason: string): never {
	throw new Error(reason);
}
const compact = (text: string) => text.normalize("NFC").replace(/\s+/gu, " ").trim();
const key = (target: { sectionId: string; itemId?: string | null; roleId?: string | null; field: string }) =>
	JSON.stringify([target.sectionId, target.itemId ?? null, target.roleId ?? null, target.field]);
export function dominantScript(text: string): "arabic" | "latin" | null {
	const arabic = (text.match(/\p{Script=Arabic}/gu) ?? []).length;
	const latin = (text.match(/\p{Script=Latin}/gu) ?? []).length;
	if (!arabic && !latin) return null;
	return arabic >= latin ? "arabic" : "latin";
}
function isCrossLanguageClaims(snapshot: VariantSnapshot, claims: Parameters<typeof guardTaskClaims>[1]): boolean {
	if (!claims.length) return false;
	const citedIds = new Set(claims.flatMap((claim) => claim.evidenceIds));
	const cvText = snapshot.cv
		.filter((fact) => citedIds.has(fact.id))
		.map((fact) => fact.text)
		.join(" ");
	const claimText = claims.map((claim) => claim.text).join(" ");
	const cvScript = dominantScript(cvText);
	const claimScript = dominantScript(claimText);
	return cvScript !== null && claimScript !== null && cvScript !== claimScript;
}
function guard(
	snapshot: VariantSnapshot,
	claims: Parameters<typeof guardTaskClaims>[1],
	retain = false,
	translate = false,
) {
	const useTranslationGuard =
		translate || (snapshot.category === "job-evidence" && isCrossLanguageClaims(snapshot, claims));
	const result = guardTaskClaims(
		snapshot,
		claims,
		{
			lostFact: retain,
			subsetEntities: !useTranslationGuard,
			...(useTranslationGuard ? { entityChecker: "translation" as const } : {}),
		},
		snapshot.translationAliases,
	);
	if (!result.pass) fail(result.error ?? "AI_GUARD_FAILED");
}
export function validateVariantOutput(snapshot: VariantSnapshot, raw: unknown): VariantReviewResult {
	const cvIds = snapshot.cv.map((fact) => fact.id);
	const jobIds = snapshot.jobAd?.segments.map((span) => span.id) ?? [];
	if (!unique(cvIds) || !unique(jobIds) || cvIds.some((id) => jobIds.includes(id))) fail("AI_EVIDENCE_COLLISION");
	const citations = (ids: string[], required = false) => {
		if (!unique(ids) || (required && !ids.length) || ids.some((id) => !cvIds.includes(id))) fail("AI_INVALID_EVIDENCE");
	};
	const common = {
		schemaVersion: 1 as const,
		sourceRevision: { kind: "resume" as const, id: snapshot.resumeId, revision: snapshot.sourceRevision },
	};
	if (snapshot.category === "job-evidence") {
		if (snapshot.jobEvidenceContract) {
			const result = validateAndFilterVariantOutput(snapshot, raw);
			if (result.withheld) fail(result.withheld.rules[0] ?? "AI_GUARD_FAILED");
			return result;
		}
		const output = jobEvidenceSchema.parse(raw);
		if (!unique(output.requirements.map((requirement) => requirement.id))) fail("JOB_DUPLICATE_REQUIREMENT");
		if (!snapshot.jobAd && output.requirements.length) fail("JOB_NOT_SUPPLIED");
		for (const requirement of output.requirements) {
			if (
				!requirement.spanIds.length ||
				!unique(requirement.spanIds) ||
				requirement.spanIds.some((id) => !jobIds.includes(id))
			)
				fail("JOB_INVALID_SPAN");
			citations(requirement.evidenceIds, ["supported", "partial"].includes(requirement.verdict));
			const wording =
				snapshot.jobAd?.segments
					.filter((span) => requirement.spanIds.includes(span.id))
					.map((span) => span.text)
					.join(" ") ?? "";
			if (
				requirement.importance === "essential" &&
				!/\b(?:must|required|requires|essential|mandatory)\b|مطلوب|يشترط|تشترط|تتطلب|يتطلب|ضروري|أساسي|اساسي|إلزامي|الزامي/iu.test(
					wording,
				)
			)
				fail("JOB_UNSUPPORTED_IMPORTANCE");
			if (
				requirement.importance === "preferred" &&
				!/\b(?:preferred|desirable|nice.to.have)\b|يفضل|مفضل/iu.test(wording)
			)
				fail("JOB_UNSUPPORTED_IMPORTANCE");
			if (["supported", "partial"].includes(requirement.verdict))
				guard(snapshot, [
					{
						id: requirement.id,
						text: requirement.explanation,
						evidenceIds: requirement.evidenceIds,
						jobSpanIds: requirement.spanIds,
						kind: "fact",
					},
				]);
			if (
				requirement.verdict === "no_evidence" &&
				snapshot.evidenceSelection &&
				(snapshot.evidenceSelection.omittedPassages > 0 || snapshot.evidenceSelection.excerptedPassageIds.length > 0)
			)
				fail("JOB_PARTIAL_EVIDENCE_ABSENCE");
			if (requirement.verdict === "no_evidence" && !boundedEvidenceAbsence(requirement.explanation))
				fail("JOB_UNBOUNDED_ABSENCE");
		}
		for (const text of [...output.requirements.map((requirement) => requirement.explanation), ...output.notes])
			if (
				/\b(?:(?:ATS|match|compatibility|hiring) (?:score|probability|chance)|hiring chance|match\s+\d+)\b|احتمال التوظيف|نسبة المطابقة|درجة التوافق|\byou lack\b|يفتقر المرشح/iu.test(
					assessmentText(text),
				)
			)
				fail("JOB_INVALID_ASSESSMENT");
		if (snapshot.jobAd && snapshot.cv.length) {
			// Notes can describe the supplied task context as well as career facts.
			// Scope this metadata to notes. Requirements still cite CV evidence only,
			// and the independent verifier checks every complete note against the task.
			const selection = snapshot.evidenceSelection;
			const noteSnapshot = selection
				? {
						...snapshot,
						cv: [
							...snapshot.cv,
							{
								id: "task:evidence-selection",
								section: "task-context",
								text: `CV evidence selection: ${selection.omittedPassages} omitted passages. Total: ${selection.totalPassages} CV passages.\nThe evidence selection omitted ${selection.omittedPassages} of ${selection.totalPassages} CV passages.\n${selection.omittedPassages} passages were omitted from the evidence selection.`,
							},
						],
					}
				: snapshot;
			guard(
				noteSnapshot,
				output.notes.map((text, index) => ({
					id: `note:${index}`,
					text,
					evidenceIds: noteSnapshot.cv.map((fact) => fact.id),
					kind: "fact" as const,
				})),
			);
		}
		return { ...common, kind: "review.job-evidence" as const, output };
	}
	if (snapshot.category === "summary") {
		const output = summaryOutputSchema.parse(raw);
		if (!output.summary.text.trim() && !output.questions.length && !output.notes.length) fail("SUMMARY_EMPTY_RESPONSE");
		if (
			!claimsCoverText(output.summary.text, output.summary.claims) ||
			!unique([...output.summary.claims.map((claim) => claim.id), ...output.questions.map((question) => question.id)])
		)
			fail("SUMMARY_UNCOVERED_TEXT");
		for (const claim of output.summary.claims) citations(claim.evidenceIds, true);
		for (const question of output.questions) citations(question.evidenceIds);
		if (!snapshot.cv.length && (output.summary.text || !output.questions.length)) fail("SUMMARY_MISSING_QUESTION");
		guard(snapshot, output.summary.claims);
		return { ...common, kind: "review.summary" as const, output };
	}
	if (snapshot.category === "tailoring") {
		const output = tailoringOutputSchema.parse(raw);
		const variant = snapshot.variant;
		if (
			!variant ||
			output.resumeId !== variant.resumeId ||
			output.baseRevision !== variant.baseRevision ||
			snapshot.resumeId !== output.resumeId ||
			snapshot.sourceRevision !== output.baseRevision
		)
			fail("TAILORING_SOURCE_CHANGED");
		if (
			!unique(output.patches.map((patch) => patch.id)) ||
			!unique(output.patches.map((patch) => key(patch.target))) ||
			!unique(output.order.map((order) => order.sectionId))
		)
			fail("TAILORING_DUPLICATE_TARGET");
		for (const patch of output.patches) {
			const field = variant.fields.find((field) => key(field) === key(patch.target));
			const target = {
				sectionId: patch.target.sectionId,
				...(patch.target.itemId ? { itemId: patch.target.itemId } : {}),
				...(patch.target.roleId ? { roleId: patch.target.roleId } : {}),
				field: patch.target.field,
			};
			if (
				!field ||
				!reviewTargetSchema.safeParse(target).success ||
				patch.target.resumeId !== output.resumeId ||
				patch.target.baseRevision !== output.baseRevision ||
				patch.before !== field.text
			)
				fail("TAILORING_INVALID_TARGET");
			if (!claimsCoverText(patch.after, patch.claims) || !unique(patch.claims.map((claim) => claim.id)))
				fail("TAILORING_UNCOVERED_TEXT");
			citations(patch.evidenceIds, true);
			if (patch.claims.some((claim) => claim.evidenceIds.some((id) => !patch.evidenceIds.includes(id))))
				fail("AI_INVALID_EVIDENCE");
			guard(snapshot, patch.claims);
			assertPatchRetention(
				snapshot,
				patch.before,
				patch.claims,
				snapshot.cv
					.filter((fact) => patch.evidenceIds.includes(fact.id))
					.map((fact) => fact.text)
					.join("\n"),
			);
		}
		for (const order of output.order) {
			const original = variant.order.find((entry) => entry.sectionId === order.sectionId);
			if (
				!original ||
				!unique(order.itemIds) ||
				order.itemIds.length !== original.itemIds.length ||
				order.itemIds.some((id) => !original.itemIds.includes(id))
			)
				fail("TAILORING_INVALID_ORDER");
		}
		return { ...common, kind: "review.tailoring" as const, output };
	}
	const output = translationOutputSchema.parse(raw);
	if (output.sourceRevision !== snapshot.sourceRevision || output.direction !== snapshot.direction)
		fail("TRANSLATION_SOURCE_CHANGED");
	if (
		!unique(output.segments.map((segment) => segment.sourceId)) ||
		output.segments.length !== snapshot.cv.length ||
		output.segments.some((segment) => !cvIds.includes(segment.sourceId))
	)
		fail("TRANSLATION_SEGMENT_IDS");
	for (const segment of output.segments) {
		const source = snapshot.cv.find((fact) => fact.id === segment.sourceId);
		if (!source) fail("TRANSLATION_SEGMENT_IDS");
		if (
			!segment.claims.length ||
			compact(segment.text) !== compact(segment.claims.map((claim) => claim.text).join(" ")) ||
			!unique(segment.claims.map((claim) => claim.id))
		)
			fail("TRANSLATION_UNCOVERED_TEXT");
		if (segment.claims.some((claim) => claim.evidenceIds.length !== 1 || claim.evidenceIds[0] !== segment.sourceId))
			fail("TRANSLATION_INVALID_EVIDENCE");
		guard({ ...snapshot, cv: [source] }, segment.claims, true, true);
	}
	return { ...common, kind: "review.translation" as const, output };
}

function hasInstructionInjection(snapshot: VariantSnapshot, evidenceIds: readonly string[], text: string): boolean {
	const source = snapshot.cv
		.filter((fact) => evidenceIds.includes(fact.id))
		.map((fact) => fact.text)
		.join("\n");
	if (!source) return false;
	return unsupportedEvidenceClaims(source, text, source).some((entry) => entry.startsWith("instruction-only:"));
}

const WITHHOLDABLE_GUARD_ERRORS = new Set([
	"JOB_INVALID_ASSESSMENT",
	"AI_UNSUPPORTED_CLAIM",
	"AI_CONTRADICTION",
	"AI_UNVERIFIED_NEGATION",
	"AI_LOST_FACT",
	"AI_GUARD_FAILED",
	"JOB_UNSUPPORTED_IMPORTANCE",
	"JOB_PARTIAL_EVIDENCE_ABSENCE",
	"JOB_UNBOUNDED_ABSENCE",
	"TRANSLATION_UNCOVERED_TEXT",
]);

/**
 * Validates multi-item variant outputs (`job-evidence`, `tailoring`, and post-regenerate `translation`) with per-item withholding:
 * global failures (schema, IDs, citations, assessments, injection, or 0 verified items remaining) still fail the whole operation;
 * individual item fact/grounding rejections withhold only that item and record its rule.
 */
export function validateAndFilterVariantOutput(
	snapshot: VariantSnapshot,
	raw: unknown,
	options?: { allowSegmentWithholding?: boolean },
): VariantReviewResult {
	if (snapshot.category === "translation") {
		if (!options?.allowSegmentWithholding) {
			return validateVariantOutput(snapshot, raw);
		}
		const cvIds = snapshot.cv.map((fact) => fact.id);
		const jobIds = snapshot.jobAd?.segments.map((span) => span.id) ?? [];
		if (!unique(cvIds) || !unique(jobIds) || cvIds.some((id) => jobIds.includes(id))) fail("AI_EVIDENCE_COLLISION");
		const output = translationOutputSchema.parse(raw);
		if (output.sourceRevision !== snapshot.sourceRevision || output.direction !== snapshot.direction)
			fail("TRANSLATION_SOURCE_CHANGED");
		if (
			!unique(output.segments.map((segment) => segment.sourceId)) ||
			output.segments.length !== snapshot.cv.length ||
			output.segments.some((segment) => !cvIds.includes(segment.sourceId))
		)
			fail("TRANSLATION_SEGMENT_IDS");

		const withheldRules = new Set<string>();
		const withheldItems: Array<{ id: string; reason?: string }> = [];
		let firstError: string | null = null;
		let keptCount = 0;

		const segments = output.segments.map((segment) => {
			const source = snapshot.cv.find((fact) => fact.id === segment.sourceId);
			if (!source) fail("TRANSLATION_SEGMENT_IDS");
			if (segment.claims.some((claim) => claim.evidenceIds.length !== 1 || claim.evidenceIds[0] !== segment.sourceId))
				fail("TRANSLATION_INVALID_EVIDENCE");
			if (hasInstructionInjection({ ...snapshot, cv: [source] }, [segment.sourceId], segment.text))
				fail("AI_UNSUPPORTED_CLAIM");
			try {
				if (
					!segment.claims.length ||
					compact(segment.text) !== compact(segment.claims.map((claim) => claim.text).join(" ")) ||
					!unique(segment.claims.map((claim) => claim.id))
				)
					fail("TRANSLATION_UNCOVERED_TEXT");
				guard({ ...snapshot, cv: [source] }, segment.claims, true, true);
				keptCount += 1;
				return segment;
			} catch (error) {
				const reason = error instanceof Error ? error.message : "AI_GUARD_FAILED";
				if (!WITHHOLDABLE_GUARD_ERRORS.has(reason)) throw error;
				firstError ??= reason;
				withheldRules.add(reason);
				withheldItems.push({ id: segment.sourceId, reason });
				return {
					sourceId: segment.sourceId,
					text: source.text,
					claims: [
						{ id: "unchanged", kind: "translation" as const, text: source.text, evidenceIds: [segment.sourceId] },
					],
				};
			}
		});

		if (output.segments.length > 0 && keptCount === 0) fail(firstError ?? "AI_GUARD_FAILED");
		return {
			schemaVersion: 1 as const,
			sourceRevision: { kind: "resume" as const, id: snapshot.resumeId, revision: snapshot.sourceRevision },
			kind: "review.translation" as const,
			output: { ...output, segments },
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
	if (snapshot.category !== "job-evidence" && snapshot.category !== "tailoring") {
		return validateVariantOutput(snapshot, raw);
	}
	const cvIds = snapshot.cv.map((fact) => fact.id);
	const jobIds = snapshot.jobAd?.segments.map((span) => span.id) ?? [];
	if (!unique(cvIds) || !unique(jobIds) || cvIds.some((id) => jobIds.includes(id))) fail("AI_EVIDENCE_COLLISION");
	const citations = (ids: string[], required = false) => {
		if (!unique(ids) || (required && !ids.length) || ids.some((id) => !cvIds.includes(id))) fail("AI_INVALID_EVIDENCE");
	};
	const common = {
		schemaVersion: 1 as const,
		sourceRevision: { kind: "resume" as const, id: snapshot.resumeId, revision: snapshot.sourceRevision },
	};

	if (snapshot.category === "job-evidence") {
		const output = jobEvidenceSchema.parse(raw);
		const requirementIds = output.requirements.map((requirement) => requirement.id);
		if (
			!unique(requirementIds) ||
			(snapshot.jobEvidenceContract && requirementIds.some((id) => /^note:\d+$/u.test(id)))
		)
			fail("JOB_DUPLICATE_REQUIREMENT");
		if (!snapshot.jobAd && output.requirements.length) fail("JOB_NOT_SUPPLIED");
		for (const text of snapshot.jobEvidenceContract
			? []
			: [...output.requirements.map((requirement) => requirement.explanation), ...output.notes])
			if (
				/\b(?:(?:ATS|match|compatibility|hiring) (?:score|probability|chance)|hiring chance|match\s+\d+)\b|احتمال التوظيف|نسبة المطابقة|درجة التوافق|\byou lack\b|يفتقر المرشح/iu.test(
					assessmentText(text),
				)
			)
				fail("JOB_INVALID_ASSESSMENT");

		const kept: typeof output.requirements = [];
		const withheldRules = new Set<string>();
		const withheldItems: Array<{ id: string; spanIds?: string[]; reason?: string; text?: string }> = [];
		let firstError: string | null = null;

		for (const requirement of output.requirements) {
			if (
				!requirement.spanIds.length ||
				!unique(requirement.spanIds) ||
				requirement.spanIds.some((id) => !jobIds.includes(id))
			)
				fail("JOB_INVALID_SPAN");
			citations(requirement.evidenceIds, ["supported", "partial"].includes(requirement.verdict));
			if (
				!snapshot.jobEvidenceContract &&
				["supported", "partial"].includes(requirement.verdict) &&
				hasInstructionInjection(snapshot, requirement.evidenceIds, requirement.explanation)
			)
				fail("AI_UNSUPPORTED_CLAIM");
			try {
				if (snapshot.jobEvidenceContract) {
					if (hasInstructionInjection(snapshot, requirement.evidenceIds, requirement.explanation))
						fail("AI_UNSUPPORTED_CLAIM");
					guardJobEvidenceItem(snapshot, { kind: "requirement", value: requirement });
					kept.push(requirement);
					continue;
				}
				const wording =
					snapshot.jobAd?.segments
						.filter((span) => requirement.spanIds.includes(span.id))
						.map((span) => span.text)
						.join(" ") ?? "";
				if (
					requirement.importance === "essential" &&
					!/\b(?:must|required|requires|essential|mandatory)\b|مطلوب|يشترط|تشترط|تتطلب|يتطلب|ضروري|أساسي|اساسي|إلزامي|الزامي/iu.test(
						wording,
					)
				)
					fail("JOB_UNSUPPORTED_IMPORTANCE");
				if (
					requirement.importance === "preferred" &&
					!/\b(?:preferred|desirable|nice.to.have)\b|يفضل|مفضل/iu.test(wording)
				)
					fail("JOB_UNSUPPORTED_IMPORTANCE");
				if (["supported", "partial"].includes(requirement.verdict))
					guard(snapshot, [
						{
							id: requirement.id,
							text: requirement.explanation,
							evidenceIds: requirement.evidenceIds,
							jobSpanIds: requirement.spanIds,
							kind: "fact",
						},
					]);
				if (
					requirement.verdict === "no_evidence" &&
					snapshot.evidenceSelection &&
					(snapshot.evidenceSelection.omittedPassages > 0 || snapshot.evidenceSelection.excerptedPassageIds.length > 0)
				)
					fail("JOB_PARTIAL_EVIDENCE_ABSENCE");
				if (requirement.verdict === "no_evidence" && !boundedEvidenceAbsence(requirement.explanation))
					fail("JOB_UNBOUNDED_ABSENCE");
				kept.push(requirement);
			} catch (error) {
				const reason = error instanceof Error ? error.message : "AI_GUARD_FAILED";
				if (!WITHHOLDABLE_GUARD_ERRORS.has(reason)) throw error;
				firstError ??= reason;
				withheldRules.add(reason);
				withheldItems.push({
					id: requirement.id,
					spanIds: requirement.spanIds,
					reason,
					...(snapshot.jobEvidenceContract ? { text: requirement.explanation } : {}),
				});
			}
		}

		if (!snapshot.jobEvidenceContract && output.requirements.length > 0 && kept.length === 0)
			fail(firstError ?? "AI_GUARD_FAILED");

		let notes = output.notes;
		if (snapshot.jobEvidenceContract) {
			notes = output.notes.filter((text, index) => {
				const id = snapshot.jobNoteIds?.[index] ?? `note:${index}`;
				try {
					guardJobEvidenceItem(snapshot, { kind: "note", id, text });
					return true;
				} catch (error) {
					if (!(error instanceof Error) || !["JOB_INVALID_ASSESSMENT", "AI_UNSUPPORTED_CLAIM"].includes(error.message))
						throw error;
					withheldRules.add(error.message);
					withheldItems.push({ id, reason: error.message, text });
					return false;
				}
			});
			if (!kept.length && !notes.length && withheldItems.length) fail([...withheldRules][0] ?? "AI_GUARD_FAILED");
		} else if (snapshot.jobAd && snapshot.cv.length) {
			const selection = snapshot.evidenceSelection;
			const noteSnapshot = selection
				? {
						...snapshot,
						cv: [
							...snapshot.cv,
							{
								id: "task:evidence-selection",
								section: "task-context",
								text: `CV evidence selection: ${selection.omittedPassages} omitted passages. Total: ${selection.totalPassages} CV passages.\nThe evidence selection omitted ${selection.omittedPassages} of ${selection.totalPassages} CV passages.\n${selection.omittedPassages} passages were omitted from the evidence selection.`,
							},
						],
					}
				: snapshot;
			guard(
				noteSnapshot,
				output.notes.map((text, index) => ({
					id: `note:${index}`,
					text,
					evidenceIds: noteSnapshot.cv.map((fact) => fact.id),
					kind: "fact" as const,
				})),
			);
		}
		const withheldCount = withheldItems.length;
		return {
			...common,
			kind: "review.job-evidence" as const,
			output: { ...output, requirements: kept, notes },
			...(withheldCount > 0
				? {
						withheld: {
							count: withheldCount,
							rules: [...withheldRules],
							...(withheldItems.length
								? { items: snapshot.jobEvidenceContract ? withheldItems : withheldItems.slice(0, 50) }
								: {}),
						},
					}
				: {}),
		};
	}

	const output = tailoringOutputSchema.parse(raw);
	const variant = snapshot.variant;
	if (
		!variant ||
		output.resumeId !== variant.resumeId ||
		output.baseRevision !== variant.baseRevision ||
		snapshot.resumeId !== output.resumeId ||
		snapshot.sourceRevision !== output.baseRevision
	)
		fail("TAILORING_SOURCE_CHANGED");
	if (
		!unique(output.patches.map((patch) => patch.id)) ||
		!unique(output.patches.map((patch) => key(patch.target))) ||
		!unique(output.order.map((order) => order.sectionId))
	)
		fail("TAILORING_DUPLICATE_TARGET");
	for (const order of output.order) {
		const original = variant.order.find((entry) => entry.sectionId === order.sectionId);
		if (
			!original ||
			!unique(order.itemIds) ||
			order.itemIds.length !== original.itemIds.length ||
			order.itemIds.some((id) => !original.itemIds.includes(id))
		)
			fail("TAILORING_INVALID_ORDER");
	}

	const keptPatches: typeof output.patches = [];
	const withheldRules = new Set<string>();
	let firstError: string | null = null;

	for (const patch of output.patches) {
		const field = variant.fields.find((field) => key(field) === key(patch.target));
		const target = {
			sectionId: patch.target.sectionId,
			...(patch.target.itemId ? { itemId: patch.target.itemId } : {}),
			...(patch.target.roleId ? { roleId: patch.target.roleId } : {}),
			field: patch.target.field,
		};
		if (
			!field ||
			!reviewTargetSchema.safeParse(target).success ||
			patch.target.resumeId !== output.resumeId ||
			patch.target.baseRevision !== output.baseRevision ||
			patch.before !== field.text
		)
			fail("TAILORING_INVALID_TARGET");
		if (!claimsCoverText(patch.after, patch.claims) || !unique(patch.claims.map((claim) => claim.id)))
			fail("TAILORING_UNCOVERED_TEXT");
		citations(patch.evidenceIds, true);
		if (patch.claims.some((claim) => claim.evidenceIds.some((id) => !patch.evidenceIds.includes(id))))
			fail("AI_INVALID_EVIDENCE");
		if (patch.claims.some((claim) => hasInstructionInjection(snapshot, claim.evidenceIds, claim.text)))
			fail("AI_UNSUPPORTED_CLAIM");
		try {
			guard(snapshot, patch.claims);
			assertPatchRetention(
				snapshot,
				patch.before,
				patch.claims,
				snapshot.cv
					.filter((fact) => patch.evidenceIds.includes(fact.id))
					.map((fact) => fact.text)
					.join("\n"),
			);
			keptPatches.push(patch);
		} catch (error) {
			const reason = error instanceof Error ? error.message : "AI_GUARD_FAILED";
			if (!WITHHOLDABLE_GUARD_ERRORS.has(reason)) throw error;
			firstError ??= reason;
			withheldRules.add(reason);
		}
	}

	if (output.patches.length > 0 && keptPatches.length === 0 && output.order.length === 0)
		fail(firstError ?? "AI_GUARD_FAILED");
	const withheldCount = output.patches.length - keptPatches.length;
	return {
		...common,
		kind: "review.tailoring" as const,
		output: { ...output, patches: keptPatches },
		...(withheldCount > 0 ? { withheld: { count: withheldCount, rules: [...withheldRules] } } : {}),
	};
}

/** Validation used for both writer and verifier prose; structure/IDs never pass through redaction. */
export function minimizedVariantText(text: string, contactValues: string[] = []): string {
	if (!text.trim()) return "";
	return (
		buildModelPayload({ selections: [{ id: "text", kind: "model_proposed", section: "summary", text }], contactValues })
			.selections[0]?.text ?? ""
	);
}
