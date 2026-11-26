import type { OwnerTransaction } from "@reactive-resume/db/owner-scope";
import type { OperationRequest } from "@reactive-resume/schema/ai-operation";
import { ORPCError } from "@orpc/client";
import { and, asc, eq, inArray, or, isNotNull, sql } from "drizzle-orm";
import { withOwnerDatabase } from "@reactive-resume/db/owner-scope";
import { aiOperation, aiReviewDecision } from "@reactive-resume/db/schema";
import { canonicalJson } from "./route-policy";

const kinds = ["review.wording", "review.summary", "review.job-evidence"];

export async function hasReviewContinuation(
	tx: OwnerTransaction,
	ownerId: string,
	operationId: string,
	includeActive = false,
) {
	const [previous] = await tx
		.select({ id: aiOperation.id })
		.from(aiOperation)
		.where(
			and(
				eq(aiOperation.userId, ownerId),
				sql`${aiOperation.parameters}->>'continuationOf' = ${operationId}`,
				or(
					isNotNull(aiOperation.deliveredAt),
					includeActive ? inArray(aiOperation.state, ["queued", "running", "cancel_requested"]) : undefined,
				),
			),
		)
		.limit(1);
	return Boolean(previous);
}

async function continuation(tx: OwnerTransaction, ownerId: string, operationId: string, answerId: string) {
	const [parent] = await tx
		.select()
		.from(aiOperation)
		.where(and(eq(aiOperation.userId, ownerId), eq(aiOperation.id, operationId)));
	if (!parent?.deliveredAt || !kinds.includes(parent.kind)) throw new ORPCError("NOT_FOUND");
	const answers = await tx
		.select({
			id: aiReviewDecision.id,
			subjectIds: aiReviewDecision.subjectIds,
			evidence: aiReviewDecision.evidence,
		})
		.from(aiReviewDecision)
		.where(
			and(
				eq(aiReviewDecision.userId, ownerId),
				eq(aiReviewDecision.operationId, operationId),
				eq(aiReviewDecision.event, "answer"),
			),
		)
		.orderBy(asc(aiReviewDecision.createdAt), asc(aiReviewDecision.id));
	const byQuestion = new Map<string, NonNullable<(typeof answers)[number]["evidence"]>>();
	for (const answer of answers)
		if (answer.evidence) for (const question of answer.subjectIds) byQuestion.set(question, answer.evidence);
	const evidence = [...new Map([...byQuestion.values()].map((answer) => [answer.id, answer])).values()];
	if (!evidence.some((answer) => answer.id === answerId)) throw new ORPCError("NOT_FOUND");
	if (parent.sources.length + evidence.length > 10) throw new ORPCError("BAD_REQUEST");
	const { interfaceLocale: _locale, ...parameters } = parent.parameters;
	const earlierIds = Array.isArray(parameters.answerIds) ? parameters.answerIds : [];
	return {
		parent,
		sources: [...parent.sources, ...evidence.map((answer) => answer.source)],
		parameters: {
			...parameters,
			continuationOf: operationId,
			answerIds: [...earlierIds, ...evidence.map((answer) => answer.id)],
		},
	};
}

export function prepareReviewContinuation(ownerId: string, operationId: string, answerId: string) {
	return withOwnerDatabase(ownerId, async (tx) => {
		const { sources, parameters } = await continuation(tx, ownerId, operationId, answerId);
		return { sources, parameters };
	});
}

/** The owner admission lock serializes competing continuations and permits retry after failed work. */
export async function validateReviewContinuation(tx: OwnerTransaction, ownerId: string, request: OperationRequest) {
	const { continuationOf, answerIds, interfaceLocale: _locale, ...scope } = request.parameters;
	if (continuationOf === undefined) return false;
	if (typeof continuationOf !== "string" || !Array.isArray(answerIds) || typeof answerIds.at(-1) !== "string")
		throw new ORPCError("BAD_REQUEST");
	const expected = await continuation(tx, ownerId, continuationOf, answerIds.at(-1));
	const { continuationOf: _parent, answerIds: expectedAnswers, ...expectedScope } = expected.parameters;
	const normalizedScope =
		request.kind === "review.job-evidence" ? { ...scope, jobSpanVersion: "requirements-v2" } : scope;
	const normalizedExpected =
		request.kind === "review.job-evidence" ? { ...expectedScope, jobSpanVersion: "requirements-v2" } : expectedScope;
	if (
		expected.parent.kind !== request.kind ||
		canonicalJson(expectedAnswers) !== canonicalJson(answerIds) ||
		canonicalJson(normalizedExpected) !== canonicalJson(normalizedScope) ||
		canonicalJson(expected.sources) !== canonicalJson(request.sources)
	)
		throw new ORPCError("BAD_REQUEST");

	if (await hasReviewContinuation(tx, ownerId, continuationOf, true))
		throw new ORPCError("CONFLICT", { data: { reason: "AI_REVIEW_ALREADY_CONTINUED" } });

	return true;
}
