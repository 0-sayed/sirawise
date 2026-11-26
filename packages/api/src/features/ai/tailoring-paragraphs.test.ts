import { expect, it } from "vite-plus/test";
import { blockText } from "@reactive-resume/resume/proposals";
import { tailoringOutputSchema } from "@reactive-resume/schema/resume/variant-outputs";
import fixture from "./testing/fixtures/tailoring-paragraphs.json";
import { assertPatchRetention } from "./variant-guard";

const patches = tailoringOutputSchema.shape.patches.parse(fixture.patches);

it.each(patches)("retains real career facts when tailoring reorders rich-text paragraphs", (patch) => {
	const source = blockText(fixture.html);
	expect(source).toContain("director. Analyzed");
	expect(() =>
		assertPatchRetention({ category: "tailoring", cv: [], jobAd: null }, source, patch.claims, source),
	).not.toThrow();
});
