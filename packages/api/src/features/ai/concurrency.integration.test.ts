import type { OperationRequest, SourceRevision } from "@reactive-resume/schema/ai-operation";
import { randomUUID } from "node:crypto";
import { afterEach, beforeAll, describe, expect, it, vi } from "vite-plus/test";
import { operationService, claimNextOperation, deliverOperation, failOperation } from "./operations";
import { createImportReviewSource } from "./review-sources";
import { withAiRuntime } from "./route-policy";
import { aiTestDatabase } from "./testing/database";
import { syntheticRuntime } from "./testing/runtime";
import { usageService } from "./usage";

vi.mock("@reactive-resume/env/server", async (importOriginal) => {
	const actual = await importOriginal<typeof import("@reactive-resume/env/server")>();
	return { ...actual, env: { ...actual.env, ADMIN_EMAILS: ["admin@example.test"] } };
});

describe.skipIf(!process.env.COVER_LETTER_TEST_DATABASE_URL)("atomic AI concurrency", () => {
	const database = aiTestDatabase();
	const run = <T>(work: () => T) => database.run(() => withAiRuntime(syntheticRuntime, work));
	let currentOwner: string;
	beforeAll(async () => {
		await database
			.admin()
			.query(
				"INSERT INTO ai_platform_budget(id,route_id,route_revision,window_date,cap_micros,request_cap_micros,concurrency) VALUES ('budget','synthetic','1',(now() AT TIME ZONE 'UTC')::date,100000,10000,100)",
			);
	});
	afterEach(async () => {
		if (!currentOwner) return;
		const active = await database
			.admin()
			.query("SELECT id FROM ai_operation WHERE user_id=$1 AND state='queued'", [currentOwner]);
		for (const row of active.rows) await run(() => operationService.cancel(currentOwner, row.id));
	});
	async function fixture(admin = false) {
		const owner = randomUUID();
		currentOwner = owner;
		const email = admin ? "admin@example.test" : `${owner}@example.test`;
		await database
			.admin()
			.query('INSERT INTO "user"(id,name,email,username,display_username,email_verified) VALUES ($1,$1,$2,$1,$1,$3)', [
				owner,
				email,
				admin,
			]);
		await database
			.admin()
			.query(
				"INSERT INTO ai_processing_consent(id,user_id,route_id,route_revision,notice_version,purpose,config_revision) VALUES ($1,$1,'synthetic','1','1','review','1')",
				[owner],
			);
		const sources: SourceRevision[] = [];
		for (let i = 0; i < 4; i++) {
			const id = randomUUID();
			const row = await database
				.admin()
				.query(
					"INSERT INTO resume(id,user_id,name,slug,data) VALUES ($1,$2,'Synthetic',$1,'{}') RETURNING updated_at",
					[id, owner],
				);
			sources.push({ kind: "resume", id, revision: row.rows[0].updated_at.toISOString() });
		}
		const request = (source: SourceRevision): OperationRequest => ({
			requestKey: randomUUID(),
			kind: "review",
			sources: [source],
			parameters: {},
			route: { routeId: "synthetic", routeRevision: "1", configRevision: "1" },
			consentVersion: "1",
		});
		const [first, second, third, fourth] = sources.map(request);
		if (!first || !second || !third || !fourth) throw new Error("Missing fixture CV");
		return { owner, requests: [first, second, third, fourth] as const, request };
	}
	async function accounting(owner: string) {
		return {
			usage: await run(() => usageService.getStartUsage(owner)),
			operations: (
				await database
					.admin()
					.query("SELECT id,state,reserved_micros,budget_id FROM ai_operation WHERE user_id=$1 ORDER BY id", [owner])
			).rows,
			ledger: (
				await database
					.admin()
					.query("SELECT operation_id,kind FROM ai_usage_ledger WHERE user_id=$1 ORDER BY id", [owner])
			).rows,
			budgets: (
				await database.admin().query("SELECT active,reserved_micros,spent_micros FROM ai_platform_budget ORDER BY id")
			).rows,
		};
	}
	it.each([false, true])(
		"admits exactly three racing CVs and denies a fourth without accounting effects (admin=%s)",
		async (admin) => {
			const f = await fixture(admin);
			const results = await run(() =>
				Promise.allSettled(f.requests.map((request) => operationService.start(f.owner, request))),
			);
			expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(3);
			const denied = results.findIndex((result) => result.status === "rejected");
			const deniedRequest = f.requests[denied];
			if (!deniedRequest) throw new Error("Expected a denied request");
			expect(results[denied]).toMatchObject({
				status: "rejected",
				reason: {
					data: { reason: "AI_CONCURRENCY_LIMIT", allowance: { limit: 3, used: 0, reserved: 3, remaining: 0 } },
				},
			});
			const before = await accounting(f.owner);
			expect(before.usage.operations).toEqual({
				limit: admin ? null : 5,
				used: 0,
				reserved: 3,
				remaining: admin ? null : 2,
			});
			expect(await run(() => operationService.preflight(f.owner, deniedRequest))).toMatchObject({
				available: false,
				reason: "AI_CONCURRENCY_LIMIT",
				allowance: { limit: 3, used: 0, reserved: 3, remaining: 0 },
			});
			await expect(run(() => operationService.start(f.owner, deniedRequest))).rejects.toMatchObject({
				data: { reason: "AI_CONCURRENCY_LIMIT" },
			});
			expect(await accounting(f.owner)).toEqual(before);
			for (const result of results)
				if (result.status === "fulfilled") await run(() => operationService.cancel(f.owner, result.value.id));
		},
	);
	it("admits only one racing request for a CV and preserves the draft and accounting on denial", async () => {
		const f = await fixture();
		const request = f.requests[0];
		const results = await run(() =>
			Promise.allSettled([
				operationService.start(f.owner, request),
				operationService.start(f.owner, { ...request, requestKey: randomUUID() }),
			]),
		);
		expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
		expect(results.find((result) => result.status === "rejected")).toMatchObject({
			reason: { data: { reason: "AI_TARGET_BUSY" } },
		});
		const before = await accounting(f.owner);
		const draft = (
			await database.admin().query("SELECT data,updated_at FROM resume WHERE id=$1", [request.sources[0]?.id])
		).rows;
		expect(
			await run(() => operationService.preflight(f.owner, { ...request, requestKey: randomUUID() })),
		).toMatchObject({ available: false, reason: "AI_TARGET_BUSY" });
		await expect(
			run(() => operationService.start(f.owner, { ...request, requestKey: randomUUID() })),
		).rejects.toMatchObject({ data: { reason: "AI_TARGET_BUSY" } });
		expect(await accounting(f.owner)).toEqual(before);
		expect(
			(await database.admin().query("SELECT data,updated_at FROM resume WHERE id=$1", [request.sources[0]?.id])).rows,
		).toEqual(draft);
	});
	it.each(["cover-letter", "import"] as const)("locks the same %s while admitting another target", async (kind) => {
		const f = await fixture();
		const targets: SourceRevision[] = [];
		for (let i = 0; i < 2; i++) {
			if (kind === "import") {
				const created = await run(() =>
					createImportReviewSource(f.owner, {
						flowId: randomUUID(),
						section: "summary",
						text: "Synthetic TypeScript skills",
						partial: false,
						contactValues: [],
					}),
				);
				targets.push(created.source);
			} else {
				const id = randomUUID();
				await database
					.admin()
					.query("INSERT INTO cover_letter(id,user_id,name,style) VALUES ($1,$2,'Synthetic','{}')", [id, f.owner]);
				targets.push({ kind, id, revision: "1" });
			}
		}
		const [firstTarget, secondTarget] = targets;
		if (!firstTarget || !secondTarget) throw new Error("Missing fixture targets");
		const first = { ...f.request(firstTarget), sources: [...f.requests[0].sources, firstTarget] };
		await run(() => operationService.start(f.owner, first));
		const before = await accounting(f.owner);
		await expect(
			run(() => operationService.start(f.owner, { ...first, requestKey: randomUUID() })),
		).rejects.toMatchObject({ data: { reason: "AI_TARGET_BUSY" } });
		expect(await accounting(f.owner)).toEqual(before);
		await expect(
			run(() =>
				operationService.start(f.owner, {
					...f.request(secondTarget),
					sources: [...f.requests[0].sources, secondTarget],
				}),
			),
		).resolves.toMatchObject({ state: "queued" });
	});
	it("denies a second staged selection from the same import flow without reserving usage", async () => {
		const f = await fixture();
		const flowId = randomUUID();
		const stage = (flowId: string, text: string) =>
			run(() =>
				createImportReviewSource(f.owner, { flowId, section: "summary", text, partial: false, contactValues: [] }),
			);
		const first = await stage(flowId, "Synthetic TypeScript skills");
		const second = await stage(flowId, "Synthetic Python skills");
		const other = await stage(randomUUID(), "Synthetic TypeScript skills");
		expect(second.source.id).not.toBe(first.source.id);
		await run(() => operationService.start(f.owner, f.request(first.source)));
		const before = await accounting(f.owner);
		await expect(run(() => operationService.start(f.owner, f.request(second.source)))).rejects.toMatchObject({
			data: { reason: "AI_TARGET_BUSY" },
		});
		expect(await accounting(f.owner)).toEqual(before);
		await expect(run(() => operationService.start(f.owner, f.request(other.source)))).resolves.toMatchObject({
			state: "queued",
		});
	});
	it("holds account and target capacity until running cancellation finishes", async () => {
		const f = await fixture();
		await run(() => Promise.all(f.requests.slice(0, 3).map((request) => operationService.start(f.owner, request))));
		const lease = await run(() => claimNextOperation(f.owner));
		if (!lease) throw new Error("Missing lease");
		expect(await run(() => operationService.cancel(f.owner, lease.operationId))).toMatchObject({
			state: "cancel_requested",
		});
		const row = (await database.admin().query("SELECT sources FROM ai_operation WHERE id=$1", [lease.operationId]))
			.rows[0];
		const before = await accounting(f.owner);
		await expect(run(() => operationService.start(f.owner, f.requests[3]))).rejects.toMatchObject({
			data: { reason: "AI_CONCURRENCY_LIMIT" },
		});
		await expect(run(() => operationService.start(f.owner, f.request(row.sources[0])))).rejects.toMatchObject({
			data: { reason: "AI_TARGET_BUSY" },
		});
		expect(await accounting(f.owner)).toEqual(before);
		await run(() => failOperation(lease, "AI_CANCELLED"));
		await expect(run(() => operationService.start(f.owner, f.request(row.sources[0])))).resolves.toMatchObject({
			state: "queued",
		});
	});
	it.each(["completion", "failure", "cancellation"])(
		"releases target and account capacity after %s with existing settlement rules",
		async (outcome) => {
			const f = await fixture();
			const operations = await run(() =>
				Promise.all(f.requests.slice(0, 3).map((request) => operationService.start(f.owner, request))),
			);
			const first = operations[0];
			if (!first) throw new Error("Missing admitted operation");
			if (outcome === "cancellation") await run(() => operationService.cancel(f.owner, first.id));
			else {
				const lease = await run(() => claimNextOperation(f.owner));
				if (!lease) throw new Error("Missing lease");
				if (outcome === "completion") await run(() => deliverOperation(lease, { text: "Synthetic review" }));
				else await run(() => failOperation(lease, "AI_DEADLINE"));
			}
			const terminal = (
				await database
					.admin()
					.query(
						"SELECT sources FROM ai_operation WHERE user_id=$1 AND state NOT IN ('queued','running','cancel_requested')",
						[f.owner],
					)
			).rows[0];
			expect((await run(() => usageService.getStartUsage(f.owner))).operations).toEqual({
				limit: 5,
				used: outcome === "completion" ? 1 : 0,
				reserved: 2,
				remaining: outcome === "completion" ? 2 : 3,
			});
			await expect(run(() => operationService.start(f.owner, f.request(terminal.sources[0])))).resolves.toMatchObject({
				state: "queued",
			});
		},
	);
});
