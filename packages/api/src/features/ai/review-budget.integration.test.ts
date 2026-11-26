import { describe, expect, it } from "vite-plus/test";
import { sql } from "drizzle-orm";
import { withOwnerDatabase } from "@reactive-resume/db/owner-scope";
import { claimNextOperation } from "./operations";
import { aiTestDatabase } from "./testing/database";
import { bindVerificationPass, createVerificationJournal, makeVerificationCall } from "./verification-journal";

describe.skipIf(!process.env.COVER_LETTER_TEST_DATABASE_URL)("review budget regressions", () => {
	const database = aiTestDatabase();
	it("deleting two admitted owners frees global slots for a third owner", async () => {
		const admin = database.admin();
		await admin.query(
			`INSERT INTO "user"(id,name,email,username,display_username) VALUES ('carol','Carol','carol@example.test','carol','carol')`,
		);
		await admin.query(
			`INSERT INTO ai_platform_budget(id,route_id,route_revision,window_date,cap_micros,request_cap_micros,concurrency) VALUES ('budget','synthetic','1',(now() AT TIME ZONE 'UTC')::date,100000,10000,2)`,
		);
		await admin.query("UPDATE ai_platform_capacity SET max_running=2 WHERE singleton");
		for (const owner of ["alice", "bob", "carol"]) {
			await admin.query(
				`INSERT INTO ai_operation(id,user_id,request_key,fingerprint,kind,sources,route,consent_version,prompt_version,schema_version) VALUES ($1,$1,$1,'fp','review','[]','{"routeId":"synthetic","routeRevision":"1"}','1','1','1')`,
				[owner],
			);
		}
		const admit = (owner: string) =>
			database.run(() =>
				withOwnerDatabase(
					owner,
					async (tx) =>
						(
							await tx.execute<{ admitted: boolean }>(
								sql`SELECT master_cv_ai_admit_budget(${owner},10000,100000) AS admitted`,
							)
						).rows[0]?.admitted,
				),
			);
		for (const owner of ["alice", "bob", "carol"]) expect(await admit(owner)).toBe(true);
		const claim = (owner: string) => database.run(() => claimNextOperation(owner));
		expect(await claim("alice")).toMatchObject({ operationId: "alice" });
		expect(await claim("bob")).toMatchObject({ operationId: "bob" });
		expect(await claim("carol")).toBeNull();
		await admin.query(`DELETE FROM "user" WHERE id IN ('alice','bob')`);
		expect(await claim("carol")).toMatchObject({ operationId: "carol" });
		expect(
			(await admin.query(`SELECT active,reserved_micros::int FROM ai_platform_budget WHERE id='budget'`)).rows,
		).toEqual([{ active: 1, reserved_micros: 10000 }]);
	});
	it("rejects runtime accounting rewrites and cannot erase another owner's reservation", async () => {
		for (const assignment of [
			"budget_id=NULL",
			"reserved_micros=0",
			"actual_micros=0",
			"unknown_booked_micros=0",
			"budget_closed=true",
		]) {
			await expect(
				database.run(() =>
					withOwnerDatabase("carol", (tx) =>
						tx.execute(sql.raw(`UPDATE ai_operation SET ${assignment} WHERE id='carol'`)),
					),
				),
			).rejects.toThrow();
		}
		await database
			.admin()
			.query(
				`INSERT INTO "user"(id,name,email,username,display_username) VALUES ('intruder','Intruder','intruder@example.test','intruder','intruder')`,
			);
		expect(
			(
				await database.run(() =>
					withOwnerDatabase("intruder", (tx) =>
						tx.execute(sql`UPDATE ai_operation SET reserved_micros=0 WHERE id='carol' RETURNING id`),
					),
				)
			).rows,
		).toEqual([]);
		await database.run(() =>
			withOwnerDatabase("intruder", (tx) => tx.execute(sql`SELECT master_cv_ai_reconcile_budget('carol')`)),
		);
		expect(
			(await database.admin().query("SELECT reserved_micros::int FROM ai_platform_budget WHERE id='budget'")).rows,
		).toEqual([{ reserved_micros: 10000 }]);
	});
	it("replaces exactly the booked bounds when late verifier costs arrive", async () => {
		const admin = database.admin();
		const output = { text: "Candidate" };
		const binding = bindVerificationPass(
			1,
			output,
			["one", "two", "three", "four"].map((id) => ({ itemIds: [id], payload: { selections: [] } })),
		);
		const [first, second, third, fourth] = binding.batchKeys;
		if (!first || !second || !third || !fourth) throw new Error("Missing batch keys");
		const journal = createVerificationJournal(binding, [
			{ ...makeVerificationCall(first, 0, 20_000), outcome: "valid", output, costMicros: 1_000 },
			makeVerificationCall(second, 0, 30_000),
			makeVerificationCall(third, 0, 40_000),
			{
				...makeVerificationCall(fourth, 0, 7_000),
				outcome: "transient",
				failure: {
					errorClass: "Error",
					message: "timeout",
					httpStatus: null,
					bytesReceived: false,
					generationId: null,
					abortCause: "call_timeout",
				},
			},
			{
				...makeVerificationCall(fourth, 1, 10_000, "backup"),
				outcome: "valid",
				output,
				costMicros: 2_000,
				observedModel: "deepseek/deepseek-v4.1-flash-1017",
				observedProvider: "Parasail",
			},
		]);
		await admin.query(`
			INSERT INTO "user"(id,name,email,username,display_username) VALUES ('bounded-owner','Bounded Owner','bounded@example.test','bounded-owner','bounded-owner');			INSERT INTO ai_platform_budget(id,route_id,route_revision,window_date,cap_micros,request_cap_micros,reserved_micros,active,concurrency)
			VALUES ('bounded','bounded','1',current_date,1000000,200000,200000,1,2);
			INSERT INTO ai_operation(id,user_id,request_key,fingerprint,kind,sources,route,consent_version,prompt_version,schema_version,state,budget_id,reserved_micros,deadline_at)
			VALUES ('bounded','bounded-owner','bounded','fp','review','[]','{}','1','1','1','failed','bounded',200000,now()-interval '6 minutes');
			INSERT INTO ai_operation_attempt(id,user_id,operation_id,ordinal,step_id,cost_micros,finished_at)
			VALUES ('bounded-writer','bounded-owner','bounded',1,'generate',10000,now());
		`);
		await admin.query(
			`INSERT INTO ai_operation_attempt(id,user_id,operation_id,ordinal,step_id,output,finished_at)
			 VALUES ('bounded-verifier','bounded-owner','bounded',2,'verify',$1,now())`,
			[journal],
		);
		const reconcile = () =>
			database.run(() =>
				withOwnerDatabase("bounded-owner", (tx) => tx.execute(sql`SELECT master_cv_ai_reconcile_budget('bounded')`)),
			);
		const budget = async () =>
			(
				await admin.query(
					"SELECT spent_micros::int,reserved_micros::int,active FROM ai_platform_budget WHERE id='bounded'",
				)
			).rows[0];
		await reconcile();
		expect(await budget()).toEqual({ spent_micros: 90_000, reserved_micros: 0, active: 0 });
		await expect(
			database.run(() =>
				withOwnerDatabase("bounded-owner", (tx) =>
					tx.execute(sql`UPDATE ai_operation_attempt
						SET output=jsonb_set(output,'{_verifyCalls,1,outcome}','"valid"') WHERE id='bounded-verifier'`),
				),
			),
		).rejects.toHaveProperty("cause.message", "Immutable completed AI attempt");
		await admin.query(`UPDATE ai_operation_attempt
			SET output=jsonb_set(output,'{_verifyCalls,1,costMicros}','1500') WHERE id='bounded-verifier'`);
		await reconcile();
		await reconcile();
		expect(await budget()).toEqual({ spent_micros: 61_500, reserved_micros: 0, active: 0 });
		await admin.query(`UPDATE ai_operation_attempt
			SET output=jsonb_set(output,'{_verifyCalls,2,costMicros}','2000') WHERE id='bounded-verifier'`);
		await reconcile();
		await reconcile();
		expect(await budget()).toEqual({ spent_micros: 23_500, reserved_micros: 0, active: 0 });
	});
	it.each([
		[10_000, 200_000],
		[210_000, 200_000],
	])("books a legacy unknown within the reservation when measured spend is %i", async (cost, booked) => {
		const admin = database.admin();
		const id = `legacy-${cost}`;
		await admin.query(
			`INSERT INTO "user"(id,name,email,username,display_username) VALUES ($1,'Legacy Owner',$1||'@example.test',$1,$1)`,
			[id],
		);
		await admin.query(
			`INSERT INTO ai_platform_budget(id,route_id,route_revision,window_date,cap_micros,request_cap_micros,reserved_micros,active,concurrency)
			 VALUES ($1,$1,'1',current_date,1000000,200000,200000,1,2)`,
			[id],
		);
		await admin.query(
			`INSERT INTO ai_operation(id,user_id,request_key,fingerprint,kind,sources,route,consent_version,prompt_version,schema_version,state,budget_id,reserved_micros,deadline_at)
			 VALUES ($1,$1,$1,'fp','review','[]','{}','1','1','1','failed',$1,200000,now()-interval '6 minutes')`,
			[id],
		);
		await admin.query(
			`INSERT INTO ai_operation_attempt(id,user_id,operation_id,ordinal,step_id,cost_micros,finished_at)
			 VALUES ($1||'-writer',$1,$1,1,'generate',$2,now()), ($1||'-verifier',$1,$1,2,'verify',NULL,NULL)`,
			[id, cost],
		);
		const reconcile = () =>
			database.run(() => withOwnerDatabase(id, (tx) => tx.execute(sql`SELECT master_cv_ai_reconcile_budget(${id})`)));
		const budget = async () =>
			(
				await admin.query("SELECT spent_micros::int,reserved_micros::int,active FROM ai_platform_budget WHERE id=$1", [
					id,
				])
			).rows[0];
		await reconcile();
		expect(await budget()).toEqual({ spent_micros: booked, reserved_micros: 0, active: 0 });
		await admin.query("UPDATE ai_operation_attempt SET finished_at=now(),cost_micros=2500 WHERE id=$1||'-verifier'", [
			id,
		]);
		await reconcile();
		await reconcile();
		expect(await budget()).toEqual({ spent_micros: Math.min(200_000, cost + 2_500), reserved_micros: 0, active: 0 });
	});
	it("rejects attaching the privileged deletion trigger to a forged runtime table", async () => {
		await expect(
			database.run(() =>
				withOwnerDatabase("intruder", async (tx) => {
					await tx.execute(sql`CREATE TEMP TABLE forged_deletion(id text)`);
					await tx.execute(
						sql`CREATE TRIGGER forged_deletion BEFORE DELETE ON forged_deletion FOR EACH ROW EXECUTE FUNCTION master_cv_ai_delete_owner()`,
					);
				}),
			),
		).rejects.toThrow();
	});

	it("derives settlement from immutable completed attempts rather than supplied actual cost", async () => {
		await database.admin().query("UPDATE ai_operation SET state='running',actual_micros=0 WHERE id='carol'");
		await database
			.admin()
			.query(
				"INSERT INTO ai_operation_attempt(id,user_id,operation_id,ordinal,step_id,cost_micros,finished_at) VALUES ('cost','carol','carol',1,'generate',700,now())",
			);
		await database.admin().query("UPDATE ai_operation SET state='failed' WHERE id='carol'");
		await database.run(() =>
			withOwnerDatabase("carol", (tx) => tx.execute(sql`SELECT master_cv_ai_reconcile_budget('carol')`)),
		);
		expect(
			(
				await database
					.admin()
					.query("SELECT actual_micros::int,reserved_micros::int,budget_closed FROM ai_operation WHERE id='carol'")
			).rows,
		).toEqual([{ actual_micros: 700, reserved_micros: 0, budget_closed: true }]);
	});

	it("ignores historical and orphaned counters when counting current live admission", async () => {
		await database
			.admin()
			.query(
				"INSERT INTO ai_platform_budget(id,route_id,route_revision,window_date,cap_micros,request_cap_micros,concurrency,active) VALUES ('yesterday','synthetic','1',(now() AT TIME ZONE 'UTC')::date-1,100000,10000,2,2)",
			);
		await database.admin().query("UPDATE ai_platform_budget SET active=2 WHERE id='budget'");
		await database
			.admin()
			.query(
				`INSERT INTO ai_operation(id,user_id,request_key,fingerprint,kind,sources,route,consent_version,prompt_version,schema_version) VALUES ('fresh','carol','fresh','fp','review','[]','{"routeId":"synthetic","routeRevision":"1"}','1','1','1')`,
			);
		expect(
			(
				await database.run(() =>
					withOwnerDatabase("carol", (tx) =>
						tx.execute(sql`SELECT master_cv_ai_admit_budget('fresh',10000,100000) AS admitted`),
					),
				)
			).rows,
		).toEqual([{ admitted: true }]);
	});
});

describe.skipIf(!process.env.COVER_LETTER_TEST_DATABASE_URL)("translation pool", () => {
	const database = aiTestDatabase();
	it("shares the request cap across concurrent translation parts and holds the daily cap", async () => {
		const admin = database.admin();
		await admin.query(`
		INSERT INTO ai_platform_budget(id,route_id,route_revision,window_date,cap_micros,request_cap_micros,spent_micros,concurrency)
		VALUES ('pool','pool','1',(now() AT TIME ZONE 'UTC')::date,15000000,200000,14800000,6);
		INSERT INTO ai_operation(id,user_id,request_key,fingerprint,kind,sources,route,parameters,consent_version,prompt_version,schema_version)
		VALUES
		('pool-root','alice','pool-root','fp','review.translation','[]','{"routeId":"pool","routeRevision":"1"}','{"translationBatch":{"rootId":"pool-root","index":0}}','1','1','1'),
		('pool-child','alice','pool-child','fp','review.translation','[]','{"routeId":"pool","routeRevision":"1"}','{"translationBatch":{"rootId":"pool-root","index":1}}','1','1','1'),
		('pool-extra','alice','pool-extra','fp','review','[]','{"routeId":"pool","routeRevision":"1"}','{}','1','1','1');
	`);
		const admit = (id: string) =>
			database.run(() =>
				withOwnerDatabase(
					"alice",
					async (tx) =>
						(
							await tx.execute<{ admitted: boolean }>(
								sql`SELECT master_cv_ai_admit_budget(${id},200000,15000000) AS admitted`,
							)
						).rows[0]?.admitted,
				),
			);
		expect(await admit("pool-root")).toBe(true);
		expect(await admit("pool-child")).toBe(true);
		expect(await admit("pool-extra")).toBe(false);
		await admin.query("UPDATE ai_operation SET state='running' WHERE id IN ('pool-root','pool-child')");
		const hold = (id: string, amount: number) =>
			database.run(() =>
				withOwnerDatabase(
					"alice",
					async (tx) =>
						(await tx.execute<{ status: string }>(sql`SELECT master_cv_ai_hold_translation(${id},${amount}) AS status`))
							.rows[0]?.status,
				),
			);
		expect(await hold("pool-root", 100000)).toBe("held");
		expect(await hold("pool-child", 100001)).not.toBe("held");
		expect(await hold("pool-child", 100000)).toBe("held");
		expect(await hold("pool-root", 100001)).not.toBe("held");
		const canDispatch = () =>
			database.run(() =>
				withOwnerDatabase(
					"alice",
					async (tx) =>
						(await tx.execute<{ allowed: boolean }>(sql`SELECT master_cv_ai_can_dispatch('pool-root') AS allowed`))
							.rows[0]?.allowed,
				),
			);
		expect(await canDispatch()).toBe(true);
		await admin.query("UPDATE ai_platform_budget SET window_date=window_date-1 WHERE id='pool'");
		expect(await canDispatch()).toBe(false);
		await admin.query("UPDATE ai_platform_budget SET window_date=window_date+1 WHERE id='pool'");
		for (const id of ["pool-root", "pool-child"]) {
			await admin.query(
				"INSERT INTO ai_operation_attempt(id,user_id,operation_id,ordinal,step_id,cost_micros,finished_at) VALUES ($1||'-writer','alice',$1,1,'generate',100000,now())",
				[id],
			);
			await admin.query("UPDATE ai_operation SET state='failed' WHERE id=$1", [id]);
			await database.run(() =>
				withOwnerDatabase("alice", (tx) => tx.execute(sql`SELECT master_cv_ai_reconcile_budget(${id})`)),
			);
		}
		expect(
			(await admin.query("SELECT spent_micros,reserved_micros FROM ai_platform_budget WHERE id='pool'")).rows,
		).toEqual([{ spent_micros: "15000000", reserved_micros: "0" }]);
	});
});
