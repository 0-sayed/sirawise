import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { expect, it } from "vite-plus/test";
import { withOwnerDatabase } from "@reactive-resume/db/client";
import { buildJobPassages } from "@reactive-resume/resume/ats";
import { defaultResumeData } from "@reactive-resume/schema/resume/default";
import { resumeService } from "../resume/service";
import { runAiOperations } from "./operation-worker";
import { operationService } from "./operations";
import { prepareReviewContinuation } from "./review-continuation";
import { listResumeReviews, recordReviewAnswer, dismissReviewQuestion } from "./review-decisions";
import { withAiRuntime } from "./route-policy";
import { aiTestDatabase } from "./testing/database";
import { syntheticReviewRuntime } from "./testing/runtime";
import { decideVariantReview, getVariantReview } from "./variant-decisions";
import { variantReviewHandlers } from "./variant-handlers";
import { loadVariantSnapshot, prepareVariantReview } from "./variant-sources";
import { validateVariantOutput } from "./variant-validation";

const database = aiTestDatabase();
const run = <T>(work: () => T) => database.run(work);

it("returns a source-lock reason from preflight without starting an operation", async () => {
	const data = structuredClone(defaultResumeData);
	data.summary.content = "<p>Used React.</p>";
	data.summary.hidden = false;
	data.metadata.layout.pages = [{ fullWidth: false, main: ["summary"], sidebar: [] }];
	const fact = buildJobPassages(data)[0];
	assert(fact);
	const id = await run(() =>
		resumeService.create({
			userId: "bob",
			name: "Locked CV",
			tags: [],
			data,
			locale: "en-US",
		}),
	);
	const revision = (
		await database.admin().query("SELECT updated_at FROM resume WHERE id=$1", [id])
	).rows[0].updated_at.toISOString();
	const prepared = await run(() =>
		prepareVariantReview("bob", {
			kind: "review.summary",
			resumeId: id,
			expectedUpdatedAt: revision,
			selectedEvidenceIds: [fact.id],
		}),
	);
	await database.admin().query("UPDATE resume SET is_locked=true WHERE id=$1", [id]);
	await database
		.admin()
		.query(
			"INSERT INTO ai_processing_consent(id,user_id,route_id,route_revision,notice_version,purpose,config_revision) VALUES ('summary-consent','bob','synthetic','1','1','review.summary','1')",
		);
	const result = await run(() =>
		withAiRuntime(syntheticReviewRuntime, () =>
			operationService.preflight("bob", {
				kind: prepared.kind,
				sources: prepared.sources,
				parameters: prepared.parameters,
				requestKey: randomUUID(),
				route: { routeId: "synthetic", routeRevision: "1", configRevision: "1" },
				consentVersion: "1",
			}),
		),
	);
	expect(result).toMatchObject({ available: false, reason: "AI_SOURCE_LOCKED" });
	expect((await database.admin().query("SELECT count(*)::int n FROM ai_operation")).rows[0].n).toBe(0);
});
it("applies a selected-fact summary, records ordinary history, replays, and rejects an undo over manual work", async () => {
	const data = structuredClone(defaultResumeData);
	data.basics.name = "Alice $&";
	data.summary.content = "<p>Alice $&amp; used React. Did not manage a budget.</p>";
	data.summary.hidden = false;
	data.basics.headline = "Unselected headline";
	data.metadata.layout.pages = [{ fullWidth: false, main: ["summary"], sidebar: [] }];
	const id = await run(() => resumeService.create({ userId: "alice", name: "CV", tags: [], data, locale: "en-US" }));
	const revision = (
		await database.admin().query("SELECT updated_at FROM resume WHERE id=$1", [id])
	).rows[0].updated_at.toISOString();
	await expect(
		run(() =>
			prepareVariantReview("alice", {
				kind: "review.summary",
				resumeId: id,
				expectedUpdatedAt: revision,
				selectedEvidenceIds: [],
			}),
		),
	).rejects.toThrow();
	// The selector receives stable visible source IDs, never inference from the job advert.
	const passage = buildJobPassages(data).find((passage) => passage.target.sectionId === "summary");
	assert(passage);
	const selected = passage.id;
	const prepared = await run(() =>
		prepareVariantReview("alice", {
			kind: "review.summary",
			resumeId: id,
			expectedUpdatedAt: revision,
			selectedEvidenceIds: [selected],
		}),
	);
	const snapshot = await run(() => withOwnerDatabase("alice", (tx) => loadVariantSnapshot(tx, "alice", prepared)));
	expect(snapshot.cv.map((fact) => fact.text)).toEqual(["[NAME_1] used React. Did not manage a budget."]);
	const raw = {
		summary: {
			text: "[NAME_1] used React.",
			claims: [{ id: "claim", text: "[NAME_1] used React.", evidenceIds: [selected], kind: "fact" }],
		},
		questions: [
			{ id: "clarify", prompt: "What other work can you confirm?", evidenceIds: [] },
			{ id: "skip", prompt: "Would you like to add study evidence?", evidenceIds: [] },
		],
		notes: [],
	};
	const result = validateVariantOutput(snapshot, raw);
	const originalText = "[NAME_1] used React. Did not manage a budget.";
	const validateResult = variantReviewHandlers["review.summary"].validateResult;
	assert(validateResult);
	const validatedNoOp = await run(() =>
		withOwnerDatabase("alice", (tx) =>
			validateResult(
				tx,
				"alice",
				{
					...prepared,
					requestKey: randomUUID(),
					consentVersion: "1",
					route: { routeId: "synthetic", routeRevision: "1", configRevision: "1" },
				},
				{
					...raw,
					summary: {
						text: originalText,
						claims: [
							...raw.summary.claims,
							{ id: "budget", text: "Did not manage a budget.", evidenceIds: [selected], kind: "fact" },
						],
					},
				},
			),
		),
	);
	expect(validatedNoOp).toMatchObject({ output: { summary: { text: "", claims: [] }, questions: raw.questions } });
	const operationId = randomUUID();
	await database
		.admin()
		.query(
			"INSERT INTO ai_operation(id,user_id,request_key,fingerprint,kind,sources,parameters,route,consent_version,prompt_version,schema_version,state,result,delivered_at) VALUES ($1,'alice',$1,'fixture','review.summary',$2,$3,'{}','1','summary-v2','summary-v2','waiting_review',$4,now())",
			[operationId, JSON.stringify(prepared.sources), JSON.stringify(prepared.parameters), JSON.stringify(result)],
		);
	const answerInput = {
		operationId,
		requestKey: randomUUID(),
		questionId: "clarify",
		text: "Prepared reports.",
		expectedSource: result.sourceRevision,
	};
	const answer = await run(() => recordReviewAnswer("alice", answerInput));
	expect(await run(() => recordReviewAnswer("alice", answerInput))).toEqual(answer);
	await run(() => dismissReviewQuestion("alice", { operationId, questionId: "skip", requestKey: randomUUID() }));
	const answered = await run(() => getVariantReview("alice", operationId));
	expect(answered.result).toMatchObject({
		output: { summary: { text: "Alice $& used React.", claims: [{ text: "Alice $& used React." }] } },
	});
	expect(answered.answeredQuestionIds).toContain("clarify");
	expect(answered.dismissedQuestionIds).toContain("skip");
	expect(
		(await database.admin().query("SELECT state FROM ai_operation WHERE id=$1", [operationId])).rows[0].state,
	).toBe("waiting_review");
	expect(await run(() => listResumeReviews("alice", id))).toMatchObject([
		{
			kind: "review.summary",
			pendingCount: 1,
			answeredCount: 1,
			unansweredQuestionCount: 0,
		},
	]);
	const continuation = await run(() => prepareReviewContinuation("alice", operationId, answer.id));
	expect(continuation.parameters.answerIds).toEqual([answer.id]);
	const followUp = await run(() =>
		withOwnerDatabase("alice", (tx) => loadVariantSnapshot(tx, "alice", { ...continuation, kind: "review.summary" })),
	);
	expect(followUp.cv).toContainEqual(
		expect.objectContaining({
			id: answer.id,
			text: "Prepared reports.",
			confirmation: "user_supplied",
		}),
	);

	const input = {
		operationId,
		requestKey: randomUUID(),
		expectedUpdatedAt: revision,
		expectedDecisionId: answered.latestDecisionId,
		subjectIds: ["summary"],
		decision: "accept" as const,
	};
	const saved = await run(() => decideVariantReview("alice", input));
	expect(saved.data.summary.content).toBe("<p>Alice $&amp; used React.</p>");
	expect(saved.data.basics.headline).toBe("Unselected headline");
	expect(await run(() => decideVariantReview("alice", input))).toEqual(saved);
	expect(
		(await database.admin().query("SELECT count(*)::int n FROM resume_version WHERE resume_id=$1 AND kind='ai'", [id]))
			.rows[0].n,
	).toBe(1);
	const view = await run(() => getVariantReview("alice", operationId));
	expect(view.segments.summary).toMatchObject({ text: "Alice $& used React.", status: "accepted" });
	const edited = structuredClone(saved.data);
	edited.summary.content = "<p>Manual work.</p>";
	await database
		.admin()
		.query("UPDATE resume SET data=$2,updated_at=updated_at+interval '1 second' WHERE id=$1", [
			id,
			JSON.stringify(edited),
		]);
	const newRevision = (
		await database.admin().query("SELECT updated_at FROM resume WHERE id=$1", [id])
	).rows[0].updated_at.toISOString();
	await expect(
		run(() =>
			decideVariantReview("alice", {
				...input,
				requestKey: randomUUID(),
				decision: "undo",
				undoDecisionId: saved.decisionId,
				expectedUpdatedAt: newRevision,
				expectedDecisionId: view.latestDecisionId,
			}),
		),
	).rejects.toMatchObject({ code: "CONFLICT" });
	expect((await database.admin().query("SELECT data FROM resume WHERE id=$1", [id])).rows[0].data.summary.content).toBe(
		"<p>Manual work.</p>",
	);
	expect(
		(await database.admin().query("SELECT count(*)::int n FROM career_fact WHERE user_id='alice'")).rows[0].n,
	).toBe(0);
});

it.each(["questions", "notes"] as const)(
	"delivers verified %s without an empty summary edit or saving the CV",
	async (mode) => {
		const ownerId = `summary-${mode}`;
		await database
			.admin()
			.query(`INSERT INTO "user"(id,name,email,username,display_username) VALUES ($1,'Synthetic',$2,$1,$1)`, [
				ownerId,
				`${ownerId}@example.test`,
			]);
		const data = structuredClone(defaultResumeData);
		data.summary.content = "<p>Used React.</p>";
		data.summary.hidden = false;
		data.metadata.layout.pages = [{ fullWidth: false, main: ["summary"], sidebar: [] }];
		const fact = buildJobPassages(data)[0];
		assert(fact);
		const id = await run(() => resumeService.create({ userId: ownerId, name: "CV", tags: [], data, locale: "en-US" }));
		const revision = (
			await database.admin().query("SELECT updated_at FROM resume WHERE id=$1", [id])
		).rows[0].updated_at.toISOString();
		const prepared = await run(() =>
			prepareVariantReview(ownerId, {
				kind: "review.summary",
				resumeId: id,
				expectedUpdatedAt: revision,
				selectedEvidenceIds: [fact.id],
			}),
		);
		await database
			.admin()
			.query(
				"INSERT INTO ai_processing_consent(id,user_id,route_id,route_revision,notice_version,purpose,config_revision) VALUES ($1,$2,'synthetic','1','1','review.summary','1') ON CONFLICT DO NOTHING",
				[`summary-${mode}`, ownerId],
			);
		await database
			.admin()
			.query(
				"INSERT INTO ai_platform_budget(id,route_id,route_revision,window_date,cap_micros,request_cap_micros,concurrency) VALUES ('summary-budget','synthetic','1',(now() AT TIME ZONE 'UTC')::date,100000,10000,2) ON CONFLICT DO NOTHING",
			);
		const output = {
			summary: { text: "", claims: [] },
			questions:
				mode === "questions"
					? [{ id: "clarify", prompt: "What work would you like to highlight?", evidenceIds: [] }]
					: [],
			notes: mode === "notes" ? ["No summary change is needed."] : [],
		};
		const calls: Array<{ model: string }> = [];
		const runtime = {
			...syntheticReviewRuntime,
			fetch: async (_url: unknown, init?: RequestInit) => {
				const body = JSON.parse(String(init?.body));
				calls.push(body);
				const payload = JSON.parse(body.messages.at(-1).content);
				const task = payload.selections.find((entry: { id: string }) => entry.id === "variant-verification-task");
				let response: unknown = output;
				if (task) {
					const inventory = JSON.parse(task.text);
					expect(inventory.claims).toEqual([]);
					expect(inventory.premises).toHaveLength(1);
					expect(
						JSON.parse(payload.selections.find((entry: { id: string }) => entry.id === "variant-response").text),
					).toEqual(output);
					response = {
						schemaVersion: 1,
						verdicts: [],
						retention: null,
						absence: [],
						premises: inventory.premises.map((entry: { id: string }) => ({
							id: entry.id,
							verdict: "no_candidate_premise",
							reason: "Open question or procedural explanation with no candidate assertion.",
						})),
						coverage: { status: "complete", reason: "Checked the entire response including question and notes." },
						quality: { status: "no_change_needed", reason: "No summary replacement is needed." },
					};
				}
				return Response.json({
					id: "synthetic-response",
					model: body.model,
					provider: body.provider.only[0],
					choices: [
						{ index: 0, message: { role: "assistant", content: JSON.stringify(response) }, finish_reason: "stop" },
					],
					usage: { prompt_tokens: 4, completion_tokens: 3, total_tokens: 7, cost: 0.00001 },
				});
			},
		};
		const operation = await run(() =>
			withAiRuntime(runtime, () =>
				operationService.start(ownerId, {
					kind: prepared.kind,
					sources: prepared.sources,
					parameters: prepared.parameters,
					requestKey: randomUUID(),
					route: { routeId: "synthetic", routeRevision: "1", configRevision: "1" },
					consentVersion: "1",
				}),
			),
		);
		await run(() => withAiRuntime(runtime, () => runAiOperations()));
		expect(await run(() => operationService.get(ownerId, operation.id))).toMatchObject({
			state: "waiting_review",
			failureCode: null,
		});
		const review = await run(() => getVariantReview(ownerId, operation.id));
		expect(review.result).toMatchObject({ kind: "review.summary", output });
		expect(review.statuses).toEqual({});
		await expect(
			run(() =>
				decideVariantReview(ownerId, {
					operationId: operation.id,
					requestKey: randomUUID(),
					expectedUpdatedAt: revision,
					expectedDecisionId: review.latestDecisionId,
					subjectIds: ["summary"],
					decision: "accept",
				}),
			),
		).rejects.toMatchObject({ code: "NOT_FOUND" });
		expect(calls).toHaveLength(2);
		expect(calls[1]?.model).toBe("deepseek/deepseek-v4.1-flash-1017");
		if (mode === "questions") {
			const answer = await run(() =>
				recordReviewAnswer(ownerId, {
					operationId: operation.id,
					questionId: "clarify",
					requestKey: randomUUID(),
					expectedSource: { kind: "resume", id, revision },
					text: "Built a reporting project.",
				}),
			);
			const next = await run(() => prepareReviewContinuation(ownerId, operation.id, answer.id));
			const follow = {
				...next,
				kind: prepared.kind,
				requestKey: randomUUID(),
				route: { routeId: "synthetic", routeRevision: "1", configRevision: "1" },
				consentVersion: "1",
			};
			await expect(run(() => prepareReviewContinuation("alice", operation.id, answer.id))).rejects.toMatchObject({
				code: "NOT_FOUND",
			});
			await expect(
				run(() =>
					withAiRuntime(runtime, () =>
						operationService.start(ownerId, {
							...follow,
							parameters: { ...follow.parameters, selectedEvidenceIds: ["another-fact"] },
						}),
					),
				),
			).rejects.toMatchObject({ code: "BAD_REQUEST" });
			expect(await run(() => withAiRuntime(runtime, () => operationService.preflight(ownerId, follow)))).toMatchObject({
				available: true,
				operationCost: 0,
			});
			const child = await run(() => withAiRuntime(runtime, () => operationService.start(ownerId, follow)));
			await run(() => withAiRuntime(runtime, () => runAiOperations()));
			expect(await run(() => operationService.get(ownerId, child.id))).toMatchObject({ state: "waiting_review" });
			expect(JSON.stringify(calls[2])).toContain("Built a reporting project.");
			expect(JSON.stringify(calls[2])).toContain("user_supplied");
			const ledger = await database
				.admin()
				.query("SELECT operation_id, units FROM ai_usage_ledger WHERE user_id=$1 AND kind='settle'", [ownerId]);
			expect(ledger.rows).toEqual([{ operation_id: operation.id, units: 1 }]);
			const childCost = await database.admin().query("SELECT actual_micros FROM ai_operation WHERE id=$1", [child.id]);
			expect(Number(childCost.rows[0].actual_micros)).toBeGreaterThan(0);
			await expect(
				run(() =>
					withAiRuntime(runtime, () =>
						operationService.start(ownerId, {
							...follow,
							requestKey: randomUUID(),
						}),
					),
				),
			).rejects.toMatchObject({ code: "CONFLICT", data: { reason: "AI_REVIEW_ALREADY_CONTINUED" } });
		}
		expect(
			(await database.admin().query("SELECT data,updated_at FROM resume WHERE id=$1", [id])).rows[0],
		).toMatchObject({
			data: { summary: { content: data.summary.content } },
			updated_at: new Date(revision),
		});
	},
);
