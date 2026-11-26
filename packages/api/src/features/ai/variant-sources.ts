import type { VariantSnapshot } from "./variant-types";
import type { OwnerTransaction } from "@reactive-resume/db/client";
import type { OperationRequest, SourceRevision } from "@reactive-resume/schema/ai-operation";
import type { VariantOperationKind } from "@reactive-resume/schema/resume/variants";
import { ORPCError } from "@orpc/client";
import { and, eq, isNull } from "drizzle-orm";
import { withOwnerDatabase } from "@reactive-resume/db/client";
import {
	resume,
	resumeFactLink,
	careerFact,
	resumeJobSelection,
	resumeVariantSource,
	aiReviewDecision,
	aiTranslationBatch,
} from "@reactive-resume/db/schema";
import { buildJobPassages } from "@reactive-resume/resume/ats";
import { blockText, readTarget } from "@reactive-resume/resume/proposals";
import {
	buildTranslationInventory,
	protectTranslationPlaceholders,
	translationBlockOnlyDivergence,
	translationPlaceholders,
	translationStructureMatches,
} from "@reactive-resume/resume/translation";
import { letterGenerationInputSchema } from "@reactive-resume/schema/cover-letter/review";
import { reviewTargetSchema } from "@reactive-resume/schema/resume/ai-review";
import { readJobRevision } from "../career/job-targets";
import { lockDocumentOwner } from "../documents/ownership";
import { isUneditedAiLanguageCopy } from "../resume/variants";
import { buildModelPayload, minimizeModelText, resumeContactValues } from "./payload";
import { loadReviewSource, lockReviewProfile } from "./review-sources";
import { getAiRuntime } from "./route-policy";
import {
	planTranslationBatches,
	persistTranslationPlan,
	restoreTranslationPlan,
	recoverTranslationPlan,
} from "./translation-batches";
import { bindTranslationPart, prepareTranslationFacts } from "./translation-invariants";
import { selectVariantEvidence, variantOperationContracts } from "./variant-contracts";
import { resolveWriterRoute } from "./writer-policy";

export async function loadTranslationPlan(
	tx: OwnerTransaction,
	ownerId: string,
	request: Pick<OperationRequest, "parameters">,
	full: VariantSnapshot,
	budget: { maxInputCodePoints: number; maxOutputTokens: number },
) {
	const batch = variantOperationContracts["review.translation"].parameters.parse(request.parameters).translationBatch;
	const [session] = batch
		? await tx
				.select()
				.from(aiTranslationBatch)
				.where(and(eq(aiTranslationBatch.userId, ownerId), eq(aiTranslationBatch.rootOperationId, batch.rootId)))
		: [];
	let plan = session?.plan ? restoreTranslationPlan(full, session.plan) : planTranslationBatches(full, budget);
	if (!session?.plan && batch && plan.fingerprint !== batch.planHash) {
		if (batch.planVersion) conflict();
		plan = recoverTranslationPlan(full, budget, batch.planHash) ?? conflict();
	}
	if (
		batch &&
		(batch.total !== plan.batches.length || batch.planHash !== plan.fingerprint || batch.planVersion !== plan.version)
	)
		conflict();
	if (session && !session.plan)
		await tx
			.update(aiTranslationBatch)
			.set({ plan: persistTranslationPlan(plan) })
			.where(
				and(eq(aiTranslationBatch.userId, ownerId), eq(aiTranslationBatch.rootOperationId, session.rootOperationId)),
			);
	return plan;
}

const jobSentenceBoundaries = new Intl.Segmenter(undefined, { granularity: "sentence" });
const jobHeading =
	/^(?:about (?:the job|us)|what (?:we offer|you[’']ll (?:do|bring|need))|how we hire|(?:minimum |required |preferred )?(?:requirements|qualifications|skills)|responsibilities|(?:nice|good) to have|must haves?|المتطلبات|المؤهلات|المهام|المسؤوليات|المزايا|المؤهلات المفضلة|يفضل)\s*:?$/iu;

export function buildJobAdSegments(
	jobId: string,
	revision: string,
	text: string,
	version?: "requirements-v2",
): NonNullable<VariantSnapshot["jobAd"]>["segments"] {
	const lines = text
		.split(/\r?\n/u)
		.map((line) => line.trim())
		.filter(Boolean);
	if (version && lines.length) {
		const spanId = `job:${jobId}:${revision}`;
		const seen = new Set<string>();
		const segments: NonNullable<VariantSnapshot["jobAd"]>["segments"] = [];
		let heading: string | undefined;
		for (const line of lines) {
			if (jobHeading.test(line) || (line.length <= 80 && line.endsWith(":"))) {
				heading = line;
				segments.push({ id: `${spanId}:${segments.length}`, text: line });
				continue;
			}
			const item = line.replace(/^(?:[-*•▪]|\d+[.)])\s+/u, "");
			for (const boundary of jobSentenceBoundaries.segment(item)) {
				const sentence = boundary.segment.trim();
				const key = sentence.normalize("NFC").replace(/\s+/gu, " ");
				if (!key || seen.has(key)) continue;
				seen.add(key);
				segments.push({
					id: `${spanId}:${segments.length}`,
					text: sentence,
					...(heading ? { heading } : {}),
				});
			}
		}
		return segments.length === 1 ? segments.map((segment) => ({ ...segment, id: spanId })) : segments;
	}
	if (lines.length > 1) {
		return lines.map((line, index) => ({ id: `job:${jobId}:${revision}:${index}`, text: line }));
	}
	const single = lines[0] ?? text.trim();
	const sentences = single
		.split(/(?<=[.!?؟])\s+/u)
		.map((sentence) => sentence.trim())
		.filter(Boolean);
	if (sentences.length > 1) {
		return sentences.map((sentence, index) => ({ id: `job:${jobId}:${revision}:${index}`, text: sentence }));
	}
	return [{ id: `job:${jobId}:${revision}`, text }];
}

function conflict(): never {
	throw new ORPCError("CONFLICT", { data: { reason: "AI_SOURCE_CHANGED" } });
}
async function loadSourceSnapshot(
	tx: OwnerTransaction,
	ownerId: string,
	request: Pick<OperationRequest, "kind" | "parameters" | "sources"> & Partial<Pick<OperationRequest, "route">>,
	options?: {
		fullTranslation?: boolean;
		compactTranslation?: boolean;
		includeTranslationPlan?: boolean;
		reviewChanges?: Parameters<typeof loadReviewSource>[4];
	},
): Promise<VariantSnapshot> {
	const kind = request.kind as VariantOperationKind;
	if (!Object.hasOwn(variantOperationContracts, kind)) throw new ORPCError("BAD_REQUEST");
	const contract = variantOperationContracts[kind];
	const parameters = contract.parameters.parse(request.parameters);
	await lockDocumentOwner(tx, ownerId);
	await lockReviewProfile(tx, ownerId);
	const [cv] = await tx
		.select()
		.from(resume)
		.where(and(eq(resume.userId, ownerId), eq(resume.id, parameters.resumeId), isNull(resume.trashedAt)))
		.for("share");
	if (!cv) throw new ORPCError("NOT_FOUND");
	if (cv.isLocked) throw new ORPCError("RESUME_LOCKED", { status: 403 });
	let copyRevisionMatchesPartialAutoApply = false;
	if (cv.updatedAt.toISOString() !== parameters.expectedUpdatedAt) {
		const rootId =
			kind === "review.translation"
				? (variantOperationContracts["review.translation"].parameters.parse(request.parameters).translationBatch
						?.rootId ?? null)
				: null;
		if (rootId) {
			const [autoApplied] = await tx
				.select({ id: aiReviewDecision.id })
				.from(aiReviewDecision)
				.where(
					and(
						eq(aiReviewDecision.userId, ownerId),
						eq(aiReviewDecision.operationId, rootId),
						eq(aiReviewDecision.afterRevision, cv.updatedAt.toISOString()),
					),
				)
				.limit(1);
			if (autoApplied) copyRevisionMatchesPartialAutoApply = true;
		}
		if (!copyRevisionMatchesPartialAutoApply) conflict();
	}
	const expected: SourceRevision[] = [
		{
			kind: "resume",
			id: cv.id,
			revision: copyRevisionMatchesPartialAutoApply ? parameters.expectedUpdatedAt : cv.updatedAt.toISOString(),
		},
	];
	const passages = buildJobPassages(cv.data);
	const contactValues = resumeContactValues(cv.data);
	const clean = (text: string) => {
		const named = cv.data.basics.name ? text.replaceAll(cv.data.basics.name, "[NAME_1]") : text;
		if (kind === "review.translation") return minimizeModelText(named, contactValues);
		return (
			buildModelPayload({
				selections: [{ id: "selected", kind: "confirmed_content", section: "summary", text: named }],
				contactValues,
			}).selections[0]?.text ?? ""
		);
	};
	const snapshot: VariantSnapshot = {
		category: contract.category,
		resumeId: cv.id,
		sourceRevision: parameters.expectedUpdatedAt,
		cv: passages.map((passage) => ({ id: passage.id, section: passage.target.sectionId, text: passage.text })),
		jobAd: null,
	};
	const [provenance] = await tx
		.select()
		.from(resumeVariantSource)
		.where(and(eq(resumeVariantSource.userId, ownerId), eq(resumeVariantSource.resumeId, cv.id)));
	let translationSource: typeof resume.$inferSelect | undefined;
	if (kind === "review.translation" || (kind === "review.tailoring" && cv.variantKind === "job")) {
		const sourceResumeId = provenance?.sourceResumeId ?? (kind === "review.tailoring" ? cv.baseResumeId : null);
		if (!sourceResumeId || cv.variantKind !== (kind === "review.translation" ? "language" : "job")) conflict();
		const [source] = await tx
			.select()
			.from(resume)
			.where(and(eq(resume.userId, ownerId), eq(resume.id, sourceResumeId), isNull(resume.trashedAt)))
			.for("share");
		if (!source) throw new ORPCError("NOT_FOUND");
		const expectedSource =
			kind === "review.translation"
				? variantOperationContracts[kind].parameters.parse(request.parameters).expectedSourceRevision
				: provenance
					? (provenance.acceptedSourceRevision ?? provenance.sourceRevision)
					: source.updatedAt.toISOString();
		if (source.isLocked || source.updatedAt.toISOString() !== expectedSource) conflict();
		expected.push({ kind: "resume", id: source.id, revision: source.updatedAt.toISOString() });
		if (kind === "review.translation") translationSource = source;
	}
	const links = await tx
		.select()
		.from(resumeFactLink)
		.innerJoin(careerFact, and(eq(resumeFactLink.factId, careerFact.id), eq(resumeFactLink.userId, careerFact.userId)))
		.where(and(eq(resumeFactLink.userId, ownerId), eq(resumeFactLink.resumeId, cv.id)));
	if (
		links.some(
			({ resume_fact_link: link, career_fact: fact }) =>
				link.acceptedRevision !== fact.revision || fact.status === "forgotten",
		)
	)
		conflict();
	if (kind === "review.job-evidence" || kind === "review.tailoring") {
		const jobParameters = variantOperationContracts[kind].parameters.parse(request.parameters);
		const [selection] = await tx
			.select()
			.from(resumeJobSelection)
			.where(and(eq(resumeJobSelection.userId, ownerId), eq(resumeJobSelection.resumeId, cv.id)))
			.for("share");
		if (
			!selection ||
			selection.jobId !== jobParameters.jobId ||
			selection.jobRevision !== jobParameters.jobRevision ||
			selection.updatedAt.toISOString() !== jobParameters.expectedSelectionRevision
		)
			conflict();
		const job = await readJobRevision(tx, ownerId, jobParameters.jobId, jobParameters.jobRevision);
		expected.push({ kind: "job", id: job.jobId, revision: job.revision });
		const version =
			kind === "review.job-evidence"
				? variantOperationContracts[kind].parameters.parse(request.parameters).jobSpanVersion
				: undefined;
		snapshot.jobAd = {
			segments: buildJobAdSegments(job.jobId, job.revision, job.text, version),
			...(version ? { version } : {}),
		};
	}
	if (kind === "review.summary") {
		const summaryParameters = variantOperationContracts[kind].parameters.parse(request.parameters);
		if (summaryParameters.selectedEvidenceIds.some((id) => !snapshot.cv.some((fact) => fact.id === id))) conflict();
		snapshot.cv = snapshot.cv.filter((fact) => summaryParameters.selectedEvidenceIds.includes(fact.id));
	}
	if (kind === "review.summary" || kind === "review.job-evidence") {
		const { continuationOf, answerIds } = variantOperationContracts[kind].parameters.parse(request.parameters);
		if (Boolean(continuationOf) !== Boolean(answerIds?.length)) conflict();
		for (const id of answerIds ?? []) {
			const source = request.sources.find((entry) => entry.kind === "answer" && entry.id === id);
			if (!source) conflict();
			const answer = (await loadReviewSource(tx, ownerId, source, [], options?.reviewChanges)).evidence[0];
			if (!answer) conflict();
			expected.push(source);
			snapshot.cv.push({ id, section: "summary", text: answer.quote, confirmation: "user_supplied" });
		}
	}

	if (kind === "review.tailoring") {
		snapshot.variant = {
			resumeId: cv.id,
			baseRevision: snapshot.sourceRevision,
			fields: passages
				.filter((passage) => reviewTargetSchema.safeParse(passage.target).success)
				.map((passage) => ({
					...passage.target,
					itemId: passage.target.itemId ?? null,
					roleId: passage.target.roleId ?? null,
					text: blockText(readTarget(cv.data, passage.target) ?? ""),
					evidenceIds: [passage.id],
				})),
			order: Object.entries(cv.data.sections).map(([sectionId, section]) => ({
				sectionId,
				itemIds: section.items.map((item) => item.id),
			})),
		};
	}
	if (kind === "review.translation") {
		if (
			!provenance?.targetLocale ||
			!translationSource ||
			provenance.targetLocale === translationSource.data.metadata.page.locale
		)
			conflict();
		if (
			!translationStructureMatches(translationSource.data, cv.data) &&
			!(
				translationBlockOnlyDivergence(translationSource.data, cv.data) &&
				(await isUneditedAiLanguageCopy(tx, ownerId, cv))
			)
		)
			throw new ORPCError("CONFLICT", { data: { reason: "TRANSLATION_STRUCTURE_CHANGED" } });
		const inventory = buildTranslationInventory(translationSource.data);
		if (inventory.blocking.length)
			throw new ORPCError("PRECONDITION_FAILED", {
				data: { reason: "TRANSLATION_PARTIAL_COVERAGE", sections: inventory.blockingSections },
			});
		snapshot.direction = provenance.targetLocale === "en-US" ? "ar-en" : "en-ar";
		const batch = variantOperationContracts[kind].parameters.parse(request.parameters).translationBatch;
		if (batch?.planVersion || options?.compactTranslation) {
			if (batch && !batch.planVersion) conflict();
			const prepared = prepareTranslationFacts(translationSource.data, inventory.segments);
			snapshot.translationProtection = {
				...prepared,
				binding: { direction: snapshot.direction, sourceRevision: snapshot.sourceRevision },
			};
			snapshot.cv = [...prepared.maskedSegments];
		} else {
			const placeholders = translationPlaceholders(translationSource.data);
			snapshot.cv = inventory.segments.map((segment) => ({
				id: segment.id,
				section: segment.target.sectionId,
				text: protectTranslationPlaceholders(segment.text, placeholders),
			}));
		}
	}
	if (
		request.sources.length !== expected.length ||
		expected.some(
			(source) =>
				!request.sources.some(
					(actual) => actual.kind === source.kind && actual.id === source.id && actual.revision === source.revision,
				),
		)
	)
		conflict();
	const routes = getAiRuntime().routes.filter(
		(route) =>
			!request.route ||
			(route.routeId === request.route.routeId &&
				route.routeRevision === request.route.routeRevision &&
				route.configRevision === request.route.configRevision),
	);
	const limit = Math.min(32000, ...routes.map((route) => route.maxInputCodePoints));
	try {
		if (kind === "review.translation") {
			const full = snapshot.translationProtection
				? snapshot
				: { ...snapshot, cv: snapshot.cv.map((fact) => ({ ...fact, text: clean(fact.text) })) };
			if (options?.fullTranslation) return full;
			const budget = {
				maxInputCodePoints: limit,
				maxOutputTokens: Math.min(
					4096,
					...routes.map((route) => resolveWriterRoute(route, request, getAiRuntime().writerConfig).maxOutputTokens),
				),
			};
			const plan = await loadTranslationPlan(tx, ownerId, request, full, budget);
			const batch = variantOperationContracts[kind].parameters.parse(request.parameters).translationBatch;
			const part = plan.batches[batch?.index ?? 0];
			if (!part) conflict();
			if (batch?.retrySegmentIds) {
				const ids = new Set(batch.retrySegmentIds);
				const cv = part.cv.filter(({ id }) => ids.has(id));
				if (!part.translationProtection || cv.length !== ids.size) conflict();
				return {
					...part,
					cv,
					translationProtection: bindTranslationPart(part.translationProtection, cv),
				};
			}
			return options?.includeTranslationPlan ? { ...part, translationPlan: plan } : part;
		}
		const selected = selectVariantEvidence(snapshot, limit);
		return selectVariantEvidence(
			{
				...selected,
				cv: selected.cv.map((fact) => ({ ...fact, text: clean(fact.text) })),
				jobAd: selected.jobAd
					? {
							...selected.jobAd,
							segments: selected.jobAd.segments.map(({ heading, ...segment }) => ({
								...segment,
								text: clean(segment.text),
								...(heading ? { heading: clean(heading) } : {}),
							})),
						}
					: null,
				...(selected.variant
					? {
							variant: {
								...selected.variant,
								fields: selected.variant.fields.map((field) => ({ ...field, text: clean(field.text) })),
							},
						}
					: {}),
			},
			limit,
		);
	} catch (error) {
		if (error instanceof Error && error.message === "AI_INPUT_LIMIT")
			throw new ORPCError("PRECONDITION_FAILED", { data: { reason: "AI_INPUT_LIMIT" } });
		throw error;
	}
}

export const loadVariantSnapshot = loadSourceSnapshot;

export function loadConfirmedCvContext(
	tx: OwnerTransaction,
	ownerId: string,
	request: Pick<OperationRequest, "kind" | "parameters" | "sources">,
): Promise<Pick<VariantSnapshot, "cv" | "jobAd" | "resumeId" | "sourceRevision">> {
	if (request.kind !== "review.cover-letter") return loadSourceSnapshot(tx, ownerId, request);
	const parameters = letterGenerationInputSchema.parse(request.parameters);
	// Reuse the exact T007 evidence and selection rules without creating a variant or an operation.
	return loadSourceSnapshot(tx, ownerId, {
		kind: "review.job-evidence",
		parameters: {
			resumeId: parameters.resumeId,
			expectedUpdatedAt: parameters.expectedUpdatedAt,
			jobId: parameters.jobId,
			jobRevision: parameters.jobRevision,
			expectedSelectionRevision: parameters.expectedSelectionRevision,
		},
		sources: request.sources.filter((source) => source.kind !== "cover-letter"),
	});
}

export function prepareVariantReview(ownerId: string, input: { kind: VariantOperationKind } & Record<string, unknown>) {
	return withOwnerDatabase(ownerId, async (tx) => {
		const { kind, ...raw } = input;
		if (!Object.hasOwn(variantOperationContracts, kind)) throw new ORPCError("BAD_REQUEST");
		const parameters = variantOperationContracts[kind].parameters.parse(
			kind === "review.job-evidence" ? { ...raw, jobSpanVersion: "requirements-v2" } : raw,
		);
		const sources: SourceRevision[] = [
			{ kind: "resume", id: parameters.resumeId, revision: parameters.expectedUpdatedAt },
		];
		if (kind === "review.job-evidence" || kind === "review.tailoring") {
			const jobParameters = variantOperationContracts[kind].parameters.parse(raw);
			sources.push({ kind: "job", id: jobParameters.jobId, revision: jobParameters.jobRevision });
		}
		if (kind === "review.tailoring" || kind === "review.translation") {
			const [cv] = await tx
				.select({ baseResumeId: resume.baseResumeId, variantKind: resume.variantKind })
				.from(resume)
				.where(and(eq(resume.userId, ownerId), eq(resume.id, parameters.resumeId), isNull(resume.trashedAt)));
			if (!cv) throw new ORPCError("NOT_FOUND");
			if (kind === "review.translation" || cv.variantKind === "job") {
				const [provenance] = await tx
					.select()
					.from(resumeVariantSource)
					.where(and(eq(resumeVariantSource.userId, ownerId), eq(resumeVariantSource.resumeId, parameters.resumeId)));
				if (provenance?.sourceResumeId) {
					const sourceRevision =
						kind === "review.translation"
							? variantOperationContracts[kind].parameters.parse(raw).expectedSourceRevision
							: (provenance.acceptedSourceRevision ?? provenance.sourceRevision);
					sources.push({ kind: "resume", id: provenance.sourceResumeId, revision: sourceRevision });
				} else if (kind === "review.tailoring" && cv.baseResumeId) {
					const [base] = await tx
						.select({ id: resume.id, updatedAt: resume.updatedAt })
						.from(resume)
						.where(and(eq(resume.userId, ownerId), eq(resume.id, cv.baseResumeId), isNull(resume.trashedAt)));
					if (!base) throw new ORPCError("NOT_FOUND");
					sources.push({ kind: "resume", id: base.id, revision: base.updatedAt.toISOString() });
				} else {
					throw new ORPCError("NOT_FOUND");
				}
			}
		}
		const translationHandler = kind === "review.translation" ? getAiRuntime().handlers[kind] : undefined;
		const snapshot = await loadVariantSnapshot(
			tx,
			ownerId,
			{ kind, parameters, sources },
			{
				compactTranslation: Boolean(translationHandler?.translationPlanVersion),
			},
		);
		return {
			kind,
			parameters,
			sources,
			evidenceIds: snapshot.cv.map((fact) => fact.id),
			contractVersion: translationHandler?.schemaVersion ?? variantOperationContracts[kind].schemaVersion,
		};
	});
}
