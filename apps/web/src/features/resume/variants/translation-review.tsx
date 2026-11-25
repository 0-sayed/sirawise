import type { SegmentItem, TermGroup, TranslationUndoAction, UndoableEntry } from "./translation-review-model";
import type { Proposal, ProposalState } from "@reactive-resume/resume/proposals";
import type { ResumeData } from "@reactive-resume/schema/resume/data";
import type { VariantDecisionInput } from "@reactive-resume/schema/resume/variants";
import { Trans, useLingui } from "@lingui/react/macro";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { blockText } from "@reactive-resume/resume/proposals";
import { Badge, CountBadge } from "@reactive-resume/ui/components/badge";
import { Button } from "@reactive-resume/ui/components/button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@reactive-resume/ui/components/collapsible";
import { Disclosure, DisclosureContent, DisclosureSummary } from "@reactive-resume/ui/components/disclosure";
import { Icon } from "@reactive-resume/ui/components/icon";
import { SectionCard, SectionCardRow } from "@reactive-resume/ui/components/section-card";
import { SuccessStatus } from "@reactive-resume/ui/components/success-celebration";
import { Textarea } from "@reactive-resume/ui/components/textarea";
import { escapeHtml } from "@reactive-resume/utils/string";
import { useTranslationRetryConsent } from "../editor/proposals/processing-consent";
import { ChangeSet } from "../editor/proposals/proposal-list";
import { submitVariantDecision } from "../editor/proposals/review-client";
import { TranslationPartFailure } from "../editor/proposals/review-failure";
import { ReviewNotice } from "../editor/proposals/review-operation";
import { Clarification } from "./clarification";
import { useVariantsCopy } from "./copy.generated";
import { TermDialog } from "./term-dialog";
import {
	extractVariantDecisionError,
	groupTranslationSegments,
	groupTranslationTerms,
	groupTranslationUndoActions,
	MAX_DECISION_SUBJECTS,
	submitChunkedVariantDecision,
	submitSequentialUndo,
} from "./translation-review-model";
import { FeatureBetaBadge } from "@/components/feature-beta-badge";
import { QuerySkeleton } from "@/components/query-skeleton";
import { client, orpc } from "@/libs/orpc/client";
import { getSectionTitle } from "@/libs/resume/section";

/** Decisions are server acknowledged; generated translation segments never autosave the CV. */
export function TranslationReview({
	operationId,
	sourceData,
	onSaved,
	onClose,
}: {
	operationId: string;
	sourceData?: ResumeData | undefined;
	onSaved?: () => void;
	onClose?: () => void;
}) {
	const copy = useVariantsCopy();
	const { t } = useLingui();
	const cache = useQueryClient();
	const review = useQuery(orpc.ai.variantReview.get.queryOptions({ input: { operationId } }));
	const [editing, setEditing] = useState<{ id: string; text: string } | null>(null);
	const [termSource, setTermSource] = useState<string | null>(null);
	const [showComparison, setShowComparison] = useState(false);
	const [retryKey, setRetryKey] = useState(() => crypto.randomUUID());
	const retryPart = useTranslationRetryConsent(
		async (notice, partIndex) => {
			if (partIndex === undefined) throw new Error("Missing translation part");
			await client.ai.operations.retryTranslation({
				id: operationId,
				requestKey: retryKey,
				partIndex,
				execution: { route: notice.route, consentVersion: notice.noticeVersion },
			});
			setRetryKey(crypto.randomUUID());
			await Promise.all([
				cache.invalidateQueries({
					queryKey: orpc.ai.operations.get.queryOptions({ input: { id: operationId } }).queryKey,
				}),
				cache.invalidateQueries({
					queryKey: orpc.ai.variantReview.get.queryOptions({ input: { operationId } }).queryKey,
				}),
				cache.invalidateQueries({ queryKey: orpc.resume.key() }),
			]);
		},
		review.data?.stale,
		copy("review.translation.retryThisPart"),
	);
	const pendingRequest = useRef<{ fingerprint: string; input: VariantDecisionInput } | null>(null);
	const errorNoticeRef = useRef<HTMLDivElement | null>(null);
	const decision = useMutation({
		mutationFn: (
			input: Pick<VariantDecisionInput, "subjectIds" | "decision"> &
				Partial<Pick<VariantDecisionInput, "editedText" | "undoDecisionId">> & {
					undoEntries?: UndoableEntry[];
				},
		) => {
			if (!review.data) throw new Error("REVIEW_UNAVAILABLE");
			const resumeId = review.data.result.sourceRevision.id;
			if (input.decision === "undo" && input.undoEntries && input.undoEntries.length > 1) {
				pendingRequest.current = null;
				return submitSequentialUndo({
					operationId,
					expectedUpdatedAt: review.data.updatedAt,
					expectedDecisionId: review.data.latestDecisionId,
					entries: input.undoEntries,
					submit: (payload) => submitVariantDecision(resumeId, payload),
				});
			}
			const { undoEntries: _ignored, ...decisionInput } = input;
			const needsChunking =
				decisionInput.subjectIds.length > MAX_DECISION_SUBJECTS ||
				(decisionInput.decision === "accept_edited" && decisionInput.subjectIds.length > 1);
			if (needsChunking) {
				pendingRequest.current = null;
				return submitChunkedVariantDecision({
					operationId,
					expectedUpdatedAt: review.data.updatedAt,
					expectedDecisionId: review.data.latestDecisionId,
					input: decisionInput,
					submit: (payload) => submitVariantDecision(resumeId, payload),
				});
			}
			const fingerprint = JSON.stringify({
				operationId,
				expectedUpdatedAt: review.data.updatedAt,
				expectedDecisionId: review.data.latestDecisionId,
				...decisionInput,
			});
			if (pendingRequest.current?.fingerprint !== fingerprint)
				pendingRequest.current = {
					fingerprint,
					input: {
						operationId,
						requestKey: crypto.randomUUID(),
						expectedUpdatedAt: review.data.updatedAt,
						expectedDecisionId: review.data.latestDecisionId,
						...decisionInput,
					},
				};
			return submitVariantDecision(resumeId, pendingRequest.current.input);
		},
		onSuccess: async () => {
			pendingRequest.current = null;
			setEditing(null);
			setTermSource(null);
			await Promise.all([
				review.refetch(),
				cache.invalidateQueries({ queryKey: orpc.resume.key() }),
				cache.invalidateQueries({ queryKey: orpc.career.jobTargets.key() }),
			]);
			onSaved?.();
		},
		onError: () => {
			pendingRequest.current = null;
		},
	});
	useEffect(() => {
		if (decision.error) {
			errorNoticeRef.current?.scrollIntoView?.({ block: "nearest", behavior: "smooth" });
		}
	}, [decision.error]);
	if (review.error)
		return (
			<ReviewNotice retry={() => void review.refetch()}>
				<Trans>Could not load this review.</Trans>
			</ReviewNotice>
		);
	if (!review.data) return <QuerySkeleton shape="rows" />;
	const { result, statuses, terms, segments, stale } = review.data;
	const groupedTerms = groupTranslationTerms(terms.terms);
	const hasPendingTerms = groupedTerms.pending.length > 0;
	const selectedTermGroup =
		termSource !== null
			? ([...groupedTerms.pending, ...groupedTerms.confirmed].find((group) => group.source === termSource) ?? null)
			: null;
	const groupedSegments =
		result.kind === "review.translation"
			? groupTranslationSegments({
					resultSegments: result.output.segments,
					sourceSegments: review.data.sourceSegments,
					segments,
					statuses,
					sourceData,
					terms: terms.terms,
				})
			: null;
	const hasDistinctJobSpans =
		result.kind === "review.job-evidence" &&
		(review.data.sourceSegments.length > 1 || result.output.requirements.length <= 1);
	const jobSpans = hasDistinctJobSpans ? review.data.sourceSegments : [];
	const requirementText = (spanIds: string[]) =>
		jobSpans
			.filter((span) => spanIds.includes(span.id))
			.map((span) => span.text)
			.join("\n");
	const items =
		result.kind === "review.translation"
			? []
			: result.kind === "review.summary"
				? result.output.summary.text.trim()
					? [{ id: "summary", before: blockText(review.data.beforeSummary), after: result.output.summary.text }]
					: []
				: result.kind === "review.tailoring"
					? [
							...result.output.patches.map((patch) => ({ id: patch.id, before: patch.before, after: patch.after })),
							...(result.output.order.length
								? [
										{
											id: "order",
											before: "",
											after: result.output.order
												.map((order) => `${order.sectionId}: ${order.itemIds.join(", ")}`)
												.join("\n"),
										},
									]
								: []),
						]
					: [{ id: "report", before: "", after: "" }];
	const proposals: Proposal[] =
		result.kind === "review.summary"
			? items.map((item) => ({
					...item,
					target: { sectionId: "summary", field: "content" },
					location: "Summary",
					after: `<p>${escapeHtml(item.after)}</p>`,
					why: "",
					status: statuses[item.id] ?? "pending",
					source: "improve" as const,
				}))
			: result.kind === "review.tailoring"
				? result.output.patches.map((patch) => ({
						id: patch.id,
						target: {
							sectionId: patch.target.sectionId,
							field: patch.target.field,
							...(patch.target.itemId ? { itemId: patch.target.itemId } : {}),
							...(patch.target.roleId ? { roleId: patch.target.roleId } : {}),
						},
						location: patch.target.sectionId,
						before: `<p>${escapeHtml(patch.before)}</p>`,
						after: `<p>${escapeHtml(patch.after)}</p>`,
						why: patch.why,
						status: statuses[patch.id] ?? "pending",
						source: "improve" as const,
					}))
				: [];

	const decisionError = decision.error ? extractVariantDecisionError(decision.error) : null;
	const errorSegmentId =
		decisionError?.reason === "TRANSLATION_LOCAL_VALUE_UNRESOLVED" ? decisionError.segmentId : null;
	const hasUnresolvedSegments = Boolean(groupedSegments && groupedSegments.unresolvedSegmentIds.length > 0);
	const unresolvedItems = groupedSegments
		? groupedSegments.groups.flatMap((group) => group.items.filter((item) => item.hasUnresolvedPlaceholder))
		: [];
	const isTranslationReady = result.kind === "review.translation" && statuses.translation === "accepted";
	const needsUserAttention =
		result.kind === "review.translation" &&
		statuses.translation === "pending" &&
		(hasPendingTerms || hasUnresolvedSegments);
	const showFullComparison =
		result.kind === "review.translation" && (showComparison || (!isTranslationReady && !needsUserAttention));

	const withheldSegments = new Map(
		result.kind === "review.translation" ? result.withheld?.items?.map((entry) => [entry.id, entry]) : [],
	);
	const renderRetryPart = (partIndex: number | undefined) =>
		partIndex === undefined ? null : (
			<Button
				size="sm"
				variant="secondary"
				disabled={stale || retryPart.pending}
				onClick={() => retryPart.open(partIndex)}
			>
				{copy("review.translation.retryThisPart")}
			</Button>
		);
	const renderSegmentCard = (item: SegmentItem, allowEdit = true) => {
		const withheldSegment = withheldSegments.get(item.id);
		const needsPlaceholderEdit = Boolean(
			item.hasUnresolvedPlaceholder || (errorSegmentId !== null && item.id === errorSegmentId),
		);
		const canEditAcceptedUnresolved = allowEdit && needsPlaceholderEdit && statuses.translation === "pending";
		const canRejectAccepted = item.status === "accepted" && statuses.translation === "pending" && !withheldSegment;
		return (
			<SectionCard key={item.id} variant="compact" aria-label={item.id}>
				{item.before && (
					<blockquote dir="auto" className="type-body break-words whitespace-pre-wrap text-ink-2">
						{item.before}
					</blockquote>
				)}
				{result.kind === "review.job-evidence" ? (
					result.output.requirements.map((requirement) => {
						const text = requirementText(requirement.spanIds);
						return (
							<div key={requirement.id} className="type-body break-words whitespace-pre-wrap text-ink">
								{text && <p dir="auto">{text}</p>}
								<p>
									{requirement.verdict === "supported"
										? copy("jobs.evidence.status.found")
										: requirement.verdict === "partial"
											? copy("jobs.evidence.status.partial")
											: requirement.verdict === "no_evidence"
												? copy("jobs.evidence.status.absent")
												: t`Unclear`}
								</p>
								<p dir="auto">{requirement.explanation}</p>
							</div>
						);
					})
				) : (
					<p dir="auto" className="type-body break-words whitespace-pre-wrap text-ink">
						{item.after}
					</p>
				)}
				<div className="flex flex-wrap items-center gap-2">
					{withheldSegment ? (
						<>
							<Badge variant="warn">{copy("review.translation.notTranslated")}</Badge>
							<span className="type-metadata text-ink-2">{copy("review.withheldReason.translation")}</span>
							{renderRetryPart(withheldSegment.partIndex)}
						</>
					) : (
						<SuccessStatus complete={item.status === "accepted" && !needsPlaceholderEdit}>
							{item.status === "accepted" ? (
								<Trans>Accepted</Trans>
							) : item.status === "rejected" ? (
								<Trans>Rejected</Trans>
							) : (
								<Trans>Pending</Trans>
							)}
						</SuccessStatus>
					)}
					{needsPlaceholderEdit && statuses.translation === "pending" && (
						<Badge variant="warn">{copy("language.translation.needsAttention")}</Badge>
					)}
				</div>
				{editing?.id === item.id ? (
					<>
						<Textarea
							aria-label={t`Edited text`}
							dir="auto"
							maxLength={4000}
							value={editing.text}
							onChange={(event) => setEditing({ ...editing, text: event.target.value })}
						/>
						<div className="flex flex-wrap gap-2">
							<Button
								size="sm"
								disabled={decision.isPending || !editing.text.trim() || stale}
								onClick={() =>
									decision.mutate({ subjectIds: [item.id], decision: "accept_edited", editedText: editing.text })
								}
							>
								<Trans>Save wording</Trans>
							</Button>
							<Button size="sm" variant="secondary" disabled={decision.isPending} onClick={() => setEditing(null)}>
								<Trans>Cancel</Trans>
							</Button>
						</div>
					</>
				) : item.status === "pending" ||
				  canRejectAccepted ||
				  canEditAcceptedUnresolved ||
				  segmentUndoById.has(item.id) ? (
					<div className="flex flex-wrap gap-2">
						{item.status === "pending" && (
							<Button
								size="sm"
								disabled={stale || decision.isPending}
								onClick={() => decision.mutate({ subjectIds: [item.id], decision: "accept" })}
							>
								<Trans>Accept</Trans>
							</Button>
						)}
						{((item.status === "pending" && allowEdit) || canEditAcceptedUnresolved) && (
							<Button
								size="sm"
								variant="secondary"
								disabled={stale || decision.isPending}
								onClick={() => setEditing({ id: item.id, text: item.after })}
							>
								<Trans>Edit</Trans>
							</Button>
						)}
						{(item.status === "pending" || canRejectAccepted) && (
							<Button
								size="sm"
								variant="secondary"
								disabled={decision.isPending}
								onClick={() => decision.mutate({ subjectIds: [item.id], decision: "reject" })}
							>
								<Trans>Reject</Trans>
							</Button>
						)}
						{segmentUndoById.has(item.id) && (
							<Button
								size="sm"
								variant="secondary"
								disabled={decision.isPending}
								onClick={() => {
									const action = segmentUndoById.get(item.id);
									if (action) triggerUndo(action.entries);
								}}
							>
								<Trans>Undo</Trans>
							</Button>
						)}
					</div>
				) : null}
			</SectionCard>
		);
	};

	const triggerUndo = (entries: readonly UndoableEntry[]) => {
		if (entries.length === 1 && entries[0]) {
			decision.mutate({
				subjectIds: entries[0].subjectIds,
				decision: "undo",
				undoDecisionId: entries[0].decisionId,
			});
		} else if (entries.length > 1) {
			decision.mutate({
				subjectIds: entries.flatMap((entry) => entry.subjectIds),
				decision: "undo",
				undoEntries: [...entries],
			});
		}
	};

	const translationUndoActions: TranslationUndoAction[] =
		result.kind === "review.translation" && groupedSegments
			? groupTranslationUndoActions(review.data.undoable, groupedSegments)
			: [];
	const sectionLabelForKey = (sectionKey: string | null) => {
		const group = groupedSegments?.groups.find((candidate) => candidate.key === sectionKey);
		if (!group) return copy("language.translation.otherSection");
		return (
			group.customTitle ??
			(group.sectionId === "other" ? copy("language.translation.otherSection") : getSectionTitle(group.sectionId))
		);
	};
	const sectionLabelForSegmentId = (segmentId: string | null) => {
		if (!segmentId || !groupedSegments) return null;
		const group = groupedSegments.groups.find((candidate) => candidate.items.some((item) => item.id === segmentId));
		return group ? sectionLabelForKey(group.key) : null;
	};
	const decisionErrorMessage = (() => {
		if (!decision.error) return null;
		if (decisionError?.reason === "TRANSLATION_LOCAL_VALUE_UNRESOLVED") {
			const section = sectionLabelForSegmentId(decisionError.segmentId);
			return section
				? copy("language.translation.errorUnresolved", { section })
				: copy("language.translation.errorUnresolvedGeneric");
		}
		if (decisionError?.reason === "TRANSLATION_REVIEW_INCOMPLETE") {
			return copy("language.translation.errorIncomplete");
		}
		if (decisionError?.reason === "TRANSLATION_STRUCTURE_CHANGED") {
			return copy("language.translation.errorStructureChanged");
		}
		return <Trans>The decision was not saved. Reload the review before trying again.</Trans>;
	})();
	const segmentUndoById = new Map<string, TranslationUndoAction>();
	const sectionUndoByKey = new Map<string, TranslationUndoAction>();
	for (const action of translationUndoActions) {
		if (action.kind === "segment") {
			segmentUndoById.set(action.segmentId, action);
			const group = groupedSegments?.groups.find((candidate) => candidate.key === action.sectionKey);
			if (group && group.totalCount === 1 && group.acceptedCount === 1) {
				sectionUndoByKey.set(group.key, action);
			}
		} else if (action.kind === "section") {
			sectionUndoByKey.set(action.sectionKey, action);
		} else if (action.kind === "all" && groupedSegments) {
			const coveredIds = new Set(action.entries.flatMap((entry) => entry.subjectIds));
			for (const group of groupedSegments.groups) {
				if (group.items.some((item) => coveredIds.has(item.id))) {
					sectionUndoByKey.set(group.key, action);
				}
			}
		}
	}
	const lastTranslationUndo = translationUndoActions.at(-1) ?? null;
	const lastGenericUndo = result.kind !== "review.translation" ? (review.data.undoable.at(-1) ?? null) : null;
	const lastTranslationUndoLabel = lastTranslationUndo
		? lastTranslationUndo.kind === "all"
			? copy("language.translation.undoAllDetail", { count: lastTranslationUndo.count })
			: lastTranslationUndo.kind === "section"
				? copy("language.translation.undoSectionDetail", {
						section: sectionLabelForKey(lastTranslationUndo.sectionKey),
						count: lastTranslationUndo.count,
					})
				: copy("language.translation.undoSegmentDetail", {
						section: sectionLabelForKey(lastTranslationUndo.sectionKey),
					})
		: null;

	const renderTermRow = (group: TermGroup) => (
		<SectionCardRow key={group.source} align="start" className="flex-wrap justify-between gap-2 px-3 py-2">
			<div className="grid min-w-0 flex-1 gap-1">
				<div className="flex flex-wrap items-center gap-2">
					<span dir="auto" className="type-label break-words text-ink">
						{group.source}
					</span>
					<Badge variant="neutral">{copy("language.terms.occurrences", { count: group.count })}</Badge>
					<Badge variant={group.status === "confirmed" ? "accent" : "warn"}>
						{group.status === "confirmed" ? <Trans>Confirmed</Trans> : copy("language.translation.status.pending")}
					</Badge>
				</div>
				{group.value !== group.source && (
					<p dir="auto" className="type-body break-words text-ink-2">
						{group.value}
					</p>
				)}
			</div>
			<Button
				size="sm"
				variant="secondary"
				disabled={stale || decision.isPending || statuses.translation !== "pending"}
				onClick={() => setTermSource(group.source)}
			>
				{copy("language.term.confirm")}
			</Button>
		</SectionCardRow>
	);

	return (
		<div className="grid gap-4" aria-label={copy("language.translation.review")}>
			{retryPart.dialog}
			{result.kind === "review.job-evidence" && (
				<div>
					<FeatureBetaBadge />
				</div>
			)}
			{stale && (
				<ReviewNotice retry={() => void review.refetch()}>
					<Trans>The source or this copy changed. Keep your work and request a new review.</Trans>
				</ReviewNotice>
			)}
			{result.withheld && result.withheld.count > 0 && (
				<ReviewNotice>
					{copy("review.withheldItems", { count: result.withheld.count })}
					{result.kind === "review.translation" ? (
						<div className="mt-1 type-metadata text-ink-2">
							{[...new Map((result.withheld.items ?? []).map((item) => [item.partIndex, item])).values()].map(
								(item) => (
									<div key={item.partIndex ?? 0} className="flex flex-wrap items-center gap-2">
										<TranslationPartFailure part={(item.partIndex ?? 0) + 1} code={item.reason} />
										{renderRetryPart(item.partIndex)}
									</div>
								),
							)}
						</div>
					) : (
						result.withheld.items &&
						result.withheld.items.length > 0 && (
							<ul className="mt-1 grid gap-1 type-metadata text-ink-2">
								{result.withheld.items.map((item, index) => {
									const spanText = jobSpans
										.filter((span) => item.spanIds?.includes(span.id))
										.map((span) => span.text)
										.join(" · ");
									const note = /^note:(\d+)$/u.exec(item.id);
									const requirement = /^(?:req|requirement)-(\d+)$/u.exec(item.id);
									const label = note
										? copy("review.withheldNote", { number: Number(note[1]) + 1 })
										: copy("review.withheldRequirement", { number: requirement ? Number(requirement[1]) : index + 1 });
									const reasonText =
										item.reason === "JOB_UNSUPPORTED_IMPORTANCE" || item.reason === "importance"
											? copy("review.withheldReason.importance")
											: ["JOB_UNBOUNDED_ABSENCE", "AI_VERIFICATION_ABSENCE", "absence_scope"].includes(
														item.reason ?? "",
												  )
												? copy("review.withheldReason.absence")
												: item.reason === "AI_VERIFICATION_INCOMPLETE"
													? copy("review.withheldReason.incomplete")
													: [
																"AI_UNSUPPORTED_CLAIM",
																"unsupported_claim",
																"AI_VERIFICATION_CLAIM_SUPPORT",
																"AI_VERIFICATION_PREMISE",
																"JOB_INVALID_ASSESSMENT",
														  ].includes(item.reason ?? "")
														? copy("review.withheldReason.unsupported")
														: copy("review.withheldReason.default");
									return (
										<li key={item.id} className="grid gap-1 wrap-anywhere">
											<span className="type-label">{label}</span>
											{spanText && <span dir="auto">{spanText}</span>}
											{item.text && (
												<>
													<span className="type-label">{copy("review.withheldFinding")}</span>
													<span dir="auto">{item.text}</span>
												</>
											)}
											<span>{reasonText}</span>
										</li>
									);
								})}
							</ul>
						)
					)}
				</ReviewNotice>
			)}
			{result.kind === "review.job-evidence" &&
				result.output.requirements.some((item) => item.verdict === "partial") && (
					<ReviewNotice title={copy("jobs.evidence.status.partial")} retry={() => void review.refetch()}>
						<Trans>
							Only part of the job requirement is supported by this CV. Add confirmed information or request a new
							review.
						</Trans>
					</ReviewNotice>
				)}
			{result.kind === "review.summary" &&
			!result.output.summary.text.trim() &&
			result.output.questions.length === 0 ? (
				<SectionCard>
					<div className="grid gap-3">
						<div className="flex flex-wrap items-center justify-between gap-3">
							<SuccessStatus complete>
								<Trans>No summary changes are needed. Your summary is unchanged.</Trans>
							</SuccessStatus>
							{onClose && (
								<Button size="sm" variant="secondary" onClick={onClose}>
									<Trans>Close</Trans>
								</Button>
							)}
						</div>
						{result.output.notes.map((note, index) => (
							<p key={index} dir="auto" className="type-body break-words whitespace-pre-wrap text-ink-2">
								{note}
							</p>
						))}
					</div>
				</SectionCard>
			) : (
				result.kind === "review.summary" &&
				result.output.notes.map((note, index) => (
					<p key={index} dir="auto" className="type-body break-words whitespace-pre-wrap">
						{note}
					</p>
				))
			)}
			{result.kind === "review.translation" && groupedSegments && (
				<>
					{isTranslationReady && (
						<SectionCard>
							<div className="flex flex-wrap items-center justify-between gap-3">
								<SuccessStatus complete>{copy("language.translation.ready")}</SuccessStatus>
								<Button size="sm" variant="secondary" onClick={() => setShowComparison((value) => !value)}>
									{showComparison
										? copy("language.translation.hideComparison")
										: copy("language.translation.compareWithOriginal")}
								</Button>
							</div>
						</SectionCard>
					)}

					{needsUserAttention && (
						<>
							<ReviewNotice>
								{hasUnresolvedSegments
									? copy("language.translation.unresolvedNotice")
									: copy("language.translation.needsAttentionNotice")}
							</ReviewNotice>

							{hasPendingTerms && (
								<SectionCard>
									<div className="flex flex-wrap items-start justify-between gap-2">
										<div className="grid min-w-0 gap-1">
											<p className="type-label text-ink">
												{copy("language.terms.confirmationCount", { count: groupedTerms.pending.length })}
											</p>
											<p className="type-metadata text-ink-2">{copy("language.terms.officialNamesHint")}</p>
										</div>
										<Button
											size="sm"
											variant="secondary"
											disabled={stale || decision.isPending || statuses.translation !== "pending"}
											onClick={() => decision.mutate({ subjectIds: groupedTerms.pendingTermIds, decision: "accept" })}
										>
											{copy("language.terms.keepAllNames")}
										</Button>
									</div>
									<div className="grid gap-2">{groupedTerms.pending.map(renderTermRow)}</div>
								</SectionCard>
							)}

							{hasUnresolvedSegments && (
								<div className="grid gap-3">{unresolvedItems.map((item) => renderSegmentCard(item))}</div>
							)}

							<div className="flex flex-wrap items-center gap-2">
								<Button size="sm" variant="secondary" onClick={() => setShowComparison((value) => !value)}>
									{showComparison
										? copy("language.translation.hideComparison")
										: copy("language.translation.compareWithOriginal")}
								</Button>
							</div>
						</>
					)}

					{showFullComparison && (
						<>
							<SectionCard>
								<div className="flex flex-wrap items-start justify-between gap-3">
									<div className="grid min-w-0 gap-1">
										<h2 className="type-section text-ink">{copy("language.translation.approvalTitle")}</h2>
										<p role="status" className="type-metadata text-ink-2">
											{copy("language.translation.progress", {
												accepted: groupedSegments.acceptedCount,
												total: groupedSegments.totalCount,
											})}
										</p>
									</div>
									{statuses.translation === "pending" && (
										<Button
											disabled={
												stale || decision.isPending || hasPendingTerms || groupedSegments.pendingSegmentIds.length === 0
											}
											onClick={() =>
												decision.mutate({ subjectIds: groupedSegments.pendingSegmentIds, decision: "accept" })
											}
										>
											<Trans>Accept all</Trans>
										</Button>
									)}
								</div>
								{statuses.translation === "pending" && hasPendingTerms && (
									<p className="type-metadata text-ink-2">{copy("language.translation.acceptAllDisabledNames")}</p>
								)}
							</SectionCard>

							{!needsUserAttention && (
								<SectionCard>
									{hasPendingTerms ? (
										<>
											<div className="flex flex-wrap items-start justify-between gap-2">
												<div className="grid min-w-0 gap-1">
													<p className="type-label text-ink">
														{copy("language.terms.confirmationCount", { count: groupedTerms.pending.length })}
													</p>
													<p className="type-metadata text-ink-2">{copy("language.terms.officialNamesHint")}</p>
												</div>
												<Button
													size="sm"
													variant="secondary"
													disabled={stale || decision.isPending || statuses.translation !== "pending"}
													onClick={() =>
														decision.mutate({ subjectIds: groupedTerms.pendingTermIds, decision: "accept" })
													}
												>
													{copy("language.terms.keepAllNames")}
												</Button>
											</div>
											<div className="grid gap-2">{groupedTerms.pending.map(renderTermRow)}</div>
										</>
									) : (
										<p className="type-body text-ink-2">{copy("language.terms.allConfirmed")}</p>
									)}
									{groupedTerms.confirmed.length > 0 && (
										<div className="overflow-hidden rounded-lg border border-line">
											<Disclosure>
												<DisclosureSummary>
													{copy("language.terms.showConfirmed", { count: groupedTerms.confirmed.length })}
												</DisclosureSummary>
												<DisclosureContent className="gap-2">
													{groupedTerms.confirmed.map(renderTermRow)}
												</DisclosureContent>
											</Disclosure>
										</div>
									)}
								</SectionCard>
							)}

							{groupedSegments.groups.length > 0 && (
								<SectionCard variant="flush" className="overflow-hidden">
									{groupedSegments.groups.map((group) => {
										const sectionLabel =
											group.customTitle ??
											(group.sectionId === "other"
												? copy("language.translation.otherSection")
												: getSectionTitle(group.sectionId));
										return (
											<Collapsible key={group.key} className="border-b border-line last:border-b-0">
												<div className="flex flex-col gap-2 px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
													<CollapsibleTrigger className="group/section-trigger touch-target flex min-w-0 flex-1 items-start gap-2 text-start type-label text-ink sm:items-center">
														<Icon
															name="caret-down"
															className="mt-1 size-4 shrink-0 text-ink-3 transition-transform duration-quick group-aria-expanded/section-trigger:rotate-180 motion-reduce:transition-none sm:mt-0"
															aria-hidden
														/>
														<span className="flex min-w-0 flex-1 flex-col gap-1 sm:flex-row sm:flex-wrap sm:items-center sm:gap-2">
															<span className="flex min-w-0 flex-wrap items-center gap-2">
																<span className="min-w-0 break-words" dir="auto">
																	{sectionLabel}
																</span>
																<CountBadge variant={group.pendingIds.length === 0 ? "accent" : "neutral"}>
																	{group.totalCount}
																</CountBadge>
																{statuses.translation === "pending" &&
																	(group.unresolvedIds.length > 0 ||
																		(errorSegmentId !== null &&
																			group.items.some((item) => item.id === errorSegmentId))) && (
																		<Badge variant="warn">{copy("language.translation.needsAttention")}</Badge>
																	)}
															</span>
															<span className="type-metadata text-ink-2">
																{copy("language.translation.progress", {
																	accepted: group.acceptedCount,
																	total: group.totalCount,
																})}
															</span>
														</span>
													</CollapsibleTrigger>
													<div className="flex flex-wrap items-center gap-2 self-start sm:self-auto">
														{statuses.translation === "pending" && group.pendingIds.length > 0 && (
															<Button
																size="sm"
																variant="secondary"
																disabled={stale || decision.isPending || hasPendingTerms}
																onClick={() => decision.mutate({ subjectIds: group.pendingIds, decision: "accept" })}
															>
																{copy("language.translation.acceptSection")}
															</Button>
														)}
														{statuses.translation === "pending" && sectionUndoByKey.has(group.key) && (
															<Button
																size="sm"
																variant="secondary"
																disabled={decision.isPending}
																onClick={() => {
																	const action = sectionUndoByKey.get(group.key);
																	if (action) triggerUndo(action.entries);
																}}
															>
																<Trans>Undo</Trans>
															</Button>
														)}
													</div>
												</div>
												<CollapsibleContent>
													<div className="grid gap-3 px-4 pb-4">
														{group.items.map((item) => renderSegmentCard(item))}
													</div>
												</CollapsibleContent>
											</Collapsible>
										);
									})}
								</SectionCard>
							)}
						</>
					)}
				</>
			)}
			{proposals.length > 0 && (
				<ChangeSet
					proposals={proposals}
					states={proposals.map((proposal) => (stale ? "stale" : proposal.status)) as ProposalState[]}
					locked={decision.isPending || stale}
					onAccept={(selected) => decision.mutate({ subjectIds: selected.map((item) => item.id), decision: "accept" })}
					onReject={(selected) => decision.mutate({ subjectIds: selected.map((item) => item.id), decision: "reject" })}
					onEdit={(proposal) =>
						setEditing({ id: proposal.id, text: items.find((item) => item.id === proposal.id)?.after ?? "" })
					}
				/>
			)}
			{items
				.filter((item) => !proposals.some((proposal) => proposal.id === item.id) || editing?.id === item.id)
				.map((item) =>
					renderSegmentCard(
						{ ...item, status: statuses[item.id] ?? "pending" },
						item.id !== "report" && item.id !== "order",
					),
				)}
			{showFullComparison && lastTranslationUndo && (
				<div className="flex flex-wrap items-center gap-3">
					<Button
						size="sm"
						variant="secondary"
						disabled={decision.isPending}
						onClick={() => triggerUndo(lastTranslationUndo.entries)}
					>
						{copy("language.translation.undoLastAction")}
					</Button>
					{lastTranslationUndoLabel && <span className="type-metadata text-ink-2">{lastTranslationUndoLabel}</span>}
				</div>
			)}
			{lastGenericUndo && (
				<div className="flex flex-wrap items-center gap-3">
					<Button
						size="sm"
						variant="secondary"
						disabled={decision.isPending}
						onClick={() => triggerUndo([lastGenericUndo])}
					>
						{copy("language.translation.undoLastAction")}
					</Button>
				</div>
			)}
			{decision.error && (
				<div ref={errorNoticeRef}>
					<ReviewNotice retry={() => void review.refetch()}>{decisionErrorMessage}</ReviewNotice>
				</div>
			)}
			{result.kind === "review.translation" && statuses.translation === "pending" && showFullComparison && (
				<div className="flex flex-wrap gap-2">
					<Button
						disabled={
							stale ||
							decision.isPending ||
							hasPendingTerms ||
							hasUnresolvedSegments ||
							Object.values(segments).some((segment) => segment.status !== "accepted")
						}
						onClick={() => decision.mutate({ subjectIds: ["translation"], decision: "accept" })}
					>
						<Trans>Approve language copy</Trans>
					</Button>
					<Button
						variant="secondary"
						disabled={decision.isPending}
						onClick={() => decision.mutate({ subjectIds: ["translation"], decision: "reject" })}
					>
						{copy("language.translation.backWithoutApproval")}
					</Button>
				</div>
			)}
			{
				<Clarification
					operationId={operationId}
					source={result.sourceRevision}
					questions={
						result.kind === "review.summary"
							? result.output.questions
							: result.kind === "review.job-evidence"
								? result.output.requirements
										.filter((requirement) => requirement.verdict !== "supported")
										.slice(0, 20)
										.map((requirement) => ({
											id: requirement.id,
											context: hasDistinctJobSpans ? requirementText(requirement.spanIds) : requirement.explanation,
											prompt: t`What experience, study or project can you confirm for this requirement?`,
										}))
								: []
					}
					resolved={review.data.answeredQuestionIds}
					dismissed={review.data.dismissedQuestionIds}
					stale={stale}
					onSaved={() => void review.refetch()}
				/>
			}
			{selectedTermGroup && (
				<TermDialog
					term={selectedTermGroup.representative}
					pending={decision.isPending}
					error={Boolean(decision.error)}
					onCancel={() => setTermSource(null)}
					onConfirm={(text) =>
						decision.mutate({
							subjectIds: selectedTermGroup.ids,
							decision: "accept_edited",
							editedText: text,
						})
					}
				/>
			)}
		</div>
	);
}
