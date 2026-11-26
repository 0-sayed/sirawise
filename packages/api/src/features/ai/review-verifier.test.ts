import type { ReviewCandidate } from "@reactive-resume/schema/resume/ai-review";
import { describe, expect, it } from "vite-plus/test";
import { reviewCandidateSchema, splitReviewClaims } from "@reactive-resume/schema/resume/ai-review";
import { assertHardFacts } from "./hard-facts";
import { buildModelPayload } from "./payload";
import { reviewHandlers } from "./review-handlers";
import { filterExtractionProvenance } from "./review-provenance";
import {
	assertVerification,
	buildVerificationPayload,
	filterExtractionVerification,
	filterReviewVerification,
	reviewVerifierSchema,
} from "./review-verifier";
import { loadSafetyCases } from "./testing/pipeline-safety-fixtures";

const extractionCases = loadSafetyCases<{
	id: string;
	source: { section: ReviewCandidate["section"]; text: string };
	candidate: {
		candidates?: unknown[];
		proposals?: Array<{ id: string; text: string; claims: ReturnType<typeof splitReviewClaims> }>;
		questions: Array<{ id: string; prompt: string; evidenceIds: string[] }>;
	};
}>("extraction");

it.each(extractionCases.inputs)("checks the fixed extraction and wording case $id", (input) => {
	const label = extractionCases.labels.find(({ id }) => id === input.id);
	if (!label) throw new Error(`Missing labels for ${input.id}`);
	if (!input.candidate.candidates) {
		const [proposal] = input.candidate.proposals ?? [];
		if (!proposal) throw new Error("Missing wording control");
		const draft = { proposals: [proposal] };
		expect(() => assertHardFacts(input.source.text, proposal.text, input.source.text)).not.toThrow();
		expect(() =>
			assertVerification(draft, {
				schemaVersion: 3,
				responseAssessment: { status: "appropriate", reason: "Synthetic assessment." },
				factRetention: { status: "lost", evidenceIds: ["selected"], reason: "The proposal omits a duty." },
				verdicts: [{ claimId: "wording/claim-1", evidenceIds: ["selected"], verdict: "supported", reason: "Cited." }],
			}),
		).toThrow(label.caught[0]?.issueClass);
		return;
	}
	const source = { kind: "import", id: input.id, revision: "synthetic" } as const;
	const evidence = [
		{
			id: "selected",
			source,
			quote: input.source.text,
			target: null,
			factId: null,
			factRevision: null,
			confirmation: "source_unconfirmed" as const,
		},
	];
	const selections = [
		{ id: "selected", kind: "unconfirmed_source" as const, text: input.source.text, section: input.source.section },
	];
	const candidates = input.candidate.candidates.map((candidate) => reviewCandidateSchema.parse(candidate));
	const questions = input.candidate.questions ?? [];
	const { keptIds, withheld } = filterExtractionProvenance(
		{ source, evidence, selections, expiresAt: null, partial: false },
		{
			schemaVersion: 2,
			kind: "extraction",
			sourceRevision: source,
			evidence,
			candidates,
			questions: questions.map(({ id, prompt, evidenceIds }) => ({ id, prompt, evidenceIds, target: null })),
		},
	);
	expect(withheld.map(({ id, reason }) => ({ itemId: id, issueClass: reason, stage: "deterministic" }))).toEqual(
		label.caught.filter(({ stage }) => stage === "deterministic"),
	);
	if (label.mode === "deterministic") {
		expect(keptIds).toEqual([]);
		expect(questions).toEqual([]);
		return;
	}
	const draft = { candidates: candidates.filter(({ id }) => keptIds.includes(id)), questions };
	const payload = buildVerificationPayload(buildModelPayload({ selections, contactValues: [] }), draft);
	const claims: Array<{ claimId: string; evidenceIds: string[] }> = JSON.parse(
		payload.selections.find((item) => "id" in item && item.id === "verification-claims")?.text ?? "[]",
	);
	const filtered = filterExtractionVerification(draft, {
		schemaVersion: 3,
		responseAssessment: { status: "appropriate", reason: "Synthetic assessment." },
		factRetention: { status: "retained", evidenceIds: ["selected"], reason: "All field facts retained." },
		verdicts: claims.map(({ claimId, evidenceIds }) => ({
			claimId,
			evidenceIds,
			reason: "Synthetic verdict.",
			verdict: label.caught.some(({ itemId, stage }) => itemId === claimId && stage === "semantic")
				? "unsupported"
				: "supported",
		})),
	});
	expect(
		filtered.withheld?.items?.map(({ id, reason }) => ({ itemId: id, issueClass: reason, stage: "semantic" })) ?? [],
	).toEqual(label.caught.filter(({ stage }) => stage === "semantic"));
	const output = filtered.output as typeof draft;
	expect([...output.candidates.map(({ id }) => id), ...output.questions.map(({ id }) => `question:${id}`)]).toEqual(
		label.retainedIds,
	);
});
const output = {
	proposals: [
		{ id: "p", text: "Coordinated appointments.", claims: splitReviewClaims("Coordinated appointments.", ["s1"]) },
	],
};
const verdict = {
	schemaVersion: 3,
	responseAssessment: { status: "appropriate", reason: "The response addresses the task." },
	factRetention: { status: "retained", evidenceIds: ["s1"], reason: "All supplied factual duties remain." },
	verdicts: [
		{ claimId: "p/claim-1", verdict: "supported", evidenceIds: ["s1"], reason: "The scheduling duty is explicit." },
	],
};
it("requires explicit retention even when every proposed claim is supported", () => {
	expect(() =>
		assertVerification(output, {
			...verdict,
			schemaVersion: 3,
			responseAssessment: { status: "appropriate", reason: "The response addresses the task." },
			factRetention: { status: "lost", evidenceIds: ["s1"], reason: "A supplied duty was omitted." },
		}),
	).toThrow("AI_FACT_RETENTION_FAILED");
});
it("labels generated claims as model proposals and flags outcome relationships", () => {
	const payload = buildVerificationPayload(
		{ selections: [{ id: "s1", kind: "confirmed_content", section: "summary", text: "Maintained inspection logs." }] },
		{ proposals: [{ id: "p", claims: splitReviewClaims("Maintained logs, thereby eliminating defects.", ["s1"]) }] },
	);
	expect(payload.selections.find((s) => "id" in s && s.id === "verification-claims")).toMatchObject({
		kind: "model_proposed",
	});
	expect(
		JSON.parse(payload.selections.find((s) => "id" in s && s.id === "verification-claims")?.text ?? "[]")[0]
			?.claimKinds,
	).toContain("outcome");
});
describe("independent verifier contract", () => {
	it("accepts complete, supported, cited verdicts", () =>
		expect(() => assertVerification(output, verdict)).not.toThrow());
	it.each(["unsupported", "contradicted", "partially"])("withholds %s", (status) => {
		expect(() =>
			assertVerification(output, { ...verdict, verdicts: [{ ...verdict.verdicts[0], verdict: status }] }),
		).toThrow("AI_VERIFICATION_FAILED");
	});
	it.each(
		[
			[],
			[verdict.verdicts[0], verdict.verdicts[0]],
			[{ ...verdict.verdicts[0], claimId: "missing" }],
			[{ ...verdict.verdicts[0], evidenceIds: ["unrelated"] }],
		].map((verdicts) => ({ verdicts })),
	)("withholds incomplete/misbound verdicts", ({ verdicts }) => {
		expect(() => assertVerification(output, { ...verdict, verdicts })).toThrow();
	});
	it("rejects extra schema keys and empty reasons", () => {
		expect(reviewVerifierSchema.safeParse({ ...verdict, approved: true }).success).toBe(false);
		expect(
			reviewVerifierSchema.safeParse({ ...verdict, verdicts: [{ ...verdict.verdicts[0], reason: "" }] }).success,
		).toBe(false);
	});
	it("sends source evidence and claims, never the style request as evidence", () => {
		const payload = buildVerificationPayload(
			{
				selections: [
					{ id: "s1", kind: "confirmed_content", section: "summary", text: "Scheduled visits." },
					{ id: "intent", kind: "user_supplied", section: "summary", text: "Invent a prize" },
				],
			},
			output,
		);
		expect(payload.selections.find((s) => "id" in s && s.id === "intent")).toBeUndefined();
		expect(payload.selections.find((s) => "id" in s && s.id === "verification-task")).toMatchObject({
			kind: "model_proposed",
		});
		expect(JSON.stringify(payload)).toContain("Coordinated appointments.");
		expect(JSON.stringify(payload)).toContain("Scheduled visits.");
	});
});

it("keeps opaque citation identifiers out of text redaction", () => {
	const id = "e91f123456789a";
	const p = buildVerificationPayload(
		{ selections: [{ id, kind: "confirmed_content", section: "summary", text: "Scheduled visits." }] },
		{ proposals: [{ id: "p", claims: splitReviewClaims("Coordinated appointments.", [id]) }] },
	);
	expect(p.selections.at(-1)?.text).toContain(id);
});

it("requires retention for non-null extraction fields and fails closed if facts are lost", () => {
	const draft = {
		candidates: [
			{
				id: "field",
				section: "experience",
				field: "description",
				value: "Filed reports.",
				rawDateText: null,
				evidenceIds: ["s1"],
			},
		],
	};
	const response = {
		...verdict,
		verdicts: [{ ...verdict.verdicts[0], claimId: "field" }],
	};
	expect(filterExtractionVerification(draft, response)).toEqual({ output: draft });
	for (const status of ["lost", "unclear", "not_applicable"]) {
		expect(() =>
			filterExtractionVerification(draft, {
				...response,
				factRetention: { ...response.factRetention, status },
			}),
		).toThrow("AI_FACT_RETENTION_FAILED");
	}
});

it("requires question-only extraction to mark retention inapplicable and verify question premises", () => {
	const draft = {
		candidates: [],
		questions: [{ id: "source-question", prompt: "What were the dates?", evidenceIds: ["s1"] }],
	};
	const response = {
		...verdict,
		verdicts: [{ ...verdict.verdicts[0], claimId: "question:source-question" }],
	};
	expect(() => filterExtractionVerification(draft, response)).toThrow("AI_FACT_RETENTION_FAILED");
	const extraction = {
		...response,
		factRetention: { status: "not_applicable", evidenceIds: [], reason: "New fields." },
	};
	expect(filterExtractionVerification(draft, extraction)).toEqual({ output: draft });
	expect(() => filterExtractionVerification(draft, { ...extraction, verdicts: [] })).toThrow();
	expect(() =>
		filterExtractionVerification(draft, {
			...extraction,
			verdicts: [{ ...extraction.verdicts[0], verdict: "unsupported" }],
		}),
	).toThrow();
});

it("sends questions, no-change notes and task context as non-evidence", () => {
	const payload = buildVerificationPayload(
		{
			selections: [
				{ id: "s1", kind: "confirmed_content", section: "summary", text: "Filed reports." },
				{ id: "intent", kind: "user_supplied", section: "summary", text: "Use past tense." },
			],
		},
		{
			proposals: [],
			questions: [{ id: "q", passageId: "s1", prompt: "How many reports?", evidenceIds: ["s1"] }],
			notes: ["Already past tense."],
		},
	);
	expect(payload.selections.find((s) => "id" in s && s.id === "verification-response")?.text).toContain(
		"How many reports?",
	);
	expect(payload.selections.find((s) => "id" in s && s.id === "verification-response")?.text).toContain(
		"Already past tense.",
	);
	expect(payload.selections.find((s) => "id" in s && s.id === "verification-task")?.text).toContain("Use past tense.");
	expect(payload.selections.some((s) => "id" in s && s.id === "intent")).toBe(false);
});

it("accepts an independently justified no-edit answer with inapplicable retention", () => {
	expect(() =>
		assertVerification(
			{ proposals: [], questions: [], notes: ["Already past tense."] },
			{
				schemaVersion: 3,
				factRetention: { status: "not_applicable", evidenceIds: [], reason: "No edit proposed." },
				responseAssessment: { status: "appropriate", reason: "The selected text is already past tense." },
				verdicts: [],
			},
		),
	).not.toThrow();
});

it("keeps redundant question quality advisory and withholds lost facts", () => {
	const v = {
		schemaVersion: 3,
		factRetention: { status: "not_applicable", evidenceIds: [], reason: "No edit." },
		responseAssessment: { status: "inappropriate", reason: "Question asks for supplied information." },
		verdicts: [],
	};
	expect(() =>
		assertVerification(
			{ proposals: [], questions: [{ id: "q", prompt: "Which role?", evidenceIds: ["s1"] }], notes: [] },
			{
				...v,
				verdicts: [
					{
						claimId: "question:q",
						verdict: "supported",
						evidenceIds: ["s1"],
						reason: "Only a question, no invented premise.",
					},
				],
			},
		),
	).not.toThrow();
	expect(() =>
		assertVerification(output, {
			...v,
			factRetention: { ...v.factRetention, status: "lost" },
			responseAssessment: { status: "appropriate", reason: "Task addressed." },
		}),
	).toThrow("AI_FACT_RETENTION_FAILED");
});

it.each(["inappropriate", "unclear", "no_change_needed"])(
	"keeps %s quality advisory for supported retained edits",
	(status) => {
		expect(() =>
			assertVerification(output, { ...verdict, responseAssessment: { status, reason: "Scope advisory." } }),
		).not.toThrow();
	},
);
it("requires retained facts independently of the advisory quality gate", () => {
	expect(() =>
		assertVerification(output, {
			...verdict,
			factRetention: { status: "not_applicable", evidenceIds: [], reason: "No lost facts." },
		}),
	).toThrow("AI_FACT_RETENTION_FAILED");
});
it("includes every extraction candidate and proposal in the minimized non-evidence response", () => {
	const candidates = [
		{
			id: "school",
			entityId: "edu-1",
			section: "education",
			field: "school",
			value: "Sample College",
			rawDateText: null,
			evidenceIds: ["s1"],
		},
		{
			id: "degree",
			entityId: "edu-1",
			section: "education",
			field: "degree",
			value: null,
			rawDateText: null,
			evidenceIds: ["s1"],
		},
	];
	const source = {
		selections: [{ id: "s1", kind: "confirmed_content" as const, section: "summary" as const, text: "Sample College" }],
	};
	const response = (value: Record<string, unknown>) =>
		JSON.parse(
			buildVerificationPayload(source, value).selections.find((s) => "id" in s && s.id === "verification-response")
				?.text ?? "{}",
		);
	expect(response({ candidates, questions: [] }).candidates).toEqual(candidates);
	expect(response(output).proposals).toMatchObject([{ id: "p", text: "Coordinated appointments." }]);
});
it("permits an explicitly bounded extraction verifier completion allowance", async () => {
	const { completionTokenLimit } = await import("./route-policy");
	expect(completionTokenLimit({ maxOutputTokens: 4096, reasoningEffort: "low", completionTokenCap: 12288 })).toBe(
		12288,
	);
	expect(() =>
		completionTokenLimit({ maxOutputTokens: 4096, reasoningEffort: "low", completionTokenCap: 12289 }),
	).toThrow("AI_INVALID_OUTPUT_LIMIT");
});

it("requires independent safety support for question premises even when quality is appropriate", () => {
	const questions = {
		proposals: [],
		questions: [{ id: "q1", prompt: "How did you lead 40 engineers?", evidenceIds: ["s1"] }],
		notes: [],
	};
	const v = {
		schemaVersion: 3,
		responseAssessment: { status: "appropriate", reason: "Relevant topic." },
		factRetention: { status: "not_applicable", evidenceIds: [], reason: "No edits." },
		verdicts: [],
	};
	expect(() => assertVerification(questions, v)).toThrow("AI_VERIFICATION_INCOMPLETE");
	expect(() =>
		assertVerification(questions, {
			...v,
			verdicts: [
				{
					claimId: "question:q1",
					verdict: "unsupported",
					evidenceIds: ["s1"],
					reason: "The premise invents team leadership.",
				},
			],
		}),
	).toThrow("AI_VERIFICATION_FAILED");
	expect(() =>
		assertVerification(questions, {
			...v,
			verdicts: [
				{
					claimId: "question:q1",
					verdict: "supported",
					evidenceIds: ["s1"],
					reason: "Only missing information requested; no asserted premise.",
				},
			],
		}),
	).not.toThrow();
});

it("rejects not_applicable retention for actual edits despite supported claims", () => {
	expect(() =>
		assertVerification(output, {
			...verdict,
			factRetention: { status: "not_applicable", evidenceIds: [], reason: "No retention assessment." },
		}),
	).toThrow("AI_FACT_RETENTION_FAILED");
});

it("does not fail extraction candidates on factRetention when every extracted candidate is supported", () => {
	const extractionOutput = {
		candidates: [
			{
				id: "c1",
				entityId: "exp-1",
				section: "experience",
				field: "company",
				value: "BandAI",
				rawDateText: null,
				evidenceIds: ["s1"],
				confirmation: "needs_review",
			},
			{
				id: "c2",
				entityId: "exp-1",
				section: "experience",
				field: "position",
				value: "Senior Software Engineer",
				rawDateText: null,
				evidenceIds: ["s1"],
				confirmation: "needs_review",
			},
		],
		questions: [],
	};
	const extractionVerdict = {
		schemaVersion: 3,
		responseAssessment: { status: "appropriate", reason: "Supported extracted fields." },
		factRetention: { status: "lost", evidenceIds: ["s1"], reason: "Omitted trailing unselected bullet." },
		verdicts: [
			{ claimId: "c1", verdict: "supported", evidenceIds: ["s1"], reason: "Employer matches source." },
			{ claimId: "c2", verdict: "supported", evidenceIds: ["s1"], reason: "Title matches source." },
		],
	};
	expect(() => assertVerification(extractionOutput, extractionVerdict)).toThrow("AI_FACT_RETENTION_FAILED");
	expect(() => filterReviewVerification(extractionOutput, extractionVerdict)).toThrow("AI_FACT_RETENTION_FAILED");
	extractionVerdict.factRetention = { status: "retained", evidenceIds: ["s1"], reason: "Selected fields retained." };
	expect(() => assertVerification(extractionOutput, extractionVerdict)).not.toThrow();
	expect(() =>
		assertVerification(extractionOutput, {
			...extractionVerdict,
			verdicts: [
				extractionVerdict.verdicts[0],
				{ claimId: "c2", verdict: "unsupported", evidenceIds: ["s1"], reason: "Invented title." },
			],
		}),
	).toThrow("AI_VERIFICATION_FAILED");

	const partialExtraction = filterReviewVerification(extractionOutput, {
		...extractionVerdict,
		verdicts: [
			extractionVerdict.verdicts[0],
			{ claimId: "c2", verdict: "unsupported", evidenceIds: ["s1"], reason: "Invented title." },
		],
	});
	expect(partialExtraction.output.candidates).toEqual([extractionOutput.candidates[0]]);
	expect(partialExtraction.withheld).toEqual({
		count: 1,
		rules: ["AI_VERIFICATION_CLAIM_SUPPORT"],
		items: [{ id: "c2", field: "position", section: "experience", reason: "AI_VERIFICATION_CLAIM_SUPPORT" }],
	});
	expect(() =>
		filterReviewVerification(extractionOutput, {
			...extractionVerdict,
			verdicts: [
				{ claimId: "c1", verdict: "unsupported", evidenceIds: ["s1"], reason: "Invented employer." },
				{ claimId: "c2", verdict: "unsupported", evidenceIds: ["s1"], reason: "Invented title." },
			],
		}),
	).toThrow("AI_VERIFICATION_FAILED");
});

it("withholds only rejected wording proposals while keeping verified proposals and global retention checks", () => {
	const multiWording = {
		proposals: [
			{
				id: "p1",
				passageId: "s1",
				text: "Maintained inspection logs.",
				reason: "Clearer",
				evidenceIds: ["s1"],
				claims: [{ id: "c1", text: "Maintained inspection logs.", evidenceIds: ["s1"] }],
			},
			{
				id: "p2",
				passageId: "s1",
				text: "Managed a team of 50.",
				reason: "Stronger",
				evidenceIds: ["s1"],
				claims: [{ id: "c1", text: "Managed a team of 50.", evidenceIds: ["s1"] }],
			},
		],
		questions: [],
		notes: [],
	};
	const multiVerdict = {
		...verdict,
		verdicts: [
			{ claimId: "p1/c1", verdict: "supported", evidenceIds: ["s1"], reason: "Supported." },
			{ claimId: "p2/c1", verdict: "unsupported", evidenceIds: ["s1"], reason: "Invented team size." },
		],
	};
	const filtered = filterReviewVerification(multiWording, multiVerdict);
	expect(filtered.output.proposals).toEqual([multiWording.proposals[0]]);
	expect(filtered.withheld).toEqual({
		count: 1,
		rules: ["AI_VERIFICATION_CLAIM_SUPPORT"],
		items: [{ id: "p2", reason: "AI_VERIFICATION_CLAIM_SUPPORT" }],
	});
	expect(() =>
		filterReviewVerification(multiWording, {
			...multiVerdict,
			factRetention: { ...verdict.factRetention, status: "lost" },
		}),
	).toThrow("AI_FACT_RETENTION_FAILED");
	expect(() =>
		filterReviewVerification(multiWording, {
			...multiVerdict,
			verdicts: multiVerdict.verdicts.map((v) => ({ ...v, verdict: "unsupported" })),
		}),
	).toThrow("AI_VERIFICATION_FAILED");
});

it("bounds the explicit benchmark allowance for realistic annotated letters", async () => {
	const { completionTokenLimit } = await import("./route-policy");
	expect(completionTokenLimit({ maxOutputTokens: 16384, reasoningEffort: "none" })).toBe(16384);
	expect(() => completionTokenLimit({ maxOutputTokens: 16385, reasoningEffort: "none" })).toThrow(
		"AI_INVALID_OUTPUT_LIMIT",
	);
});

it.each([
	["AI_VERIFICATION_CLAIM_SUPPORT", { ...verdict, verdicts: [{ ...verdict.verdicts[0], verdict: "unsupported" }] }],
	["AI_VERIFICATION_CLAIM_IDS", { ...verdict, verdicts: [] }],
	["AI_VERIFICATION_RETENTION", { ...verdict, factRetention: { ...verdict.factRetention, status: "lost" } }],
])("retains a precise private review rejection rule %s", async (rule, rejected) => {
	const { verificationFailureDetail } = await import("./verification-failure");
	try {
		assertVerification(output, rejected);
		throw new Error("Expected rejection");
	} catch (error) {
		expect(verificationFailureDetail(error)).toEqual({ rule });
	}
});

it("rejects unclear retention even for a supported question-only answer", () => {
	const questions = {
		proposals: [],
		questions: [{ id: "clarify", prompt: "Which work should be highlighted?", evidenceIds: ["s1"] }],
		notes: [],
	};
	expect(() =>
		assertVerification(questions, {
			...verdict,
			responseAssessment: { status: "unclear", reason: "Quality was not requested." },
			factRetention: { status: "unclear", evidenceIds: [], reason: "No edit exists to assess." },
			verdicts: [
				{
					claimId: "question:clarify",
					verdict: "supported",
					evidenceIds: ["s1"],
					reason: "Open question without invented facts.",
				},
			],
		}),
	).toThrow("AI_FACT_RETENTION_FAILED");
});

it("withholds only the extraction field with an explicitly scoped retention failure", () => {
	const candidates = [
		{ id: "company", section: "experience", field: "company", value: "Acme", rawDateText: null, evidenceIds: ["s1"] },
		{
			id: "description",
			section: "experience",
			field: "description",
			value: "Improved latency",
			rawDateText: null,
			evidenceIds: ["s1"],
		},
	];
	const verdict = {
		schemaVersion: 3,
		responseAssessment: { status: "appropriate", reason: "Selected source fields." },
		factRetention: {
			status: "lost",
			evidenceIds: ["s1"],
			reason: "The description drops a quantity.",
			failedClaimIds: ["description"],
		},
		verdicts: candidates.map(({ id, evidenceIds }) => ({
			claimId: id,
			evidenceIds,
			verdict: "supported",
			reason: "The proposed words are supported.",
		})),
	};
	expect(filterExtractionVerification({ candidates, questions: [] }, verdict)).toMatchObject({
		output: { candidates: [candidates[0]] },
		withheld: { count: 1, rules: ["AI_VERIFICATION_RETENTION"], items: [{ id: "description" }] },
	});
	expect(() =>
		filterExtractionVerification(
			{ candidates, questions: [] },
			{
				...verdict,
				factRetention: { ...verdict.factRetention, failedClaimIds: ["missing"] },
			},
		),
	).toThrow();
});

it("binds wording verdicts to the exact claim IDs and citations in the prepared task", () => {
	const payload = buildVerificationPayload(
		{ selections: [{ id: "s1", kind: "confirmed_content", section: "summary", text: "Filed reports." }] },
		{ proposals: [], questions: [{ id: "q", prompt: "How many reports?", evidenceIds: ["s1"] }] },
	);
	const schema = reviewHandlers["review.wording"].verifier?.outputForPayload?.(payload);
	const verdict = {
		schemaVersion: 3,
		responseAssessment: { status: "appropriate", reason: "Clear" },
		factRetention: { status: "not_applicable", reason: "Question only", evidenceIds: [] },
		verdicts: [{ claimId: "question:q", verdict: "supported", evidenceIds: ["s1"], reason: "Grounded" }],
	};
	expect(schema?.safeParse(verdict).success).toBe(true);
	expect(schema?.safeParse({ ...verdict, verdicts: [] }).success).toBe(false);
	expect(
		schema?.safeParse({
			...verdict,
			verdicts: [{ ...verdict.verdicts[0], claimId: "different" }],
		}).success,
	).toBe(false);
	expect(
		schema?.safeParse({
			...verdict,
			verdicts: [{ ...verdict.verdicts[0], evidenceIds: ["unrelated"] }],
		}).success,
	).toBe(false);
});
