import type {
	CaseReceipt,
	QualificationManifest,
	QualificationBatch,
	QualificationCase,
	QualificationReceipts,
	QualificationRoute,
	SafetyExpected,
	SafetyFeature,
	SafetyInput,
} from "./types";
import type { ApprovedRoute } from "@reactive-resume/api/features/ai/route-policy";
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { readFile, writeFile, lstat } from "node:fs/promises";
import { basename, dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { z } from "zod";
import { bindExpectedIdentifiers } from "./expected-identifiers";
import { scorePipelineSafety, sha256 } from "./run";
import { plannedVerifier } from "./types";

const repository = fileURLToPath(new URL("../../../../", import.meta.url));
const folder = fileURLToPath(new URL("./", import.meta.url));
const publicRoutePath = resolve(repository, "apps/server/src/startup/ai-route.json");
const suiteFeatures = {
	"translation-primary": "translation",
	"job-evidence-primary": "job-evidence",
	"extraction-primary": "extraction",
} as const;
type SuiteId = keyof typeof suiteFeatures;
const campaignCap = 2500000;
export const previousQualificationCampaignCap = 2023724;
const positiveInteger = z.number().int().positive();
const approvedConfig = z.strictObject({
	campaignId: z.string().regex(/^[a-z0-9][a-z0-9-]{0,79}$/u),
	suiteCaps: z.strictObject({
		"translation-primary": z.literal(436660),
		"job-evidence-primary": z.literal(672401),
		"extraction-primary": z.literal(1091956),
	}),
	routes: z.record(
		z.string(),
		z.strictObject({
			maxInputCodePoints: positiveInteger,
			maxOutputTokens: positiveInteger,
			maxCallCostMicros: positiveInteger,
			inputMicrosPerMillionTokens: positiveInteger,
			completionMicrosPerMillionTokens: positiveInteger,
			feeBasisPoints: z.number().int().nonnegative(),
			fixedFeeMicros: z.number().int().nonnegative(),
			protocolOverheadTokens: positiveInteger,
		}),
	),
});

export function approvedQualificationConfig() {
	const raw = process.env.QUALIFICATION_APPROVED_LIMITS;
	if (!raw) throw new Error("QUALIFICATION_APPROVED_LIMITS_REQUIRED");
	return approvedConfig.parse(JSON.parse(raw));
}

export function qualificationCallCost(
	wireBytes: number,
	completionTokens: number,
	rate: NonNullable<ReturnType<typeof approvedQualificationConfig>["routes"][string]>,
) {
	const inputCost = (wireBytes + rate.protocolOverheadTokens) * rate.inputMicrosPerMillionTokens;
	const outputCost = completionTokens * rate.completionMicrosPerMillionTokens;
	return Math.ceil(((inputCost + outputCost) * (10000 + rate.feeBasisPoints)) / 10000000000) + rate.fixedFeeMicros;
}

export function requireDispatchableManifest(manifest: QualificationManifest) {
	if (manifest.callLimitViolations?.length) throw new Error("QUALIFICATION_CALL_LIMIT");
}

/** Use the application's public route policy so receipts can match a later startup selection. */
export function qualificationRouteBase(apiKey: string): ApprovedRoute {
	const { concurrency: _concurrency, ...route } = JSON.parse(readFileSync(publicRoutePath, "utf8")) as Omit<
		ApprovedRoute,
		"apiKey"
	> & { concurrency: number };
	return { ...route, apiKey };
}

export function requireQualificationLimits(
	verifier: ApprovedRoute,
	feature: SafetyFeature,
	approved: ReturnType<typeof approvedQualificationConfig>,
) {
	const limits = approved.routes[feature];
	if (
		!limits ||
		limits.maxInputCodePoints !== verifier.maxInputCodePoints ||
		limits.maxOutputTokens !== verifier.maxOutputTokens ||
		limits.maxCallCostMicros !== verifier.maxCallCostMicros
	)
		throw new Error("QUALIFICATION_LIMITS_UNAPPROVED");
	return limits;
}

function artifactPaths(manifest: string) {
	if (basename(manifest) !== "batch.manifest.json") throw new Error("QUALIFICATION_MANIFEST_FILENAME");
	return {
		fixtures: join(dirname(manifest), "batch.fixtures.json"),
		expected: join(dirname(manifest), "batch.expected.json"),
	};
}

function executable(path: string) {
	return (
		!path.split("/").some((part) => part.startsWith(".") || part === "node_modules" || part === "dist") &&
		!path.startsWith("tooling/evaluations/review/pipeline-safety/expected/") &&
		!/\.(?:test|spec)\.[cm]?[jt]sx?$/u.test(path) &&
		(/^(?:apps\/server|packages)\/.*\.(?:[cm]?[jt]sx?|json|md)$/u.test(path) ||
			/^(?:tooling\/evaluations\/review\/pipeline-safety|tooling\/local)\/.*\.(?:[cm]?[jt]s|json)$/u.test(path) ||
			[
				"package.json",
				"pnpm-lock.yaml",
				"pnpm-workspace.yaml",
				"tsconfig.json",
				"tests/e2e/dev-real-ai-server.ts",
			].includes(path))
	);
}

async function executableDigest(path: string) {
	const absolute = resolve(repository, path);
	if (!executable(path) || relative(repository, absolute) !== path || !(await lstat(absolute)).isFile())
		throw new Error("QUALIFICATION_EXECUTABLE_PATH_DENIED");
	return { path, sha256: sha256(await readFile(absolute)) };
}

async function executableInputs() {
	const files = execFileSync("git", ["ls-files", "--cached", "--others", "--exclude-standard", "-z"], {
		cwd: repository,
		encoding: "utf8",
		maxBuffer: 16 * 1024 * 1024,
	});
	const paths = [...new Set(files.split("\0").filter(executable))].sort();
	const entries = [];
	for (const path of paths) {
		try {
			entries.push(await executableDigest(path));
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		}
	}
	return entries;
}

export async function loadQualificationBatch(path: string) {
	const artifacts = artifactPaths(path);
	const raw = await readFile(path, "utf8");
	const manifest = JSON.parse(raw) as QualificationManifest;
	const manifestSha256 = sha256(raw);
	if (
		manifest.version !== 1 ||
		!/^[a-f0-9]{64}$/u.test(manifest.fixtureIdentifierSeed) ||
		manifest.maxRunMicros !== campaignCap ||
		JSON.stringify(manifest) !== raw ||
		manifest.buildSha256 !== sha256(JSON.stringify(manifest.executables)) ||
		manifest.implementationSha256 !== manifest.buildSha256
	)
		throw new Error("QUALIFICATION_MANIFEST_CHANGED");
	const current = await executableInputs();
	if (JSON.stringify(current) !== JSON.stringify(manifest.executables)) throw new Error("QUALIFICATION_BUILD_CHANGED");
	const fixtureBytes = await readFile(artifacts.fixtures);
	if (sha256(fixtureBytes) !== manifest.fixturesSha256) throw new Error("QUALIFICATION_FIXTURES_CHANGED");
	return { artifacts, manifest, manifestSha256, fixtures: JSON.parse(fixtureBytes.toString()) as SafetyInput[] };
}

async function prepare(suites: string[], outputPath: string, freezeBlocked: boolean) {
	const approvals = approvedQualificationConfig();
	const fixtureIdentifierSeed = randomBytes(32).toString("hex");
	if (
		!suites.length ||
		new Set(suites).size !== suites.length ||
		suites.some((suite) => !Object.hasOwn(suiteFeatures, suite))
	)
		throw new Error("QUALIFICATION_PRIMARY_SUITES_REQUIRED");
	const [runtime, routePolicy, contracts, review, verifier, reviewVerifier, local, writerPolicy] = await Promise.all([
		import("./local-runtime"),
		import("@reactive-resume/api/features/ai/route-policy"),
		import("@reactive-resume/api/features/ai/variant-contracts"),
		import("@reactive-resume/api/features/ai/review-handlers"),
		import("@reactive-resume/api/features/ai/variant-verifier"),
		import("@reactive-resume/api/features/ai/review-verifier"),
		import("@reactive-resume/api/features/ai/verifier-policy"),
		import("@reactive-resume/api/features/ai/writer-policy"),
	]);
	const base = qualificationRouteBase("offline-configuration-only");
	const fixtures: SafetyInput[] = [];
	const labels: SafetyExpected[] = [];
	const routes = new Map<SafetyFeature, QualificationRoute>();
	const preparedSuites: QualificationManifest["suites"] = [];
	const callLimitViolations: NonNullable<QualificationManifest["callLimitViolations"]> = [];
	for (const suite of suites as SuiteId[]) {
		const feature = suiteFeatures[suite];
		const inputs = JSON.parse(await readFile(join(folder, "fixtures", `${feature}.json`), "utf8")) as SafetyInput[];
		const expected = JSON.parse(
			await readFile(join(folder, "expected", `${feature}.json`), "utf8"),
		) as SafetyExpected[];
		if (
			inputs.length !== 16 ||
			expected.length !== 16 ||
			new Set(inputs.map(({ id }) => id)).size !== 16 ||
			inputs.filter(({ locale }) => locale === "ar-SA").length !== 8 ||
			inputs.some(({ id }, i) => id !== expected[i]?.id)
		)
			throw new Error("QUALIFICATION_CORPUS_INCOMPLETE");
		fixtures.push(...inputs);
		labels.push(...expected);
		const capMicros = approvals.suiteCaps[suite];
		let plannedMicros = 0;
		const cases: QualificationCase[] = [];
		for (const input of inputs) {
			const routeFeature = input.feature;
			const effective = runtime.effectiveQualificationRoute(input, base);
			const rate = requireQualificationLimits(effective, routeFeature, approvals);
			const writerModel = writerPolicy.resolveWriterRoute(base, {
				kind: `review.${routeFeature}`,
				parameters: {},
			}).model;
			const versions =
				routeFeature === "translation"
					? contracts.translationCandidateContract
					: routeFeature === "job-evidence"
						? contracts.jobEvidenceCandidateContract
						: routeFeature === "extraction"
							? review.extractionCandidateHandler
							: review.reviewHandlers["review.wording"];
			const verifierVersion =
				routeFeature === "translation"
					? "translation-check-v2"
					: routeFeature === "job-evidence"
						? `${verifier.VARIANT_VERIFIER_VERSION}-classified`
						: routeFeature === "extraction"
							? reviewVerifier.EXTRACTION_VERIFIER_VERSION
							: reviewVerifier.VERIFIER_VERSION;
			const routeSha256 = local.canonicalVerifierRouteSha256(effective);
			const route: QualificationRoute = routes.get(routeFeature) ?? {
				feature: routeFeature,
				endpointSlot: "primary",
				endpoint: effective.endpoint,
				model: effective.model,
				downstreamProvider: effective.downstreamProvider,
				reasoningEffort: effective.reasoningEffort ?? "none",
				writerModel,
				promptVersion: versions.promptVersion,
				schemaVersion: versions.schemaVersion,
				verifierPromptVersion:
					routeFeature === "translation"
						? contracts.translationCandidateContract.verifierPromptVersion
						: routeFeature === "job-evidence"
							? contracts.jobEvidenceCandidateContract.verifierPromptVersion
							: verifierVersion,
				verifierSchemaVersion: verifierVersion,
				routeSha256,
				promptSha256: sha256(""),
				schemaSha256: sha256(""),
				limits: {
					maxInputCodePoints: effective.maxInputCodePoints,
					maxOutputTokens: effective.maxOutputTokens,
					maxCallCostMicros: effective.maxCallCostMicros,
					callTimeoutMs: effective.callTimeoutMs,
					completionTokenLimit: routePolicy.completionTokenLimit(effective),
				},
			};
			routes.set(routeFeature, route);
			const prepared = runtime.prepareFixedCase(input, route, fixtureIdentifierSeed);
			const batches: QualificationBatch[] = [];
			for (const batch of prepared.batches) {
				const hashes = runtime.batchHashes(batch);
				if ([...JSON.stringify(batch.payload)].length > effective.maxInputCodePoints)
					throw new Error(`QUALIFICATION_INPUT_LIMIT: ${suite}/${input.id}/${batch.key}`);
				const boundMicros = await runtime.qualificationBatchBound(batch, effective);
				const wireBytes = await runtime.batchInputBytes(batch, effective, boundMicros);
				const derivedMicros = qualificationCallCost(wireBytes, routePolicy.completionTokenLimit(effective), rate);
				if (derivedMicros > effective.maxCallCostMicros)
					callLimitViolations.push({
						suite,
						caseId: input.id,
						batchKey: batch.key,
						wireBytes,
						derivedMicros,
						capMicros: effective.maxCallCostMicros,
					});
				plannedMicros += boundMicros;
				batches.push({
					batchKey: batch.key,
					itemIds: batch.itemIds,
					...hashes,
					boundMicros,
					wireBytes,
				});
			}
			if (batches.reduce((total, { boundMicros }) => total + boundMicros, 0) > effective.requestCapMicros)
				throw new Error(`QUALIFICATION_CASE_CAP: ${suite}/${input.id}`);
			cases.push({
				id: input.id,
				inputSha256: sha256(JSON.stringify(input)),
				logicalInputSha256: sha256(JSON.stringify([input.source, input.candidate])),
				batches,
				writerModel,
				feature: routeFeature,
				routeSha256,
			});
		}
		if (plannedMicros > capMicros)
			throw new Error(`QUALIFICATION_SUITE_CAP: ${suite} needs ${plannedMicros}, cap ${capMicros}`);
		const primary = routes.get(feature);
		if (!primary) throw new Error("QUALIFICATION_ROUTE_REQUIRED");
		preparedSuites.push({ id: suite, routeSha256: primary.routeSha256, capMicros, cases });
	}
	const allCases = preparedSuites.flatMap(({ cases }) => cases);
	for (const route of routes.values()) {
		const batches = allCases.filter(({ feature }) => feature === route.feature).flatMap(({ batches }) => batches);
		route.promptSha256 = sha256(JSON.stringify(batches.map(({ promptSha256 }) => promptSha256)));
		route.schemaSha256 = sha256(JSON.stringify(batches.map(({ schemaSha256 }) => schemaSha256)));
	}
	const fixtureBytes = JSON.stringify(fixtures);
	const expectedBytes = JSON.stringify(labels);
	const executables = await executableInputs();
	const buildSha256 = sha256(JSON.stringify(executables));
	const manifest: QualificationManifest = {
		version: 1,
		campaignId: approvals.campaignId,
		fixtureIdentifierSeed,
		fixturesSha256: sha256(fixtureBytes),
		expectedSha256: sha256(expectedBytes),
		buildSha256,
		implementationSha256: buildSha256,
		maxRunMicros: campaignCap,
		routes: [...routes.values()],
		executables,
		suites: preparedSuites,
		...(callLimitViolations.length ? { callLimitViolations } : {}),
	};
	for (const violation of callLimitViolations) console.error("QUALIFICATION_CALL_LIMIT", JSON.stringify(violation));
	if (!freezeBlocked) requireDispatchableManifest(manifest);
	const artifacts = artifactPaths(outputPath);
	await writeFile(artifacts.fixtures, fixtureBytes);
	await writeFile(artifacts.expected, expectedBytes);
	await writeFile(outputPath, JSON.stringify(manifest));
}

export function qualificationBaseUrl(value: string): string {
	const match = /^http:\/\/127\.0\.0\.1:([1-9]\d{0,4})$/u.exec(value);
	if (!match || Number(match[1]) > 65535) throw new Error("QUALIFICATION_LOOPBACK_REQUIRED");
	return value;
}

export async function runQualification(base: string, manifestFile: string, output: string) {
	qualificationBaseUrl(base);
	const { manifest, manifestSha256 } = await loadQualificationBatch(manifestFile);
	requireDispatchableManifest(manifest);
	const endpoint = `${base}/__local/qualification`;
	const identity = await fetch(endpoint, { redirect: "error", signal: AbortSignal.timeout(5000) });
	if (!identity.ok) throw new Error("QUALIFICATION_SERVER_UNAVAILABLE");
	const remote = (await identity.json()) as { manifestSha256: string; buildSha256: string };
	if (remote.manifestSha256 !== manifestSha256 || remote.buildSha256 !== manifest.buildSha256)
		throw new Error("QUALIFICATION_BUILD_CHANGED");
	const receipts: QualificationReceipts = {
		version: 1,
		manifestSha256,
		buildSha256: manifest.buildSha256,
		campaignId: manifest.campaignId,
		startedAt: new Date().toISOString(),
		finishedAt: "",
		totalMeasuredMicros: 0,
		totalHeldMicros: 0,
		cases: [],
	};
	for (const suite of manifest.suites) {
		for (const planned of suite.cases) {
			const response = await fetch(`${endpoint}/case`, {
				method: "POST",
				redirect: "error",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ manifestSha256, suite: suite.id, caseId: planned.id }),
				signal: AbortSignal.timeout(600000),
			});
			const receipt: CaseReceipt = response.ok
				? ((await response.json()) as CaseReceipt)
				: {
						suite: suite.id,
						caseId: planned.id,
						inputSha256: planned.inputSha256,
						logicalInputSha256: planned.logicalInputSha256,
						plannedVerifier: plannedVerifier(planned, suite.routeSha256),
						elapsedMs: 0,
						stage: planned.batches.length ? "semantic" : "deterministic",
						status: "refused",
						unavailableHttpStatus: response.status,
						retainedIds: [],
						issues: [],
						calls: [],
					};
			if (receipt.suite !== suite.id || receipt.caseId !== planned.id) throw new Error("QUALIFICATION_CASE_CHANGED");
			receipts.cases.push(receipt);
			receipts.totalMeasuredMicros += receipt.calls.reduce((sum, call) => sum + (call.costMicros ?? 0), 0);
			receipts.totalHeldMicros += receipt.calls.reduce((sum, call) => sum + call.heldMicros, 0);
			receipts.finishedAt = new Date().toISOString();
			await writeFile(output, JSON.stringify(receipts));
		}
	}
}

async function score(manifestFile: string, receiptsFile: string) {
	const { artifacts, manifest, manifestSha256, fixtures } = await loadQualificationBatch(manifestFile);
	const labels = await readFile(artifacts.expected);
	if (sha256(labels) !== manifest.expectedSha256) throw new Error("QUALIFICATION_EXPECTATIONS_CHANGED");
	const bytes = await readFile(receiptsFile);
	const receipts = JSON.parse(bytes.toString()) as QualificationReceipts;
	const expected = bindExpectedIdentifiers(
		fixtures,
		JSON.parse(labels.toString()) as SafetyExpected[],
		manifest.fixtureIdentifierSeed,
	);
	const verdicts = scorePipelineSafety(manifest, expected, receipts);
	const passed = new Set(verdicts.filter((verdict) => verdict.passed).map(({ suite }) => suite));
	const qualified = manifest.routes.filter(
		({ feature, endpointSlot }) =>
			endpointSlot === "primary" &&
			(Object.entries(suiteFeatures) as [SuiteId, SafetyFeature][]).some(
				([suite, suiteFeature]) => suiteFeature === feature && passed.has(suite),
			),
	);
	const selections = qualified.map(
		({ feature, endpointSlot, writerModel, model, promptVersion, schemaVersion, routeSha256 }) => ({
			feature,
			endpointSlot,
			writerModel,
			verifierModel: model,
			promptVersion,
			schemaVersion,
			routeSha256,
			manifestSha256,
			scoredReceiptsSha256: sha256(bytes),
		}),
	);
	await writeFile(join(dirname(manifestFile), "batch.selection.json"), JSON.stringify({ selections }));
	for (const verdict of verdicts) {
		if (verdict.passed) process.stdout.write(`SAFETY_SUITE_PASSED ${verdict.suite}\n`);
		else process.stdout.write(`SAFETY_SUITE_FAILED ${verdict.suite} ${verdict.reason}\n`);
	}
	if (passed.size !== verdicts.length) throw new Error("SAFETY_GATE_FAILED: one or more suites failed");
	process.stdout.write(`SAFETY_GATE_PASSED ${receipts.cases.length} cases\n`);
}

async function main() {
	process.loadEnvFile = () => {};
	const { positionals, values } = parseArgs({
		allowPositionals: true,
		options: {
			suites: { type: "string" },
			out: { type: "string" },
			manifest: { type: "string" },
			"base-url": { type: "string" },
			receipts: { type: "string" },
			"freeze-blocked": { type: "boolean", default: false },
		},
	});
	const command = positionals[0];
	if (positionals.length !== 1) throw new Error("QUALIFICATION_COMMAND_REQUIRED");
	if (command === "prepare" && values.out && values.suites)
		return await prepare(values.suites.split(","), values.out, values["freeze-blocked"]);
	if (command === "run" && values.manifest && values.out && values["base-url"])
		return runQualification(values["base-url"], values.manifest, values.out);
	if (command === "score" && values.manifest && values.receipts) return score(values.manifest, values.receipts);
	throw new Error("QUALIFICATION_COMMAND_REQUIRED");
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	void main().catch((error: unknown) => {
		process.stderr.write(
			`${error instanceof Error && /^QUALIFICATION_|^SAFETY_GATE_FAILED/u.test(error.message) ? error.message : "QUALIFICATION_FAILED"}\n`,
		);
		process.exitCode = 1;
	});
}
