import type { VariantSnapshot } from "./variant-types";
import { expect, it } from "vite-plus/test";
import fixture from "./testing/fixtures/job-evidence-long-cv.json";
import { validateAndFilterVariantOutput, validateVariantOutput } from "./variant-validation";

const snapshot = fixture.snapshot as VariantSnapshot;

it.each([
	"The evidence selection omitted 187 of 210 CV passages, so the comparison is limited to the supplied passages.",
	"The comparison used the supplied CV passages. The evidence selection reports 187 omitted passages.",
])("grounds a real evidence-selection note in task metadata: %s", (note) => {
	expect(() => validateVariantOutput(snapshot, { ...fixture.outputs[0], notes: [note] })).not.toThrow();
});

it.each([
	"The candidate led 187 teams.",
	"The evidence selection omitted 187 passages. The candidate used SAP.",
	"The evidence selection omitted 999 of 210 CV passages.",
])("does not let context counts authorize candidate claims or false counts: %s", (note) => {
	expect(() => validateVariantOutput(snapshot, { requirements: [], notes: [note] })).toThrow("AI_UNSUPPORTED_CLAIM");
});

it.each(fixture.outputs)(
	"accepts real long-CV evidence explanations without treating reporting grammar as career facts",
	(output) => {
		expect(() => validateVariantOutput(snapshot, output)).not.toThrow();
	},
);

it.each([
	"The CV describes SAP expertise.",
	"The CV describes a 99% improvement.",
	"The CV describes being an engineer.",
])("still rejects unsupported candidate facts behind the reporting prefix: %s", (explanation) => {
	const requirement = fixture.outputs[0]?.requirements[1];
	expect(() => validateVariantOutput(snapshot, { requirements: [{ ...requirement, explanation }], notes: [] })).toThrow(
		"AI_UNSUPPORTED_CLAIM",
	);
});

it("rejects an invented evidence-selection count", () => {
	expect(() =>
		validateVariantOutput(snapshot, {
			requirements: [],
			notes: ["The comparison used the supplied CV passages; 999 passages were omitted from the evidence selection."],
		}),
	).toThrow("AI_UNSUPPORTED_CLAIM");
});

it("does not let a negative job reference authorize an invented tool", () => {
	const requirement = fixture.outputs[0]?.requirements[1];
	expect(() =>
		validateVariantOutput(snapshot, {
			requirements: [
				{
					...requirement,
					verdict: "partial",
					explanation: "The CV describes a metrics dashboard, but does not explicitly describe SAP expertise.",
				},
			],
			notes: [],
		}),
	).toThrow("AI_UNSUPPORTED_CLAIM");
});

it("accepts cross-language job-evidence explanations and notes while still blocking invented numbers or tools", () => {
	const crossLangSnapshot: VariantSnapshot = {
		category: "job-evidence",
		resumeId: "cv-en",
		sourceRevision: "2026-11-22T06:00:00.000Z",
		cv: [
			{
				id: "cv-1",
				section: "experience",
				text: "Designed weekly quality reports using operational data, reducing preparation time by 15% across 8 teams.",
			},
		],
		jobAd: {
			segments: [{ id: "job-1", text: "مطلوب إعداد تقارير جودة أسبوعية وتحسين العمليات." }],
		},
		evidenceSelection: { totalPassages: 210, omittedPassages: 114, excerptedPassageIds: [] },
	};
	const validCrossLang = {
		requirements: [
			{
				id: "req-1",
				spanIds: ["job-1"],
				importance: "essential" as const,
				verdict: "supported" as const,
				evidenceIds: ["cv-1"],
				explanation: "توضح السيرة تصميم تقارير جودة أسبوعية باستخدام البيانات التشغيلية بنسبة 15% مع 8 فرق.",
			},
		],
		notes: ["المقارنة مبنية على المقاطع المختارة فقط؛ حُذفت 114 فقرة من إجمالي 210 مقاطع."],
	};
	expect(() => validateAndFilterVariantOutput(crossLangSnapshot, validCrossLang)).not.toThrow();

	const firstReq = validCrossLang.requirements[0];
	if (!firstReq) throw new Error("Expected requirement");
	const inventedNumber = {
		...validCrossLang,
		requirements: [
			{
				...firstReq,
				explanation: "توضح السيرة تصميم تقارير جودة أسبوعية بنسبة 40% مع 8 فرق.",
			},
		],
	};
	expect(() => validateAndFilterVariantOutput(crossLangSnapshot, inventedNumber)).toThrow("AI_UNSUPPORTED_CLAIM");

	const inventedTool = {
		...validCrossLang,
		requirements: [
			{
				...firstReq,
				explanation: "توضح السيرة استخدام SAP لتصميم تقارير جودة أسبوعية.",
			},
		],
	};
	expect(() => validateAndFilterVariantOutput(crossLangSnapshot, inventedTool)).toThrow("AI_UNSUPPORTED_CLAIM");
});
