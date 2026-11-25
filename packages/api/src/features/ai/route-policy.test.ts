import type { AiRuntime, ApprovedRoute } from "./route-policy";
import type { OperationRequest } from "@reactive-resume/schema/ai-operation";
import { expect, it, vi } from "vite-plus/test";
import { reviewHandlers } from "./review-handlers";
import {
	getAiAvailability,
	assertLegacyAiDenied,
	getOperationHandler,
	resolveApprovedRoute,
	withAiRuntime,
	withMeasuredReviewExecution,
	completionTokenLimit,
} from "./route-policy";
import { syntheticRoute } from "./testing/runtime";
import { resolveReviewVerifierRoute } from "./verifier-policy";

vi.mock("@reactive-resume/db/owner-scope", () => ({
	withOwnerDatabase: (_owner: string, work: (tx: unknown) => unknown) =>
		work({ select: () => ({ from: () => ({ where: () => Promise.resolve([{ id: "consent" }]) }) }) }),
}));

const route: ApprovedRoute = {
	...syntheticRoute,
	model: "openai/gpt-6-luna",
	downstreamProvider: "azure",
	reasoningEffort: "low",
	writers: [
		{
			model: "openai/gpt-6-luna",
			reasoningEffort: "high",
			downstreamProvider: "azure",
			evidenceVersion: "synthetic-extraction-high",
			maxCallCostMicros: 3000,
		},
		{
			model: "openai/gpt-6.1-terra",
			reasoningEffort: "medium",
			downstreamProvider: "azure",
			evidenceVersion: "synthetic-terra-medium",
			maxCallCostMicros: 2000,
		},
		{
			model: "deepseek/deepseek-v4.1-flash-1017",
			reasoningEffort: "low",
			downstreamProvider: "together",
			evidenceVersion: "synthetic-deepseek-low",
			maxCallCostMicros: 1000,
		},
	],
};
const runtime: AiRuntime = { routes: [route], handlers: reviewHandlers, workerAvailable: true };
const request = (kind = "review.wording"): OperationRequest => ({
	requestKey: "test",
	kind,
	sources: [{ kind: "resume", id: "test", revision: "1" }],
	route: { routeId: "synthetic", routeRevision: "1", configRevision: "1" },
	consentVersion: "1",
	parameters: {},
});

it("uses the approved translation timeout for both calls without expanding its other bounds", async () => {
	const approved = { ...route, translationCallTimeoutMs: 60000, maxCalls: 2, maxRepairs: 0 };
	const selected = await withAiRuntime({ ...runtime, routes: [approved] }, () =>
		resolveApprovedRoute("owner", request("review.translation")),
	);
	expect(selected).toMatchObject({
		callTimeoutMs: 60000,
		deadlineMs: 120000,
		maxCalls: 2,
		maxRepairs: 0,
		requestCapMicros: approved.requestCapMicros,
		maxCallCostMicros: approved.maxCallCostMicros,
		dayCapMicros: approved.dayCapMicros,
	});
	expect(resolveReviewVerifierRoute(selected).callTimeoutMs).toBe(60000);
});

it("admits the measured translation deadline and forwards it to the verifier without raising spend limits", async () => {
	const approved = withMeasuredReviewExecution(route);
	const selected = await withAiRuntime({ ...runtime, routes: [approved] }, () =>
		resolveApprovedRoute("owner", request("review.translation")),
	);
	expect(selected).toMatchObject({
		callTimeoutMs: 90_000,
		deadlineMs: 300_000,
		requestCapMicros: route.requestCapMicros,
		maxCallCostMicros: route.maxCallCostMicros,
		dayCapMicros: route.dayCapMicros,
	});
	expect(resolveReviewVerifierRoute(selected)).toMatchObject({ callTimeoutMs: 90_000, deadlineMs: 300_000 });
});

it.each(["review.translation", "review.tailoring"])(
	"rejects an unapproved 300-second deadline for %s",
	async (kind) => {
		await expect(
			withAiRuntime({ ...runtime, routes: [{ ...route, deadlineMs: 300_000 }] }, () =>
				resolveApprovedRoute("owner", request(kind)),
			),
		).rejects.toMatchObject({ data: { reason: "AI_NOT_ENABLED" } });
	},
);

it.each([
	"review.wording",
	"review.extraction",
	"review.job-evidence",
	"review.tailoring",
	"review.summary",
	"review.cover-letter",
	"review.interview-prep",
])("keeps %s writer and verifier timeouts at 30 seconds with a translation approval", async (kind) => {
	const approved = { ...route, translationCallTimeoutMs: 60000 };
	const selected = await withAiRuntime({ ...runtime, routes: [approved] }, () =>
		resolveApprovedRoute("owner", request(kind)),
	);
	expect(selected.callTimeoutMs).toBe(30000);
	expect(resolveReviewVerifierRoute(selected).callTimeoutMs).toBe(30000);
});

it.each([0, -1, 60001, 1.5, Number.NaN])(
	"rejects an invalid translation timeout: %s",
	async (translationCallTimeoutMs) => {
		await expect(
			withAiRuntime({ ...runtime, routes: [{ ...route, translationCallTimeoutMs }] }, () =>
				resolveApprovedRoute("owner", request("review.translation")),
			),
		).rejects.toMatchObject({ data: { reason: "AI_NOT_ENABLED" } });
	},
);

it.each(["review.translation", "review.wording"])("rejects an excessive shared timeout for %s", async (kind) => {
	await expect(
		withAiRuntime({ ...runtime, routes: [{ ...route, callTimeoutMs: 60001 }] }, () =>
			resolveApprovedRoute("owner", request(kind)),
		),
	).rejects.toMatchObject({ data: { reason: "AI_NOT_ENABLED" } });
});

it("keeps real processing disabled regardless of environment credentials or request flags", () => {
	expect(getAiAvailability()).toEqual({ state: "not_enabled", reason: "NO_APPROVED_ROUTE" });
	expect(() => assertLegacyAiDenied()).toThrow();
	expect(() => getOperationHandler("arbitrary-tool")).toThrow();
});

it.each([
	["review.wording", "low", 5120, 3333],
	["review.extraction", "high", 20480, 3000],
])(
	"resolves the benchmark default for %s with its own completion and call bounds",
	async (kind, effort, tokens, cost) => {
		const selected = await withAiRuntime(runtime, () => resolveApprovedRoute("owner", request(kind)));
		expect(selected).toMatchObject({
			model: "openai/gpt-6-luna",
			reasoningEffort: effort,
			downstreamProvider: "azure",
			maxCallCostMicros: cost,
		});
		expect(completionTokenLimit(selected)).toBe(tokens);
		expect(resolveReviewVerifierRoute(selected)).toMatchObject({
			model: "deepseek/deepseek-v4.1-flash-1017",
			downstreamProvider: "together",
			reasoningEffort: "low",
			maxCallCostMicros: 3333,
		});
	},
);

it.each([
	["openai/gpt-6.1-terra", "medium", "deepseek/deepseek-v4.1-flash-1017", "together", 2000],
	["deepseek/deepseek-v4.1-flash-1017", "low", "openai/gpt-6-luna", "azure", 1000],
])(
	"accepts an approved %s override without changing cross-family verification",
	async (model, effort, verifier, provider, cost) => {
		const selected = await withAiRuntime(
			{ ...runtime, writerConfig: { "review.wording": { model, reasoningEffort: effort } } },
			() => resolveApprovedRoute("owner", request()),
		);
		expect(selected).toMatchObject({ model, reasoningEffort: effort, maxCallCostMicros: cost });
		expect(resolveReviewVerifierRoute(selected)).toMatchObject({
			model: verifier,
			downstreamProvider: provider,
			reasoningEffort: "low",
		});
	},
);

it.each([
	{ "review.wording": { model: "unknown/model", reasoningEffort: "low" } },
	{ "review.wording": { model: "openai/gpt-6-luna", reasoningEffort: "ultra" } },
	{ "review.wording": { model: "openai/gpt-6-luna", reasoningEffort: "medium" } },
	{ "review.wording": { model: "openai/gpt-6-luna", reasoningEffort: "low", downstreamProvider: "openai" } },
	{ "review.unsupported": { model: "openai/gpt-6.1-terra", reasoningEffort: "medium" } },
])("fails closed for unknown or unapproved model/effort configuration: %j", async (writerConfig) => {
	await expect(
		withAiRuntime({ ...runtime, writerConfig }, () => resolveApprovedRoute("owner", request())),
	).rejects.toMatchObject({ data: { reason: "AI_NOT_ENABLED" } });
});

it.each([{ answerIds: undefined }, { answerIds: [] }])(
	"uses Terra medium for the existing result-question mode with %j",
	async ({ answerIds }) => {
		const selected = await withAiRuntime(runtime, () =>
			resolveApprovedRoute("owner", { ...request(), parameters: { action: "result", answerIds } }),
		);
		expect(selected).toMatchObject({
			model: "openai/gpt-6.1-terra",
			reasoningEffort: "medium",
			downstreamProvider: "azure",
			maxCallCostMicros: 2000,
		});
		expect(completionTokenLimit(selected)).toBe(8192);
		expect(resolveReviewVerifierRoute(selected)).toMatchObject({
			model: "deepseek/deepseek-v4.1-flash-1017",
			reasoningEffort: "low",
		});
	},
);

it("uses the wording default after the user supplies the requested outcome", async () => {
	const selected = await withAiRuntime(runtime, () =>
		resolveApprovedRoute("owner", { ...request(), parameters: { action: "result", answerIds: ["answer"] } }),
	);
	expect(selected).toMatchObject({ model: "openai/gpt-6-luna", reasoningEffort: "low" });
});

it("fails closed when the bundle has no approved Terra question writer", async () => {
	await expect(
		withAiRuntime({ ...runtime, routes: [{ ...route, writers: [] }] }, () =>
			resolveApprovedRoute("owner", { ...request(), parameters: { action: "result" } }),
		),
	).rejects.toMatchObject({ data: { reason: "AI_NOT_ENABLED" } });
});

it("does not fall back to the base writer when the bundle lacks the configured model", async () => {
	await expect(
		withAiRuntime({ ...runtime, routes: [{ ...route, writers: [] }] }, () =>
			resolveApprovedRoute("owner", request("review.extraction")),
		),
	).rejects.toMatchObject({ data: { reason: "AI_NOT_ENABLED" } });
});

it.each(["openai", "together"])("rejects a non-Azure OpenAI writer approval on %s", async (downstreamProvider) => {
	await expect(
		withAiRuntime({ ...runtime, routes: [{ ...route, downstreamProvider }] }, () =>
			resolveApprovedRoute("owner", request()),
		),
	).rejects.toMatchObject({ data: { reason: "AI_NOT_ENABLED" } });
});

it("checks the selected writer's call bound against the request cap before dispatch", async () => {
	await expect(
		withAiRuntime(
			{
				...runtime,
				routes: [
					{ ...route, writers: (route.writers ?? []).map((writer) => ({ ...writer, maxCallCostMicros: 4000 })) },
				],
			},
			() => resolveApprovedRoute("owner", request("review.extraction")),
		),
	).rejects.toMatchObject({ data: { reason: "AI_NOT_ENABLED" } });
});

it("includes the independently approved verifier bound in the selected writer's request budget", async () => {
	await expect(
		withAiRuntime(
			{ ...runtime, routes: [{ ...route, verifier: { evidenceVersion: "synthetic", maxCallCostMicros: 5000 } }] },
			() => resolveApprovedRoute("owner", request("review.extraction")),
		),
	).rejects.toMatchObject({ data: { reason: "AI_NOT_ENABLED" } });
});

it.each([
	{ routeRevision: "unapproved" },
	{ configRevision: "unapproved" },
	{ noticeVersion: "unapproved" },
	{ evidenceVersion: "" },
])("does not let writer configuration bypass the outer approved bundle: %j", async (binding) => {
	await expect(
		withAiRuntime({ ...runtime, routes: [{ ...route, ...binding }] }, () =>
			resolveApprovedRoute("owner", request("review.extraction")),
		),
	).rejects.toMatchObject({ data: { reason: "AI_NOT_ENABLED" } });
});

it.each([{ evidenceVersion: "" }, { maxCallCostMicros: 0 }, { downstreamProvider: "openai" }])(
	"requires evidence, metering and Azure on an additional writer approval: %j",
	async (approval) => {
		await expect(
			withAiRuntime(
				{
					...runtime,
					routes: [{ ...route, writers: (route.writers ?? []).map((writer) => ({ ...writer, ...approval })) }],
				},
				() => resolveApprovedRoute("owner", request("review.extraction")),
			),
		).rejects.toMatchObject({ data: { reason: "AI_NOT_ENABLED" } });
	},
);

it.each([-1, 2, 1.5, Number.NaN])(
	"rejects an invalid translation transient retry allowance: %s",
	async (translationTransientRetries) => {
		await expect(
			withAiRuntime({ ...runtime, routes: [{ ...route, translationTransientRetries }] }, () =>
				resolveApprovedRoute("owner", request("review.translation")),
			),
		).rejects.toMatchObject({ data: { reason: "AI_NOT_ENABLED" } });
	},
);

it.each([
	"review.wording",
	"review.extraction",
	"review.job-evidence",
	"review.tailoring",
	"review.summary",
	"review.cover-letter",
	"review.interview-prep",
	"review.translation",
])("uses the bounded shared long-CV timeout for %s", async (kind) => {
	const selected = await withAiRuntime({ ...runtime, routes: [{ ...route, callTimeoutMs: 60000 }] }, () =>
		resolveApprovedRoute("owner", request(kind)),
	);
	expect(selected.callTimeoutMs).toBe(60000);
	expect(resolveReviewVerifierRoute(selected).callTimeoutMs).toBe(60000);
	expect(selected.requestCapMicros).toBe(route.requestCapMicros);
});
