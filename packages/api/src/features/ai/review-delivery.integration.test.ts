import { beforeAll, describe, expect, it } from "vite-plus/test";
import { splitReviewClaims, withheldReviewItemsSchema } from "@reactive-resume/schema/resume/ai-review";
import { defaultResumeData } from "@reactive-resume/schema/resume/default";
import { getProcessingNotices, processingConsentService } from "./consent";
import { executeLease, runAiOperations } from "./operation-worker";
import { claimNextOperation, mergeWithheldItems, operationService } from "./operations";
import { extractionCandidateHandler, reviewHandlers } from "./review-handlers";
import { createImportReviewSource, prepareResumeReview } from "./review-sources";
import { withAiRuntime } from "./route-policy";
import { aiTestDatabase } from "./testing/database";
import { syntheticReviewRuntime as syntheticRuntime } from "./testing/runtime";

it("merges withholding by ID before applying the public list limit", () => {
	const items = Array.from({ length: 56 }, (_, i) => ({ id: `field-${i}`, reason: "AI_SOURCE_BINDING" }));
	const repeated = { count: 1, rules: ["AI_UNSUPPORTED_CLAIM"], items: [{ id: "field-0" }] };
	const legacy = { count: 3, rules: ["AI_VERIFICATION_CLAIM_SUPPORT"] };
	expect(mergeWithheldItems(repeated, repeated)).toEqual(repeated);
	const merged = mergeWithheldItems(
		{ count: items.length, rules: ["AI_SOURCE_BINDING"], items },
		repeated,
		legacy,
		legacy,
	);
	expect(merged).toEqual({
		count: 59,
		rules: ["AI_SOURCE_BINDING", "AI_UNSUPPORTED_CLAIM", "AI_VERIFICATION_CLAIM_SUPPORT"],
		items: items.slice(0, 50),
	});
});

it("reports a rejected question using its full valid claim ID", () => {
	const report = {
		count: 1,
		rules: ["AI_VERIFICATION_CLAIM_SUPPORT"],
		items: [{ id: `question:${"q".repeat(200)}` }],
	};
	expect(withheldReviewItemsSchema.parse(mergeWithheldItems(report))).toEqual(report);
});

describe.skipIf(!process.env.COVER_LETTER_TEST_DATABASE_URL)("review delivery", () => {
	const database = aiTestDatabase();
	let captured: unknown;
	let text = "Developed services.";
	let empty = false;
	let verifierMode = "supported";
	let verifierCalls = 0;
	let verifierRequest: Record<string, unknown> | null = null;
	const runtime = {
		...syntheticRuntime,
		handlers: reviewHandlers,
		fetch: async (_url: unknown, init?: RequestInit) => {
			const body = JSON.parse(String(init?.body));
			if (!String(body.messages[0].content).includes("t006-verifier")) captured = body;
			const content = JSON.parse(body.messages.at(-1).content);
			const verification = content.selections.find((s: { id: string }) => s.id === "verification-claims");
			if (verification) {
				verifierRequest = body;
				verifierCalls++;
				if (verifierMode === "down") return Response.json({ error: "Synthetic unavailable" }, { status: 503 });
				const claims = JSON.parse(verification.text) as { claimId: string; evidenceIds: string[] }[];
				return Response.json({
					id: "verification",
					model: body.model,
					provider: body.provider.only[0],
					choices: [
						{
							index: 0,
							message: {
								role: "assistant",
								content: JSON.stringify({
									schemaVersion: 3,
									responseAssessment: { status: "appropriate", reason: "The response addresses the task." },
									factRetention: {
										status: verifierMode === "lost" ? "lost" : "retained",
										evidenceIds: [...new Set(claims.flatMap((c) => c.evidenceIds))],
										reason: "Synthetic retention judgment",
									},
									verdicts:
										verifierMode === "missing"
											? []
											: claims.map((c) => ({
													claimId: c.claimId,
													verdict: verifierMode === "lost" ? "supported" : verifierMode,
													evidenceIds: c.evidenceIds,
													reason: "Synthetic fidelity verdict",
												})),
								}),
							},
							finish_reason: "stop",
						},
					],
					usage: { prompt_tokens: 6, completion_tokens: 4, total_tokens: 10, cost: 0.00001 },
				});
			}
			const id = content.selections.find((selection: { id: string }) => selection.id !== "intent").id;
			return new Response(
				JSON.stringify({
					id: "synthetic",
					model: body.model,
					provider: body.provider.only[0],
					choices: [
						{
							index: 0,
							message: {
								role: "assistant",
								content: JSON.stringify({
									proposals: empty
										? []
										: [
												{
													id: "p1",
													passageId: id,
													text,
													reason: "Clearer",
													evidenceIds: [id],
													claims: splitReviewClaims(text, [id]),
												},
											],
									questions: [],
									notes: [],
								}),
							},
							finish_reason: "stop",
						},
					],
					usage: { prompt_tokens: 5, completion_tokens: 5, total_tokens: 10, cost: 0.00001 },
				}),
				{ headers: { "content-type": "application/json" } },
			);
		},
	};
	const run = <T>(work: () => T) => database.run(() => withAiRuntime(runtime, work));
	beforeAll(async () => {
		const data = structuredClone(defaultResumeData);
		data.summary.content = "<p>Built services.</p>";
		data.basics.name = "Ada Lovelace";
		data.basics.location = "London";
		await database
			.admin()
			.query("INSERT INTO resume(id,user_id,name,slug,data) VALUES ('cv','alice','Synthetic','cv',$1)", [
				JSON.stringify(data),
			]);
		await database
			.admin()
			.query(
				"INSERT INTO ai_processing_consent(id,user_id,route_id,route_revision,notice_version,purpose,config_revision) VALUES ('consent','alice','synthetic','1','1','review.wording','1')",
			);
		await database
			.admin()
			.query(
				"INSERT INTO ai_platform_budget(id,route_id,route_revision,window_date,cap_micros,request_cap_micros,concurrency) VALUES ('budget','synthetic','1',(now() AT TIME ZONE 'UTC')::date,100000,10000,2)",
			);
	});
	const start = async (key: string, customRequest?: string) => {
		const revision = (
			await database.admin().query("SELECT updated_at FROM resume WHERE id='cv'")
		).rows[0].updated_at.toISOString();
		const prepared = await run(() =>
			prepareResumeReview("alice", {
				resumeId: "cv",
				expectedUpdatedAt: revision,
				targets: [{ sectionId: "summary", field: "content" }],
			}),
		);
		return run(() =>
			operationService.start("alice", {
				requestKey: key,
				kind: "review.wording",
				sources: prepared.sources,
				route: { routeId: "synthetic", routeRevision: "1", configRevision: "1" },
				consentVersion: "1",
				parameters: {
					resumeId: "cv",
					targets: [{ sectionId: "summary", field: "content" }],
					action: customRequest ? "custom" : "review",
					...(customRequest ? { request: customRequest } : {}),
				},
			}),
		);
	};
	it.each(["mixed", "all-invalid", "fabricated-question"] as const)(
		"delivers only verified extraction fields in the %s case",
		async (mode) => {
			const verifierInputs: string[][] = [];
			const shutdown = new AbortController();
			const verifier = extractionCandidateHandler.verifier;
			const buildInput = verifier?.buildInputInContext;
			if (!verifier || !buildInput) throw new Error("Missing extraction verifier");
			let pauseBeforeDispatch = mode === "mixed";
			let writerCalls = 0;
			const extraction = {
				...runtime,
				handlers: {
					...reviewHandlers,
					"review.extraction": {
						...extractionCandidateHandler,
						verifier: {
							...verifier,
							buildInputInContext: async (...args: Parameters<typeof buildInput>) => {
								const payload = await buildInput(...args);
								if (pauseBeforeDispatch) {
									pauseBeforeDispatch = false;
									shutdown.abort();
								}
								return payload;
							},
						},
					},
				},
				fetch: async (_url: unknown, init?: RequestInit) => {
					const body = JSON.parse(String(init?.body));
					const { messages } = body;
					const { selections } = JSON.parse(messages.at(-1).content);
					const evidenceIds = [
						selections.find((selection: { kind: string }) => selection.kind === "unconfirmed_source").id,
					];
					const claims = selections.find((selection: { id: string }) => selection.id === "verification-claims");
					const candidate = {
						id: "field-valid",
						section: "experience",
						entityId: "entry",
						field: "description",
						value: "Built secure services",
						confirmation: "needs_review",
						evidenceIds,
						rawDateText: null,
					};
					const writer = {
						candidates: [
							...(mode === "mixed" ? [candidate] : []),
							{ ...candidate, id: "field-invalid", field: "company", value: "Invented Employer" },
						],
						questions:
							mode === "all-invalid"
								? []
								: [
										{
											id: "source-question",
											passageId: null,
											evidenceIds,
											prompt: mode === "mixed" ? "Which employer can you confirm?" : "How many people did you manage?",
										},
									],
					};
					const verdicts: { claimId: string; evidenceIds: string[] }[] = claims ? JSON.parse(claims.text) : [];
					if (claims) {
						verifierInputs.push(verdicts.map(({ claimId }) => claimId));
						const task = JSON.parse(
							selections.find((selection: { id: string }) => selection.id === "verification-task").text,
						);
						expect(task.retentionApplicable).toBe(mode === "mixed");
					} else writerCalls++;
					const output = claims
						? {
								schemaVersion: 3,
								responseAssessment: { status: "appropriate", reason: "Synthetic response." },
								factRetention:
									mode === "mixed"
										? { status: "retained", evidenceIds, reason: "Field facts retained.", failedClaimIds: [] }
										: { status: "not_applicable", evidenceIds: [], reason: "Only a question.", failedClaimIds: [] },
								verdicts: verdicts.map(({ claimId, evidenceIds }) => ({
									claimId,
									evidenceIds,
									verdict: mode === "mixed" ? "supported" : "unsupported",
									reason: "Synthetic verdict.",
								})),
							}
						: writer;
					return Response.json({
						id: "extraction",
						model: body.model,
						provider: body.provider.only[0],
						choices: [
							{ index: 0, message: { role: "assistant", content: JSON.stringify(output) }, finish_reason: "stop" },
						],
						usage: { prompt_tokens: 5, completion_tokens: 5, total_tokens: 10, cost: 0.00001 },
					});
				},
			};
			const work = <T>(fn: () => T) => database.run(() => withAiRuntime(extraction, fn));
			const route = { routeId: "synthetic", routeRevision: "1", configRevision: "1" };
			await work(async () => {
				const [notice] = await getProcessingNotices("bob", { purpose: "review.extraction", locale: "en-US" });
				if (!notice) throw new Error("Missing synthetic processing notice");
				const { content: _content, alreadyGranted: _alreadyGranted, ...acceptance } = notice;
				await processingConsentService.grant("bob", acceptance);
			});
			const { source } = await work(() =>
				createImportReviewSource("bob", {
					flowId: mode,
					section: "experience",
					text: "Built secure services",
					contactValues: [],
					partial: false,
				}),
			);
			const operation = await work(() =>
				operationService.start("bob", {
					kind: "review.extraction",
					requestKey: mode,
					route,
					consentVersion: "1",
					parameters: { sourceId: source.id },
					sources: [source],
				}),
			);
			if (mode === "mixed") {
				const lease = await work(() => claimNextOperation("bob"));
				if (!lease) throw new Error("Missing initial extraction lease");
				await work(() => executeLease(lease, shutdown.signal));
				const admin = database.admin();
				const listPasses = () =>
					admin.query(
						"SELECT id, lease_token, finished_at, output FROM ai_operation_attempt WHERE operation_id=$1 AND step_id='verify'",
						[operation.id],
					);
				const { rows: before } = await listPasses();
				expect(before).toEqual([
					expect.objectContaining({
						lease_token: lease.token,
						finished_at: null,
						output: expect.objectContaining({ _verifyCalls: [] }),
					}),
				]);
				await admin.query("UPDATE ai_operation SET lease_until=now()-interval '1 minute' WHERE id=$1", [operation.id]);
				const reclaimed = await work(() => claimNextOperation("bob"));
				if (!reclaimed) throw new Error("Missing reclaimed extraction lease");
				await work(() => executeLease(reclaimed));
				expect((await listPasses()).rows).toEqual([
					expect.objectContaining({ id: before[0].id, lease_token: lease.token, finished_at: expect.any(Date) }),
				]);
				expect(writerCalls).toBe(1);
				expect(verifierInputs).toEqual([["field-valid", "question:source-question"]]);
				expect(await work(() => operationService.getResult("bob", operation.id))).toMatchObject({
					kind: "extraction",
					candidates: [{ id: "field-valid" }],
					questions: [{ id: "source-question" }],
					withheld: { count: 1, items: [{ id: "field-invalid" }] },
				});
			} else {
				await work(() => runAiOperations());
				expect(verifierInputs.flat()).toEqual(
					mode === "all-invalid" ? [] : ["question:source-question", "question:source-question"],
				);
				expect(await work(() => operationService.get("bob", operation.id))).toMatchObject({
					state: "failed",
					resultId: null,
				});
			}
		},
	);
	it("publishes a validated pending review once without changing the CV", async () => {
		const operation = await start("valid", "Mention Ada Lovelace in London");
		await run(() => runAiOperations());

		expect(await run(() => operationService.get("alice", operation.id))).toMatchObject({
			state: "waiting_review",
			failureCode: null,
		});
		expect(await run(() => operationService.getResult("alice", operation.id))).toMatchObject({
			kind: "wording",
			proposals: [{ status: "pending", before: "<p>Built services.</p>", after: "<p>Developed services.</p>" }],
		});
		await run(() => runAiOperations());
		expect((await database.admin().query("SELECT data FROM resume WHERE id='cv'")).rows[0].data.summary.content).toBe(
			"<p>Built services.</p>",
		);
		expect(
			(
				await database
					.admin()
					.query("SELECT count(*)::int n FROM ai_usage_ledger WHERE operation_id=$1 AND kind='settle'", [operation.id])
			).rows[0].n,
		).toBe(1);
		expect(
			(
				await database
					.admin()
					.query("SELECT count(*)::int n, sum(cost_micros)::int cost FROM ai_operation_attempt WHERE operation_id=$1", [
						operation.id,
					])
			).rows[0],
		).toEqual({ n: 2, cost: 20 });
		expect(JSON.stringify(captured)).not.toContain("cv");
		expect(JSON.stringify(captured)).not.toContain("Ada Lovelace");
		expect(JSON.stringify(captured)).not.toContain("London");
		expect(verifierRequest).toMatchObject({
			model: "deepseek/deepseek-v4.1-flash-1017",
			reasoning: { effort: "low" },
			provider: { only: ["together"], allow_fallbacks: false, data_collection: "deny", zdr: true },
		});
	});
	it.each(["unsupported", "contradicted", "down", "missing", "lost"])(
		"withholds proposals when verifier returns %s",
		async (mode) => {
			verifierMode = mode;
			const operation = await start(`verify-${mode}`);
			await run(() => runAiOperations());
			expect(await run(() => operationService.get("alice", operation.id))).toMatchObject({
				state: "failed",
				resultId: null,
			});
			const attempts = (
				await database
					.admin()
					.query("SELECT step_id,output FROM ai_operation_attempt WHERE operation_id=$1 ORDER BY ordinal", [
						operation.id,
					])
			).rows;
			expect(attempts.map((a) => a.step_id)).toEqual(
				["unsupported", "contradicted", "lost"].includes(mode)
					? ["generate", "verify", "regenerate", "verify"]
					: ["generate", "verify"],
			);
			if (["down", "missing"].includes(mode))
				expect(attempts[1]?.output._verifyCalls.map((call: { outcome: string }) => call.outcome)).toEqual([
					"transient",
					"transient",
				]);
			expect(
				(
					await database
						.admin()
						.query("SELECT kind FROM ai_usage_ledger WHERE operation_id=$1 ORDER BY created_at", [operation.id])
				).rows.map((r) => r.kind),
			).toEqual(["reserve", "release"]);
			verifierMode = "supported";
		},
	);
	it("fails semantic-invalid output without publishing or settling usage", async () => {
		const previousVerifierCalls = verifierCalls;
		text = "Led delivery with a 30% increase.";
		const operation = await start("invalid");
		await run(() => runAiOperations());
		expect(verifierCalls).toBe(previousVerifierCalls);
		expect(await run(() => operationService.get("alice", operation.id))).toMatchObject({
			state: "failed",
			failureCode: "AI_REVIEW_INVALID",
		});
		expect(
			(
				await database
					.admin()
					.query("SELECT kind FROM ai_usage_ledger WHERE operation_id=$1 ORDER BY created_at", [operation.id])
			).rows.map((row) => row.kind),
		).toEqual(["reserve", "release"]);
	});
	it("settles three identical-input synthetic runs once each and preserves source mapping", async () => {
		text = "Developed services.";
		const results = [];
		for (let index = 0; index < 3; index++) {
			const operation = await start(`repeat-${index}`);
			await run(() => runAiOperations());
			results.push(await run(() => operationService.getResult("alice", operation.id)));
			expect(
				(
					await database
						.admin()
						.query("SELECT count(*)::int n FROM ai_usage_ledger WHERE operation_id=$1 AND kind='settle'", [
							operation.id,
						])
				).rows[0].n,
			).toBe(1);
		}
		expect(results[1]).toEqual(results[0]);
		expect(results[2]).toEqual(results[0]);
	});
	it("delivers an explicit empty successful review and settles it once", async () => {
		empty = true;
		const operation = await start("empty");
		await run(() => runAiOperations());
		expect(await run(() => operationService.get("alice", operation.id))).toMatchObject({ state: "succeeded" });
		expect(await run(() => operationService.getResult("alice", operation.id))).toMatchObject({
			proposals: [],
			questions: [],
		});
		expect(
			(
				await database
					.admin()
					.query("SELECT count(*)::int n FROM ai_usage_ledger WHERE operation_id=$1 AND kind='settle'", [operation.id])
			).rows[0].n,
		).toBe(1);
	});
});
