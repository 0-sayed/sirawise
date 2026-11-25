import { describe, expect, it, vi } from "vite-plus/test";
import { withOwnerDatabase } from "@reactive-resume/db/owner-scope";
import { aiOperation } from "@reactive-resume/db/schema";
import { AI_QUEUE_TTL_MS, claimNextOperation } from "./operations";
import { withAiRuntime } from "./route-policy";
import { aiTestDatabase } from "./testing/database";
import { syntheticRuntime } from "./testing/runtime";
import { reserveOperation, releaseOperation, settleOperation, usageService } from "./usage";

describe.skipIf(!process.env.COVER_LETTER_TEST_DATABASE_URL)("Start operation ledger", () => {
	const database = aiTestDatabase();
	async function reserve(id: string, createdAt?: Date, dueAt?: Date) {
		return database.run(() =>
			withOwnerDatabase("alice", async (tx) => {
				await tx.insert(aiOperation).values({
					id,
					userId: "alice",
					requestKey: id,
					fingerprint: id,
					kind: "test",
					sources: [],
					route: { routeId: "test", routeRevision: "1", configRevision: "1" },
					consentVersion: "1",
					promptVersion: "1",
					schemaVersion: "1",
					...(createdAt ? { createdAt } : {}),
					...(dueAt ? { dueAt } : {}),
				});
				await reserveOperation(tx, "alice", id);
			}),
		);
	}
	it("expires queued work separately under racing claims and releases one use", async () => {
		const createdAt = new Date(Date.now() - 31 * 60_000);
		await reserve("expired-queue", createdAt, new Date(Date.now() + 60_000));
		expect(await database.run(() => Promise.all([claimNextOperation("alice"), claimNextOperation("alice")]))).toEqual([
			null,
			null,
		]);
		const { rows } = await database
			.admin()
			.query(
				"SELECT state,failure_code,queue_expires_at,execution_started_at FROM ai_operation WHERE id='expired-queue'",
			);
		expect(rows).toEqual([
			{
				state: "failed",
				failure_code: "AI_QUEUE_EXPIRED",
				queue_expires_at: new Date(createdAt.getTime() + AI_QUEUE_TTL_MS),
				execution_started_at: null,
			},
		]);
		expect(
			(
				await database
					.admin()
					.query("SELECT kind FROM ai_usage_ledger WHERE operation_id='expired-queue' ORDER BY created_at")
			).rows,
		).toEqual([{ kind: "reserve" }, { kind: "release" }]);
		expect(
			(await database.admin().query("SELECT id FROM ai_operation_attempt WHERE operation_id='expired-queue'")).rows,
		).toEqual([]);
	});
	it("scopes the local allowance to its owner and ignores it in production", async () => {
		const runtime = { ...syntheticRuntime, localOwnerAllowance: { ownerId: "alice", limit: 50 } };
		const usage = (owner: string) =>
			database.run(() => withAiRuntime(runtime, () => usageService.getStartUsage(owner)));
		expect((await usage("alice")).operations.limit).toBe(50);
		expect((await usage("bob")).operations.limit).toBe(5);
		try {
			vi.stubEnv("NODE_ENV", "production");
			expect((await usage("alice")).operations.limit).toBe(5);
		} finally {
			vi.unstubAllEnvs();
		}
	});
	it("reserves the final credit once under races; failure releases; five deliveries never replenish", async () => {
		for (const id of ["a", "b", "c", "d"]) {
			await reserve(id);
			await database.run(() => withOwnerDatabase("alice", (tx) => settleOperation(tx, "alice", id)));
		}
		const race = await Promise.allSettled([reserve("last1"), reserve("last2")]);
		expect(race.filter((r) => r.status === "fulfilled")).toHaveLength(1);
		expect(race.find((result) => result.status === "rejected")).toMatchObject({
			status: "rejected",
			reason: {
				data: { reason: "AI_OPERATIONS_LIMIT", allowance: { limit: 5, used: 4, reserved: 1, remaining: 0 } },
			},
		});
		expect((await database.run(() => usageService.getStartUsage("alice"))).operations).toEqual({
			limit: 5,
			used: 4,
			reserved: 1,
			remaining: 0,
		});
		const last = race[0]?.status === "fulfilled" ? "last1" : "last2";
		await database.run(() =>
			withOwnerDatabase("alice", async (tx) => {
				await releaseOperation(tx, "alice", last);
				await releaseOperation(tx, "alice", last);
				await settleOperation(tx, "alice", last);
			}),
		);
		expect((await database.run(() => usageService.getStartUsage("alice"))).operations).toEqual({
			limit: 5,
			used: 4,
			reserved: 0,
			remaining: 1,
		});
		await reserve("final");
		await database.run(() =>
			withOwnerDatabase("alice", async (tx) => {
				await reserveOperation(tx, "alice", "final");
				await settleOperation(tx, "alice", "final");
				await settleOperation(tx, "alice", "final");
				await releaseOperation(tx, "alice", "final");
			}),
		);
		expect((await database.run(() => usageService.getStartUsage("alice"))).operations).toEqual({
			limit: 5,
			used: 5,
			reserved: 0,
			remaining: 0,
		});
		expect((await database.run(() => usageService.getStartUsage("bob"))).operations).toEqual({
			limit: 5,
			used: 0,
			reserved: 0,
			remaining: 5,
		});
		await expect(reserve("sixth")).rejects.toMatchObject({
			code: "PRECONDITION_FAILED",
			data: { reason: "AI_OPERATIONS_LIMIT" },
		});
		expect((await database.admin().query("SELECT id FROM ai_operation WHERE id='sixth'")).rows).toEqual([]);
	});
});
