import { randomUUID } from "node:crypto";
import { beforeAll, describe, expect, it, vi } from "vite-plus/test";
import { defaultResumeData } from "@reactive-resume/schema/resume/default";
import { executeApprovedStep } from "./adapter";
import { processingConsentService } from "./consent";
import { executeLease, runAiOperations } from "./operation-worker";
import { claimNextOperation, failOperation, operationService, reconcileExpiredAccounting } from "./operations";
import { buildModelPayload } from "./payload";
import { withAiRuntime } from "./route-policy";
import { aiTestDatabase } from "./testing/database";
import { syntheticRuntime, syntheticRoute } from "./testing/runtime";
import { usageService } from "./usage";
import { VerificationGateError } from "./verification-failure";
import {
	bindVerificationPass,
	createVerificationJournal,
	makeVerificationCall,
	readVerificationJournal,
} from "./verification-journal";
import { resolveReviewVerifierRoute } from "./verifier-policy";

describe.skipIf(!process.env.COVER_LETTER_TEST_DATABASE_URL)("qualified backup verification", () => {
	const database = aiTestDatabase();
	beforeAll(async () => {
		await database
			.admin()
			.query(
				"INSERT INTO ai_platform_budget(id,route_id,route_revision,window_date,cap_micros,request_cap_micros,concurrency) VALUES ('synthetic-backup','synthetic-backup','1',(now() AT TIME ZONE 'UTC')::date,3000000,200000,1)",
			);
	});
	type Blocker =
		| "schema"
		| "identity"
		| "unsupported"
		| "refusal"
		| "expired"
		| "stale"
		| "revoked"
		| "cancelled"
		| "deadline"
		| "unqualified";
	it.each<{
		status: number | null;
		primaryBound: number;
		backupBound: number;
		dispatch: boolean;
		blocker?: Blocker;
		reclaim?: "primary" | "backup";
	}>([
		{ status: 429, primaryBound: 100_000, backupBound: 100_000, dispatch: true },
		{ status: 500, primaryBound: 100_000, backupBound: 100_000, dispatch: true },
		{ status: 502, primaryBound: 100_000, backupBound: 100_000, dispatch: true },
		{ status: 503, primaryBound: 100_000, backupBound: 100_000, dispatch: true },
		{ status: 504, primaryBound: 100_000, backupBound: 100_000, dispatch: true },
		{ status: null, primaryBound: 100_000, backupBound: 100_000, dispatch: false },
		{ status: null, primaryBound: 60_000, backupBound: 30_000, dispatch: true },
		{ status: 401, primaryBound: 30_000, backupBound: 30_000, dispatch: false },
		{ status: 402, primaryBound: 30_000, backupBound: 30_000, dispatch: false },
		{ status: 403, primaryBound: 30_000, backupBound: 30_000, dispatch: false },
		{ status: 400, primaryBound: 30_000, backupBound: 30_000, dispatch: false },
		...(
			[
				"schema",
				"identity",
				"unsupported",
				"refusal",
				"expired",
				"stale",
				"revoked",
				"cancelled",
				"deadline",
				"unqualified",
			] as const
		).map((blocker) => ({ status: 503, primaryBound: 30_000, backupBound: 30_000, dispatch: false, blocker })),
		{ status: 503, primaryBound: 30_000, backupBound: 30_000, dispatch: true, reclaim: "primary" },
		{ status: 503, primaryBound: 30_000, backupBound: 30_000, dispatch: true, reclaim: "backup" },
	])(
		"uses one backup only for eligible failures and funds ($status, $primaryBound, $backupBound, $blocker, $reclaim)",
		async ({ status, primaryBound, backupBound, dispatch, blocker, reclaim }) => {
			const owner = randomUUID();
			const kind = "review.job-evidence" as const;
			const verifierModel = "deepseek/deepseek-v4.1-flash-1017";
			const review = syntheticRuntime.handlers.review;
			if (!review) throw new Error("Missing synthetic handler");
			const proof = "synthetic";
			const route = {
				...syntheticRoute,
				routeId: "synthetic-backup",
				model: "openai/gpt-6.1-terra",
				downstreamProvider: "azure",
				reasoningEffort: "medium" as const,
				maxCalls: 2,
				maxRepairs: 0,
				transientRetries: 0,
				maxCallCostMicros: 100_000,
				requestCapMicros: 200_000,
				dayCapMicros: 3_000_000,
				callTimeoutMs: blocker === "deadline" ? 1200 : 150,
				deadlineMs: blocker === "deadline" ? 700 : syntheticRoute.deadlineMs,
				verifier: {
					evidenceVersion: proof,
					maxCallCostMicros: primaryBound,
					backup: {
						endpoint: syntheticRoute.endpoint,
						model: verifierModel,
						downstreamProvider: "parasail",
						providerEndpoint: "parasail/bf16",
						precision: "bf16" as const,
						evidenceVersion: proof,
						maxCallCostMicros: backupBound,
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
							purposes: [kind],
						},
						qualified: blocker === "unqualified" ? [] : [{ kind, writerModel: "openai/gpt-6.1-terra", verifierModel }],
					},
				},
			};
			const admin = database.admin();
			const spent = async () =>
				(await admin.query("SELECT spent_micros::int FROM ai_platform_budget WHERE id='synthetic-backup'")).rows[0]
					.spent_micros;
			const spentBefore = await spent();
			await admin.query(
				"INSERT INTO \"user\"(id,name,email,username,display_username) VALUES ($1,$1,$1||'@example.test',$1,$1)",
				[owner],
			);
			const {
				rows: [resume],
			} = await admin.query(
				"INSERT INTO resume(id,user_id,name,slug,data) VALUES ($1,$1,'Synthetic','cv',$2) RETURNING updated_at",
				[owner, defaultResumeData],
			);
			await admin.query(
				"INSERT INTO ai_processing_consent(id,user_id,route_id,route_revision,config_revision,notice_version,purpose) VALUES ($1,$1,$2,'1','1','1',$3)",
				[owner, route.routeId, kind],
			);
			const providers: string[] = [];
			const stop = new AbortController();
			const backupDispatched = Promise.withResolvers<void>();
			const backupResponse = Promise.withResolvers<void>();
			const primaryDispatched = Promise.withResolvers<void>();
			const primaryResponse = Promise.withResolvers<void>();
			let operationId = "";
			const run = <T>(work: () => T) =>
				database.run(() =>
					withAiRuntime(
						{
							...syntheticRuntime,
							routes: [route],
							handlers: {
								[kind]: {
									...review,
									verifier: {
										output: review.output,
										systemPrompt: "Verify the synthetic result.",
										buildInput: (payload) => payload,
										validate: () => {
											if (blocker === "unsupported")
												throw new VerificationGateError("AI_VERIFICATION_CLAIM_SUPPORT", "AI_UNSUPPORTED_CLAIM");
										},
									},
								},
							},
							fetch: async (_url, init) => {
								const body = JSON.parse(String(init?.body));
								const provider = body.provider.only[0].split("/")[0];
								providers.push(provider);
								expect(body.provider).toMatchObject({ allow_fallbacks: false, zdr: true, data_collection: "deny" });
								if (provider === "parasail")
									expect(body.provider).toMatchObject({ only: ["parasail/bf16"], quantizations: ["bf16"] });
								if (provider === "together") {
									if (reclaim === "primary" && !stop.signal.aborted) stop.abort();
									if (blocker === "revoked")
										await admin.query("UPDATE ai_processing_consent SET revoked_at=now() WHERE user_id=$1", [owner]);
									if (blocker === "stale")
										await admin.query("UPDATE resume SET updated_at=now()+interval '1 second' WHERE id=$1", [owner]);
									if (blocker === "expired")
										await admin.query("UPDATE ai_operation SET lease_until=now()-interval '1 second' WHERE id=$1", [
											operationId,
										]);
									if (blocker === "cancelled") {
										primaryDispatched.resolve();
										await primaryResponse.promise;
									}
									if (
										blocker === "schema" ||
										blocker === "identity" ||
										blocker === "unsupported" ||
										blocker === "refusal"
									)
										return Response.json({
											id: provider,
											provider: blocker === "identity" ? "other" : provider,
											model: body.model,
											choices: [
												{
													index: 0,
													message: {
														role: "assistant",
														content: blocker === "schema" ? "{}" : '{"text":"Synthetic review"}',
														...(blocker === "refusal" ? { refusal: "Synthetic refusal" } : {}),
													},
													finish_reason: "stop",
												},
											],
											usage: { prompt_tokens: 5, completion_tokens: 5, total_tokens: 10, cost: 0.005 },
										});
									if (status !== null && blocker !== "deadline")
										return Response.json({ error: { code: status } }, { status });
									return new Promise<Response>((_, reject) => {
										const signal = init?.signal;
										if (!signal) return reject(new Error("Missing abort signal"));
										if (signal.aborted) return reject(signal.reason);
										signal.addEventListener("abort", () => reject(signal.reason), { once: true });
									});
								}
								if (provider === "parasail" && reclaim === "backup") {
									backupDispatched.resolve();
									await backupResponse.promise;
								}
								return Response.json({
									id: provider,
									provider,
									model: body.model,
									choices: [
										{
											index: 0,
											message: { role: "assistant", content: '{"text":"Synthetic review"}' },
											finish_reason: "stop",
										},
									],
									usage: { prompt_tokens: 5, completion_tokens: 5, total_tokens: 10, cost: 0.01 },
								});
							},
						},
						work,
					),
				);
			const input = {
				requestKey: owner,
				kind,
				parameters: {},
				route: { routeId: route.routeId, routeRevision: route.routeRevision, configRevision: route.configRevision },
				consentVersion: route.noticeVersion,
				sources: [{ kind: "resume" as const, id: owner, revision: resume.updated_at.toISOString() }],
			};
			const operation = await run(() => operationService.start(owner, input));
			operationId = operation.id;
			const lease = await run(() => claimNextOperation(owner));
			if (!lease) throw new Error("Missing lease");
			const initial = run(() => executeLease(lease, stop.signal));
			if (blocker === "cancelled") {
				await Promise.race([primaryDispatched.promise, initial]);
				try {
					expect(await run(() => operationService.cancel(owner, operationId))).toMatchObject({ state: "cancelled" });
					const next = await run(() => operationService.start(owner, { ...input, requestKey: randomUUID() }));
					expect(next.state).toBe("queued");
					await run(() => operationService.cancel(owner, next.id));
				} finally {
					primaryResponse.resolve();
					await initial;
				}
			} else if (reclaim === "backup") await Promise.race([backupDispatched.promise, initial]);
			else await initial;
			if (reclaim) {
				try {
					await admin.query("UPDATE ai_operation SET lease_until=now()-interval '1 second' WHERE id=$1", [
						operation.id,
					]);
					const recovered = await run(() => claimNextOperation(owner));
					if (!recovered) throw new Error("Missing recovered lease");
					await run(() => executeLease(recovered));
				} finally {
					backupResponse.resolve();
					await initial;
				}
			}
			expect(providers).toEqual(
				dispatch
					? ["azure", "together", "parasail"]
					: blocker === "unsupported"
						? ["azure", "together", "azure", "together"]
						: ["azure", "together"],
			);
			const {
				rows: [stored],
			} = await admin.query("SELECT state FROM ai_operation WHERE id=$1", [operation.id]);
			const delivered = dispatch && reclaim !== "backup";
			expect(stored.state).toBe(
				blocker === "expired"
					? "running"
					: blocker === "cancelled"
						? "cancelled"
						: delivered
							? "waiting_review"
							: "failed",
			);
			if (blocker === "expired") {
				const recovered = await run(() => claimNextOperation(owner));
				if (!recovered) throw new Error("Missing reclaimed expired lease");
				await run(() => executeLease(recovered));
				expect(providers).toEqual(["azure", "together"]);
			}
			if (status === null) {
				expect((await spent()) - spentBefore).toBe(0);
				expect(
					(await admin.query("SELECT reserved_micros::int FROM ai_operation WHERE id=$1", [operation.id])).rows[0]
						.reserved_micros,
				).toBe(200_000);
				const {
					rows: [pass],
				} = await admin.query("SELECT output FROM ai_operation_attempt WHERE operation_id=$1 AND step_id='verify'", [
					operation.id,
				]);
				expect(readVerificationJournal(pass.output)?.calls).toEqual([
					expect.objectContaining({ endpointSlot: "primary", boundMicros: primaryBound, costMicros: null }),
					...(dispatch
						? [expect.objectContaining({ endpointSlot: "backup", boundMicros: backupBound, costMicros: 10_000 })]
						: []),
				]);
			}
			if (status !== null && !blocker && reclaim !== "backup")
				expect((await spent()) - spentBefore).toBe(10_000 + (dispatch ? 10_000 : 0));
			const { rows } = await admin.query("SELECT kind FROM ai_usage_ledger WHERE operation_id=$1 ORDER BY kind", [
				operation.id,
			]);
			expect(rows).toEqual(
				delivered ? [{ kind: "reserve" }, { kind: "settle" }] : [{ kind: "release" }, { kind: "reserve" }],
			);
		},
	);
});

describe.skipIf(!process.env.COVER_LETTER_TEST_DATABASE_URL)("AI delivery and global admission", () => {
	const database = aiTestDatabase();
	const run = <T>(work: () => T) => database.run(() => withAiRuntime(syntheticRuntime, work));
	const revisions = new Map<string, string>();
	beforeAll(async () => {
		await database
			.admin()
			.query(
				"INSERT INTO \"user\"(id,name,email,username,display_username) VALUES ('carol','Carol','carol@example.test','carol','carol')",
			);
		for (const owner of ["alice", "bob", "carol"]) {
			const route = owner === "bob" ? "synthetic-b" : "synthetic";
			await database
				.admin()
				.query("INSERT INTO resume(id,user_id,name,slug,data) VALUES ($1,$2,'Synthetic','cv',$3)", [
					`cv-${owner}`,
					owner,
					JSON.stringify(defaultResumeData),
				]);
			revisions.set(
				owner,
				(
					await database.admin().query("SELECT updated_at FROM resume WHERE id=$1", [`cv-${owner}`])
				).rows[0].updated_at.toISOString(),
			);
			await database
				.admin()
				.query(
					"INSERT INTO ai_processing_consent(id,user_id,route_id,route_revision,notice_version,purpose,config_revision) VALUES ($1,$2,$3,'1','1','review','1')",
					[`consent-${owner}`, owner, route],
				);
		}
		for (const route of ["synthetic", "synthetic-b"])
			await database
				.admin()
				.query(
					"INSERT INTO ai_platform_budget(id,route_id,route_revision,window_date,cap_micros,request_cap_micros,concurrency) VALUES ($1,$1,'1',(now() AT TIME ZONE 'UTC')::date,100000,10000,2)",
					[route],
				);
	});
	const request = (owner: string, key: string) => ({
		requestKey: key,
		kind: "review",
		sources: [{ kind: "resume" as const, id: `cv-${owner}`, revision: revisions.get(owner) ?? "missing" }],
		route: { routeId: owner === "bob" ? "synthetic-b" : "synthetic", routeRevision: "1", configRevision: "1" },
		consentVersion: "1",
		parameters: {},
	});
	it.each([
		["length", "AI_TRUNCATED"],
		["stop", "AI_INVALID"],
		["content_filter", "AI_REFUSAL"],
	])("reports the writer failure %s on its first attempt", async (finishReason, failureCode) => {
		const review = syntheticRuntime.handlers.review;
		const transport = syntheticRuntime.fetch;
		if (!review || !transport) throw new Error("Missing synthetic handler or transport");
		const runtime = {
			...syntheticRuntime,
			routes: syntheticRuntime.routes.map((route) => ({ ...route, maxCalls: 2, maxRepairs: 0 })),
			handlers: {
				review: {
					...review,
					verifier: {
						output: review.output,
						systemPrompt: "Verify the synthetic result.",
						buildInput: (payload: ReturnType<typeof buildModelPayload>) => payload,
						validate: () => undefined,
					},
				},
			},
			fetch: async (...args: Parameters<typeof fetch>) => {
				const response = await transport(...args);
				const body = await response.json();
				body.choices[0].finish_reason = finishReason;
				body.choices[0].message.content = "{}";
				return Response.json(body);
			},
		};
		const work = <T>(task: () => T) => database.run(() => withAiRuntime(runtime, task));
		const operation = await work(() => operationService.start("alice", request("alice", `writer-${finishReason}`)));
		await work(() => runAiOperations());
		expect(await work(() => operationService.get("alice", operation.id))).toMatchObject({
			state: "failed",
			failureCode,
		});
	});

	it("reports an execution deadline while retaining the unknown cost of a dispatched verifier call", async () => {
		const review = syntheticRuntime.handlers.review;
		const transport = syntheticRuntime.fetch;
		if (!review || !transport) throw new Error("Missing synthetic handler or transport");
		const deadline = new AbortController();
		const verifierStarted = Promise.withResolvers<void>();
		let verifierCalls = 0;
		const runtime = {
			...syntheticRuntime,
			handlers: {
				review: {
					...review,
					verifier: {
						output: review.output,
						systemPrompt: "Verify before the execution deadline.",
						buildInput: (payload: ReturnType<typeof buildModelPayload>) => payload,
						validate: () => undefined,
					},
				},
			},
			fetch: (...args: Parameters<typeof fetch>) => {
				const init = args[1];
				if (JSON.parse(String(init?.body)).messages[0].content !== "Verify before the execution deadline.")
					return transport(...args);
				verifierCalls++;
				const signal = init?.signal;
				if (!signal) throw new Error("Missing verifier signal");
				return Promise.resolve(
					new Response(
						new ReadableStream({
							start(controller) {
								controller.enqueue(new TextEncoder().encode(" "));
							},
							pull(controller) {
								verifierStarted.resolve();
								return new Promise<void>((resolve) => {
									const abort = () => {
										controller.error(signal.reason);
										resolve();
									};
									if (signal.aborted) abort();
									else signal.addEventListener("abort", abort, { once: true });
								});
							},
						}),
					),
				);
			},
		};
		const work = <T>(fn: () => T) => database.run(() => withAiRuntime(runtime, fn));
		const operation = await work(() => operationService.start("alice", request("alice", "verify-execution-deadline")));
		const lease = await work(() => claimNextOperation("alice"));
		if (!lease) throw new Error("Missing verifier lease");
		// Replace only the worker's deadline signal. Adapter and provider call timeouts still run normally.
		const timeout = vi.spyOn(AbortSignal, "timeout").mockReturnValueOnce(deadline.signal);
		const task = work(() => executeLease(lease));
		try {
			await Promise.race([verifierStarted.promise, task]);
			deadline.abort(new DOMException("Synthetic execution deadline elapsed", "TimeoutError"));
			await task;
		} finally {
			timeout.mockRestore();
		}
		expect(verifierCalls).toBe(1);
		expect.soft(await work(() => operationService.get("alice", operation.id))).toMatchObject({
			state: "failed",
			failureCode: "AI_DEADLINE",
			resultId: null,
		});
		const attempts = await database
			.admin()
			.query("SELECT outcome,cost_micros,output FROM ai_operation_attempt WHERE operation_id=$1 AND step_id='verify'", [
				operation.id,
			]);
		expect.soft(attempts.rows).toMatchObject([
			{
				outcome: "unknown",
				cost_micros: null,
				output: {
					_verifyCalls: [
						{
							outcome: "unknown",
							costMicros: null,
							failure: { abortCause: "operation_deadline", httpStatus: 200, bytesReceived: true, requestSent: true },
						},
					],
				},
			},
		]);
		const accounting = await database
			.admin()
			.query("SELECT budget_closed,reserved_micros::int,failure_detail FROM ai_operation WHERE id=$1", [operation.id]);
		expect(accounting.rows).toMatchObject([
			{
				budget_closed: true,
				reserved_micros: 10_000,
				failure_detail: { abortCause: "operation_deadline", httpStatus: 200, bytesReceived: true, requestSent: true },
			},
		]);
	});
	it.each(
		(["generate", "verify"] as const).flatMap((step) =>
			(["consent revoked", "cancelled", "source changed"] as const).map((blocker) => ({ step, blocker })),
		),
	)("blocks $step queued for a provider slot when $blocker", async ({ step, blocker }) => {
		const owner = "alice";
		const review = syntheticRuntime.handlers.review;
		const transport = syntheticRuntime.fetch;
		if (!review || !transport) throw new Error("Missing synthetic handler or transport");
		const verifying = step === "verify";
		const route = verifying ? resolveReviewVerifierRoute(syntheticRoute) : syntheticRoute;
		const limit = verifying ? 5 : 2;
		const occupied = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		const calls: string[] = [];
		let occupants = 0;
		const runtime = {
			...syntheticRuntime,
			handlers: {
				review: verifying
					? {
							...review,
							verifier: {
								output: review.output,
								systemPrompt: "Verify the synthetic result.",
								buildInput: (payload: ReturnType<typeof buildModelPayload>) => payload,
								validate: () => undefined,
							},
						}
					: review,
			},
			fetch: (...args: Parameters<typeof fetch>) => {
				calls.push(JSON.parse(String(args[1]?.body)).model);
				return transport(...args);
			},
		};
		const run = <T>(work: () => T) => database.run(() => withAiRuntime(runtime, work));
		const admin = database.admin();
		const payload = buildModelPayload({
			selections: [{ section: "skills", confirmed: true, text: "Synthetic slot holder" }],
			contactValues: [],
		});
		const operation = await run(() => operationService.start(owner, request(owner, `queued-${step}-${blocker}`)));
		const lease = await run(() => claimNextOperation(owner));
		if (!lease) throw new Error("Missing operation lease");
		const holds = withAiRuntime(
			{
				...syntheticRuntime,
				fetch: async (...args) => {
					if (++occupants === limit) occupied.resolve();
					await release.promise;
					return transport(...args);
				},
			},
			() =>
				Array.from({ length: limit }, (_, index) =>
					executeApprovedStep(
						{
							route,
							operationId: "slot-holder",
							attemptId: String(index),
							stepId: step,
							payload,
							outputSchema: review.output,
							signal: new AbortController().signal,
						},
						{ retry: false, concurrencyLimit: limit },
					),
				),
		);
		let worker: Promise<void> | undefined;
		try {
			await occupied.promise;
			worker = run(() => executeLease(lease));
			await vi.waitFor(async () => {
				const { rows } = await admin.query(
					"SELECT output FROM ai_operation_attempt WHERE operation_id=$1 AND step_id=$2",
					[operation.id, step],
				);
				expect(rows).toHaveLength(1);
				if (verifying) expect(readVerificationJournal(rows[0].output)?.calls).toHaveLength(1);
			});
			expect(calls).toEqual(verifying ? [syntheticRoute.model] : []);
			if (blocker === "consent revoked") await run(() => processingConsentService.revoke(owner, route.routeId));
			if (blocker === "cancelled") await run(() => operationService.cancel(owner, operation.id));
			if (blocker === "source changed")
				await admin.query("UPDATE resume SET updated_at=now() WHERE id=$1", [`cv-${owner}`]);
			release.resolve();
			await worker;
			expect(calls).toEqual(verifying ? [syntheticRoute.model] : []);
			expect(await run(() => operationService.get(owner, operation.id))).toMatchObject({
				state: blocker === "cancelled" ? "cancelled" : "failed",
				resultId: null,
			});
			expect(
				(await admin.query("SELECT actual_micros::int FROM ai_operation WHERE id=$1", [operation.id])).rows,
			).toEqual([{ actual_micros: verifying ? 10 : 0 }]);
			expect(
				(await admin.query("SELECT kind FROM ai_usage_ledger WHERE operation_id=$1 ORDER BY kind", [operation.id]))
					.rows,
			).toEqual([{ kind: "release" }, { kind: "reserve" }]);
		} finally {
			release.resolve();
			await Promise.allSettled([...holds, ...(worker ? [worker] : [])]);
			if (blocker === "consent revoked")
				await admin.query("UPDATE ai_processing_consent SET revoked_at=NULL WHERE user_id=$1", [owner]);
			if (blocker === "source changed")
				await admin.query("UPDATE resume SET updated_at=$1 WHERE id=$2", [revisions.get(owner), `cv-${owner}`]);
		}
	});
	it("waits for an in-flight consent revocation before dispatching or charging", async () => {
		const owner = "alice";
		const admin = database.admin();
		const fetch = vi.fn(syntheticRuntime.fetch);
		const operation = await run(() => operationService.start(owner, request(owner, "revocation-race")));
		const lease = await run(() => claimNextOperation(owner));
		if (!lease) throw new Error("Missing operation lease");

		const revocation = await admin.connect();
		let worker: Promise<void> | undefined;
		try {
			await revocation.query("BEGIN");
			const {
				rows: [{ pid }],
			} = await revocation.query("SELECT pg_backend_pid() AS pid");
			await revocation.query("UPDATE ai_processing_consent SET revoked_at=now() WHERE user_id=$1", [owner]);
			worker = database.run(() => withAiRuntime({ ...syntheticRuntime, fetch }, () => executeLease(lease)));
			await expect
				.poll(async () => {
					if (fetch.mock.calls.length) return "dispatched";
					const {
						rows: [{ waiting }],
					} = await admin.query(
						"SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE $1 = ANY(pg_blocking_pids(pid))) AS waiting",
						[pid],
					);
					return waiting ? "waiting for revocation" : "preparing";
				})
				.toBe("waiting for revocation");

			await revocation.query("COMMIT");
			await worker;
			expect(fetch).not.toHaveBeenCalled();
			expect(await run(() => operationService.get(owner, operation.id))).toMatchObject({
				state: "failed",
				resultId: null,
			});
			expect(
				(await admin.query("SELECT actual_micros::int FROM ai_operation WHERE id=$1", [operation.id])).rows,
			).toEqual([{ actual_micros: 0 }]);
			expect(
				(await admin.query("SELECT kind FROM ai_usage_ledger WHERE operation_id=$1 ORDER BY kind", [operation.id]))
					.rows,
			).toEqual([{ kind: "release" }, { kind: "reserve" }]);
		} finally {
			await revocation.query("ROLLBACK");
			revocation.release();
			if (worker) await Promise.allSettled([worker]);
			await admin.query("UPDATE ai_processing_consent SET revoked_at=NULL WHERE user_id=$1", [owner]);
		}
	});
	it("queues three racing owners across separate routes and claims at most two", async () => {
		const runtime = { ...syntheticRuntime, routes: [syntheticRoute, { ...syntheticRoute, routeId: "synthetic-b" }] };
		const owners = ["alice", "bob", "carol"];
		const admin = database.admin();
		await admin.query("UPDATE ai_platform_capacity SET max_running=2 WHERE singleton");
		try {
			await database.run(() =>
				withAiRuntime(runtime, async () => {
					const operations = await Promise.all(
						owners.map((owner) => operationService.start(owner, request(owner, "global-race"))),
					);
					expect(operations.map((operation) => operation.state)).toEqual(["queued", "queued", "queued"]);
					const {
						rows: [first, second, third],
					} = await admin.query<{ user_id: string }>(
						"SELECT user_id FROM ai_operation WHERE request_key='global-race' ORDER BY created_at,id",
					);
					if (!first || !second || !third) throw new Error("Missing queued operations");
					const firstLease = await claimNextOperation(first.user_id);
					const secondLease = await claimNextOperation(second.user_id);
					if (!firstLease || !secondLease) throw new Error("Missing platform leases");
					expect(await claimNextOperation(third.user_id)).toBeNull();
					expect((await admin.query("SELECT sum(active)::int AS active FROM ai_platform_budget")).rows[0].active).toBe(
						3,
					);
					await failOperation(firstLease, "AI_CANCELLED");
					const thirdLease = await claimNextOperation(third.user_id);
					if (!thirdLease) throw new Error("Missing queued lease after release");
					await Promise.all([failOperation(secondLease, "AI_CANCELLED"), failOperation(thirdLease, "AI_CANCELLED")]);
					expect(
						(await admin.query("SELECT state,execution_started_at FROM ai_operation WHERE request_key='global-race'"))
							.rows,
					).toEqual(operations.map(() => ({ state: "failed", execution_started_at: expect.any(Date) })));
				}),
			);
		} finally {
			await admin.query("UPDATE ai_platform_capacity SET max_running=30 WHERE singleton");
		}
	});
	it("rolls back copy, first revision and settlement together when result persistence fails", async () => {
		const review = syntheticRuntime.handlers.review;
		if (!review) throw new Error("Missing synthetic handler");
		const runtime = {
			...syntheticRuntime,
			handlers: {
				review: {
					...review,
					copyClaim: () => ({ variantKind: "language" as const, baseResumeId: "cv-alice" }),
					createCopy: () => ({ name: "Synthetic language", locale: "en-US" as const, data: defaultResumeData }),
				},
			},
		};
		await database
			.admin()
			.query(
				"CREATE FUNCTION reject_synthetic_copy_version() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'synthetic persistence failure'; END $$; CREATE TRIGGER reject_synthetic_copy_version BEFORE INSERT ON resume_version FOR EACH ROW EXECUTE FUNCTION reject_synthetic_copy_version()",
			);
		try {
			const operation = await database.run(() =>
				withAiRuntime(runtime, () => operationService.start("alice", request("alice", "failed-copy"))),
			);
			await database.run(() => withAiRuntime(runtime, () => runAiOperations()));
			expect(await run(() => operationService.get("alice", operation.id))).toMatchObject({
				state: "failed",
				resultId: null,
			});
			expect(
				(await database.admin().query("SELECT count(*)::int AS n FROM resume WHERE base_resume_id='cv-alice'")).rows[0]
					.n,
			).toBe(0);
			expect(
				(
					await database
						.admin()
						.query("SELECT kind FROM ai_usage_ledger WHERE operation_id=$1 ORDER BY kind", [operation.id])
				).rows,
			).toEqual([{ kind: "release" }, { kind: "reserve" }]);
			expect((await run(() => usageService.getStartUsage("alice"))).operations).toEqual({
				limit: 5,
				used: 0,
				reserved: 0,
				remaining: 5,
			});
		} finally {
			await database
				.admin()
				.query(
					"DROP TRIGGER reject_synthetic_copy_version ON resume_version; DROP FUNCTION reject_synthetic_copy_version()",
				);
		}
	});
	it("releases the platform reservation for definitive rejections across bounded retries", async () => {
		let calls = 0;
		const runtime = {
			...syntheticRuntime,
			routes: [{ ...syntheticRoute, maxCalls: 2, maxCallCostMicros: 5000 }],
			fetch: () => {
				calls++;
				return Promise.resolve(new Response("", { status: 503 }));
			},
		};
		const operation = await database.run(() =>
			withAiRuntime(runtime, () => operationService.start("alice", request("alice", "unknown-cost"))),
		);
		await database.run(() => withAiRuntime(runtime, () => runAiOperations()));
		expect(calls).toBe(2);
		expect(
			(
				await database
					.admin()
					.query("SELECT actual_micros,reserved_micros::int FROM ai_operation WHERE id=$1", [operation.id])
			).rows,
		).toEqual([{ actual_micros: "0", reserved_micros: 0 }]);
		expect((await run(() => usageService.getStartUsage("alice"))).operations.used).toBe(0);
	});
	it.each(["generate", "verify"])("reports a timed-out %s call and holds unknown spending", async (failedStep) => {
		const review = syntheticRuntime.handlers.review;
		if (!review) throw new Error("Missing synthetic handler");
		let calls = 0;
		const runtime = {
			...syntheticRuntime,
			routes: [
				{
					...syntheticRoute,
					maxCalls: 2,
					maxCallCostMicros: 1000,
					callTimeoutMs: 5,
					verifier: { evidenceVersion: "synthetic-verifier-v2", maxCallCostMicros: 7000 },
				},
			],
			handlers: {
				review: {
					...review,
					verifier: {
						output: review.output,
						systemPrompt: "Verify the synthetic result.",
						buildInput: (payload: Parameters<NonNullable<typeof review.verifier>["buildInput"]>[0]) => payload,
						validate: () => undefined,
					},
				},
			},
			fetch: (_url: unknown, init?: RequestInit) => {
				calls++;
				if (failedStep === "verify" && calls === 1) {
					const transport = syntheticRuntime.fetch;
					if (!transport) throw new Error("Missing transport");
					return transport("https://openrouter.ai/api/v1/chat/completions", init);
				}
				return Promise.resolve(
					new Response(
						new ReadableStream({
							start(controller) {
								const signal = init?.signal;
								if (!signal) throw new Error("Missing abort signal");
								if (signal.aborted) controller.error(signal.reason);
								else signal.addEventListener("abort", () => controller.error(signal.reason), { once: true });
							},
						}),
					),
				);
			},
		};
		const operation = await database.run(() =>
			withAiRuntime(runtime, () => operationService.start("alice", request("alice", `${failedStep}-timeout`))),
		);
		await database.run(() => withAiRuntime(runtime, () => runAiOperations()));
		expect(await run(() => operationService.get("alice", operation.id))).toMatchObject({
			state: "failed",
			failureCode: "AI_TIMEOUT",
			resultId: null,
		});
		expect(calls).toBe(failedStep === "verify" ? 2 : 1);
		expect(
			(
				await database
					.admin()
					.query(
						"SELECT step_id,outcome,input_tokens,output_tokens,cost_micros FROM ai_operation_attempt WHERE operation_id=$1 AND outcome='unknown'",
						[operation.id],
					)
			).rows,
		).toEqual([
			{ step_id: failedStep, outcome: "unknown", input_tokens: null, output_tokens: null, cost_micros: null },
		]);
		expect(
			(
				await database
					.admin()
					.query("SELECT actual_micros,reserved_micros::int FROM ai_operation WHERE id=$1", [operation.id])
			).rows,
		).toEqual([{ actual_micros: null, reserved_micros: 10000 }]);
		expect((await run(() => usageService.getStartUsage("alice"))).operations.used).toBe(0);
		const spent = async () =>
			(await database.admin().query("SELECT spent_micros::int FROM ai_platform_budget WHERE id='synthetic'")).rows[0]
				.spent_micros;
		const before = await spent();
		// Age the deadline in the disposable fixture to exercise accounting rollover.
		await database.admin().query(`
			ALTER TABLE ai_operation DISABLE TRIGGER ai_operation_guard;
			UPDATE ai_operation SET deadline_at=now()-interval '6 minutes' WHERE request_key='${failedStep}-timeout';
			ALTER TABLE ai_operation ENABLE TRIGGER ai_operation_guard;
		`);
		await run(() => reconcileExpiredAccounting("alice"));
		await run(() => reconcileExpiredAccounting("alice"));
		expect((await spent()) - before).toBe(failedStep === "verify" ? 7010 : 10000);
	});
	it("retries once on pre-response connection loss and fails AI_OUTCOME_UNKNOWN if retry also drops", async () => {
		let calls = 0;
		const callTimes: number[] = [];
		const infoSpy = vi.spyOn(console, "info").mockImplementation(() => {});
		const runtime = {
			...syntheticRuntime,
			fetch: async () => {
				calls++;
				callTimes.push(Date.now());
				throw new TypeError("fetch failed", {
					cause: Object.assign(new Error("socket closed after request write"), {
						code: "ECONNRESET",
						bytesWritten: 512,
					}),
				});
			},
		};
		try {
			const operation = await database.run(() =>
				withAiRuntime(runtime, () => operationService.start("carol", request("carol", "dispatched-connection-loss"))),
			);
			await database.run(() => withAiRuntime(runtime, () => runAiOperations()));
			expect(await run(() => operationService.get("carol", operation.id))).toMatchObject({
				state: "failed",
				failureCode: "AI_OUTCOME_UNKNOWN",
				resultId: null,
			});
			expect(calls).toBe(2);
			expect((callTimes[1] ?? 0) - (callTimes[0] ?? 0)).toBeGreaterThanOrEqual(950);
			const rows = (
				await database
					.admin()
					.query("SELECT actual_micros,reserved_micros::int,failure_detail FROM ai_operation WHERE id=$1", [
						operation.id,
					])
			).rows;
			expect(rows).toEqual([
				{
					actual_micros: null,
					reserved_micros: 10000,
					failure_detail: {
						errorClass: "TypeError",
						message: "fetch failed",
						causeCode: "ECONNRESET",
						httpStatus: null,
						bytesReceived: false,
						requestSent: true,
						causes: [{ errorClass: "Error", code: "ECONNRESET", message: "socket closed after request write" }],
					},
				},
			]);
			expect(infoSpy).toHaveBeenCalledWith(
				"[ai-operation]",
				expect.objectContaining({
					event: "outcome_unknown",
					kind: "review",
					operationId: operation.id,
					stepId: "generate",
					attempt: 2,
					failure: expect.objectContaining({
						errorClass: "TypeError",
						causeCode: "ECONNRESET",
						httpStatus: null,
						requestSent: true,
					}),
				}),
			);
		} finally {
			infoSpy.mockRestore();
		}
	});
	it("does not repeat generation after partial response bytes, HTTP status with unknown cost, or generation id", async () => {
		let calls = 0;
		const partialRuntime = {
			...syntheticRuntime,
			fetch: async () => {
				calls++;
				return new Response(
					new ReadableStream({
						start(controller) {
							controller.enqueue(new TextEncoder().encode('{"id":"gen-1","choices":'));
							controller.error(new TypeError("stream dropped mid-body"));
						},
					}),
					{ status: 200, headers: { "content-type": "application/json" } },
				);
			},
		};
		const opPartial = await database.run(() =>
			withAiRuntime(partialRuntime, () => operationService.start("carol", request("carol", "partial-body-loss"))),
		);
		await database.run(() => withAiRuntime(partialRuntime, () => runAiOperations()));
		expect(await run(() => operationService.get("carol", opPartial.id))).toMatchObject({
			state: "failed",
			failureCode: "AI_OUTCOME_UNKNOWN",
			resultId: null,
		});
		expect(calls).toBe(1);

		let usageCalls = 0;
		const usageRuntime = {
			...syntheticRuntime,
			fetch: async () => {
				usageCalls++;
				return Response.json(
					{ id: "gen-2", error: { code: 503, message: "overloaded" }, usage: { prompt_tokens: 4 } },
					{ status: 503 },
				);
			},
		};
		const opUsage = await database.run(() =>
			withAiRuntime(usageRuntime, () => operationService.start("carol", request("carol", "status-usage-unknown-cost"))),
		);
		await database.run(() => withAiRuntime(usageRuntime, () => runAiOperations()));
		expect(await run(() => operationService.get("carol", opUsage.id))).toMatchObject({
			state: "failed",
			failureCode: "AI_OUTCOME_UNKNOWN",
			resultId: null,
		});
		expect(usageCalls).toBe(1);
	});
	it("does not resend a recovered transient attempt whose provider bill is unknown", async () => {
		const runtime = { ...syntheticRuntime, routes: [{ ...syntheticRoute, routeId: "synthetic-b" }] };
		const operation = await database.run(() =>
			withAiRuntime(runtime, () => operationService.start("bob", request("bob", "recover-unknown-transient"))),
		);
		const lease = await database.run(() => withAiRuntime(runtime, () => claimNextOperation("bob")));
		if (!lease) throw new Error("Missing lease");
		await database
			.admin()
			.query(
				"INSERT INTO ai_operation_attempt(id,user_id,operation_id,ordinal,step_id,lease_token,outcome,cost_micros,finished_at) VALUES ('unknown-transient','bob',$1,1,'generate',$2,'transient',NULL,now())",
				[operation.id, lease.token],
			);
		await database
			.admin()
			.query("UPDATE ai_operation SET lease_until=now()-interval '1 minute' WHERE id=$1", [operation.id]);
		let calls = 0;
		const transport = syntheticRuntime.fetch;
		if (!transport) throw new Error("Missing synthetic transport");
		await database.run(() =>
			withAiRuntime(
				{
					...runtime,
					fetch: (...args: Parameters<typeof fetch>) => {
						calls++;
						return transport(...args);
					},
				},
				() => runAiOperations(),
			),
		);
		expect(await run(() => operationService.get("bob", operation.id))).toMatchObject({
			state: "failed",
			failureCode: "AI_OUTCOME_UNKNOWN",
			resultId: null,
		});
		expect(calls).toBe(0);
		expect(
			(
				await database
					.admin()
					.query("SELECT actual_micros,reserved_micros::int FROM ai_operation WHERE id=$1", [operation.id])
			).rows,
		).toEqual([{ actual_micros: null, reserved_micros: 10000 }]);
	});
	it("makes no provider call when consent is revoked while preparing its input", async () => {
		const review = syntheticRuntime.handlers.review;
		const transport = syntheticRuntime.fetch;
		if (!review || !transport) throw new Error("Missing synthetic handler or transport");
		let calls = 0;
		const runtime = {
			...syntheticRuntime,
			handlers: {
				review: {
					...review,
					buildInput: async (...args: Parameters<typeof review.buildInput>) => {
						await database.admin().query("UPDATE ai_processing_consent SET revoked_at=now() WHERE id='consent-alice'");
						return review.buildInput(...args);
					},
				},
			},
			fetch: (...args: Parameters<typeof fetch>) => {
				calls++;
				return transport(...args);
			},
		};
		try {
			const operation = await database.run(() =>
				withAiRuntime(runtime, () => operationService.start("alice", request("alice", "preparation-revoked"))),
			);
			await database.run(() => withAiRuntime(runtime, () => runAiOperations()));
			expect(calls).toBe(0);
			expect(await run(() => operationService.get("alice", operation.id))).toMatchObject({
				state: "failed",
				resultId: null,
			});
		} finally {
			await database.admin().query("UPDATE ai_processing_consent SET revoked_at=NULL WHERE id='consent-alice'");
		}
	});
	it("makes no provider call if input preparation consumes the operation deadline", async () => {
		const review = syntheticRuntime.handlers.review;
		const transport = syntheticRuntime.fetch;
		if (!review || !transport) throw new Error("Missing synthetic handler or transport");
		let calls = 0;
		const now = Date.now();
		const clock = vi.spyOn(Date, "now");
		const runtime = {
			...syntheticRuntime,
			routes: [{ ...syntheticRoute, deadlineMs: 1000 }],
			handlers: {
				review: {
					...review,
					buildInput: async (...args: Parameters<typeof review.buildInput>) => {
						clock.mockReturnValue(now + 2000);
						return review.buildInput(...args);
					},
				},
			},
			fetch: (...args: Parameters<typeof fetch>) => {
				calls++;
				return transport(...args);
			},
		};
		try {
			const operation = await database.run(() =>
				withAiRuntime(runtime, () => operationService.start("alice", request("alice", "input-deadline"))),
			);
			await database.run(() => withAiRuntime(runtime, () => runAiOperations()));
			expect(calls).toBe(0);
			expect(await run(() => operationService.get("alice", operation.id))).toMatchObject({
				state: "failed",
				failureCode: "AI_DEADLINE",
				resultId: null,
			});
		} finally {
			clock.mockRestore();
		}
	});
	it("discovers another owner while a provider call occupies a worker", async () => {
		const firstDispatched = Promise.withResolvers<void>();
		const refreshScheduled = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		const transport = syntheticRuntime.fetch;
		if (!transport) throw new Error("Missing synthetic transport");
		const firstRoute = { ...syntheticRoute, model: "synthetic/discovery-first" };
		const nextRoute = { ...syntheticRoute, routeId: "synthetic-b", model: "synthetic/discovery-next" };
		const runtime = {
			...syntheticRuntime,
			routes: [firstRoute, nextRoute],
			fetch: async (...args: Parameters<typeof fetch>) => {
				if (JSON.parse(String(args[1]?.body)).model === firstRoute.model) {
					firstDispatched.resolve();
					await release.promise;
				}
				return transport(...args);
			},
		};
		const work = <T>(fn: () => T) => database.run(() => withAiRuntime(runtime, fn));
		const first = await work(() => operationService.start("alice", request("alice", "discover-running-owner")));
		// Trigger the worker's scheduled refresh after Bob queues, even under CPU contention.
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
		const schedule = globalThis.setTimeout;
		const timer = vi.spyOn(globalThis, "setTimeout").mockImplementation((callback, delay, ...args) => {
			const handle = schedule(callback, delay, ...args);
			if (delay === 1000) refreshScheduled.resolve();
			return handle;
		});
		const worker = work(() => runAiOperations(undefined, 6));
		try {
			await Promise.race([
				Promise.all([firstDispatched.promise, refreshScheduled.promise]),
				worker.then(() => {
					throw new Error("Worker finished before its first refresh");
				}),
			]);
			const next = await work(() => operationService.start("bob", request("bob", "discover-new-owner")));
			await vi.advanceTimersByTimeAsync(1000);
			await expect
				.poll(async () => (await work(() => operationService.get("bob", next.id))).state, { timeout: 3000 })
				.toBe("waiting_review");
			expect((await work(() => operationService.get("alice", first.id))).state).toBe("running");
		} finally {
			release.resolve();
			try {
				await worker;
			} finally {
				timer.mockRestore();
				vi.useRealTimers();
			}
		}
		expect((await work(() => operationService.get("alice", first.id))).state).toBe("waiting_review");
	});
	it.each([true, false])("retries an invalid checker contract once (recovered: %s)", async (recovered) => {
		const review = syntheticRuntime.handlers.review;
		if (!review) throw new Error("Missing synthetic handler");
		const used = (await run(() => usageService.getStartUsage("alice"))).operations.used;
		let calls = 0;
		const runtime = {
			...syntheticRuntime,
			handlers: {
				review: {
					...review,
					verifier: {
						output: review.output,
						systemPrompt: "Verify the synthetic result.",
						buildInput: (payload: Parameters<NonNullable<typeof review.verifier>["buildInput"]>[0]) => payload,
						validate: () => undefined,
					},
				},
			},
			fetch: async (_url: unknown, init?: RequestInit) => {
				calls++;
				const transport = syntheticRuntime.fetch;
				if (!transport) throw new Error("Missing transport");
				const response = await transport("https://openrouter.ai/api/v1/chat/completions", init);
				if (calls === 1 || (recovered && calls === 3)) return response;
				const body = await response.json();
				body.choices[0].message.content = "{}";
				return new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } });
			},
		};
		const operation = await database.run(() =>
			withAiRuntime(runtime, () => operationService.start("alice", request("alice", `checker-schema-${recovered}`))),
		);
		await database.run(() => withAiRuntime(runtime, () => runAiOperations()));
		expect(calls).toBe(3);
		expect(await run(() => operationService.get("alice", operation.id))).toMatchObject(
			recovered
				? { state: "waiting_review", failureCode: null }
				: { state: "failed", failureCode: "AI_VERIFICATION_INCOMPLETE" },
		);
		const attempts = await database
			.admin()
			.query(
				"SELECT step_id,outcome,cost_micros,output FROM ai_operation_attempt WHERE operation_id=$1 ORDER BY ordinal",
				[operation.id],
			);
		expect(attempts.rows.map((attempt) => attempt.step_id)).toEqual(["generate", "verify"]);
		expect(attempts.rows[1]?.output._verifyCalls.map((call: { outcome: string }) => call.outcome)).toEqual([
			"transient",
			recovered ? "valid" : "transient",
		]);
		expect(attempts.rows.every((attempt) => attempt.cost_micros !== null)).toBe(true);
		expect((await run(() => usageService.getStartUsage("alice"))).operations.used).toBe(used + Number(recovered));
		if (!recovered) {
			expect(
				(await database.admin().query("SELECT failure_detail FROM ai_operation WHERE id=$1", [operation.id])).rows,
			).toEqual([{ failure_detail: { rule: "AI_VERIFICATION_SCHEMA" } }]);
		}
	});
	it("records zero cost for connect-phase AggregateError so subsequent generate and verify steps fit inside reservation", async () => {
		const review = syntheticRuntime.handlers.review;
		if (!review) throw new Error("Missing synthetic handler");
		let calls = 0;
		const runtime = {
			...syntheticRuntime,
			handlers: {
				review: {
					...review,
					verifier: {
						output: review.output,
						systemPrompt: "Verify the synthetic result.",
						buildInput: (payload: Parameters<NonNullable<typeof review.verifier>["buildInput"]>[0]) => payload,
						validate: () => undefined,
					},
				},
			},
			fetch: async (_url: unknown, init?: RequestInit) => {
				calls++;
				if (calls === 1) {
					throw new TypeError("fetch failed", {
						cause: new AggregateError(
							[
								Object.assign(new Error("connect ETIMEDOUT 104.18.3.115:443"), {
									code: "ETIMEDOUT",
									syscall: "connect",
								}),
								Object.assign(new Error("connect ENETUNREACH 2606:4700::1:443"), {
									code: "ENETUNREACH",
									syscall: "connect",
								}),
							],
							"",
						),
					});
				}
				const transport = syntheticRuntime.fetch;
				if (!transport) throw new Error("Missing transport");
				return transport("https://openrouter.ai/api/v1/chat/completions", init);
			},
		};
		const operation = await database.run(() =>
			withAiRuntime(runtime, () => operationService.start("alice", request("alice", "connect-zero-cost-fits-verify"))),
		);
		await database.run(() => withAiRuntime(runtime, () => runAiOperations()));
		expect(calls).toBe(3);
		expect(await run(() => operationService.get("alice", operation.id))).toMatchObject({
			state: "waiting_review",
			failureCode: null,
		});
		const attempts = await database
			.admin()
			.query(
				"SELECT ordinal,step_id,outcome,cost_micros FROM ai_operation_attempt WHERE operation_id=$1 ORDER BY ordinal",
				[operation.id],
			);
		expect(attempts.rows).toMatchObject([
			{ ordinal: 1, step_id: "generate", outcome: "transient", cost_micros: "0" },
			{ ordinal: 2, step_id: "generate", outcome: "valid" },
			{ ordinal: 3, step_id: "verify", outcome: "valid" },
		]);
	});
	it("persists sanitized transport failure detail and logs when verifier is unavailable", async () => {
		const review = syntheticRuntime.handlers.review;
		if (!review) throw new Error("Missing synthetic handler");
		const infoSpy = vi.spyOn(console, "info").mockImplementation(() => {});
		let calls = 0;
		const runtime = {
			...syntheticRuntime,
			handlers: {
				review: {
					...review,
					verifier: {
						output: review.output,
						systemPrompt: "Verify the synthetic result.",
						buildInput: (payload: Parameters<NonNullable<typeof review.verifier>["buildInput"]>[0]) => payload,
						validate: () => undefined,
					},
				},
			},
			fetch: async (_url: unknown, init?: RequestInit) => {
				calls++;
				if (calls === 1) {
					const transport = syntheticRuntime.fetch;
					if (!transport) throw new Error("Missing transport");
					return transport("https://openrouter.ai/api/v1/chat/completions", init);
				}
				throw new TypeError("fetch failed", {
					cause: Object.assign(new Error("connect ETIMEDOUT 104.18.3.115:443"), {
						code: "ETIMEDOUT",
						syscall: "connect",
					}),
				});
			},
		};
		try {
			const operation = await database.run(() =>
				withAiRuntime(runtime, () => operationService.start("alice", request("alice", "verifier-unavailable-detail"))),
			);
			await database.run(() => withAiRuntime(runtime, () => runAiOperations()));
			expect(await run(() => operationService.get("alice", operation.id))).toMatchObject({
				state: "failed",
				failureCode: "AI_VERIFIER_UNAVAILABLE",
			});
			const rows = (await database.admin().query("SELECT failure_detail FROM ai_operation WHERE id=$1", [operation.id]))
				.rows;
			expect(rows).toEqual([
				{
					failure_detail: expect.objectContaining({
						errorClass: "TypeError",
						causeCode: "ETIMEDOUT",
						httpStatus: null,
						requestSent: false,
					}),
				},
			]);
			expect(infoSpy).toHaveBeenCalledWith(
				"[ai-operation]",
				expect.objectContaining({
					event: "verifier_unavailable",
					operationId: operation.id,
					stepId: "verify",
					failure: expect.objectContaining({ causeCode: "ETIMEDOUT", requestSent: false }),
				}),
			);
		} finally {
			infoSpy.mockRestore();
		}
	});
	it.each(["AI_VERIFICATION_CITATION", "LETTER_VERIFICATION_INCOMPLETE"] as const)(
		"retries verify once on %s and delivers when the retry passes",
		async (rule) => {
			const review = syntheticRuntime.handlers.review;
			if (!review) throw new Error("Missing synthetic handler");
			let verifyCalls = 0;
			const runtime = {
				...syntheticRuntime,
				handlers: {
					review: {
						...review,
						verifier: {
							output: review.output,
							systemPrompt: "Verify the synthetic result.",
							buildInput: (payload: Parameters<NonNullable<typeof review.verifier>["buildInput"]>[0]) => payload,
							validate: () => {
								verifyCalls++;
								if (verifyCalls === 1) throw new Error(rule);
							},
						},
					},
				},
			};
			const operation = await database.run(() =>
				withAiRuntime(runtime, () => operationService.start("alice", request("alice", `retry-${rule}`))),
			);
			await database.run(() => withAiRuntime(runtime, () => runAiOperations()));
			expect(await run(() => operationService.get("alice", operation.id))).toMatchObject({
				state: "waiting_review",
				failureCode: null,
			});
			const attempts = await database
				.admin()
				.query(
					"SELECT ordinal,step_id,outcome,output FROM ai_operation_attempt WHERE operation_id=$1 ORDER BY ordinal",
					[operation.id],
				);
			expect(attempts.rows.map(({ output: _output, ...attempt }) => attempt)).toEqual([
				{ ordinal: 1, step_id: "generate", outcome: "valid" },
				{ ordinal: 2, step_id: "verify", outcome: "valid" },
			]);
			expect(attempts.rows[1]?.output._verifyCalls.map((call: { outcome: string }) => call.outcome)).toEqual([
				"transient",
				"valid",
			]);
		},
	);
	it.each([
		[401, "401 key", "invalid_api_key"],
		[402, "402 credits", "insufficient_credits"],
		[403, "403 limit", "key_limit_exceeded"],
	] as const)(
		"maps provider HTTP %i ACCOUNT_ERROR to AI_PROVIDER_UNAVAILABLE without retrying or charging the user",
		async (status, statusMeaning, providerErrorCode) => {
			const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
			let calls = 0;
			const runtime = {
				...syntheticRuntime,
				localOwnerAllowance: { ownerId: "alice", limit: 100 },
				fetch: async () => {
					calls++;
					return new Response(
						JSON.stringify({ error: { code: status, type: providerErrorCode, message: "Refused" } }),
						{
							status,
							headers: { "content-type": "application/json" },
						},
					);
				},
			};
			try {
				const operation = await database.run(() =>
					withAiRuntime(runtime, () => operationService.start("alice", request("alice", `acct-err-${status}`))),
				);
				await database.run(() => withAiRuntime(runtime, () => runAiOperations()));
				expect(calls).toBe(1);
				expect(await run(() => operationService.get("alice", operation.id))).toMatchObject({
					state: "failed",
					failureCode: "AI_PROVIDER_UNAVAILABLE",
				});
				const detail = (
					await database.admin().query("SELECT failure_detail FROM ai_operation WHERE id=$1", [operation.id])
				).rows[0]?.failure_detail;
				expect(detail).toMatchObject({ httpStatus: status, statusMeaning, providerErrorCode });
				expect(JSON.stringify(detail)).not.toContain("synthetic-key");
				expect(errorSpy).toHaveBeenCalledWith(
					"[ai-operation]",
					expect.objectContaining({
						event: "provider_account_error",
						operationId: operation.id,
						httpStatus: status,
						statusMeaning,
						providerErrorCode,
					}),
				);
				const ledger = (
					await database
						.admin()
						.query("SELECT kind FROM ai_usage_ledger WHERE operation_id=$1 ORDER BY kind", [operation.id])
				).rows;
				expect(ledger).toEqual([{ kind: "release" }, { kind: "reserve" }]);
			} finally {
				errorSpy.mockRestore();
			}
		},
	);
	it.each([2, 4, 5])(
		"completes generate -> %i-batch verify -> regenerate -> verify within ordinal 1..7",
		async (batchCount) => {
			const review = syntheticRuntime.handlers.review;
			const transport = syntheticRuntime.fetch;
			if (!review || !transport) throw new Error("Missing synthetic handler");
			let validateCalls = 0;
			let writers = 0;
			let active = 0;
			let peak = 0;
			let simulatedTime = Date.now();
			let waveReady = false;
			const pricedVerifier = batchCount === 4;
			const writerCostMicros = pricedVerifier ? 16_041 : 1000;
			const routeId = pricedVerifier ? "synthetic-priced-verifier" : syntheticRoute.routeId;
			const runtime: import("./route-policy").AiRuntime = {
				...syntheticRuntime,
				localOwnerAllowance: { ownerId: "alice", limit: 100 },
				routes: [
					{
						...syntheticRoute,
						routeId,
						maxCalls: 2,
						maxCallCostMicros: pricedVerifier ? 100_000 : 20_000,
						requestCapMicros: 200_000,
						dayCapMicros: 1_000_000,
						verifier: {
							evidenceVersion: "synthetic-verifier-v2",
							maxCallCostMicros: pricedVerifier ? 100_000 : 20_000,
							...(pricedVerifier ? { boundByTogetherPricing: true, maxOutputTokens: 16_384 } : {}),
						},
					},
				],
				fetch: async (...args) => {
					const body = JSON.parse(String(args[1]?.body));
					const isVerifier = body.messages[0].content === "Verify split batch.";
					if (isVerifier) {
						if (active === 0) waveReady = false;
						peak = Math.max(peak, ++active);
						if (active === batchCount) {
							simulatedTime += 20_000;
							waveReady = true;
						}
						await vi.waitFor(() => expect(waveReady).toBe(true), { timeout: 3000 });
						active--;
					} else {
						writers++;
						simulatedTime += 5_000;
					}
					const result = await (await transport(...args)).json();
					result.choices[0].message.content = JSON.stringify({ text: `Candidate ${writers}` });
					result.usage.cost = (isVerifier ? 1000 : writerCostMicros) / 1_000_000;
					return Response.json(result);
				},
				handlers: {
					review: {
						...review,
						verifier: {
							output: review.output,
							systemPrompt: "Verify split batch.",
							buildInput: (payload: Parameters<NonNullable<typeof review.verifier>["buildInput"]>[0]) => payload,
							validate: () => undefined,
							buildBatchesInContext: async (_tx, _ownerId, _req, output) => ({
								batches: Array.from({ length: batchCount }, (_, index) => ({
									output,
									payload: {
										selections: [
											{ id: `b${index}`, kind: "confirmed_content", section: "summary", text: `batch ${index}` },
										],
									},
									itemIds: [`s${index}`],
								})),
							}),
							validateBatchesInContext: async (_tx, _ownerId, _req, output, verdicts) => {
								for (const verdict of verdicts) expect(review.output.parse(verdict)).toEqual(output);
								validateCalls++;
								if (validateCalls === 1) throw new VerificationGateError("AI_VERIFICATION_CLAIM_SUPPORT");
								return { output, batchCount };
							},
						},
					},
				},
			};
			const admin = database.admin();
			if (pricedVerifier) {
				await admin.query(
					"INSERT INTO ai_platform_budget(id,route_id,route_revision,window_date,cap_micros,request_cap_micros,concurrency) VALUES ($1,$1,'1',(now() AT TIME ZONE 'UTC')::date,1000000,200000,2)",
					[routeId],
				);
				await admin.query(
					"INSERT INTO ai_processing_consent(id,user_id,route_id,route_revision,notice_version,purpose,config_revision) VALUES ($1,'alice',$1,'1','1','review','1')",
					[routeId],
				);
			} else {
				await admin.query(
					"UPDATE ai_platform_budget SET cap_micros=1000000,request_cap_micros=200000 WHERE id='synthetic'",
				);
			}
			const runWaves = <T>(work: () => T) => database.run(() => withAiRuntime(runtime, work));
			const input = request("alice", `split-verify-regenerate-${batchCount}`);
			const operation = await runWaves(() =>
				operationService.start("alice", { ...input, route: { ...input.route, routeId } }),
			);
			const lease = await runWaves(() => claimNextOperation("alice"));
			if (!lease) throw new Error("Missing wave lease");
			const [{ execution_started_at: startedAt, deadline_at: deadlineAt }] = (
				await database
					.admin()
					.query("SELECT execution_started_at, deadline_at FROM ai_operation WHERE id=$1", [operation.id])
			).rows;
			simulatedTime = startedAt.getTime();
			const clock = vi.spyOn(Date, "now").mockImplementation(() => simulatedTime);
			try {
				await runWaves(() => executeLease(lease));
			} finally {
				clock.mockRestore();
				if (!pricedVerifier)
					await admin.query(
						"UPDATE ai_platform_budget SET cap_micros=100000,request_cap_micros=10000 WHERE id='synthetic'",
					);
			}
			expect(await run(() => operationService.get("alice", operation.id))).toMatchObject({
				state: "waiting_review",
				failureCode: null,
			});
			const attempts = await database
				.admin()
				.query("SELECT ordinal,step_id,outcome FROM ai_operation_attempt WHERE operation_id=$1 ORDER BY ordinal", [
					operation.id,
				]);
			expect(attempts.rows).toEqual([
				{ ordinal: 1, step_id: "generate", outcome: "valid" },
				{ ordinal: 2, step_id: "verify", outcome: "valid" },
				{ ordinal: 3, step_id: "regenerate", outcome: "valid" },
				{ ordinal: 4, step_id: "verify", outcome: "valid" },
			]);
			const verification = (
				await database
					.admin()
					.query(
						"SELECT cost_micros::int, output FROM ai_operation_attempt WHERE operation_id=$1 AND step_id='verify' ORDER BY ordinal",
						[operation.id],
					)
			).rows;
			expect(verification.map((row) => row.output._verifyCalls.length)).toEqual([batchCount, batchCount]);
			expect(verification.map((row) => row.cost_micros)).toEqual([batchCount * 1000, batchCount * 1000]);
			expect(new Set(verification.map((row) => row.output._verifyBinding.candidateSha256)).size).toBe(2);
			expect(
				(await database.admin().query("SELECT actual_micros::int FROM ai_operation WHERE id=$1", [operation.id]))
					.rows[0].actual_micros,
			).toBe((batchCount * 1000 + writerCostMicros) * 2);
			expect(
				(
					await database
						.admin()
						.query("SELECT kind FROM ai_usage_ledger WHERE operation_id=$1 ORDER BY created_at", [operation.id])
				).rows,
			).toEqual([{ kind: "reserve" }, { kind: "settle" }]);
			expect(peak).toBe(batchCount);
			expect(simulatedTime - startedAt.getTime()).toBe(50_000);
			expect(simulatedTime).toBeLessThan(deadlineAt.getTime());
		},
	);
	it.each(["deadline", "depleted"] as const)(
		"leaves legacy-bound verification batches unsent when %s stops serial dispatch",
		async (limit) => {
			const handler = syntheticRuntime.handlers.review;
			const transport = syntheticRuntime.fetch;
			if (!handler || !transport) throw new Error("Missing synthetic handler");
			const calls: string[] = [];
			let simulatedTime = Date.now();
			const routeId = `synthetic-legacy-${limit}`;
			const runtime: import("./route-policy").AiRuntime = {
				...syntheticRuntime,
				localOwnerAllowance: { ownerId: "alice", limit: 100 },
				routes: [
					{
						...syntheticRoute,
						routeId,
						maxCalls: 2,
						requestCapMicros: 200_000,
						dayCapMicros: 1_000_000,
						maxCallCostMicros: 100_000,
						deadlineMs: 120_000,
						verifier: { evidenceVersion: "synthetic-verifier-v2", maxCallCostMicros: 100_000 },
					},
				],
				handlers: {
					review: {
						...handler,
						verifier: {
							output: handler.output,
							systemPrompt: "Verify legacy serial batch.",
							buildInput: (payload) => payload,
							buildBatchesInContext: async (_tx, _owner, _request, output) => ({
								batches: ["batch-1", "batch-2", "batch-3"].map((id) => ({
									itemIds: [id],
									output,
									payload: { selections: [{ id, section: "summary", text: id }] },
								})),
							}),
							validate: () => undefined,
						},
					},
				},
				fetch: async (...args) => {
					const body = JSON.parse(String(args[1]?.body));
					const isVerifier = body.messages[0].content === "Verify legacy serial batch.";
					const result = await (await transport(...args)).json();
					if (isVerifier) {
						calls.push(JSON.parse(body.messages.at(-1).content).selections[0].id);
						simulatedTime += 60_000;
					}
					result.usage.cost = isVerifier ? (limit === "depleted" ? 0.1 : 0.001) : 0.009;
					return Response.json(result);
				},
			};
			const work = <T>(fn: () => T) => database.run(() => withAiRuntime(runtime, fn));
			const admin = database.admin();
			await admin.query(
				"INSERT INTO ai_platform_budget(id,route_id,route_revision,window_date,cap_micros,request_cap_micros,concurrency) VALUES ($1,$1,'1',(now() AT TIME ZONE 'UTC')::date,1000000,200000,2)",
				[routeId],
			);
			await admin.query(
				"INSERT INTO ai_processing_consent(id,user_id,route_id,route_revision,notice_version,purpose,config_revision) VALUES ($1,'alice',$1,'1','1','review','1')",
				[routeId],
			);
			const input = request("alice", `legacy-serial-${limit}`);
			const operation = await work(() =>
				operationService.start("alice", { ...input, route: { ...input.route, routeId } }),
			);
			const lease = await work(() => claimNextOperation("alice"));
			if (!lease) throw new Error("Missing serial wave lease");
			// Let the test clock advance past the deadline without also testing heartbeat renewal.
			const { rows } = await admin.query(
				"UPDATE ai_operation SET lease_until=deadline_at+interval '1 minute' WHERE id=$1 RETURNING execution_started_at",
				[operation.id],
			);
			simulatedTime = rows[0].execution_started_at.getTime();
			const clock = vi.spyOn(Date, "now").mockImplementation(() => simulatedTime);
			try {
				await work(() => executeLease(lease));
			} finally {
				clock.mockRestore();
			}
			expect(calls).toEqual(limit === "deadline" ? ["batch-1", "batch-2"] : ["batch-1"]);
			expect(await work(() => operationService.get("alice", operation.id))).toMatchObject({
				state: "failed",
				resultId: null,
				failureCode: limit === "deadline" ? "AI_DEADLINE" : "AI_REQUEST_COST_LIMIT",
			});
			const settled = await admin.query("SELECT actual_micros::int FROM ai_operation WHERE id=$1", [operation.id]);
			expect(settled.rows).toEqual([{ actual_micros: limit === "deadline" ? 11_000 : 109_000 }]);
		},
	);
	it.each(["single", "split", "aggregate", "ambiguous"] as const)(
		"recovers existing %s verification receipts without repeating provider requests",
		async (format) => {
			const handler = syntheticRuntime.handlers.review;
			if (!handler) throw new Error("Missing synthetic handler");
			const output = { text: "Historical candidate" };
			const verdicts = [{ text: "First verdict" }, { text: "Second verdict" }];
			const checkVerdicts = (actual: unknown, expected: unknown) => expect(actual).toEqual(expected);
			const fetch = vi.fn<typeof globalThis.fetch>();
			const runtime: import("./route-policy").AiRuntime = {
				...syntheticRuntime,
				localOwnerAllowance: { ownerId: "alice", limit: 100 },
				fetch,
				handlers: {
					review: {
						...handler,
						verifier: {
							output: handler.output,
							systemPrompt: "Verify historical candidate.",
							buildInput: (payload) => payload,
							validate: () => undefined,
							validateInContext: async (_tx, _owner, _request, candidate, verdict) => {
								checkVerdicts(verdict, verdicts[0]);
								return { output: candidate };
							},
							validateBatchesInContext: async (_tx, _owner, _request, candidate, actual) => {
								checkVerdicts(actual, verdicts);
								return { output: candidate, batchCount: actual.length };
							},
						},
					},
				},
			};
			const work = <T>(fn: () => T) => database.run(() => withAiRuntime(runtime, fn));
			const key = `recover-legacy-${format}`;
			const operation = await work(() => operationService.start("alice", request("alice", key)));
			const lease = await work(() => claimNextOperation("alice"));
			if (!lease) throw new Error("Missing initial lease");
			const insert = (ordinal: number, step: string, result: Record<string, unknown>, finished: boolean) =>
				database.admin().query(
					`INSERT INTO ai_operation_attempt(id,user_id,operation_id,ordinal,step_id,lease_token,outcome,cost_micros,finished_at,output)
					 VALUES ($1,'alice',$2,$3,$4,$5,$6,$7,CASE WHEN $8 THEN now() ELSE NULL END,$9)`,
					[
						`${key}-${ordinal}`,
						operation.id,
						ordinal,
						step,
						lease.token,
						finished ? "valid" : "unknown",
						finished ? 10 : null,
						finished,
						result,
					],
				);
			await insert(1, "generate", output, true);
			switch (format) {
				case "split":
					for (const [index, verdict] of verdicts.entries())
						await insert(index + 2, "verify", { ...verdict, _verifyBatchIndex: index, _verifyBatchTotal: 2 }, true);
					break;
				case "aggregate":
					await insert(
						2,
						"verify",
						{
							_verifyBatchTotal: 2,
							_verifyCalls: verdicts.map((verdict, batchIndex) => ({
								outcome: "valid",
								batchIndex,
								output: verdict,
								costMicros: 5,
							})),
						},
						true,
					);
					break;
				default:
					await insert(2, "verify", { ...verdicts[0] }, format === "single");
			}
			await database
				.admin()
				.query("UPDATE ai_operation SET lease_until=now()-interval '1 minute' WHERE id=$1", [operation.id]);
			const reclaimed = await work(() => claimNextOperation("alice"));
			if (format === "ambiguous") expect(reclaimed).toBeNull();
			else {
				if (!reclaimed) throw new Error("Missing reclaimed lease");
				await work(() => executeLease(reclaimed));
			}
			expect(fetch).not.toHaveBeenCalled();
			expect(await work(() => operationService.get("alice", operation.id))).toMatchObject(
				format === "ambiguous"
					? { state: "failed", resultId: null, failureCode: "AI_OUTCOME_UNKNOWN" }
					: { state: "waiting_review", resultId: operation.id },
			);
		},
	);
	it.each(["unissued", "finished", "pending", "booked", "closed-failed"] as const)(
		"reclaims a bound pass with a %s call",
		async (state) => {
			const handler = syntheticRuntime.handlers.review;
			const transport = syntheticRuntime.fetch;
			if (!handler || !transport) throw new Error("Missing synthetic handler");
			const pending = state === "pending" || state === "booked";
			const output = { text: "Recovered candidate" };
			const batchIds = state === "closed-failed" ? ["one", "two", "three"] : ["one", "two"];
			const batches = batchIds.map((id) => ({
				itemIds: [id],
				output,
				payload: { selections: [{ id, kind: "confirmed_content" as const, section: "summary" as const, text: id }] },
			}));
			const first = Promise.withResolvers<void>();
			const reply = Promise.withResolvers<void>();
			const calls: string[] = [];
			const runtime: import("./route-policy").AiRuntime = {
				...syntheticRuntime,
				localOwnerAllowance: { ownerId: "alice", limit: 100 },
				routes: [
					{
						...syntheticRoute,
						maxCalls: 2,
						maxCallCostMicros: 1000,
						verifier: { evidenceVersion: "synthetic-verifier-v2", maxCallCostMicros: 7000 },
					},
				],
				handlers: {
					review: {
						...handler,
						verifier: {
							output: handler.output,
							systemPrompt: "Verify recovered batch.",
							buildInput: (payload) => payload,
							buildBatchesInContext: async () => ({ batches }),
							validate: () => undefined,
							...(state === "booked"
								? {}
								: {
										validateBatchesInContext: async (_tx, _owner, _request, value, verdicts) => {
											expect(verdicts).toHaveLength(batchIds.length);
											return { output: value, batchCount: verdicts.length };
										},
									}),
						},
					},
				},
				fetch: async (...args) => {
					const request = JSON.parse(String(args[1]?.body));
					const id: string = JSON.parse(request.messages.at(-1).content).selections[0].id;
					calls.push(id);
					if (pending && id === "one") {
						first.resolve();
						await reply.promise;
					}
					return transport(...args);
				},
			};
			const work = <T>(fn: () => T) => database.run(() => withAiRuntime(runtime, fn));
			const operation = await work(() => operationService.start("alice", request("alice", `recover-pass-${state}`)));
			const legacyLease = await work(() => claimNextOperation("alice"));
			if (!legacyLease) throw new Error("Missing initial lease");
			const passId = `recover-verify-${state}`;
			const binding = bindVerificationPass(1, output, batches);
			const [firstBatchKey, secondBatchKey] = binding.batchKeys;
			if (!firstBatchKey || !secondBatchKey) throw new Error("Missing batch key");
			const settledCall = {
				...makeVerificationCall(firstBatchKey, 0, 7000),
				outcome: "valid" as const,
				output,
				costMicros: 10,
			};
			const closedFailed = state === "closed-failed";
			const passCalls = closedFailed
				? [
						settledCall,
						{ ...makeVerificationCall(secondBatchKey, 0, 7000), outcome: "transient" as const, costMicros: 0 },
						{ ...makeVerificationCall(secondBatchKey, 1, 7000), outcome: "transient" as const, costMicros: 0 },
					]
				: state === "finished"
					? [settledCall]
					: [];
			await database
				.admin()
				.query(
					"INSERT INTO ai_operation_attempt(id,user_id,operation_id,ordinal,step_id,lease_token,outcome,cost_micros,finished_at,output) VALUES ($1,'alice',$2,1,'generate',$3,'valid',10,now(),$4)",
					[`recover-writer-${state}`, operation.id, legacyLease.token, output],
				);
			await database
				.admin()
				.query(
					"INSERT INTO ai_operation_attempt(id,user_id,operation_id,ordinal,step_id,lease_token,outcome,output,cost_micros,finished_at) VALUES ($1,'alice',$2,2,'verify',$3,$4,$5,$6,$7)",
					[
						passId,
						operation.id,
						legacyLease.token,
						closedFailed ? "transient" : "unknown",
						createVerificationJournal(binding, passCalls),
						closedFailed ? 10 : null,
						closedFailed ? new Date() : null,
					],
				);
			const oldWork = pending ? work(() => executeLease(legacyLease)) : undefined;
			const budget = async () =>
				(
					await database
						.admin()
						.query("SELECT spent_micros::int,reserved_micros::int,active FROM ai_platform_budget WHERE id='synthetic'")
				).rows[0];
			const beforeReply = await budget();
			try {
				if (oldWork)
					await Promise.race([
						first.promise,
						oldWork.then(() => {
							throw new Error("Missing dispatch");
						}),
					]);
				await database
					.admin()
					.query("UPDATE ai_operation SET lease_until=now()-interval '1 minute' WHERE id=$1", [operation.id]);
				const lease = await work(() => claimNextOperation("alice"));
				if (!lease) throw new Error("Missing reclaimed lease");
				expect(lease.token).not.toBe(legacyLease.token);
				const legacy = runtime.handlers.review;
				if (!legacy) throw new Error("Missing legacy handler");
				const selectedRuntime = {
					...runtime,
					handlers: {
						review: {
							...legacy,
							promptVersion: "new-approval",
							buildInput: () => Promise.reject(new Error("Wrong handler")),
						},
					},
					historicalHandlers: { review: [legacy] },
				};
				await database.run(() => withAiRuntime(selectedRuntime, () => executeLease(lease)));
				if (state === "booked") {
					// Simulate expiry of the accounting hold while the verifier transport is still pending.
					await database.admin().query(
						`WITH booked AS (
							UPDATE ai_operation SET unknown_booked_micros=7010,reserved_micros=0 WHERE id=$1 RETURNING budget_id
						) UPDATE ai_platform_budget SET spent_micros=spent_micros+7010,reserved_micros=reserved_micros-10000
						  WHERE id=(SELECT budget_id FROM booked)`,
						[operation.id],
					);
				}
			} finally {
				reply.resolve();
				await oldWork;
			}
			if (closedFailed) {
				expect(calls).toEqual([]);
				expect(await work(() => operationService.get("alice", operation.id))).toMatchObject({
					state: "failed",
					failureCode: "AI_VERIFIER_UNAVAILABLE",
					resultId: null,
				});
				return;
			}
			expect(calls).toEqual(pending ? ["one"] : state === "finished" ? ["two"] : ["one", "two"]);
			expect(await work(() => operationService.get("alice", operation.id))).toMatchObject(
				pending
					? { state: "failed", failureCode: "AI_OUTCOME_UNKNOWN", resultId: null }
					: { state: "waiting_review", resultId: operation.id },
			);
			const rows = (
				await database
					.admin()
					.query(
						"SELECT id,ordinal,lease_token,outcome,cost_micros::int,finished_at,output FROM ai_operation_attempt WHERE operation_id=$1 AND step_id='verify'",
						[operation.id],
					)
			).rows;
			expect(rows).toEqual([
				expect.objectContaining({
					id: passId,
					ordinal: 2,
					lease_token: legacyLease.token,
					finished_at: expect.any(Date),
					outcome: pending ? "unknown" : "valid",
					cost_micros: pending ? 10 : 20,
				}),
			]);
			if (pending) {
				expect(rows[0].output._verifyCalls).toEqual([
					expect.objectContaining({ outcome: "pending", output: null, costMicros: 10 }),
				]);
				await work(() => reconcileExpiredAccounting("alice"));
				expect(await budget()).toEqual({
					spent_micros: beforeReply.spent_micros + 20,
					reserved_micros: beforeReply.reserved_micros - 10_000,
					active: beforeReply.active - 1,
				});
			}
			expect(
				(
					await database
						.admin()
						.query("SELECT budget_closed,actual_micros::int FROM ai_operation WHERE id=$1", [operation.id])
				).rows,
			).toEqual([{ budget_closed: true, actual_micros: pending ? 20 : 30 }]);
			expect(
				(
					await database
						.admin()
						.query("SELECT kind FROM ai_usage_ledger WHERE operation_id=$1 ORDER BY created_at", [operation.id])
				).rows,
			).toEqual([{ kind: "reserve" }, { kind: pending ? "release" : "settle" }]);
		},
	);
	it("retries only the single incomplete batch on a 5-batch verification wave within ordinal 1..7", async () => {
		const review = syntheticRuntime.handlers.review;
		if (!review) throw new Error("Missing synthetic handler");
		let batch3Validations = 0;
		const runtime: import("./route-policy").AiRuntime = {
			...syntheticRuntime,
			localOwnerAllowance: { ownerId: "alice", limit: 100 },
			routes: [
				{
					...syntheticRoute,
					maxCalls: 2,
					maxCallCostMicros: 1000,
					requestCapMicros: 10000,
					verifier: { evidenceVersion: "synthetic-verifier-v2", maxCallCostMicros: 1000 },
				},
			],
			handlers: {
				review: {
					...review,
					verifier: {
						output: review.output,
						systemPrompt: "Verify 5-batch job evidence.",
						buildInput: (payload: Parameters<NonNullable<typeof review.verifier>["buildInput"]>[0]) => payload,
						validate: () => undefined,
						buildBatchesInContext: async (_tx, _ownerId, _req, output) => ({
							batches: Array.from({ length: 5 }, (_, idx) => ({
								output,
								payload: {
									selections: [{ id: `b${idx}`, kind: "confirmed_content", section: "summary", text: `batch ${idx}` }],
								},
								itemIds: [`req-${idx}`],
							})),
						}),
						validateBatchInContext: async (_tx, _ownerId, _req, _output, batchIndex) => {
							if (batchIndex === 3) {
								batch3Validations++;
								if (batch3Validations === 1) {
									throw new VerificationGateError("AI_VERIFICATION_PREMISE_IDS", "AI_VERIFICATION_INCOMPLETE");
								}
							}
						},
						validateBatchesInContext: async (_tx, _ownerId, _req, output) => ({ output, batchCount: 5 }),
					},
				},
			},
		};
		const operation = await database.run(() =>
			withAiRuntime(runtime, () => operationService.start("alice", request("alice", "five-batch-single-retry"))),
		);
		await database.run(() => withAiRuntime(runtime, () => runAiOperations()));
		expect(await run(() => operationService.get("alice", operation.id))).toMatchObject({
			state: "waiting_review",
			failureCode: null,
		});
		const attempts = await database
			.admin()
			.query("SELECT ordinal,step_id,outcome,output FROM ai_operation_attempt WHERE operation_id=$1 ORDER BY ordinal", [
				operation.id,
			]);
		expect(attempts.rows.map(({ output: _output, ...attempt }) => attempt)).toEqual([
			{ ordinal: 1, step_id: "generate", outcome: "valid" },
			{ ordinal: 2, step_id: "verify", outcome: "valid" },
		]);
		expect(
			attempts.rows[1].output._verifyCalls.map((call: { batchKey: string; outcome: string }) => [
				attempts.rows[1].output._verifyBinding.batchKeys.indexOf(call.batchKey),
				call.outcome,
			]),
		).toEqual([
			[0, "valid"],
			[1, "valid"],
			[2, "valid"],
			[3, "transient"],
			[4, "valid"],
			[3, "valid"],
		]);
	});
	it.each(["per-batch", "regenerate", "budget", "missing-without-cost", "timeout", "terminal-wave"] as const)(
		"handles verifier retry through the worker (%s)",
		async (mode) => {
			const review = syntheticRuntime.handlers.review;
			const transport = syntheticRuntime.fetch;
			if (!review || !transport) throw new Error("Missing synthetic review");
			const verifyCalls = new Map<string, number>();
			const writerCalls: string[] = [];
			const routeId = `truncation-${mode}`;
			const pendingSibling = Promise.withResolvers<AbortSignal>();
			const releaseSibling = Promise.withResolvers<void>();
			const siblingWasAborted = vi.fn();
			const admin = database.admin();
			await admin.query(
				"INSERT INTO ai_platform_budget(id,route_id,route_revision,window_date,cap_micros,request_cap_micros,concurrency) VALUES ($1,$1,'1',(now() AT TIME ZONE 'UTC')::date,100000,10000,1)",
				[routeId],
			);
			await admin.query(
				"INSERT INTO ai_processing_consent(id,user_id,route_id,route_revision,notice_version,purpose,config_revision) VALUES ($1,'alice',$1,'1','1','review','1')",
				[routeId],
			);
			const runtime: import("./route-policy").AiRuntime = {
				...syntheticRuntime,
				localOwnerAllowance: { ownerId: "alice", limit: 100 },
				routes: [
					{
						...syntheticRoute,
						routeId,
						maxCalls: 2,
						...(mode === "timeout" ? { callTimeoutMs: 150 } : {}),
						maxCallCostMicros: 1000,
						requestCapMicros: 10_000,
						verifier: {
							evidenceVersion: "synthetic-verifier-v2",
							maxCallCostMicros: mode === "budget" ? 7000 : 1000,
						},
					},
				],
				handlers: {
					review: {
						...review,
						verifier: {
							output: review.output,
							systemPrompt: "Verify truncated batches.",
							buildInput: (payload) => payload,
							validate: () => undefined,
							...(mode === "regenerate" || mode === "timeout" ? { withholdTruncatedBatch: true as const } : {}),
							buildBatchesInContext: async (_tx, _ownerId, _req, output) => ({
								batches: Array.from({ length: 2 }, (_, index) => ({
									output,
									payload: {
										selections: [
											{ id: `b${index}`, kind: "confirmed_content", section: "summary", text: `Batch ${index}` },
										],
									},
									itemIds: [`item-${index}`],
								})),
							}),
							validateBatchesInContext: async (_tx, _ownerId, _req, output, verdicts) => {
								for (const verdict of verdicts) expect(review.output.parse(verdict)).toEqual(output);
								return { output, batchCount: verdicts.length };
							},
						},
					},
				},
				fetch: async (...args) => {
					const wire = JSON.parse(String(args[1]?.body));
					const response = await transport(...args);
					if (wire.messages[0].content !== "Verify truncated batches.") {
						writerCalls.push(wire.messages[1].content);
						return response;
					}
					const batch = wire.messages[1].content;
					const count = (verifyCalls.get(batch) ?? 0) + 1;
					verifyCalls.set(batch, count);
					const signal = args[1]?.signal;
					if (!signal) throw new Error("Missing dispatch signal");
					if (mode === "timeout" && batch.includes("Batch 1")) {
						await new Promise<void>((_, reject) =>
							signal.addEventListener("abort", () => reject(signal.reason), { once: true }),
						);
					}
					if (mode === "terminal-wave") {
						if (batch.includes("Batch 1")) {
							pendingSibling.resolve(signal);
							await releaseSibling.promise;
							if (signal.aborted) siblingWasAborted();
							return response;
						}
						await pendingSibling.promise;
						return Response.json({ error: { code: 403 } }, { status: 403 });
					}
					if (mode === "regenerate" ? writerCalls.length > 1 : count > 1) return response;
					const body = await response.json();
					if (mode === "missing-without-cost") body.choices[0].message.content = "{}";
					else {
						body.choices[0].finish_reason = "length";
						body.choices[0].message.content = '{"text":"Incomplete';
					}
					if (mode !== "regenerate") delete body.usage.cost;
					return Response.json(body);
				},
			};
			const work = <T>(callback: () => T) => database.run(() => withAiRuntime(runtime, callback));
			const input = request("alice", routeId);
			const operation = await work(() =>
				operationService.start("alice", { ...input, route: { ...input.route, routeId } }),
			);
			if (mode === "terminal-wave") {
				const worker = work(() => runAiOperations());
				const signal = await pendingSibling.promise;
				try {
					await vi.waitFor(() => expect(signal.aborted).toBe(true));
				} finally {
					releaseSibling.resolve();
					await worker;
				}
				expect(siblingWasAborted).toHaveBeenCalledOnce();
				expect(await work(() => operationService.get("alice", operation.id))).toMatchObject({
					state: "failed",
					failureCode: "AI_PROVIDER_UNAVAILABLE",
				});
				return;
			}
			await work(() => runAiOperations());
			if (mode === "timeout") {
				expect([...verifyCalls.values()]).toEqual([1, 1]);
				expect(await work(() => operationService.get("alice", operation.id))).toMatchObject({
					state: "failed",
					failureCode: "AI_TIMEOUT",
				});
				return;
			}
			if (mode === "budget") {
				expect([...verifyCalls.values()]).toEqual([1]);
				expect(await work(() => operationService.get("alice", operation.id))).toMatchObject({
					state: "failed",
					resultId: null,
				});
				return;
			}
			expect([...verifyCalls.values()]).toEqual(mode === "regenerate" ? [3, 3] : [2, 2]);
			expect(writerCalls).toHaveLength(mode === "regenerate" ? 2 : 1);
			expect(await work(() => operationService.get("alice", operation.id))).toMatchObject({
				state: "waiting_review",
				resultId: operation.id,
			});
			const passes = await database
				.admin()
				.query("SELECT step_id, output FROM ai_operation_attempt WHERE operation_id=$1 ORDER BY ordinal", [
					operation.id,
				]);
			expect(passes.rows.map(({ step_id }) => step_id)).toEqual(
				mode === "regenerate" ? ["generate", "verify", "regenerate", "verify"] : ["generate", "verify"],
			);
			expect(readVerificationJournal(passes.rows[1]?.output)?.calls.map(({ dispatchIndex }) => dispatchIndex)).toEqual([
				0, 0, 1, 1,
			]);
		},
	);

	it("starts the execution deadline on claim and keeps it when recovering the lease", async () => {
		const runtime = { ...syntheticRuntime, localOwnerAllowance: { ownerId: "alice", limit: 100 } };
		const work = <T>(callback: () => T) => database.run(() => withAiRuntime(runtime, callback));
		const operation = await work(() => operationService.start("alice", request("alice", "claim-clock")));
		const admin = database.admin();
		await admin.query("ALTER TABLE ai_operation DISABLE TRIGGER USER");
		try {
			await admin.query(
				"UPDATE ai_operation SET created_at=now()-interval '150 seconds',deadline_at=now()-interval '30 seconds' WHERE id=$1",
				[operation.id],
			);
		} finally {
			await admin.query("ALTER TABLE ai_operation ENABLE TRIGGER USER");
		}
		const lease = await run(() => claimNextOperation("alice"));
		expect(lease?.operationId).toBe(operation.id);
		const timing = async () =>
			(await admin.query("SELECT deadline_at, execution_started_at FROM ai_operation WHERE id=$1", [operation.id]))
				.rows[0];
		const claimed = await timing();
		expect(claimed.deadline_at.getTime() - claimed.execution_started_at.getTime()).toBe(syntheticRoute.deadlineMs);
		await admin.query("UPDATE ai_operation SET lease_until=now()-interval '1 second' WHERE id=$1", [operation.id]);
		const recovered = await run(() => claimNextOperation("alice"));
		expect(recovered?.operationId).toBe(operation.id);
		expect(recovered?.token).not.toBe(lease?.token);
		expect(await timing()).toEqual(claimed);
		if (!recovered) throw new Error("Missing recovered lease");
		await run(() => failOperation(recovered, "AI_CANCELLED"));
	});
});
