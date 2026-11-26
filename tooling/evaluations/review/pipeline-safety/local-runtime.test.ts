import type { CaseReceipt, QualificationCall, QualificationRoute, SafetyExpected, SafetyInput } from "./types";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { expect, it } from "vite-plus/test";
import { bindExpectedIdentifiers } from "./expected-identifiers";
import extractionLabels from "./expected/extraction.json";
import jobLabels from "./expected/job-evidence.json";
import translationLabels from "./expected/translation.json";
import { qualificationSelectionId } from "./fixture-identifiers";
import extraction from "./fixtures/extraction.json";
import jobs from "./fixtures/job-evidence.json";
import translation from "./fixtures/translation.json";
import { batchHashes, prepareFixedCase, QualificationLedger } from "./local-runtime";

const fixtureIdentifierSeed = "a".repeat(64);

it("varies every verdict-labeled item across all hex prefixes between manifests", () => {
	const fixtures = [...translation, ...jobs, ...extraction] as SafetyInput[];
	const labels = [...translationLabels, ...jobLabels, ...extractionLabels] as SafetyExpected[];
	const prefixes = new Map<string, Set<string>>();
	for (let index = 0; index < 256; index++) {
		const seed = index.toString(16).padStart(64, "0");
		const bound = bindExpectedIdentifiers(fixtures, labels, seed);
		for (const [caseIndex, label] of bound.entries()) {
			const ids = [...label.retainedIds, ...label.caught.map(({ itemId }) => itemId)];
			for (const [itemIndex, id] of ids.entries()) {
				const prefix = /^(?:question:)?x([0-9a-f])/u.exec(id)?.[1];
				if (!prefix) continue; // Job note indices are assigned by the contract.
				const key = `${caseIndex}/${itemIndex}`;
				const observed = prefixes.get(key) ?? new Set<string>();
				observed.add(prefix);
				prefixes.set(key, observed);
			}
		}
	}
	expect(fixtures).toHaveLength(48);
	expect(prefixes.size).toBeGreaterThan(48);
	for (const [item, observed] of prefixes) expect(observed.size, item).toBe(16);
});

it("places each extraction question in both wire positions across manifests", () => {
	const inputs = (extraction as SafetyInput[]).filter(
		({ feature, candidate }) =>
			feature === "extraction" && Array.isArray(candidate.questions) && candidate.questions.length > 0,
	);
	expect(inputs).toHaveLength(4);
	for (const input of inputs) {
		const positions = new Set<number>();
		for (let index = 0; index < 32; index++) {
			const seed = index.toString(16).padStart(64, "0");
			const { batches } = prepareFixedCase(input, { feature: "extraction" } as QualificationRoute, seed);
			positions.add(batches[0]?.itemIds.findIndex((id) => id.startsWith("question:")) ?? -1);
		}
		expect(positions, input.id).toEqual(new Set([0, 1]));
	}
});

it("binds extraction responses to the actual claim IDs and requires complete coverage", () => {
	const input = extraction.find(({ id }) => id === "extraction-en-mixed");
	if (!input) throw new Error("Missing extraction fixture");
	const [batch] = prepareFixedCase(
		input as SafetyInput,
		{ feature: "extraction" } as QualificationRoute,
		fixtureIdentifierSeed,
	).batches;
	if (!batch) throw new Error("Missing extraction batch");
	expect(batch.payload.selections[0]?.text).toBe(input.source.text);
	const inventory = batch.payload.selections.find((item) => "id" in item && item.id === "verification-claims");
	const claims = JSON.parse(inventory?.text ?? "[]") as Array<{ claimId: string; itemType: string }>;
	expect(claims).toHaveLength(2);
	for (const { claimId } of claims) expect(claimId).toMatch(/^x[0-9a-f]{12}$/u);
	const fieldClaim = claims.find(({ itemType }) => itemType === "field");
	if (!fieldClaim) throw new Error("Missing extraction field claim");
	const body = {
		schemaVersion: 3,
		responseAssessment: { status: "appropriate", reason: "OK" },
		factRetention: {
			status: "retained",
			evidenceIds: [qualificationSelectionId],
			failedClaimIds: [],
			reason: "Retained",
		},
		verdicts: claims.map(({ claimId }) => ({
			claimId,
			verdict: "supported",
			evidenceIds: [qualificationSelectionId],
			reason: "OK",
		})),
	};
	const [field, question] = body.verdicts;
	expect(batch.schema.safeParse(body).success).toBe(true);
	expect(batch.schema.safeParse({ ...body, verdicts: [field] }).success).toBe(false);
	expect(batch.schema.safeParse({ ...body, verdicts: [field, field] }).success).toBe(false);
	expect(
		batch.schema.safeParse({ ...body, verdicts: [field, { ...question, claimId: "source-question" }] }).success,
	).toBe(false);
	expect(
		batch.schema.safeParse({
			...body,
			factRetention: { status: "not_applicable", evidenceIds: [], failedClaimIds: [], reason: "N/A" },
		}).success,
	).toBe(false);
	expect(batch.validate(body)).toEqual(batch.itemIds.map((itemId) => ({ itemId, issueClass: null })));
	expect(
		batch.validate({
			...body,
			factRetention: { ...body.factRetention, status: "lost", failedClaimIds: [fieldClaim.claimId] },
		}),
	).toEqual(
		batch.itemIds.map((itemId) => ({
			itemId,
			issueClass: itemId === fieldClaim.claimId ? "AI_VERIFICATION_RETENTION" : null,
		})),
	);
	expect(() => batch.validate({ ...body, factRetention: { ...body.factRetention, status: "lost" } })).toThrow(
		"AI_FACT_RETENTION_FAILED",
	);
	expect(
		batch.validate({ ...body, verdicts: body.verdicts.map((entry) => ({ ...entry, verdict: "unsupported" })) }),
	).toEqual(batch.itemIds.map((itemId) => ({ itemId, issueClass: "AI_VERIFICATION_CLAIM_SUPPORT" })));
});

async function ledger() {
	const path = join(await mkdtemp(join(tmpdir(), "qualification-test-")), "ledger.json");
	return () => new QualificationLedger(path, "fixture-campaign", 120);
}

const call = {
	batchKey: "a",
	endpointSlot: "primary",
	transport: "stub",
	routeSha256: "route",
	promptSha256: "prompt",
	schemaSha256: "schema",
	observedModel: "model",
	observedProvider: "provider",
	responseId: "response",
	costMicros: 20,
	heldMicros: 0,
	elapsedMs: 0,
	verdicts: [],
} satisfies QualificationCall;
const caseReceipt = {
	suite: "suite",
	caseId: "a",
	inputSha256: "a",
	logicalInputSha256: "a",
	plannedVerifier: { routeSha256: "route", batches: [] },
	elapsedMs: 0,
	stage: "semantic",
	status: "evaluated",
	retainedIds: [],
	issues: [],
	calls: [call],
} satisfies CaseReceipt;

it("reuses a completed receipt after restart with no new call", async () => {
	const open = await ledger();
	const first = open();
	await first.reserve("manifest", "suite", "a", "a", 40, 75);
	await first.settle("manifest", "suite", "a", call);
	await first.complete("manifest", caseReceipt);
	expect(await open().existing("manifest", "suite", "a")).toEqual(caseReceipt);
	await expect(open().reserve("manifest", "suite", "a", "a", 40, 75)).rejects.toThrow();
});

it("holds unresolved requests after restart and across manifests", async () => {
	const open = await ledger();
	await open().reserve("original", "suite", "a", "a", 75, 90);
	await expect(open().reserve("original", "suite", "a", "a", 1, 90)).rejects.toThrow();
	await expect(open().reserve("new", "suite", "b", "a", 16, 90)).rejects.toThrow("QUALIFICATION_BUDGET");
	await expect(open().reserve("new", "second", "b", "a", 46, 90)).rejects.toThrow("QUALIFICATION_BUDGET");
	expect(await open().spend()).toEqual({ measured: 0, held: 75 });
});

it("keeps prior spend and holds when the approved campaign cap increases", async () => {
	const path = join(await mkdtemp(join(tmpdir(), "qualification-test-")), "ledger.json");
	const first = new QualificationLedger(path, "fixture-campaign", 120);
	await first.reserve("original", "suite", "a", "a", 40, 120);
	await first.settle("original", "suite", "a", call);
	await first.complete("original", caseReceipt);
	await first.reserve("original", "suite", "pending", "a", 40, 120);

	const increased = new QualificationLedger(path, "fixture-campaign", 150, 120);
	await expect(increased.reserve("new", "suite", "b", "a", 91, 150)).rejects.toThrow("QUALIFICATION_BUDGET");
	await increased.reserve("new", "suite", "b", "a", 90, 150);
	const restarted = new QualificationLedger(path, "fixture-campaign", 150);
	expect(await restarted.spend()).toEqual({ measured: 20, held: 130 });
	expect(await restarted.existing("original", "suite", "a")).toEqual(caseReceipt);
	await expect(first.spend()).rejects.toThrow("QUALIFICATION_CAMPAIGN_CHANGED");
});

it("settles measured expense and stops egress after an over-bound call", async () => {
	const open = await ledger();
	await open().reserve("same", "suite", "a", "a", 15, 90);
	await expect(open().settle("same", "suite", "a", call)).rejects.toThrow("QUALIFICATION_BOUND_EXCEEDED");
	expect(await open().spend()).toEqual({ measured: 20, held: 0 });
	await expect(open().reserve("new", "suite", "b", "b", 1, 90)).rejects.toThrow("QUALIFICATION_BUDGET");
});

it("recovers an interrupted ledger write while preserving prior holds", async () => {
	const path = join(await mkdtemp(join(tmpdir(), "qualification-test-")), "ledger.json");
	const first = new QualificationLedger(path, "fixture-campaign", 120);
	await first.reserve("manifest", "suite", "first", "a", 40, 90);
	await writeFile(`${path}.lock`, "", { mode: 0o600 });
	const restarted = new QualificationLedger(path, "fixture-campaign", 120);
	await restarted.reserve("manifest", "suite", "second", "a", 40, 90);
	expect(await restarted.spend()).toEqual({ measured: 0, held: 80 });
	await expect(restarted.reserve("manifest", "suite", "first", "a", 1, 90)).rejects.toThrow(
		"QUALIFICATION_ALREADY_DISPATCHED",
	);
});

it("keeps the OS lock when another writer in the same process tries to reserve", async () => {
	const path = join(await mkdtemp(join(tmpdir(), "qualification-test-")), "ledger.json");
	const lockPath = `${path}.lock.sqlite`;
	const lock = new DatabaseSync(lockPath);
	try {
		lock.exec("BEGIN IMMEDIATE");
		const ledger = new QualificationLedger(path, "fixture-campaign", 120);
		await expect(ledger.reserve("manifest", "suite", "a", "a", 40, 90)).rejects.toThrow(/locked/u);
		const contender = spawnSync(
			process.execPath,
			[
				"--input-type=module",
				"-e",
				`import { DatabaseSync } from "node:sqlite";
			 const lock = new DatabaseSync(process.argv[1]);
			 lock.exec("BEGIN IMMEDIATE");
			 lock.close();`,
				lockPath,
			],
			{ encoding: "utf8", timeout: 5_000 },
		);
		expect(contender.status).toBe(1);
		expect(contender.stderr).toContain("database is locked");
	} finally {
		lock.close();
	}
});

it("releases a dead writer's lock without taking it from a live writer", async () => {
	const path = join(await mkdtemp(join(tmpdir(), "qualification-test-")), "ledger.json");
	const writer = spawn(
		process.execPath,
		[
			"--input-type=module",
			"-e",
			`import { DatabaseSync } from "node:sqlite";
		 const lock = new DatabaseSync(process.argv[1]);
		 lock.exec("BEGIN IMMEDIATE");
		 console.log("locked");
		 setInterval(() => {}, 1000);`,
			`${path}.lock.sqlite`,
		],
		{ stdio: ["ignore", "pipe", "inherit"] },
	);
	const exited = once(writer, "exit");
	const ledger = new QualificationLedger(path, "fixture-campaign", 120);
	try {
		const [ready] = await once(writer.stdout, "data");
		expect(String(ready)).toBe("locked\n");
		await expect(ledger.reserve("manifest", "suite", "a", "a", 40, 90)).rejects.toThrow(/locked/u);
	} finally {
		writer.kill("SIGKILL");
		await exited;
	}
	await ledger.reserve("manifest", "suite", "a", "a", 40, 90);
	expect(await ledger.spend()).toEqual({ measured: 0, held: 40 });
});

it.each([
	["job-evidence", jobs, jobLabels],
	["extraction", extraction, extractionLabels],
] as const)("prepares all 16 frozen %s cases through their production contracts", (_feature, fixtures, labels) => {
	const inputs = fixtures as SafetyInput[];
	const expected = bindExpectedIdentifiers(inputs, labels as SafetyExpected[], fixtureIdentifierSeed);
	expect(inputs.map(({ id }) => id)).toEqual(expected.map(({ id }) => id));
	expect(inputs.filter(({ locale }) => locale === "ar-SA")).toHaveLength(8);
	expect(inputs.filter(({ locale }) => locale === "en-US")).toHaveLength(8);
	for (const input of inputs) {
		const label = expected.find(({ id }) => id === input.id);
		if (!label) throw new Error("Missing fixture label");
		const route = {
			feature: input.feature,
			limits: { maxInputCodePoints: 24000, maxOutputTokens: 2400 },
		} as QualificationRoute;
		const prepared = prepareFixedCase(input, route, fixtureIdentifierSeed);
		expect(prepared.localIssues, input.id).toEqual(label.caught.filter(({ stage }) => stage === "deterministic"));
		const submitted = prepared.batches.flatMap(({ itemIds }) => itemIds).sort();
		const semanticIds = label.caught.filter(({ stage }) => stage === "semantic").map(({ itemId }) => itemId);
		expect(submitted, input.id).toEqual([...label.retainedIds, ...semanticIds].sort());
		for (const batch of prepared.batches) expect(batchHashes(batch).schemaSha256).toMatch(/^[a-f0-9]{64}$/u);
	}
});

it("rejects historical translation cases before any qualification dispatch", () => {
	const [input] = translation;
	if (!input) throw new Error("Missing historical translation fixture");
	expect(() =>
		prepareFixedCase(input as SafetyInput, { feature: "translation" } as QualificationRoute, fixtureIdentifierSeed),
	).toThrow("QUALIFICATION_FEATURE_RETIRED");
});
