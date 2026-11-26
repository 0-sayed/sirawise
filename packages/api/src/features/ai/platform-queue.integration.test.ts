import { beforeAll, describe, expect, it, vi } from "vite-plus/test";
import { executeLease, runAiOperations } from "./operation-worker";
import { claimNextOperation, operationService } from "./operations";
import { withAiRuntime } from "./route-policy";
import { aiTestDatabase } from "./testing/database";
import { syntheticRoute, syntheticRuntime } from "./testing/runtime";
import { usageService } from "./usage";

describe.skipIf(!process.env.COVER_LETTER_TEST_DATABASE_URL)("AI platform queue", () => {
	const database = aiTestDatabase();
	const runtime = { ...syntheticRuntime, routes: [{ ...syntheticRoute, dayCapMicros: 1_000_000 }] };
	const run = <T>(work: () => T) => database.run(() => withAiRuntime(runtime, work));
	const setCapacity = (max: number) =>
		database.admin().query("UPDATE ai_platform_capacity SET max_running=$1 WHERE singleton", [max]);

	beforeAll(async () => {
		await database.admin().query(`
			INSERT INTO ai_platform_budget(id,route_id,route_revision,window_date,cap_micros,request_cap_micros,concurrency)
			VALUES ('queue-budget','synthetic','1',(now() AT TIME ZONE 'UTC')::date,1000000,10000,6)
		`);
	});

	async function fixture(owner: string, target: string) {
		const admin = database.admin();
		await admin.query(
			`INSERT INTO "user"(id,name,email,username,display_username)
			VALUES ($1,$1,$1 || '@example.test',$1,$1) ON CONFLICT DO NOTHING`,
			[owner],
		);
		const {
			rows: [row],
		} = await admin.query<{ updated_at: Date }>(
			"INSERT INTO resume(id,user_id,name,slug,data) VALUES ($1,$2,$1,$1,'{}') RETURNING updated_at",
			[target, owner],
		);
		await admin.query(
			"INSERT INTO ai_processing_consent(id,user_id,route_id,route_revision,notice_version,purpose,config_revision) VALUES ($1,$1,'synthetic','1','1','review','1') ON CONFLICT DO NOTHING",
			[owner],
		);
		if (!row) throw new Error("Missing synthetic CV");
		return () =>
			run(() =>
				operationService.start(owner, {
					requestKey: target,
					kind: "review",
					sources: [{ kind: "resume", id: target, revision: row.updated_at.toISOString() }],
					route: { routeId: "synthetic", routeRevision: "1", configRevision: "1" },
					consentVersion: "1",
					parameters: {},
				}),
			);
	}

	it("starts older requests across accounts after a slot frees and a worker restarts", async () => {
		await setCapacity(1);
		const first = await (await fixture("alice", "first"))();
		const lease = await run(() => claimNextOperation("alice"));
		if (!lease) throw new Error("Missing active lease");
		expect(lease.operationId).toBe(first.id);
		const second = await (await fixture("bob", "second"))();
		const third = await (await fixture("alice", "third"))();
		expect(second.state).toBe("queued");
		expect(third.state).toBe("queued");
		expect(await run(() => operationService.get("bob", second.id))).toMatchObject({ queuePosition: 1 });
		expect(await run(() => operationService.get("alice", third.id))).toMatchObject({ queuePosition: 2 });
		expect(await run(() => claimNextOperation("bob"))).toBeNull();
		await run(() => executeLease(lease));
		expect(await run(() => claimNextOperation("alice"))).toBeNull();
		await run(() => Promise.all([runAiOperations(), runAiOperations()]));
		const { rows } = await database
			.admin()
			.query("SELECT id, state FROM ai_operation WHERE id=ANY($1) ORDER BY execution_started_at", [
				[first.id, second.id, third.id],
			]);
		expect(rows).toEqual([first, second, third].map(({ id }) => ({ id, state: "waiting_review" })));
	});

	it("expires and cancels queued work without a provider attempt or charge", async () => {
		await setCapacity(1);
		const running = await (await fixture("running-owner", "running-cv"))();
		const lease = await run(() => claimNextOperation("running-owner"));
		if (!lease) throw new Error("Missing active lease");
		expect(lease.operationId).toBe(running.id);
		const expiring = await (await fixture("expiring-owner", "expiring-cv"))();
		const cancelled = await (await fixture("cancel-owner", "cancel-cv"))();
		const admin = database.admin();
		expect(
			(
				await admin.query(
					"SELECT extract(epoch FROM queue_expires_at-created_at)::int AS ttl FROM ai_operation WHERE id=$1",
					[expiring.id],
				)
			).rows,
		).toEqual([{ ttl: 300 }]);
		const client = await admin.connect();
		try {
			await client.query("BEGIN");
			await client.query("SET LOCAL session_replication_role = replica");
			await client.query("UPDATE ai_operation SET queue_expires_at=now()-interval '1 second' WHERE id=$1", [
				expiring.id,
			]);
			await client.query("COMMIT");
		} finally {
			await client.query("ROLLBACK");
			client.release();
		}
		expect(await run(() => claimNextOperation("expiring-owner"))).toBeNull();
		expect(await run(() => operationService.get("expiring-owner", expiring.id))).toMatchObject({
			state: "failed",
			failureCode: "AI_QUEUE_EXPIRED",
		});
		expect(await run(() => operationService.cancel("cancel-owner", cancelled.id))).toMatchObject({
			state: "cancelled",
		});
		for (const owner of ["expiring-owner", "cancel-owner"])
			expect((await run(() => usageService.getStartUsage(owner))).operations).toMatchObject({ used: 0, reserved: 0 });
		expect(
			(
				await admin.query("SELECT id FROM ai_operation_attempt WHERE operation_id=ANY($1)", [
					[expiring.id, cancelled.id],
				])
			).rows,
		).toEqual([]);
		await run(() => executeLease(lease));
	});

	it("completes 31 concurrent requests from 11 accounts with a peak of 30", async () => {
		await setCapacity(30);
		const requests = await Promise.all(
			Array.from({ length: 31 }, (_, i) => fixture(`load-owner-${Math.floor(i / 3)}`, `load-cv-${i}`)),
		);
		const starts = await Promise.all(requests.map((start) => start()));
		expect(starts.map(({ state }) => state)).toEqual(Array.from({ length: 31 }, () => "queued"));
		const gate = Promise.withResolvers<void>();
		let calls = 0;
		const ids = starts.map(({ id }) => id);
		const fetch = syntheticRuntime.fetch;
		if (!fetch) throw new Error("Missing synthetic transport");
		const worker = database.run(() =>
			withAiRuntime(
				{
					...runtime,
					fetch: async (...args) => {
						calls++;
						await gate.promise;
						return fetch(...args);
					},
				},
				() => Promise.all([runAiOperations(), runAiOperations()]),
			),
		);
		try {
			await vi.waitFor(
				async () => {
					const { rows } = await database
						.admin()
						.query("SELECT count(*)::int AS running FROM ai_operation WHERE id=ANY($1) AND state='running'", [ids]);
					expect(rows).toEqual([{ running: 30 }]);
					expect(calls).toBeGreaterThan(0);
				},
				{ timeout: 15_000 },
			);
			expect(
				(await database.admin().query("SELECT id FROM ai_operation WHERE id=ANY($1) AND state='queued'", [ids]))
					.rowCount,
			).toBe(1);
		} finally {
			gate.resolve();
			await worker;
		}
		expect(calls).toBe(31);
		expect(
			(await database.admin().query("SELECT id FROM ai_operation WHERE id=ANY($1) AND state='waiting_review'", [ids]))
				.rowCount,
		).toBe(31);
		expect(
			(
				await database
					.admin()
					.query("SELECT operation_id FROM ai_usage_ledger WHERE operation_id=ANY($1) AND kind='settle'", [ids])
			).rowCount,
		).toBe(31);
	}, 35_000);
});
