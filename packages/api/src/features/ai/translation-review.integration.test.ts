import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { expect, it } from "vite-plus/test";
import { withDatabaseOwner, withOwnerDatabase } from "@reactive-resume/db/client";
import { blockText } from "@reactive-resume/resume/proposals";
import { buildTranslationInventory } from "@reactive-resume/resume/translation";
import { customSectionSchema, educationItemSchema } from "@reactive-resume/schema/resume/data";
import { defaultResumeData } from "@reactive-resume/schema/resume/default";
import { resumeService } from "../resume/service";
import { applyReviewedTranslation, createVariant } from "../resume/variants";
import { runAiOperations } from "./operation-worker";
import { operationService } from "./operations";
import { withAiRuntime } from "./route-policy";
import { aiTestDatabase } from "./testing/database";
import { syntheticReviewRuntime } from "./testing/runtime";
import { decideVariantReview, getVariantReview } from "./variant-decisions";
import { variantReviewHandlers } from "./variant-handlers";
import { loadVariantSnapshot, prepareVariantReview } from "./variant-sources";
import { validateVariantOutput } from "./variant-validation";
import { variantVerificationInventory } from "./variant-verifier";

const database = aiTestDatabase();
function translateFact(fact: { id: string; text: string }) {
	const text =
		fact.text === "مهندس"
			? "Engineer"
			: fact.text === "نبذة"
				? "Summary"
				: fact.text.includes("React")
					? fact.text.replace(
							"استخدمت React في 1445 هـ. لم أدر ميزانية.",
							"Used React in 1445 AH. Did not manage a budget.",
						)
					: fact.text;
	return { sourceId: fact.id, text, claims: [{ id: "claim", text, evidenceIds: [fact.id], kind: "translation" }] };
}
async function fixture(official = false, protectedName?: string, custom = false) {
	await database.admin().query("DELETE FROM resume_variant_source WHERE user_id='alice'");
	await database.admin().query("DELETE FROM resume WHERE user_id='alice'");
	const data = structuredClone(defaultResumeData);
	data.basics.name = protectedName ?? "اسم خاص";
	data.basics.email = "private@example.test";
	data.basics.headline = "مهندس";
	data.summary.hidden = false;
	data.summary.title = "نبذة";
	data.summary.content = `<p>${protectedName ? `${protectedName} ` : ""}استخدمت React في 1445 هـ. لم أدر ميزانية.</p>`;
	data.metadata.layout.pages = [{ fullWidth: false, main: ["summary"], sidebar: [] }];
	if (custom) {
		data.customSections = [
			customSectionSchema.parse({
				id: "courses",
				type: "certifications",
				title: "دورات",
				hidden: false,
				items: [
					{
						id: "course",
						hidden: false,
						title: "شهادة",
						issuer: "المعهد المحلي",
						date: "1445 هـ",
						website: { url: "https://private.example.test", label: "" },
						description: `<p>${data.basics.name} استخدمت React في 1445 هـ. لم أدر ميزانية.</p>`,
					},
				],
			}),
		];
		const page = data.metadata.layout.pages[0];
		assert(page);
		page.main.push("courses");
	}
	if (official) {
		data.sections.education.hidden = false;
		data.sections.education.items = [
			educationItemSchema.parse({
				id: "school",
				hidden: false,
				school: "المعهد المحلي",
				degree: "شهادة إتمام تدريب",
				area: "",
				grade: "",
				location: "",
				period: "1445 هـ",
				website: { url: "https://private.example.test", label: "" },
				description: "",
			}),
		];
		const page = data.metadata.layout.pages[0];
		assert(page);
		page.main.push("education");
	}
	const source = await database.run(() =>
		resumeService.create({ userId: "alice", name: "Synthetic", tags: [], data, locale: "ar-SA" }),
	);
	const sourceRevision = (
		await database.admin().query("SELECT updated_at FROM resume WHERE id=$1", [source])
	).rows[0].updated_at.toISOString();
	const copy = await database.run(() =>
		createVariant("alice", {
			variantKind: "language",
			sourceResumeId: source,
			expectedUpdatedAt: sourceRevision,
			requestKey: randomUUID(),
			targetLocale: "en-US",
		}),
	);
	const prepared = await database.run(() =>
		prepareVariantReview("alice", {
			kind: "review.translation",
			resumeId: copy.resumeId,
			expectedUpdatedAt: copy.updatedAt,
			expectedSourceRevision: sourceRevision,
		}),
	);
	const snapshot = await database.run(() =>
		withOwnerDatabase("alice", (tx) => loadVariantSnapshot(tx, "alice", prepared, { fullTranslation: true })),
	);
	const raw = {
		direction: "ar-en",
		sourceRevision: copy.updatedAt,
		segments: snapshot.cv.map(translateFact),
		notes: [],
	};
	const result = validateVariantOutput(snapshot, raw);
	const operationId = randomUUID();
	await database
		.admin()
		.query(
			"INSERT INTO ai_operation(id,user_id,request_key,fingerprint,kind,sources,parameters,route,consent_version,prompt_version,schema_version,state,result,delivered_at) VALUES ($1,'alice',$1,'fixture','review.translation',$2,$3,'{}','1','translation-v2','translation-v2','waiting_review',$4,now())",
			[operationId, JSON.stringify(prepared.sources), JSON.stringify(prepared.parameters), JSON.stringify(result)],
		);
	return { source, sourceRevision, copy, operationId, raw, prepared };
}
const run = <T>(work: () => T) => database.run(work);

it("accepts a factually verified translation through the production handler when advisory quality was not assessed", async () => {
	const f = await fixture();
	const request = {
		...f.prepared,
		requestKey: randomUUID(),
		route: { routeId: "synthetic", routeRevision: "1", configRevision: "1" },
		consentVersion: "1",
	};
	const handler = variantReviewHandlers["review.translation"];
	await run(() =>
		withOwnerDatabase("alice", async (tx) => {
			const snapshot = await loadVariantSnapshot(tx, "alice", request);
			const output = { ...f.raw, segments: snapshot.cv.map(translateFact) };
			const inventory = variantVerificationInventory(snapshot, output);
			const verdict = {
				schemaVersion: 1,
				verdicts: inventory.claims.map((claim) => ({
					claimId: claim.id,
					verdict: "supported",
					evidenceIds: claim.evidenceIds,
					reason: "All translated facts are supported by the matching source segment.",
				})),
				retention: {
					status: "retained",
					evidenceIds: snapshot.cv.map((fact) => fact.id),
					reason: "All source facts survive.",
				},
				absence: [],
				coverage: { status: "complete", reason: "Every response assertion was checked." },
				premises: [],
				quality: {
					assessment: "translation_language_quality",
					status: "unclear",
					reason:
						"Translation quality was not requested by the verifier task; no independent language-quality assessment can be inferred",
				},
			};
			assert(handler.verifier?.validateInContext && handler.validateResult);
			expect(handler.verifier.output.safeParse(verdict).success).toBe(true);
			await expect(handler.verifier.validateInContext(tx, "alice", request, output, verdict)).resolves.toMatchObject({
				output,
			});
			await expect(handler.validateResult(tx, "alice", request, output)).resolves.toMatchObject({
				kind: "review.translation",
				output,
			});
		}),
	);
	expect(
		(await database.admin().query("SELECT data FROM resume WHERE id=$1", [f.copy.resumeId])).rows[0].data.metadata.page
			.locale,
	).toBe("ar-SA");
});

async function decide(
	f: Awaited<ReturnType<typeof fixture>>,
	subjectIds: string[],
	decision: "accept" | "reject" | "undo" = "accept",
	extra = {},
) {
	const view = await run(() => getVariantReview("alice", f.operationId));
	return run(() =>
		decideVariantReview("alice", {
			operationId: f.operationId,
			requestKey: randomUUID(),
			expectedUpdatedAt: view.updatedAt,
			expectedDecisionId: view.latestDecisionId,
			subjectIds,
			decision,
			...extra,
		}),
	);
}

it("reviews and confirms custom sections atomically with protected names and official terms", async () => {
	const f = await fixture(false, undefined, true);
	const before = await run(() => getVariantReview("alice", f.operationId));
	expect(before.terms.terms.map((term) => term.target)).toEqual(
		expect.arrayContaining([
			expect.objectContaining({ sectionId: "certifications", customSectionId: "courses", field: "title" }),
			expect.objectContaining({ sectionId: "certifications", customSectionId: "courses", field: "issuer" }),
		]),
	);
	expect(JSON.stringify(f.raw)).not.toContain("اسم خاص");
	expect(JSON.stringify(before)).not.toMatch(/\[LOCAL_\d+\]/u);
	await expect(decide(f, ["translation"])).rejects.toMatchObject({ code: "CONFLICT" });
	// Confirming the first official term triggers one-click auto-apply (items 65 & 68), confirming remaining terms and applying atomically.
	const firstTerm = before.terms.terms[0];
	assert(firstTerm);
	const accepted = await decide(f, [firstTerm.id]);
	expect(accepted.statuses.translation).toBe("accepted");
	expect(accepted.data.customSections[0]?.items[0]?.issuer).toBe("المعهد المحلي");
	expect(accepted.data.customSections[0]?.items[0]?.date).toBe("1445 هـ");
	expect(accepted.data.customSections[0]?.items[0]?.description).toContain("اسم خاص Used React");
	expect(accepted.data.customSections[0]?.items[0]?.website).toMatchObject({
		url: "https://private.example.test",
		label: "",
	});
	expect(
		(await database.admin().query("SELECT data FROM resume WHERE id=$1", [f.source])).rows[0].data.customSections[0]
			.items[0].description,
	).toContain("استخدمت");
	const undone = await decide(f, ["translation"], "undo", { undoDecisionId: accepted.decisionId });
	expect(undone.data.metadata.page.locale).toBe("ar-SA");
});

it("names unsupported sections before admission or review without spending an operation", async () => {
	const f = await fixture(false, undefined, true);
	await database
		.admin()
		.query(
			`UPDATE resume SET data=jsonb_set(jsonb_set(data, '{customSections,0,type}', '"legacy-renderer"'), '{customSections,0,title}', '"Legacy content"') WHERE id=ANY($1)`,
			[[f.source, f.copy.resumeId]],
		);
	const expected = {
		code: "PRECONDITION_FAILED",
		data: { reason: "TRANSLATION_PARTIAL_COVERAGE", sections: ["Legacy content"] },
	};
	await expect(
		run(() =>
			prepareVariantReview("alice", {
				kind: "review.translation",
				resumeId: f.copy.resumeId,
				expectedUpdatedAt: f.copy.updatedAt,
				expectedSourceRevision: f.sourceRevision,
			}),
		),
	).rejects.toMatchObject(expected);
	await expect(run(() => getVariantReview("alice", f.operationId))).rejects.toMatchObject(expected);
	expect((await database.admin().query("SELECT count(*)::int n FROM ai_usage_ledger")).rows[0].n).toBe(0);
});

it("keeps segment approvals local, applies the complete translation atomically, replays once and undoes only this copy", async () => {
	const f = await fixture();
	for (const segment of f.raw.segments) await decide(f, [segment.sourceId]);
	const before = (await database.admin().query("SELECT data,updated_at FROM resume WHERE id=$1", [f.copy.resumeId]))
		.rows[0];
	expect(before.updated_at.toISOString()).toBe(f.copy.updatedAt);
	expect(before.data.metadata.page.locale).toBe("ar-SA");
	const view = await run(() => getVariantReview("alice", f.operationId));
	const input = {
		operationId: f.operationId,
		requestKey: randomUUID(),
		expectedUpdatedAt: view.updatedAt,
		expectedDecisionId: view.latestDecisionId,
		subjectIds: ["translation"],
		decision: "accept" as const,
	};
	const accepted = await run(() => decideVariantReview("alice", input));
	expect(await run(() => decideVariantReview("alice", input))).toEqual(accepted);
	expect(accepted.data.metadata.page.locale).toBe("en-US");
	expect(accepted.data.basics.name).toBe("اسم خاص");
	expect(accepted.data.basics.email).toBe("private@example.test");
	expect(accepted.data.summary.content).toContain("1445 AH");
	expect(
		(await database.admin().query("SELECT data FROM resume WHERE id=$1", [f.source])).rows[0].data.metadata.page.locale,
	).toBe("ar-SA");
	expect(
		(
			await database
				.admin()
				.query(
					"SELECT count(*)::int n FROM ai_review_decision WHERE operation_id=$1 AND subject_ids='[\"translation\"]'",
					[f.operationId],
				)
		).rows[0].n,
	).toBe(1);
	const undone = await decide(f, ["translation"], "undo", { undoDecisionId: accepted.decisionId });
	expect(undone.data).toEqual(before.data);
	expect(
		(
			await database
				.admin()
				.query("SELECT accepted_source_revision FROM resume_variant_source WHERE resume_id=$1", [f.copy.resumeId])
		).rows[0].accepted_source_revision,
	).toBeNull();
	const acceptedVersion = (
		await database.admin().query("SELECT history_version_id FROM ai_review_decision WHERE id=$1", [accepted.decisionId])
	).rows[0].history_version_id;
	await run(() =>
		withDatabaseOwner("alice", () =>
			resumeService.versions.restore({
				resumeId: f.copy.resumeId,
				versionId: acceptedVersion,
				userId: "alice",
				expectedUpdatedAt: new Date(undone.updatedAt),
			}),
		),
	);
	const restored = (await database.admin().query("SELECT data FROM resume WHERE id=$1", [f.copy.resumeId])).rows[0]
		.data;
	expect(restored.metadata.page.locale).toBe("en-US");
	expect(
		(
			await database
				.admin()
				.query("SELECT accepted_source_revision FROM resume_variant_source WHERE resume_id=$1", [f.copy.resumeId])
		).rows[0].accepted_source_revision,
	).toBe(f.sourceRevision);
});

it("blocks partial approval, foreign ownership, source changes and manual target edits", async () => {
	const f = await fixture();
	await expect(decide(f, ["translation"])).rejects.toMatchObject({ code: "CONFLICT" });
	const firstSegment = f.raw.segments[0];
	assert(firstSegment);
	await expect(run(() => getVariantReview("bob", f.operationId))).rejects.toMatchObject({ code: "NOT_FOUND" });
	await database.admin().query("UPDATE resume SET updated_at=updated_at+interval '1 second' WHERE id=$1", [f.source]);
	await expect(decide(f, [firstSegment.sourceId])).rejects.toMatchObject({ code: "CONFLICT" });
	await database.admin().query("UPDATE resume SET updated_at=$2 WHERE id=$1", [f.source, f.sourceRevision]);
	const view = await run(() => getVariantReview("alice", f.operationId));
	await database
		.admin()
		.query("UPDATE resume SET updated_at=updated_at+interval '1 second' WHERE id=$1", [f.copy.resumeId]);
	await expect(
		run(() =>
			decideVariantReview("alice", {
				operationId: f.operationId,
				requestKey: randomUUID(),
				expectedUpdatedAt: view.updatedAt,
				expectedDecisionId: view.latestDecisionId,
				subjectIds: [firstSegment.sourceId],
				decision: "accept",
			}),
		),
	).rejects.toMatchObject({ code: "CONFLICT" });
});

it("does not offer or execute an undo of an undo event", async () => {
	const f = await fixture();
	for (const segment of f.raw.segments) await decide(f, [segment.sourceId]);
	const accepted = await decide(f, ["translation"]);
	const undone = await decide(f, ["translation"], "undo", { undoDecisionId: accepted.decisionId });
	const view = await run(() => getVariantReview("alice", f.operationId));
	expect(view.undoable).not.toContainEqual({ decisionId: undone.decisionId, subjectIds: ["translation"] });
	await expect(decide(f, ["translation"], "undo", { undoDecisionId: undone.decisionId })).rejects.toMatchObject({
		code: "CONFLICT",
		data: { reason: "AI_UNDO_CHANGED" },
	});
	const unchanged = await run(() => getVariantReview("alice", f.operationId));
	expect(unchanged.updatedAt).toBe(undone.updatedAt);
	expect(unchanged.statuses.translation).toBe("pending");
});

it("keeps all pending official names in one decision and permits a later per-name correction", async () => {
	const f = await fixture(true);
	const initial = await run(() => getVariantReview("alice", f.operationId));
	// Item 68: only true proper names (school, not degree) are official terms.
	expect(initial.terms.terms).toHaveLength(1);
	await expect(decide(f, [initial.terms.terms[0]?.id ?? "missing", "translation"])).rejects.toMatchObject({
		code: "BAD_REQUEST",
	});
	const accepted = await decide(
		f,
		initial.terms.terms.map((term) => term.id),
	);
	const confirmed = await run(() => getVariantReview("alice", f.operationId));
	expect(confirmed.terms.terms.every((term) => term.status === "confirmed" && term.value === term.source)).toBe(true);
	// Undo auto-apply before editing a confirmed official name
	await decide(f, ["translation"], "undo", { undoDecisionId: accepted.decisionId });
	const term = confirmed.terms.terms[0];
	assert(term);
	await decide(f, [term.id], "accept", { decision: "accept_edited", editedText: "Reviewed official name" });
	const corrected = await run(() => getVariantReview("alice", f.operationId));
	expect(corrected.terms.terms.find((entry) => entry.id === term.id)?.value).toBe("Reviewed official name");
});

it("requires persisted official terms, invalidates the affected segment, and retains user terminology only in this copy", async () => {
	const f = await fixture(true);
	for (const segment of f.raw.segments) await decide(f, [segment.sourceId]);
	await expect(decide(f, ["translation"])).rejects.toMatchObject({ code: "CONFLICT" });
	const view = await run(() => getVariantReview("alice", f.operationId));
	expect(view.terms.terms).toHaveLength(1);
	const term = view.terms.terms[0];
	assert(term);
	const accepted = await decide(f, [term.id]);
	expect(accepted.statuses.translation).toBe("accepted");
	expect(accepted.data.sections.education.items[0]?.school).toBe("المعهد المحلي");
	expect(accepted.data.sections.education.items[0]?.degree).toBe("شهادة إتمام تدريب");
	expect(accepted.data.sections.education.items[0]?.website.url).toBe("https://private.example.test");
	expect(accepted.data.sections.education.items[0]?.period).toBe("1445 هـ");
});

it("rejects official-term corrections after final approval until that approval is undone", async () => {
	const f = await fixture(true);
	const initial = await run(() => getVariantReview("alice", f.operationId));
	const term = initial.terms.terms[0];
	assert(term);
	const accepted = await decide(f, [term.id]);
	expect(accepted.statuses.translation).toBe("accepted");
	const confirmed = await run(() => getVariantReview("alice", f.operationId));
	const correction = async () => {
		const view = await run(() => getVariantReview("alice", f.operationId));
		return run(() =>
			decideVariantReview("alice", {
				operationId: f.operationId,
				requestKey: randomUUID(),
				expectedUpdatedAt: view.updatedAt,
				expectedDecisionId: view.latestDecisionId,
				subjectIds: [term.id],
				decision: "accept_edited",
				editedText: "Corrected official term",
			}),
		);
	};
	await expect(correction()).rejects.toMatchObject({ code: "CONFLICT", data: { reason: "AI_DECISION_CHANGED" } });
	const unchanged = await run(() => getVariantReview("alice", f.operationId));
	expect(unchanged.latestDecisionId).toBe(accepted.decisionId);
	expect(unchanged.terms).toEqual(confirmed.terms);
	await decide(f, ["translation"], "undo", { undoDecisionId: accepted.decisionId });
	const corrected = await correction();
	expect(JSON.stringify(corrected.data)).toContain("Corrected official term");
});

it("rolls back content, locale, provenance and history when recording final approval fails", async () => {
	const f = await fixture();
	for (const segment of f.raw.segments) await decide(f, [segment.sourceId]);
	const before = (await database.admin().query("SELECT data,updated_at FROM resume WHERE id=$1", [f.copy.resumeId]))
		.rows[0];
	const versions = (
		await database.admin().query("SELECT count(*)::int n FROM resume_version WHERE resume_id=$1", [f.copy.resumeId])
	).rows[0].n;
	await database
		.admin()
		.query(
			"CREATE FUNCTION reject_translation_commit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.subject_ids='[\"translation\"]'::jsonb THEN RAISE EXCEPTION 'Synthetic approval failure'; END IF; RETURN NEW; END $$; CREATE TRIGGER reject_translation_commit BEFORE INSERT ON ai_review_decision FOR EACH ROW EXECUTE FUNCTION reject_translation_commit()",
		);
	await expect(decide(f, ["translation"])).rejects.toMatchObject({ cause: { message: "Synthetic approval failure" } });
	expect(
		(await database.admin().query("SELECT data,updated_at FROM resume WHERE id=$1", [f.copy.resumeId])).rows[0],
	).toEqual(before);
	expect(
		(await database.admin().query("SELECT count(*)::int n FROM resume_version WHERE resume_id=$1", [f.copy.resumeId]))
			.rows[0].n,
	).toBe(versions);
	expect(
		(
			await database
				.admin()
				.query("SELECT accepted_source_revision FROM resume_variant_source WHERE resume_id=$1", [f.copy.resumeId])
		).rows[0].accepted_source_revision,
	).toBeNull();
	await database
		.admin()
		.query("DROP TRIGGER reject_translation_commit ON ai_review_decision; DROP FUNCTION reject_translation_commit()");
});

it("rejects the first translation segment without saving the CV and undoes that review decision", async () => {
	const f = await fixture(true);
	const first = f.raw.segments[0];
	assert(first);
	const before = await run(() => getVariantReview("alice", f.operationId));
	const rejected = await decide(f, [first.sourceId], "reject");
	expect(rejected.statuses[first.sourceId]).toBe("rejected");
	const view = await run(() => getVariantReview("alice", f.operationId));
	expect(view.statuses[first.sourceId]).toBe("rejected");
	expect(view.segments[first.sourceId]?.status).toBe("rejected");
	expect(view.terms).toEqual(before.terms);
	expect(view.updatedAt).toBe(f.copy.updatedAt);
	expect(view.undoable).toContainEqual({ decisionId: rejected.decisionId, subjectIds: [first.sourceId] });
	const undone = await decide(f, [first.sourceId], "undo", { undoDecisionId: rejected.decisionId });
	expect(undone.statuses[first.sourceId]).toBe("pending");
	const restored = await run(() => getVariantReview("alice", f.operationId));
	expect(restored.segments).toEqual(before.segments);
	expect(restored.terms).toEqual(before.terms);
	expect(restored.updatedAt).toBe(before.updatedAt);
	expect(restored.undoable).toEqual([]);
});

it("resolves local names in review text before confirmation, after term edits and in applied prose", async () => {
	const f = await fixture(true);
	const before = await run(() => getVariantReview("alice", f.operationId));
	const school = before.terms.terms.find((term) => term.target.field === "school");
	assert(school);
	const segmentId = school.id.slice("term:".length);
	expect(before.segments[segmentId]?.text).toBe(school.source);
	expect(JSON.stringify(before)).not.toMatch(/\[LOCAL_\d+\]/u);
	const reviewedName = "Local Institute";
	const applied = await run(async () => {
		const view = await getVariantReview("alice", f.operationId);
		return decideVariantReview("alice", {
			operationId: f.operationId,
			requestKey: randomUUID(),
			expectedUpdatedAt: view.updatedAt,
			expectedDecisionId: view.latestDecisionId,
			subjectIds: [school.id],
			decision: "accept_edited",
			editedText: reviewedName,
		});
	});
	const after = await run(() => getVariantReview("alice", f.operationId));
	expect(after.segments[segmentId]?.text).toBe(reviewedName);
	expect(JSON.stringify(after)).not.toMatch(/\[LOCAL_\d+\]/u);
	expect(applied.data.sections.education.items[0]?.school).toBe(reviewedName);
	expect(JSON.stringify(applied.data)).not.toMatch(/\[LOCAL_\d+\]/u);
});

it("restores protected values with replacement metacharacters verbatim on final approval", async () => {
	const name = "$& $$ $` $'";
	const f = await fixture(false, name);
	const review = await run(() => getVariantReview("alice", f.operationId));
	assert(review.result.kind === "review.translation");
	expect(review.result.output.segments.find((segment) => segment.text.includes("React"))?.text).toBe(
		`${name} Used React in 1445 AH. Did not manage a budget.`,
	);
	for (const segment of f.raw.segments) await decide(f, [segment.sourceId]);
	const accepted = await decide(f, ["translation"]);
	expect(accepted.data.basics.name).toBe(name);
	expect(blockText(accepted.data.summary.content)).toBe(`${name} Used React in 1445 AH. Did not manage a budget.`);
});

it.each(["addition", "removal"] as const)(
	"blocks a source structural %s before preparing paid translation",
	async (change) => {
		const f = await fixture(true);
		const before = (await database.admin().query("SELECT data FROM resume WHERE id=$1", [f.copy.resumeId])).rows[0]
			.data;
		const changed = structuredClone(before);
		if (change === "addition")
			changed.sections.education.items.push({ ...changed.sections.education.items[0], id: "added-school" });
		else changed.sections.education.items = [];
		await database
			.admin()
			.query("UPDATE resume SET data=$2, updated_at=updated_at+interval '1 second' WHERE id=$1", [
				f.source,
				JSON.stringify(changed),
			]);
		const sourceRevision = (
			await database.admin().query("SELECT updated_at FROM resume WHERE id=$1", [f.source])
		).rows[0].updated_at.toISOString();
		const operations = (await database.admin().query("SELECT count(*)::int n FROM ai_operation")).rows[0].n;
		await expect(
			run(() =>
				prepareVariantReview("alice", {
					kind: "review.translation",
					resumeId: f.copy.resumeId,
					expectedUpdatedAt: f.copy.updatedAt,
					expectedSourceRevision: sourceRevision,
				}),
			),
		).rejects.toMatchObject({ code: "CONFLICT", data: { reason: "TRANSLATION_STRUCTURE_CHANGED" } });
		expect((await database.admin().query("SELECT count(*)::int n FROM ai_operation")).rows[0].n).toBe(operations);
		expect((await database.admin().query("SELECT count(*)::int n FROM ai_usage_ledger")).rows[0].n).toBe(0);
		expect(
			(await database.admin().query("SELECT data FROM resume WHERE id=$1", [f.copy.resumeId])).rows[0].data,
		).toEqual(before);
	},
);

it("realigns rich-text block count for an unedited AI language copy when source summary paragraphs change, while still blocking manually edited copies", async () => {
	const f = await fixture(true);
	// Source summary changes from 1 block to 2 blocks (e.g. after accepting an AI summary on the source CV)
	const sourceRow = (await database.admin().query("SELECT data FROM resume WHERE id=$1", [f.source])).rows[0].data;
	const updatedSource = structuredClone(sourceRow);
	updatedSource.summary.content = "<p>Used React in 1445 AH.</p><p>Did not manage a budget.</p>";
	await database
		.admin()
		.query("UPDATE resume SET data=$2, updated_at=updated_at+interval '1 second' WHERE id=$1", [
			f.source,
			JSON.stringify(updatedSource),
		]);
	const sourceRevision = (
		await database.admin().query("SELECT updated_at FROM resume WHERE id=$1", [f.source])
	).rows[0].updated_at.toISOString();

	// Unedited AI language copy succeeds in preparing translation
	const prepared = await run(() =>
		prepareVariantReview("alice", {
			kind: "review.translation",
			resumeId: f.copy.resumeId,
			expectedUpdatedAt: f.copy.updatedAt,
			expectedSourceRevision: sourceRevision,
		}),
	);
	expect(prepared.kind).toBe("review.translation");

	// Once the user manually edits the copy, block divergence must be blocked to protect manual edits
	const editedCopy = structuredClone(
		(await database.admin().query("SELECT data FROM resume WHERE id=$1", [f.copy.resumeId])).rows[0].data,
	);
	editedCopy.summary.content = "<p>Manual user edit</p>";
	await database
		.admin()
		.query("UPDATE resume SET data=$2, updated_at=updated_at+interval '2 seconds' WHERE id=$1", [
			f.copy.resumeId,
			JSON.stringify(editedCopy),
		]);
	const copyUpdatedAt = (
		await database.admin().query("SELECT updated_at FROM resume WHERE id=$1", [f.copy.resumeId])
	).rows[0].updated_at.toISOString();

	await expect(
		run(() =>
			prepareVariantReview("alice", {
				kind: "review.translation",
				resumeId: f.copy.resumeId,
				expectedUpdatedAt: copyUpdatedAt,
				expectedSourceRevision: sourceRevision,
			}),
		),
	).rejects.toMatchObject({ code: "CONFLICT", data: { reason: "TRANSLATION_STRUCTURE_CHANGED" } });
});

it.each([
	[0, "<p><strong>Previously saved English</strong></p><p>Verified English</p><p>Verified English</p>"],
	[1, "<p>Verified English</p><p></p><p>Verified English</p>"],
])("preserves the saved target of withheld paragraph %i when the source gains paragraphs", async (index, expected) => {
	const f = await fixture();
	const stored = async (id: string) =>
		(await database.admin().query("SELECT data, updated_at FROM resume WHERE id=$1", [id])).rows[0];
	const source = (await stored(f.source)).data;
	source.summary.content = "<p>فقرة أولى</p><p>فقرة ثانية</p><p>فقرة ثالثة</p>";
	await database.admin().query("UPDATE resume SET data=$2 WHERE id=$1", [f.source, JSON.stringify(source)]);
	const copy = (await stored(f.copy.resumeId)).data;
	copy.summary.content = "<p><strong>Previously saved English</strong></p>";
	await database.admin().query("UPDATE resume SET data=$2 WHERE id=$1", [f.copy.resumeId, JSON.stringify(copy)]);
	const segments = buildTranslationInventory(source).segments;
	const withheld = segments.find(({ target }) => "blockIndex" in target && target.blockIndex === index);
	assert(withheld);
	const expectedSourceRevision = (await stored(f.source)).updated_at.toISOString();
	const result = await run(() =>
		withOwnerDatabase("alice", (tx) =>
			applyReviewedTranslation(tx, "alice", {
				resumeId: f.copy.resumeId,
				sourceResumeId: f.source,
				expectedSourceRevision,
				data: copy,
				payload: {
					schemaVersion: 1,
					kind: "review.translation",
					segments: Object.fromEntries(
						segments
							.filter(({ id }) => id !== withheld.id)
							.map(({ id }) => [id, { status: "accepted", author: "model", text: "Verified English" }]),
					),
					terms: { schemaVersion: 1, terms: [] },
					before: null,
					after: null,
				},
				withheldSegmentIds: new Set([withheld.id]),
			}),
		),
	);
	expect(result.data.summary.content).toBe(expected);
});

it("journals and delivers a supported translation with the observed unclear-quality response through the complete worker", async () => {
	await database
		.admin()
		.query(
			"INSERT INTO ai_processing_consent(id,user_id,route_id,route_revision,notice_version,purpose,config_revision) VALUES ('translation-verifier-consent','alice','synthetic','1','1','review.translation','1')",
		);
	await database
		.admin()
		.query(
			"INSERT INTO ai_platform_budget(id,route_id,route_revision,window_date,cap_micros,request_cap_micros,concurrency) VALUES ('translation-verifier-budget','synthetic','1',(now() AT TIME ZONE 'UTC')::date,100000,10000,2)",
		);
	const quality = {
		assessment: "translation_language_quality",
		status: "unclear",
		reason:
			"Translation quality was not requested by the verifier task; no independent language-quality assessment can be inferred",
	};
	const runtime = {
		...syntheticReviewRuntime,
		fetch: async (_url: unknown, init?: RequestInit) => {
			const body = JSON.parse(String(init?.body));
			const payload = JSON.parse(body.messages.at(-1).content);
			const selection = (id: string) =>
				JSON.parse(payload.selections.find((entry: { id: string }) => entry.id === id).text);
			const verifying = payload.selections.some((entry: { id: string }) => entry.id === "variant-verification-task");
			const facts = selection("variant-cv-evidence") as Array<{ id: string; text: string }>;
			const task = selection(verifying ? "variant-verification-task" : "variant-task");
			const output = verifying
				? {
						schemaVersion: 1,
						verdicts: task.claims.map((claim: { id: string; evidenceIds: string[] }) => ({
							claimId: claim.id,
							verdict: "supported",
							evidenceIds: claim.evidenceIds,
							reason: "The matching source supports every fact.",
						})),
						retention: {
							status: "retained",
							evidenceIds: facts.map((fact) => fact.id),
							reason: "Every source fact survives.",
						},
						absence: [],
						coverage: { status: "complete", reason: "Checked the whole response." },
						premises: [],
						quality,
					}
				: {
						direction: task.direction,
						sourceRevision: task.sourceRevision,
						segments: facts.map(translateFact),
						notes: [],
					};
			return Response.json({
				id: "synthetic-translation-verifier",
				model: body.model,
				provider: body.provider.only[0],
				choices: [{ index: 0, message: { role: "assistant", content: JSON.stringify(output) }, finish_reason: "stop" }],
				usage: { prompt_tokens: 5, completion_tokens: 5, total_tokens: 10, cost: 0.00001 },
			});
		},
	};
	await database.run(() =>
		withAiRuntime(runtime, async () => {
			const f = await fixture();
			const operation = await operationService.start("alice", {
				kind: f.prepared.kind,
				parameters: f.prepared.parameters,
				sources: f.prepared.sources,
				requestKey: randomUUID(),
				route: { routeId: "synthetic", routeRevision: "1", configRevision: "1" },
				consentVersion: "1",
			});
			await runAiOperations();
			expect(await operationService.get("alice", operation.id)).toMatchObject({
				state: "succeeded",
				resultId: operation.id,
				failureCode: null,
			});
			const attempts = (
				await database
					.admin()
					.query("SELECT step_id,outcome,output FROM ai_operation_attempt WHERE operation_id=$1 ORDER BY ordinal", [
						operation.id,
					])
			).rows;
			expect(attempts.map(({ step_id, outcome }) => ({ step_id, outcome }))).toEqual([
				{ step_id: "generate", outcome: "valid" },
				{ step_id: "verify", outcome: "valid" },
			]);
			expect(attempts[1].output._verifyCalls).toEqual([
				expect.objectContaining({ outcome: "valid", output: expect.objectContaining({ quality }) }),
			]);
			expect(await operationService.getResult("alice", operation.id)).toMatchObject({
				kind: "review.translation",
				output: { segments: f.raw.segments.map(({ sourceId, text }) => ({ sourceId, text })) },
			});
			expect(
				(await database.admin().query("SELECT data FROM resume WHERE id=$1", [f.copy.resumeId])).rows[0].data.metadata
					.page.locale,
			).toBe("en-US");
		}),
	);
});
