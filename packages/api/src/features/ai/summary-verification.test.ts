import type { VariantSnapshot } from "./variant-types";
import { expect, it } from "vite-plus/test";
import realSummary from "./testing/fixtures/summary-advisory-retention.json";
import { validateVariantOutput } from "./variant-validation";
import { assertVariantVerification, buildVariantVerificationPayload } from "./variant-verifier";

it("accepts the supported summary with the required null retention assessment", () => {
	expect(() =>
		assertVariantVerification(realSummary.snapshot as VariantSnapshot, realSummary.output, {
			...realSummary.verdict,
			retention: null,
		}),
	).not.toThrow();
});

it.each(["retained", "lost", "unclear"])("rejects an unsolicited %s assessment on a summary", (status) => {
	expect(() =>
		assertVariantVerification(realSummary.snapshot as VariantSnapshot, realSummary.output, {
			...realSummary.verdict,
			retention: { ...realSummary.verdict.retention, status },
		}),
	).toThrow("AI_VERIFICATION_RETENTION_SCOPE");
});

it("still rejects invented citations in an optional summary retention assessment", () => {
	expect(() =>
		assertVariantVerification(realSummary.snapshot as VariantSnapshot, realSummary.output, {
			...realSummary.verdict,
			retention: { ...realSummary.verdict.retention, evidenceIds: ["invented"] },
		}),
	).toThrow("AI_VERIFICATION_RETENTION_SCOPE");
});

const snapshot: VariantSnapshot = {
	category: "summary" as const,
	resumeId: "cv",
	sourceRevision: "revision",
	cv: [{ id: "fact", section: "skills", text: "Used React." }],
	jobAd: null,
};
const questionOnly = {
	summary: { text: "", claims: [] },
	questions: [{ id: "clarify", prompt: "What work would you like to highlight?", evidenceIds: [] }],
	notes: [],
};
const safeVerdict = {
	schemaVersion: 1,
	verdicts: [],
	retention: null,
	absence: [],
	coverage: { status: "complete", reason: "Checked the complete summary, question and notes." },
	premises: [{ id: "question:clarify", verdict: "no_candidate_premise", reason: "Open question with no assertions." }],
	quality: { status: "no_change_needed", reason: "Clarification is appropriate." },
};

it("rejects a summary response with no summary, question or no-change explanation", () => {
	expect(() => validateVariantOutput(snapshot, { ...questionOnly, questions: [] })).toThrow("SUMMARY_EMPTY_RESPONSE");
});

it("keeps safe question-only summaries in the full-response verification input", () => {
	expect(validateVariantOutput(snapshot, questionOnly)).toMatchObject({ kind: "review.summary", output: questionOnly });
	const payload = buildVariantVerificationPayload(snapshot, questionOnly);
	const response = payload.selections.find((entry) => "id" in entry && entry.id === "variant-response");
	const task = payload.selections.find((entry) => "id" in entry && entry.id === "variant-verification-task");
	expect(JSON.parse(response?.text ?? "null")).toEqual(questionOnly);
	expect(JSON.parse(task?.text ?? "null")).toMatchObject({
		claims: [],
		premises: [{ id: "question:clarify", text: questionOnly.questions[0]?.prompt }],
		retention: false,
	});
	expect(() => assertVariantVerification(snapshot, questionOnly, safeVerdict)).not.toThrow();
});

it("allows independently checked no-change notes without summary claims", () => {
	const output = { ...questionOnly, questions: [], notes: ["No summary change is needed."] };
	expect(validateVariantOutput(snapshot, output)).toMatchObject({ output });
	expect(() =>
		assertVariantVerification(snapshot, output, {
			...safeVerdict,
			premises: [{ id: "note:0", verdict: "no_candidate_premise", reason: "Procedural no-change explanation." }],
		}),
	).not.toThrow();
});

it.each(["unsupported", "contradicted", "unclear"])(
	"withholds %s question premises despite no-change quality",
	(verdict) => {
		expect(() =>
			assertVariantVerification(snapshot, questionOnly, {
				...safeVerdict,
				premises: [{ id: "question:clarify", verdict, reason: "Unsupported candidate premise." }],
			}),
		).toThrow("AI_VERIFICATION_FAILED");
	},
);

it("requires full coverage and exact question IDs even with no summary claims", () => {
	expect(() => assertVariantVerification(snapshot, questionOnly, { ...safeVerdict, premises: [] })).toThrow(
		"AI_VERIFICATION_INCOMPLETE",
	);
	expect(() =>
		assertVariantVerification(snapshot, questionOnly, {
			...safeVerdict,
			coverage: { status: "unclear", reason: "Incomplete review." },
		}),
	).toThrow("AI_VERIFICATION_FAILED");
});

it("still rejects question citations outside selected CV evidence", () => {
	expect(() =>
		validateVariantOutput(snapshot, {
			...questionOnly,
			questions: [{ ...questionOnly.questions[0], evidenceIds: ["job-only"] }],
		}),
	).toThrow("AI_INVALID_EVIDENCE");
});
