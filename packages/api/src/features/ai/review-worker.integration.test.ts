import { beforeAll, describe, expect, it, vi } from "vite-plus/test";
import { getProcessingNotices, processingConsentService } from "./consent";
import { runAiOperations } from "./operation-worker";
import { claimNextOperation, heartbeatOperation, operationService } from "./operations";
import { withAiRuntime } from "./route-policy";
import { aiTestDatabase } from "./testing/database";
import { syntheticRoute, syntheticRuntime } from "./testing/runtime";
import { usageService } from "./usage";

describe.skipIf(!process.env.COVER_LETTER_TEST_DATABASE_URL)("review worker lifecycle", () => {
	const database = aiTestDatabase();
	const run = <T>(work: () => T) => database.run(() => withAiRuntime(syntheticRuntime, work));
	beforeAll(async () => {
		await database
			.admin()
			.query(
				"INSERT INTO ai_platform_budget(id,route_id,route_revision,window_date,cap_micros,request_cap_micros,concurrency) VALUES ('budget','synthetic','1',current_date,100000,10000,2)",
			);
	});
	async function prepare(owner: string) {
		await database
			.admin()
			.query(`INSERT INTO "user"(id,name,email,username,display_username) VALUES ($1,$1,$1||'@example.test',$1,$1)`, [
				owner,
			]);
		await database
			.admin()
			.query("INSERT INTO resume(id,user_id,name,slug,data) VALUES ($1,$1,'Synthetic','cv','{}')", [owner]);
		const revision = (
			await database.admin().query("SELECT updated_at FROM resume WHERE id=$1", [owner])
		).rows[0].updated_at.toISOString();
		const route = { routeId: "synthetic", routeRevision: "1", configRevision: "1" };
		await run(async () => {
			const [notice] = await getProcessingNotices(owner, { purpose: "review", locale: "en-US" });
			if (!notice) throw new Error("Missing synthetic processing notice");
			const { content: _content, alreadyGranted: _alreadyGranted, ...acceptance } = notice;
			await processingConsentService.grant(owner, acceptance);
		});
		return {
			requestKey: owner,
			kind: "review",
			sources: [{ kind: "resume" as const, id: owner, revision }],
			route,
			consentVersion: "1",
			parameters: {},
		};
	}
	it.each(["writer", "verify"])(
		"retries one known-cost %s failure without consuming its peer call or extra quota",
		async (failedStep) => {
			const owner = `shared-retry-${failedStep}`;
			const request = await prepare(owner);
			const handler = syntheticRuntime.handlers.review;
			const transport = syntheticRuntime.fetch;
			if (!handler || !transport) throw new Error("Missing synthetic runtime");
			let calls = 0;
			const runtime = {
				...syntheticRuntime,
				routes: [{ ...syntheticRoute, maxCalls: 2, maxRepairs: 0 }],
				handlers: {
					review: {
						...handler,
						verifier: {
							output: handler.output,
							systemPrompt: "Verify synthetic content.",
							buildInput: (payload: import("./payload").ModelPayload) => payload,
							validate: () => undefined,
						},
					},
				},
				fetch: (...args: Parameters<typeof fetch>) => {
					calls++;
					return calls === (failedStep === "writer" ? 1 : 2)
						? Promise.resolve(new Response("", { status: 503 }))
						: transport(...args);
				},
			};
			const work = <T>(fn: () => T) => database.run(() => withAiRuntime(runtime, fn));
			const operation = await work(() => operationService.start(owner, request));
			await work(() => runAiOperations());
			expect(await work(() => operationService.get(owner, operation.id))).toMatchObject({
				state: "waiting_review",
				failureCode: null,
			});
			expect(calls).toBe(3);
			expect((await work(() => usageService.getStartUsage(owner))).operations.used).toBe(1);
			const attempts = (
				await database
					.admin()
					.query("SELECT step_id,outcome,output FROM ai_operation_attempt WHERE operation_id=$1 ORDER BY ordinal", [
						operation.id,
					])
			).rows;
			expect(attempts.map(({ step_id, outcome }) => ({ step_id, outcome }))).toEqual(
				failedStep === "writer"
					? [
							{ step_id: "generate", outcome: "transient" },
							{ step_id: "generate", outcome: "valid" },
							{ step_id: "verify", outcome: "valid" },
						]
					: [
							{ step_id: "generate", outcome: "valid" },
							{ step_id: "verify", outcome: "valid" },
						],
			);
			const verification = attempts.find((attempt) => attempt.step_id === "verify");
			expect(verification?.output._verifyCalls.map((call: { outcome: string }) => call.outcome)).toEqual(
				failedStep === "verify" ? ["transient", "valid"] : ["valid"],
			);
		},
	);
	it.each(["writer", "verify"])(
		"stops after one automatic %s retry and releases failed-operation quota",
		async (failedStep) => {
			const owner = `shared-limit-${failedStep}`;
			const request = await prepare(owner);
			const handler = syntheticRuntime.handlers.review;
			const transport = syntheticRuntime.fetch;
			if (!handler || !transport) throw new Error("Missing synthetic runtime");
			let calls = 0;
			const runtime = {
				...syntheticRuntime,
				routes: [{ ...syntheticRoute, maxCalls: 2, maxRepairs: 0 }],
				handlers: {
					review: {
						...handler,
						verifier: {
							output: handler.output,
							systemPrompt: "Verify synthetic content.",
							buildInput: (payload: import("./payload").ModelPayload) => payload,
							validate: () => undefined,
						},
					},
				},
				fetch: (...args: Parameters<typeof fetch>) => {
					calls++;
					return failedStep === "verify" && calls === 1
						? transport(...args)
						: Promise.resolve(new Response("", { status: 503 }));
				},
			};
			const work = <T>(fn: () => T) => database.run(() => withAiRuntime(runtime, fn));
			const operation = await work(() => operationService.start(owner, request));
			await work(() => runAiOperations());
			expect(await work(() => operationService.get(owner, operation.id))).toMatchObject({
				state: "failed",
				failureCode: failedStep === "writer" ? "AI_TRANSIENT" : "AI_VERIFIER_UNAVAILABLE",
			});
			expect(calls).toBe(failedStep === "writer" ? 2 : 3);
			expect((await work(() => usageService.getStartUsage(owner))).operations).toMatchObject({ used: 0, reserved: 0 });
		},
	);
	it("completes content regeneration after both bounded transient step retries", async () => {
		const owner = "shared-retry-regenerate";
		const request = await prepare(owner);
		const handler = syntheticRuntime.handlers.review;
		const transport = syntheticRuntime.fetch;
		if (!handler || !transport) throw new Error("Missing synthetic runtime");
		let calls = 0;
		let checks = 0;
		const runtime = {
			...syntheticRuntime,
			routes: [{ ...syntheticRoute, maxCalls: 2, maxRepairs: 0 }],
			handlers: {
				review: {
					...handler,
					verifier: {
						output: handler.output,
						systemPrompt: "Verify synthetic content.",
						buildInput: (payload: import("./payload").ModelPayload) => payload,
						validate: () => {
							if (++checks === 1) throw new Error("AI_VERIFICATION_FAILED");
						},
					},
				},
			},
			fetch: (...args: Parameters<typeof fetch>) => {
				calls++;
				return [1, 5].includes(calls) ? Promise.resolve(new Response("", { status: 503 })) : transport(...args);
			},
		};
		const work = <T>(fn: () => T) => database.run(() => withAiRuntime(runtime, fn));
		const operation = await work(() => operationService.start(owner, request));
		await work(() => runAiOperations());
		expect(await work(() => operationService.get(owner, operation.id))).toMatchObject({
			state: "waiting_review",
			failureCode: null,
		});
		expect(calls).toBe(6);
		expect((await work(() => usageService.getStartUsage(owner))).operations.used).toBe(1);
	});
	it("keeps the schema repair and verifier slots after a free transient writer retry", async () => {
		const owner = "shared-retry-repair";
		const request = await prepare(owner);
		const handler = syntheticRuntime.handlers.review;
		const transport = syntheticRuntime.fetch;
		if (!handler || !transport) throw new Error("Missing synthetic runtime");
		let calls = 0;
		const runtime = {
			...syntheticRuntime,
			handlers: {
				review: {
					...handler,
					verifier: {
						output: handler.output,
						systemPrompt: "Verify synthetic content.",
						buildInput: (payload: import("./payload").ModelPayload) => payload,
						validate: () => undefined,
					},
				},
			},
			fetch: async (...args: Parameters<typeof fetch>) => {
				calls++;
				if (calls === 1) return new Response("", { status: 503 });
				const response = await transport(...args);
				if (calls !== 2) return response;
				const body = await response.json();
				body.choices[0].message.content = '{"wrong":true}';
				return new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } });
			},
		};
		const work = <T>(fn: () => T) => database.run(() => withAiRuntime(runtime, fn));
		const operation = await work(() => operationService.start(owner, request));
		await work(() => runAiOperations());
		expect(await work(() => operationService.get(owner, operation.id))).toMatchObject({
			state: "waiting_review",
			failureCode: null,
		});
		expect(calls).toBe(4);
		expect(
			(
				await database
					.admin()
					.query("SELECT step_id FROM ai_operation_attempt WHERE operation_id=$1 ORDER BY ordinal", [operation.id])
			).rows,
		).toEqual([{ step_id: "generate" }, { step_id: "generate" }, { step_id: "repair" }, { step_id: "verify" }]);
	});
	it.each(["deadline", "shutdown"])("bounds stalled input loading on %s without provider egress", async (cause) => {
		const owner = `input-${cause}`;
		const request = await prepare(owner);
		const review = syntheticRuntime.handlers.review;
		if (!review) throw new Error("Missing handler");
		const entered = Promise.withResolvers<void>();
		const input = Promise.withResolvers<Awaited<ReturnType<typeof review.buildInput>>>();
		const controller = new AbortController();
		const deadline = new AbortController();
		const timeout =
			cause === "deadline" ? vi.spyOn(AbortSignal, "timeout").mockReturnValue(deadline.signal) : undefined;
		let clock: { mockRestore(): void } | undefined;
		let calls = 0;
		const runtime = {
			...syntheticRuntime,
			routes: [{ ...syntheticRoute, deadlineMs: cause === "deadline" ? 5000 : 120000 }],
			handlers: {
				review: {
					...review,
					buildInput: () => {
						entered.resolve();
						return input.promise;
					},
				},
			},
			fetch: () => {
				calls++;
				throw new Error("Must not call");
			},
		};
		const operation = await database.run(() => withAiRuntime(runtime, () => operationService.start(owner, request)));
		const pending = database.run(() => withAiRuntime(runtime, () => runAiOperations(controller.signal)));
		try {
			await Promise.race([
				entered.promise,
				pending.then(() => {
					throw new Error("Worker exited before input preparation");
				}),
			]);
			if (cause === "shutdown") controller.abort();
			else {
				expect(timeout).toHaveBeenCalledExactlyOnceWith(expect.any(Number));
				const remaining = timeout?.mock.calls[0]?.[0];
				expect(remaining).toBeGreaterThan(0);
				expect(remaining).toBeLessThanOrEqual(5000);
				clock = vi.spyOn(Date, "now").mockReturnValue(Date.now() + 5001);
				deadline.abort(new DOMException("Synthetic deadline elapsed", "TimeoutError"));
			}
			const finished = await Promise.race([
				pending.then(() => true),
				new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 250)),
			]);
			expect(finished).toBe(true);
			expect(calls).toBe(0);
			const status = await run(() => operationService.get(owner, operation.id));
			expect(status).toMatchObject(
				cause === "deadline"
					? { state: "failed", failureCode: "AI_DEADLINE" }
					: { state: "running", failureCode: null },
			);
		} finally {
			clock?.mockRestore();
			timeout?.mockRestore();
			input.resolve(await review.buildInput(owner, request));
			await pending;
			await run(() => operationService.cancel(owner, operation.id));
			await run(() => runAiOperations());
		}
	});
	it("drains an in-flight provider call when scheduler shutdown begins", async () => {
		const owner = "shutdown-call";
		const request = await prepare(owner);
		const entered = Promise.withResolvers<void>();
		const response = Promise.withResolvers<Response>();
		const controller = new AbortController();
		const operation = await run(() => operationService.start(owner, request));
		const pending = database.run(() =>
			withAiRuntime(
				{
					...syntheticRuntime,
					fetch: (_url: unknown, init?: RequestInit) =>
						new Promise<Response>((resolve, reject) => {
							entered.resolve();
							const signal = init?.signal;
							if (signal?.aborted) reject(signal.reason);
							else signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
							response.promise.then(resolve, reject);
						}),
				},
				() => runAiOperations(controller.signal),
			),
		);
		await entered.promise;
		controller.abort();
		await new Promise((resolve) => setImmediate(resolve));
		const fetch = syntheticRuntime.fetch;
		if (!fetch) throw new Error("Missing synthetic transport");
		response.resolve(await fetch("https://openrouter.ai/api/v1/chat/completions"));
		await pending;
		expect(await run(() => operationService.get(owner, operation.id))).toMatchObject({
			state: "waiting_review",
			resultId: operation.id,
		});
	});
	it("rejects recovered output whose recorded call exceeds the approved cost ceiling", async () => {
		const owner = "recovered-cost";
		const request = await prepare(owner);
		const operation = await run(() => operationService.start(owner, request));
		const lease = await run(() => claimNextOperation(owner));
		if (!lease) throw new Error("Missing lease");
		await database
			.admin()
			.query(
				"INSERT INTO ai_operation_attempt(id,user_id,operation_id,ordinal,step_id,lease_token,outcome,cost_micros,finished_at,output) VALUES ('over-cap',$1,$2,1,'generate',$3,'valid',3334,now(),'{\"text\":\"Recovered\"}')",
				[owner, operation.id, lease.token],
			);
		await database
			.admin()
			.query("UPDATE ai_operation SET lease_until=now()-interval '1 minute' WHERE id=$1", [operation.id]);
		await run(() => runAiOperations());
		expect(await run(() => operationService.get(owner, operation.id))).toMatchObject({
			state: "failed",
			failureCode: "AI_REQUEST_COST_LIMIT",
			resultId: null,
		});
		expect((await run(() => usageService.getStartUsage(owner))).operations.used).toBe(0);
	});
	it("refuses to renew a lease after its execution deadline", async () => {
		const owner = "expired-heartbeat";
		const request = await prepare(owner);
		const operation = await database.run(() =>
			withAiRuntime({ ...syntheticRuntime, routes: [{ ...syntheticRoute, deadlineMs: 1 }] }, () =>
				operationService.start(owner, request),
			),
		);
		const lease = await run(() => claimNextOperation(owner));
		if (!lease) throw new Error("Missing lease");
		await new Promise((resolve) => setTimeout(resolve, 10));
		await expect(run(() => heartbeatOperation(lease))).rejects.toThrow();
		await run(() => operationService.cancel(owner, operation.id));
		await database
			.admin()
			.query("UPDATE ai_operation SET lease_until=now()-interval '1 minute' WHERE id=$1", [operation.id]);
		await run(() => runAiOperations());
	});

	it("retries one pre-response transient transport error and charges one user credit", async () => {
		const owner = "pre-response-retry-pass";
		const request = await prepare(owner);
		const transport = syntheticRuntime.fetch;
		if (!transport) throw new Error("Missing synthetic transport");
		let calls = 0;
		const runtime = {
			...syntheticRuntime,
			routes: [{ ...syntheticRoute, maxCalls: 1, maxRepairs: 0 }],
			fetch: (...args: Parameters<typeof fetch>) => {
				calls++;
				if (calls === 1) return Promise.reject(new TypeError("terminated"));
				return transport(...args);
			},
		};
		const work = <T>(fn: () => T) => database.run(() => withAiRuntime(runtime, fn));
		const operation = await work(() => operationService.start(owner, request));
		await work(() => runAiOperations());
		expect(await work(() => operationService.get(owner, operation.id))).toMatchObject({
			state: "waiting_review",
			failureCode: null,
		});
		expect(calls).toBe(2);
		expect((await work(() => usageService.getStartUsage(owner))).operations.used).toBe(1);
		const attempts = (
			await database
				.admin()
				.query(
					"SELECT step_id, outcome, cost_micros FROM ai_operation_attempt WHERE operation_id=$1 ORDER BY ordinal",
					[operation.id],
				)
		).rows;
		expect(attempts).toHaveLength(2);
		expect(attempts[0]).toMatchObject({ step_id: "generate", outcome: "transient", cost_micros: null });
		expect(attempts[1]).toMatchObject({ step_id: "generate", outcome: "valid" });
	});

	it("fails with AI_OUTCOME_UNKNOWN after two pre-response transient transport errors", async () => {
		const owner = "pre-response-retry-twice";
		const request = await prepare(owner);
		let calls = 0;
		const runtime = {
			...syntheticRuntime,
			routes: [{ ...syntheticRoute, maxCalls: 1, maxRepairs: 0 }],
			fetch: () => {
				calls++;
				return Promise.reject(new TypeError("terminated"));
			},
		};
		const work = <T>(fn: () => T) => database.run(() => withAiRuntime(runtime, fn));
		const operation = await work(() => operationService.start(owner, request));
		await work(() => runAiOperations());
		expect(await work(() => operationService.get(owner, operation.id))).toMatchObject({
			state: "failed",
			failureCode: "AI_OUTCOME_UNKNOWN",
		});
		expect(calls).toBe(2);
	});

	it("does not pre-response-retry transient errors that include usage or nearly spent deadlines", async () => {
		const ownerUsage = "pre-response-usage-no-retry";
		const reqUsage = await prepare(ownerUsage);
		let usageCalls = 0;
		const usageRuntime = {
			...syntheticRuntime,
			routes: [{ ...syntheticRoute, maxCalls: 1, maxRepairs: 0 }],
			fetch: () => {
				usageCalls++;
				return Promise.resolve(
					Response.json({
						error: { code: 503, message: "temporarily unavailable" },
						usage: { prompt_tokens: 2 },
					}),
				);
			},
		};
		const workUsage = <T>(fn: () => T) => database.run(() => withAiRuntime(usageRuntime, fn));
		const opUsage = await workUsage(() => operationService.start(ownerUsage, reqUsage));
		await workUsage(() => runAiOperations());
		expect(await workUsage(() => operationService.get(ownerUsage, opUsage.id))).toMatchObject({
			state: "failed",
			failureCode: "AI_OUTCOME_UNKNOWN",
		});
		expect(usageCalls).toBe(1);

		const ownerDeadline = "pre-response-deadline-no-retry";
		const reqDeadline = await prepare(ownerDeadline);
		let deadlineCalls = 0;
		const deadlineRuntime = {
			...syntheticRuntime,
			routes: [{ ...syntheticRoute, maxCalls: 1, maxRepairs: 0, deadlineMs: 400 }],
			fetch: () => {
				deadlineCalls++;
				return Promise.reject(new TypeError("terminated"));
			},
		};
		const workDeadline = <T>(fn: () => T) => database.run(() => withAiRuntime(deadlineRuntime, fn));
		const opDeadline = await workDeadline(() => operationService.start(ownerDeadline, reqDeadline));
		await workDeadline(() => runAiOperations());
		expect(await workDeadline(() => operationService.get(ownerDeadline, opDeadline.id))).toMatchObject({
			state: "failed",
			failureCode: "AI_OUTCOME_UNKNOWN",
		});
		expect(deadlineCalls).toBe(1);
	});
});
