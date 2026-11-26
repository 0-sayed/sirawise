import { expect, it } from "vite-plus/test";
import { buildTranslationInventory, translationPlaceholders } from "@reactive-resume/resume/translation";
import { defaultResumeData } from "@reactive-resume/schema/resume/default";
import { resumeContactValues } from "./payload";
import { evaluateTranslationAutoApply } from "./translation-auto-apply";

function sampleCv() {
	const data = structuredClone(defaultResumeData);
	data.basics.name = "سارة العتيبي";
	data.basics.email = "sara@example.test";
	data.basics.headline = "مهندسة برمجيات";
	data.summary.hidden = false;
	data.summary.title = "نبذة";
	data.summary.content = "<p>خبرة في تطوير الأنظمة. تواصل عبر reviewer@example.test</p>";
	data.metadata.layout.pages = [{ fullWidth: false, main: ["summary"], sidebar: [] }];
	return data;
}

it("keeps verified partial results separate from failures", () => {
	const source = sampleCv();
	const inventory = buildTranslationInventory(source);
	const [failed] = inventory.segments;
	if (!failed) throw new Error("Missing fixture segment");
	const withheldSegmentIds = new Set([failed.id]);
	const segments = Object.fromEntries(
		inventory.segments.slice(1).map(({ id }) => [id, { text: "Verified", status: "pending" as const }]),
	);
	const input = { inventory, placeholders: [], contactValues: [], terms: [], segments };
	expect(evaluateTranslationAutoApply({ ...input, withheldSegmentIds })).toEqual({ ready: true });
	expect(
		evaluateTranslationAutoApply({
			...input,
			withheldSegmentIds,
			segments: { ...segments, [failed.id]: { text: "Unverified promotion", status: "pending" } },
		}),
	).toEqual({ ready: false, reason: "incomplete_segments" });
	expect(
		evaluateTranslationAutoApply({
			...input,
			segments: {},
			withheldSegmentIds: new Set(inventory.segments.map(({ id }) => id)),
		}),
	).toEqual({
		ready: false,
		reason: "incomplete_segments",
	});
});

it("allows auto-apply when all segments are verified, no terms are pending, and placeholders resolve cleanly", () => {
	const source = sampleCv();
	const originalSnapshot = structuredClone(source);
	const inventory = buildTranslationInventory(source);
	const placeholders = translationPlaceholders(source);
	const contactValues = resumeContactValues(source);
	const segments = Object.fromEntries(
		inventory.segments.map((segment) => [
			segment.id,
			{
				text: segment.text.includes("reviewer@example.test")
					? "Experience building systems. Contact [redacted]"
					: `Translated: ${segment.text}`,
				status: "pending" as const,
				author: "model" as const,
			},
		]),
	);

	const result = evaluateTranslationAutoApply({
		inventory,
		placeholders,
		contactValues,
		basicsName: source.basics.name,
		terms: [],
		segments,
	});

	expect(result).toEqual({ ready: true });
	expect(source).toEqual(originalSnapshot);
});

it.each([
	["جامعة الرياض", { ready: true }],
	["Riyadh University", { ready: false, reason: "pending_terms" }],
])("handles the pending proper name %s before auto-apply", (value, expected) => {
	const source = sampleCv();
	const inventory = buildTranslationInventory(source);
	const segments = Object.fromEntries(
		inventory.segments.map((segment) => [segment.id, { text: "Translated", status: "pending" as const }]),
	);

	const result = evaluateTranslationAutoApply({
		inventory,
		placeholders: translationPlaceholders(source),
		contactValues: resumeContactValues(source),
		basicsName: source.basics.name,
		terms: [
			{
				id: "term:1",
				source: "جامعة الرياض",
				value,
				status: "pending",
			},
		],
		segments,
	});

	expect(result).toEqual(expected);
});

it("stops auto-apply when any segment still has an unresolvable privacy placeholder", () => {
	const source = sampleCv();
	const inventory = buildTranslationInventory(source);
	const firstId = inventory.segments[0]?.id ?? "";
	const segments = Object.fromEntries(
		inventory.segments.map((segment, index) => [
			segment.id,
			{ text: index === 0 ? "Software Engineer [LOCAL_99]" : "Translated", status: "pending" as const },
		]),
	);

	const result = evaluateTranslationAutoApply({
		inventory,
		placeholders: translationPlaceholders(source),
		contactValues: resumeContactValues(source),
		basicsName: source.basics.name,
		terms: [],
		segments,
	});

	expect(result).toEqual({ ready: false, reason: "unresolved_placeholders", segmentIds: [firstId] });
});

it("stops auto-apply when any segment was rejected or missing", () => {
	const source = sampleCv();
	const inventory = buildTranslationInventory(source);
	const firstId = inventory.segments[0]?.id ?? "";
	const segments = Object.fromEntries(
		inventory.segments.map((segment, index) => [
			segment.id,
			{ text: "Translated", status: index === 0 ? ("rejected" as const) : ("pending" as const) },
		]),
	);

	expect(
		evaluateTranslationAutoApply({
			inventory,
			placeholders: translationPlaceholders(source),
			contactValues: resumeContactValues(source),
			basicsName: source.basics.name,
			terms: [],
			segments,
		}),
	).toEqual({ ready: false, reason: "rejected_segments" });

	const incomplete = { ...segments };
	delete incomplete[firstId];
	expect(
		evaluateTranslationAutoApply({
			inventory,
			placeholders: translationPlaceholders(source),
			contactValues: resumeContactValues(source),
			basicsName: source.basics.name,
			terms: [],
			segments: incomplete,
		}),
	).toEqual({ ready: false, reason: "incomplete_segments" });
});
