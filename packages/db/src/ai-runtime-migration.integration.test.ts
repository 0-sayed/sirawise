import { randomUUID } from "node:crypto";
import { mkdtemp, readdir, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vite-plus/test";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { Pool } from "pg";

describe.skipIf(!process.env.COVER_LETTER_TEST_DATABASE_URL)("T005 existing runtime migration", () => {
	it("upgrades an existing append-only runtime role without permitting ledger rewrites or budget access", async () => {
		const connection = process.env.COVER_LETTER_TEST_DATABASE_URL;
		if (!connection) throw new Error("Disposable local database required");
		const suffix = randomUUID().replaceAll("-", "");
		const name = `t005_migration_${suffix}`;
		const role = `t005_legacy_${suffix}`;
		const admin = new Pool({ connectionString: connection });
		const migrations = fileURLToPath(new URL("../../../migrations", import.meta.url));
		const baseline = await mkdtemp(path.join(tmpdir(), "t005-migration-"));
		await admin.query(`CREATE DATABASE "${name}"`);
		const url = new URL(connection);
		url.pathname = `/${name}`;
		const pool = new Pool({ connectionString: url.toString(), max: 1 });
		try {
			for (const directory of await readdir(migrations))
				if (directory < "20261111193937_t005_ai_runtime")
					await symlink(path.join(migrations, directory), path.join(baseline, directory));
			const db = drizzle({ client: pool });
			await migrate(db, { migrationsFolder: baseline });
			await pool.query(
				`CREATE ROLE "${role}" NOSUPERUSER NOBYPASSRLS NOINHERIT; GRANT USAGE ON SCHEMA public TO "${role}"; GRANT SELECT,INSERT,UPDATE,DELETE ON ALL TABLES IN SCHEMA public TO "${role}"; REVOKE UPDATE,DELETE ON career_fact_revision FROM "${role}"; ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO "${role}"`,
			);
			for (const directory of await readdir(migrations))
				if (directory >= "20261111193937_t005_ai_runtime" && directory < "20261124235951_ai_queue_expiry")
					await symlink(path.join(migrations, directory), path.join(baseline, directory));
			await migrate(db, { migrationsFolder: baseline });
			await pool.query(`INSERT INTO "user"(id,name,email,username,display_username)
				VALUES ('owner','Synthetic','owner@example.test','owner','owner')`);
			await pool.query(`INSERT INTO ai_operation(
				id,user_id,request_key,fingerprint,kind,sources,route,consent_version,prompt_version,schema_version,state,created_at,deadline_at)
				VALUES
				('queued','owner','queued','fp','review','[]','{}','1','1','1','queued','2026-01-01T00:00Z','2026-01-01T00:02Z'),
				('running','owner','running','fp','review','[]','{}','1','1','1','running','2026-01-01T00:00Z','2026-01-01T00:02Z'),
				('failed','owner','failed','fp','review','[]','{}','1','1','1','failed','2026-01-01T00:00Z','2026-01-01T00:02Z')`);
			await migrate(db, { migrationsFolder: migrations });
			expect(
				(
					await pool.query(
						`SELECT id, state, queue_expires_at, execution_started_at, deadline_at FROM ai_operation ORDER BY id`,
					)
				).rows,
			).toEqual(
				["failed", "queued", "running"].map((state) => ({
					id: state,
					state,
					queue_expires_at: new Date(state === "queued" ? "2026-01-01T00:05Z" : "2026-01-01T00:30Z"),
					execution_started_at: null,
					deadline_at: new Date("2026-01-01T00:02Z"),
				})),
			);
			await expect(pool.query(`UPDATE ai_operation SET queue_expires_at=now() WHERE id='queued'`)).rejects.toThrow(
				"Immutable AI operation binding",
			);
			const rights = await pool.query(
				`SELECT has_table_privilege($1,'ai_usage_ledger','SELECT') AS read,
					has_table_privilege($1,'ai_usage_ledger','INSERT') AS append,
					has_table_privilege($1,'ai_usage_ledger','UPDATE') AS update,
					has_table_privilege($1,'ai_usage_ledger','DELETE') AS delete,
					has_table_privilege($1,'ai_usage_ledger','TRUNCATE') AS truncate,
					has_table_privilege($1,'ai_platform_budget','SELECT,INSERT,UPDATE,DELETE,TRUNCATE') AS budget,
					has_table_privilege($1,'ai_platform_capacity','SELECT,INSERT,UPDATE,DELETE,TRUNCATE') AS capacity,
					has_function_privilege($1,'master_cv_ai_admit_budget(text,bigint,bigint)','EXECUTE') AS admission,
					has_function_privilege($1,'master_cv_ai_claim_slot(text)','EXECUTE') AS claim,
					has_function_privilege($1,'master_cv_ai_queue_position(text)','EXECUTE') AS position`,
				[role],
			);
			expect(rights.rows).toEqual([
				{
					read: true,
					append: true,
					update: false,
					delete: false,
					truncate: false,
					budget: false,
					capacity: false,
					admission: true,
					claim: true,
					position: true,
				},
			]);
			expect((await pool.query("SELECT rolsuper,rolbypassrls FROM pg_roles WHERE rolname=$1", [role])).rows).toEqual([
				{ rolsuper: false, rolbypassrls: false },
			]);
		} finally {
			await pool.end();
			await admin.query(`DROP DATABASE "${name}"`);
			await admin.query(`DROP ROLE IF EXISTS "${role}"`);
			await admin.end();
			await rm(baseline, { recursive: true, force: true });
		}
	});
});
