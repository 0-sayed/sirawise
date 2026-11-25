import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { expect, it } from "vite-plus/test";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { Pool } from "pg";

it("isolates translation batches, freezes completed results, and cascades account erasure", async () => {
	const connection = process.env.COVER_LETTER_TEST_DATABASE_URL;
	if (!connection) throw new Error("Disposable local database required");
	const url = new URL(connection);
	if (!["localhost", "127.0.0.1", "[::1]"].includes(url.hostname) || url.searchParams.has("host"))
		throw new Error("Expected disposable Postgres");
	const suffix = randomUUID().replaceAll("-", "");
	const name = `translation_batch_${suffix}`;
	const role = `translation_batch_runtime_${suffix}`;
	const admin = new Pool({ connectionString: connection });
	await admin.query(`CREATE DATABASE "${name}"`);
	url.pathname = `/${name}`;
	const pool = new Pool({ connectionString: url.toString(), max: 1 });
	try {
		await migrate(drizzle({ client: pool }), {
			migrationsFolder: fileURLToPath(new URL("../../../migrations", import.meta.url)),
		});
		await pool.query(
			`CREATE ROLE "${role}" NOSUPERUSER NOBYPASSRLS NOINHERIT; GRANT USAGE ON SCHEMA public TO "${role}"; GRANT SELECT,INSERT,UPDATE,DELETE ON ALL TABLES IN SCHEMA public TO "${role}"`,
		);
		await pool.query(
			`INSERT INTO "user" (id,name,email,username,display_username) VALUES ('alice','Alice','alice@example.test','alice','alice'),('bob','Bob','bob@example.test','bob','bob')`,
		);
		await pool.query(
			`INSERT INTO ai_operation (id,user_id,request_key,fingerprint,kind,sources,route,consent_version,prompt_version,schema_version,state) VALUES ('root','alice','request','fingerprint','translation','[]','{}','v1','v1','v1','failed'),('other','bob','request','fingerprint','translation','[]','{}','v1','v1','v1','queued')`,
		);
		const asOwner = async (query: string, owner = "alice") => {
			await pool.query("BEGIN");
			try {
				await pool.query(`SET LOCAL ROLE "${role}"`);
				await pool.query("SELECT set_config('app.user_id',$1,true)", [owner]);
				const result = await pool.query(query);
				await pool.query("COMMIT");
				return result;
			} catch (error) {
				await pool.query("ROLLBACK");
				throw error;
			}
		};
		await pool.query(`INSERT INTO ai_operation (id,user_id,request_key,fingerprint,kind,sources,route,consent_version,prompt_version,schema_version,state,parameters)
			VALUES ('legacy','alice','legacy','legacy','review.translation','[]','{}','v1','v1','v1','failed',
			'{"translationBatch":{"rootId":"legacy","index":0,"total":3,"planHash":"${"a".repeat(64)}"}}')`);
		const migration = await readFile(
			new URL("../../../migrations/20261121103849_translation_batch_resume/migration.sql", import.meta.url),
			"utf8",
		);
		const backfill = migration
			.split("--> statement-breakpoint")
			.find((statement) => statement.includes("Restore aggregate rows"));
		if (!backfill) throw new Error("Expected the translation aggregate backfill");
		await pool.query(backfill);
		await pool.query(backfill);
		expect(
			(await asOwner("SELECT total,state,plan FROM ai_translation_batch WHERE root_operation_id='legacy'")).rows,
		).toEqual([{ total: 3, state: "running", plan: null }]);
		expect((await pool.query("SELECT user_id FROM master_cv_ai_queue_owners()")).rows).toContainEqual({
			user_id: "alice",
		});
		await asOwner(
			"UPDATE ai_translation_batch SET state='paused',failure_code='AI_CANCELLED' WHERE root_operation_id='legacy'",
		);
		expect((await pool.query("SELECT user_id FROM master_cv_ai_queue_owners()")).rows).not.toContainEqual({
			user_id: "alice",
		});
		await pool.query(`INSERT INTO ai_operation (id,user_id,request_key,fingerprint,kind,sources,route,consent_version,prompt_version,schema_version,state,parameters)
			SELECT 'failed-'||i, 'alice', 'failed-'||i, 'failed-'||i, 'review.translation', '[]', '{}', 'v1','v1','v1','failed',
			jsonb_build_object('translationBatch', jsonb_build_object('rootId','legacy','index',i,'total',3)) FROM generate_series(1,2) i`);
		await asOwner(
			'UPDATE ai_translation_batch SET state=\'running\',failure_code=NULL,execution=\'{"route":{},"consentVersion":"1","retryFailedOperationIds":["failed-2"]}\' WHERE root_operation_id=\'legacy\'',
		);
		// Every index exists and no operation is active: only the persisted retry intent discovers this owner.
		expect((await pool.query("SELECT user_id FROM master_cv_ai_queue_owners()")).rows).toContainEqual({
			user_id: "alice",
		});
		await asOwner(
			'UPDATE ai_translation_batch SET execution=\'{"route":{},"consentVersion":"1","retryFailedOperationIds":[]}\' WHERE root_operation_id=\'legacy\'',
		);
		expect((await pool.query("SELECT user_id FROM master_cv_ai_queue_owners()")).rows).not.toContainEqual({
			user_id: "alice",
		});
		await pool.query("DELETE FROM ai_operation WHERE id IN ('failed-1','failed-2')");
		await pool.query("DELETE FROM ai_operation WHERE id='legacy'");
		await expect(
			asOwner(
				"INSERT INTO ai_translation_batch(user_id,root_operation_id,total,state) VALUES ('alice','root',0,'running')",
			),
		).rejects.toMatchObject({ code: "23514" });
		await asOwner(
			"INSERT INTO ai_translation_batch(user_id,root_operation_id,total,state) VALUES ('alice','root',2,'running')",
		);
		expect((await asOwner("SELECT root_operation_id FROM ai_translation_batch", "bob")).rows).toEqual([]);
		expect((await asOwner("UPDATE ai_translation_batch SET state='paused'", "bob")).rowCount).toBe(0);
		await expect(
			asOwner(
				"INSERT INTO ai_translation_batch(user_id,root_operation_id,total,state) VALUES ('bob','other',2,'running')",
			),
		).rejects.toMatchObject({ code: "42501" });
		await expect(
			asOwner(
				"INSERT INTO ai_translation_batch(user_id,root_operation_id,total,state) VALUES ('alice','other',2,'running')",
			),
		).rejects.toMatchObject({ code: "23503" });
		await expect(asOwner("UPDATE ai_translation_batch SET state='complete'")).rejects.toMatchObject({ code: "23514" });
		await expect(asOwner("UPDATE ai_translation_batch SET result='{}'")).rejects.toMatchObject({ code: "23514" });
		await asOwner("UPDATE ai_translation_batch SET state='paused',failure_code='RETRY'");
		await asOwner("UPDATE ai_translation_batch SET plan='{}'");
		await expect(asOwner("UPDATE ai_translation_batch SET plan=NULL")).rejects.toThrow(
			"Immutable translation batch plan",
		);
		await expect(asOwner("UPDATE ai_translation_batch SET plan='{\"changed\":true}'")).rejects.toThrow(
			"Immutable translation batch plan",
		);
		await asOwner('UPDATE ai_translation_batch SET execution=\'{"route":{"routeId":"new"},"consentVersion":"1"}\'');
		await asOwner("UPDATE ai_translation_batch SET state='running',failure_code=NULL");
		await asOwner("UPDATE ai_translation_batch SET state='complete',result='{\"proposals\":[]}'");
		await asOwner("UPDATE ai_translation_batch SET review_state='succeeded'");
		await expect(asOwner("UPDATE ai_translation_batch SET execution=NULL")).rejects.toThrow(
			"Immutable completed translation batch",
		);
		await expect(asOwner("UPDATE ai_translation_batch SET result='{}'")).rejects.toThrow(
			"Immutable completed translation batch",
		);
		await expect(asOwner("UPDATE ai_translation_batch SET state='running',result=NULL")).rejects.toThrow(
			"Immutable completed translation batch",
		);
		await expect(asOwner("UPDATE ai_translation_batch SET total=3")).rejects.toThrow(
			"Immutable translation batch binding",
		);
		await expect(
			asOwner("UPDATE ai_operation SET state='waiting_review',delivered_at=now(),result='{}' WHERE id='root'"),
		).rejects.toThrow("Invalid AI operation transition");
		expect((await asOwner("SELECT review_state FROM ai_translation_batch")).rows).toEqual([
			{ review_state: "succeeded" },
		]);
		await pool.query("DELETE FROM \"user\" WHERE id='alice'");
		expect((await pool.query("SELECT root_operation_id FROM ai_translation_batch")).rows).toEqual([]);
	} finally {
		await pool.end();
		await admin.query(`DROP DATABASE "${name}"`);
		await admin.query(`DROP ROLE IF EXISTS "${role}"`);
		await admin.end();
	}
});
