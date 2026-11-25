import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vite-plus/test";

const tooling = fileURLToPath(new URL("../../../", import.meta.url));
const verifierLimits = {
	maxInputCodePoints: 32000,
	maxOutputTokens: 16384,
	maxCallCostMicros: 100000,
	inputMicrosPerMillionTokens: 600000,
	completionMicrosPerMillionTokens: 2400000,
	feeBasisPoints: 550,
	fixedFeeMicros: 0,
	protocolOverheadTokens: 1024,
};

it("dispatches the application verifier route and blocks a batch above its approved cost", async () => {
	const directory = await mkdtemp(join(tmpdir(), "qualification-runtime-"));
	const manifest = join(directory, "batch.manifest.json");
	const blockedDirectory = await mkdtemp(join(tmpdir(), "qualification-blocked-"));
	const blockedManifest = join(blockedDirectory, "batch.manifest.json");
	const approvals = {
		campaignId: "offline-runtime-test",
		suiteCaps: {
			"translation-primary": 436660,
			"job-evidence-primary": 672401,
			"extraction-primary": 1091956,
		},
		routes: {
			translation: verifierLimits,
			"job-evidence": verifierLimits,
			extraction: verifierLimits,
			wording: verifierLimits,
		},
	};
	const ledgerFile = join(directory, `campaign-${approvals.campaignId}.json`);
	const priorHold = {
		manifest: "prior-manifest",
		suite: "translation-primary",
		caseId: "prior-case",
		batchKey: "prior-batch",
		bound: 40000,
		cost: 20000,
	};
	await writeFile(
		ledgerFile,
		JSON.stringify({
			campaignId: approvals.campaignId,
			capMicros: 2023724,
			overBound: false,
			holds: [priorHold],
			completed: [],
		}),
	);
	const environment = {
		PATH: process.env.PATH,
		APP_URL: "http://127.0.0.1:3140",
		DATABASE_URL: "postgresql://postgres:postgres@127.0.0.1:55432/postgres",
		COVER_LETTER_TEST_DATABASE_URL: "postgresql://postgres:postgres@127.0.0.1:55432/postgres",
		AUTH_SECRET: "synthetic-qualification-runtime-only",
		NODE_ENV: "test",
		QUALIFICATION_APPROVED_LIMITS: JSON.stringify(approvals),
	};
	const cli = "evaluations/review/pipeline-safety/cli.ts";
	const suites = "translation-primary,job-evidence-primary,extraction-primary";
	const isolation = fileURLToPath(new URL("../../../local/test-isolation.mjs", import.meta.url));
	const prepare = (output: string, env: typeof environment, flags: string[] = []) =>
		execFileSync(
			process.execPath,
			["--import", isolation, "--import", "tsx", cli, "prepare", ...flags, "--suites", suites, "--out", output],
			{ cwd: tooling, env, timeout: 15_000 },
		);
	prepare(
		blockedManifest,
		{
			...environment,
			QUALIFICATION_APPROVED_LIMITS: JSON.stringify({
				...approvals,
				routes: { ...approvals.routes, wording: { ...verifierLimits, fixedFeeMicros: 100000 } },
			}),
		},
		["--freeze-blocked"],
	);
	prepare(manifest, environment);
	const serverModule = new URL("../../../../tests/e2e/dev-real-ai-server.ts", import.meta.url);
	const result = execFileSync(
		process.execPath,
		[
			"--import",
			"tsx",
			"--input-type=module",
			"--eval",
			String.raw`
				import assert from "node:assert/strict";
				import { createHash } from "node:crypto";
				import { once } from "node:events";
				import { readFile } from "node:fs/promises";

				process.loadEnvFile = () => {};
				const networkFetch = globalThis.fetch;
				const requests = [];
				globalThis.fetch = (input, init) => {
					const url = new URL(input instanceof Request ? input.url : String(input));
					if (url.hostname === "127.0.0.1") return networkFetch(input, init);
					assert.equal(url.href, "https://openrouter.ai/api/v1/chat/completions");
					requests.push(String(init.body));
					throw new Error("OFFLINE_PROVIDER_REQUEST_BLOCKED");
				};
				const [manifestFile, ledgerDirectory, blockedManifest] = process.argv.slice(1);
				const raw = await readFile(manifestFile, "utf8");
				const manifest = JSON.parse(raw);
				const extractionIds = new Set();
				const cases = manifest.suites.flatMap(({ cases }) => cases);
				const caseFragments = cases.map(({ id }) => id.replace(/^.*?-(?:en|ar)-/, ""));
				// Protocol vocabulary such as "credential" is legitimate in prose and issue enums.
				// Scan distinctive leak words everywhere and require opaque values in every identifier slot.
				const leak = new RegExp([
					...cases.map(({ id }) => id),
					...caseFragments.filter((fragment) => fragment.includes("-")),
					"honest", "invented[-_]", "invented employer", "invented qualification", "field-valid", "field-invalid",
					"overbroad", "bad-citation", "false-full-cv", "wrong[-_]",
				].join("|"), "iu");
				const identifierKeys = new Set([
					"id", "claimId", "sourceId", "entityId", "passageId", "batchId", "fileName", "filename",
					"evidenceIds", "spanIds", "excerptedPassageIds", "checkedSourceIds", "sourceIds",
					"caseId", "caseName", "fieldId", "itemId", "noteId", "label", "name",
					"requiredSourceIds", "requiredClaimIds", "supportedSourceIds", "requirementId", "premiseId", "absenceId",
				]);
				const protocolIds = new Set([
					"translation-check", "variant-cv-evidence", "variant-job-context", "variant-verification-task",
					"variant-response", "verification-task", "verification-response", "verification-claims", "response",
				]);
				function assertOpaque(value, caseId, key = "", identifier = false) {
					if (Array.isArray(value)) {
						for (const item of value) assertOpaque(item, caseId, key, identifier);
					} else if (value && typeof value === "object") {
						for (const [childKey, child] of Object.entries(value)) {
							assertOpaque(child, caseId, childKey, identifierKeys.has(childKey) ||
								(identifier && ["items", "enum", "const", "anyOf", "oneOf"].includes(childKey)));
						}
					} else if (typeof value === "string") {
						if (identifier && !protocolIds.has(value)) {
							assert.match(value, /^(?:(?:requirement|absence):)?x[0-9a-f]{12}(?:\/x[0-9a-f]{12})?$|^e[0-9]+$|^note:[0-9]+$|^part-[0-9]+$/, caseId + "/" + key);
						} else if ((key === "content" || key === "text") && /^[{\[]/.test(value)) {
							assertOpaque(JSON.parse(value), caseId);
						}
					}
				}
				const manifestSha256 = createHash("sha256").update(raw).digest("hex");
				process.env.QUALIFICATION_ARMED_MANIFEST = manifestSha256;
				process.env.OPENROUTER_API_KEY = "offline-placeholder";
				const { startQualificationServer } = await import(${JSON.stringify(serverModule.href)});
				const blocked = await readFile(blockedManifest, "utf8");
				const blockedPlan = JSON.parse(blocked);
				assert.deepEqual(blockedPlan.callLimitViolations.map(({ caseId }) => caseId), [
					"wording-en-retention", "wording-ar-retention",
				]);
				for (const { derivedMicros, capMicros } of blockedPlan.callLimitViolations) {
					assert.equal(capMicros, 100000);
					assert(derivedMicros > capMicros);
				}
				assert.notEqual(blockedPlan.fixtureIdentifierSeed, manifest.fixtureIdentifierSeed);
				assert.deepEqual(blockedPlan.suites.flatMap(({ cases }) => cases.map(({ inputSha256 }) => inputSha256)),
					cases.map(({ inputSha256 }) => inputSha256));
				assert(manifest.routes.every(({ limits }) => limits.maxCallCostMicros === 100000));
				assert.deepEqual(manifest.suites.map(({ cases }) =>
					cases.flatMap(({ batches }) => batches).reduce((sum, { boundMicros }) => sum + boundMicros, 0)
				), [328045, 399932, 1000000]);
				process.env.QUALIFICATION_ARMED_MANIFEST = createHash("sha256").update(blocked).digest("hex");
				await assert.rejects(startQualificationServer(blockedManifest, "0", ledgerDirectory), /QUALIFICATION_CALL_LIMIT/);
				assert.equal(requests.length, 0);
				process.env.QUALIFICATION_ARMED_MANIFEST = manifestSha256;
				const server = await startQualificationServer(manifestFile, "0", ledgerDirectory);
				try {
					if (!server.listening) await once(server, "listening");
					const endpoint = "http://127.0.0.1:" + server.address().port + "/__local/qualification";
					for (const suite of manifest.suites) {
						for (const planned of suite.cases) {
							const before = requests.length;
							const response = await fetch(endpoint + "/case", {
								method: "POST",
								headers: { "content-type": "application/json" },
								body: JSON.stringify({ manifestSha256, suite: suite.id, caseId: planned.id }),
							});
							assert.equal(response.status, 200, suite.id + "/" + planned.id);
							const receipt = await response.json();
							assert.equal(receipt.caseId, planned.id);
							assert.equal(receipt.suite, suite.id);
							assert.equal(receipt.status, planned.batches.length ? "transport_failed" : "evaluated");
							assert.equal(requests.length - before, planned.batches.length, planned.id);
							for (const [index, request] of requests.slice(before).entries()) {
								assert(!request.includes(manifest.fixtureIdentifierSeed), planned.id);
								assert.doesNotMatch(request, leak, planned.id);
								const wire = JSON.parse(request);
								assertOpaque(wire, planned.id);
								assert.equal(wire.model, "deepseek/deepseek-v4.1-flash-1017");
								assert.equal(wire.max_tokens, 20480);
								assert.deepEqual(wire.reasoning, { effort: "low", exclude: true });
								assert.deepEqual(wire.provider.only, ["together"]);
								assert.deepEqual(wire.provider.max_price, { prompt: 0.3, completion: 1.2, request: 0 });
								const batch = planned.batches[index];
								assert.equal(Buffer.byteLength(request, "utf8"), batch.wireBytes, planned.id);
								const selections = JSON.parse(wire.messages.at(-1).content).selections;
								const selection = (id) => JSON.parse(selections.find((item) => item.id === id).text);
								let orderedIds = batch.itemIds;
								if (planned.feature === "translation") {
									const task = selection("translation-check");
									orderedIds = task.pairs.map(({ sourceId }) => sourceId);
									assert.deepEqual(task.requiredSourceIds, orderedIds);
								} else if (planned.feature === "job-evidence") {
									const requirements = selection("variant-response").requirements;
									orderedIds = [...requirements.map(({ id }) => id), ...batch.itemIds.filter((id) => id.startsWith("note:"))];
									const task = selection("variant-verification-task");
									assert.deepEqual(task.requiredItems.map(({ requirementId, premiseId }) => requirementId ?? premiseId), orderedIds);
								} else if (planned.feature === "extraction") {
									const claims = selection("verification-claims");
									assert.deepEqual(selection("verification-task").requiredClaimIds, claims.map(({ claimId }) => claimId));
									orderedIds = claims.map(({ claimId, claimKinds }) => {
										assert.match(claimId, /^x[0-9a-f]{12}$/);
										assert(!extractionIds.has(claimId), claimId);
										extractionIds.add(claimId);
										return claimKinds.includes("question-premises") ? "question:" + claimId : claimId;
									});
								}
								assert.deepEqual([...orderedIds].sort(), [...batch.itemIds].sort(), planned.id);
							}
							assert.equal(receipt.inputSha256, planned.inputSha256);
							assert.equal(receipt.logicalInputSha256, planned.logicalInputSha256);
							assert.deepEqual(receipt.plannedVerifier, {
								routeSha256: planned.routeSha256,
								batches: planned.batches.map(({ batchKey, promptSha256, schemaSha256 }) => ({ batchKey, promptSha256, schemaSha256 })),
							});
							for (const [index, call] of receipt.calls.entries()) {
								assert.equal(call.routeSha256, planned.routeSha256);
								assert.equal(call.promptSha256, planned.batches[index].promptSha256);
								assert.equal(call.schemaSha256, planned.batches[index].schemaSha256);
								assert.equal(call.responseId, null);
							}
						}
					}
					console.log(JSON.stringify({ cases: cases.length, blockedCalls: requests.length }));
				} finally {
					await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
				}
			`,
			manifest,
			directory,
			blockedManifest,
		],
		{ cwd: tooling, env: environment, encoding: "utf8", timeout: 15_000 },
	);
	expect(JSON.parse(result)).toEqual({ cases: 48, blockedCalls: 36 });
	const ledger = JSON.parse(await readFile(ledgerFile, "utf8"));
	expect(ledger).toMatchObject({ capMicros: 2500000 });
	expect(ledger.holds[0]).toEqual(priorHold);
});
