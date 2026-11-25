import type { CaseReceipt, QualificationManifest, QualificationReceipts, SafetyExpected } from "./types";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vite-plus/test";
import { loadQualificationBatch, runQualification } from "./cli";
import { scorePipelineSafety, sha256 } from "./run";

vi.mock("node:child_process", () => ({
	execFileSync: () => "tooling/evaluations/review/pipeline-safety/expected/translation.json\0",
}));

it("loads a runtime batch without offline labels in its artifacts or executable digest", async () => {
	const directory = await mkdtemp(join(tmpdir(), "qualification-batch-"));
	const path = join(directory, "batch.manifest.json");
	const fixtures = [{ id: "synthetic-case" }];
	const fixtureBytes = JSON.stringify(fixtures);
	const buildSha256 = sha256("[]");
	const manifest = {
		version: 1,
		fixtureIdentifierSeed: "a".repeat(64),
		maxRunMicros: 2500000,
		buildSha256,
		implementationSha256: buildSha256,
		executables: [],
		fixturesSha256: sha256(fixtureBytes),
		expectedSha256: sha256("offline labels"),
	};
	await writeFile(path, JSON.stringify(manifest));
	await writeFile(join(directory, "batch.fixtures.json"), fixtureBytes);
	await expect(loadQualificationBatch(path)).resolves.toMatchObject({ fixtures, manifest });
});

it.each([200, 404, 409])("records a suite refusal and continues after case HTTP %i", async (status) => {
	const directory = await mkdtemp(join(tmpdir(), "qualification-refusal-"));
	const path = join(directory, "batch.manifest.json");
	const output = join(directory, "batch.receipts.json");
	const ids = ["refusal", "translation-next", "job", "extraction"];
	const inputSha256 = sha256("synthetic input");
	const planned = (id: string) => ({
		id,
		inputSha256,
		logicalInputSha256: inputSha256,
		writerModel: "synthetic-writer",
		batches: [],
	});
	const expected: SafetyExpected[] = ids.map((id) => ({ id, mode: "deterministic", caught: [], retainedIds: [] }));
	const buildSha256 = sha256("[]");
	const routeSha256 = sha256("synthetic route");
	const manifest: QualificationManifest = {
		version: 1,
		campaignId: "synthetic",
		fixtureIdentifierSeed: "a".repeat(64),
		maxRunMicros: 2500000,
		buildSha256,
		implementationSha256: buildSha256,
		executables: [],
		fixturesSha256: sha256("[]"),
		expectedSha256: sha256(JSON.stringify(expected)),
		routes: [
			{
				feature: "translation",
				endpointSlot: "primary",
				endpoint: "https://openrouter.ai/api/v1",
				model: "synthetic-verifier",
				downstreamProvider: "synthetic",
				writerModel: "synthetic-writer",
				promptVersion: "synthetic",
				schemaVersion: "synthetic",
				reasoningEffort: "low",
				routeSha256,
				promptSha256: sha256("synthetic prompt"),
				schemaSha256: sha256("synthetic schema"),
				limits: { maxInputCodePoints: 10, maxOutputTokens: 10, maxCallCostMicros: 10, callTimeoutMs: 1000 },
			},
		],
		suites: [
			{ id: "translation-primary", cases: [planned("refusal"), planned("translation-next")] },
			{ id: "job-evidence-primary", cases: [planned("job")] },
			{ id: "extraction-primary", cases: [planned("extraction")] },
		].map((suite) => ({ ...suite, routeSha256, capMicros: 100 })),
	};
	const raw = JSON.stringify(manifest);
	const manifestSha256 = sha256(raw);
	await writeFile(path, raw);
	await writeFile(join(directory, "batch.fixtures.json"), "[]");
	const requested: string[] = [];
	vi.stubGlobal("fetch", (_input: string, init: RequestInit) => {
		if (init.method !== "POST") return Promise.resolve(Response.json({ manifestSha256, buildSha256 }));
		const { suite, caseId } = JSON.parse(String(init.body)) as Pick<CaseReceipt, "suite" | "caseId">;
		requested.push(caseId);
		if (caseId === "refusal" && status !== 200) return Promise.resolve(new Response(null, { status }));
		return Promise.resolve(
			Response.json({
				suite,
				caseId,
				status: caseId === "refusal" ? "refused" : "evaluated",
				stage: "deterministic",
				inputSha256,
				logicalInputSha256: inputSha256,
				plannedVerifier: { routeSha256, batches: [] },
				elapsedMs: 1,
				calls: [],
				issues: [],
				retainedIds: [],
			} satisfies CaseReceipt),
		);
	});
	try {
		await runQualification("http://127.0.0.1:3100", path, output);
	} finally {
		vi.unstubAllGlobals();
	}
	expect(requested).toEqual(ids);
	const receipts = JSON.parse(await readFile(output, "utf8")) as QualificationReceipts;
	expect(receipts.cases.map(({ status }) => status)).toEqual(["refused", "evaluated", "evaluated", "evaluated"]);
	expect(receipts.cases[0]?.unavailableHttpStatus).toBe(status === 200 ? undefined : status);
	for (const receipt of receipts.cases) {
		expect(receipt.inputSha256).toBe(inputSha256);
		expect(receipt.logicalInputSha256).toBe(inputSha256);
		expect(receipt.plannedVerifier).toEqual({ routeSha256, batches: [] });
	}
	expect(scorePipelineSafety(manifest, expected, receipts)).toEqual([
		{ suite: "translation-primary", passed: false, reason: expect.stringContaining("refused") },
		{ suite: "job-evidence-primary", passed: true },
		{ suite: "extraction-primary", passed: true },
	]);
});
