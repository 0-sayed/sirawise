import type { VariantSnapshot } from "./variant-types";
import { expect, it } from "vite-plus/test";
import { defaultResumeData } from "@reactive-resume/schema/resume/default";
import { translationCandidateSchema } from "@reactive-resume/schema/resume/variant-outputs";
import { loadSafetyCases } from "./testing/pipeline-safety-fixtures";
import { prepareTranslationFacts } from "./translation-invariants";
import { buildCompactTranslationWriter } from "./variant-contracts";
import { prepareCompactTranslationVerification } from "./variant-handlers";

const { inputs: fixtures, labels: expected } = loadSafetyCases<{
	id: string;
	locale: string;
	source: {
		ownerName?: string;
		sourceRevision: string;
		direction: string;
		segments: { id: string; text: string }[];
	};
	candidate: unknown;
}>("translation");

it("freezes eight Arabic and eight English translation cases with exact labels", () => {
	expect(fixtures.filter(({ locale }) => locale === "ar-SA")).toHaveLength(8);
	expect(fixtures.filter(({ locale }) => locale === "en-US")).toHaveLength(8);
	expect(fixtures.map(({ id }) => id)).toEqual(expected.map(({ id }) => id));
	expect(new Set(fixtures.map(({ id }) => id)).size).toBe(16);
});

it.each(fixtures)("uses the compact production guard for $id", (fixture) => {
	const labels = expected.find(({ id }) => id === fixture.id);
	if (!labels) throw new Error("Missing fixture label");
	const data = structuredClone(defaultResumeData);
	data.basics.name = fixture.source.ownerName ?? "";
	const protection = prepareTranslationFacts(
		data,
		fixture.source.segments.map(({ id, text }) => ({
			id,
			text,
			source: text,
			official: false,
			target: { sectionId: "summary", field: "content" },
		})),
	);
	const snapshot: VariantSnapshot = {
		category: "translation",
		resumeId: "synthetic",
		sourceRevision: fixture.source.sourceRevision,
		direction: fixture.source.direction === "ar-en" ? "ar-en" : "en-ar",
		jobAd: null,
		cv: [...protection.maskedSegments],
		translationProtection: protection,
	};
	if (!translationCandidateSchema.safeParse(fixture.candidate).success) {
		expect(labels.caught).toEqual([{ itemId: "subject", issueClass: "AI_CANDIDATE_SCHEMA", stage: "deterministic" }]);
		return;
	}
	if (labels.caught.some(({ issueClass }) => issueClass === "AI_SOURCE_BINDING")) {
		expect(() => prepareCompactTranslationVerification(snapshot, fixture.candidate, "part-1")).toThrow(
			"AI_SOURCE_BINDING",
		);
		return;
	}
	const prepared = prepareCompactTranslationVerification(snapshot, fixture.candidate, "part-1");
	expect(prepared.withheldIds).toEqual(
		labels.caught.filter(({ stage }) => stage === "deterministic").map(({ itemId }) => itemId),
	);
	if (labels.mode === "deterministic") {
		expect(prepared.payload).toBeNull();
		return;
	}
	if (fixture.source.ownerName) {
		expect(JSON.stringify(buildCompactTranslationWriter(snapshot))).not.toContain(fixture.source.ownerName);
		expect(JSON.stringify(prepared.payload)).not.toContain(fixture.source.ownerName);
	}
	const semanticIssues = labels.caught.filter(({ stage }) => stage === "semantic");
	const verdict = {
		schemaVersion: 1,
		batchId: "part-1",
		checkedSourceIds: prepared.keptIds,
		supportedSourceIds: labels.retainedIds,
		issues: semanticIssues.map(({ itemId, issueClass }) => ({ sourceIds: [itemId], code: issueClass })),
	};
	const [firstId] = prepared.keptIds;
	if (!firstId) throw new Error("Missing semantic fixture segment");
	for (const checkedSourceIds of [
		prepared.keptIds.slice(1),
		[...prepared.keptIds, firstId],
		["unknown", ...prepared.keptIds.slice(1)],
	])
		expect(() => prepared.finish({ ...verdict, checkedSourceIds })).toThrow();
	const { output, withheldIds } = prepared.finish(verdict);
	expect(withheldIds).toEqual(labels.caught.map(({ itemId }) => itemId));
	expect(output.segments.filter(({ claims }) => claims.length).map(({ sourceId }) => sourceId)).toEqual(
		labels.retainedIds,
	);
	expect(output.notes).toEqual([]);
});
