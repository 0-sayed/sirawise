import { expect, it } from "vite-plus/test";
import { completionTokenLimit } from "./route-policy";
import { syntheticRoute } from "./testing/runtime";
import {
	canonicalVerifierRouteSha256,
	reviewVerifierPolicy,
	resolveReviewVerifierRoute,
	resolveReviewVerifierRoutes,
} from "./verifier-policy";

it("requires complete processor evidence and a matching feature and model tuple for the backup", () => {
	const writer = {
		...syntheticRoute,
		verifier: {
			evidenceVersion: "synthetic",
			maxCallCostMicros: 3333,
			backup: {
				endpoint: syntheticRoute.endpoint,
				model: "deepseek/deepseek-v4.1-flash-1017",
				downstreamProvider: "parasail",
				providerEndpoint: "parasail/bf16",
				precision: "bf16" as const,
				evidenceVersion: "synthetic",
				maxCallCostMicros: 1000,
				processor: {
					availability: "synthetic",
					location: "synthetic",
					contract: "synthetic",
					retention: "synthetic",
					zdr: "synthetic",
					dataCollectionDenial: "synthetic",
					fullPrecision: "synthetic",
					structuredOutput: "synthetic",
					callBound: "synthetic",
					purposes: ["review.translation"] as const,
				},
				qualified: [
					{
						kind: "review.translation" as const,
						writerModel: syntheticRoute.model,
						verifierModel: "deepseek/deepseek-v4.1-flash-1017",
					},
				],
			},
		},
	};
	expect(resolveReviewVerifierRoutes(writer, "review.translation").backup).toMatchObject({
		routeRevision: writer.routeRevision,
		downstreamProvider: "parasail",
		maxCallCostMicros: 1000,
	});
	expect(resolveReviewVerifierRoutes(writer, "review.extraction").backup).toBeUndefined();
	expect(
		resolveReviewVerifierRoutes({ ...writer, model: "other/writer" }, "review.translation").backup,
	).toBeUndefined();
	expect(
		resolveReviewVerifierRoutes(
			{
				...writer,
				verifier: {
					...writer.verifier,
					backup: { ...writer.verifier.backup, processor: { ...writer.verifier.backup.processor, contract: "" } },
				},
			},
			"review.translation",
		).backup,
	).toBeUndefined();
});

it("hashes the exact effective route without hashing credentials or consent evidence", () => {
	const route = resolveReviewVerifierRoute(syntheticRoute);
	const hash = canonicalVerifierRouteSha256(route);
	expect(canonicalVerifierRouteSha256({ ...route, apiKey: "other-synthetic", evidenceVersion: "updated-notice" })).toBe(
		hash,
	);
	for (const change of [
		{ endpoint: "https://backup.example.test" },
		{ downstreamProvider: "other" },
		{ reasoningEffort: "minimal" as const },
		{ maxInputCodePoints: 31000 },
		{ maxCallCostMicros: 20_000 },
	])
		expect(canonicalVerifierRouteSha256({ ...route, ...change })).not.toBe(hash);
});

it("pins the verifier independently of writer family", () => {
	expect(reviewVerifierPolicy("openai/gpt-6-luna")).toMatchObject({
		model: "deepseek/deepseek-v4.1-flash-1017",
		downstreamProvider: "together",
		reasoningEffort: "low",
	});
	expect(reviewVerifierPolicy("deepseek/deepseek-v4.1-flash-1017")).toMatchObject({
		model: "openai/gpt-6-luna",
		downstreamProvider: "azure",
		reasoningEffort: "low",
	});
});
it("requires approved verifier evidence and an independent cost bound in the route bundle", () => {
	expect(() => resolveReviewVerifierRoute({ ...syntheticRoute, verifier: undefined })).toThrow(
		"AI_VERIFIER_ROUTE_UNAPPROVED",
	);
});
it("preserves the operation consent/budget binding and switches the pinned provider", () => {
	const verifier = resolveReviewVerifierRoute({
		...syntheticRoute,
		model: "openai/gpt-6-luna",
		verifier: { evidenceVersion: "synthetic-v2", maxCallCostMicros: 1234 },
	});
	expect(verifier).toMatchObject({
		routeId: syntheticRoute.routeId,
		requestCapMicros: syntheticRoute.requestCapMicros,
		downstreamProvider: "together",
		model: "deepseek/deepseek-v4.1-flash-1017",
		maxCallCostMicros: 1234,
	});
});

it.each([0, -1, 16385, 1.5])("rejects an invalid independent verifier output allowance: %s", (maxOutputTokens) => {
	expect(() =>
		resolveReviewVerifierRoute({
			...syntheticRoute,
			model: "openai/gpt-6-luna",
			verifier: { evidenceVersion: "synthetic", maxCallCostMicros: 1234, maxOutputTokens },
		}),
	).toThrow("AI_INVALID_OUTPUT_LIMIT");
});

it("caps job evidence verification without reducing the translation allowance", () => {
	const writer = {
		...syntheticRoute,
		verifier: { evidenceVersion: "synthetic", maxCallCostMicros: 1234, maxOutputTokens: 16384 },
	};
	expect(completionTokenLimit(resolveReviewVerifierRoutes(writer, "review.job-evidence").primary)).toBe(12288);
	expect(completionTokenLimit(resolveReviewVerifierRoutes(writer, "review.translation").primary)).toBe(20480);
});
