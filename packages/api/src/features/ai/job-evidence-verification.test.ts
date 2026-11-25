import type { VariantSnapshot } from "./variant-types";
import type { JobEvidenceOutput } from "@reactive-resume/schema/resume/variant-outputs";
import { expect, it } from "vite-plus/test";
import { z } from "zod";
import fixture from "./testing/fixtures/job-evidence-redundant-verdicts.json";
import { loadSafetyCases } from "./testing/pipeline-safety-fixtures";
import { variantReviewHandlers } from "./variant-handlers";
import { buildJobAdSegments } from "./variant-sources";
import { validateAndFilterVariantOutput, validateVariantOutput } from "./variant-validation";
import {
	assertVariantVerification,
	buildVariantVerificationPayload,
	buildVariantVerifierSchema,
	jobEvidenceVerifierSchema,
	filterVariantVerification,
	mergeBatchedVariantVerifications,
	planVariantVerificationBatches,
	variantVerificationInventory,
} from "./variant-verifier";
import { truncatedVerificationBatch } from "./verification-journal";

const snapshot = fixture.snapshot as VariantSnapshot;

const jobCases = loadSafetyCases<{ id: string; source: VariantSnapshot; candidate: JobEvidenceOutput }>("job-evidence");

it("binds surviving note text to its original verdict ID after a sibling is withheld", () => {
	const input = jobCases.inputs.find(({ id }) => id === "job-en-notes");
	if (!input) throw new Error("Missing note fixture");
	const scoped = {
		...input.source,
		jobEvidenceContract: { maxInputCodePoints: 32000, maxOutputTokens: 4096 },
		jobNoteIds: ["note:1"],
	};
	const payload = buildVariantVerificationPayload(scoped, {
		requirements: input.candidate.requirements,
		notes: [input.candidate.notes[1]],
	});
	const task = JSON.parse(
		payload.selections.find((entry) => "id" in entry && entry.id === "variant-verification-task")?.text ?? "null",
	);
	expect(task.premises).toContainEqual({ id: "note:1", text: input.candidate.notes[1] });
});

it.each(jobCases.inputs)("applies the candidate to the fixed job fixture $id", (input) => {
	const expected = jobCases.labels.find(({ id }) => id === input.id);
	if (!expected) throw new Error(`Missing labels for ${input.id}`);
	const candidate = {
		...input.source,
		jobEvidenceContract: { maxInputCodePoints: 32000, maxOutputTokens: 4096 },
	};
	if (expected.mode === "deterministic") {
		expect(() => validateAndFilterVariantOutput(candidate, input.candidate)).toThrow(expected.caught[0]?.issueClass);
		expect(() => validateVariantOutput(candidate, input.candidate)).toThrow(expected.caught[0]?.issueClass);
		return;
	}
	const guarded = validateAndFilterVariantOutput(candidate, input.candidate);
	if (guarded.kind !== "review.job-evidence") throw new Error("Expected job evidence");
	const deterministic = expected.caught.filter(({ stage }) => stage === "deterministic");
	expect(guarded.withheld?.items ?? []).toEqual(
		deterministic.map(({ itemId, issueClass }) => expect.objectContaining({ id: itemId, reason: issueClass })),
	);
	if (deterministic.length)
		expect(() => validateVariantOutput(candidate, input.candidate)).toThrow(deterministic[0]?.issueClass);
	const rejected = new Set(guarded.withheld?.items?.map((item) => item.id));
	const scoped = {
		...candidate,
		jobNoteIds: input.candidate.notes.map((_, i) => `note:${i}`).filter((id) => !rejected.has(id)),
	};
	const plan = planVariantVerificationBatches(scoped, guarded.output);
	const batches = plan.batches.map((batch) => {
		const inventory = variantVerificationInventory(batch.snapshot, batch.output);
		const unsupported = expected.caught.find(
			({ stage, issueClass }) => stage === "semantic" && issueClass === "unsupported_claim",
		);
		const verdict = {
			schemaVersion: 2,
			retention: null,
			verdicts: inventory.claims.map(({ id, evidenceIds }) => ({
				claimId: id,
				evidenceIds,
				verdict: id === `requirement:${unsupported?.itemId}` ? "unsupported" : "supported",
				reason: "Synthetic.",
			})),
			premises: inventory.premises.map(({ id }) => {
				const issue = expected.caught.find(
					(entry) => entry.stage === "semantic" && entry !== unsupported && id === `requirement:${entry.itemId}`,
				);
				return {
					id,
					verdict: issue ? "unsupported" : "supported",
					reason: "Synthetic.",
					issueClass: issue?.issueClass ?? null,
				};
			}),
			absence: inventory.absence.map(({ id }) => ({ id, verdict: "confirmed_absent" })),
			coverage: { status: "complete", reason: "Synthetic." },
			quality: { status: "appropriate", reason: "Synthetic." },
		};
		for (const scope of ["verdicts", "premises", "absence"] as const) {
			const entries = verdict[scope];
			const first = entries[0];
			if (!first) continue;
			expect(() =>
				filterVariantVerification(batch.snapshot, batch.output, { ...verdict, [scope]: entries.slice(1) }),
			).toThrow("AI_VERIFICATION_INCOMPLETE");
			expect(() =>
				filterVariantVerification(batch.snapshot, batch.output, {
					...verdict,
					[scope]: [...entries, first],
				}),
			).toThrow("AI_VERIFICATION_INCOMPLETE");
		}
		return { ...batch, verdict };
	});
	const merged = mergeBatchedVariantVerifications(scoped, guarded.output, batches, plan.oversizeWithheld);
	const output = merged.output as typeof guarded.output;
	expect([...output.requirements.map(({ id }) => id), ...(output.notes.length ? scoped.jobNoteIds : [])]).toEqual(
		expected.retainedIds,
	);
	expect(merged.withheld?.items ?? []).toEqual(
		expected.caught
			.filter(({ stage }) => stage === "semantic")
			.map(({ itemId, issueClass }) => expect.objectContaining({ id: itemId, reason: issueClass })),
	);
});
function firstVerdict() {
	const value = structuredClone(fixture.verdicts[0]);
	if (!value) throw new Error("Missing captured verdict");
	return value;
}
function lastVerdict(value: ReturnType<typeof firstVerdict>) {
	const last = value.verdicts.at(-1);
	if (!last) throw new Error("Missing captured assessment");
	return last;
}

function withoutExtraVerdicts(value: ReturnType<typeof firstVerdict>) {
	const ids = new Set(variantVerificationInventory(snapshot, fixture.output).claims.map(({ id }) => id));
	return { ...value, verdicts: value.verdicts.filter(({ claimId }) => ids.has(claimId)) };
}

it.each(fixture.verdicts)("rejects captured extra IDs and preserves factual rejections with exact IDs", (verdict) => {
	expect(() => assertVariantVerification(snapshot, fixture.output, verdict)).toThrow("AI_VERIFICATION_INCOMPLETE");
	expect(() => assertVariantVerification(snapshot, fixture.output, withoutExtraVerdicts(verdict))).toThrow(
		"AI_VERIFICATION_FAILED",
	);
});

it("does not let a premise verdict replace a missing career claim verdict", () => {
	const verdict = firstVerdict();
	expect(() =>
		assertVariantVerification(snapshot, fixture.output, { ...verdict, verdicts: verdict.verdicts.slice(1) }),
	).toThrow("AI_VERIFICATION_INCOMPLETE");
});

it.each(["unsupported", "contradicted", "partially"])("still rejects a redundant %s verdict", (status) => {
	const verdict = structuredClone(firstVerdict());
	lastVerdict(verdict).verdict = status;
	expect(() => assertVariantVerification(snapshot, fixture.output, verdict)).toThrow("AI_VERIFICATION_INCOMPLETE");
});

it.each(["invented", "requirement:req-01"])("rejects an extra unknown or duplicate verdict ID: %s", (claimId) => {
	const verdict = structuredClone(firstVerdict());
	lastVerdict(verdict).claimId = claimId;
	expect(() => assertVariantVerification(snapshot, fixture.output, verdict)).toThrow("AI_VERIFICATION_INCOMPLETE");
});

it("rejects an invented evidence citation on a redundant verdict", () => {
	const verdict = structuredClone(firstVerdict());
	lastVerdict(verdict).evidenceIds = ["invented"];
	expect(() => assertVariantVerification(snapshot, fixture.output, verdict)).toThrow("AI_VERIFICATION_INCOMPLETE");
	const exactVerdict = withoutExtraVerdicts(verdict);
	lastVerdict(exactVerdict).evidenceIds = ["invented"];
	expect(() => assertVariantVerification(snapshot, fixture.output, exactVerdict)).toThrow("AI_VERIFICATION_CITATION");
});

it("requires exact IDs even when all factual verdicts are supported", () => {
	const verdict = firstVerdict();
	verdict.verdicts = verdict.verdicts.map((entry) => ({ ...entry, verdict: "supported" }));
	expect(() => assertVariantVerification(snapshot, fixture.output, verdict)).toThrow("AI_VERIFICATION_INCOMPLETE");
	expect(() => assertVariantVerification(snapshot, fixture.output, withoutExtraVerdicts(verdict))).not.toThrow();
});
it("sends explicit selected-passage scope to the independent checker", () => {
	const payload = buildVariantVerificationPayload(snapshot, fixture.output);
	const task = JSON.parse(
		payload.selections.find((entry) => "id" in entry && entry.id === "variant-verification-task")?.text ?? "null",
	);
	expect(task.evidenceScope).toEqual({ completeCv: false, absence: "selected_passages_only" });
});

it("splits single-paragraph multi-sentence job ads into distinct sentence spans and records withheld reasons", () => {
	const ad =
		"تبحث شركة أفق الرحلة عن استشاري العمليات لقيادة تحسين العمليات. تشمل المسؤوليات إعداد تقارير أسبوعية. تتطلب الوظيفة عشر سنوات من الخبرة.";
	const segments = buildJobAdSegments("j1", "r1", ad);
	expect(segments).toHaveLength(3);
	expect(segments[0]).toEqual({
		id: "job:j1:r1:0",
		text: "تبحث شركة أفق الرحلة عن استشاري العمليات لقيادة تحسين العمليات.",
	});
	expect(segments[2]).toEqual({ id: "job:j1:r1:2", text: "تتطلب الوظيفة عشر سنوات من الخبرة." });
	expect(buildJobAdSegments("j1", "r1", "TypeScript required.")).toEqual([
		{ id: "job:j1:r1", text: "TypeScript required." },
	]);

	const verdict = withoutExtraVerdicts(firstVerdict());
	const filtered = filterVariantVerification(snapshot, fixture.output, verdict);
	expect(filtered.withheld?.items?.length).toBeGreaterThan(0);
	for (const item of filtered.withheld?.items ?? []) {
		expect(item.reason).toBeTruthy();
		expect(item.spanIds?.length).toBeGreaterThan(0);
	}
});

it("keeps independently verified job items when a sibling premise is missing", () => {
	const scoped = { ...snapshot, jobEvidenceContract: { maxInputCodePoints: 32_000, maxOutputTokens: 4096 } };
	const output = { requirements: [], notes: ["Review the selected passages.", "Check the wording."] };
	const [batch] = planVariantVerificationBatches(scoped, output).batches;
	if (!batch) throw new Error("Missing verifier batch");
	const verdict = {
		schemaVersion: 2,
		retention: null,
		verdicts: [],
		premises: [{ id: "note:0", verdict: "no_candidate_premise", issueClass: null, reason: "Procedural" }],
		absence: [],
		coverage: { status: "complete", reason: "Checked" },
		quality: { status: "appropriate", reason: "Checked" },
	};
	expect(mergeBatchedVariantVerifications(scoped, output, [{ ...batch, verdict }])).toMatchObject({
		output: { requirements: [], notes: ["Review the selected passages."] },
		withheld: { count: 1, items: [{ id: "note:1", reason: "AI_VERIFICATION_INCOMPLETE", text: "Check the wording." }] },
	});
});

it("requires the full inventory initially and accepts a safe subset on a verification retry", () => {
	const scoped = { ...snapshot, jobEvidenceContract: { maxInputCodePoints: 32_000, maxOutputTokens: 4096 } };
	const payload = buildVariantVerificationPayload(scoped, fixture.output);
	const schema = buildVariantVerifierSchema(payload);
	const retrySchema = buildVariantVerifierSchema(payload, { allowMissingDecisions: true });
	const verdict = {
		schemaVersion: 2,
		verdicts: [],
		premises: [],
		absence: [],
		retention: null,
		coverage: { status: "complete", reason: "The selected evidence supports the factual description as written." },
		quality: { status: "appropriate", reason: "Clear" },
	};
	expect(schema.safeParse(verdict).success).toBe(false);
	expect(retrySchema.safeParse(verdict).success).toBe(true);
	expect(jobEvidenceVerifierSchema.safeParse(verdict).success).toBe(true);
});

it("withholds unchecked legacy job items after a retry or a truncated batch", () => {
	expect(variantReviewHandlers["review.job-evidence"].verifier?.withholdTruncatedBatch).toBe(true);
	const output = { requirements: [], notes: ["Review the selected passages.", "Check the wording."] };
	const verifierPayload = buildVariantVerificationPayload(snapshot, output);
	const verdict = {
		schemaVersion: 1,
		retention: null,
		verdicts: [],
		premises: [{ id: "note:0", verdict: "no_candidate_premise", reason: "Procedural" }],
		absence: [],
		coverage: { status: "complete", reason: "Checked" },
		quality: { status: "appropriate", reason: "Checked" },
	};
	expect(buildVariantVerifierSchema(verifierPayload).safeParse(verdict).success).toBe(false);
	expect(buildVariantVerifierSchema(verifierPayload, { allowMissingDecisions: true }).safeParse(verdict).success).toBe(
		true,
	);
	const checked = { snapshot, output: { ...output, notes: output.notes.slice(0, 1) }, verdict };
	const truncated = {
		snapshot: { ...snapshot, jobNoteIds: ["note:1"] },
		output: { ...output, notes: output.notes.slice(1) },
		verdict: truncatedVerificationBatch,
	};
	for (const batches of [[{ snapshot, output, verdict }], [checked, truncated]])
		expect(mergeBatchedVariantVerifications(snapshot, output, batches)).toMatchObject({
			output: checked.output,
			withheld: { count: 1, items: [{ id: "note:1", reason: "AI_VERIFICATION_INCOMPLETE" }] },
		});
});

it.each([
	{ claimIndexes: [0, 4, 5, 8, 9, 11], notes: [] },
	{ claimIndexes: [0, 5, 8, 11], notes: ["Review the selected evidence."] },
])(
	"packs a long review into one wave while keeping absence and claim decisions separate",
	({ claimIndexes, notes }) => {
		const template = fixture.output.requirements[0];
		if (!template) throw new Error("Missing requirement fixture");
		const evidenceIds = snapshot.cv.slice(0, 1).map(({ id }) => id);
		const requirements = Array.from({ length: 15 }, (_, index) => {
			const absent = !claimIndexes.includes(index);
			return {
				...template,
				id: "assessment-" + index,
				verdict: absent ? "no_evidence" : "partial",
				evidenceIds: absent ? [] : evidenceIds,
			};
		});
		const scoped = {
			...snapshot,
			cv: snapshot.cv.map((fact) => ({ ...fact, text: fact.text.repeat(2) })),
			jobEvidenceContract: { maxInputCodePoints: 32_000, maxOutputTokens: 4096 },
		};
		const { batches, oversizeWithheld } = planVariantVerificationBatches(scoped, { requirements, notes });
		expect(oversizeWithheld).toBeUndefined();
		expect(batches).toHaveLength(5);
		expect(batches.flatMap(({ itemIds }) => itemIds).sort()).toEqual(
			[...requirements.map(({ id }) => id), ...notes.map((_, index) => `note:${index}`)].sort(),
		);
		for (const batch of batches) {
			const inventory = variantVerificationInventory(batch.snapshot, batch.output);
			expect(inventory.absence.length > 0 && inventory.claims.length > 0).toBe(false);
			if (inventory.absence.length) expect(batch.snapshot.cv).toEqual(scoped.cv);
		}
	},
);

it("prevents a checker from attaching a rejection class to a supported absence premise", () => {
	const scoped = { ...snapshot, jobEvidenceContract: { maxInputCodePoints: 32000, maxOutputTokens: 4096 } };
	const template = fixture.output.requirements[0];
	if (!template) throw new Error("Missing requirement fixture");
	const requirement = {
		...template,
		id: "change-management",
		verdict: "no_evidence",
		evidenceIds: [],
	};
	const payload = buildVariantVerificationPayload(scoped, { requirements: [requirement], notes: [] });
	const schema = buildVariantVerifierSchema(payload);
	const premise = {
		id: "requirement:change-management",
		verdict: "supported",
		issueClass: null,
		reason: "Scoped absence",
	};
	const verdict = {
		schemaVersion: 2,
		retention: null,
		verdicts: [],
		premises: [premise],
		absence: [{ id: "absence:change-management", verdict: "confirmed_absent" }],
		coverage: { status: "complete", reason: "Checked" },
		quality: { status: "appropriate", reason: "Checked" },
	};
	expect(schema.safeParse(verdict).success).toBe(true);
	expect(schema.safeParse({ ...verdict, premises: [{ ...premise, issueClass: "unsupported_claim" }] }).success).toBe(
		false,
	);
	expect(JSON.stringify(z.toJSONSchema(schema))).toContain('"anyOf"');
});
