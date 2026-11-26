import type { ReviewSourceSnapshot } from "./review-sources";
import type { OperationHandler } from "./route-policy";
import type { OwnerTransaction } from "@reactive-resume/db/owner-scope";
import type { OperationRequest } from "@reactive-resume/schema/ai-operation";
import type { ReviewResult } from "@reactive-resume/schema/resume/ai-review";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import {
	reviewSystemPrompt,
	extractionReviewSystemPrompt,
	reviewVerifierPrompt,
	reviewExtractionVerifierPrompt,
} from "@reactive-resume/ai/prompts";
import { withOwnerDatabase } from "@reactive-resume/db/owner-scope";
import { resume } from "@reactive-resume/db/schema";
import { proposalStart, readTarget, splitBlocks } from "@reactive-resume/resume/proposals";
import {
	hashReviewTarget,
	repeatsUntouchedReviewPassage,
	replaceReviewPassageText,
} from "@reactive-resume/resume/review-evidence";
import { masterFields } from "@reactive-resume/schema/career-master";
import {
	claimsCoverText,
	reviewClaimsSchema,
	reviewCandidateSchema,
	reviewTargetSchema,
} from "@reactive-resume/schema/resume/ai-review";
import { parseResumeDataForWrite } from "@reactive-resume/schema/resume/write";
import { uiLocaleSchema } from "@reactive-resume/utils/locale";
import { buildModelPayload, resumeContactValues } from "./payload";
import { filterExtractionProvenance, type ExtractionWithholding } from "./review-provenance";
import {
	boundQuestionEvidence,
	reviewEvidenceSelection,
	loadReviewSource,
	loadBoundReviewAnswer,
	prepareResumeReviewInTransaction,
	reviewPassageId,
	sameReviewSource,
} from "./review-sources";
import { parseReviewResultForSource, validateReviewResult } from "./review-validation";
import {
	reviewVerifierSchema,
	buildVerificationPayload,
	buildWordingVerifierSchema,
	buildExtractionVerifierSchema,
	filterReviewVerification,
	filterExtractionVerification,
	extractionVerifierSchema,
} from "./review-verifier";

const id = z.string().min(1).max(200);
const plain = z
	.string()
	.trim()
	.min(1)
	.max(4000)
	.refine((text) => !/<[^>]*>/u.test(text), "Plain text required");
export const wordingParameters = z.strictObject({
	resumeId: id,
	targets: z.array(reviewTargetSchema).min(1).max(10),
	action: z.enum(["review", "verb", "shorter", "result", "custom"]),
	request: z.string().trim().min(1).max(500).optional(),
	answerIds: z.array(id).max(9).optional(),
	continuationOf: id.optional(),
	interfaceLocale: uiLocaleSchema.optional(),
});
const extractionParameters = z.strictObject({ sourceId: id, interfaceLocale: uiLocaleSchema.optional() });
const question = z.strictObject({
	id,
	passageId: id.nullable(),
	prompt: plain.describe("Question for the user in the requested interface language."),
	evidenceIds: z.array(id).min(1).max(50),
});
const wordingOutput = z.strictObject({
	proposals: z
		.array(
			z
				.strictObject({
					id,
					passageId: id,
					text: plain,
					reason: plain,
					evidenceIds: z.array(id).min(1).max(50),
					claims: reviewClaimsSchema,
				})
				.refine((p) => claimsCoverText(p.text, p.claims), "Uncited proposed text"),
		)
		.max(50),
	questions: z.array(question).max(20),
	notes: z.array(z.string().max(4000)).max(20),
});
const extractionOutput = z.strictObject({
	candidates: z.array(reviewCandidateSchema).max(100),
	questions: z.array(question).max(20),
});

async function snapshot(
	tx: OwnerTransaction,
	ownerId: string,
	request: OperationRequest,
): Promise<ReviewSourceSnapshot> {
	if (request.kind === "review.extraction") {
		const parameters = extractionParameters.parse(request.parameters);
		const source = request.sources[0];
		if (!source || request.sources.length !== 1 || source.kind !== "import" || source.id !== parameters.sourceId)
			throw new Error("AI_SOURCE_BINDING");
		return loadReviewSource(tx, ownerId, source);
	}
	const parameters = wordingParameters.parse(request.parameters);
	if (new Set(parameters.answerIds ?? []).size !== (parameters.answerIds ?? []).length)
		throw new Error("AI_SOURCE_BINDING");
	const source = request.sources.find((source) => source.kind === "resume" && source.id === parameters.resumeId);
	if (!source) throw new Error("AI_SOURCE_BINDING");
	const prepared = await prepareResumeReviewInTransaction(tx, ownerId, {
		resumeId: parameters.resumeId,
		expectedUpdatedAt: source.revision,
		targets: parameters.targets,
	});
	const expected = [...prepared.sources];
	const evidence = [...prepared.evidence];
	for (const answerId of parameters.answerIds ?? []) {
		const answer = request.sources.find((source) => source.kind === "answer" && source.id === answerId);
		if (!answer) throw new Error("AI_SOURCE_BINDING");
		const loaded = await loadBoundReviewAnswer(
			tx,
			ownerId,
			answer,
			source,
			parameters.targets,
			Boolean(parameters.continuationOf),
		);
		expected.push(answer);
		evidence.push(...loaded.evidence);
	}
	if (
		expected.length !== request.sources.length ||
		expected.some((source) => !request.sources.some((bound) => sameReviewSource(source, bound)))
	)
		throw new Error("AI_SOURCE_BINDING");
	const selectedEvidence =
		parameters.action === "result" && !parameters.answerIds?.length ? boundQuestionEvidence(evidence) : evidence;
	return {
		source,
		evidence: selectedEvidence,
		selections: selectedEvidence.map(reviewEvidenceSelection),
		expiresAt: null,
		partial: false,
	};
}

const makeHandler = (kind: "review.wording" | "review.extraction"): OperationHandler => ({
	verifier: {
		output: reviewVerifierSchema,
		...(kind === "review.wording" ? { outputForPayload: buildWordingVerifierSchema } : {}),
		systemPrompt: reviewVerifierPrompt,
		buildInput: buildVerificationPayload,
		validate: filterReviewVerification,
	},
	promptVersion: kind === "review.wording" ? "t006-wording-v7-passages" : "t006-extraction-v5",
	schemaVersion: "t006-review-v3",
	parameters: kind === "review.wording" ? wordingParameters : extractionParameters,
	output: kind === "review.wording" ? wordingOutput : extractionOutput,
	systemPrompt:
		kind === "review.wording"
			? reviewSystemPrompt
			: `${extractionReviewSystemPrompt}\nExtraction field contract: ${JSON.stringify(Object.fromEntries(Object.entries(masterFields).map(([section, schema]) => [section, Object.keys(schema.shape)])))}`,
	resultState: "waiting_review",
	buildInput: (ownerId, request) =>
		withOwnerDatabase(ownerId, async (tx) => {
			const loaded = await snapshot(tx, ownerId, request);
			let contactValues: string[] = [];
			if (kind === "review.wording") {
				const parameters = wordingParameters.parse(request.parameters);
				const [document] = await tx
					.select({ data: resume.data })
					.from(resume)
					.where(and(eq(resume.userId, ownerId), eq(resume.id, parameters.resumeId)));
				if (!document) throw new Error("AI_SOURCE_BINDING");
				contactValues = resumeContactValues(parseResumeDataForWrite(document.data));
				loaded.selections.push({
					id: "intent",
					kind: "user_supplied",
					section: "summary",
					text: `${parameters.action}${parameters.request ? `: ${parameters.request}` : ""}`,
				});
			}
			return { selections: loaded.selections, contactValues };
		}),
	validateResult: async (tx, ownerId, request, raw) => {
		const loaded = await snapshot(tx, ownerId, request);
		const evidence = new Map(loaded.evidence.map((entry) => [entry.id, entry]));
		const output = kind === "review.wording" ? wordingOutput.parse(raw) : extractionOutput.parse(raw);
		const common = {
			schemaVersion: 2 as const,
			sourceRevision: loaded.source,
			evidence: loaded.evidence,
			questions: output.questions.map((question) => {
				const target = question.passageId === null ? null : evidence.get(question.passageId)?.target;
				if (target === undefined) throw new Error("AI_INVALID_PASSAGE");
				return { id: question.id, target, prompt: question.prompt, evidenceIds: question.evidenceIds };
			}),
		};
		let result: ReviewResult;
		if ("proposals" in output) {
			const parameters = wordingParameters.parse(request.parameters);
			if (parameters.action === "result" && !parameters.answerIds?.length && output.proposals.length)
				throw new Error("AI_MISSING_OUTCOME");
			const [row] = await tx
				.select()
				.from(resume)
				.where(and(eq(resume.userId, ownerId), eq(resume.id, loaded.source.id)));
			if (!row) throw new Error("AI_SOURCE_CHANGED");
			const data = parseResumeDataForWrite(row.data);
			result = {
				...common,
				kind: "wording",
				notes: output.notes,
				proposals: output.proposals.map((proposal) => {
					const entry = evidence.get(proposal.passageId);
					if (
						!entry?.target ||
						entry.confirmation !== "confirmed" ||
						entry.source.kind !== "resume" ||
						!proposal.evidenceIds.includes(entry.id)
					)
						throw new Error("AI_INVALID_PASSAGE");
					const target = entry.target;
					const value = readTarget(data, target);
					if (value === undefined) throw new Error("AI_INVALID_PASSAGE");
					const blocks = splitBlocks(value);
					const citedPassages = new Set(
						proposal.evidenceIds.filter((id) => evidence.get(id)?.source.kind === "resume"),
					);
					const selected = blocks.flatMap((block, index) =>
						citedPassages.has(reviewPassageId(loaded.source, target, block.html, index)) ? [{ block, index }] : [],
					);
					const first = selected[0];
					const last = selected.at(-1);
					if (
						!first ||
						!last ||
						selected.length !== citedPassages.size ||
						last.index - first.index + 1 !== selected.length ||
						reviewPassageId(loaded.source, target, first.block.html, first.index) !== proposal.passageId
					)
						throw new Error("AI_INVALID_MARKUP");
					const start = proposalStart(value, { before: first.block.html, blockIndex: first.index });
					const end =
						proposalStart(value, { before: last.block.html, blockIndex: last.index }) + last.block.html.length;
					const before = value.slice(start, end);
					let after: string;
					try {
						after = replaceReviewPassageText(before, proposal.text);
					} catch {
						throw new Error("AI_INVALID_MARKUP");
					}
					if (before !== after && repeatsUntouchedReviewPassage(value, { before, after, blockIndex: first.index }))
						throw new Error("AI_INVALID_MARKUP");
					return {
						schemaVersion: 2,
						id: proposal.id,
						target,
						location: entry.target.sectionId,
						before,
						blockIndex: first.index,
						after,
						why: proposal.reason,
						status: "pending",
						source: "improve",
						base: loaded.source,
						targetHash: hashReviewTarget(value),
						evidenceIds: proposal.evidenceIds,
						claims: proposal.claims,
					};
				}),
			};
		} else result = { ...common, kind: "extraction", candidates: output.candidates };
		return validateReviewResult(loaded, result, uiLocaleSchema.safeParse(request.parameters.interfaceLocale).success);
	},
});

/** Explicit server composition only; the default runtime remains closed. */
export const reviewHandlers: Readonly<Record<"review.wording" | "review.extraction", OperationHandler>> = {
	"review.wording": makeHandler("review.wording"),
	"review.extraction": makeHandler("review.extraction"),
};

function extractionResult(loaded: ReviewSourceSnapshot, raw: Record<string, unknown>) {
	const output = extractionOutput.parse(raw);
	if (output.questions.some((question) => question.passageId !== null)) throw new Error("AI_INVALID_PASSAGE");
	const questionIds = new Set(output.questions.map(({ id }) => `question:${id}`));
	if (output.candidates.some(({ id }) => questionIds.has(id))) throw new Error("AI_DUPLICATE_SUBJECT");
	const result = parseReviewResultForSource(loaded, {
		schemaVersion: 2,
		kind: "extraction",
		sourceRevision: loaded.source,
		evidence: loaded.evidence,
		candidates: output.candidates,
		questions: output.questions.map(({ id, prompt, evidenceIds }) => ({ id, target: null, prompt, evidenceIds })),
	});
	if (result.kind !== "extraction") throw new Error("AI_INVALID_EXTRACTION");
	return { result, output };
}

export async function prepareExtractionVerification(
	tx: OwnerTransaction,
	ownerId: string,
	request: OperationRequest,
	raw: Record<string, unknown>,
): Promise<{ output: Record<string, unknown>; withheld: ExtractionWithholding[] }> {
	return prepareExtractionFromSnapshot(await snapshot(tx, ownerId, request), raw);
}

export function prepareExtractionFromSnapshot(loaded: ReviewSourceSnapshot, raw: Record<string, unknown>) {
	const { result, output } = extractionResult(loaded, raw);
	const { keptIds, withheld } = filterExtractionProvenance(loaded, result);
	const kept = new Set(keptIds);
	const candidates = output.candidates.filter((candidate) => kept.has(candidate.id));
	if (!candidates.some((candidate) => candidate.value !== null) && !output.questions.length)
		throw new Error(withheld[0]?.reason ?? "AI_UNSUPPORTED_CLAIM");
	return { output: { ...output, candidates }, withheld };
}

export const extractionCandidateHandler: OperationHandler = {
	...reviewHandlers["review.extraction"],
	promptVersion: "extraction-v7-source-span-verification",
	schemaVersion: "extraction-v5-selective-delivery",
	validateCandidate: async (tx, ownerId, request, raw) =>
		(await prepareExtractionVerification(tx, ownerId, request, raw)).output,
	validateDelivery: async (tx, ownerId, request, raw) => {
		const { result } = extractionResult(await snapshot(tx, ownerId, request), raw);
		if (!result.candidates.some((candidate) => candidate.value !== null) && !result.questions.length)
			throw new Error("AI_UNSUPPORTED_CLAIM");
		return result;
	},
	verifier: {
		output: extractionVerifierSchema,
		outputForPayload: buildExtractionVerifierSchema,
		systemPrompt: reviewExtractionVerifierPrompt,
		buildInput: buildVerificationPayload,
		validate: filterExtractionVerification,
		buildInputInContext: async (tx, ownerId, request, raw) => {
			const loaded = await snapshot(tx, ownerId, request);
			const prepared = prepareExtractionFromSnapshot(loaded, raw);
			return buildVerificationPayload(
				buildModelPayload({ selections: loaded.selections, contactValues: [] }, true),
				prepared.output,
			);
		},
		validateInContext: async (tx, ownerId, request, raw, verdict) => {
			const prepared = await prepareExtractionVerification(tx, ownerId, request, raw);
			const filtered = filterExtractionVerification(prepared.output, verdict);
			const items = [...prepared.withheld, ...(filtered.withheld?.items ?? [])];
			const rules = [
				...new Set([...prepared.withheld.map((item) => item.reason), ...(filtered.withheld?.rules ?? [])]),
			];
			return { output: filtered.output, ...(items.length ? { withheld: { count: items.length, items, rules } } : {}) };
		},
	},
};
