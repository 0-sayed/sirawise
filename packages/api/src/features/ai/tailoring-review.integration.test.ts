import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { expect, it } from "vite-plus/test";
import { withDatabaseOwner, withOwnerDatabase } from "@reactive-resume/db/client";
import { educationItemSchema } from "@reactive-resume/schema/resume/data";
import { defaultResumeData } from "@reactive-resume/schema/resume/default";
import { saveJobTarget, selectResumeJob } from "../career/job-targets";
import { resumeService } from "../resume/service";
import { createVariant } from "../resume/variants";
import { aiTestDatabase } from "./testing/database";
import { createReviewedJobVariant, decideVariantReview, getVariantReview } from "./variant-decisions";
import { variantReviewHandlers } from "./variant-handlers";
import { loadVariantSnapshot, prepareVariantReview } from "./variant-sources";
import { validateVariantOutput } from "./variant-validation";

const database = aiTestDatabase();
const run = <T>(work: () => T) => database.run(work);

it("rejects edited ordering without changing content and still accepts the reviewed reorder", async () => {
	const data = structuredClone(defaultResumeData);
	data.sections.education.items = ["first", "second"].map((id) =>
		educationItemSchema.parse({
			id,
			hidden: false,
			school: "School",
			degree: "Degree",
			area: "",
			grade: "",
			location: "",
			period: "",
			website: { url: "", label: "" },
			description: "",
		}),
	);
	data.sections.education.hidden = false;
	data.metadata.layout.pages = [{ fullWidth: false, main: ["education"], sidebar: [] }];
	const source = await run(() =>
		resumeService.create({ userId: "alice", name: "CV", tags: [], data, locale: "en-US" }),
	);
	const sourceRevision = (
		await database.admin().query("SELECT updated_at FROM resume WHERE id=$1", [source])
	).rows[0].updated_at.toISOString();
	const job = await run(() => saveJobTarget("alice", { role: "Engineer", employer: "", text: "Degree required" }));
	const copy = await run(() =>
		createVariant("alice", {
			variantKind: "job",
			sourceResumeId: source,
			expectedUpdatedAt: sourceRevision,
			requestKey: randomUUID(),
			jobId: job.jobId,
			jobRevision: job.revision,
		}),
	);
	const selection = (
		await database.admin().query("SELECT updated_at FROM resume_job_selection WHERE resume_id=$1", [copy.resumeId])
	).rows[0].updated_at.toISOString();
	const prepared = await run(() =>
		prepareVariantReview("alice", {
			kind: "review.tailoring",
			resumeId: copy.resumeId,
			expectedUpdatedAt: copy.updatedAt,
			jobId: job.jobId,
			jobRevision: job.revision,
			expectedSelectionRevision: selection,
		}),
	);
	const snapshot = await run(() => withOwnerDatabase("alice", (tx) => loadVariantSnapshot(tx, "alice", prepared)));
	assert(snapshot.variant);
	const result = validateVariantOutput(snapshot, {
		resumeId: copy.resumeId,
		baseRevision: copy.updatedAt,
		patches: [],
		order: [{ sectionId: "education", itemIds: ["second", "first"] }],
		notes: [],
	});
	const operationId = randomUUID();
	await database
		.admin()
		.query(
			"INSERT INTO ai_operation(id,user_id,request_key,fingerprint,kind,sources,parameters,route,consent_version,prompt_version,schema_version,state,result,delivered_at) VALUES ($1,'alice',$1,'fixture','review.tailoring',$2,$3,'{}','1','tailoring-v2','tailoring-v2','waiting_review',$4,now())",
			[operationId, JSON.stringify(prepared.sources), JSON.stringify(prepared.parameters), JSON.stringify(result)],
		);
	const input = {
		operationId,
		requestKey: randomUUID(),
		expectedUpdatedAt: copy.updatedAt,
		expectedDecisionId: null,
		subjectIds: ["order"],
	};
	await expect(
		run(() =>
			decideVariantReview("alice", {
				...input,
				decision: "accept_edited",
				editedText: "Ignored wording",
			}),
		),
	).rejects.toMatchObject({ code: "BAD_REQUEST" });
	const unchanged = await run(() => getVariantReview("alice", operationId));
	expect(unchanged.statuses.order).toBe("pending");
	expect(unchanged.updatedAt).toBe(copy.updatedAt);
	expect(unchanged.latestDecisionId).toBeNull();
	const accepted = await run(() => decideVariantReview("alice", { ...input, decision: "accept" }));
	expect(accepted.data.sections.education.items.map((item) => item.id)).toEqual(["second", "first"]);
	const reloaded = await run(() => getVariantReview("alice", operationId));
	expect(reloaded.beforeOrder).toEqual([{ sectionId: "education", itemIds: ["first", "second"] }]);
});

it("stages accepted wording on the source and saves it only in the reviewed job copy", async () => {
	const data = structuredClone(defaultResumeData);
	data.summary.hidden = false;
	data.summary.content = "<p>Built TypeScript services.</p>";
	data.metadata.layout.pages = [{ fullWidth: false, main: ["summary"], sidebar: [] }];
	const source = await run(() => resumeService.create({ userId: "bob", name: "CV", tags: [], data, locale: "en-US" }));
	const before = await run(() => withDatabaseOwner("bob", () => resumeService.getById({ userId: "bob", id: source })));
	const job = await run(() => saveJobTarget("bob", { role: "Engineer", employer: "", text: "TypeScript services" }));
	const selection = await run(() =>
		selectResumeJob("bob", {
			resumeId: source,
			expectedUpdatedAt: before.updatedAt.toISOString(),
			jobId: job.jobId,
			jobRevision: job.revision,
			expectedSelectionRevision: null,
		}),
	);
	const prepared = await run(() =>
		prepareVariantReview("bob", {
			kind: "review.tailoring",
			resumeId: source,
			expectedUpdatedAt: before.updatedAt.toISOString(),
			jobId: job.jobId,
			jobRevision: job.revision,
			expectedSelectionRevision: selection.revision,
		}),
	);
	const snapshot = await run(() => withOwnerDatabase("bob", (tx) => loadVariantSnapshot(tx, "bob", prepared)));
	const field = snapshot.variant?.fields[0];
	assert(field);
	const result = validateVariantOutput(snapshot, {
		resumeId: source,
		baseRevision: before.updatedAt.toISOString(),
		patches: [
			{
				id: "summary",
				target: {
					resumeId: source,
					baseRevision: before.updatedAt.toISOString(),
					sectionId: "summary",
					itemId: null,
					roleId: null,
					field: "content",
				},
				before: field.text,
				after: "Developed TypeScript services.",
				why: "Use a precise verb.",
				evidenceIds: field.evidenceIds,
				claims: [{ id: "claim", text: "Developed TypeScript services.", evidenceIds: field.evidenceIds, kind: "fact" }],
			},
		],
		order: [],
		notes: [],
	});
	assert(result.kind === "review.tailoring");
	const patch = result.output.patches[0];
	assert(patch);
	const validateResult = variantReviewHandlers["review.tailoring"].validateResult;
	assert(validateResult);
	const validatedNoOp = await run(() =>
		withOwnerDatabase("bob", (tx) =>
			validateResult(
				tx,
				"bob",
				{
					...prepared,
					requestKey: randomUUID(),
					consentVersion: "1",
					route: { routeId: "synthetic", routeRevision: "1", configRevision: "1" },
				},
				{
					...result.output,
					patches: [
						{ ...patch, after: patch.before, claims: patch.claims.map((claim) => ({ ...claim, text: patch.before })) },
					],
				},
			),
		),
	);
	expect(validatedNoOp).toMatchObject({ output: { patches: [] } });
	const operationId = randomUUID();
	await database
		.admin()
		.query(
			"INSERT INTO ai_operation(id,user_id,request_key,fingerprint,kind,sources,parameters,route,consent_version,prompt_version,schema_version,state,result,delivered_at) VALUES ($1,'bob',$1,'fixture','review.tailoring',$2,$3,'{}','1','tailoring-v2','tailoring-v2','waiting_review',$4,now())",
			[operationId, JSON.stringify(prepared.sources), JSON.stringify(prepared.parameters), JSON.stringify(result)],
		);
	const decision = await run(() =>
		decideVariantReview("bob", {
			operationId,
			requestKey: randomUUID(),
			expectedUpdatedAt: before.updatedAt.toISOString(),
			expectedDecisionId: null,
			subjectIds: ["summary"],
			decision: "accept_edited",
			editedText: "Developed services with TypeScript.",
		}),
	);
	expect(decision.statuses.summary).toBe("accepted");
	expect(await run(() => withDatabaseOwner("bob", () => resumeService.getById({ userId: "bob", id: source })))).toEqual(
		before,
	);
	const copy = await run(() =>
		createReviewedJobVariant("bob", {
			sourceResumeId: source,
			variantKind: "job",
			expectedUpdatedAt: before.updatedAt.toISOString(),
			requestKey: randomUUID(),
			jobId: job.jobId,
			jobRevision: job.revision,
			review: { operationId, decisionId: decision.decisionId },
		}),
	);
	expect(
		(await run(() => withDatabaseOwner("bob", () => resumeService.getById({ userId: "bob", id: copy.resumeId })))).data
			.summary.content,
	).toBe("<p>Developed services with TypeScript.</p>");
	expect(await run(() => withDatabaseOwner("bob", () => resumeService.getById({ userId: "bob", id: source })))).toEqual(
		before,
	);
});
