import { expect, it } from "vite-plus/test";
import {
	bindVerificationPass,
	createVerificationJournal,
	makeVerificationCall,
	recoverVerificationPass,
	verificationPassCostLimit,
	verificationPassIncurred,
	verificationPassVerdicts,
} from "./verification-journal";

const testPayload = (text: string) => ({ selections: [{ section: "summary" as const, text }] });

it("requires the latest response for every batch, including a retried batch", () => {
	const valid = { batchIndex: 0, outcome: "valid", output: { verdict: "supported" }, costMicros: 10 };
	const output = { _verifyBatchTotal: 2, _verifyCalls: [valid] };
	expect(() => verificationPassVerdicts(output)).toThrow("AI_VERIFICATION_REQUIRED");
	const complete = { ...output, _verifyCalls: [valid, { ...valid, batchIndex: 1 }] };
	expect(verificationPassVerdicts(complete)).toEqual([{ verdict: "supported" }, { verdict: "supported" }]);
	expect(() =>
		verificationPassVerdicts({
			...complete,
			_verifyCalls: [...complete._verifyCalls, { ...valid, outcome: "pending" }],
		}),
	).toThrow("AI_VERIFICATION_REQUIRED");
	expect(verificationPassCostLimit(complete, 100)).toBe(200);
	expect(verificationPassCostLimit({ ...output, _verifyCalls: [{ ...valid, costMicros: 101 }] }, 100)).toBe(0);
});

it("recovers measured verdicts, unsent batches and unresolved dispatches from the same pass", () => {
	const binding = bindVerificationPass(
		3,
		{ text: "regenerated" },
		["a", "b", "c"].map((id) => ({ itemIds: [id], payload: testPayload(id) })),
	);
	const [checked, issued, unsent] = binding.batchKeys;
	if (!checked || !issued || !unsent) throw new Error("Expected three batches");
	const journal = createVerificationJournal(binding, [
		{ ...makeVerificationCall(checked, 0, 100), outcome: "valid", output: { verdict: "supported" }, costMicros: 10 },
		makeVerificationCall(issued, 0, 150),
	]);
	expect(recoverVerificationPass(journal, binding)).toEqual({
		remainingBatchKeys: [unsent],
		verdictsByBatchKey: new Map([[checked, { verdict: "supported" }]]),
		unknownBatchKeys: [issued],
		unknownMicros: 150,
	});
	expect(() => recoverVerificationPass(journal, { ...binding, generationOrdinal: 1 })).toThrow(
		"AI_VERIFICATION_REQUIRED",
	);
	expect(() => verificationPassVerdicts(journal, binding)).toThrow("AI_VERIFICATION_REQUIRED");
});

it("binds ordered payloads and IDs to an immutable writer result", () => {
	const output = { b: 2, a: { z: "value", y: 1 } };
	const batch = { itemIds: ["a", "b"], payload: testPayload("selected text") };
	const binding = bindVerificationPass(1, output, [batch]);
	expect(bindVerificationPass(1, { a: { y: 1, z: "value" }, b: 2 }, [batch])).toEqual(binding);
	expect(bindVerificationPass(3, { ...output, b: 3 }, [batch])).toMatchObject({ generationOrdinal: 3 });
	expect(bindVerificationPass(3, { ...output, b: 3 }, [batch]).candidateSha256).not.toBe(binding.candidateSha256);
	expect(bindVerificationPass(1, output, [{ ...batch, itemIds: ["b", "a"] }]).batchKeys).not.toEqual(binding.batchKeys);
	expect(bindVerificationPass(1, output, [{ ...batch, payload: testPayload("changed") }]).batchPlanSha256).not.toBe(
		binding.batchPlanSha256,
	);
});

it("holds the recorded bound only for issued calls with unknown cost", () => {
	const binding = bindVerificationPass(
		1,
		{},
		["a", "b", "c"].map((id) => ({ itemIds: [id], payload: testPayload(id) })),
	);
	const [knownKey, pendingKey] = binding.batchKeys;
	if (!knownKey || !pendingKey) throw new Error("Expected the planned batch keys");
	const known = {
		...makeVerificationCall(knownKey, 0, 20_000),
		outcome: "valid" as const,
		output: {},
		costMicros: 1000,
	};
	const pending = makeVerificationCall(pendingKey, 0, 30_000);
	const output = createVerificationJournal(binding, [known, pending]);
	expect(verificationPassCostLimit(output, 10_000)).toBe(50_000);
	expect(verificationPassIncurred(output, 10_000)).toBe(31_000);
	expect(verificationPassIncurred(createVerificationJournal(binding, []), 100_000)).toBe(0);
});

it("withholds only exhausted truncated batches and retains liability for unknown prices", () => {
	const binding = bindVerificationPass(
		1,
		{},
		["a", "b"].map((id) => ({ itemIds: [id], payload: testPayload(id) })),
	);
	const [checked, truncated] = binding.batchKeys;
	if (!checked || !truncated) throw new Error("Missing batch");
	const first = {
		...makeVerificationCall(checked, 0, 100),
		outcome: "valid" as const,
		output: { verdict: "supported" },
		costMicros: 10,
	};
	const second = { ...makeVerificationCall(truncated, 0, 100), outcome: "truncated" as const, costMicros: 50 };
	const retry = { ...makeVerificationCall(truncated, 1, 100), outcome: "truncated" as const, costMicros: 30 };
	const journal = createVerificationJournal(binding, [first, second, retry]);
	expect(() => verificationPassVerdicts(journal, binding)).toThrow("AI_VERIFICATION_REQUIRED");
	expect(verificationPassVerdicts(journal, binding, true)).toEqual([{ verdict: "supported" }, {}]);
	expect(verificationPassIncurred(journal, 100)).toBe(90);
	const allTruncated = createVerificationJournal(binding, [{ ...first, outcome: "truncated", output: null }, second]);
	expect(() => verificationPassVerdicts(allTruncated, binding, true)).toThrow("AI_VERIFICATION_FAILED");
	const unknownCost = createVerificationJournal(binding, [first, { ...second, costMicros: null }, retry]);
	expect(verificationPassVerdicts(unknownCost, binding, true)).toEqual([{ verdict: "supported" }, {}]);
	expect(verificationPassIncurred(unknownCost, 100)).toBe(140);
	const unconfirmed = createVerificationJournal(binding, [first, { ...second, outcome: "unknown", costMicros: null }]);
	expect(() => verificationPassVerdicts(unconfirmed, binding, true)).toThrow("AI_VERIFICATION_REQUIRED");
});
