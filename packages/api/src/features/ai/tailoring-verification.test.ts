import type { VariantSnapshot } from "./variant-types";
import { expect, it } from "vite-plus/test";
import { validateVariantOutput } from "./variant-validation";
import {
	assertVariantVerification,
	buildVariantVerificationPayload,
	buildVariantVerifierSchema,
	variantVerificationInventory,
} from "./variant-verifier";

const snapshot: VariantSnapshot = {
	category: "tailoring",
	resumeId: "copy",
	sourceRevision: "revision",
	cv: [{ id: "fact", section: "summary", text: "Used React." }],
	jobAd: null,
	variant: {
		resumeId: "copy",
		baseRevision: "revision",
		fields: [
			{
				sectionId: "summary",
				itemId: null,
				roleId: null,
				field: "content",
				text: "Used React.",
				evidenceIds: ["fact"],
			},
		],
		order: [],
	},
};
const noChange = {
	resumeId: "copy",
	baseRevision: "revision",
	patches: [],
	order: [],
	notes: ["Which work would you like to highlight?"],
};
const verdict = {
	schemaVersion: 1,
	verdicts: [],
	retention: { status: "retained", evidenceIds: ["fact"], reason: "No source facts changed." },
	absence: [],
	coverage: { status: "complete", reason: "The entire procedural question was checked." },
	premises: [{ id: "note:0", verdict: "no_candidate_premise", reason: "Open question with no invented facts." }],
	quality: { status: "unclear", reason: "No wording quality assessment was requested." },
};

it("requires a retention assessment for a safe question-only tailoring answer", () => {
	expect(validateVariantOutput(snapshot, noChange)).toMatchObject({ output: noChange });
	expect(variantVerificationInventory(snapshot, noChange).retention).toBe(true);
	expect(() => assertVariantVerification(snapshot, noChange, { ...verdict, retention: null })).toThrow(
		"AI_VERIFICATION_RETENTION_SCOPE",
	);
	expect(() => assertVariantVerification(snapshot, noChange, verdict)).not.toThrow();
});

it("rejects unclear aggregate retention when no tailoring text changes are proposed", () => {
	expect(() =>
		assertVariantVerification(snapshot, noChange, {
			...verdict,
			retention: { status: "unclear", evidenceIds: ["fact"], reason: "No edit exists to assess." },
		}),
	).toThrow("AI_VERIFICATION_FAILED");
});

it("rejects explicitly lost retention even for a question-only answer", () => {
	expect(() =>
		assertVariantVerification(snapshot, noChange, {
			...verdict,
			retention: { status: "lost", evidenceIds: ["fact"], reason: "A source fact was lost." },
		}),
	).toThrow("AI_VERIFICATION_FAILED");
});

it.each(["unsupported", "contradicted", "unclear"])("withholds %s premises without tailoring edits", (status) => {
	expect(() =>
		assertVariantVerification(snapshot, noChange, {
			...verdict,
			premises: [{ ...verdict.premises[0], verdict: status }],
		}),
	).toThrow("AI_VERIFICATION_FAILED");
});

it("still requires exact premise coverage and valid retention citations without edits", () => {
	expect(() => assertVariantVerification(snapshot, noChange, { ...verdict, premises: [] })).toThrow(
		"AI_VERIFICATION_INCOMPLETE",
	);
	expect(() =>
		assertVariantVerification(snapshot, noChange, {
			...verdict,
			retention: { status: "unclear", evidenceIds: ["invented"], reason: "No edit." },
		}),
	).toThrow("AI_VERIFICATION_CITATION");
});

const edited = {
	...noChange,
	patches: [
		{
			id: "patch",
			target: {
				resumeId: "copy",
				baseRevision: "revision",
				sectionId: "summary",
				itemId: null,
				roleId: null,
				field: "content",
			},
			before: "Used React.",
			after: "Used React.",
			why: "Preserve supported wording.",
			evidenceIds: ["fact"],
			claims: [{ id: "claim", text: "Used React.", evidenceIds: ["fact"], kind: "fact" }],
		},
	],
};
it.each([null, "unclear", "lost"])("still requires retained facts for actual tailoring patches: %s", (status) => {
	expect(variantVerificationInventory(snapshot, edited).retention).toBe(true);
	expect(() =>
		assertVariantVerification(snapshot, edited, {
			...verdict,
			verdicts: [
				{ claimId: "patch:patch:claim", verdict: "supported", evidenceIds: ["fact"], reason: "Explicit source." },
			],
			premises: [
				...verdict.premises,
				{ id: "reason:patch", verdict: "no_candidate_premise", reason: "Procedural reason." },
			],
			retention: status === null ? null : { status, evidenceIds: ["fact"], reason: "Retention assessment." },
		}),
	).toThrow();
});

it("constrains retention in the verifier output schema to match each task's retention scope", () => {
	const editedSchema = buildVariantVerifierSchema(buildVariantVerificationPayload(snapshot, edited));
	const editedVerdict = {
		...verdict,
		verdicts: [
			{ claimId: "patch:patch:claim", verdict: "supported", evidenceIds: ["fact"], reason: "Explicit source." },
		],
		premises: [
			{ id: "reason:patch", verdict: "supported", reason: "Preserves supported wording." },
			{ id: "note:0", verdict: "no_candidate_premise", reason: "Procedural note." },
		],
	};
	expect(editedSchema.safeParse({ ...editedVerdict, retention: null }).success).toBe(false);
	expect(
		editedSchema.safeParse({
			...editedVerdict,
			retention: { status: "retained", evidenceIds: ["fact"], reason: "All source facts remain." },
		}).success,
	).toBe(true);

	const noChangeSchema = buildVariantVerifierSchema(buildVariantVerificationPayload(snapshot, noChange));
	expect(noChangeSchema.safeParse(verdict).success).toBe(true);
	expect(noChangeSchema.safeParse({ ...verdict, retention: null }).success).toBe(false);
	expect(
		noChangeSchema.safeParse({
			...verdict,
			retention: { status: "unclear", evidenceIds: ["fact"], reason: "No edit exists to assess." },
		}).success,
	).toBe(true);

	const jobSnapshot: VariantSnapshot = {
		category: "job-evidence",
		resumeId: "copy",
		sourceRevision: "revision",
		cv: [{ id: "fact", section: "summary", text: "Used React." }],
		jobAd: { segments: [{ id: "job:1", text: "Requires React." }] },
	};
	const jobOutput = {
		requirements: [
			{
				id: "req-1",
				spanIds: ["job:1"],
				verdict: "supported",
				importance: "essential",
				evidenceIds: ["fact"],
				explanation: "The CV states the candidate used React.",
			},
		],
		notes: [],
	};
	const jobSchema = buildVariantVerifierSchema(buildVariantVerificationPayload(jobSnapshot, jobOutput));
	const jobVerdict = {
		...verdict,
		verdicts: [
			{ claimId: "requirement:req-1", verdict: "supported", evidenceIds: ["fact"], reason: "Explicit source." },
		],
		premises: [{ id: "requirement:req-1", verdict: "supported", reason: "Supported requirement." }],
	};
	expect(jobSchema.safeParse({ ...jobVerdict, retention: null }).success).toBe(true);
	expect(
		jobSchema.safeParse({
			...jobVerdict,
			retention: { status: "retained", evidenceIds: ["fact"], reason: "Not applicable." },
		}).success,
	).toBe(false);
});
