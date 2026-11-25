import { expect, it } from "vite-plus/test";
import { planTranslationBatches, mergeTranslationBatches } from "@reactive-resume/api/features/ai/translation-batches";
import { buildVariantWriterPayload } from "@reactive-resume/api/features/ai/variant-contracts";
import { buildVariantVerificationPayload } from "@reactive-resume/api/features/ai/variant-verifier";
import { buildTranslationInventory } from "@reactive-resume/resume/translation";
import { createDemoResume } from "./demo-resume";
const budget = { maxInputCodePoints: 32000, maxOutputTokens: 4096 };
it("partitions the actual 45k-character Arabic demo into bounded writer and verifier calls", () => {
	const data = createDemoResume(true);
	expect(JSON.stringify(data).length).toBeGreaterThan(44000);
	expect(JSON.stringify(data).length).toBeLessThan(46000);
	const inventory = buildTranslationInventory(data);
	const full = {
		category: "translation" as const,
		resumeId: "copy",
		sourceRevision: "revision",
		jobAd: null,
		direction: "ar-en" as const,
		cv: inventory.segments.map((segment) => ({
			id: segment.id,
			section: segment.target.sectionId,
			text: segment.text,
		})),
	};
	const plan = planTranslationBatches(full, budget);
	expect(inventory.segments).toHaveLength(450);
	expect(plan.batches).toHaveLength(25);
	const outputs = plan.batches.map((batch) => ({
		direction: "ar-en" as const,
		sourceRevision: full.sourceRevision,
		segments: batch.cv.map((fact) => ({
			sourceId: fact.id,
			text: fact.text,
			claims: [{ id: "c", text: fact.text, evidenceIds: [fact.id], kind: "translation" as const }],
		})),
		notes: [],
	}));
	for (const [index, batch] of plan.batches.entries()) {
		expect([...JSON.stringify(buildVariantWriterPayload(batch))].length).toBeLessThanOrEqual(budget.maxInputCodePoints);
		expect([...JSON.stringify(buildVariantVerificationPayload(batch, outputs[index]))].length).toBeLessThanOrEqual(
			12000,
		);
		expect(JSON.stringify(outputs[index]).length / 4).toBeLessThanOrEqual(1200);
	}
	const merged = mergeTranslationBatches(full, plan, outputs);
	expect(merged.segments.map((segment) => ({ id: segment.sourceId, text: segment.text }))).toEqual(
		full.cv.map(({ id, text }) => ({ id, text })),
	);
});
