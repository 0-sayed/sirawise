import type { VariantSnapshot } from "./variant-types";
import { expect, it } from "vite-plus/test";
import { defaultResumeData } from "@reactive-resume/schema/resume/default";
import { translationCandidateSchema } from "@reactive-resume/schema/resume/variant-outputs";
import { loadSafetyCases } from "./testing/pipeline-safety-fixtures";
import { prepareTranslationFacts } from "./translation-invariants";
import { buildCompactTranslationWriter } from "./variant-contracts";
import { checkTranslationCandidate } from "./variant-handlers";

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
		expect(() => checkTranslationCandidate(snapshot, fixture.candidate)).toThrow("AI_SOURCE_BINDING");
		return;
	}
	const checked = checkTranslationCandidate(snapshot, fixture.candidate);
	const withheld =
		fixture.id === "translation-ar-unchanged"
			? ["subject"]
			: labels.caught.filter(({ stage }) => stage === "deterministic").map(({ itemId }) => itemId);
	expect(checked.withheldSegmentIds ?? []).toEqual(withheld);
	expect(checked.output.segments.filter(({ claims }) => claims.length).map(({ sourceId }) => sourceId)).toEqual(
		snapshot.cv.map(({ id }) => id).filter((id) => !withheld.includes(id)),
	);
	if (fixture.source.ownerName)
		expect(JSON.stringify(buildCompactTranslationWriter(snapshot))).not.toContain(fixture.source.ownerName);
});
