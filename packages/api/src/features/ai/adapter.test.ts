import { once } from "node:events";
import { createServer } from "node:http";
import net from "node:net";
import { expect, it, vi } from "vite-plus/test";
import { ORPCError } from "@orpc/server";
import { zodSchema } from "ai";
import { z } from "zod";
import { masterFields } from "@reactive-resume/schema/career-master";
import {
	AI_CONNECT_ATTEMPT_TIMEOUT_MS,
	AiTransportError,
	ensureAiTransportConnectBudget,
	executeApprovedStep,
	failedBeforeDispatch,
	translationWriterCallBound,
	verificationCallBound,
	type ApprovedStepInput,
} from "./adapter";
import { buildModelPayload } from "./payload";
import { reviewHandlers } from "./review-handlers";
import { boundQuestionEvidence } from "./review-sources";
import { withAiRuntime } from "./route-policy";
import { syntheticRoute, syntheticRuntime } from "./testing/runtime";

it("enforces the priced verifier's journaled bound before sending the exact structured request", async () => {
	const route = {
		...syntheticRoute,
		model: "deepseek/deepseek-v4.1-flash-1017",
		downstreamProvider: "together",
		boundByTogetherPricing: true,
		maxCallCostMicros: 100_000,
		maxOutputTokens: 16_384,
		reasoningEffort: "low" as const,
	};
	const input: ApprovedStepInput = {
		route,
		operationId: "operation",
		attemptId: "attempt",
		stepId: "verify",
		payload: { selections: [{ section: "summary", text: "خبرة في تطوير البرمجيات" }] },
		outputSchema: z.strictObject({ text: z.string() }),
		signal: new AbortController().signal,
	};
	const bound = await verificationCallBound(route, input);
	expect(bound).toBeGreaterThan(24_576);
	expect(bound).toBeLessThan(45_000);
	if (!syntheticRuntime.fetch) throw new Error("Missing synthetic transport");
	const fetch = vi.fn(syntheticRuntime.fetch);
	await withAiRuntime({ ...syntheticRuntime, fetch }, async () => {
		const result = await executeApprovedStep({ ...input, verificationBoundMicros: bound });
		expect(result.outcome).toBe("valid");
		expect(JSON.parse(String(fetch.mock.calls[0]?.[1]?.body))).toMatchObject({
			max_tokens: 20_480,
			provider: {
				only: ["together"],
				max_price: { prompt: 0.3, completion: 1.2, request: 0 },
				allow_fallbacks: false,
				require_parameters: true,
				data_collection: "deny",
				zdr: true,
			},
		});
		const blocked = await executeApprovedStep({
			...input,
			verificationBoundMicros: bound,
			payload: { selections: [{ section: "summary", text: "界".repeat(2000) }] },
		});
		expect(blocked).toMatchObject({ outcome: "unsupported", costMicros: 0 });
		expect(fetch).toHaveBeenCalledTimes(1);
	});
});

it.each([
	[new Error("AI_CANCELLED"), "AI_CANCELLED"],
	[new Error("AI_REQUEST_COST_LIMIT"), "AI_REQUEST_COST_LIMIT"],
	[new ORPCError("CONFLICT", { data: { reason: "AI_SOURCE_CHANGED" } }), "AI_SOURCE_CHANGED"],
])("records a dispatch rejection without a provider call (%s)", async (error, code) => {
	const fetch = vi.fn(syntheticRuntime.fetch);
	const result = await withAiRuntime({ ...syntheticRuntime, fetch }, () =>
		executeApprovedStep({
			route: syntheticRoute,
			operationId: "guarded-operation",
			attemptId: "attempt",
			stepId: "generate",
			payload: { selections: [{ section: "summary", text: "TypeScript" }] },
			outputSchema: z.strictObject({ text: z.string() }),
			signal: new AbortController().signal,
			withDispatch: async () => {
				throw error;
			},
		}),
	);
	expect(result).toMatchObject({
		outcome: "unknown",
		costMicros: 0,
		failure: { requestSent: false, dispatchFailureCode: code },
	});
	expect(result.failure?.timedOut).toBeUndefined();
	expect(fetch).not.toHaveBeenCalled();
});

it("rejects a paid writer request whose enforced token pricing exceeds 100000 micros before dispatch", async () => {
	const fetch = vi.fn(syntheticRuntime.fetch);
	const route = {
		...syntheticRoute,
		model: "openai/gpt-6.1-terra",
		downstreamProvider: "azure",
		evidenceVersion: "paid-route-fixture",
		maxCallCostMicros: 100_000,
		maxOutputTokens: 16_384,
		reasoningEffort: "high" as const,
	};
	const result = await withAiRuntime({ ...syntheticRuntime, fetch }, () =>
		executeApprovedStep({
			route,
			operationId: "operation",
			attemptId: "attempt",
			stepId: "generate",
			payload: { selections: [{ section: "summary", text: "Confirmed work." }] },
			outputSchema: z.strictObject({ text: z.string() }),
			signal: new AbortController().signal,
		}),
	);
	expect(result).toMatchObject({ outcome: "unsupported", costMicros: 0 });
	expect(fetch).not.toHaveBeenCalled();
});

it("dispatches a writer at the 100000-micro bound and blocks one extra byte", async () => {
	const fetch = vi.fn(syntheticRuntime.fetch);
	const input: ApprovedStepInput = {
		route: {
			...syntheticRoute,
			model: "openai/gpt-6.1-terra",
			downstreamProvider: "azure",
			evidenceVersion: "paid-route-fixture",
			maxCallCostMicros: 100_000,
			maxOutputTokens: 12_000,
			reasoningEffort: "none",
		},
		operationId: "operation",
		attemptId: "attempt",
		stepId: "generate",
		payload: { selections: [{ section: "summary", text: "" }] },
		outputSchema: z.strictObject({ text: z.string() }),
		signal: new AbortController().signal,
	};
	await withAiRuntime({ ...syntheticRuntime, fetch }, async () => {
		await executeApprovedStep(input);
		const wire = JSON.parse(String(fetch.mock.calls[0]?.[1]?.body));
		expect(wire.provider).toMatchObject({ only: ["azure"], require_parameters: true, allow_fallbacks: false });
		expect(wire.provider).not.toHaveProperty("max_price");
		expect(wire).not.toHaveProperty("prompt_cache_options");
		const promptBytes = Buffer.byteLength(
			JSON.stringify([wire.messages[0].content, wire.messages[1].content, wire.response_format.json_schema.schema]),
		);
		const limit = Math.floor((100_000 - wire.max_tokens * 6) / 1.2) - 4096 - promptBytes;
		const withText = (length: number): ApprovedStepInput => ({
			...input,
			payload: { selections: [{ section: "summary", text: "a".repeat(length) }] },
		});
		await executeApprovedStep(withText(limit));
		expect(fetch).toHaveBeenCalledTimes(2);
		expect(await executeApprovedStep(withText(limit + 1))).toMatchObject({ outcome: "unsupported", costMicros: 0 });
		expect(fetch).toHaveBeenCalledTimes(2);
	});
});

it("supplies the exact extraction field contract and executable claim-boundary examples to writers", () => {
	const extraction = reviewHandlers["review.extraction"].systemPrompt ?? "";
	const contract = JSON.parse(extraction.split("Extraction field contract: ")[1] ?? "null");
	expect(contract).toEqual(
		Object.fromEntries(Object.entries(masterFields).map(([key, value]) => [key, Object.keys(value.shape)])),
	);
	const wording = reviewHandlers["review.wording"].systemPrompt ?? "";
	const examples = [
		...wording.matchAll(/^Valid (?:wording|missing-info|injection|no-change) example .*: (\{.*\})$/gmu),
	];
	expect(examples).toHaveLength(4);
	for (const example of examples)
		expect(reviewHandlers["review.wording"].output.safeParse(JSON.parse(example[1] ?? "null")).success).toBe(true);
});

function assertStrictSchema(value: object, path = "$", root = value as Record<string, unknown>): void {
	const node = value as Record<string, unknown>;
	if (node.$ref) {
		const target = String(node.$ref)
			.split("/")
			.slice(1)
			.reduce((value, key) => value[key] as Record<string, unknown>, root);
		assertStrictSchema(target, path, root);
		return;
	}
	if (Array.isArray(node.anyOf)) {
		for (const branch of node.anyOf) assertStrictSchema(branch as Record<string, unknown>, path, root);
		return;
	}
	expect(node.type, `${path} requires a type`).toBeDefined();
	if (node.type === "object") {
		expect(node.additionalProperties, path).toBe(false);
		const properties = node.properties as Record<string, Record<string, unknown>>;
		expect([...((node.required as string[]) ?? [])].sort(), path).toEqual(Object.keys(properties).sort());
		for (const [key, value] of Object.entries(properties)) assertStrictSchema(value, `${path}.${key}`, root);
	}
	if (node.type === "array") assertStrictSchema(node.items as Record<string, unknown>, `${path}[]`, root);
}
it("converts every T006 writer and verifier with the adapter SDK conversion into strict output schemas", async () => {
	for (const handler of Object.values(reviewHandlers)) {
		if (!handler.verifier) throw new Error("Missing T006 verifier");
		for (const output of [handler.output, handler.verifier.output]) {
			assertStrictSchema(await zodSchema(output).jsonSchema);
		}
	}
});
it.each([400, 200])("classifies HTTP %s request-schema errors without disabling a model", async (status) => {
	let attempts = 0;
	const result = await replayTransport(async () => {
		attempts++;
		return Response.json(
			{
				error: { code: 400, message: "invalid_json_schema", metadata: { provider_error_code: "invalid_json_schema" } },
			},
			{ status },
		);
	});
	expect(result).toMatchObject({ outcome: "REQUEST_SCHEMA_ERROR", costMicros: 0 });
	expect(attempts).toBe(1);
});
it("preserves HTTP 400 classification when the provider supplies a string error code", async () => {
	const result = await replayTransport(async () =>
		Response.json({ error: { code: "invalid_json_schema", message: "Invalid schema" } }, { status: 400 }),
	);
	expect(result.outcome).toBe("REQUEST_SCHEMA_ERROR");
});

it("serializes one structured request with no fallback, bounded tokens and no SDK retries", async () => {
	let request: Record<string, unknown> = {};
	const fetch = vi.fn(async (_url: unknown, init?: RequestInit) => {
		request = JSON.parse(String(init?.body));
		return new Response(
			JSON.stringify({
				id: "response-1",
				model: "synthetic/model",
				provider: "Test",
				choices: [
					{ index: 0, message: { role: "assistant", content: '{"text":"Useful result"}' }, finish_reason: "stop" },
				],
				usage: { prompt_tokens: 4, completion_tokens: 3, total_tokens: 7, cost: 0.00001 },
			}),
			{ headers: { "content-type": "application/json" } },
		);
	});
	const result = await withAiRuntime({ routes: [syntheticRoute], handlers: {}, workerAvailable: true, fetch }, () =>
		executeApprovedStep({
			route: syntheticRoute,
			operationId: "op",
			attemptId: "attempt",
			stepId: "answer",
			payload: { selections: [{ section: "skills", text: "TypeScript" }] },
			outputSchema: z.strictObject({ text: z.string() }),
			signal: new AbortController().signal,
		}),
	);
	expect(result).toMatchObject({
		outcome: "valid",
		output: { text: "Useful result" },
		responseId: "response-1",
		observedModel: "synthetic/model",
		observedProvider: "Test",
		costMicros: 10,
	});
	expect(request).toMatchObject({
		model: "synthetic/model",
		max_tokens: 4096,
		provider: { only: ["Test"], allow_fallbacks: false, require_parameters: true, data_collection: "deny", zdr: true },
		response_format: { type: "json_schema" },
	});
	expect(request).not.toHaveProperty("tools");
	expect(fetch).toHaveBeenCalledTimes(1);
});

it.each([
	["length", '{"text":"Partial"}', "truncated"],
	["content_filter", "", "refusal"],
	["stop", '{"wrong":true}', "invalid"],
])("rejects %s output and preserves measured expense", async (finish, content, outcome) => {
	const fetch = vi.fn(
		async () =>
			new Response(
				JSON.stringify({
					id: "response",
					choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: finish }],
					usage: {
						prompt_tokens: 4,
						completion_tokens: 3,
						completion_tokens_details: { reasoning_tokens: 2 },
						total_tokens: 7,
						cost: 0.00001,
					},
				}),
				{ headers: { "content-type": "application/json" } },
			),
	);
	const result = await withAiRuntime({ routes: [syntheticRoute], handlers: {}, workerAvailable: true, fetch }, () =>
		executeApprovedStep({
			route: syntheticRoute,
			operationId: "op",
			attemptId: "attempt",
			stepId: "generate",
			payload: { selections: [{ section: "skills", text: "TypeScript" }] },
			outputSchema: z.strictObject({ text: z.string() }),
			signal: new AbortController().signal,
		}),
	);
	expect(result).toMatchObject({ outcome, output: null, costMicros: 10, outputTokens: 3, reasoningTokens: 2 });
	expect(fetch).toHaveBeenCalledTimes(1);
});

it("holds ambiguous billing without retrying a dispatched request after owner cancellation", async () => {
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), 5);
	const fetch = vi.fn(
		(_url: unknown, init?: RequestInit) =>
			new Promise<Response>((_resolve, reject) => {
				const signal = init?.signal;
				if (!signal) throw new Error("Missing abort signal");
				if (signal.aborted) reject(signal.reason);
				else signal.addEventListener("abort", () => reject(signal.reason), { once: true });
			}),
	);
	const pending = withAiRuntime({ routes: [syntheticRoute], handlers: {}, workerAvailable: true, fetch }, () =>
		executeApprovedStep({
			route: { ...syntheticRoute, callTimeoutMs: 5 },
			operationId: "op",
			attemptId: "attempt",
			stepId: "answer",
			payload: { selections: [{ section: "skills", text: "TypeScript" }] },
			outputSchema: z.strictObject({ text: z.string() }),
			signal: controller.signal,
		}),
	);
	const result = await pending;
	clearTimeout(timer);
	expect(result).toMatchObject({ outcome: "transient", output: null, costMicros: null });
	expect(fetch).toHaveBeenCalledTimes(1);
});

it("identifies a provider call timeout without retrying its unknown expense", async () => {
	let calls = 0;
	const result = await withAiRuntime(
		{
			...syntheticRuntime,
			fetch: (_url: unknown, init?: RequestInit) =>
				new Promise<Response>((_resolve, reject) => {
					calls++;
					const signal = init?.signal;
					if (!signal) throw new Error("Missing abort signal");
					if (signal.aborted) reject(signal.reason);
					else signal.addEventListener("abort", () => reject(signal.reason), { once: true });
				}),
		},
		() =>
			executeApprovedStep({
				route: { ...syntheticRoute, callTimeoutMs: 5 },
				operationId: "timeout",
				attemptId: "attempt",
				stepId: "generate",
				payload: { selections: [{ section: "skills", text: "TypeScript" }] },
				outputSchema: z.strictObject({ text: z.string() }),
				signal: new AbortController().signal,
			}),
	);
	expect(result).toMatchObject({
		output: null,
		inputTokens: null,
		outputTokens: null,
		costMicros: null,
		failure: { timedOut: true, abortCause: "call_timeout" },
	});
	expect(calls).toBe(1);
});

it.each(["cancelled", "operation_deadline"] as const)(
	"distinguishes %s from a verifier call timeout",
	async (cause) => {
		const controller = new AbortController();
		const result = await withAiRuntime(
			{
				...syntheticRuntime,
				fetch: async (_url, init) => {
					controller.abort(new Error(cause === "cancelled" ? "AI_CANCELLED" : "AI_DEADLINE"));
					init?.signal?.throwIfAborted();
					throw new Error("Expected abort");
				},
			},
			() =>
				executeApprovedStep(
					{
						route: syntheticRoute,
						operationId: "aborted",
						attemptId: "attempt",
						stepId: "verify",
						payload: { selections: [] },
						outputSchema: z.strictObject({ text: z.string() }),
						signal: controller.signal,
					},
					{ retry: false },
				),
		);
		expect(result).toMatchObject({ costMicros: null, output: null, failure: { abortCause: cause } });
		expect(result.failure?.timedOut).toBeUndefined();
	},
);

it("keeps a measured transport cost when the operation is cancelled", async () => {
	const controller = new AbortController();
	const result = await withAiRuntime(
		{
			...syntheticRuntime,
			fetch: async () => {
				controller.abort();
				throw new AiTransportError(controller.signal.reason, {
					httpStatus: null,
					bytesReceived: false,
					generationId: null,
					costMicros: 700,
				});
			},
		},
		() =>
			executeApprovedStep(
				{
					route: syntheticRoute,
					operationId: "cancelled",
					attemptId: "measured",
					stepId: "verify",
					payload: { selections: [] },
					outputSchema: z.strictObject({ text: z.string() }),
					signal: controller.signal,
				},
				{ retry: false },
			),
	);
	expect(result).toMatchObject({ costMicros: 700, output: null, failure: { abortCause: "cancelled" } });
});

it.each([
	{ model: "other/model", provider: "Test" },
	{ model: "synthetic/model", provider: "Other" },
	{ model: "synthetic/model" },
	{ provider: "Test" },
])("rejects a usable verifier response without the exact observed identity (%j)", async (identity) => {
	const fetch = vi.fn(async () =>
		Response.json({
			...identity,
			id: "synthetic-verifier",
			choices: [{ index: 0, message: { role: "assistant", content: '{"text":"checked"}' }, finish_reason: "stop" }],
			usage: { prompt_tokens: 4, completion_tokens: 3, total_tokens: 7, cost: 0.00001 },
		}),
	);
	const result = await withAiRuntime({ ...syntheticRuntime, fetch }, () =>
		executeApprovedStep(
			{
				route: syntheticRoute,
				operationId: "identity",
				attemptId: "attempt",
				stepId: "verify",
				payload: { selections: [] },
				outputSchema: z.strictObject({ text: z.string() }),
				signal: new AbortController().signal,
			},
			{ retry: false },
		),
	);
	expect(result).toMatchObject({
		outcome: "invalid",
		output: null,
		costMicros: 10,
		responseId: "synthetic-verifier",
		observedModel: identity.model ?? null,
		observedProvider: identity.provider ?? null,
		failure: { code: "AI_VERIFIER_IDENTITY_MISMATCH" },
	});
	expect(fetch).toHaveBeenCalledTimes(1);
});

it.each([400, 401, 402, 403, 408, 429, 500, 502, 503])(
	"settles definitive HTTP %s rejection at zero cost",
	async (status) => {
		vi.useFakeTimers();
		const pending = withAiRuntime(
			{
				routes: [syntheticRoute],
				handlers: {},
				workerAvailable: true,
				fetch: async () =>
					new Response('{"error":{"message":"Rejected"}}', { status, headers: { "content-type": "application/json" } }),
			},
			() =>
				executeApprovedStep({
					route: syntheticRoute,
					operationId: "op",
					attemptId: "a",
					stepId: "generate",
					payload: { selections: [{ section: "skills", text: "TypeScript" }] },
					outputSchema: z.strictObject({ text: z.string() }),
					signal: new AbortController().signal,
				}),
		);
		await vi.runAllTimersAsync();
		const result = await pending;
		vi.useRealTimers();
		expect(result.costMicros).toBe(0);
		if (status === 408) expect(result.outcome).toBe("transient");
		expect(result.output).toBeNull();
	},
);
it("keeps a lost response after partial output conservatively unknown", async () => {
	const result = await withAiRuntime(
		{
			routes: [syntheticRoute],
			handlers: {},
			workerAvailable: true,
			fetch: async () =>
				new Response(
					new ReadableStream({
						start(controller) {
							controller.enqueue(new TextEncoder().encode('{"choices":[{"message":{"content":"partial'));
						},
						pull(controller) {
							controller.error(new Error("Connection lost"));
						},
					}),
				),
		},
		() =>
			executeApprovedStep({
				route: syntheticRoute,
				operationId: "op",
				attemptId: "a",
				stepId: "generate",
				payload: { selections: [{ section: "skills", text: "TypeScript" }] },
				outputSchema: z.strictObject({ text: z.string() }),
				signal: new AbortController().signal,
			}),
	);
	expect(result).toMatchObject({ costMicros: null, outcome: "unknown", output: null });
});

const throttled = {
	error: {
		code: 429,
		message: "openai/gpt-6-luna is temporarily rate-limited upstream...",
		metadata: { error_type: "rate_limit_exceeded" },
	},
};
it("preserves the nested connection cause while removing embedded headers", async () => {
	const controller = new AbortController();
	const failures: unknown[] = [];
	const pending = withAiRuntime(
		{
			routes: [],
			handlers: {},
			workerAvailable: true,
			fetch: async () => {
				throw new TypeError("fetch failed", {
					cause: new Error('connect ECONNREFUSED; "headers":{"x-secret":"private-value"}'),
				});
			},
		},
		() =>
			executeApprovedStep(
				{
					route: syntheticRoute,
					operationId: "op",
					attemptId: "a",
					stepId: "answer",
					payload: { selections: [] },
					outputSchema: z.object({ text: z.string() }),
					signal: controller.signal,
				},
				{
					concurrencyLimit: 2,
					onAttempt: async (r) => {
						failures.push(r.failure);
						controller.abort();
					},
				},
			),
	);
	await pending;
	expect(failures).toEqual([
		expect.objectContaining({ causes: [{ errorClass: "Error", message: 'connect ECONNREFUSED; "[REDACTED]' }] }),
	]);
	expect(JSON.stringify(failures)).not.toContain("private-value");
});
async function replayTransport(fetch: typeof globalThis.fetch, signal = new AbortController().signal) {
	return withAiRuntime({ routes: [], handlers: {}, workerAvailable: true, fetch }, () =>
		executeApprovedStep({
			route: syntheticRoute,
			operationId: "op",
			attemptId: "a",
			stepId: "answer",
			payload: { selections: [] },
			outputSchema: z.object({ text: z.string() }),
			signal,
		}),
	);
}
it.each([TypeError, Error])(
	"retries an established pre-dispatch %s and preserves sanitized attempt diagnostics",
	async (ErrorClass) => {
		vi.useFakeTimers();
		try {
			const failures: unknown[] = [];
			let sends = 0;
			const pending = withAiRuntime(
				{
					routes: [],
					handlers: {},
					workerAvailable: true,
					fetch: async () => {
						if (++sends === 1)
							throw Object.assign(
								new ErrorClass(`connection failed ${syntheticRoute.apiKey}\nAuthorization: Bearer private-token`),
								{ code: "ECONNREFUSED" },
							);
						return Response.json({
							id: "recovered",
							choices: [
								{ index: 0, message: { role: "assistant", content: '{"text":"safe"}' }, finish_reason: "stop" },
							],
							usage: { prompt_tokens: 4, completion_tokens: 3, cost: 0.00001 },
						});
					},
				},
				() =>
					executeApprovedStep(
						{
							route: syntheticRoute,
							operationId: "op",
							attemptId: "a",
							stepId: "answer",
							payload: { selections: [] },
							outputSchema: z.object({ text: z.string() }),
							signal: new AbortController().signal,
						},
						{
							concurrencyLimit: 2,
							onAttempt: async (r) => {
								failures.push(r.failure);
							},
						},
					),
			);
			await vi.runAllTimersAsync();
			expect(await pending).toMatchObject({ outcome: "valid", costMicros: 10 });
			expect(failures).toEqual([
				expect.objectContaining({
					errorClass: ErrorClass.name,
					httpStatus: null,
					bytesReceived: false,
					generationId: null,
					message: "connection failed [REDACTED]",
				}),
			]);
			expect(JSON.stringify(failures)).not.toContain("private-token");
		} finally {
			vi.useRealTimers();
		}
	},
);
it("retries HTTP 200 upstream errors with identical pinned requests and accounts for billed attempts", async () => {
	vi.useFakeTimers();
	try {
		const bodies: string[] = [];
		const pending = replayTransport(async (_url, init) => {
			bodies.push(String(init?.body));
			if (bodies.length === 1)
				return Response.json(
					{ ...throttled, usage: { prompt_tokens: 2, completion_tokens: 1, cost: 0.000002 } },
					{ headers: { "retry-after": "2" } },
				);
			return Response.json({
				id: "ok",
				choices: [{ index: 0, message: { role: "assistant", content: '{"text":"safe"}' }, finish_reason: "stop" }],
				usage: { prompt_tokens: 4, completion_tokens: 3, cost: 0.00001 },
			});
		});
		await vi.advanceTimersByTimeAsync(1999);
		expect(bodies).toHaveLength(1);
		await vi.runAllTimersAsync();
		expect(await pending).toMatchObject({ outcome: "valid", costMicros: 12, inputTokens: 6, outputTokens: 4 });
		expect(bodies).toHaveLength(2);
		expect(bodies[1]).toBe(bodies[0]);
	} finally {
		vi.useRealTimers();
	}
});
it.each([200, 429, 502, 503])(
	"bounds transient retries for HTTP %s without charging unbilled failures",
	async (status) => {
		vi.useFakeTimers();
		try {
			let attempts = 0;
			const pending = replayTransport(async () => {
				attempts++;
				return Response.json(throttled, { status });
			});
			await vi.runAllTimersAsync();
			expect(await pending).toMatchObject({ outcome: "transient", output: null, costMicros: 0 });
			expect(attempts).toBe(5);
		} finally {
			vi.useRealTimers();
		}
	},
);
it("leaves transient retries to the durable caller when transport retries are disabled", async () => {
	vi.useFakeTimers();
	try {
		const fetch = vi.fn(async () => Response.json(throttled, { status: 503 }));
		const pending = withAiRuntime({ ...syntheticRuntime, fetch }, () =>
			executeApprovedStep(
				{
					route: syntheticRoute,
					operationId: "op",
					attemptId: "attempt",
					stepId: "generate",
					payload: { selections: [] },
					outputSchema: z.strictObject({ text: z.string() }),
					signal: new AbortController().signal,
				},
				{ retry: false },
			),
		);
		await vi.runAllTimersAsync();
		expect(await pending).toMatchObject({ outcome: "transient", output: null, costMicros: 0 });
		expect(fetch).toHaveBeenCalledTimes(1);
	} finally {
		vi.useRealTimers();
	}
});

it("limits concurrent calls to two per model and releases slots", async () => {
	let active = 0;
	let peak = 0;
	const release: (() => void)[] = [];
	const fetch: typeof globalThis.fetch = async () => {
		active++;
		peak = Math.max(peak, active);
		await new Promise<void>((resolve) => release.push(resolve));
		active--;
		return Response.json({ error: { code: 400, message: "unsupported" } }, { status: 400 });
	};
	const pending = Array.from({ length: 5 }, () => replayTransport(fetch));
	for (let i = 0; i < 10; i++) {
		await new Promise((resolve) => setTimeout(resolve, 0));
		release.splice(0).forEach((resolve) => resolve());
	}
	await Promise.all(pending);
	expect(peak).toBe(2);
	expect(active).toBe(0);
});

it("checks revoked consent after the verifier slot opens and records zero cost", async () => {
	const started = Promise.withResolvers<void>();
	const release = Promise.withResolvers<void>();
	const fetch = vi.fn(async () => {
		started.resolve();
		await release.promise;
		return Response.json({ error: { code: 400, message: "unsupported" } }, { status: 400 });
	});
	const input = {
		route: syntheticRoute,
		operationId: "op",
		attemptId: "attempt",
		stepId: "verify",
		payload: { selections: [{ section: "skills" as const, text: "TypeScript" }] },
		outputSchema: z.strictObject({ text: z.string() }),
		signal: new AbortController().signal,
	};
	let consent = true;
	const withDispatch = vi.fn(async (send: () => Promise<void>) => {
		if (!consent) throw new Error("AI_CONSENT_REQUIRED");
		await send();
	});
	await withAiRuntime({ ...syntheticRuntime, fetch }, async () => {
		const occupying = executeApprovedStep(input, { concurrencyLimit: 1 });
		await started.promise;
		const queued = executeApprovedStep({ ...input, attemptId: "queued", withDispatch }, { concurrencyLimit: 1 });
		expect(withDispatch).not.toHaveBeenCalled();
		consent = false;
		release.resolve();
		expect(await queued).toMatchObject({
			costMicros: 0,
			output: null,
			failure: { requestSent: false, message: "AI_CONSENT_REQUIRED" },
		});
		await occupying;
	});
	expect(fetch).toHaveBeenCalledTimes(1);
	expect(withDispatch).toHaveBeenCalledTimes(1);
});

it("releases the dispatch fence when native fetch writes the request, before the response", async () => {
	const enteringFetch = Promise.withResolvers<void>();
	const connect = Promise.withResolvers<void>();
	const received = Promise.withResolvers<void>();
	const reply = Promise.withResolvers<void>();
	const server = createServer(async (request, response) => {
		request.resume();
		await once(request, "end");
		received.resolve();
		await reply.promise;
		response.writeHead(400).end();
	});
	server.listen(0, "127.0.0.1");
	await once(server, "listening");
	const address = server.address();
	if (!address || typeof address === "string") throw new Error("Missing synthetic provider address");

	const nativeFetch = globalThis.fetch;
	const mock = vi.spyOn(globalThis, "fetch").mockImplementation(async (_url, init) => {
		enteringFetch.resolve();
		await connect.promise;
		return nativeFetch(`http://127.0.0.1:${address.port}`, init);
	});
	const { fetch: _transport, ...nativeRuntime } = syntheticRuntime;
	const fenceReleased = Promise.withResolvers<void>();
	const step = withAiRuntime(nativeRuntime, () =>
		executeApprovedStep({
			route: {
				...syntheticRoute,
				model: "openai/gpt-6-luna",
				downstreamProvider: "azure",
				maxCallCostMicros: 100_000,
			},
			operationId: "native-fetch",
			attemptId: "send",
			stepId: "generate",
			payload: { selections: [{ section: "skills", text: "TypeScript" }] },
			outputSchema: z.strictObject({ text: z.string() }),
			signal: new AbortController().signal,
			withDispatch: async (send) => {
				await send();
				fenceReleased.resolve();
			},
		}),
	);
	try {
		await enteringFetch.promise;
		const early = vi.fn();
		void fenceReleased.promise.then(early);
		await new Promise<void>((resolve) => setImmediate(resolve));
		expect(early).not.toHaveBeenCalled();
		connect.resolve();
		await received.promise;
		await fenceReleased.promise;
		reply.resolve();
		expect(await step).toMatchObject({ costMicros: 0, failure: { httpStatus: 400 } });
	} finally {
		connect.resolve();
		reply.resolve();
		mock.mockRestore();
		server.closeAllConnections();
		await new Promise<void>((resolve) => {
			server.close(() => resolve());
		});
		await step;
	}
});

it.each([1, 4, 8])("uses an explicitly passed retry-sequence cap of %s", async (concurrencyLimit) => {
	const input = {
		route: syntheticRoute,
		operationId: "op",
		attemptId: "attempt",
		stepId: "answer",
		payload: { selections: [{ section: "skills" as const, text: "TypeScript" }] },
		outputSchema: z.strictObject({ text: z.string() }),
		signal: new AbortController().signal,
	};
	let active = 0;
	let peak = 0;
	const fetch: typeof globalThis.fetch = async () => {
		active++;
		peak = Math.max(peak, active);
		await new Promise((resolve) => setTimeout(resolve, 5));
		active--;
		return Response.json({ error: { code: 400 } }, { status: 400 });
	};
	await withAiRuntime({ routes: [syntheticRoute], handlers: {}, workerAvailable: true, fetch }, () =>
		Promise.all(Array.from({ length: 10 }, () => executeApprovedStep(input, { concurrencyLimit }))),
	);
	expect(peak).toBe(concurrencyLimit);
	expect(active).toBe(0);
});

it.each([0, -1, 1.5, 9, Number.NaN, Infinity])(
	"rejects an invalid explicit concurrency cap %s before dispatch",
	async (concurrencyLimit) => {
		await expect(
			executeApprovedStep(
				{
					route: syntheticRoute,
					operationId: "op",
					attemptId: "attempt",
					stepId: "answer",
					payload: { selections: [{ section: "skills", text: "TypeScript" }] },
					outputSchema: z.strictObject({ text: z.string() }),
					signal: new AbortController().signal,
				},
				{ concurrencyLimit },
			),
		).rejects.toThrow("AI_INVALID_CONCURRENCY_LIMIT");
	},
);

it("keeps production at two despite concurrency overrides in environment, runtime, route or payload", async () => {
	vi.stubEnv("AI_CONCURRENCY_LIMIT", "8");
	vi.stubEnv("concurrencyLimit", "8");
	const pollution = { concurrencyLimit: 8 };
	const pollutedRoute = { ...syntheticRoute, ...pollution };
	let active = 0;
	let peak = 0;
	try {
		await withAiRuntime(
			{
				routes: [pollutedRoute],
				handlers: {},
				workerAvailable: true,
				...pollution,
				fetch: async () => {
					active++;
					peak = Math.max(peak, active);
					await new Promise((resolve) => setTimeout(resolve, 5));
					active--;
					return Response.json({ error: { code: 400 } }, { status: 400 });
				},
			},
			() =>
				Promise.all(
					Array.from({ length: 5 }, () =>
						executeApprovedStep({
							route: pollutedRoute,
							operationId: "op",
							attemptId: "attempt",
							stepId: "answer",
							payload: { selections: [{ section: "skills", text: "TypeScript", ...pollution }] },
							outputSchema: z.strictObject({ text: z.string() }),
							signal: new AbortController().signal,
						}),
					),
				),
		);
		expect(peak).toBe(2);
		expect(active).toBe(0);
	} finally {
		vi.unstubAllEnvs();
	}
});

it("honors Retry-After dates and cancels backoff without losing billed usage", async () => {
	vi.useFakeTimers();
	try {
		const controller = new AbortController();
		let attempts = 0;
		const pending = replayTransport(async () => {
			attempts++;
			return Response.json(
				{ ...throttled, usage: { prompt_tokens: 2, cost: 0.000002 } },
				{ headers: { "retry-after": new Date(Date.now() + 60000).toUTCString() } },
			);
		}, controller.signal);
		await vi.advanceTimersByTimeAsync(30000);
		expect(attempts).toBe(1);
		controller.abort();
		expect(await pending).toMatchObject({ outcome: "transient", costMicros: 2, inputTokens: 2 });
		expect(attempts).toBe(1);
	} finally {
		vi.useRealTimers();
	}
});
it("retains unknown billing on errors with usage but no cost", async () => {
	let attempts = 0;
	const result = await replayTransport(async () => {
		attempts++;
		return Response.json({ ...throttled, usage: { prompt_tokens: 2 } });
	});
	expect(result).toMatchObject({ outcome: "transient", costMicros: null, inputTokens: 2 });
	expect(attempts).toBe(1);
});
it("does not retry a non-transient error inside HTTP 200", async () => {
	let attempts = 0;
	const result = await replayTransport(async () => {
		attempts++;
		return Response.json({ error: { code: 400, message: "unsupported" } });
	});
	expect(result).toMatchObject({ outcome: "refusal", output: null, costMicros: 0 });
	expect(attempts).toBe(1);
});

it("honors Retry-After on a non-JSON upstream outage", async () => {
	vi.useFakeTimers();
	try {
		let attempts = 0;
		const pending = replayTransport(async () => {
			attempts++;
			return new Response("upstream overloaded", { status: 503, headers: { "retry-after": "50" } });
		});
		await vi.advanceTimersByTimeAsync(30000);
		expect(attempts).toBe(1);
		await vi.runAllTimersAsync();
		expect(await pending).toMatchObject({ outcome: "transient", costMicros: 0 });
		expect(attempts).toBe(3);
	} finally {
		vi.useRealTimers();
	}
});

it("holds unknown cost without retry after a dispatched connection loss", async () => {
	vi.useFakeTimers();
	try {
		let sends = 0;
		const pending = replayTransport(async (_url, init) => {
			expect(init?.body).toBeTruthy();
			sends++;
			throw new TypeError("fetch failed", {
				cause: Object.assign(new Error("socket closed after request write"), { code: "ECONNRESET", bytesWritten: 512 }),
			});
		});
		await vi.runAllTimersAsync();
		expect(await pending).toMatchObject({
			output: null,
			costMicros: null,
			failure: {
				errorClass: "TypeError",
				message: "fetch failed",
				httpStatus: null,
				bytesReceived: false,
				requestSent: true,
				causes: [{ errorClass: "Error", code: "ECONNRESET", message: "socket closed after request write" }],
			},
		});
		expect(sends).toBe(1);
	} finally {
		vi.useRealTimers();
	}
});

it("redacts secrets in transport failure detail while preserving cause codes", async () => {
	const result = await replayTransport(async () => {
		throw new TypeError(`fetch failed for ${syntheticRoute.apiKey}`, {
			cause: Object.assign(new Error("read ECONNRESET Bearer sk-or-v1-secret123"), { code: "UND_ERR_SOCKET" }),
		});
	});
	expect(result.failure).toMatchObject({
		errorClass: "TypeError",
		httpStatus: null,
		requestSent: true,
		causes: [{ errorClass: "Error", code: "UND_ERR_SOCKET" }],
	});
	const serialized = JSON.stringify(result.failure);
	expect(serialized).not.toContain(syntheticRoute.apiKey);
	expect(serialized).not.toContain("sk-or-v1-secret123");
});

it("raises Node happy-eyeballs autoSelectFamilyAttemptTimeout to a realistic connect budget", () => {
	const previous = net.getDefaultAutoSelectFamilyAttemptTimeout();
	try {
		net.setDefaultAutoSelectFamilyAttemptTimeout(250);
		ensureAiTransportConnectBudget();
		expect(AI_CONNECT_ATTEMPT_TIMEOUT_MS).toBeGreaterThanOrEqual(2500);
		expect(net.getDefaultAutoSelectFamilyAttemptTimeout()).toBeGreaterThanOrEqual(AI_CONNECT_ATTEMPT_TIMEOUT_MS);
	} finally {
		net.setDefaultAutoSelectFamilyAttemptTimeout(previous);
	}
});

it("treats pure connect-phase failures and pure connect AggregateErrors as unsent with zero cost", async () => {
	const connectAggregate = new TypeError("fetch failed", {
		cause: new AggregateError(
			[
				Object.assign(new Error("connect ETIMEDOUT 104.18.3.115:443"), { code: "ETIMEDOUT", syscall: "connect" }),
				Object.assign(new Error("connect ETIMEDOUT 104.18.2.115:443"), { code: "ETIMEDOUT", syscall: "connect" }),
				Object.assign(new Error("connect ENETUNREACH 2606:4700::1:443"), { code: "ENETUNREACH", syscall: "connect" }),
			],
			"",
		),
	});
	expect(failedBeforeDispatch(connectAggregate)).toBe(true);
	expect(
		failedBeforeDispatch(
			new TypeError("fetch failed", {
				cause: Object.assign(new Error("connect EHOSTUNREACH 10.0.0.1:443"), { code: "EHOSTUNREACH" }),
			}),
		),
	).toBe(true);

	const result = await withAiRuntime(
		{
			routes: [syntheticRoute],
			handlers: {},
			workerAvailable: true,
			fetch: async () => {
				throw connectAggregate;
			},
		},
		() =>
			executeApprovedStep(
				{
					route: syntheticRoute,
					operationId: "op",
					attemptId: "attempt",
					stepId: "generate",
					payload: { selections: [{ section: "skills", text: "TypeScript" }] },
					outputSchema: z.strictObject({ text: z.string() }),
					signal: new AbortController().signal,
				},
				{ retry: false },
			),
	);
	expect(result).toMatchObject({
		outcome: "transient",
		costMicros: 0,
		failure: {
			errorClass: "TypeError",
			httpStatus: null,
			bytesReceived: false,
			requestSent: false,
		},
	});
});

it("keeps conservative unknown cost for post-connect read ETIMEDOUT or mixed AggregateErrors", async () => {
	const mixedAggregate = new TypeError("fetch failed", {
		cause: new AggregateError(
			[
				Object.assign(new Error("connect ETIMEDOUT 104.18.3.115:443"), { code: "ETIMEDOUT", syscall: "connect" }),
				Object.assign(new Error("socket hang up"), { code: "ECONNRESET" }),
			],
			"",
		),
	});
	expect(failedBeforeDispatch(mixedAggregate)).toBe(false);

	const readTimeout = new TypeError("fetch failed", {
		cause: Object.assign(new Error("read ETIMEDOUT"), { code: "ETIMEDOUT", syscall: "read" }),
	});
	expect(failedBeforeDispatch(readTimeout)).toBe(false);

	const result = await withAiRuntime(
		{
			routes: [syntheticRoute],
			handlers: {},
			workerAvailable: true,
			fetch: async () => {
				throw mixedAggregate;
			},
		},
		() =>
			executeApprovedStep(
				{
					route: syntheticRoute,
					operationId: "op",
					attemptId: "attempt",
					stepId: "generate",
					payload: { selections: [{ section: "skills", text: "TypeScript" }] },
					outputSchema: z.strictObject({ text: z.string() }),
					signal: new AbortController().signal,
				},
				{ retry: false },
			),
	);
	expect(result).toMatchObject({
		outcome: "transient",
		costMicros: null,
		failure: {
			httpStatus: null,
			requestSent: true,
		},
	});
});

it("reserves an enforceable writer bound for a small, price-pinned translation request", async () => {
	const input: ApprovedStepInput = {
		route: {
			...syntheticRoute,
			model: "openai/gpt-6-luna",
			downstreamProvider: "azure",
			evidenceVersion: "paid-route-fixture",
			maxCallCostMicros: 100_000,
			maxOutputTokens: 4096,
		},
		operationId: "translation",
		attemptId: "attempt",
		stepId: "generate",
		payload: { selections: [{ section: "summary", text: "Confirmed work." }] },
		outputSchema: z.strictObject({ text: z.string() }),
		signal: new AbortController().signal,
	};
	const fetch = vi.fn(syntheticRuntime.fetch);
	await withAiRuntime({ ...syntheticRuntime, fetch }, async () => {
		const bound = await translationWriterCallBound(input.route, input);
		expect(bound).toBeGreaterThan(0);
		expect(bound).toBeLessThan(10_000);
		expect(await executeApprovedStep({ ...input, verificationBoundMicros: bound })).toMatchObject({ outcome: "valid" });
		expect(
			await executeApprovedStep({
				...input,
				verificationBoundMicros: bound,
				payload: { selections: [{ section: "summary", text: "界".repeat(10_000) }] },
			}),
		).toMatchObject({ outcome: "unsupported", costMicros: 0 });
		expect(fetch).toHaveBeenCalledTimes(1);
	});
});

it("gives a waiting operation the next provider slot ahead of a running translation's queued batches", async () => {
	const release = [Promise.withResolvers<void>(), Promise.withResolvers<void>()];
	const transport = syntheticRuntime.fetch;
	if (!transport) throw new Error("Missing synthetic transport");
	const fetch = vi.fn<typeof globalThis.fetch>();
	fetch.mockImplementation(async (url, init) => {
		const index = fetch.mock.calls.length - 1;
		if (index < 2) await release[index]?.promise;
		return transport(url, init);
	});
	const dispatched: string[] = [];
	await withAiRuntime(
		{
			...syntheticRuntime,
			fetch: (url, init) => {
				dispatched.push(JSON.parse(JSON.parse(String(init?.body)).messages.at(-1).content).selections[0].text);
				return fetch(url, init);
			},
		},
		async () => {
			const send = (id: string, group: string) =>
				executeApprovedStep(
					{
						route: syntheticRoute,
						operationId: id,
						attemptId: id,
						stepId: "generate",
						payload: { selections: [{ section: "summary", text: id }] },
						outputSchema: z.strictObject({ text: z.string() }),
						signal: new AbortController().signal,
					},
					{ retry: false, concurrencyLimit: 2, operationGroupId: group },
				);
			const first = send("part-1", "translation");
			const second = send("part-2", "translation");
			await vi.waitFor(() => expect(dispatched).toEqual(["part-1", "part-2"]));
			const third = send("part-3", "translation");
			const other = send("independent", "independent");
			try {
				release[0]?.resolve();
				await vi.waitFor(() => expect(dispatched).toHaveLength(4));
				expect(dispatched.slice(2)).toEqual(["independent", "part-3"]);
			} finally {
				release[1]?.resolve();
				await Promise.all([first, second, third, other]);
			}
		},
	);
});

it("dispatches large Arabic question selections inside the original Terra cost cap", async () => {
	const fetch = vi.fn(syntheticRuntime.fetch);
	const { output: outputSchema, systemPrompt } = reviewHandlers["review.wording"];
	if (!systemPrompt) throw new Error("Missing wording system prompt");
	const route = {
		...syntheticRoute,
		model: "openai/gpt-6.1-terra",
		downstreamProvider: "azure",
		evidenceVersion: "paid-route-fixture",
		maxCallCostMicros: 100_000,
		maxOutputTokens: 4096,
		reasoningEffort: "medium" as const,
	};
	const evidence = Array.from({ length: 20 }, (_, index) => ({
		id: `cv-${index}`,
		confirmation: "confirmed" as const,
		quote: "راجعت تقارير الأداء التشغيلي وحللت أسباب التأخير في معالجة طلبات العملاء. ".repeat(18).trim(),
	}));
	const selected = boundQuestionEvidence(evidence);
	expect(selected.length).toBeGreaterThan(0);
	expect(selected).toEqual(evidence.slice(0, selected.length));
	const payload = buildModelPayload({
		selections: selected.map(({ id, quote }) => ({ id, kind: "confirmed_content", section: "summary", text: quote })),
		contactValues: [],
	});
	await withAiRuntime({ ...syntheticRuntime, fetch }, () =>
		executeApprovedStep({
			route,
			operationId: "operation",
			attemptId: "attempt",
			stepId: "generate",
			payload,
			outputSchema,
			systemPrompt,
			signal: new AbortController().signal,
		}),
	);
	expect(fetch).toHaveBeenCalledTimes(1);
});

it("shares released translation slots with job verification under the eight-call ceiling", async () => {
	const transport = syntheticRuntime.fetch;
	if (!transport) throw new Error("Missing synthetic transport");
	const gates = Array.from({ length: 10 }, () => Promise.withResolvers<void>());
	const dispatched: string[] = [];
	await withAiRuntime(
		{
			...syntheticRuntime,
			fetch: async (url, init) => {
				const index = dispatched.length;
				dispatched.push(JSON.parse(JSON.parse(String(init?.body)).messages.at(-1).content).selections[0].text);
				await gates[index]?.promise;
				return transport(url, init);
			},
		},
		async () => {
			const send = (id: string, group: string, concurrencyLimit: number) =>
				executeApprovedStep(
					{
						route: syntheticRoute,
						operationId: id,
						attemptId: id,
						stepId: "generate",
						payload: { selections: [{ section: "summary", text: id }] },
						outputSchema: z.strictObject({ text: z.string() }),
						signal: new AbortController().signal,
					},
					{ retry: false, operationGroupId: group, concurrencyLimit },
				);
			const translation = Array.from({ length: 9 }, (_, index) => send("translation-" + index, "translation", 8));
			const job = send("job", "job", 5);
			try {
				await vi.waitFor(() => expect(dispatched).toHaveLength(8));
				gates[0]?.resolve();
				await vi.waitFor(() => expect(dispatched.at(8)).toBe("job"));
				expect(dispatched).toHaveLength(9);
			} finally {
				for (const gate of gates) gate.resolve();
				await Promise.all([...translation, job]);
			}
		},
	);
});
