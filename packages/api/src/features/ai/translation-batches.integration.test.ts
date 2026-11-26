import type { OperationRequest } from "@reactive-resume/schema/ai-operation";
import { randomUUID } from "node:crypto";
import { beforeAll, beforeEach, expect, it, vi } from "vite-plus/test";
import { withOwnerDatabase } from "@reactive-resume/db/client";
import { defaultResumeData } from "@reactive-resume/schema/resume/default";
import { resumeService } from "../resume/service";
import { createVariant, listVariants } from "../resume/variants";
import { executeLease, runAiOperations } from "./operation-worker";
import { claimNextOperation, discoverAiOwners, operationService, reconcileExpiredAccounting } from "./operations";
import { withAiRuntime } from "./route-policy";
import { aiTestDatabase } from "./testing/database";
import { syntheticReviewRuntime, syntheticRuntime } from "./testing/runtime";
import * as translationBatches from "./translation-batches";
import { usageService } from "./usage";
import { decideVariantReview, getVariantReview } from "./variant-decisions";
import { createTranslationCandidateHandler } from "./variant-handlers";
import { prepareVariantReview } from "./variant-sources";

const database = aiTestDatabase();
let failPart = 1;
let writers = 0;
let verifiers = 0;
let additionalFailedPart = 0;
let plannedEvidenceIds: string[] = [];
let sourceId: string | undefined;
let languageCopyId: string | undefined;
let observeOperationId: string | undefined;
let observedProgress: Array<{ phase: "writer" | "verifier"; step: string | undefined; part: number | undefined }> = [];
let observedCurrentStartTimes: boolean[] = [];
let beforeWriterResponse: (() => Promise<void>) | undefined;
let reviewDecisionFixture = false;
let stepCostMicros = 10;
const runtime = {
	...syntheticReviewRuntime,
	localOwnerAllowance: { ownerId: "alice", limit: 100 },
	fetch: async (_url: unknown, init?: RequestInit) => {
		const body = JSON.parse(String(init?.body));
		const payload = JSON.parse(body.messages.at(-1).content);
		const selection = (id: string) =>
			JSON.parse(payload.selections.find((entry: { id: string }) => entry.id === id).text);
		const verifier = payload.selections.some((entry: { id: string }) => entry.id === "variant-verification-task");
		const operationId = observeOperationId;
		if (operationId) {
			const view = await run(() => operationService.get("alice", operationId));
			const root = (
				await database.admin().query("SELECT execution_started_at FROM ai_operation WHERE id=$1", [operationId])
			).rows[0];
			observedCurrentStartTimes.push(view.progress?.startedAt === root.execution_started_at.toISOString());
			observedProgress.push({
				phase: verifier ? "verifier" : "writer",
				step: view.progress?.step,
				part: view.progress?.part,
			});
		}
		let output: unknown;
		if (verifier) {
			verifiers++;
			const task = selection("variant-verification-task");
			output = {
				schemaVersion: 1,
				verdicts: task.claims.map((claim: { id: string; evidenceIds: string[] }) => ({
					claimId: claim.id,
					verdict: [failPart, additionalFailedPart].some(
						(part) => part > 0 && claim.evidenceIds.includes(plannedEvidenceIds[part - 1] ?? ""),
					)
						? "unsupported"
						: "supported",
					evidenceIds: claim.evidenceIds,
					reason: "Synthetic check",
				})),
				absence: [],
				premises: task.premises.map((entry: { id: string }) => ({
					id: entry.id,
					verdict: "no_candidate_premise",
					reason: "Synthetic check",
				})),
				retention: {
					status: "retained",
					evidenceIds: [
						...new Set<string>(task.claims.flatMap((claim: { evidenceIds: string[] }) => claim.evidenceIds)),
					],
					reason: "Synthetic retention",
				},
				coverage: { status: "complete", reason: "Synthetic coverage" },
				quality: { assessment: "translation_language_quality", status: "appropriate", reason: '{"mqm":[]}' },
			};
		} else {
			writers++;
			await beforeWriterResponse?.();
			const task = selection("variant-task");
			output = {
				direction: task.direction,
				sourceRevision: task.sourceRevision,
				segments: selection("variant-cv-evidence").map((fact: { id: string; text: string }) => {
					const text = reviewDecisionFixture
						? fact.text.replaceAll("Used React for confirmed career work number", "استخدمت React في عمل مهني موثق رقم")
						: fact.text;
					return {
						sourceId: fact.id,
						text,
						claims: [{ id: "claim", text, evidenceIds: [fact.id], kind: "translation" }],
					};
				}),
				notes: [],
			};
		}
		return Response.json({
			id: "synthetic",
			model: body.model,
			provider: body.provider.only[0],
			choices: [{ index: 0, message: { role: "assistant", content: JSON.stringify(output) }, finish_reason: "stop" }],
			usage: { prompt_tokens: 5, completion_tokens: 5, total_tokens: 10, cost: stepCostMicros / 1_000_000 },
		});
	},
};
const run = <T>(work: () => T) => database.run(() => withAiRuntime(runtime, work));
beforeAll(async () => {
	await database
		.admin()
		.query(
			"INSERT INTO ai_processing_consent(id,user_id,route_id,route_revision,notice_version,purpose,config_revision) VALUES ('batch-consent','alice','synthetic','1','1','review.translation','1')",
		);
	await database
		.admin()
		.query(
			"INSERT INTO ai_platform_budget(id,route_id,route_revision,window_date,cap_micros,request_cap_micros,concurrency) VALUES ('batch-budget','synthetic','1',(now() AT TIME ZONE 'UTC')::date,100000,10000,6)",
		);
});
beforeEach(() => {
	failPart = 0;
	writers = 0;
	verifiers = 0;
	additionalFailedPart = 0;
	plannedEvidenceIds = [];
	observeOperationId = undefined;
	observedProgress = [];
	observedCurrentStartTimes = [];
	beforeWriterResponse = undefined;
	reviewDecisionFixture = false;
	stepCostMicros = 10;
	runtime.localOwnerAllowance.limit = 100;
});
async function start(repeat = 3, paragraphCount = 18, unresolved = false, plainDescription = false) {
	const data = structuredClone(defaultResumeData);
	data.summary.hidden = false;
	data.summary.content = Array.from(
		{ length: paragraphCount },
		(_, i) =>
			`<p>${`Used React for confirmed career work number ${i}. `.repeat(repeat).trim()}${unresolved && i === paragraphCount - 1 ? " [LOCAL_999]" : ""}</p>`,
	).join("");
	data.metadata.layout.pages = [{ fullWidth: false, main: ["summary"], sidebar: [] }];
	if (plainDescription) {
		data.sections.experience.hidden = false;
		data.sections.experience.items.push({
			id: randomUUID(),
			hidden: false,
			company: "Example",
			position: "",
			location: "",
			period: "",
			website: { url: "", label: "", inlineLink: false },
			roles: [],
			description: "Used React for confirmed career work number 99.",
		});
		data.metadata.layout.pages[0]?.main.push("experience");
	}
	const source =
		sourceId ??
		(await run(() => resumeService.create({ userId: "alice", name: "Synthetic", tags: [], data, locale: "en-US" })));
	sourceId = source;
	if (repeat !== 3 || paragraphCount !== 18 || unresolved || plainDescription)
		await database.admin().query("UPDATE resume SET data=$2,updated_at=now() WHERE id=$1", [source, data]);
	const revision = (
		await database.admin().query("SELECT updated_at FROM resume WHERE id=$1", [source])
	).rows[0].updated_at.toISOString();
	if (!languageCopyId) {
		const created = await run(() =>
			createVariant("alice", {
				variantKind: "language",
				sourceResumeId: source,
				expectedUpdatedAt: revision,
				requestKey: randomUUID(),
				targetLocale: "ar-SA",
			}),
		);
		languageCopyId = created.resumeId;
	}
	if (reviewDecisionFixture || plainDescription)
		await database.admin().query("UPDATE resume SET data=$2,updated_at=now() WHERE id=$1", [languageCopyId, data]);
	const row = (await database.admin().query("SELECT updated_at,data FROM resume WHERE id=$1", [languageCopyId]))
		.rows[0];
	const copy = { resumeId: languageCopyId, updatedAt: row.updated_at.toISOString() as string };
	const prepared = await run(() =>
		prepareVariantReview("alice", {
			kind: "review.translation",
			resumeId: copy.resumeId,
			expectedUpdatedAt: copy.updatedAt,
			expectedSourceRevision: revision,
		}),
	);
	const route = runtime.routes[0];
	if (!route) throw new Error("Missing synthetic translation route");
	const request = {
		kind: prepared.kind,
		parameters: prepared.parameters,
		sources: prepared.sources,
		requestKey: randomUUID(),
		route: { routeId: route.routeId, routeRevision: "1", configRevision: "1" },
		consentVersion: "1",
	};
	const operation = await run(() => operationService.start("alice", request));
	const manifest = (
		await database.admin().query("SELECT plan FROM ai_translation_batch WHERE root_operation_id=$1", [operation.id])
	).rows[0].plan;
	plannedEvidenceIds = manifest.batches.map((part: Array<{ id: string }>) => part[0]?.id);
	return { copy, operation, request, data: row.data as typeof data, source, revision };
}

it("keeps verified parts, retries only the failed part, charges the whole translation once at admission and exposes one atomic review", async () => {
	failPart = 2;
	writers = 0;
	verifiers = 0;
	const f = await start();
	const preflight = await run(() => operationService.preflight("alice", f.request));
	expect(preflight.operationCost).toBe(1);
	const partCount = f.operation.progress?.total ?? 0;
	expect(partCount).toBeGreaterThanOrEqual(3);
	expect(preflight.translationParts).toBe(partCount);
	await run(() => runAiOperations());
	expect(await run(() => operationService.get("alice", f.operation.id))).toMatchObject({
		state: "succeeded",
		resultId: f.operation.id,
		retryable: true,
		progress: { part: partCount, total: partCount },
	});
	await run(() => runAiOperations());
	// Item 92: after 1 automatic regenerate, verified segments are applied and only the rejected segment is withheld with retryable: true.
	const partial = await run(() => operationService.get("alice", f.operation.id));
	expect(partial).toMatchObject({ state: "succeeded", resultId: f.operation.id, retryable: true });
	expect(partial).not.toHaveProperty("failureDetail");
	const partialReview = await run(() => getVariantReview("alice", f.operation.id));
	expect(partialReview.result.kind).toBe("review.translation");
	if (partialReview.result.kind !== "review.translation") throw new Error("Missing translation");
	expect(partialReview.result.withheld).toMatchObject({ count: 1, rules: ["AI_VERIFICATION_CLAIM_SUPPORT"] });
	expect(writers).toBe(partCount + 1);
	failPart = 0;
	const retryKey = randomUUID();
	const retry = await run(() => operationService.retryTranslation("alice", f.operation.id, retryKey));
	expect(await run(() => operationService.retryTranslation("alice", f.operation.id, retryKey))).toEqual(retry);
	for (let i = 0; i < 20; i++) {
		const view = await run(() => operationService.get("alice", f.operation.id));
		if (view.resultId && !view.retryable) break;
		await run(() => runAiOperations());
	}
	const final = await run(() => operationService.get("alice", f.operation.id));
	expect(final.failureCode).toBeNull();
	expect(final).toMatchObject({ state: "succeeded", resultId: f.operation.id, retryable: false });
	const view = await run(() => getVariantReview("alice", f.operation.id));
	expect(view.result.kind).toBe("review.translation");
	if (view.result.kind !== "review.translation") throw new Error("Missing translation");
	expect(view.result.withheld).toBeUndefined();
	expect(view.result.output.segments.length).toBe(18);
	expect(writers).toBe(partCount + 2);
	expect(verifiers).toBe(writers);
	const ledger = (
		await database
			.admin()
			.query(
				"SELECT kind,count(*)::int n FROM ai_usage_ledger WHERE operation_id IN (SELECT id FROM ai_operation WHERE parameters->'translationBatch'->>'rootId'=$1) GROUP BY kind",
				[f.operation.id],
			)
	).rows;
	expect(ledger).toHaveLength(2);
	expect(ledger).toContainEqual({ kind: "reserve", n: 1 });
	expect(ledger).toContainEqual({ kind: "settle", n: 1 });
	// Item 65: clean multi-part translation auto-applies atomically to the language copy without changing the source CV.
	expect(view.statuses.translation).toBe("accepted");
	await expect(
		run(() =>
			operationService.start("alice", {
				...f.request,
				requestKey: randomUUID(),
				parameters: {
					...f.request.parameters,
					translationBatch: { rootId: f.operation.id, index: 1, total: partCount },
				},
			}),
		),
	).rejects.toMatchObject({ code: "BAD_REQUEST" });
});

async function runOnePart() {
	await run(async () => {
		const lease = await claimNextOperation("alice");
		expect(lease).not.toBeNull();
		if (lease) await executeLease(lease);
	});
}

it.each([2, 100])(
	"retries every failed part beyond six after deployment at translation staging capacity %i without another credit",
	async (platformConcurrency) => {
		const transport = runtime.fetch;
		const routes = runtime.routes;
		const slots = Math.min(platformConcurrency, 6);
		const savedSource = sourceId;
		const savedCopy = languageCopyId;
		const savedData = savedSource
			? (await database.admin().query("SELECT data,updated_at FROM resume WHERE id=$1", [savedSource])).rows[0]
			: undefined;
		try {
			await database
				.admin()
				.query("UPDATE ai_platform_budget SET concurrency=$1 WHERE id='batch-budget'", [platformConcurrency]);
			runtime.fetch = async () => new Response("temporarily unavailable", { status: 503 });
			const fixture = await start(8);
			const total = fixture.operation.progress?.total ?? 0;
			expect(total).toBeGreaterThan(6);
			await run(() => runAiOperations(undefined, 100));
			expect(await run(() => operationService.get("alice", fixture.operation.id))).toMatchObject({
				state: "failed",
				progress: {
					failedParts: total,
					failedPartDetails: Array.from({ length: total }, (_, index) => ({
						part: index + 1,
						failureCode: "AI_TRANSIENT",
					})),
				},
			});
			runtime.fetch = transport;
			runtime.routes = routes.map((route) => ({
				...route,
				configRevision: "bulk-retry-deployed",
				maxOutputTokens: 1536,
			}));
			await database
				.admin()
				.query("UPDATE ai_processing_consent SET config_revision='bulk-retry-deployed' WHERE id='batch-consent'");
			const resumed = await run(() =>
				operationService.retryTranslation(
					"alice",
					fixture.operation.id,
					randomUUID(),
					{
						route: { ...fixture.request.route, configRevision: "bulk-retry-deployed" },
						consentVersion: "1",
					},
					"failed_parts",
				),
			);
			expect(resumed).toMatchObject({
				state: "queued",
				progress: { activeParts: slots, pendingRetryParts: total - slots },
			});
			const persisted = (
				await database
					.admin()
					.query("SELECT execution FROM ai_translation_batch WHERE root_operation_id=$1", [fixture.operation.id])
			).rows[0].execution;
			expect(persisted.retryFailedOperationIds).toHaveLength(total - slots);
			// A later worker resumes from the persisted aggregate after the retry request returns.
			await run(() => runAiOperations(undefined, 100));
			expect(await finishBatch(fixture.operation.id)).toMatchObject({
				state: "succeeded",
				resultId: fixture.operation.id,
			});
			expect(writers).toBe(total);
			const ledger = await database
				.admin()
				.query(
					"SELECT kind,count(*)::int n FROM ai_usage_ledger WHERE operation_id IN (SELECT id FROM ai_operation WHERE parameters->'translationBatch'->>'rootId'=$1) GROUP BY kind",
					[fixture.operation.id],
				);
			expect(ledger.rows).toEqual(
				expect.arrayContaining([
					{ kind: "reserve", n: 1 },
					{ kind: "settle", n: 1 },
				]),
			);
		} finally {
			runtime.fetch = transport;
			runtime.routes = routes;
			await database.admin().query("UPDATE ai_processing_consent SET config_revision='1' WHERE id='batch-consent'");
			await database.admin().query("UPDATE ai_platform_budget SET concurrency=6 WHERE id='batch-budget'");
			if (savedSource && savedData)
				await database
					.admin()
					.query("UPDATE resume SET data=$2,updated_at=$3 WHERE id=$1", [
						savedSource,
						savedData.data,
						savedData.updated_at,
					]);
			sourceId = savedSource;
			languageCopyId = savedCopy;
		}
	},
	20000,
);

async function finishBatch(operationId: string) {
	for (let attempt = 0; attempt < 8; attempt++) {
		const view = await run(() => operationService.get("alice", operationId));
		if (view.resultId) return view;
		await run(() => runAiOperations());
	}
	throw new Error("Translation batch did not deliver within its bounded fixture steps");
}

it.each([2, 6, 100])(
	"runs up to six parts within translation staging capacity %i and refills without another user charge",
	async (platformConcurrency) => {
		// Make room for six simultaneous worst-case writer holds and the unrelated test operations.
		const savedRoutes = runtime.routes;
		runtime.routes = savedRoutes.map((route) => ({ ...route, requestCapMicros: 25_000 }));
		await database
			.admin()
			.query("UPDATE ai_platform_budget SET concurrency=$1,request_cap_micros=25000 WHERE id='batch-budget'", [
				platformConcurrency,
			]);
		const slots = Math.min(platformConcurrency, 6);
		const savedSource = sourceId;
		const savedCopy = languageCopyId;
		const savedData = savedSource
			? (await database.admin().query("SELECT data,updated_at FROM resume WHERE id=$1", [savedSource])).rows[0]
			: undefined;
		const releases: Array<() => void> = [];
		const release = () => releases.forEach((resolve) => resolve());
		let worker: Promise<void> | undefined;
		try {
			const fixture = await start(8);
			expect(fixture.operation.progress?.total).toBeGreaterThan(slots);
			const queued = await database
				.admin()
				.query(
					"SELECT count(*)::int n FROM ai_operation WHERE parameters->'translationBatch'->>'rootId'=$1 AND state='queued'",
					[fixture.operation.id],
				);
			expect(queued.rows[0].n).toBe(slots);
			const anotherOperation = { ...fixture.request, requestKey: randomUUID() };
			expect(await run(() => operationService.preflight("alice", anotherOperation))).toMatchObject({
				available: false,
				reason: "AI_TARGET_BUSY",
			});
			await expect(run(() => operationService.start("alice", anotherOperation))).rejects.toMatchObject({
				data: {
					reason: "AI_TARGET_BUSY",
				},
			});
			if (platformConcurrency === 6) {
				const review = syntheticRuntime.handlers.review;
				if (!review) throw new Error("Missing review handler");
				const reviewRuntime = { ...runtime, handlers: { ...runtime.handlers, review } };
				await database
					.admin()
					.query(
						"INSERT INTO ai_processing_consent(id,user_id,route_id,route_revision,notice_version,purpose,config_revision) VALUES ($1,'alice','synthetic','1','1','review','1')",
						[randomUUID()],
					);
				const extras: OperationRequest[] = [];
				for (let i = 0; i < 2; i++) {
					const id = randomUUID();
					const cv = await database
						.admin()
						.query(
							"INSERT INTO resume(id,user_id,name,slug,data) VALUES ($1,'alice','Synthetic',$1,'{}') RETURNING updated_at",
							[id],
						);
					extras.push({
						...fixture.request,
						kind: "review",
						parameters: {},
						requestKey: randomUUID(),
						sources: [{ kind: "resume" as const, id, revision: cv.rows[0].updated_at.toISOString() }],
					});
				}
				await database.run(() =>
					withAiRuntime(reviewRuntime, async () => {
						const admitted = await Promise.all(extras.map((request) => operationService.start("alice", request)));
						// Use a fresh independent target to exercise account capacity, not the target lock.
						const id = randomUUID();
						const cv = await database
							.admin()
							.query(
								"INSERT INTO resume(id,user_id,name,slug,data) VALUES ($1,'alice','Synthetic',$1,'{}') RETURNING updated_at",
								[id],
							);
						const firstExtra = extras[0];
						if (!firstExtra) throw new Error("Missing independent target");
						const fourth = {
							...firstExtra,
							requestKey: randomUUID(),
							sources: [{ kind: "resume" as const, id, revision: cv.rows[0].updated_at.toISOString() }],
						};
						expect(await operationService.preflight("alice", fourth)).toMatchObject({
							available: false,
							reason: "AI_CONCURRENCY_LIMIT",
							allowance: { limit: 3, used: 0, reserved: 3, remaining: 0 },
						});
						await expect(operationService.start("alice", fourth)).rejects.toMatchObject({
							data: { reason: "AI_CONCURRENCY_LIMIT" },
						});
						const rollback = new Error("Keep queued operations for the dispatch test");
						await expect(
							withOwnerDatabase("alice", async () => {
								const first = await claimNextOperation("alice");
								const next = await claimNextOperation("alice");
								expect(first?.operationId).toBe(fixture.operation.id);
								expect(admitted.map((operation) => operation.id)).toContain(next?.operationId);
								throw rollback;
							}),
						).rejects.toBe(rollback);
						for (const operation of admitted) await operationService.cancel("alice", operation.id);
					}),
				);
			}
			const occupied = Promise.withResolvers<void>();
			const refilled = Promise.withResolvers<void>();
			beforeWriterResponse = async () => {
				if (writers > 6) refilled.resolve();
				if (writers > slots) return;
				const response = Promise.withResolvers<void>();
				releases.push(response.resolve);
				if (releases.length === slots) occupied.resolve();
				await response.promise;
			};
			worker = run(() => runAiOperations(undefined, 100));
			await occupied.promise;
			expect(writers).toBe(slots);
			for (const resolve of releases.slice(1)) resolve();
			await refilled.promise;
			expect(writers).toBeGreaterThan(6);
			await expect(run(() => getVariantReview("alice", fixture.operation.id))).rejects.toMatchObject({
				code: "PRECONDITION_FAILED",
			});
			release();
			await worker;
			beforeWriterResponse = undefined;
			expect(await finishBatch(fixture.operation.id)).toMatchObject({
				state: "succeeded",
				resultId: fixture.operation.id,
			});
			expect(writers).toBe(fixture.operation.progress?.total);
			const ledger = await database
				.admin()
				.query(
					"SELECT kind,count(*)::int n FROM ai_usage_ledger WHERE operation_id IN (SELECT id FROM ai_operation WHERE parameters->'translationBatch'->>'rootId'=$1) GROUP BY kind",
					[fixture.operation.id],
				);
			expect(ledger.rows).toEqual(
				expect.arrayContaining([
					{ kind: "reserve", n: 1 },
					{ kind: "settle", n: 1 },
				]),
			);
			// Item 65: clean translation auto-applies atomically to the language copy.
			expect((await run(() => getVariantReview("alice", fixture.operation.id))).statuses.translation).toBe("accepted");
		} finally {
			beforeWriterResponse = undefined;
			release();
			await worker;
			runtime.routes = savedRoutes;
			await database
				.admin()
				.query("UPDATE ai_platform_budget SET concurrency=6,request_cap_micros=10000 WHERE id='batch-budget'");
			if (savedSource && savedData)
				await database
					.admin()
					.query("UPDATE resume SET data=$2,updated_at=$3 WHERE id=$1", [
						savedSource,
						savedData.data,
						savedData.updated_at,
					]);
			if (!savedCopy && languageCopyId)
				await database.admin().query("DELETE FROM resume WHERE id=$1", [languageCopyId]);
			if (!savedSource && sourceId) await database.admin().query("DELETE FROM resume WHERE id=$1", [sourceId]);
			sourceId = savedSource;
			languageCopyId = savedCopy;
		}
	},
	15000,
);

it.each(["writer", "verifier"])(
	"automatically retries one transient %s error without repeating verified work or charging quota",
	async (phase) => {
		const transport = runtime.fetch;
		const routes = runtime.routes;
		runtime.routes = routes.map((route) => ({ ...route, maxCalls: 2, maxRepairs: 0, translationTransientRetries: 1 }));
		let failed = false;
		let failedAt = 0;
		let retriedAt = 0;
		let retryPayload = "";
		runtime.fetch = async (url, init) => {
			const body = JSON.parse(String(init?.body));
			const payload = JSON.parse(body.messages.at(-1).content);
			const verifying = payload.selections.some((entry: { id: string }) => entry.id === "variant-verification-task");
			if (verifying === (phase === "verifier")) {
				if (!failed) {
					failed = true;
					failedAt = Date.now();
					retryPayload = JSON.stringify(payload);
					return new Response("upstream overloaded", { status: 503 });
				}
				if (JSON.stringify(payload) === retryPayload && !retriedAt) retriedAt = Date.now();
			}
			return transport(url, init);
		};
		const before = await run(() => usageService.getStartUsage("alice"));
		try {
			const fixture = await start();
			expect(await finishBatch(fixture.operation.id)).toMatchObject({ state: "succeeded" });
			expect(failed).toBe(true);
			expect(retriedAt - failedAt).toBeGreaterThanOrEqual(200);
			expect(writers).toBe(fixture.operation.progress?.total);
			expect(verifiers).toBe(fixture.operation.progress?.total);
			expect((await run(() => usageService.getStartUsage("alice"))).operations.used).toBe(before.operations.used + 1);
			const attempts = await database
				.admin()
				.query(
					"SELECT a.step_id,a.outcome,a.output FROM ai_operation_attempt a JOIN ai_operation o ON o.id=a.operation_id WHERE o.parameters->'translationBatch'->>'rootId'=$1",
					[fixture.operation.id],
				);
			const calls = attempts.rows.flatMap((row) => row.output?._verifyCalls ?? []);
			if (phase === "verifier") expect(calls.filter((call) => call.outcome === "transient")).toHaveLength(1);
			else expect(attempts.rows.filter((row) => row.outcome === "transient")).toHaveLength(1);
			expect(attempts.rows).toHaveLength((fixture.operation.progress?.total ?? 0) * 2 + (phase === "writer" ? 1 : 0));
			// Item 65: clean translation auto-applies atomically to the language copy.
			expect((await run(() => getVariantReview("alice", fixture.operation.id))).statuses.translation).toBe("accepted");
		} finally {
			runtime.fetch = transport;
			runtime.routes = routes;
		}
	},
);

it.each([
	["writer", 1, true],
	["verifier", 1, true],
	["verifier", 2, true],
	["verifier", 1, false],
] as const)(
	"handles a %s call timeout with %i timed out responses and deadline room=%s",
	async (phase, timeoutCount, deadlineRoom) => {
		const transport = runtime.fetch;
		const routes = runtime.routes;
		const routeId = `timeout-${phase}-${timeoutCount}-${deadlineRoom}`;
		const admin = database.admin();
		await admin.query(
			"INSERT INTO ai_platform_budget(id,route_id,route_revision,window_date,cap_micros,request_cap_micros,concurrency) VALUES ($1,$1,'1',(now() AT TIME ZONE 'UTC')::date,100000,10000,6)",
			[routeId],
		);
		await admin.query(
			"INSERT INTO ai_processing_consent(id,user_id,route_id,route_revision,notice_version,purpose,config_revision) VALUES ($1,'alice',$1,'1','1','review.translation','1')",
			[routeId],
		);
		runtime.routes = routes.map((route) => {
			if (!route.verifier) throw new Error("Missing synthetic translation verifier");
			return {
				...route,
				routeId,
				callTimeoutMs: 500,
				deadlineMs: deadlineRoom ? route.deadlineMs : 10000,
				// Leave room for an owner-triggered retry while both unknown costs remain reserved.
				verifier: { ...route.verifier, maxCallCostMicros: 1000 },
			};
		});
		let selectedPayload: string | undefined;
		let calls = 0;
		runtime.fetch = async (url, init) => {
			const body = JSON.parse(String(init?.body));
			const payload = body.messages.at(-1).content;
			const verifying = payload.includes('"id":"variant-verification-task"');
			if (verifying === (phase === "verifier") && payload.includes(plannedEvidenceIds[1] ?? "<missing part>")) {
				selectedPayload ??= payload;
				if (payload === selectedPayload && ++calls <= timeoutCount) {
					return new Response(
						new ReadableStream({
							start(controller) {
								init?.signal?.addEventListener("abort", () => controller.error(init.signal?.reason), { once: true });
							},
						}),
						{ status: 200, headers: { "content-type": "application/json" } },
					);
				}
			}
			return transport(url, init);
		};
		const before = await run(() => usageService.getStartUsage("alice"));
		try {
			const fixture = await start();
			await run(() => runAiOperations());
			const view = await run(() => operationService.get("alice", fixture.operation.id));
			if (deadlineRoom && timeoutCount === 1) expect(view).toMatchObject({ state: "succeeded", retryable: false });
			else {
				expect(view).toMatchObject({ state: "failed", retryable: true, failureCode: "AI_TIMEOUT" });
				expect(view.progress?.failedPartDetails).toEqual([{ part: 2, failureCode: "AI_TIMEOUT" }]);
			}
			expect(calls).toBe(deadlineRoom ? 2 : 1);
			expect((await run(() => usageService.getStartUsage("alice"))).operations.used).toBe(before.operations.used + 1);
			const { rows } = await database.admin().query(
				`SELECT a.outcome,a.cost_micros,a.output,o.actual_micros
			FROM ai_operation_attempt a JOIN ai_operation o ON a.operation_id=o.id
			WHERE o.parameters->'translationBatch'->>'rootId'=$1`,
				[fixture.operation.id],
			);
			const attempts = phase === "writer" ? rows : rows.flatMap((row) => row.output?._verifyCalls ?? []);
			const timedOut = attempts.filter((call) => call.outcome === "unknown" && !call.output?._verifyCalls);
			expect(timedOut).toHaveLength(timeoutCount);
			for (const call of timedOut) expect(call.costMicros ?? call.cost_micros ?? null).toBeNull();
			expect(rows.some((row) => row.actual_micros === null)).toBe(true);
			if (timeoutCount === 2) {
				const retried = await run(() =>
					operationService.retryTranslation("alice", fixture.operation.id, randomUUID(), undefined, { partIndex: 1 }),
				);
				expect(retried).toMatchObject({ state: "queued", progress: { part: 2, activeParts: 1 } });
				expect(await finishBatch(fixture.operation.id)).toMatchObject({ state: "succeeded", retryable: false });
				expect((await run(() => usageService.getStartUsage("alice"))).operations.used).toBe(before.operations.used + 1);
			}
		} finally {
			runtime.fetch = transport;
			runtime.routes = routes;
		}
	},
);

it.each(["writer", "verifier"])("bounds automatic %s retry and lets the other parts finish", async (phase) => {
	const transport = runtime.fetch;
	const routes = runtime.routes;
	runtime.routes = routes.map((route) => ({ ...route, maxCalls: 2, maxRepairs: 0, translationTransientRetries: 1 }));
	let failedPayload: string | undefined;
	let failures = 0;
	runtime.fetch = async (url, init) => {
		const body = JSON.parse(String(init?.body));
		const payload = JSON.parse(body.messages.at(-1).content);
		const verifying = payload.selections.some((entry: { id: string }) => entry.id === "variant-verification-task");
		if (verifying === (phase === "verifier")) {
			failedPayload ??= JSON.stringify(payload);
			if (JSON.stringify(payload) === failedPayload) {
				failures++;
				return new Response("upstream overloaded", { status: 503 });
			}
		}
		return transport(url, init);
	};
	const before = await run(() => usageService.getStartUsage("alice"));
	try {
		const f = await start();
		await run(() => runAiOperations());
		expect(await run(() => operationService.get("alice", f.operation.id))).toMatchObject({
			state: "failed",
			retryable: true,
			resultId: null,
			failureCode: phase === "verifier" ? "AI_VERIFIER_UNAVAILABLE" : "AI_TRANSIENT",
		});
		expect(failures).toBe(2);
		expect(verifiers).toBe((f.operation.progress?.total ?? 0) - 1);
		await expect(run(() => getVariantReview("alice", f.operation.id))).rejects.toMatchObject({
			code: "PRECONDITION_FAILED",
		});
		runtime.fetch = transport;
		const finishedWriters = writers;
		await run(() => operationService.retryTranslation("alice", f.operation.id, randomUUID()));
		expect(await finishBatch(f.operation.id)).toMatchObject({ state: "succeeded" });
		expect(writers - finishedWriters).toBe(1);
		expect((await run(() => usageService.getStartUsage("alice"))).operations.used).toBe(before.operations.used + 1);
	} finally {
		runtime.fetch = transport;
		runtime.routes = routes;
	}
});

it.each(["live", "legacy-retry", "legacy-recovery"])(
	"dispatches unstarted parts after a failure, including legacy persisted runs (%s), then retries across a deployment into one review",
	async (scenario) => {
		const legacy = scenario !== "live";
		const original = (await database.admin().query("SELECT data,updated_at FROM resume WHERE id=$1", [sourceId]))
			.rows[0];
		const f = await start(8);
		try {
			const total = f.operation.progress?.total;
			if (!total) throw new Error("Expected a persisted translation part count");
			expect(total).toBeGreaterThan(6);
			failPart = 1;
			if (legacy)
				await database
					.admin()
					.query(
						"UPDATE ai_translation_batch SET state='paused',failure_code='AI_CANCELLED' WHERE root_operation_id=$1",
						[f.operation.id],
					);
			await runOnePart();
			await run(() => runAiOperations());
			if (legacy) {
				// The previous dispatcher stopped after six admissions and did not persist its plan.
				const count = (
					await database
						.admin()
						.query("SELECT count(*)::int AS n FROM ai_operation WHERE parameters->'translationBatch'->>'rootId'=$1", [
							f.operation.id,
						])
				).rows[0].n;
				expect(count).toBe(6);
				await database.admin().query("DELETE FROM ai_translation_batch WHERE root_operation_id=$1", [f.operation.id]);
				await database
					.admin()
					.query(
						"INSERT INTO ai_translation_batch(root_operation_id,user_id,total,state,failure_code) VALUES ($1,'alice',$2,'paused','AI_VERIFICATION_FAILED')",
						[f.operation.id, total],
					);
				if (scenario === "legacy-recovery") await run(() => runAiOperations());
			}
			const unstarted = scenario === "legacy-retry" ? total - 6 : 0;
			const before = (
				await database
					.admin()
					.query("SELECT state FROM ai_operation WHERE parameters->'translationBatch'->>'rootId'=$1", [f.operation.id])
			).rows;
			expect(before.filter((part) => part.state === "waiting_review")).toHaveLength(total - unstarted);
			expect(await run(() => operationService.get("alice", f.operation.id))).toMatchObject(
				scenario === "legacy-retry"
					? { state: "failed", resultId: null, retryable: true }
					: { state: "succeeded", resultId: f.operation.id, retryable: true },
			);
			const deployed = {
				...runtime,
				routes: runtime.routes.map((route) => ({
					...route,
					configRevision: "deployed",
					maxOutputTokens: 1536,
				})),
			};

			failPart = 0;
			const writersBefore = writers;
			const retry = () =>
				database.run(() =>
					withAiRuntime(deployed, () =>
						operationService.retryTranslation("alice", f.operation.id, randomUUID(), {
							route: { ...f.request.route, configRevision: "deployed" },
							consentVersion: "1",
						}),
					),
				);
			await expect(retry()).rejects.toMatchObject({ data: { reason: "AI_CONSENT_REQUIRED" } });
			await database
				.admin()
				.query("UPDATE ai_processing_consent SET config_revision='deployed' WHERE id='batch-consent'");
			await retry();
			await database.run(() => withAiRuntime(deployed, () => runAiOperations()));
			expect(writers - writersBefore).toBe(1 + unstarted);
			expect(await run(() => operationService.get("alice", f.operation.id))).toMatchObject({
				state: "succeeded",
				resultId: f.operation.id,
			});
			const review = await run(() => getVariantReview("alice", f.operation.id));
			expect(review.result.kind).toBe("review.translation");
			expect(
				(
					await database
						.admin()
						.query("SELECT count(*)::int AS n FROM ai_usage_ledger WHERE operation_id=$1 AND kind='settle'", [
							f.operation.id,
						])
				).rows[0].n,
			).toBe(1);
			// Item 65: auto-applied translation updates the copy while leaving the source CV untouched.
			expect((await run(() => getVariantReview("alice", f.operation.id))).statuses.translation).toBe("accepted");
		} finally {
			await run(() => operationService.cancel("alice", f.operation.id));
			await database.admin().query("UPDATE ai_processing_consent SET config_revision='1' WHERE id='batch-consent'");
			if (original)
				await database
					.admin()
					.query("UPDATE resume SET data=$2,updated_at=$3 WHERE id=$1", [sourceId, original.data, original.updated_at]);
		}
	},
	15000,
);

it("refuses a verifier retry when its known cost leaves insufficient reserved money", async () => {
	await database.admin().query("UPDATE ai_platform_budget SET request_cap_micros=6666 WHERE id='batch-budget'");
	const transport = runtime.fetch;
	const routes = runtime.routes;
	runtime.routes = routes.map((route) => ({
		...route,
		maxCalls: 2,
		maxRepairs: 0,
		requestCapMicros: 6666,
		translationTransientRetries: 1,
	}));
	let failedPayload: string | undefined;
	let failures = 0;
	runtime.fetch = async (url, init) => {
		const body = JSON.parse(String(init?.body));
		const payload = JSON.parse(body.messages.at(-1).content);
		if (payload.selections.some((entry: { id: string }) => entry.id === "variant-verification-task")) {
			failedPayload ??= JSON.stringify(payload);
			if (JSON.stringify(payload) === failedPayload) {
				failures++;
				return Response.json(
					{ error: { code: 503, message: "overloaded" }, usage: { cost: 0.00333 } },
					{ status: 503 },
				);
			}
		}
		return transport(url, init);
	};
	try {
		const f = await start();
		await run(() => runAiOperations());
		expect(failures).toBe(1);
		expect(await run(() => operationService.get("alice", f.operation.id))).toMatchObject({
			state: "failed",
			failureCode: "AI_REQUEST_COST_LIMIT",
			resultId: null,
		});
	} finally {
		runtime.fetch = transport;
		runtime.routes = routes;
		await database.admin().query("UPDATE ai_platform_budget SET request_cap_micros=10000 WHERE id='batch-budget'");
	}
});

it("resumes the saved verifier after a transient failure and worker shutdown without rewriting", async () => {
	const transport = runtime.fetch;
	const routes = runtime.routes;
	runtime.routes = routes.map((route) => ({ ...route, maxCalls: 2, maxRepairs: 0, translationTransientRetries: 1 }));
	const controller = new AbortController();
	let failed = false;
	runtime.fetch = async (url, init) => {
		const payload = JSON.parse(JSON.parse(String(init?.body)).messages.at(-1).content);
		if (!failed && payload.selections.some((entry: { id: string }) => entry.id === "variant-verification-task")) {
			failed = true;
			controller.abort();
			return new Response("upstream overloaded", { status: 503 });
		}
		return transport(url, init);
	};
	try {
		const f = await start();
		await run(() => runAiOperations(controller.signal, 1));
		expect(writers).toBe(1);
		expect(
			(await database.admin().query("SELECT state FROM ai_operation WHERE id=$1", [f.operation.id])).rows[0].state,
		).toBe("running");
		await database
			.admin()
			.query("UPDATE ai_operation SET lease_until=now()-interval '1 second' WHERE id=$1", [f.operation.id]);
		runtime.fetch = transport;
		expect(await finishBatch(f.operation.id)).toMatchObject({ state: "succeeded" });
		expect(writers).toBe(f.operation.progress?.total);
		expect(verifiers).toBe(f.operation.progress?.total);
	} finally {
		runtime.fetch = transport;
		runtime.routes = routes;
	}
});

it("does not reset an exhausted writer retry allowance after lease recovery", async () => {
	const routes = runtime.routes;
	runtime.routes = routes.map((route) => ({ ...route, maxCalls: 2, maxRepairs: 0, translationTransientRetries: 1 }));
	try {
		const f = await start();
		const lease = await run(() => claimNextOperation("alice"));
		if (!lease) throw new Error("Missing root lease");
		expect(lease.operationId).toBe(f.operation.id);
		for (const ordinal of [1, 2])
			await database
				.admin()
				.query(
					"INSERT INTO ai_operation_attempt(id,user_id,operation_id,ordinal,step_id,lease_token,outcome,cost_micros,finished_at) VALUES ($1,'alice',$2,$3,'generate',$4,'transient',0,now())",
					[randomUUID(), f.operation.id, ordinal, lease.token],
				);
		await database
			.admin()
			.query("UPDATE ai_operation SET lease_until=now()-interval '1 second' WHERE id=$1", [f.operation.id]);
		await run(() => runAiOperations());
		expect(await run(() => operationService.get("alice", f.operation.id))).toMatchObject({
			state: "failed",
			failureCode: "AI_TRANSIENT",
			resultId: null,
		});
		expect(writers).toBe((f.operation.progress?.total ?? 0) - 1);
	} finally {
		runtime.routes = routes;
	}
});

it("does not dispatch a transient retry after the part deadline", async () => {
	const transport = runtime.fetch;
	const routes = runtime.routes;
	runtime.routes = routes.map((route) => ({
		...route,
		maxCalls: 2,
		maxRepairs: 0,
		translationTransientRetries: 1,
		deadlineMs: 2000,
	}));
	const actualNow = Date.now;
	const clock = vi.spyOn(Date, "now");
	let calls = 0;
	let operationId: string | undefined;
	runtime.fetch = async () => {
		calls++;
		clock.mockImplementation(() => actualNow() + 1800);
		return new Response("upstream overloaded", { status: 503 });
	};
	try {
		const f = await start();
		operationId = f.operation.id;
		await runOnePart();
		expect(calls).toBe(1);
		expect(await run(() => operationService.get("alice", f.operation.id))).toMatchObject({
			state: "failed",
			resultId: null,
			failureCode: "AI_DEADLINE",
		});
	} finally {
		clock.mockRestore();
		if (operationId) {
			const id = operationId;
			await run(() => operationService.cancel("alice", id));
		}
		runtime.fetch = transport;
		runtime.routes = routes;
	}
});

async function expectRootPointer(fixture: Awaited<ReturnType<typeof start>>) {
	const variants = await run(() => listVariants("alice", fixture.source));
	expect(variants.find((variant) => variant.resumeId === fixture.copy.resumeId)?.operationId).toBe(
		fixture.operation.id,
	);
}

it("retries only the selected translation part and keeps the other failure available", async () => {
	failPart = 1;
	additionalFailedPart = 3;
	const fixture = await start();
	await finishBatch(fixture.operation.id);
	const withheldParts = async () => {
		const review = await run(() => getVariantReview("alice", fixture.operation.id));
		return [...new Set(review.result.withheld?.items?.map((item) => item.partIndex))].sort();
	};
	expect(await withheldParts()).toEqual([0, 2]);
	failPart = 0;
	additionalFailedPart = 0;
	const beforeRetry = writers;
	const key = randomUUID();
	await run(() => operationService.retryTranslation("alice", fixture.operation.id, key, undefined, { partIndex: 2 }));
	await finishBatch(fixture.operation.id);
	expect(writers - beforeRetry).toBe(1);
	expect(await withheldParts()).toEqual([0]);
	await run(() => operationService.retryTranslation("alice", fixture.operation.id, key, undefined, { partIndex: 2 }));
	expect(await withheldParts()).toEqual([0]);
});

it("recovers a failed first part into one aggregate review and applies all accepted segments atomically", async () => {
	failPart = 1;
	const fixture = await start();
	await expectRootPointer(fixture);
	observeOperationId = fixture.operation.id;
	await run(() => runAiOperations());
	await run(() => runAiOperations());
	const total = fixture.operation.progress?.total ?? 0;
	expect(total).toBeGreaterThanOrEqual(3);
	expect(await run(() => operationService.get("alice", fixture.operation.id))).toMatchObject({
		state: "succeeded",
		resultId: fixture.operation.id,
		retryable: true,
		progress: { part: total, total },
	});
	expect(observedProgress).toContainEqual({ phase: "writer", step: "drafting", part: 1 });
	expect(observedProgress).toContainEqual({ phase: "verifier", step: "checking", part: 1 });
	const failedWriters = writers;
	failPart = 0;
	await run(() => operationService.retryTranslation("alice", fixture.operation.id, randomUUID()));
	await expectRootPointer(fixture);
	expect(await finishBatch(fixture.operation.id)).toMatchObject({
		state: "succeeded",
		resultId: fixture.operation.id,
		progress: { part: total, total },
	});
	expect(writers - failedWriters).toBe(1);
	expect(observedCurrentStartTimes.length).toBeGreaterThan(6);
	expect(observedCurrentStartTimes.every(Boolean)).toBe(true);
	expect(new Set(observedCurrentStartTimes).size).toBe(1);
	await expectRootPointer(fixture);
	const child = (
		await database
			.admin()
			.query(
				"SELECT id FROM ai_operation WHERE parameters->'translationBatch'->>'rootId'=$1 AND id<>$1 ORDER BY created_at DESC LIMIT 1",
				[fixture.operation.id],
			)
	).rows[0];
	expect(child).toBeDefined();
	await expect(run(() => getVariantReview("alice", child.id))).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });
	let review = await run(() => getVariantReview("alice", fixture.operation.id));
	if (review.result.kind !== "review.translation") throw new Error("Missing aggregate translation");
	expect(review.result.output.segments).toHaveLength(18);
	expect(await run(() => operationService.getResult("alice", fixture.operation.id))).toEqual(review.result);
	expect(review.statuses.translation).toBe("accepted");
	expect(
		(
			await database
				.admin()
				.query("SELECT count(*)::int n FROM resume_version WHERE resume_id=$1 AND kind='ai'", [fixture.copy.resumeId])
		).rows[0].n,
	).toBeGreaterThanOrEqual(1);
	expect(await run(() => operationService.get("alice", fixture.operation.id))).toMatchObject({
		state: "succeeded",
		resultId: fixture.operation.id,
	});
	expect(
		(
			await database
				.admin()
				.query("SELECT state,review_state FROM ai_translation_batch WHERE root_operation_id=$1", [fixture.operation.id])
		).rows[0],
	).toMatchObject({ state: "complete", review_state: "succeeded" });
});

it("finishes every part with one remaining user use and accounts platform spending per part", async () => {
	const before = await run(() => usageService.getStartUsage("alice"));
	runtime.localOwnerAllowance.limit = before.operations.used + 1;
	const fixture = await start();
	expect((await run(() => usageService.getStartUsage("alice"))).operations).toMatchObject({
		used: before.operations.used,
		reserved: 1,
		remaining: 0,
	});
	const replay = await run(() => operationService.start("alice", fixture.request));
	expect(replay.id).toBe(fixture.operation.id);
	const total = fixture.operation.progress?.total ?? 0;
	expect(total).toBeGreaterThanOrEqual(3);
	expect(await finishBatch(fixture.operation.id)).toMatchObject({
		state: "succeeded",
		resultId: fixture.operation.id,
		progress: { part: total, total },
	});
	expect(writers).toBe(total);
	expect(verifiers).toBe(total);
	expect((await run(() => usageService.getStartUsage("alice"))).operations).toMatchObject({
		used: before.operations.used + 1,
		reserved: 0,
		remaining: 0,
	});
	const parts = (
		await database
			.admin()
			.query(
				"SELECT reserved_micros::int reserved,actual_micros::int spent FROM ai_operation WHERE parameters->'translationBatch'->>'rootId'=$1",
				[fixture.operation.id],
			)
	).rows;
	expect(parts).toHaveLength(total);
	for (const part of parts) expect(part).toMatchObject({ reserved: 0, spent: 20 });
	const refreshedUpdatedAt = (
		await database.admin().query("SELECT updated_at FROM resume WHERE id=$1", [fixture.copy.resumeId])
	).rows[0].updated_at.toISOString();
	await expect(
		run(() =>
			operationService.start("alice", {
				...fixture.request,
				requestKey: randomUUID(),
				sources: fixture.request.sources.map((s) =>
					s.id === fixture.copy.resumeId ? { ...s, revision: refreshedUpdatedAt } : s,
				),
				parameters: { ...fixture.request.parameters, expectedUpdatedAt: refreshedUpdatedAt },
			}),
		),
	).rejects.toMatchObject({
		data: { reason: "AI_OPERATIONS_LIMIT" },
	});
});

it("keeps the single start charge after first-part failure and resumes at zero remaining uses", async () => {
	const original = sourceId
		? (await database.admin().query("SELECT data,updated_at FROM resume WHERE id=$1", [sourceId])).rows[0]
		: undefined;
	const before = await run(() => usageService.getStartUsage("alice"));
	runtime.localOwnerAllowance.limit = before.operations.used + 1;
	failPart = 1;
	try {
		const fixture = await start(3, 9);
		expect(fixture.operation.progress?.total).toBe(2);
		await runOnePart();
		await runOnePart();
		expect(await run(() => operationService.get("alice", fixture.operation.id))).toMatchObject({
			state: "succeeded",
			resultId: fixture.operation.id,
			retryable: true,
		});
		expect((await run(() => usageService.getStartUsage("alice"))).operations).toMatchObject({
			used: before.operations.used + 1,
			reserved: 0,
			remaining: 0,
		});
		failPart = 0;
		const writesBeforeRetry = writers;
		await run(() => operationService.retryTranslation("alice", fixture.operation.id, randomUUID()));
		await runOnePart();
		expect(await run(() => operationService.get("alice", fixture.operation.id))).toMatchObject({
			state: "succeeded",
			resultId: fixture.operation.id,
			retryable: false,
		});
		expect(writers - writesBeforeRetry).toBe(1);
		expect((await run(() => usageService.getStartUsage("alice"))).operations.used).toBe(before.operations.used + 1);
	} finally {
		if (original)
			await database
				.admin()
				.query("UPDATE resume SET data=$2, updated_at=$3 WHERE id=$1", [sourceId, original.data, original.updated_at]);
	}
});

it("releases the reservation when cancelled before the first lease", async () => {
	const before = await run(() => usageService.getStartUsage("alice"));
	const fixture = await start();
	expect(await run(() => operationService.cancel("alice", fixture.operation.id))).toMatchObject({
		state: "cancelled",
		resultId: null,
		retryable: false,
		charged: false,
	});
	expect((await run(() => usageService.getStartUsage("alice"))).operations).toMatchObject({
		used: before.operations.used,
		reserved: 0,
	});
	expect(writers).toBe(0);
	expect(verifiers).toBe(0);
});

it("expires the unstarted translation and all queued parts without dispatch or charge", async () => {
	const before = await run(() => usageService.getStartUsage("alice"));
	const { operation } = await start();
	const client = await database.admin().connect();
	try {
		await client.query("BEGIN");
		await client.query("SET LOCAL session_replication_role = replica");
		await client.query("UPDATE ai_operation SET queue_expires_at=now()-interval '1 second' WHERE id=$1", [
			operation.id,
		]);
		await client.query("COMMIT");
	} finally {
		await client.query("ROLLBACK");
		client.release();
	}
	await run(() => Promise.all([runAiOperations(), runAiOperations()]));
	expect(await run(() => operationService.get("alice", operation.id))).toMatchObject({
		state: "failed",
		resultId: null,
		failureCode: "AI_QUEUE_EXPIRED",
		retryable: false,
		charged: false,
	});
	expect((await run(() => usageService.getStartUsage("alice"))).operations).toEqual(before.operations);
	expect(writers).toBe(0);
	expect(verifiers).toBe(0);
});

it("expires a queued translation child without dispatch and retries it under the root charge", async () => {
	const fixture = await start();
	const rootId = fixture.operation.id;
	const { rows } = await database
		.admin()
		.query(
			"SELECT id FROM ai_operation WHERE id<>$1 AND parameters->'translationBatch'->>'rootId'=$1 AND state='queued' LIMIT 1",
			[rootId],
		);
	const childId: string = rows[0].id;
	const client = await database.admin().connect();
	try {
		await client.query("BEGIN");
		await client.query("SET LOCAL session_replication_role = replica");
		await client.query(
			"UPDATE ai_operation SET created_at=now()-interval '31 minutes', queue_expires_at=now()-interval '1 minute', due_at=now()+interval '1 minute' WHERE id=$1",
			[childId],
		);
		await client.query("COMMIT");
	} finally {
		await client.query("ROLLBACK");
		client.release();
	}
	await run(() => runAiOperations());
	expect(await run(() => operationService.get("alice", rootId))).toMatchObject({
		retryable: true,
		failureCode: "AI_QUEUE_EXPIRED",
	});
	expect(
		(
			await database
				.admin()
				.query("SELECT state,failure_code,reserved_micros::int FROM ai_operation WHERE id=$1", [childId])
		).rows,
	).toEqual([{ state: "failed", failure_code: "AI_QUEUE_EXPIRED", reserved_micros: 0 }]);
	expect(
		(await database.admin().query("SELECT id FROM ai_operation_attempt WHERE operation_id=$1", [childId])).rows,
	).toEqual([]);
	await run(() => operationService.retryTranslation("alice", rootId, randomUUID()));
	expect(await finishBatch(rootId)).toMatchObject({ state: "succeeded", retryable: false });
	expect(
		(
			await database
				.admin()
				.query(
					"SELECT operation_id,kind FROM ai_usage_ledger WHERE operation_id IN (SELECT id FROM ai_operation WHERE parameters->'translationBatch'->>'rootId'=$1) ORDER BY created_at",
					[rootId],
				)
		).rows,
	).toEqual([
		{ operation_id: rootId, kind: "reserve" },
		{ operation_id: rootId, kind: "settle" },
	]);
});

it("keeps all parts within one request reservation under a tight daily cap", async () => {
	const admin = database.admin();
	const budget = () =>
		admin.query("SELECT active,reserved_micros::int,spent_micros::int FROM ai_platform_budget WHERE id='batch-budget'");
	const usageBefore = await run(() => usageService.getStartUsage("alice"));
	const spentBefore = (await budget()).rows[0].spent_micros;
	// Leave room for exactly one 10,000-micro reservation, plus the parts' measured spend.
	await admin.query("UPDATE ai_platform_budget SET cap_micros=spent_micros+10500 WHERE id='batch-budget'");
	try {
		await admin.query("UPDATE ai_platform_budget SET concurrency=1 WHERE id='batch-budget'");
		const { operation } = await start();
		const total = operation.progress?.total ?? 0;
		expect(total).toBeGreaterThan(1);
		expect(operation.progress?.completedParts).toBe(0);
		expect((await budget()).rows).toEqual([{ active: 1, reserved_micros: 10_000, spent_micros: spentBefore }]);
		await runOnePart();
		expect(await run(() => operationService.get("alice", operation.id))).toMatchObject({
			state: "queued",
			failureCode: null,
			progress: { part: 2, activeParts: 1, completedParts: 1, total },
		});
		expect((await budget()).rows).toEqual([{ active: 1, reserved_micros: 0, spent_micros: spentBefore + 20 }]);
		await run(() => runAiOperations());
		expect(await finishBatch(operation.id)).toMatchObject({ state: "succeeded", retryable: false });
		expect((await budget()).rows).toEqual([{ active: 0, reserved_micros: 0, spent_micros: spentBefore + total * 20 }]);
		expect((await run(() => usageService.getStartUsage("alice"))).operations.used).toBe(
			usageBefore.operations.used + 1,
		);
	} finally {
		await admin.query("UPDATE ai_platform_budget SET cap_micros=100000,concurrency=6 WHERE id='batch-budget'");
	}
});

it("pauses at the shared request cap and does not charge rejected admission or preflight at the daily cap", async () => {
	const before = await run(() => usageService.getStartUsage("alice"));
	const admin = database.admin();
	const savedRoutes = runtime.routes;
	runtime.routes = savedRoutes.map((route) => ({ ...route, requestCapMicros: 6666, maxCalls: 2 }));
	stepCostMicros = 3333;
	await admin.query(
		"UPDATE ai_platform_budget SET concurrency=1,request_cap_micros=6666,cap_micros=spent_micros+6666 WHERE id='batch-budget'",
	);
	try {
		const fixture = await start();
		const afterStart = await run(() => usageService.getStartUsage("alice"));
		expect(afterStart.operations).toMatchObject({ used: before.operations.used, reserved: 1 });
		await run(() => runAiOperations());
		const afterExecution = await run(() => usageService.getStartUsage("alice"));
		expect(afterExecution.operations).toMatchObject({ used: before.operations.used + 1, reserved: 0 });
		expect(await run(() => operationService.get("alice", fixture.operation.id))).toMatchObject({
			state: "failed",
			resultId: null,
			retryable: true,
		});
		expect(writers).toBe(1);
		expect(verifiers).toBe(1);
		expect(
			(
				await admin.query(
					"SELECT spent_micros=cap_micros AS at_cap,reserved_micros::int FROM ai_platform_budget WHERE id='batch-budget'",
				)
			).rows,
		).toEqual([{ at_cap: true, reserved_micros: 0 }]);
		expect(
			(
				await admin.query(
					"SELECT COALESCE(sum(actual_micros),0)::int AS total FROM ai_operation WHERE parameters->'translationBatch'->>'rootId'=$1",
					[fixture.operation.id],
				)
			).rows,
		).toEqual([{ total: 6666 }]);
		const freshRequest = { ...fixture.request, requestKey: randomUUID() };
		expect(await run(() => operationService.preflight("alice", freshRequest))).toMatchObject({
			available: false,
			operationCost: 1,
			reason: "AI_BUDGET_LIMIT",
		});
		await expect(run(() => operationService.start("alice", freshRequest))).rejects.toMatchObject({
			data: { reason: "AI_BUDGET_LIMIT" },
		});
		expect((await run(() => usageService.getStartUsage("alice"))).operations).toEqual(afterExecution.operations);
	} finally {
		runtime.routes = savedRoutes;
		await admin.query(
			"UPDATE ai_platform_budget SET cap_micros=100000,request_cap_micros=10000,concurrency=6 WHERE id='batch-budget'",
		);
	}
});

it("retires an old partial review after a copy edit and removes its queued retry from worker discovery", async () => {
	failPart = 2;
	const fixture = await start();
	const id = fixture.operation.id;
	await run(() => runAiOperations());
	expect(await finishBatch(id)).toMatchObject({ retryable: true, resultId: id });
	const admin = database.admin();
	const saved = (await admin.query("SELECT data, updated_at FROM resume WHERE id=$1", [fixture.copy.resumeId])).rows[0];
	const updated = (
		await admin.query(
			`UPDATE resume SET updated_at = updated_at + interval '1 second',
			data = jsonb_set(data, '{basics,headline}', '"Manually edited Arabic copy"')
			WHERE id=$1 RETURNING data, updated_at`,
			[fixture.copy.resumeId],
		)
	).rows[0];
	const deferred = (
		await admin.query(
			`SELECT id FROM ai_operation WHERE parameters->'translationBatch'->>'rootId'=$1
			AND (failure_code IN ('AI_VERIFICATION_FAILED', 'AI_REVIEW_INVALID') OR result ? 'withheld')
			ORDER BY created_at DESC LIMIT 1`,
			[id],
		)
	).rows[0];
	expect(deferred).toBeDefined();
	await admin.query(`UPDATE ai_translation_batch SET execution=$2 WHERE root_operation_id=$1`, [
		id,
		{
			route: fixture.request.route,
			consentVersion: fixture.request.consentVersion,
			retryFailedOperationIds: [deferred.id],
		},
	]);
	expect(await run(discoverAiOwners)).toContain("alice");
	const writerCount = writers;
	try {
		expect(await run(() => operationService.get("alice", id))).toMatchObject({
			state: "failed",
			failureCode: "AI_SOURCE_CHANGED",
			resultId: null,
			retryable: false,
		});
		await run(() => runAiOperations());
		expect(await run(discoverAiOwners)).not.toContain("alice");
		await run(() => runAiOperations());
		expect(writers).toBe(writerCount);
		expect(
			(await admin.query("SELECT failure_code FROM ai_translation_batch WHERE root_operation_id=$1", [id])).rows,
		).toEqual([{ failure_code: "AI_SOURCE_CHANGED" }]);
		expect(
			(await admin.query("SELECT data, updated_at FROM resume WHERE id=$1", [fixture.copy.resumeId])).rows,
		).toEqual([updated]);
	} finally {
		await admin.query("UPDATE resume SET data=$2, updated_at=$3 WHERE id=$1", [
			fixture.copy.resumeId,
			saved.data,
			saved.updated_at,
		]);
	}
});

it("withholds a batch after its source changes and prevents retry or partial application", async () => {
	const fixture = await start();
	await runOnePart();
	expect(writers).toBe(1);
	await database
		.admin()
		.query("UPDATE resume SET updated_at=updated_at + interval '1 second' WHERE id=$1", [fixture.source]);
	await run(() => runAiOperations());
	expect(await run(() => operationService.get("alice", fixture.operation.id))).toMatchObject({
		state: "failed",
		failureCode: "AI_SOURCE_CHANGED",
		retryable: false,
		resultId: null,
		progress: { part: 2, total: fixture.operation.progress?.total },
	});
	await run(() => reconcileExpiredAccounting("alice"));
	expect(await run(discoverAiOwners)).not.toContain("alice");
	const partCount = async () =>
		(
			await database
				.admin()
				.query("SELECT count(*)::int n FROM ai_operation WHERE parameters->'translationBatch'->>'rootId'=$1", [
					fixture.operation.id,
				])
		).rows[0].n;
	const beforeRetry = await partCount();
	await expect(
		run(() => operationService.retryTranslation("alice", fixture.operation.id, randomUUID())),
	).rejects.toMatchObject({ code: "CONFLICT", data: { reason: "AI_SOURCE_CHANGED" } });
	expect(await partCount()).toBe(beforeRetry);
	expect(writers).toBe(1);
	await expect(run(() => operationService.getResult("alice", fixture.operation.id))).rejects.toMatchObject({
		code: "PRECONDITION_FAILED",
	});
	await expect(run(() => getVariantReview("alice", fixture.operation.id))).rejects.toMatchObject({
		code: "PRECONDITION_FAILED",
	});
	await expect(
		run(() =>
			decideVariantReview("alice", {
				operationId: fixture.operation.id,
				requestKey: randomUUID(),
				expectedUpdatedAt: fixture.copy.updatedAt,
				expectedDecisionId: null,
				subjectIds: ["translation"],
				decision: "accept",
			}),
		),
	).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });
	expect(
		(await database.admin().query("SELECT data,updated_at FROM resume WHERE id=$1", [fixture.copy.resumeId])).rows[0],
	).toMatchObject({ data: fixture.data, updated_at: new Date(fixture.copy.updatedAt) });
	expect((await run(() => usageService.getStartUsage("alice"))).operations.reserved).toBe(0);
});

it("cancels the running later part without changing the verified root or exposing a partial review", async () => {
	const before = await run(() => usageService.getStartUsage("alice"));
	const fixture = await start();
	await runOnePart();
	const rootBefore = (
		await database
			.admin()
			.query("SELECT state,result,delivered_at FROM ai_operation WHERE id=$1", [fixture.operation.id])
	).rows[0];
	expect(rootBefore.state).toBe("waiting_review");
	let cancelledChildId: string | undefined;
	beforeWriterResponse = async () => {
		const child = (
			await database
				.admin()
				.query("SELECT id FROM ai_operation WHERE parameters->'translationBatch'->>'rootId'=$1 AND state='running'", [
					fixture.operation.id,
				])
		).rows[0];
		cancelledChildId = child.id;
		expect(await run(() => operationService.cancel("alice", fixture.operation.id))).toMatchObject({
			state: "cancel_requested",
		});
		expect((await database.admin().query("SELECT state FROM ai_operation WHERE id=$1", [child.id])).rows[0].state).toBe(
			"cancel_requested",
		);
	};
	await runOnePart();
	expect(cancelledChildId).toBeDefined();
	expect(await run(() => operationService.get("alice", fixture.operation.id))).toMatchObject({
		state: "cancelled",
		resultId: null,
		failureCode: "AI_CANCELLED",
		progress: { part: 2, total: fixture.operation.progress?.total },
	});
	expect(
		(await database.admin().query("SELECT state FROM ai_operation WHERE id=$1", [cancelledChildId])).rows[0].state,
	).toBe("cancelled");
	expect(
		(
			await database
				.admin()
				.query("SELECT state,result,delivered_at FROM ai_operation WHERE id=$1", [fixture.operation.id])
		).rows[0],
	).toEqual(rootBefore);
	await expect(run(() => getVariantReview("alice", fixture.operation.id))).rejects.toMatchObject({
		code: "PRECONDITION_FAILED",
	});
	await expect(run(() => operationService.getResult("alice", fixture.operation.id))).rejects.toMatchObject({
		code: "PRECONDITION_FAILED",
	});
	await expect(
		run(() =>
			decideVariantReview("alice", {
				operationId: fixture.operation.id,
				requestKey: randomUUID(),
				expectedUpdatedAt: fixture.copy.updatedAt,
				expectedDecisionId: null,
				subjectIds: ["translation"],
				decision: "accept",
			}),
		),
	).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });
	const after = await run(() => usageService.getStartUsage("alice"));
	expect(after.operations.used - before.operations.used).toBe(1);
	expect(after.operations.reserved).toBe(0);
	expect(writers).toBe(2);
	expect(verifiers).toBe(1);
	expect(
		(await database.admin().query("SELECT data,updated_at FROM resume WHERE id=$1", [fixture.copy.resumeId])).rows[0],
	).toMatchObject({ data: fixture.data, updated_at: new Date(fixture.copy.updatedAt) });
});

it("keeps reporting progress while other parts run after one part fails factual checks, then partially applies", async () => {
	const transport = runtime.fetch;
	try {
		const f = await start();
		const total = f.operation.progress?.total ?? 0;
		expect(total).toBeGreaterThanOrEqual(3);
		// Make part 0 fail deterministically with TRANSLATION_UNCOVERED_TEXT on both generate and regenerate.
		runtime.fetch = async (url, init) => {
			const body = JSON.parse(String(init?.body));
			const payload = JSON.parse(body.messages.at(-1).content);
			const verifier = payload.selections.some((entry: { id: string }) => entry.id === "variant-verification-task");
			if (!verifier) {
				const cv = JSON.parse(
					payload.selections.find((entry: { id: string }) => entry.id === "variant-cv-evidence").text,
				);
				if (cv[0]?.id === plannedEvidenceIds[0]) {
					const task = JSON.parse(payload.selections.find((entry: { id: string }) => entry.id === "variant-task").text);
					return Response.json({
						id: "synthetic-uncovered",
						model: body.model,
						provider: body.provider.only[0],
						choices: [
							{
								index: 0,
								message: {
									role: "assistant",
									content: JSON.stringify({
										direction: task.direction,
										sourceRevision: task.sourceRevision,
										segments: cv.map((fact: { id: string; text: string }) => ({
											sourceId: fact.id,
											text: fact.text,
											claims: [
												{ id: "claim", text: `${fact.text} mismatch`, evidenceIds: [fact.id], kind: "translation" },
											],
										})),
										notes: [],
									}),
								},
								finish_reason: "stop",
							},
						],
						usage: { prompt_tokens: 5, completion_tokens: 5, total_tokens: 10, cost: 0.00001 },
					});
				}
			}
			return transport(url, init);
		};
		// Run ONLY part 0 while parts 1..N-1 are still queued.
		await runOnePart();
		const midRun = await run(() => operationService.get("alice", f.operation.id));
		// Must NOT flash state="failed" / "Nothing was applied" while other parts are still active.
		expect(midRun.state).not.toBe("failed");
		expect(midRun.failureCode).toBeNull();
		// Now let the remaining parts finish.
		await run(() => runAiOperations());
		const after = await run(() => operationService.get("alice", f.operation.id));
		expect(after).toMatchObject({ state: "succeeded", resultId: f.operation.id, retryable: true });
	} finally {
		runtime.fetch = transport;
	}
});

it("prepares a single source paragraph above the former 128000-character payload limit as bounded parts", async () => {
	if (!sourceId || !languageCopyId) throw new Error("Missing reusable translation fixture");
	const source = sourceId;
	const copy = languageCopyId;
	const data = structuredClone(defaultResumeData);
	const paragraph = "Confirmed React experience. ".repeat(6000);
	expect(paragraph.length).toBeGreaterThan(128000);
	data.summary.hidden = false;
	data.summary.content = `<p>${paragraph}</p>`;
	data.metadata.layout.pages = [{ fullWidth: false, main: ["summary"], sidebar: [] }];
	await database
		.admin()
		.query("UPDATE resume SET data=$1,updated_at=now() WHERE id=ANY($2::text[])", [
			JSON.stringify(data),
			[source, copy],
		]);
	const rows = (
		await database.admin().query("SELECT id,updated_at FROM resume WHERE id=ANY($1::text[])", [[source, copy]])
	).rows;
	const sourceRevision = rows.find((row) => row.id === source)?.updated_at.toISOString() as string;
	const copyRevision = rows.find((row) => row.id === copy)?.updated_at.toISOString() as string;
	const prepared = await run(() =>
		prepareVariantReview("alice", {
			kind: "review.translation",
			resumeId: copy,
			expectedUpdatedAt: copyRevision,
			expectedSourceRevision: sourceRevision,
		}),
	);
	expect(prepared.evidenceIds.length).toBeGreaterThan(0);
	using plan = vi.spyOn(translationBatches, "planTranslationBatches");
	const preflight = await run(() =>
		operationService.preflight("alice", {
			kind: prepared.kind,
			parameters: prepared.parameters,
			sources: prepared.sources,
			requestKey: randomUUID(),
			route: { routeId: "synthetic", routeRevision: "1", configRevision: "1" },
			consentVersion: "1",
		}),
	);
	expect(plan).toHaveBeenCalledTimes(1);
	expect(preflight).toMatchObject({ available: true, operationCost: 1 });
	expect(preflight.translationParts).toBeGreaterThan(3);
	expect(preflight.operationCost).toBe(1);
	expect(writers).toBe(0);
	expect(verifiers).toBe(0);
});

it.each(["reject", "undo and reject", "accept"] as const)(
	"preserves an unrelated segment after %s and retry of a withheld part",
	async (action) => {
		reviewDecisionFixture = true;
		failPart = 2;
		// A legacy unresolved local value leaves the comparison open before any auto-apply.
		const fixture = await start(4, 18, action !== "undo and reject");
		const operationId = fixture.operation.id;
		const read = () => run(() => getVariantReview("alice", operationId));
		await finishBatch(operationId);
		const initial = await read();
		const first = initial.sourceSegments[0];
		if (!first) throw new Error("Expected a segment in the first translation part");
		expect(initial.result.withheld?.items?.map(({ partIndex }) => partIndex)).toContain(1);
		const decide = async (subjectIds: string[], decision: "accept" | "reject" | "undo", undoDecisionId?: string) => {
			const view = await read();
			return run(() =>
				decideVariantReview("alice", {
					operationId,
					requestKey: randomUUID(),
					expectedUpdatedAt: view.updatedAt,
					expectedDecisionId: view.latestDecisionId,
					subjectIds,
					decision,
					...(undoDecisionId ? { undoDecisionId } : {}),
				}),
			);
		};
		if (action === "undo and reject") {
			const applied = initial.undoable.at(-1);
			if (!applied) throw new Error("Expected an auto-apply to undo");
			await decide(applied.subjectIds, "undo", applied.decisionId);
		}
		const decision = action === "accept" ? "accept" : "reject";
		const expectedStatus = decision === "accept" ? "accepted" : "rejected";
		await decide([first.id], decision);
		const before = await read();
		expect(before.statuses[first.id]).toBe(expectedStatus);
		expect(before.statuses.translation).toBe("pending");
		const withheld = before.result.withheld?.items ?? [];
		const retriedIds = new Set(withheld.filter(({ partIndex }) => partIndex === 1).map(({ id }) => id));
		expect(retriedIds.size).toBeGreaterThan(0);
		expect(retriedIds.has(first.id)).toBe(false);
		const saved = async () =>
			(
				await database
					.admin()
					.query<{ data: typeof fixture.data }>("SELECT data FROM resume WHERE id=$1", [fixture.copy.resumeId])
			).rows[0]?.data;
		const beforeParagraphs = (await saved())?.summary.content.match(/<p>[^<]*<\/p>/gu);
		expect(beforeParagraphs).toHaveLength(initial.sourceSegments.length);
		const beforeRetry = writers;
		failPart = 0;
		await run(() => operationService.retryTranslation("alice", operationId, randomUUID(), undefined, { partIndex: 1 }));
		await finishBatch(operationId);
		const after = await read();
		expect(writers - beforeRetry).toBe(1);
		expect(after.result.withheld).toBeUndefined();
		expect(after.statuses.translation).toBe("pending");
		expect(after.statuses[first.id]).toBe(expectedStatus);
		for (const [id, segment] of Object.entries(before.segments)) {
			expect(after.segments[id]).toEqual(segment);
			expect(after.statuses[id]).toBe(before.statuses[id]);
		}
		const afterParagraphs = (await saved())?.summary.content.match(/<p>[^<]*<\/p>/gu);
		expect(afterParagraphs).toHaveLength(beforeParagraphs?.length ?? 0);
		for (const [index, segment] of initial.sourceSegments.entries()) {
			if (retriedIds.has(segment.id)) {
				expect(after.statuses[segment.id]).toBe("accepted");
				expect(afterParagraphs?.[index]).toContain("استخدمت React في عمل مهني موثق رقم");
			} else expect(afterParagraphs?.[index]).toBe(beforeParagraphs?.[index]);
		}
		if (action === "undo and reject") {
			const appliedRetry = after.undoable.at(-1);
			if (!appliedRetry) throw new Error("Expected the recovered part to be undoable");
			expect(new Set(appliedRetry.subjectIds)).toEqual(retriedIds);
			await decide(appliedRetry.subjectIds, "undo", appliedRetry.decisionId);
			const undoneRetry = await read();
			expect(undoneRetry.statuses[first.id]).toBe("rejected");
			for (const id of retriedIds) expect(undoneRetry.statuses[id]).toBe("pending");
			expect((await saved())?.summary.content.match(/<p>[^<]*<\/p>/gu)).toEqual(beforeParagraphs);
		}
	},
);

it("withholds changed facts and retries only the selected segment before explicit approval", async () => {
	const originalHandlers = runtime.handlers;
	const originalFetch = runtime.fetch;
	const savedResumes = (
		await database.admin().query("SELECT id,data,updated_at FROM resume WHERE id=ANY($1)", [[sourceId, languageCopyId]])
	).rows;
	const requests: string[][] = [];
	let repairing = false;
	const goodText = "وثقت أعمال React رقم";
	runtime.handlers = { ...originalHandlers, "review.translation": createTranslationCandidateHandler() };
	runtime.fetch = async (_url, init) => {
		const body = JSON.parse(String(init?.body));
		const selection = JSON.parse(body.messages.at(-1).content).selections[0];
		expect(selection.id).toBe("translation-source");
		const task = JSON.parse(selection.text);
		const segments = task.segments as Array<{ id: string; text: string }>;
		requests.push(segments.map(({ id }) => id));
		const output = {
			direction: task.direction,
			sourceRevision: task.sourceRevision,
			segments: segments.map(({ id, text }) => ({
				sourceId: id,
				text: text.replaceAll(
					/Used React for confirmed career work number (\d+)/gu,
					(_match, number) => goodText + " " + (!repairing && ["0", "1"].includes(number) ? "88" : number),
				),
			})),
		};
		return Response.json({
			id: "synthetic-writer-only",
			model: body.model,
			provider: body.provider.only[0],
			choices: [{ index: 0, message: { role: "assistant", content: JSON.stringify(output) }, finish_reason: "stop" }],
			usage: { prompt_tokens: 5, completion_tokens: 5, total_tokens: 10, cost: 0.00001 },
		});
	};
	try {
		const fixture = await start(3, 18, false, true);
		const id = fixture.operation.id;
		const stored = async () =>
			(await database.admin().query("SELECT data,updated_at FROM resume WHERE id=$1", [fixture.copy.resumeId])).rows[0];
		expect(await finishBatch(id)).toMatchObject({ state: "waiting_review", retryable: true });
		expect((await stored()).updated_at.toISOString()).toBe(fixture.copy.updatedAt);
		const read = () => run(() => getVariantReview("alice", id));
		const first = await read();
		const [gap, otherGap] = first.result.withheld?.items ?? [];
		if (gap?.partIndex === undefined || otherGap?.partIndex === undefined)
			throw new Error("Missing deterministic gaps");
		expect(first.stale).toBe(false);
		expect(gap.reason).toBe("TRANSLATION_FACT_NUMBER:0");
		expect(first.segments[gap.id]).toBeUndefined();
		const decide = (view: typeof first, subjectIds: string[]) =>
			run(() =>
				decideVariantReview("alice", {
					operationId: id,
					requestKey: randomUUID(),
					expectedUpdatedAt: view.updatedAt,
					expectedDecisionId: view.latestDecisionId,
					subjectIds,
					decision: "accept",
				}),
			);
		await expect(decide(first, ["translation"])).rejects.toMatchObject({
			data: { reason: "TRANSLATION_REVIEW_INCOMPLETE" },
		});

		const beforeRetry = requests.length;
		repairing = true;
		const retryKey = randomUUID();
		const scope = { partIndex: gap.partIndex, segmentId: gap.id };
		await run(() => operationService.retryTranslation("alice", id, retryKey, undefined, scope));
		expect(await finishBatch(id)).toMatchObject({ state: "waiting_review", retryable: true });
		expect(requests.slice(beforeRetry)).toEqual([[plannedEvidenceIds[gap.partIndex]]]);
		const after = await read();
		expect(after.result.withheld?.items).toEqual([otherGap]);
		expect(after.segments[gap.id]?.text).toContain(goodText + " 0");
		expect((await stored()).updated_at.toISOString()).toBe(fixture.copy.updatedAt);
		await run(() => operationService.retryTranslation("alice", id, retryKey, undefined, scope));
		expect(requests.slice(beforeRetry)).toEqual([[plannedEvidenceIds[gap.partIndex]]]);

		if (after.terms.terms.length)
			await decide(
				after,
				after.terms.terms.map(({ id }) => id),
			);
		const confirmed = await read();
		await decide(confirmed, Object.keys(confirmed.segments));
		await decide(await read(), ["translation"]);
		const saved = await stored();
		expect(saved.data.summary.content).toContain(goodText + " 0");
		expect(saved.data.summary.content).toContain("Used React for confirmed career work number 1.");
		expect(saved.data.summary.content).not.toContain("88");
		expect(saved.data.sections.experience.items[0].description).toBe(`<p>${goodText} 99.</p>`);
		const { partIndex: remainingPartIndex } = otherGap;
		await run(() =>
			operationService.retryTranslation("alice", id, randomUUID(), undefined, {
				partIndex: remainingPartIndex,
				segmentId: otherGap.id,
			}),
		);
		expect(await finishBatch(id)).toMatchObject({ state: "waiting_review", retryable: false });
		const recovered = await read();
		expect(recovered.statuses).toMatchObject({ translation: "pending", [otherGap.id]: "pending" });
		expect((await stored()).data).toEqual(saved.data);
		await decide(recovered, [otherGap.id]);
		await decide(await read(), ["translation"]);
		expect((await stored()).data.summary.content).toContain(goodText + " 1");

		expect(
			(await database.admin().query("SELECT kind FROM ai_usage_ledger WHERE operation_id=$1 AND kind='settle'", [id]))
				.rows,
		).toHaveLength(1);
		expect(
			(
				await database.admin().query("SELECT updated_at FROM resume WHERE id=$1", [fixture.source])
			).rows[0].updated_at.toISOString(),
		).toBe(fixture.revision);
	} finally {
		runtime.handlers = originalHandlers;
		runtime.fetch = originalFetch;
		for (const saved of savedResumes)
			await database
				.admin()
				.query("UPDATE resume SET data=$2,updated_at=$3 WHERE id=$1", [saved.id, saved.data, saved.updated_at]);
	}
}, 15_000);
