import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vite-plus/test";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { Pool } from "pg";

describe.skipIf(!process.env.COVER_LETTER_TEST_DATABASE_URL)("AI platform budget concurrency", () => {
	it("admits requests independently of the route concurrency field and enforces the platform limit at claim", async () => {
		const connection = process.env.COVER_LETTER_TEST_DATABASE_URL;
		if (!connection) throw new Error("Disposable local database required");
		const suffix = randomUUID().replaceAll("-", "");
		const databaseName = `ai_budget_${suffix}`;
		const userId = `ai-budget-${suffix}`;
		const operationPrefix = `ai-budget-${suffix}`;
		const admin = new Pool({ connectionString: connection });
		const migrations = fileURLToPath(new URL("../../../migrations", import.meta.url));
		await admin.query(`CREATE DATABASE "${databaseName}"`);
		const url = new URL(connection);
		url.pathname = `/${databaseName}`;
		const pool = new Pool({ connectionString: url.toString(), max: 1 });
		try {
			const db = drizzle({ client: pool });
			await migrate(db, { migrationsFolder: migrations });
			await pool.query(
				`INSERT INTO "user" (id,name,email,username,display_username)
				 VALUES ($1,$1,$1||'@example.test',$1,$1)`,
				[userId],
			);
			await pool.query("SELECT set_config('app.user_id', $1, false)", [userId]);
			const route = { routeId: operationPrefix, routeRevision: "1" };
			const day = new Date().toISOString().slice(0, 10);
			const budgetId = `${route.routeId}:1:${day}`;
			await pool.query(
				"INSERT INTO ai_platform_budget (id,route_id,route_revision,window_date,cap_micros,request_cap_micros,concurrency) VALUES ($1,$2,'1',$3,10000000,1000,100)",
				[budgetId, route.routeId, day],
			);
			expect((await pool.query("SELECT max_running FROM ai_platform_capacity WHERE singleton")).rows).toEqual([
				{ max_running: 30 },
			]);

			const admit = async (id: string) => {
				await pool.query(
					`INSERT INTO ai_operation
					 (id,user_id,request_key,fingerprint,kind,sources,route,consent_version,prompt_version,schema_version)
					 VALUES ($1,$2,$1,$1,'review.extraction','[]'::jsonb,$3::jsonb,'1','1','1')`,
					[id, userId, JSON.stringify(route)],
				);
				const result = await pool.query("SELECT master_cv_ai_admit_budget($1,1000,10000000) AS admitted", [id]);
				return result.rows[0]?.admitted;
			};
			const claim = async (id: string) =>
				(await pool.query("SELECT master_cv_ai_claim_slot($1) AS allowed", [id])).rows[0]?.allowed;

			for (let index = 0; index < 50; index++)
				expect(await admit(`${operationPrefix}-${String(index).padStart(2, "0")}`)).toBe(true);
			await pool.query("UPDATE ai_platform_budget SET concurrency=3 WHERE id=$1", [budgetId]);
			const queued = `${operationPrefix}-later`;
			expect(await admit(queued)).toBe(true);
			expect(await claim(queued)).toBe(false);

			const { rows } = await pool.query<{ id: string }>("SELECT id FROM ai_operation ORDER BY created_at,id LIMIT 31");
			const first = rows[0];
			const next = rows[30];
			if (!first || !next) throw new Error("Expected the first 31 queued requests");
			for (const { id } of rows.slice(0, 30)) {
				expect(await claim(id)).toBe(true);
				await pool.query("UPDATE ai_operation SET state='running' WHERE id=$1", [id]);
			}
			expect(await claim(next.id)).toBe(false);
			await pool.query("UPDATE ai_operation SET state='failed' WHERE id=$1", [first.id]);
			expect(await claim(next.id)).toBe(true);
		} finally {
			await pool.end();
			await admin.query(`DROP DATABASE "${databaseName}"`);
			await admin.end();
		}
	});
});
