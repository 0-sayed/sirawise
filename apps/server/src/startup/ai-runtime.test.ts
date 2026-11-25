import { describe, expect, it } from "vite-plus/test";
import { extractionCandidateHandler, reviewHandlers } from "@reactive-resume/api/features/ai/review-handlers";
import { getAiAvailability, getOperationHandler, withAiRuntime } from "@reactive-resume/api/features/ai/route-policy";
import {
	jobEvidenceCandidateContract,
	translationCandidateContract,
} from "@reactive-resume/api/features/ai/variant-contracts";
import { variantReviewHandlers } from "@reactive-resume/api/features/ai/variant-handlers";
import {
	canonicalVerifierRouteSha256,
	resolveReviewVerifierRoute,
	resolveReviewVerifierRoutes,
} from "@reactive-resume/api/features/ai/verifier-policy";
import { resolveWriterRoute } from "@reactive-resume/api/features/ai/writer-policy";
import { resolvePrimaryContract, selectQualifiedContract } from "./ai-qualification";
import { bindQualifiedReviewHandlers, createProductionAiRuntime, productionAiRoute } from "./ai-runtime";

it.each(["translation", "job-evidence", "extraction"] as const)(
	"requires exact qualification evidence for %s",
	(feature) => {
		const expected = {
			feature,
			endpointSlot: "primary" as const,
			writerModel: "test/writer",
			verifierModel: "test/verifier",
			promptVersion: "prompt",
			schemaVersion: "schema",
			routeSha256: "a".repeat(64),
		};
		const evidence = { ...expected, manifestSha256: "b".repeat(64), scoredReceiptsSha256: "c".repeat(64) };
		expect(selectQualifiedContract(expected, [])).toBe(false);
		expect(selectQualifiedContract(expected, [{ ...evidence, scoredReceiptsSha256: "missing" }])).toBe(false);
		expect(selectQualifiedContract(expected, [{ ...evidence, endpointSlot: "backup" }])).toBe(false);
		expect(selectQualifiedContract(expected, [{ ...evidence, promptVersion: "changed" }])).toBe(false);
		expect(selectQualifiedContract(expected, [{ ...evidence, schemaVersion: "changed" }])).toBe(false);
		expect(selectQualifiedContract(expected, [{ ...evidence, routeSha256: "d".repeat(64) }])).toBe(false);
		const unrelatedBuild = { ...evidence, lockfileSha256: "new-build-only" };
		expect(selectQualifiedContract(expected, [unrelatedBuild])).toBe(true);
	},
);

it.each([
	["translation", translationCandidateContract],
	["job-evidence", jobEvidenceCandidateContract],
	["extraction", extractionCandidateHandler],
] as const)("selects the complete %s contract and keeps the legacy operation version readable", (feature, versions) => {
	const production = createProductionAiRuntime({ OPENROUTER_API_KEY: "synthetic" });
	const route = production?.routes[0];
	if (!production || !route) throw new Error("Missing production route fixture");
	const kind = `review.${feature}` as const;
	const baseRuntime = {
		...production,
		handlers: { ...production.handlers, ...reviewHandlers, ...variantReviewHandlers },
	};
	const legacy = baseRuntime.handlers[kind];
	if (!legacy) throw new Error("Missing legacy handler");
	expect(legacy.promptVersion).not.toBe(versions.promptVersion);
	const { tuple } = resolvePrimaryContract(route, feature, versions);
	const selection = { ...tuple, manifestSha256: "b".repeat(64), scoredReceiptsSha256: "c".repeat(64) };
	const candidateRuntime = bindQualifiedReviewHandlers(baseRuntime, [selection]);
	withAiRuntime(candidateRuntime, () => {
		expect(getOperationHandler(kind)).toMatchObject({
			promptVersion: versions.promptVersion,
			schemaVersion: versions.schemaVersion,
		});
		expect(getOperationHandler(kind, legacy)).toBe(legacy);
	});
	const changedRuntime = bindQualifiedReviewHandlers(baseRuntime, [{ ...selection, routeSha256: "d".repeat(64) }]);
	expect(changedRuntime.handlers[kind]).toBe(legacy);
});

describe("createProductionAiRuntime", () => {
	it("activates only the two primary tuples qualified on the final manifest", () => {
		const runtime = createProductionAiRuntime({ OPENROUTER_API_KEY: "synthetic" });
		const route = runtime?.routes[0];
		if (!runtime || !route) throw new Error("Expected production routes");
		expect(route.verifier?.backup).toBeNull();
		for (const [feature, contract, hash] of [
			[
				"job-evidence",
				jobEvidenceCandidateContract,
				"1253770956597bfbd0de305391df626a488b595cc2484e320d4611722df9c6a0",
			],
			["extraction", extractionCandidateHandler, "d81c19614d7d61a1159e3ff874ed5237a0d5c451a1bedfef909a82d6665de8ed"],
		] as const) {
			expect(resolvePrimaryContract(route, feature, contract).tuple.routeSha256).toBe(hash);
			expect(runtime.handlers[`review.${feature}`]).toMatchObject({
				promptVersion: contract.promptVersion,
				schemaVersion: contract.schemaVersion,
			});
		}
		expect(runtime.handlers["review.translation"]?.promptVersion).toBe("translation-v5-quota-batches");
	});

	it("ignores the local candidate switch in the production entry", () => {
		const environment = { OPENROUTER_API_KEY: "synthetic", NODE_ENV: "production" };
		const withSwitch = { ...environment, LOCAL_REAL_AI_PIPELINES: "candidates" };
		const normal = createProductionAiRuntime(environment);
		const switched = createProductionAiRuntime(withSwitch);
		const handlerConfiguration = (runtime: NonNullable<typeof normal>) =>
			JSON.parse(
				JSON.stringify(runtime.handlers, (_key, value) => (typeof value === "function" ? String(value) : value)),
			);
		if (!normal || !switched) throw new Error("Missing production runtime");
		expect(handlerConfiguration(switched)).toEqual(handlerConfiguration(normal));
		expect(switched?.routes).toEqual(normal?.routes);
	});

	it("returns null without a usable key", () => {
		expect(createProductionAiRuntime({})).toBeNull();
		expect(createProductionAiRuntime({ OPENROUTER_API_KEY: "   " })).toBeNull();
	});

	it("builds the approved pilot route", () => {
		const runtime = createProductionAiRuntime({ OPENROUTER_API_KEY: "sk-test" });
		expect(runtime).not.toBeNull();
		expect(runtime).toMatchObject({
			routes: [
				expect.objectContaining({
					routeId: "sirawise-pilot-openrouter",
					routeRevision: "1",
					configRevision: "pilot-writers-full-cv-2026-11-21-v4",
					endpoint: "https://openrouter.ai/api/v1",
					model: "openai/gpt-6-luna",
					downstreamProvider: "azure",
					reasoningEffort: "low",
					apiKey: "sk-test",
					evidenceVersion: "pilot-2026-11-20-owner-approved",
					maxCalls: 2,
					maxRepairs: 0,
					callTimeoutMs: 60000,
					transientRetries: 1,
					deadlineMs: 120000,
					maxInputCodePoints: 32000,
					maxOutputTokens: 4096,
					maxCallCostMicros: 100000,
					requestCapMicros: 200000,
					dayCapMicros: 50000000,
					writers: expect.arrayContaining([
						expect.objectContaining({ model: "openai/gpt-6.1-terra", reasoningEffort: "medium" }),
						expect.objectContaining({ model: "openai/gpt-6-luna", reasoningEffort: "high" }),
					]),
					verifier: expect.objectContaining({
						backup: null,
						policy: expect.objectContaining({ model: "deepseek/deepseek-v4.1-flash-1017" }),
					}),
				}),
			],
			workerAvailable: true,
		});
		expect(runtime?.fetch).toBeUndefined();
		expect(runtime?.localOwnerAllowance).toBeUndefined();
		expect(Object.keys(runtime?.handlers ?? {})).toEqual(
			expect.arrayContaining(["review.extraction", "review.wording", "review.cover-letter"]),
		);
		expect(productionAiRoute.routeId).toBe("sirawise-pilot-openrouter");
		expect(productionAiRoute.concurrency).toBe(100);
	});

	it.each([
		{ kind: "review.translation", callTimeoutMs: 90_000, deadlineMs: 240_000 },
		{ kind: "review.wording", callTimeoutMs: 60_000, deadlineMs: 120_000 },
		{ kind: "review.extraction", callTimeoutMs: 60_000, deadlineMs: 120_000 },
		{ kind: "review.summary", callTimeoutMs: 60_000, deadlineMs: 120_000 },
		{ kind: "review.job-evidence", callTimeoutMs: 90_000, deadlineMs: 240_000 },
	])(
		"resolves the production $kind writer and verifier timeout without changing spend limits",
		({ kind, callTimeoutMs, deadlineMs }) => {
			const runtime = createProductionAiRuntime({ OPENROUTER_API_KEY: "sk-test" });
			const route = runtime?.routes[0];
			if (!route) throw new Error("Expected a configured route");
			const writer = resolveWriterRoute(route, { kind, parameters: {} });
			const verifier = resolveReviewVerifierRoute(writer);
			for (const selected of [writer, verifier]) {
				expect(selected).toMatchObject({
					callTimeoutMs,
					deadlineMs,
					maxCalls: 2,
					maxRepairs: 0,
					maxCallCostMicros: 100000,
					requestCapMicros: 200000,
					dayCapMicros: 50000000,
				});
			}
		},
	);

	it("makes AI available inside the runtime", () => {
		const runtime = createProductionAiRuntime({ OPENROUTER_API_KEY: "sk-test" });
		if (!runtime) throw new Error("Expected a configured runtime");
		expect(withAiRuntime(runtime, getAiAvailability)).toEqual({ state: "ready", reason: null });
	});
});

it("requires exact backup receipts and fresh notice and configuration revisions while preserving the route revision", () => {
	const runtime = createProductionAiRuntime({ OPENROUTER_API_KEY: "synthetic" });
	const current = runtime?.routes[0];
	if (!runtime || !current?.verifier) throw new Error("Missing route fixture");
	const { tuple } = resolvePrimaryContract(current, "translation", translationCandidateContract);
	const proof = "synthetic";
	const route = {
		...current,
		verifier: {
			...current.verifier,
			backup: {
				endpoint: current.endpoint,
				model: tuple.verifierModel,
				downstreamProvider: "parasail",
				providerEndpoint: "parasail/bf16",
				precision: "bf16" as const,
				evidenceVersion: proof,
				maxCallCostMicros: 10_000,
				processor: {
					availability: proof,
					location: proof,
					contract: proof,
					retention: proof,
					zdr: proof,
					dataCollectionDenial: proof,
					fullPrecision: proof,
					structuredOutput: proof,
					callBound: proof,
					purposes: ["review.translation"] as const,
				},
				qualified: [
					{ kind: "review.translation" as const, writerModel: tuple.writerModel, verifierModel: tuple.verifierModel },
				],
			},
		},
	};
	const kind = "review.translation";
	const backup = resolveReviewVerifierRoutes(resolveWriterRoute(route, { kind, parameters: {} }), kind).backup;
	if (!backup) throw new Error("Missing backup fixture");
	const primary = { ...tuple, manifestSha256: "b".repeat(64), scoredReceiptsSha256: "c".repeat(64) };
	const receipt = { ...primary, endpointSlot: "backup" as const, routeSha256: canonicalVerifierRouteSha256(backup) };
	const expanded = { ...route, noticeVersion: "2", configRevision: "synthetic-expanded" };
	for (const [routes, selections] of [
		[[route], [primary, receipt]],
		[[{ ...expanded, noticeVersion: current.noticeVersion }], [primary, receipt]],
		[[{ ...expanded, configRevision: current.configRevision }], [primary, receipt]],
		[[expanded], [receipt]],
		[[expanded], [primary, { ...receipt, routeSha256: "d".repeat(64) }]],
	] as const) {
		expect(
			bindQualifiedReviewHandlers({ ...runtime, routes }, selections).routes[0]?.verifier?.backup?.qualified,
		).toEqual([]);
	}
	const bound = bindQualifiedReviewHandlers({ ...runtime, routes: [expanded] }, [primary, receipt]).routes[0];
	expect(bound).toMatchObject({ routeRevision: current.routeRevision, dayCapMicros: current.dayCapMicros });
	expect(bound?.verifier?.backup?.qualified).toEqual(route.verifier.backup.qualified);
});
