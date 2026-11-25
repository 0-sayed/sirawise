import type { VariantSnapshot } from "./variant-types";
import { expect, it } from "vite-plus/test";
import { defaultResumeData } from "@reactive-resume/schema/resume/default";
import cases from "./testing/fixtures/verifier-holdout.json";
import { planTranslationBatches } from "./translation-batches";
import { prepareTranslationFacts } from "./translation-invariants";
import { jobEvidenceCandidateContract, translationCandidateContract } from "./variant-contracts";
import { prepareCompactTranslationVerification } from "./variant-handlers";
import {
	buildVariantVerifierSchema,
	filterVariantVerification,
	planVariantVerificationBatches,
	variantVerificationInventory,
} from "./variant-verifier";

const limits = { maxInputCodePoints: 32_000, maxOutputTokens: 4096 };

it.each(cases.filter(({ type }) => type === "job"))(
	"enforces absence scope for $id even after a positive verdict",
	(fixture) => {
		if (!fixture.selected || !fixture.additional || !fixture.candidate) throw new Error("Incomplete job fixture");
		const snapshot: VariantSnapshot = {
			category: "job-evidence",
			resumeId: "synthetic",
			sourceRevision: "1",
			cv: [{ id: "source", section: "experience", text: fixture.selected }],
			jobAd: { segments: [{ id: "job", text: "Map the applicant's work experience to the role." }] },
			evidenceSelection: { totalPassages: 2, omittedPassages: 1, excerptedPassageIds: [] },
			jobEvidenceContract: limits,
		};
		const output = {
			requirements: [
				{
					id: fixture.id,
					spanIds: ["job"],
					importance: "unstated",
					verdict: "unclear",
					evidenceIds: [],
					explanation: fixture.candidate,
				},
			],
			notes: [],
		};
		const [batch] = planVariantVerificationBatches(snapshot, output).batches;
		if (!batch) throw new Error("Missing job verification batch");
		expect(JSON.stringify(batch.payload)).not.toContain("absence_scope");
		expect(JSON.stringify(batch.payload)).not.toContain(fixture.additional);
		expect(jobEvidenceCandidateContract.verifierPrompt).not.toContain(fixture.candidate);
		const inventory = variantVerificationInventory(batch.snapshot, batch.output);
		const positive = {
			schemaVersion: 2,
			verdicts: [],
			absence: [],
			premises: inventory.premises.map(({ id }) => ({
				id,
				verdict: "supported",
				issueClass: null,
				reason: "Checked.",
			})),
			retention: null,
			coverage: { status: "complete", reason: "Checked." },
			quality: { status: "appropriate", reason: "Checked." },
		};
		expect(buildVariantVerifierSchema(batch.payload).safeParse(positive).success).toBe(true);
		const result = filterVariantVerification(batch.snapshot, batch.output, positive, { allowEmptyJobBatch: true });
		if (fixture.expected === "confirmed_absent") expect(result.output).toEqual(output);
		else expect(result.withheld?.items).toMatchObject([{ id: fixture.id, reason: "absence_scope" }]);
	},
);

it.each(cases.filter(({ type }) => type === "translation"))("keeps dates and binds the verdict to $id", (fixture) => {
	if (!fixture.source || !fixture.target) throw new Error("Incomplete translation fixture");
	const source = [{ id: fixture.id, section: "summary", text: fixture.source }];
	const target = { sectionId: "summary", field: "content" } as const;
	const protection = prepareTranslationFacts(
		defaultResumeData,
		source.map((segment) => ({ ...segment, source: segment.text, target, official: false })),
	);
	const direction = fixture.locale === "ar" ? "ar-en" : "en-ar";
	const candidate = { direction, sourceRevision: "1", segments: [{ sourceId: fixture.id, text: fixture.target }] };
	const snapshot: VariantSnapshot = {
		category: "translation",
		resumeId: "synthetic",
		sourceRevision: "1",
		direction,
		jobAd: null,
		cv: [...protection.maskedSegments],
		translationProtection: protection,
	};
	const result = prepareCompactTranslationVerification(snapshot, candidate, "part-1");
	expect(result.keptIds).toEqual([fixture.id]);
	expect(translationCandidateContract.verifierPrompt).not.toContain(fixture.source);
	const verdict = {
		schemaVersion: 1,
		batchId: "part-1",
		checkedSourceIds: [fixture.id],
		supportedSourceIds: fixture.expected ? [] : [fixture.id],
		issues: fixture.expected ? [{ sourceIds: [fixture.id], code: "credential" }] : [],
		quality: { status: "appropriate", reason: '{"mqm":[]}' },
	};
	expect(result.finishBatches([verdict]).withheldIds).toEqual(fixture.expected ? [fixture.id] : []);
});

it("bounds new compact translation parts by pair count and preserves the complete source", () => {
	const cv = Array.from({ length: 36 }, (_, index) => ({
		id: `source-${index}`,
		section: "experience",
		text: "Reviewed incident reports and sent the weekly update.",
	}));
	const snapshot: VariantSnapshot = {
		category: "translation",
		resumeId: "synthetic",
		sourceRevision: "1",
		direction: "en-ar",
		jobAd: null,
		cv,
		translationProtection: { maskedSegments: cv, localMap: new Map(), assertions: [] },
	};
	const plan = planTranslationBatches(snapshot, limits);
	expect(Math.max(...plan.batches.map((part) => part.cv.length))).toBeLessThanOrEqual(6);
	expect(plan.batches.flatMap((part) => part.cv.map(({ text }) => text))).toEqual(cv.map(({ text }) => text));

	// An already admitted part keeps its writer boundaries and uses smaller verifier batches.
	const candidate = {
		direction: "en-ar",
		sourceRevision: "1",
		segments: cv.map(({ id }) => ({ sourceId: id, text: "راجعت تقارير الحوادث وأرسلت التحديث الأسبوعي." })),
	};
	const verification = prepareCompactTranslationVerification(snapshot, candidate, "part-1");
	expect(verification.batches.map(({ itemIds }) => itemIds.length)).toEqual([6, 6, 6, 6, 6, 6]);
	const verdicts = verification.batches.map(({ batchId, itemIds }) => ({
		schemaVersion: 1,
		batchId,
		checkedSourceIds: itemIds,
		supportedSourceIds: itemIds,
		issues: [],
		quality: { status: "appropriate", reason: '{"mqm":[]}' },
	}));
	expect(verification.finishBatches(verdicts).withheldIds).toEqual([]);
	expect(() => verification.finishBatches(verdicts.slice(1))).toThrow("AI_VERIFICATION_REQUIRED");
	expect(() => verification.finishBatches(verdicts.toReversed())).toThrow();
});
