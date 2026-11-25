import type { VariantSnapshot } from "./variant-types";
import { expect, it } from "vite-plus/test";
import { zodSchema } from "ai";
import job from "./testing/fixtures/job-evidence-redundant-verdicts.json";
import tailoring from "./testing/fixtures/tailoring-redundant-verdicts.json";
import { variantReviewHandlers } from "./variant-handlers";
import { assertVariantVerification, buildVariantVerificationPayload } from "./variant-verifier";

it("rejects the captured tailoring checker response with extra claim IDs", () => {
	expect(() =>
		assertVariantVerification(tailoring.snapshot as VariantSnapshot, tailoring.output, tailoring.verdict),
	).toThrow("AI_VERIFICATION_INCOMPLETE");
});

it.each([job, tailoring])(
	"constrains checker IDs and counts in the actual structured output contract",
	async (fixture) => {
		const snapshot = fixture.snapshot as VariantSnapshot;
		const handler = variantReviewHandlers[`review.${snapshot.category}`];
		const payload = buildVariantVerificationPayload(snapshot, fixture.output);
		const schema = handler.verifier?.outputForPayload?.(payload) ?? handler.verifier?.output;
		if (!schema) throw new Error("Missing verifier schema");
		const raw = "verdict" in fixture ? fixture.verdict : fixture.verdicts[0];
		if (!raw) throw new Error("Missing captured verdict");
		// Both real checkers added premise IDs to verdicts. The provider contract must forbid this.
		expect(schema.safeParse(raw).success).toBe(false);
		const task = JSON.parse(
			payload.selections.find((entry) => "id" in entry && entry.id === "variant-verification-task")?.text ?? "null",
		);
		const correct = {
			...raw,
			verdicts: raw.verdicts.filter((entry) => task.claims.some((claim: { id: string }) => claim.id === entry.claimId)),
		};
		expect(schema.safeParse(correct).success).toBe(true);
		expect(schema.safeParse({ ...correct, verdicts: correct.verdicts.slice(1) }).success).toBe(false);
		expect(
			schema.safeParse({
				...correct,
				premises: correct.premises.map((entry) => ({ ...entry, id: `premise:${entry.id}` })),
			}).success,
		).toBe(false);
		const wire = await zodSchema(schema).jsonSchema;
		expect(JSON.stringify(wire)).toContain('"enum"');
	},
);
