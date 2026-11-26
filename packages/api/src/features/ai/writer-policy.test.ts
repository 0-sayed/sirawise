import { expect, it } from "vite-plus/test";
import { syntheticReviewRuntime } from "./testing/runtime";
import { resolveWriterRoute } from "./writer-policy";
const route = syntheticReviewRuntime.routes[0];
if (!route || !route.verifier) throw new Error("Missing synthetic route");
const verifier = route.verifier;
it("narrows the writer without shrinking the implicit verifier cap", () => {
	const selected = resolveWriterRoute(
		{ ...route, maxOutputTokens: 8192 },
		{ kind: "review.job-evidence", parameters: {} },
	);
	expect(selected.maxOutputTokens).toBe(4096);
	expect(selected.verifier?.maxOutputTokens).toBe(8192);
});
it("preserves an explicit verifier cap", () => {
	const selected = resolveWriterRoute(
		{ ...route, maxOutputTokens: 8192, verifier: { ...verifier, maxOutputTokens: 12288 } },
		{ kind: "review.job-evidence", parameters: {} },
	);
	expect(selected.maxOutputTokens).toBe(4096);
	expect(selected.verifier?.maxOutputTokens).toBe(12288);
});

it.each(["review.job-evidence", "review.tailoring", "review.translation"])(
	"keeps %s inside the approved writer and spend limits",
	(kind) => {
		const approved = { ...route, maxOutputTokens: 1024, maxCalls: 2 as const };
		const selected = resolveWriterRoute(approved, { kind, parameters: {} });
		expect(selected.maxOutputTokens).toBe(1024);
		expect(selected.maxCalls).toBe(2);
		expect(selected.maxInputCodePoints).toBe(approved.maxInputCodePoints);
		expect(selected.requestCapMicros).toBe(approved.requestCapMicros);
		expect(selected.maxCallCostMicros).toBe(approved.maxCallCostMicros);
	},
);

it("gives measured tailoring two 90-second calls and time for a retry", () => {
	const selected = resolveWriterRoute(
		{ ...route, extendJobAndTranslationTiming: true, callTimeoutMs: 60_000, deadlineMs: 120_000 },
		{ kind: "review.tailoring", parameters: {} },
	);
	expect(selected.callTimeoutMs).toBe(90_000);
	expect(selected.deadlineMs).toBe(240_000);
});

it("gives measured translation parts a longer execution window without extending each call", () => {
	const selected = resolveWriterRoute(
		{ ...route, extendJobAndTranslationTiming: true, callTimeoutMs: 60_000, deadlineMs: 120_000 },
		{ kind: "review.translation", parameters: {} },
	);
	expect(selected.callTimeoutMs).toBe(90_000);
	expect(selected.deadlineMs).toBeGreaterThan(240_000);
});
