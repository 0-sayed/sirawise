import type { VariantSnapshot } from "./variant-types";
import { expect, it } from "vite-plus/test";
import fixture from "./testing/fixtures/job-evidence-selected-passages.json";
import { validateAndFilterVariantOutput, validateVariantOutput } from "./variant-validation";

const snapshot = fixture.snapshot as VariantSnapshot;
it.each(fixture.outputs.flatMap((output, index) => output.requirements.map((requirement) => ({ index, requirement }))))(
	"accepts the captured explanation $index / $requirement.id",
	({ requirement }) => {
		expect(() => validateVariantOutput(snapshot, { requirements: [requirement], notes: [] })).not.toThrow();
	},
);
it.each(fixture.outputs)("accepts a complete real writer response", (output) => {
	expect(() => validateVariantOutput(snapshot, output)).not.toThrow();
});

it("keeps the captured honest Arabic explanations on the candidate contract", () => {
	const output = fixture.outputs[0];
	if (!output) throw new Error("Missing captured response");
	const expected = ["req-06", "req-09", "req-12"];
	const candidate = { requirements: output.requirements.filter(({ id }) => expected.includes(id)), notes: [] };
	const scoped = { ...snapshot, jobEvidenceContract: { maxInputCodePoints: 32_000, maxOutputTokens: 4096 } };
	const result = validateAndFilterVariantOutput(scoped, candidate);
	if (result.kind !== "review.job-evidence") throw new Error("Expected job evidence");
	expect(result.output.requirements.map(({ id }) => id)).toEqual(expected);
	expect(result.withheld).toBeUndefined();
	expect(() => validateVariantOutput(scoped, candidate)).not.toThrow();
});

it("grounds section-reporting prose without inventing a role or metric", async () => {
	const { assertHardFacts } = await import("./hard-facts");
	const requirement = fixture.outputs[1]?.requirements.find((entry) => entry.id === "req-10");
	if (!requirement) throw new Error("Missing captured requirement");
	const evidence = snapshot.cv
		.filter((entry) => requirement.evidenceIds.includes(entry.id))
		.map((entry) => entry.text)
		.join("\n");
	assertHardFacts("", requirement.explanation, evidence);
});

it.each([
	"The selected passages do not establish SAP expertise.",
	"The selected passages do not establish handover coordination. The candidate used SAP.",
	"The candidate reduced preparation time by 99%. The selected passages do not establish handover coordination.",
	"The selected passages do not establish handover coordination. The candidate was an engineer.",
])("keeps fabricated facts and unsupported job references blocked: %s", (explanation) => {
	const requirement = fixture.outputs[0]?.requirements.find((entry) => entry.id === "req-03");
	if (!requirement) throw new Error("Missing captured requirement");
	expect(() => validateVariantOutput(snapshot, { requirements: [{ ...requirement, explanation }], notes: [] })).toThrow(
		"AI_UNSUPPORTED_CLAIM",
	);
});
