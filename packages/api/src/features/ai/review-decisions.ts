import type { OwnerTransaction } from "@reactive-resume/db/owner-scope";
import type {
	ReviewAnswerInput,
	ReviewDecisionInput,
	ReviewDecisionView,
	ReviewEvidence,
	ReviewProposal,
	ReviewResult,
} from "@reactive-resume/schema/resume/ai-review";
import { createHash } from "node:crypto";
import { ORPCError } from "@orpc/client";
import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";
import { withOwnerDatabase } from "@reactive-resume/db/owner-scope";
import { aiOperation, aiReviewDecision, careerFact, resume } from "@reactive-resume/db/schema";
import { applyTo, readTarget, splitBlocks, writeTarget } from "@reactive-resume/resume/proposals";
import {
	applyReviewProposals,
	hasCompleteReviewScope,
	replaceReviewPassageText,
	reviewProposalPosition,
} from "@reactive-resume/resume/review-evidence";
import { splitReviewClaims } from "@reactive-resume/schema/resume/ai-review";
import {
	reviewAnswerInputSchema,
	reviewDecisionInputSchema,
	reviewQuestionDismissalSchema,
	reviewResultSchema,
	reviewTargetSchema,
} from "@reactive-resume/schema/resume/ai-review";
import { variantReviewResultSchema } from "@reactive-resume/schema/resume/variants";
import { parseResumeDataForWrite } from "@reactive-resume/schema/resume/write";
import { generateId } from "@reactive-resume/utils/string";
import { lockDocumentOwner } from "../documents/ownership";
import { notifyResumeUpdated, updateResumeTx } from "../resume/service";
import { writeVersion } from "../resume/version-history";
import { buildModelPayload, resumeContactValues } from "./payload";
import { loadReviewSource, lockReviewProfile, sameReviewSource } from "./review-sources";
import { canonicalJson } from "./route-policy";
import { loadVariantSnapshot } from "./variant-sources";

type Decision = typeof aiReviewDecision.$inferSelect;
type Statuses = ReviewDecisionView["statuses"];
const conflict = (reason = "AI_DECISION_CHANGED"): never => {
	throw new ORPCError("CONFLICT", { data: { reason } });
};
const fingerprint = (input: unknown) => createHash("sha256").update(canonicalJson(input)).digest("hex");
const decisionsFor = (tx: OwnerTransaction, ownerId: string, operationId: string) =>
	tx
		.select()
		.from(aiReviewDecision)
		.where(and(eq(aiReviewDecision.userId, ownerId), eq(aiReviewDecision.operationId, operationId)))
		.orderBy(asc(aiReviewDecision.createdAt), asc(aiReviewDecision.id));
function statusesFor(result: ReviewResult, decisions: readonly Pick<Decision, "event" | "subjectIds">[]): Statuses {
	const statuses: Statuses = Object.fromEntries(
		result.kind === "wording" ? result.proposals.map((proposal) => [proposal.id, "pending"]) : [],
	);
	for (const decision of decisions)
		if (["accept", "accept_edited", "reject", "undo"].includes(decision.event))
			for (const id of decision.subjectIds)
				statuses[id] = decision.event === "undo" ? "pending" : decision.event === "reject" ? "rejected" : "accepted";
	return statuses;
}

const acceptedReviewDecision = (decision: Decision) =>
	decision.event === "accept" || decision.event === "accept_edited";
const activeReviewChanges = (decisions: readonly Decision[]) => {
	const undone = new Set(decisions.map((decision) => decision.previousDecisionId));
	return decisions
		.filter((decision) => acceptedReviewDecision(decision) && !undone.has(decision.id))
		.flatMap((decision) => decision.changes);
};
const rightToLeft = (changes: readonly ReviewProposal[]) =>
	changes.toSorted((a, b) => (b.blockIndex ?? -1) - (a.blockIndex ?? -1));
const inverseReviewChange = (change: ReviewProposal) => ({ ...change, before: change.after, after: change.before });

function expectedUndoField(accepted: Decision, decisions: readonly Decision[], target: ReviewProposal["target"]) {
	let expected = accepted.response ? readTarget(accepted.response.data, target) : undefined;
	const key = canonicalJson(target);
	for (let index = decisions.indexOf(accepted) + 1; index < decisions.length; index++) {
		const later = decisions[index];
		if (!later || (later.event !== "undo" && !acceptedReviewDecision(later))) continue;
		const changes = later.changes.filter((change) => canonicalJson(change.target) === key);
		if (!changes.length) continue;
		const active = activeReviewChanges(decisions.slice(0, index));
		for (const change of rightToLeft(changes)) {
			const positioned = reviewProposalPosition(change, active);
			expected = applyTo(expected, later.event === "undo" ? inverseReviewChange(positioned) : positioned);
		}
	}
	return expected;
}

async function ownedReview(tx: OwnerTransaction, ownerId: string, operationId: string, variantQuestions = false) {
	const [operation] = await tx
		.select()
		.from(aiOperation)
		.where(and(eq(aiOperation.userId, ownerId), eq(aiOperation.id, operationId)))
		.for("update");
	if (
		!operation?.result ||
		!operation.kind.startsWith("review.") ||
		!["waiting_review", "succeeded"].includes(operation.state)
	)
		throw new ORPCError("NOT_FOUND");
	const variant = variantQuestions ? variantReviewResultSchema.safeParse(operation.result) : null;
	const result: ReviewResult =
		variant?.success && ["review.summary", "review.job-evidence"].includes(variant.data.kind)
			? {
					schemaVersion: 2,
					kind: "wording",
					sourceRevision: variant.data.sourceRevision,
					evidence: [],
					proposals: [],
					notes: [],
					questions:
						variant.data.kind === "review.summary"
							? variant.data.output.questions.map((question) => ({ ...question, target: null }))
							: variant.data.kind === "review.job-evidence"
								? variant.data.output.requirements
										.filter((requirement) => requirement.verdict !== "supported")
										.slice(0, 20)
										.map((requirement) => ({
											id: requirement.id,
											target: null,
											prompt: requirement.explanation,
											evidenceIds: requirement.evidenceIds,
										}))
								: [],
				}
			: reviewResultSchema.parse(operation.result);
	const source = result.sourceRevision;
	let document: typeof resume.$inferSelect | undefined;
	if (source.kind === "resume") {
		await lockReviewProfile(tx, ownerId);
		[document] = await tx
			.select()
			.from(resume)
			.where(and(eq(resume.userId, ownerId), eq(resume.id, source.id)))
			.for("update");
		if (!document || document.trashedAt) throw new ORPCError("NOT_FOUND");
	} else await loadReviewSource(tx, ownerId, source);
	return { operation, result, document, decisions: await decisionsFor(tx, ownerId, operationId) };
}
async function assertEvidence(
	tx: OwnerTransaction,
	ownerId: string,
	result: ReviewResult,
	proposals: ReviewProposal[],
	decisions: Decision[],
) {
	const ids = new Set(proposals.flatMap((proposal) => proposal.evidenceIds));
	const resumeChanges = decisions.filter((decision) => ["accept", "accept_edited", "undo"].includes(decision.event));
	for (const evidence of result.evidence.filter((entry) => ids.has(entry.id))) {
		if (evidence.source.kind === "answer") {
			try {
				const current = await loadReviewSource(tx, ownerId, evidence.source, [], resumeChanges);
				if (!current.evidence.some((entry) => canonicalJson(entry) === canonicalJson(evidence)))
					conflict("AI_SOURCE_CHANGED");
			} catch {
				conflict("AI_SOURCE_CHANGED");
			}
		}
		if (evidence.factId === null) continue;
		const [fact] = await tx
			.select()
			.from(careerFact)
			.where(and(eq(careerFact.userId, ownerId), eq(careerFact.id, evidence.factId)))
			.for("share");
		if (
			!fact ||
			fact.status !== "active" ||
			fact.confirmation !== "confirmed" ||
			fact.revision !== evidence.factRevision
		)
			conflict("AI_SOURCE_CHANGED");
	}
}
async function closeResolved(
	tx: OwnerTransaction,
	operationId: string,
	result: ReviewResult,
	decisions: Decision[],
	statuses: Statuses,
) {
	const closed = new Set(
		decisions
			.filter((decision) => decision.event === "answer" || decision.event === "dismiss_question")
			.flatMap((decision) => decision.subjectIds),
	);
	if (
		Object.values(statuses).every((status) => status !== "pending") &&
		result.questions.every((question) => closed.has(question.id))
	)
		await tx
			.update(aiOperation)
			.set({ state: "succeeded" })
			.where(and(eq(aiOperation.id, operationId), eq(aiOperation.state, "waiting_review")));
}

export function getReview(ownerId: string, operationId: string) {
	return withOwnerDatabase(ownerId, async (tx) => {
		const { result, decisions } = await ownedReview(tx, ownerId, operationId);
		const statuses = statusesFor(result, decisions);
		const currentAnswers = new Map<string, ReviewEvidence>();
		for (const decision of decisions)
			if (decision.event === "answer" && decision.evidence)
				for (const id of decision.subjectIds) currentAnswers.set(id, decision.evidence);
		return {
			result,
			statuses,
			answeredQuestionIds: decisions
				.filter((decision) => decision.event === "answer")
				.flatMap((decision) => decision.subjectIds),
			answers: [...currentAnswers.values()],
			dismissedQuestionIds: decisions
				.filter((decision) => decision.event === "dismiss_question")
				.flatMap((decision) => decision.subjectIds),
			undoable: decisions
				.filter(
					(decision) =>
						["accept", "accept_edited"].includes(decision.event) &&
						!decisions.some((later) => later.previousDecisionId === decision.id) &&
						decision.subjectIds.every((id) => statuses[id] === "accepted"),
				)
				.map((decision) => ({
					decisionId: decision.id,
					proposalIds: decision.subjectIds,
					changes: decision.changes,
					userSupplied: decision.event === "accept_edited",
				})),
		};
	});
}

export function getLatestResumeReview(ownerId: string, resumeId: string) {
	return withOwnerDatabase(ownerId, async (tx) => {
		const [document] = await tx
			.select({ id: resume.id })
			.from(resume)
			.where(and(eq(resume.userId, ownerId), eq(resume.id, resumeId)));
		if (!document) throw new ORPCError("NOT_FOUND");
		const [operation] = await tx
			.select({ id: aiOperation.id })
			.from(aiOperation)
			.where(
				and(
					eq(aiOperation.userId, ownerId),
					eq(aiOperation.kind, "review.wording"),
					sql`${aiOperation.sources} @> ${JSON.stringify([{ kind: "resume", id: resumeId }])}::jsonb`,
				),
			)
			.orderBy(desc(aiOperation.createdAt), desc(aiOperation.id))
			.limit(1);
		return operation?.id ?? null;
	});
}

/** Persisted per-field reviews, including unresolved suggestions from older operations. */
export function listResumeReviews(ownerId: string, resumeId: string) {
	return withOwnerDatabase(ownerId, async (tx) => {
		const [document] = await tx
			.select({ id: resume.id })
			.from(resume)
			.where(and(eq(resume.userId, ownerId), eq(resume.id, resumeId)));
		if (!document) throw new ORPCError("NOT_FOUND");
		const operations = await tx
			.select({ id: aiOperation.id, result: aiOperation.result, parameters: aiOperation.parameters })
			.from(aiOperation)
			.where(
				and(
					eq(aiOperation.userId, ownerId),
					eq(aiOperation.kind, "review.wording"),
					sql`${aiOperation.sources} @> ${JSON.stringify([{ kind: "resume", id: resumeId }])}::jsonb`,
				),
			)
			.orderBy(desc(aiOperation.createdAt), desc(aiOperation.id));
		if (!operations.length) return [];
		const decisions = await tx
			.select({
				operationId: aiReviewDecision.operationId,
				event: aiReviewDecision.event,
				subjectIds: aiReviewDecision.subjectIds,
			})
			.from(aiReviewDecision)
			.where(
				and(
					eq(aiReviewDecision.userId, ownerId),
					inArray(
						aiReviewDecision.operationId,
						operations.map((operation) => operation.id),
					),
				),
			)
			.orderBy(asc(aiReviewDecision.createdAt), asc(aiReviewDecision.id));
		return operations
			.map((operation) => {
				const parsed = reviewResultSchema.safeParse(operation.result);
				const result =
					parsed.success &&
					parsed.data.kind === "wording" &&
					parsed.data.sourceRevision.kind === "resume" &&
					parsed.data.sourceRevision.id === resumeId
						? parsed.data
						: null;
				const statuses = result
					? statusesFor(
							result,
							decisions.filter((decision) => decision.operationId === operation.id),
						)
					: {};
				const parameters = operation.parameters as { targets?: unknown[] } | null;
				const targets = new Map<string, { target: ReviewProposal["target"]; pendingCount: number }>();
				for (const raw of [
					...(Array.isArray(parameters?.targets) ? parameters.targets : []),
					...(result?.evidence.map((entry) => entry.target) ?? []),
					...(result?.proposals.map((proposal) => proposal.target) ?? []),
				]) {
					const parsed = reviewTargetSchema.safeParse(raw);
					if (parsed.success) targets.set(canonicalJson(parsed.data), { target: parsed.data, pendingCount: 0 });
				}
				for (const proposal of result?.proposals ?? []) {
					const entry = targets.get(canonicalJson(proposal.target));
					if (entry && statuses[proposal.id] === "pending") entry.pendingCount++;
				}
				return { operationId: operation.id, targets: [...targets.values()] };
			})
			.filter((operation) => operation.targets.length > 0);
	});
}

export async function decideReview(ownerId: string, raw: ReviewDecisionInput): Promise<ReviewDecisionView> {
	const input = reviewDecisionInputSchema.parse(raw);
	let changed = false;
	const view = await withOwnerDatabase(ownerId, async (tx) => {
		await lockDocumentOwner(tx, ownerId);
		const { result, document, decisions } = await ownedReview(tx, ownerId, input.operationId);
		if (result.kind !== "wording" || !document) throw new ORPCError("BAD_REQUEST");
		const key = fingerprint(input);
		const [replay] = await tx
			.select()
			.from(aiReviewDecision)
			.where(and(eq(aiReviewDecision.userId, ownerId), eq(aiReviewDecision.requestKey, input.requestKey)));
		if (replay) {
			if (replay.fingerprint !== key || !replay.response) return conflict("AI_REQUEST_KEY_REUSED");
			return replay.response;
		}
		if (document.isLocked) throw new ORPCError("RESUME_LOCKED", { status: 403 });
		if (document.updatedAt.toISOString() !== input.expectedUpdatedAt) return conflict("AI_SOURCE_CHANGED");
		const statuses = statusesFor(result, decisions);
		const proposals = input.proposalIds.map((id) => result.proposals.find((proposal) => proposal.id === id));
		if (proposals.some((proposal) => !proposal)) throw new ORPCError("NOT_FOUND");
		let selected = proposals as ReviewProposal[];
		const originalData = parseResumeDataForWrite(document.data);
		let data = originalData;
		if (input.decision === "undo") {
			const accepted = decisions.find((decision) => decision.id === input.undoDecisionId);
			if (
				!accepted ||
				!["accept", "accept_edited"].includes(accepted.event) ||
				canonicalJson([...accepted.subjectIds].sort()) !== canonicalJson([...input.proposalIds].sort()) ||
				decisions.some((decision) => decision.previousDecisionId === accepted.id)
			)
				return conflict();
			if (selected.some((proposal) => statuses[proposal.id] !== "accepted")) return conflict();
			selected = accepted.changes;
			data = structuredClone(originalData);
			const active = activeReviewChanges(decisions);
			for (const change of rightToLeft(selected)) {
				const proposal = reviewProposalPosition(change, active);
				const value = readTarget(originalData, proposal.target);
				// The accepted snapshot binds Undo to its passage and adjacent context, never
				// to a replacement string found elsewhere in a manually edited field.
				const expected = expectedUndoField(accepted, decisions, proposal.target);
				if (expected === undefined || value === undefined) return conflict("AI_UNDO_CHANGED");
				const savedBlocks = splitBlocks(expected);
				const currentBlocks = splitBlocks(value);
				const index = proposal.blockIndex ?? savedBlocks.findIndex((block) => block.html === proposal.after);
				if (
					index < 0 ||
					savedBlocks[index]?.html !== proposal.after ||
					savedBlocks.length !== currentBlocks.length ||
					[index - 1, index, index + 1].some((i) => savedBlocks[i]?.html !== currentBlocks[i]?.html)
				)
					return conflict("AI_UNDO_CHANGED");
				const restored = applyTo(readTarget(data, proposal.target), inverseReviewChange(proposal));
				if (restored === undefined) return conflict("AI_UNDO_CHANGED");
				writeTarget(data, proposal.target, restored);
			}
			data = parseResumeDataForWrite(data);
		} else {
			if (selected.some((proposal) => statuses[proposal.id] !== "pending")) return conflict();
			if (input.decision !== "reject") {
				if (selected.some((proposal) => !hasCompleteReviewScope(proposal, result.evidence)))
					return conflict("AI_SOURCE_CHANGED");
				await assertEvidence(tx, ownerId, result, selected, decisions);
			}
			const editedText = input.editedText;
			if (input.decision === "accept_edited" && editedText !== undefined)
				selected = selected.map((proposal) => ({
					...proposal,
					after: replaceReviewPassageText(proposal.before, editedText),
					claims: splitReviewClaims(editedText, proposal.evidenceIds),
				}));
			// Dismissal only records the pending proposal's disposition; it never applies old text.
			if (input.decision !== "reject") {
				try {
					data = applyReviewProposals(originalData, selected, activeReviewChanges(decisions));
				} catch {
					return conflict("AI_SOURCE_CHANGED");
				}
			}
		}
		let updatedAt = document.updatedAt.toISOString();
		let historyVersionId: string | null = null;
		if (input.decision !== "reject") {
			const saved = await updateResumeTx(tx, {
				id: document.id,
				userId: ownerId,
				data,
				expectedUpdatedAt: document.updatedAt,
				skipAutoSnapshot: true,
			});
			updatedAt = saved.updatedAt.toISOString();
			historyVersionId = (await writeVersion(tx, { resumeId: document.id, userId: ownerId, data, kind: "ai" })).id;
			changed = true;
		}
		for (const id of input.proposalIds)
			statuses[id] = input.decision === "undo" ? "pending" : input.decision === "reject" ? "rejected" : "accepted";
		const response: ReviewDecisionView = {
			decisionId: generateId(),
			operationId: input.operationId,
			statuses,
			resumeId: document.id,
			updatedAt,
			data,
		};
		const [event] = await tx
			.insert(aiReviewDecision)
			.values({
				id: response.decisionId,
				userId: ownerId,
				operationId: input.operationId,
				resumeId: document.id,
				requestKey: input.requestKey,
				fingerprint: key,
				event: input.decision,
				subjectIds: input.proposalIds,
				previousDecisionId: input.undoDecisionId ?? null,
				changes: selected,
				beforeRevision: document.updatedAt.toISOString(),
				afterRevision: updatedAt,
				historyVersionId,
				response,
			})
			.returning();
		if (!event) throw new ORPCError("INTERNAL_SERVER_ERROR");
		await closeResolved(tx, input.operationId, result, [...decisions, event], statuses);
		return response;
	});
	if (changed)
		await notifyResumeUpdated({
			type: "resume.updated",
			resumeId: view.resumeId,
			userId: ownerId,
			updatedAt: view.updatedAt,
			mutation: "update",
		});
	return view;
}

export function recordReviewAnswer(ownerId: string, raw: ReviewAnswerInput): Promise<ReviewEvidence> {
	const input = reviewAnswerInputSchema.parse(raw);
	return withOwnerDatabase(ownerId, async (tx) => {
		await lockDocumentOwner(tx, ownerId);
		const { operation, result, document, decisions } = await ownedReview(tx, ownerId, input.operationId, true);
		const key = fingerprint(input);
		const [replay] = await tx
			.select()
			.from(aiReviewDecision)
			.where(and(eq(aiReviewDecision.userId, ownerId), eq(aiReviewDecision.requestKey, input.requestKey)));
		if (replay) {
			if (replay.fingerprint !== key || !replay.evidence) return conflict("AI_REQUEST_KEY_REUSED");
			return replay.evidence;
		}
		if (!sameReviewSource(input.expectedSource, result.sourceRevision)) return conflict("AI_SOURCE_CHANGED");
		await loadReviewSource(tx, ownerId, input.expectedSource);
		if (["review.summary", "review.job-evidence"].includes(operation.kind))
			await loadVariantSnapshot(tx, ownerId, operation);
		const question = result.questions.find((question) => question.id === input.questionId);
		if (!question) throw new ORPCError("NOT_FOUND");
		if (
			decisions.some((decision) => decision.event === "dismiss_question" && decision.subjectIds.includes(question.id))
		)
			return conflict();
		const contacts = document ? resumeContactValues(document.data) : [];
		const id = generateId();
		const quote = buildModelPayload({
			selections: [{ id, kind: "user_supplied", section: "summary", text: input.text }],
			contactValues: contacts,
		}).selections[0]?.text;
		if (!quote) throw new ORPCError("BAD_REQUEST");
		const evidence: ReviewEvidence = {
			id,
			source: { kind: "answer", id, revision: key },
			factId: null,
			factRevision: null,
			target: question.target,
			quote,
			confirmation: "user_supplied",
		};
		const [event] = await tx
			.insert(aiReviewDecision)
			.values({
				id,
				userId: ownerId,
				operationId: input.operationId,
				resumeId: document?.id ?? null,
				requestKey: input.requestKey,
				fingerprint: key,
				event: "answer",
				subjectIds: [question.id],
				evidence,
			})
			.returning();
		if (!event) throw new ORPCError("INTERNAL_SERVER_ERROR");
		if (!["review.summary", "review.job-evidence"].includes(operation.kind))
			await closeResolved(tx, input.operationId, result, [...decisions, event], statusesFor(result, decisions));
		return evidence;
	});
}

export async function dismissReviewQuestion(
	ownerId: string,
	raw: { operationId: string; questionId: string; requestKey: string },
): Promise<void> {
	const input = reviewQuestionDismissalSchema.parse(raw);
	await withOwnerDatabase(ownerId, async (tx) => {
		await lockDocumentOwner(tx, ownerId);
		const { operation, result, document, decisions } = await ownedReview(tx, ownerId, input.operationId, true);
		const key = fingerprint(input);
		const [replay] = await tx
			.select()
			.from(aiReviewDecision)
			.where(and(eq(aiReviewDecision.userId, ownerId), eq(aiReviewDecision.requestKey, input.requestKey)));
		if (replay) {
			if (replay.fingerprint !== key) conflict("AI_REQUEST_KEY_REUSED");
			return;
		}
		if (!result.questions.some((question) => question.id === input.questionId)) throw new ORPCError("NOT_FOUND");
		const [event] = await tx
			.insert(aiReviewDecision)
			.values({
				userId: ownerId,
				operationId: input.operationId,
				resumeId: document?.id ?? null,
				requestKey: input.requestKey,
				fingerprint: key,
				event: "dismiss_question",
				subjectIds: [input.questionId],
			})
			.returning();
		if (!event) throw new ORPCError("INTERNAL_SERVER_ERROR");
		if (!["review.summary", "review.job-evidence"].includes(operation.kind))
			await closeResolved(tx, input.operationId, result, [...decisions, event], statusesFor(result, decisions));
	});
}
