import { createHash } from "node:crypto";
import { expect, it } from "vite-plus/test";
import { loadModels } from "../config";
import { cases } from "../corpus";
import { runBenchmark } from "../runner";
import { smokeCases } from "../study";

it("core categories produce the expected offline receipt with the current contracts", async () => {
	const raw: unknown[] = [];
	const artifact = await runBenchmark({
		models: loadModels(),
		cases: smokeCases(cases),
		phase: "smoke",
		runs: 1,
		fake: true,
		budgetUsd: 100,
		openaiBudgetUsd: 100,
		sessionConcurrency: 1,
		onRaw: async ({ latencyMs: _latencyMs, ...record }) => {
			raw.push(record);
		},
	});
	expect(artifact.stopReason).toBeNull();
	expect(artifact.calls).toHaveLength(132);
	const calls = artifact.calls.map(({ id: _id, latencyMs: _latencyMs, ...call }) => call);
	// Judgment receipts now include timings too. Keep all receipt fields except elapsed time.
	const hash = createHash("sha256")
		.update(JSON.stringify({ raw, calls }, (key, value) => (key === "latencyMs" ? undefined : value)))
		.digest("hex");
	// Current wording and extraction contracts change the bytes and reservations.
	// Historical approvals stay bound to their original freeze and receipts.
	expect(hash).toBe("ad7646477ab27c069b1e8dd2b4e0cb122778a1814b2311baf7572d56a9ef47c1");
});
