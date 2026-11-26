import type { OwnerTransaction } from "@reactive-resume/db/client";
import type { ResumeData } from "@reactive-resume/schema/resume/data";
import type { VariantDecisionPayload } from "@reactive-resume/schema/resume/variants";
import type { CreateVariantInput } from "@reactive-resume/schema/resume/variants";
import { createHash } from "node:crypto";
import { ORPCError } from "@orpc/client";
import { and, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import { withOwnerDatabase } from "@reactive-resume/db/client";
import {
	aiOperation,
	aiReviewDecision,
	careerFact,
	resume,
	resumeFactLink,
	resumeJobSelection,
	resumeVariantSource,
} from "@reactive-resume/db/schema";
import {
	alignRichTextStructure,
	buildTranslationInventory,
	translationBlockOnlyDivergence,
	translationPlaceholders,
	translationStructureMatches,
	writeTranslationTarget,
} from "@reactive-resume/resume/translation";
import { createVariantInputSchema } from "@reactive-resume/schema/resume/variants";
import { resumeContactValues } from "../ai/payload";
import { prepareTranslationFacts } from "../ai/translation-invariants";
import { hasUnresolvedTranslationPlaceholder, resolveTranslationText } from "../ai/translation-placeholders";
import { readJobRevision } from "../career/job-targets";
import { lockDocumentOwner } from "../documents/ownership";
import { createResumeInTransaction } from "./service";

async function variantView(tx: OwnerTransaction, ownerId: string, resumeId: string) {
	const [cv] = await tx
		.select()
		.from(resume)
		.where(and(eq(resume.userId, ownerId), eq(resume.id, resumeId), isNull(resume.trashedAt)));
	const [provenance] = await tx
		.select()
		.from(resumeVariantSource)
		.where(and(eq(resumeVariantSource.userId, ownerId), eq(resumeVariantSource.resumeId, resumeId)));
	if (!cv || !provenance) throw new ORPCError("NOT_FOUND");
	return {
		resumeId: cv.id,
		baseResumeId: cv.baseResumeId ?? cv.id,
		variantKind: cv.variantKind,
		sourceResumeId: provenance.sourceResumeId,
		sourceRevision: provenance.sourceRevision,
		documentLocale: cv.data.metadata.page.locale,
		targetLocale: provenance.targetLocale,
		reviewState: provenance.acceptedSourceRevision ? ("accepted" as const) : ("pending" as const),
		updatedAt: cv.updatedAt.toISOString(),
	};
}

const tailoringCopyPrefix = "tailoring-copy:";

export function createVariant(
	ownerId: string,
	raw: CreateVariantInput,
	resolveReviewedData?: (tx: OwnerTransaction) => Promise<ResumeData>,
) {
	const input = createVariantInputSchema.parse(raw);
	const review = input.variantKind === "job" ? input.review : undefined;
	if (Boolean(review) !== Boolean(resolveReviewedData)) throw new ORPCError("BAD_REQUEST");
	const requestKey = review ? tailoringCopyPrefix + review.decisionId : input.requestKey;
	if (!review && requestKey.startsWith(tailoringCopyPrefix)) throw new ORPCError("BAD_REQUEST");
	const requestHash = createHash("sha256")
		.update(JSON.stringify({ ...input, requestKey }))
		.digest("hex");
	return withOwnerDatabase(ownerId, async (tx) => {
		await lockDocumentOwner(tx, ownerId);
		const [replay] = await tx
			.select()
			.from(resumeVariantSource)
			.where(and(eq(resumeVariantSource.userId, ownerId), eq(resumeVariantSource.requestKey, requestKey)));
		if (replay) {
			if (replay.requestHash !== requestHash)
				throw new ORPCError("CONFLICT", { data: { reason: "REQUEST_KEY_REUSED" } });
			return variantView(tx, ownerId, replay.resumeId);
		}
		const [source] = await tx
			.select()
			.from(resume)
			.where(and(eq(resume.userId, ownerId), eq(resume.id, input.sourceResumeId), isNull(resume.trashedAt)))
			.for("update");
		if (!source) throw new ORPCError("NOT_FOUND");
		if (source.isLocked) throw new ORPCError("RESUME_LOCKED", { status: 403 });
		if (source.updatedAt.toISOString() !== input.expectedUpdatedAt)
			throw new ORPCError("CONFLICT", { data: { reason: "RESUME_VERSION_CHANGED" } });
		if (input.variantKind === "language" && input.targetLocale === source.data.metadata.page.locale)
			throw new ORPCError("CONFLICT", { data: { reason: "LANGUAGE_ALREADY_CURRENT" } });
		if (input.variantKind === "job") await readJobRevision(tx, ownerId, input.jobId, input.jobRevision);
		const id = await createResumeInTransaction(tx, {
			userId: ownerId,
			name: source.name,
			tags: source.tags,
			data: resolveReviewedData ? await resolveReviewedData(tx) : structuredClone(source.data),
			locale: source.data.metadata.page.locale as "en-US" | "ar-SA",
			creation: { variantKind: input.variantKind, baseResumeId: source.id },
		});
		const links = await tx
			.select()
			.from(resumeFactLink)
			.where(and(eq(resumeFactLink.userId, ownerId), eq(resumeFactLink.resumeId, source.id)));
		if (links.length) await tx.insert(resumeFactLink).values(links.map((link) => ({ ...link, resumeId: id })));
		await tx.insert(resumeVariantSource).values({
			userId: ownerId,
			resumeId: id,
			sourceResumeId: source.id,
			sourceRevision: source.updatedAt.toISOString(),
			requestKey,
			requestHash,
			...(review ? { acceptedSourceRevision: source.updatedAt.toISOString() } : {}),
			targetLocale: input.variantKind === "language" ? input.targetLocale : null,
			jobId: input.variantKind === "job" ? input.jobId : null,
			jobRevision: input.variantKind === "job" ? input.jobRevision : null,
			acceptedFactRevisions: links.map((link) => ({ factId: link.factId, revision: link.acceptedRevision })),
		});
		if (input.variantKind === "job")
			await tx
				.insert(resumeJobSelection)
				.values({ userId: ownerId, resumeId: id, jobId: input.jobId, jobRevision: input.jobRevision });
		return variantView(tx, ownerId, id);
	});
}

export function getVariantFreshness(ownerId: string, resumeId: string) {
	return withOwnerDatabase(ownerId, async (tx) => {
		const variant = await variantView(tx, ownerId, resumeId);
		const [provenance] = await tx
			.select()
			.from(resumeVariantSource)
			.where(and(eq(resumeVariantSource.userId, ownerId), eq(resumeVariantSource.resumeId, resumeId)));
		if (!provenance) throw new ORPCError("NOT_FOUND");
		const [source] = provenance.sourceResumeId
			? await tx
					.select()
					.from(resume)
					.where(and(eq(resume.userId, ownerId), eq(resume.id, provenance.sourceResumeId), isNull(resume.trashedAt)))
			: [];
		const facts = provenance.acceptedFactRevisions.length
			? await tx
					.select()
					.from(careerFact)
					.where(
						and(
							eq(careerFact.userId, ownerId),
							inArray(
								careerFact.id,
								provenance.acceptedFactRevisions.map((fact) => fact.factId),
							),
						),
					)
			: [];
		const staleFactIds = provenance.acceptedFactRevisions
			.filter(
				(accepted) =>
					!facts.some(
						(fact) => fact.id === accepted.factId && fact.revision === accepted.revision && fact.status !== "forgotten",
					),
			)
			.map((fact) => fact.factId);
		const sourceChanged = Boolean(
			source && source.updatedAt.toISOString() !== (provenance.acceptedSourceRevision ?? provenance.sourceRevision),
		);
		return {
			...variant,
			state: !source
				? ("unavailable" as const)
				: sourceChanged || staleFactIds.length
					? ("stale" as const)
					: ("current" as const),
			sourceChanged,
			staleFactIds,
		};
	});
}

/** One owner-scoped family; a language switch never changes the selected document. */
export function listVariants(ownerId: string, resumeId: string, job?: { jobId: string; jobRevision: string }) {
	return withOwnerDatabase(ownerId, async (tx) => {
		const [selected] = await tx
			.select()
			.from(resume)
			.where(and(eq(resume.userId, ownerId), eq(resume.id, resumeId), isNull(resume.trashedAt)));
		if (!selected) throw new ORPCError("NOT_FOUND");
		const baseId = selected.baseResumeId ?? selected.id;
		const family = await tx
			.select()
			.from(resume)
			.where(and(eq(resume.userId, ownerId), isNull(resume.trashedAt), eq(resume.baseResumeId, baseId)));
		const [base] = await tx
			.select()
			.from(resume)
			.where(and(eq(resume.userId, ownerId), eq(resume.id, baseId), isNull(resume.trashedAt)));
		return Promise.all(
			[...(base ? [base] : []), ...family].map(async (cv) => {
				const [provenance] = await tx
					.select()
					.from(resumeVariantSource)
					.where(and(eq(resumeVariantSource.userId, ownerId), eq(resumeVariantSource.resumeId, cv.id)));
				const [selection] =
					cv.variantKind === "job"
						? await tx
								.select({ jobId: resumeJobSelection.jobId })
								.from(resumeJobSelection)
								.where(and(eq(resumeJobSelection.userId, ownerId), eq(resumeJobSelection.resumeId, cv.id)))
						: [];
				const [operation] = await tx
					.select()
					.from(aiOperation)
					.where(
						and(
							eq(aiOperation.userId, ownerId),
							eq(
								aiOperation.kind,
								cv.variantKind === "language" && !(job && cv.id === resumeId)
									? "review.translation"
									: "review.tailoring",
							),
							cv.variantKind === "language" && !(job && cv.id === resumeId)
								? sql`${aiOperation.sources} @> ${JSON.stringify([{ kind: "resume", id: cv.id }])}::jsonb`
								: sql`${aiOperation.parameters}->>'resumeId' = ${cv.id}`,
							job && cv.id === resumeId
								? sql`${aiOperation.parameters}->>'jobId' = ${job.jobId} and ${aiOperation.parameters}->>'jobRevision' = ${job.jobRevision}`
								: undefined,
						),
					)
					.orderBy(desc(aiOperation.createdAt), desc(aiOperation.id))
					.limit(1);
				return {
					resumeId: cv.id,
					name: cv.name,
					jobId: selection?.jobId ?? provenance?.jobId ?? null,
					tailoringDecisionId: provenance?.requestKey.startsWith(tailoringCopyPrefix)
						? provenance.requestKey.slice(tailoringCopyPrefix.length)
						: null,
					variantKind: cv.variantKind,
					sourceResumeId: provenance?.sourceResumeId ?? null,
					documentLocale: cv.data.metadata.page.locale,
					targetLocale: provenance?.targetLocale ?? null,
					updatedAt: cv.updatedAt.toISOString(),
					operationId:
						(operation?.parameters.translationBatch as { rootId?: string } | undefined)?.rootId ??
						operation?.id ??
						null,
				};
			}),
		);
	});
}

/** Called only by the locked final decision transaction; never persists partially reviewed content. */
/** True when a language copy has no manual edits since creation or its last accepted translation. */
export async function isUneditedAiLanguageCopy(
	tx: OwnerTransaction,
	ownerId: string,
	copy: { id: string; createdAt: Date; updatedAt: Date },
): Promise<boolean> {
	if (copy.updatedAt.getTime() === copy.createdAt.getTime()) return true;
	const [decision] = await tx
		.select({ id: aiReviewDecision.id })
		.from(aiReviewDecision)
		.where(
			and(
				eq(aiReviewDecision.userId, ownerId),
				eq(aiReviewDecision.resumeId, copy.id),
				eq(aiReviewDecision.event, "accept"),
				eq(aiReviewDecision.afterRevision, copy.updatedAt.toISOString()),
			),
		)
		.limit(1);
	return Boolean(decision);
}

export async function applyReviewedTranslation(
	tx: OwnerTransaction,
	ownerId: string,
	input: {
		resumeId: string;
		sourceResumeId: string;
		expectedSourceRevision: string;
		data: ResumeData;
		payload: VariantDecisionPayload;
		withheldSegmentIds: ReadonlySet<string>;
		segmentIds?: ReadonlySet<string>;
		compactTranslation?: boolean;
	},
) {
	const [source] = await tx
		.select()
		.from(resume)
		.where(and(eq(resume.userId, ownerId), eq(resume.id, input.sourceResumeId), isNull(resume.trashedAt)))
		.for("share");
	const [provenance] = await tx
		.select()
		.from(resumeVariantSource)
		.where(and(eq(resumeVariantSource.userId, ownerId), eq(resumeVariantSource.resumeId, input.resumeId)))
		.for("update");
	if (
		!source ||
		source.isLocked ||
		source.updatedAt.toISOString() !== input.expectedSourceRevision ||
		provenance?.sourceResumeId !== source.id ||
		!provenance.targetLocale
	)
		throw new ORPCError("CONFLICT");
	const needsAlignment = !translationStructureMatches(source.data, input.data);
	if (needsAlignment) {
		const [copyMeta] = await tx
			.select({ id: resume.id, createdAt: resume.createdAt, updatedAt: resume.updatedAt })
			.from(resume)
			.where(and(eq(resume.userId, ownerId), eq(resume.id, input.resumeId), isNull(resume.trashedAt)));
		if (
			!copyMeta ||
			!translationBlockOnlyDivergence(source.data, input.data) ||
			!(await isUneditedAiLanguageCopy(tx, ownerId, copyMeta))
		) {
			throw new ORPCError("CONFLICT", { data: { reason: "TRANSLATION_STRUCTURE_CHANGED" } });
		}
	}
	const inventory = buildTranslationInventory(source.data);
	if (inventory.blocking.length)
		throw new ORPCError("PRECONDITION_FAILED", {
			data: { reason: "TRANSLATION_PARTIAL_COVERAGE", sections: inventory.blockingSections },
		});
	const placeholders = translationPlaceholders(source.data);
	const protection = input.compactTranslation ? prepareTranslationFacts(source.data, inventory.segments) : undefined;
	const contactValues = resumeContactValues(input.data);
	const actionable = inventory.segments.filter(({ id }) => !input.withheldSegmentIds.has(id));
	const selected = input.segmentIds;
	const targets = selected ? actionable.filter(({ id }) => selected.has(id)) : actionable;
	const terms = selected
		? input.payload.terms.terms.filter(({ id }) => selected.has(id.slice("term:".length)))
		: input.payload.terms.terms;
	if (
		!targets.length ||
		(selected && targets.length !== selected.size) ||
		actionable.length !== Object.keys(input.payload.segments).length ||
		terms.some((term) => term.status !== "confirmed")
	)
		throw new ORPCError("CONFLICT", { data: { reason: "TRANSLATION_REVIEW_INCOMPLETE" } });
	const pending = new Map<string, string>();
	for (const segment of targets) {
		const approved = input.payload.segments[segment.id];
		if (!approved || approved.status !== "accepted")
			throw new ORPCError("CONFLICT", { data: { reason: "TRANSLATION_REVIEW_INCOMPLETE" } });
		const term = terms.find((term) => term.id === `term:${segment.id}`);
		const text = resolveTranslationText({
			text: approved.text,
			sourceText: segment.text,
			placeholders,
			terms: input.payload.terms.terms,
			contactValues,
			basicsName: input.data.basics.name,
			termValue: term?.value,
			scope: protection ? { sourceId: segment.id, localMap: protection.localMap } : undefined,
		});
		if (hasUnresolvedTranslationPlaceholder(text))
			throw new ORPCError("CONFLICT", {
				data: { reason: "TRANSLATION_LOCAL_VALUE_UNRESOLVED", segmentId: segment.id },
			});
		pending.set(segment.id, text);
	}
	const data = needsAlignment
		? alignRichTextStructure(
				source.data,
				input.data,
				selected || input.withheldSegmentIds.size
					? { pending, preserveEmptySlots: provenance.acceptedSourceRevision === input.expectedSourceRevision }
					: undefined,
			)
		: structuredClone(input.data);
	for (const segment of targets) {
		const text = pending.get(segment.id);
		if (text !== undefined) writeTranslationTarget(data, segment.target, text);
	}
	if (!selected) data.metadata.page.locale = provenance.targetLocale;
	return {
		data,
		provenance: {
			acceptedSourceRevision: selected ? provenance.acceptedSourceRevision : source.updatedAt.toISOString(),
			terminology: selected
				? {
						...provenance.terminology,
						terms: [
							...provenance.terminology.terms.filter(({ id }) => !selected.has(id.slice("term:".length))),
							...terms,
						],
					}
				: input.payload.terms,
			acceptedFactRevisions: provenance.acceptedFactRevisions,
		},
	};
}
