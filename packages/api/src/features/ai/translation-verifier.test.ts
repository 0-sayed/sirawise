import type { ProtectedTranslation } from "./translation-invariants";
import { describe, expect, it } from "vite-plus/test";
import { translationCandidateSchema, translationOutputSchema } from "@reactive-resume/schema/resume/variant-outputs";
import {
	adaptVerifiedTranslation,
	assertTranslationCheck,
	buildTranslationCheck,
	buildTranslationVerifierSchema,
	planCompactTranslationChecks,
	translationVerifierCheckSchema,
} from "./translation-verifier";
import { validateCompactTranslationDelivery } from "./variant-validation";

const prepared: ProtectedTranslation = {
	maskedSegments: [
		{ id: "a", section: "summary", text: "Documented QA." },
		{ id: "b", section: "experience", text: "Supported the lead." },
	],
	localMap: new Map(),
	assertions: [],
};
const candidate = translationCandidateSchema.parse({
	direction: "en-ar",
	sourceRevision: "1",
	segments: [
		{ sourceId: "a", text: "وثقت الاختبارات." },
		{ sourceId: "b", text: "قدت الفريق." },
	],
});
const clean = {
	schemaVersion: 1,
	batchId: "part-1",
	checkedSourceIds: ["a", "b"],
	supportedSourceIds: ["a", "b"],
	issues: [],
};

describe("compact translation verification", () => {
	it("keeps checks for multiple substantive translations small even under the wire byte limit", () => {
		const maskedSegments = Array.from({ length: 6 }, (_, index) => ({
			id: String(index),
			section: "experience",
			text: "Automated deployment review, tracked production issues, and coordinated fixes across three teams.",
		}));
		const segments = maskedSegments.map(({ id }) => ({
			sourceId: id,
			text: "أتمت مراجعة النشر، وتابع مشكلات الإنتاج، ونسّق الإصلاحات بين ثلاثة فرق.",
		}));
		const batches = planCompactTranslationChecks({ ...prepared, maskedSegments }, { ...candidate, segments }, "part-8");
		expect(batches.length).toBeGreaterThan(1);
		expect(batches.flatMap(({ itemIds }) => itemIds)).toEqual(maskedSegments.map(({ id }) => id));
		for (const { payload } of batches) expect(buildTranslationVerifierSchema(payload)).toBeDefined();
	});

	it("writes translated text once", () => {
		const payload = JSON.stringify(buildTranslationCheck(prepared, candidate, "part-1"));
		expect(payload.split("وثقت الاختبارات.")).toHaveLength(2);
		expect(payload).toContain("Documented QA.");
		expect(translationCandidateSchema.safeParse({ ...candidate, notes: ["Invented degree"] }).success).toBe(false);
		const check = assertTranslationCheck(candidate, "part-1", {
			...clean,
			supportedSourceIds: ["a"],
			issues: [{ sourceIds: ["b"], code: "responsibility" }],
		});
		const adapted = adaptVerifiedTranslation(prepared, candidate, check, []);
		expect(adapted.withheldIds).toEqual(["b"]);
		expect(translationOutputSchema.parse(adapted.output)).toMatchObject({
			notes: [],
			segments: [
				{ sourceId: "a", text: "وثقت الاختبارات." },
				{ sourceId: "b", text: "Supported the lead.", claims: [] },
			],
		});
	});

	it.each([[undefined], [[]], [["a"]]] as const)(
		"withholds segments without explicit support (%j)",
		(supportedSourceIds) => {
			const check = assertTranslationCheck(candidate, "part-1", { ...clean, supportedSourceIds });
			const adapted = adaptVerifiedTranslation(prepared, candidate, check, []);
			expect(adapted.withheldIds).toEqual(supportedSourceIds?.length ? ["b"] : ["a", "b"]);
			expect(adapted.unverifiedIds).toEqual(adapted.withheldIds);
			expect(adapted.output.segments.filter(({ claims }) => claims.length).map(({ sourceId }) => sourceId)).toEqual(
				supportedSourceIds ?? [],
			);
		},
	);

	it("requires complete exception-check coverage", () => {
		expect(assertTranslationCheck(candidate, "part-1", clean)).toEqual(clean);
		for (const verdict of [
			{ ...clean, checkedSourceIds: [] },
			{ ...clean, checkedSourceIds: ["a", "a"] },
			{ ...clean, checkedSourceIds: ["a", "other"] },
			{ ...clean, batchId: "part-2" },
			{ ...clean, issues: [{ sourceIds: ["other"], code: "addition" }] },
			{ ...clean, issues: [{ sourceIds: ["b"], code: "addition", reason: "Invented note" }] },
		])
			expect(() => assertTranslationCheck(candidate, "part-1", verdict)).toThrow();
	});

	it("requires a separate language assessment on new responses and keeps factual decisions independent", () => {
		expect(translationVerifierCheckSchema.safeParse(clean).success).toBe(false);
		const assessment = { status: "unclear", reason: "Language quality unavailable." };
		const response = translationVerifierCheckSchema.parse({
			...clean,
			supportedSourceIds: ["a"],
			quality: assessment,
			issues: [{ sourceIds: ["b"], code: "responsibility" }],
		});
		const check = assertTranslationCheck(candidate, "part-1", response);
		expect(adaptVerifiedTranslation(prepared, candidate, check, []).withheldIds).toEqual(["b"]);
	});

	it("validates delivery against the bound source slots and server-owned claims", () => {
		const snapshot = {
			category: "translation" as const,
			direction: candidate.direction,
			resumeId: "synthetic",
			sourceRevision: candidate.sourceRevision,
			jobAd: null,
			cv: [...prepared.maskedSegments],
		};
		const verdict = assertTranslationCheck(candidate, "part-1", {
			...clean,
			supportedSourceIds: ["a"],
			issues: [{ sourceIds: ["b"], code: "addition" }],
		});
		const { output } = adaptVerifiedTranslation(prepared, candidate, verdict, []);
		expect(validateCompactTranslationDelivery(snapshot, output).output).toEqual(output);
		const [kept, withheld] = output.segments;
		if (!kept || !withheld) throw new Error("Missing fixture segments");
		for (const corrupt of [
			{ ...output, segments: [kept] },
			{ ...output, notes: ["Invented qualification"] },
			{ ...output, segments: [kept, { ...withheld, text: "Invented role" }] },
			{
				...output,
				segments: [
					{ ...kept, claims: [{ id: "verified", text: kept.text, kind: "translation", evidenceIds: ["b"] }] },
					withheld,
				],
			},
		])
			expect(() => validateCompactTranslationDelivery(snapshot, corrupt)).toThrow("AI_SOURCE_BINDING");
	});
});

it("withholds an omitted decision and still rejects duplicate or conflicting decisions", () => {
	const schema = buildTranslationVerifierSchema(buildTranslationCheck(prepared, candidate, "part-1"));
	const complete = {
		...clean,
		supportedSourceIds: ["a"],
		issues: [{ sourceIds: ["b"], code: "responsibility" }],
		quality: { status: "appropriate", reason: '{"mqm":[]}' },
	};
	expect(schema.safeParse(complete).success).toBe(true);
	const omitted = schema.parse({ ...complete, issues: [] });
	const check = assertTranslationCheck(candidate, "part-1", omitted);
	expect(adaptVerifiedTranslation(prepared, candidate, check, []).unverifiedIds).toEqual(["b"]);
	for (const invalid of [
		{ ...complete, supportedSourceIds: ["a", "b"] },
		{ ...complete, checkedSourceIds: ["a", "a"] },
		{ ...complete, issues: [...complete.issues, { sourceIds: ["b"], code: "addition" }] },
	])
		expect(() => assertTranslationCheck(candidate, "part-1", schema.parse(invalid))).toThrow(
			"AI_VERIFICATION_INCOMPLETE",
		);
});
