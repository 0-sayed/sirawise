import type { OwnerTransaction } from "@reactive-resume/db/client";
import type {
	CreateVariantInput,
	VariantDecisionInput,
	VariantDecisionPayload,
	VariantReviewResult,
	VariantReviewView,
} from "@reactive-resume/schema/resume/variants";
import { createHash } from "node:crypto";
import { ORPCError } from "@orpc/client";
import { and, asc, eq, isNull } from "drizzle-orm";
import { withOwnerDatabase } from "@reactive-resume/db/client";
import {
	aiOperation,
	aiTranslationBatch,
	aiReviewDecision,
	resume,
	resumeVariantSource,
} from "@reactive-resume/db/schema";
import { blockText, readTarget, writeTarget } from "@reactive-resume/resume/proposals";
import { buildTranslationInventory, translationPlaceholders } from "@reactive-resume/resume/translation";
import { reviewTargetSchema } from "@reactive-resume/schema/resume/ai-review";
import {
	variantDecisionInputSchema,
	variantDecisionPayloadSchema,
	variantReviewResultSchema,
} from "@reactive-resume/schema/resume/variants";
import { parseResumeDataForWrite } from "@reactive-resume/schema/resume/write";
import { escapeHtml, generateId } from "@reactive-resume/utils/string";
import { lockDocumentOwner } from "../documents/ownership";
import { notifyResumeUpdated, updateResumeTx } from "../resume/service";
import { applyReviewedTranslation, createVariant } from "../resume/variants";
import { writeVersion } from "../resume/version-history";
import { assembleTranslationBatchResult } from "./operations";
import { resumeContactValues } from "./payload";
import { hasReviewContinuation } from "./review-continuation";
import { savedQuestionAnswers } from "./review-decisions";
import { canonicalJson } from "./route-policy";
import { evaluateTranslationAutoApply } from "./translation-auto-apply";
import { prepareTranslationFacts } from "./translation-invariants";
import { resolveTranslationText } from "./translation-placeholders";
import { translationCandidateContract } from "./variant-contracts";
import { loadVariantSnapshot } from "./variant-sources";

function conflict(reason = "AI_SOURCE_CHANGED"): never {
	throw new ORPCError("CONFLICT", { data: { reason } });
}
async function context(tx: OwnerTransaction, ownerId: string, operationId: string) {
	await lockDocumentOwner(tx, ownerId);
	let [operation] = await tx
		.select()
		.from(aiOperation)
		.where(and(eq(aiOperation.userId, ownerId), eq(aiOperation.id, operationId)))
		.for("update");
	if (!operation) throw new ORPCError("NOT_FOUND");
	if (operation.kind === "review.translation" && operation.parameters.translationBatch) {
		const batch = operation.parameters.translationBatch as { rootId: string };
		const [session] = await tx
			.select()
			.from(aiTranslationBatch)
			.where(and(eq(aiTranslationBatch.userId, ownerId), eq(aiTranslationBatch.rootOperationId, operation.id)));
		const assembled =
			batch.rootId === operation.id ? await assembleTranslationBatchResult(tx, ownerId, operation) : null;
		if (!session || !assembled)
			throw new ORPCError("PRECONDITION_FAILED", { data: { reason: "TRANSLATION_BATCH_INCOMPLETE" } });
		operation = {
			...operation,
			state: session.reviewState,
			result: assembled,
			deliveredAt: operation.deliveredAt ?? operation.createdAt,
		};
	}
	if (!operation.result || !operation.deliveredAt || !["waiting_review", "succeeded"].includes(operation.state))
		throw new ORPCError("NOT_FOUND");
	const {
		withheldSegmentIds: storedIds,
		withheldSegmentParts,
		withholdingIdsComplete,
		...publicResult
	} = operation.result;
	const result = variantReviewResultSchema.parse(publicResult);
	const withheldParts = new Map<string, { partIndex?: number | undefined; reason?: string | undefined }>(
		(Array.isArray(withheldSegmentParts) ? withheldSegmentParts : (result.withheld?.items ?? [])).map(
			({ id, partIndex, reason }) => [id, { partIndex, reason }],
		),
	);
	const withheldSegmentIds = new Set<string>();
	if (result.kind === "review.translation") {
		for (const id of Array.isArray(storedIds) ? storedIds : (result.withheld?.items ?? []).map(({ id }) => id))
			withheldSegmentIds.add(id);
	}
	const incompleteWithholding =
		result.kind === "review.translation" &&
		(withholdingIdsComplete === false || withheldSegmentIds.size !== (result.withheld?.count ?? 0));
	const compactTranslation =
		(operation.parameters.translationBatch as { planVersion?: string } | undefined)?.planVersion === "compact-v1";
	if (result.kind !== operation.kind || result.sourceRevision.kind !== "resume") throw new ORPCError("NOT_FOUND");
	const [document] = await tx
		.select()
		.from(resume)
		.where(and(eq(resume.userId, ownerId), eq(resume.id, result.sourceRevision.id), isNull(resume.trashedAt)))
		.for("update");
	if (!document) throw new ORPCError("NOT_FOUND");
	const decisions = await tx
		.select()
		.from(aiReviewDecision)
		.where(and(eq(aiReviewDecision.userId, ownerId), eq(aiReviewDecision.operationId, operationId)))
		.orderBy(asc(aiReviewDecision.createdAt), asc(aiReviewDecision.id));
	const [provenance] = await tx
		.select()
		.from(resumeVariantSource)
		.where(and(eq(resumeVariantSource.userId, ownerId), eq(resumeVariantSource.resumeId, document.id)))
		.for("update");
	return {
		operation,
		result,
		document,
		decisions,
		provenance,
		withheldSegmentIds,
		withheldParts,
		incompleteWithholding,
		compactTranslation,
	};
}
type Context = Awaited<ReturnType<typeof context>>;
const stagesTailoring = (ctx: Context) => ctx.result.kind === "review.tailoring" && ctx.document.variantKind !== "job";
const workingSnapshot = (ctx: Context) =>
	stagesTailoring(ctx)
		? ctx.decisions.findLast((event) => event.variantPayload?.after)?.variantPayload?.after
		: undefined;

export function createReviewedJobVariant(ownerId: string, input: Extract<CreateVariantInput, { variantKind: "job" }>) {
	const review = input.review;
	if (!review) throw new ORPCError("BAD_REQUEST");
	return createVariant(ownerId, input, async (tx) => {
		const ctx = await context(tx, ownerId, review.operationId);
		if (
			!stagesTailoring(ctx) ||
			ctx.document.id !== input.sourceResumeId ||
			ctx.operation.parameters.jobId !== input.jobId ||
			ctx.operation.parameters.jobRevision !== input.jobRevision ||
			ctx.decisions.at(-1)?.id !== review.decisionId
		)
			conflict();
		await assertCurrent(tx, ownerId, ctx);
		const snapshot = workingSnapshot(ctx);
		if (!snapshot || !Object.values(statuses(ctx)).includes("accepted")) conflict();
		return snapshot.data;
	});
}
const restoreSummaryNames = (text: string, ctx: Context) =>
	text.replaceAll("[NAME_1]", () => ctx.document.data.basics.name);
const subjectIds = (result: VariantReviewResult): string[] =>
	result.kind === "review.translation"
		? [...result.output.segments.map((segment) => segment.sourceId), "translation"]
		: result.kind === "review.tailoring"
			? [...result.output.patches.map((patch) => patch.id), ...(result.output.order.length ? ["order"] : [])]
			: result.kind === "review.summary"
				? result.output.summary.text.trim()
					? ["summary"]
					: []
				: ["report"];
function statuses({ result, decisions, withheldSegmentIds: withheldIds, operation }: Context) {
	const value: Record<string, "pending" | "accepted" | "rejected"> = Object.fromEntries(
		subjectIds(result)
			.filter((id) => !withheldIds.has(id))
			.map((id) => [id, "pending"]),
	);
	for (const event of decisions)
		if (["accept", "accept_edited", "reject", "undo"].includes(event.event))
			for (const id of event.subjectIds)
				if (Object.hasOwn(value, id))
					value[id] = event.event === "undo" ? "pending" : event.event === "reject" ? "rejected" : "accepted";
	if (result.kind === "review.translation")
		for (const [id, segment] of Object.entries(decisions.at(-1)?.variantPayload?.segments ?? {}))
			if (!withheldIds.has(id)) value[id] = segment.status;
	if (
		result.kind === "review.translation" &&
		operation.promptVersion === translationCandidateContract.promptVersion &&
		value.translation === "accepted"
	) {
		const approval = decisions.findLast(
			(event) => event.event === "accept" && event.subjectIds.includes("translation"),
		);
		const approvedSegments = approval?.variantPayload?.segments ?? {};
		if (Object.keys(value).some((id) => id !== "translation" && !Object.hasOwn(approvedSegments, id)))
			value.translation = "pending";
	}
	return value;
}
function previousPayload(ctx: Context) {
	const stored = ctx.decisions.at(-1)?.variantPayload;
	if (!stored) return null;
	const payload = variantDecisionPayloadSchema.parse(stored);
	for (const id of ctx.withheldSegmentIds) delete payload.segments[id];
	payload.terms.terms = payload.terms.terms.filter(({ id }) => !ctx.withheldSegmentIds.has(id.slice("term:".length)));
	return payload;
}
async function translationSource(tx: OwnerTransaction, ownerId: string, ctx: Context) {
	const id = ctx.provenance?.sourceResumeId;
	const sourcePin = ctx.operation.sources.find((source) => source.kind === "resume" && source.id === id);
	if (!id || !sourcePin) conflict();
	const [source] = await tx
		.select()
		.from(resume)
		.where(and(eq(resume.userId, ownerId), eq(resume.id, id), isNull(resume.trashedAt)))
		.for("share");
	if (!source || source.isLocked || source.updatedAt.toISOString() !== sourcePin.revision) conflict();
	return source;
}
async function initialPayload(tx: OwnerTransaction, ownerId: string, ctx: Context): Promise<VariantDecisionPayload> {
	const payload: VariantDecisionPayload = {
		schemaVersion: 1,
		kind: ctx.result.kind,
		terms: { schemaVersion: 1, terms: [] },
		segments: {},
		before: null,
		after: null,
	};
	if (ctx.result.kind !== "review.translation") return payload;
	const source = await translationSource(tx, ownerId, ctx);
	const inventory = buildTranslationInventory(source.data);
	if (inventory.blocking.length)
		throw new ORPCError("PRECONDITION_FAILED", {
			data: { reason: "TRANSLATION_PARTIAL_COVERAGE", sections: inventory.blockingSections },
		});
	const approvedTerms = new Map(
		ctx.operation.promptVersion === translationCandidateContract.promptVersion
			? ctx.provenance?.terminology.terms.filter(({ status }) => status === "confirmed").map((term) => [term.id, term])
			: [],
	);
	payload.terms.terms = inventory.segments
		.filter((segment) => segment.official && !ctx.withheldSegmentIds.has(segment.id))
		.map((segment) => {
			const id = `term:${segment.id}`;
			const prior = approvedTerms.get(id);
			const approved = prior?.source === segment.text ? prior : undefined;
			return {
				id,
				sourceRevision: ctx.result.sourceRevision.revision,
				target: segment.target,
				source: segment.text,
				value: approved?.value ?? segment.text,
				status: approved?.status ?? "pending",
				author: approved?.author ?? "source",
			};
		});
	payload.segments = Object.fromEntries(
		ctx.result.output.segments
			.filter(({ sourceId }) => !ctx.withheldSegmentIds.has(sourceId))
			.map((segment) => [segment.sourceId, { text: segment.text, status: "pending", author: "model" }]),
	);
	return payload;
}
async function reviewPayload(tx: OwnerTransaction, ownerId: string, ctx: Context) {
	const previous = previousPayload(ctx);
	if (!previous) return initialPayload(tx, ownerId, ctx);
	if (
		ctx.result.kind !== "review.translation" ||
		ctx.result.output.segments.every(
			({ sourceId }) => ctx.withheldSegmentIds.has(sourceId) || Object.hasOwn(previous.segments, sourceId),
		)
	)
		return previous;
	const initial = await initialPayload(tx, ownerId, ctx);
	const previousTerms = new Set(previous.terms.terms.map(({ id }) => id));
	return {
		...previous,
		segments: { ...initial.segments, ...previous.segments },
		terms: {
			...previous.terms,
			terms: [...previous.terms.terms, ...initial.terms.terms.filter(({ id }) => !previousTerms.has(id))],
		},
	};
}
const snapshotProvenance = (value: Context["provenance"]) =>
	value
		? {
				acceptedSourceRevision: value.acceptedSourceRevision,
				terminology: value.terminology,
				acceptedFactRevisions: value.acceptedFactRevisions,
			}
		: null;
async function assertCurrent(tx: OwnerTransaction, ownerId: string, ctx: Context) {
	const lastChange = ctx.decisions.findLast(
		(decision) => decision.variantPayload?.after !== null && decision.variantPayload?.after !== undefined,
	);
	if (ctx.document.updatedAt.toISOString() !== (lastChange?.afterRevision ?? ctx.result.sourceRevision.revision))
		conflict();
	if (ctx.compactTranslation) {
		await loadVariantSnapshot(tx, ownerId, ctx.operation);
		return;
	}
	const revision = ctx.document.updatedAt.toISOString();
	await loadVariantSnapshot(
		tx,
		ownerId,
		{
			kind: ctx.operation.kind,
			parameters: { ...ctx.operation.parameters, expectedUpdatedAt: revision },
			sources: ctx.operation.sources.map((source) =>
				source.kind === "resume" && source.id === ctx.document.id ? { ...source, revision } : source,
			),
		},
		{ reviewChanges: ctx.decisions },
	);
}

export function getVariantReview(ownerId: string, operationId: string) {
	return withOwnerDatabase(ownerId, async (tx) => {
		const ctx = await context(tx, ownerId, operationId);
		let stale = false;
		try {
			await assertCurrent(tx, ownerId, ctx);
		} catch (error) {
			if (error instanceof ORPCError && ["CONFLICT", "NOT_FOUND", "RESUME_LOCKED"].includes(error.code)) stale = true;
			else throw error;
		}
		const empty: Pick<VariantDecisionPayload, "terms" | "segments"> = {
			terms: { schemaVersion: 1, terms: [] },
			segments: {},
		};
		const payload = stale ? (previousPayload(ctx) ?? empty) : await reviewPayload(tx, ownerId, ctx);
		const sourceSegments: VariantReviewView["sourceSegments"] =
			ctx.result.kind === "review.translation" && !stale
				? buildTranslationInventory((await translationSource(tx, ownerId, ctx)).data).segments.map((segment) => ({
						id: segment.id,
						text: segment.text,
						...(ctx.withheldSegmentIds.has(segment.id)
							? { untranslated: ctx.withheldParts.get(segment.id) ?? {} }
							: {}),
					}))
				: ctx.result.kind === "review.job-evidence" && !stale
					? ((await loadVariantSnapshot(tx, ownerId, ctx.operation)).jobAd?.segments ?? []).map(({ id, text }) => ({
							id,
							text,
						}))
					: [];
		// Inference tokens stay in the operation ledger. Resolve them only in this owner-scoped view.
		const result = structuredClone(ctx.result);
		const segments = structuredClone(payload.segments);
		const decisions = statuses(ctx);
		const accepted = (id: string) =>
			decisions[id] === "accepted"
				? ctx.decisions.findLast(
						(event) => (event.event === "accept" || event.event === "accept_edited") && event.subjectIds.includes(id),
					)
				: undefined;
		let beforeSummary = ctx.document.data.summary.content;
		if (result.kind === "review.translation") {
			if (stale) {
				// A stale source cannot safely reconstruct the token registry. Keep the recovery notice, withhold comparisons.
				result.output.segments = [];
				result.output.notes = [];
				for (const id of Object.keys(segments)) delete segments[id];
			} else {
				if (ctx.compactTranslation && result.withheld) {
					const publicWithheld = new Set(result.withheld.items?.map(({ id }) => id));
					result.output.segments = result.output.segments.filter(
						({ sourceId }) => !ctx.withheldSegmentIds.has(sourceId) || publicWithheld.has(sourceId),
					);
				}
				const source = await translationSource(tx, ownerId, ctx);
				const placeholders = translationPlaceholders(source.data);
				const protection = ctx.compactTranslation
					? prepareTranslationFacts(source.data, buildTranslationInventory(source.data).segments)
					: undefined;
				const contactValues = resumeContactValues(ctx.document.data);
				const sourceTextById = new Map(sourceSegments.map((segment) => [segment.id, segment.text]));
				const resolve = (text: string, sourceText?: string, sourceId?: string) =>
					resolveTranslationText({
						text,
						sourceText,
						placeholders,
						terms: payload.terms.terms,
						contactValues,
						basicsName: ctx.document.data.basics.name,
						scope: protection && sourceId ? { sourceId, localMap: protection.localMap } : undefined,
					});
				for (const segment of result.output.segments) {
					const term = payload.terms.terms.find((term) => term.id === `term:${segment.sourceId}`);
					const reviewed = segments[segment.sourceId];
					const sourceText = sourceTextById.get(segment.sourceId);
					segment.text = resolveTranslationText({
						text: reviewed?.text ?? segment.text,
						sourceText,
						placeholders,
						terms: payload.terms.terms,
						contactValues,
						basicsName: ctx.document.data.basics.name,
						termValue: term?.value,
						scope: protection ? { sourceId: segment.sourceId, localMap: protection.localMap } : undefined,
					});
					if (reviewed) reviewed.text = segment.text;
					for (const claim of segment.claims) claim.text = resolve(claim.text, sourceText, segment.sourceId);
				}
				result.output.notes = result.output.notes.map((note) => resolve(note));
			}
		} else if (result.kind === "review.summary") {
			result.output.summary.text = restoreSummaryNames(result.output.summary.text, ctx);
			for (const claim of result.output.summary.claims) claim.text = restoreSummaryNames(claim.text, ctx);
			for (const question of result.output.questions) question.prompt = restoreSummaryNames(question.prompt, ctx);
			result.output.notes = result.output.notes.map((note) => restoreSummaryNames(note, ctx));
			const saved = accepted("summary");
			if (saved?.variantPayload?.after) {
				beforeSummary = saved.variantPayload.before?.data.summary.content ?? beforeSummary;
				segments.summary = {
					text: blockText(saved.variantPayload.after.data.summary.content),
					status: "accepted",
					author: saved.event === "accept_edited" ? "user" : "model",
				};
			}
		} else if (result.kind === "review.tailoring") {
			for (const { id, target } of result.output.patches) {
				const saved = accepted(id);
				if (!saved?.variantPayload?.after) continue;
				const { sectionId, field, itemId, roleId } = target;
				const html = readTarget(saved.variantPayload.after.data, {
					sectionId,
					field,
					itemId: itemId ?? undefined,
					roleId: roleId ?? undefined,
				});
				if (html !== undefined)
					segments[id] = {
						text: blockText(html),
						status: "accepted",
						author: saved.event === "accept_edited" ? "user" : "model",
					};
			}
		}
		const questionAnswers = savedQuestionAnswers(ctx.decisions);
		const beforeTailoring = result.kind === "review.tailoring" ? accepted("order")?.variantPayload?.before : null;
		const beforeOrder =
			result.kind === "review.tailoring" && beforeTailoring
				? result.output.order.flatMap(({ sectionId }) => {
						const { sections } = beforeTailoring.data;
						const section = sections[sectionId as keyof typeof sections];
						return section ? [{ sectionId, itemIds: section.items.map(({ id }) => id) }] : [];
					})
				: undefined;
		return {
			beforeSummary,
			...(beforeOrder && { beforeOrder }),
			...(["review.summary", "review.job-evidence"].includes(result.kind)
				? {
						questionAnswers,
						remainingAnswerSlots: Math.max(0, 10 - ctx.operation.sources.length - questionAnswers.length),
						continued: await hasReviewContinuation(tx, ownerId, operationId),
					}
				: {}),
			answeredQuestionIds: ctx.decisions
				.filter((event) => event.event === "answer")
				.flatMap((event) => event.subjectIds),
			dismissedQuestionIds: ctx.decisions
				.filter((event) => event.event === "dismiss_question")
				.flatMap((event) => event.subjectIds),
			sourceSegments,
			result,
			statuses: decisions,
			terms: payload.terms,
			segments,
			updatedAt: ctx.document.updatedAt.toISOString(),
			latestDecisionId: ctx.decisions.at(-1)?.id ?? null,
			stale,
			undoable: ctx.decisions
				.filter(
					(event) =>
						["accept", "accept_edited", "reject"].includes(event.event) &&
						(event.variantPayload?.after ||
							(ctx.result.kind === "review.translation" &&
								["accept", "accept_edited", "reject"].includes(event.event) &&
								event.subjectIds.every((id) => Boolean(event.variantPayload?.segments[id])) &&
								event.afterRevision === ctx.document.updatedAt.toISOString())) &&
						!ctx.decisions.some((later) => later.previousDecisionId === event.id),
				)
				.map((event) => ({
					decisionId: event.id,
					subjectIds:
						ctx.result.kind === "review.translation" &&
						event.subjectIds.includes("translation") &&
						event.subjectIds.length > 1
							? ["translation"]
							: event.subjectIds,
				})),
		};
	});
}

/** Appends to the existing immutable ledger. Pending translation decisions never save a partial document. */
export async function decideVariantReview(ownerId: string, raw: VariantDecisionInput) {
	const input = variantDecisionInputSchema.parse(raw);
	const fingerprint = createHash("sha256").update(canonicalJson(input)).digest("hex");
	let changed = false;
	const response = await withOwnerDatabase(ownerId, async (tx) => {
		const ctx = await context(tx, ownerId, input.operationId);
		const [replay] = await tx
			.select()
			.from(aiReviewDecision)
			.where(and(eq(aiReviewDecision.userId, ownerId), eq(aiReviewDecision.requestKey, input.requestKey)));
		if (replay) {
			if (replay.fingerprint !== fingerprint || !replay.response) conflict("AI_REQUEST_KEY_REUSED");
			return replay.response;
		}
		if (ctx.document.isLocked) throw new ORPCError("RESUME_LOCKED", { status: 403 });
		if (
			ctx.document.updatedAt.toISOString() !== input.expectedUpdatedAt ||
			(ctx.decisions.at(-1)?.id ?? null) !== input.expectedDecisionId
		)
			conflict();
		if (input.decision !== "reject" && input.decision !== "undo") await assertCurrent(tx, ownerId, ctx);
		const payload = structuredClone(await reviewPayload(tx, ownerId, ctx));
		payload.before = null;
		payload.after = null;
		const currentStatuses = statuses(ctx);
		const terms = new Set(payload.terms.terms.map((term) => term.id));
		if (input.subjectIds.some((id) => !Object.hasOwn(currentStatuses, id) && !terms.has(id)))
			throw new ORPCError("NOT_FOUND");
		const originalData = workingSnapshot(ctx)?.data ?? ctx.document.data;
		let data = structuredClone(originalData);
		let nextProvenance = snapshotProvenance(ctx.provenance);
		let save = false;
		if (input.decision === "undo") {
			const accepted = ctx.decisions.find((event) => event.id === input.undoDecisionId);
			const isLegacyTranslationAutoApply =
				ctx.result.kind === "review.translation" &&
				Boolean(accepted?.subjectIds.includes("translation")) &&
				input.subjectIds.length === 1 &&
				input.subjectIds[0] === "translation";
			if (
				!accepted ||
				!["accept", "accept_edited", "reject"].includes(accepted.event) ||
				ctx.decisions.some((event) => event.previousDecisionId === accepted.id) ||
				(!isLegacyTranslationAutoApply &&
					canonicalJson([...input.subjectIds].sort()) !== canonicalJson([...accepted.subjectIds].sort())) ||
				accepted.afterRevision !== ctx.document.updatedAt.toISOString()
			)
				conflict("AI_UNDO_CHANGED");
			if (ctx.result.kind === "review.translation" && !accepted.variantPayload?.after) {
				if (
					!["accept", "accept_edited", "reject"].includes(accepted.event) ||
					!input.subjectIds.every((id) => Boolean(accepted.variantPayload?.segments[id]))
				)
					conflict("AI_UNDO_CHANGED");
				const index = ctx.decisions.indexOf(accepted);
				const prior = ctx.decisions[index - 1]?.variantPayload ?? (await initialPayload(tx, ownerId, ctx));
				for (const id of input.subjectIds) {
					const segment = prior.segments[id];
					if (!segment) conflict("AI_UNDO_CHANGED");
					payload.segments[id] = structuredClone(segment);
				}
			} else {
				if (
					!accepted?.variantPayload?.before ||
					!accepted.variantPayload.after ||
					ctx.decisions.some((event) => event.previousDecisionId === accepted.id) ||
					(!isLegacyTranslationAutoApply &&
						canonicalJson([...input.subjectIds].sort()) !== canonicalJson([...accepted.subjectIds].sort())) ||
					accepted.afterRevision !== ctx.document.updatedAt.toISOString() ||
					canonicalJson(accepted.variantPayload.after.data) !== canonicalJson(originalData) ||
					canonicalJson(accepted.variantPayload.after.provenance) !== canonicalJson(snapshotProvenance(ctx.provenance))
				)
					conflict("AI_UNDO_CHANGED");
				if (ctx.result.kind === "review.translation" && !isLegacyTranslationAutoApply) {
					const previous = ctx.decisions[ctx.decisions.indexOf(accepted) - 1]?.variantPayload;
					const undoneIds = new Set(input.subjectIds);
					for (const id of undoneIds) {
						const segment = payload.segments[id];
						if (!segment) conflict("AI_UNDO_CHANGED");
						payload.segments[id] = structuredClone(previous?.segments[id] ?? { ...segment, status: "pending" });
					}
					payload.terms.terms = payload.terms.terms.map((term) => {
						if (!undoneIds.has(term.id.slice("term:".length))) return term;
						return structuredClone(
							previous?.terms.terms.find(({ id }) => id === term.id) ?? { ...term, status: "pending" },
						);
					});
				}
				if (stagesTailoring(ctx)) for (const id of input.subjectIds) delete payload.segments[id];
				data = structuredClone(accepted.variantPayload.before.data);
				nextProvenance = structuredClone(accepted.variantPayload.before.provenance);
				save = true;
			}
		} else if (input.subjectIds.some((id) => terms.has(id))) {
			if (currentStatuses.translation !== "pending") conflict("AI_DECISION_CHANGED");
			if (input.decision === "reject" || input.subjectIds.some((id) => !terms.has(id)))
				throw new ORPCError("BAD_REQUEST");
			for (const id of input.subjectIds) {
				const term = payload.terms.terms.find((term) => term.id === id);
				if (!term) throw new ORPCError("NOT_FOUND");
				term.value = input.editedText ?? term.value;
				term.status = "confirmed";
				term.author = input.editedText === undefined ? "source" : "user";
				const segmentId = term.id.slice("term:".length);
				if (payload.segments[segmentId]) payload.segments[segmentId].status = "pending";
			}
		} else {
			const editingTranslationDraft =
				ctx.result.kind === "review.translation" && currentStatuses.translation === "pending";
			if (
				input.subjectIds.some(
					(id) =>
						currentStatuses[id] !== "pending" &&
						!(
							editingTranslationDraft &&
							payload.segments[id] &&
							(input.decision === "accept_edited" ||
								(input.decision === "reject" && currentStatuses[id] === "accepted") ||
								(input.decision === "accept" && currentStatuses[id] === "rejected"))
						),
				)
			)
				conflict("AI_DECISION_CHANGED");
			if (ctx.result.kind === "review.translation") {
				if (input.subjectIds.includes("translation")) {
					if (input.subjectIds.length !== 1 || input.decision === "accept_edited") throw new ORPCError("BAD_REQUEST");
					if (input.decision === "accept") {
						if (
							ctx.incompleteWithholding ||
							(ctx.operation.promptVersion === translationCandidateContract.promptVersion &&
								!Object.keys(payload.segments).length) ||
							Object.values(payload.segments).some((segment) => segment.status === "pending") ||
							payload.terms.terms.some((term) => term.status !== "confirmed")
						)
							conflict("TRANSLATION_REVIEW_INCOMPLETE");
						const source = await translationSource(tx, ownerId, ctx);
						const applied = await applyReviewedTranslation(tx, ownerId, {
							resumeId: ctx.document.id,
							sourceResumeId: source.id,
							expectedSourceRevision: source.updatedAt.toISOString(),
							data,
							payload,
							withheldSegmentIds: ctx.withheldSegmentIds,
							compactTranslation: ctx.compactTranslation,
						});
						data = applied.data;
						nextProvenance = applied.provenance;
						save = true;
					}
				} else
					for (const id of input.subjectIds) {
						const segment = payload.segments[id];
						if (!segment) throw new ORPCError("NOT_FOUND");
						segment.status = input.decision === "reject" ? "rejected" : "accepted";
						if (input.editedText !== undefined) {
							segment.text = input.editedText;
							segment.author = "user";
							const term = payload.terms.terms.find((term) => term.id === `term:${id}`);
							if (term) term.status = "pending";
						}
					}
			} else if (input.decision !== "reject" && ctx.result.kind === "review.summary") {
				const text = restoreSummaryNames(input.editedText ?? ctx.result.output.summary.text, ctx);
				if (!text.trim()) throw new ORPCError("BAD_REQUEST");
				data.summary.content = `<p>${escapeHtml(text)}</p>`;
				save = true;
			} else if (input.decision !== "reject" && ctx.result.kind === "review.tailoring") {
				if (input.subjectIds.includes("order") && input.decision === "accept_edited")
					throw new ORPCError("BAD_REQUEST");
				for (const patch of ctx.result.output.patches.filter((patch) => input.subjectIds.includes(patch.id))) {
					const target = reviewTargetSchema.parse({
						sectionId: patch.target.sectionId,
						field: patch.target.field,
						...(patch.target.itemId ? { itemId: patch.target.itemId } : {}),
						...(patch.target.roleId ? { roleId: patch.target.roleId } : {}),
					});
					const current = readTarget(data, target);
					if (
						current === undefined ||
						blockText(current) !== blockText(patch.before) ||
						/\[(?:redacted|NAME_\d+)\]/iu.test(patch.before)
					)
						conflict();
					const text = input.editedText ?? patch.after;
					writeTarget(data, target, `<p>${escapeHtml(text)}</p>`);
					if (stagesTailoring(ctx) && input.decision === "accept_edited")
						payload.segments[patch.id] = { text, status: "accepted", author: "user" };
				}
				if (input.subjectIds.includes("order"))
					for (const order of ctx.result.output.order) {
						const section = data.sections[order.sectionId as keyof typeof data.sections];
						if (!section || section.items.length !== order.itemIds.length) conflict();
						const positions = new Map(order.itemIds.map((id, index) => [id, index]));
						if (section.items.some((item) => !positions.has(item.id))) conflict();
						section.items.sort((a, b) => {
							const left = positions.get(a.id);
							const right = positions.get(b.id);
							if (left === undefined || right === undefined) conflict();
							return left - right;
						});
					}
				save = true;
			}
		}
		let updatedAt = ctx.document.updatedAt.toISOString();
		let historyVersionId: string | null = null;
		if (save) {
			data = parseResumeDataForWrite(data);
			payload.before = { data: originalData, provenance: snapshotProvenance(ctx.provenance) };
			payload.after = { data, provenance: nextProvenance };
		}
		if (save && !stagesTailoring(ctx)) {
			const saved = await updateResumeTx(tx, {
				id: ctx.document.id,
				userId: ownerId,
				data,
				expectedUpdatedAt: ctx.document.updatedAt,
				skipAutoSnapshot: true,
			});
			updatedAt = saved.updatedAt.toISOString();
			if (nextProvenance)
				await tx
					.update(resumeVariantSource)
					.set(nextProvenance)
					.where(and(eq(resumeVariantSource.userId, ownerId), eq(resumeVariantSource.resumeId, ctx.document.id)));
			historyVersionId = (await writeVersion(tx, { resumeId: ctx.document.id, userId: ownerId, data, kind: "ai" })).id;
			changed = true;
		}
		for (const id of input.subjectIds)
			if (Object.hasOwn(currentStatuses, id))
				currentStatuses[id] =
					payload.segments[id]?.status ??
					(input.decision === "undo" ? "pending" : input.decision === "reject" ? "rejected" : "accepted");
		const response = {
			decisionId: generateId(),
			operationId: input.operationId,
			statuses: currentStatuses,
			resumeId: ctx.document.id,
			updatedAt,
			data: stagesTailoring(ctx) ? ctx.document.data : data,
		};
		await tx.insert(aiReviewDecision).values({
			id: response.decisionId,
			userId: ownerId,
			operationId: input.operationId,
			resumeId: ctx.document.id,
			requestKey: input.requestKey,
			fingerprint,
			event: input.decision,
			subjectIds: input.subjectIds,
			previousDecisionId: input.undoDecisionId ?? null,
			beforeRevision: ctx.document.updatedAt.toISOString(),
			afterRevision: updatedAt,
			historyVersionId,
			response,
			variantPayload: variantDecisionPayloadSchema.parse(payload),
			createdAt: new Date(Math.max(Date.now(), (ctx.decisions.at(-1)?.createdAt.getTime() ?? 0) + 1)),
		});
		const reviewComplete =
			(ctx.result.kind === "review.translation" && currentStatuses.translation === "rejected") ||
			Object.values(currentStatuses).every((status) => status !== "pending");
		if (ctx.operation.parameters.translationBatch) {
			await tx
				.update(aiTranslationBatch)
				.set({
					reviewState: reviewComplete ? "succeeded" : "waiting_review",
				})
				.where(eq(aiTranslationBatch.rootOperationId, ctx.operation.id));
		} else if (reviewComplete)
			await tx.update(aiOperation).set({ state: "succeeded" }).where(eq(aiOperation.id, ctx.operation.id));
		if (
			ctx.result.kind === "review.translation" &&
			currentStatuses.translation === "pending" &&
			input.decision !== "undo" &&
			input.decision !== "reject" &&
			!input.subjectIds.includes("translation") &&
			(input.subjectIds.some((id) => terms.has(id)) || input.decision === "accept_edited")
		) {
			const autoApplied = await tryAutoApplyTranslationInTx(tx, ownerId, input.operationId);
			if (autoApplied) {
				changed = true;
				return {
					...response,
					decisionId: autoApplied.decisionId,
					statuses: autoApplied.statuses,
					updatedAt: autoApplied.updatedAt,
					data: autoApplied.data,
				};
			}
		}
		return response;
	});
	if (changed)
		await notifyResumeUpdated({
			type: "resume.updated",
			resumeId: response.resumeId,
			userId: ownerId,
			updatedAt: response.updatedAt,
			mutation: "update",
		});
	return response;
}

/**
 * Applies verified text to its language copy. A batch retry only applies newly recovered segments.
 * Always runs through applyReviewedTranslation and its revision/structure/placeholder guards.
 */
export async function tryAutoApplyTranslationInTx(
	tx: OwnerTransaction,
	ownerId: string,
	operationId: string,
	options?: { previousWithheldIds: ReadonlySet<string> | undefined },
) {
	const ctx = await context(tx, ownerId, operationId);
	if (
		ctx.result.kind !== "review.translation" ||
		ctx.operation.promptVersion === translationCandidateContract.promptVersion ||
		ctx.document.isLocked ||
		ctx.incompleteWithholding
	)
		return null;
	const currentStatuses = statuses(ctx);
	if (currentStatuses.translation === "rejected" || (!options && currentStatuses.translation !== "pending"))
		return null;
	try {
		await assertCurrent(tx, ownerId, ctx);
	} catch (error) {
		if (error instanceof ORPCError) return null;
		throw error;
	}
	const source = await translationSource(tx, ownerId, ctx).catch((error) => {
		if (error instanceof ORPCError) return null;
		throw error;
	});
	if (!source) return null;
	const inventory = buildTranslationInventory(source.data);
	const payload = structuredClone(await reviewPayload(tx, ownerId, ctx));
	const previousSegments = ctx.decisions.at(-1)?.variantPayload?.segments;
	const recovered =
		options && (options.previousWithheldIds || previousSegments)
			? new Set(
					Object.keys(payload.segments).filter(
						(id) => (options.previousWithheldIds?.has(id) ?? true) && !Object.hasOwn(previousSegments ?? {}, id),
					),
				)
			: undefined;
	const withheldSegmentIds = recovered
		? new Set(inventory.segments.filter(({ id }) => !recovered.has(id)).map(({ id }) => id))
		: ctx.withheldSegmentIds;
	const segments = recovered
		? Object.fromEntries(Object.entries(payload.segments).filter(([id]) => recovered.has(id)))
		: payload.segments;
	const segmentIds = Object.keys(segments);
	if (recovered?.size === 0) {
		if (Object.values(currentStatuses).every((status) => status !== "pending")) {
			await tx
				.update(aiTranslationBatch)
				.set({ reviewState: "succeeded" })
				.where(eq(aiTranslationBatch.rootOperationId, ctx.operation.id));
		}
		return null;
	}
	const evaluation = evaluateTranslationAutoApply({
		inventory,
		placeholders: translationPlaceholders(source.data),
		contactValues: resumeContactValues(ctx.document.data),
		basicsName: ctx.document.data.basics.name,
		terms: payload.terms.terms,
		segments,
		withheldSegmentIds,
		protection: ctx.compactTranslation ? prepareTranslationFacts(source.data, inventory.segments) : undefined,
	});
	if (!evaluation.ready) return null;

	for (const term of payload.terms.terms) {
		if (term.status !== "confirmed" && (!recovered || recovered.has(term.id.slice("term:".length)))) {
			term.status = "confirmed";
			term.author = "source";
		}
	}
	for (const id of segmentIds) {
		const segment = payload.segments[id];
		if (segment) segment.status = "accepted";
		if (Object.hasOwn(currentStatuses, id)) currentStatuses[id] = "accepted";
	}
	if (!recovered) currentStatuses.translation = "accepted";

	let applied: Awaited<ReturnType<typeof applyReviewedTranslation>>;
	try {
		applied = await applyReviewedTranslation(tx, ownerId, {
			resumeId: ctx.document.id,
			sourceResumeId: source.id,
			expectedSourceRevision: source.updatedAt.toISOString(),
			data: structuredClone(ctx.document.data),
			payload,
			withheldSegmentIds: ctx.withheldSegmentIds,
			compactTranslation: ctx.compactTranslation,
			...(recovered && { segmentIds: recovered }),
		});
	} catch (error) {
		if (error instanceof ORPCError) return null;
		throw error;
	}

	const data = parseResumeDataForWrite(applied.data);
	payload.before = { data: ctx.document.data, provenance: snapshotProvenance(ctx.provenance) };
	payload.after = { data, provenance: applied.provenance };
	const saved = await updateResumeTx(tx, {
		id: ctx.document.id,
		userId: ownerId,
		data,
		expectedUpdatedAt: ctx.document.updatedAt,
		skipAutoSnapshot: true,
	});
	const updatedAt = saved.updatedAt.toISOString();
	await tx
		.update(resumeVariantSource)
		.set(applied.provenance)
		.where(and(eq(resumeVariantSource.userId, ownerId), eq(resumeVariantSource.resumeId, ctx.document.id)));
	const historyVersionId = (await writeVersion(tx, { resumeId: ctx.document.id, userId: ownerId, data, kind: "ai" }))
		.id;

	const decisionId = generateId();
	const autoSubjectIds = recovered ? segmentIds : ["translation"];
	const requestKey = `auto-apply:${operationId}:${ctx.decisions.at(-1)?.id ?? "initial"}`;
	const response = {
		decisionId,
		operationId,
		statuses: currentStatuses,
		resumeId: ctx.document.id,
		updatedAt,
		data,
	};
	await tx.insert(aiReviewDecision).values({
		id: decisionId,
		userId: ownerId,
		operationId,
		resumeId: ctx.document.id,
		requestKey,
		fingerprint: createHash("sha256").update(canonicalJson({ requestKey, autoSubjectIds })).digest("hex"),
		event: "accept",
		subjectIds: autoSubjectIds,
		previousDecisionId: null,
		beforeRevision: ctx.document.updatedAt.toISOString(),
		afterRevision: updatedAt,
		historyVersionId,
		response,
		variantPayload: variantDecisionPayloadSchema.parse(payload),
		createdAt: new Date(Math.max(Date.now(), (ctx.decisions.at(-1)?.createdAt.getTime() ?? 0) + 1)),
	});
	if (ctx.operation.parameters.translationBatch) {
		await tx
			.update(aiTranslationBatch)
			.set({ reviewState: currentStatuses.translation === "accepted" ? "succeeded" : "waiting_review" })
			.where(eq(aiTranslationBatch.rootOperationId, ctx.operation.id));
	} else {
		await tx.update(aiOperation).set({ state: "succeeded" }).where(eq(aiOperation.id, ctx.operation.id));
	}
	return response;
}
