import type { DraftDecision } from "./translation-draft-review";
import type { SegmentItem, UndoableEntry } from "./translation-review-model";
import type { Proposal, ProposalState } from "@reactive-resume/resume/proposals";
import type { ResumeData } from "@reactive-resume/schema/resume/data";
import type { VariantDecisionInput } from "@reactive-resume/schema/resume/variants";
import { Trans, useLingui } from "@lingui/react/macro";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { buildJobPassages } from "@reactive-resume/resume/ats";
import { blockText, readTarget } from "@reactive-resume/resume/proposals";
import { ActionGroup } from "@reactive-resume/ui/components/action-group";
import { Button } from "@reactive-resume/ui/components/button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@reactive-resume/ui/components/collapsible";
import { Icon } from "@reactive-resume/ui/components/icon";
import { SectionCard } from "@reactive-resume/ui/components/section-card";
import { SuccessStatus } from "@reactive-resume/ui/components/success-celebration";
import { Textarea } from "@reactive-resume/ui/components/textarea";
import { escapeHtml } from "@reactive-resume/utils/string";
import { ChangeSet } from "../editor/proposals/proposal-list";
import { submitVariantDecision } from "../editor/proposals/review-client";
import { ReviewNotice } from "../editor/proposals/review-operation";
import { Clarification } from "./clarification";
import { useVariantsCopy } from "./copy.generated";
import { useReviewInterfaceText, useReviewSectionTitle } from "./review-interface-copy";
import { TailoringOrder, resolveTailoringOrder } from "./tailoring-order";
import { TranslationDraftReview } from "./translation-draft-review";
import {
	MAX_DECISION_SUBJECTS,
	submitApproveTranslation,
	submitChunkedVariantDecision,
	submitSequentialUndo,
} from "./translation-review-model";
import { QuerySkeleton } from "@/components/query-skeleton";
import { orpc } from "@/libs/orpc/client";

/** Decisions are server acknowledged; generated translation segments never autosave the CV. */
export function TranslationReview({
	operationId,
	sourceData,
	onSaved,
	onRetry,
	onDiscarded,
	comparingSaved = false,
	onClose,
	stageTailoring = false,
	lockDecisions = false,
	onContinued,
	continued,
	primaryAction,
	footerHint,
}: {
	operationId: string;
	sourceData?: ResumeData | undefined;
	onSaved?: () => void;
	onRetry?: () => void;
	onDiscarded?: () => void;
	comparingSaved?: boolean;
	onClose?: () => void;
	stageTailoring?: boolean;
	lockDecisions?: boolean;
	onContinued?: ((id: string) => void) | undefined;
	continued?: boolean | undefined;
	primaryAction?: ReactNode;
	footerHint?: ReactNode;
}) {
	const copy = useVariantsCopy();
	const reviewSectionTitle = useReviewSectionTitle();
	const interfaceText = useReviewInterfaceText();
	const { t } = useLingui();
	const cache = useQueryClient();
	const review = useQuery(orpc.ai.variantReview.get.queryOptions({ input: { operationId } }));
	const [editing, setEditing] = useState<{ id: string; text: string } | null>(null);
	const pendingRequest = useRef<{ fingerprint: string; input: VariantDecisionInput } | null>(null);
	const errorNoticeRef = useRef<HTMLDivElement | null>(null);
	const decision = useMutation({
		mutationFn: (input: DraftDecision & { undoEntries?: UndoableEntry[] }) => {
			if (!review.data) throw new Error("REVIEW_UNAVAILABLE");
			const resumeId = review.data.result.sourceRevision.id;
			if (input.approveSegmentIds) {
				return submitApproveTranslation({
					operationId,
					expectedUpdatedAt: review.data.updatedAt,
					expectedDecisionId: review.data.latestDecisionId,
					pendingSegmentIds: input.approveSegmentIds,
					submit: (payload) => submitVariantDecision(resumeId, payload),
				});
			}
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
			const { undoEntries: _ignored, approveSegmentIds: _approveSegmentIds, ...decisionInput } = input;
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
		onSuccess: async (_response, input) => {
			pendingRequest.current = null;
			setEditing(null);
			await Promise.all([
				review.refetch(),
				cache.invalidateQueries({ queryKey: orpc.resume.key() }),
				cache.invalidateQueries({ queryKey: orpc.career.jobTargets.key() }),
			]);
			if (review.data?.result.kind !== "review.translation") {
				onSaved?.();
			} else if (input.subjectIds.includes("translation")) {
				await cache.invalidateQueries({
					queryKey: orpc.ai.operations.get.queryOptions({ input: { id: operationId } }).queryKey,
				});
				if (input.decision === "accept") onSaved?.();
				if (input.decision === "reject") onDiscarded?.();
			}
		},
		onError: (_error, input) => {
			pendingRequest.current = null;
			// A prior chunk can already be acknowledged when a later request fails.
			if (input.approveSegmentIds) void review.refetch();
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
	const { result, statuses, segments, stale } = review.data;
	const decisionsLocked = decision.isPending || lockDecisions;
	if (result.kind === "review.translation") {
		return (
			<TranslationDraftReview
				operationId={operationId}
				review={review.data}
				result={result}
				sourceData={sourceData}
				comparingSaved={comparingSaved}
				locked={decisionsLocked || review.isFetching}
				saving={decision.isPending && decision.variables?.approveSegmentIds !== undefined}
				error={decision.error}
				decide={(input, onSuccess) => {
					if (onSuccess) decision.mutate(input, { onSuccess });
					else decision.mutate(input);
				}}
				reload={() => {
					decision.reset();
					void review.refetch();
				}}
			/>
		);
	}
	const stagedLabel =
		stageTailoring && result.kind === "review.tailoring" ? copy("jobs.tailoring.acceptedForCopy") : undefined;
	const acceptVariant = result.kind === "review.summary" ? "primary" : "secondary";
	const sectionTitle = (sectionId: string) => reviewSectionTitle(sectionId, sourceData);
	const order =
		result.kind === "review.tailoring" && sourceData
			? resolveTailoringOrder(sourceData, result.output.order, review.data.beforeOrder)
			: [];
	const jobRequirements = result.kind === "review.job-evidence" ? result.output.requirements : [];
	const jobSpans =
		result.kind === "review.job-evidence" && (review.data.sourceSegments.length > 1 || jobRequirements.length <= 1)
			? review.data.sourceSegments
			: [];
	const cvPassages = result.kind === "review.job-evidence" && sourceData ? buildJobPassages(sourceData) : [];
	const requirementText = (spanIds: string[]) =>
		jobSpans
			.filter((span) => spanIds.includes(span.id))
			.map((span) => span.text)
			.join("\n");
	// The answer endpoint exposes the first 20 non-supported requirements as questions.
	const jobQuestionIds = new Set(
		jobRequirements
			.filter(({ verdict }) => verdict !== "supported")
			.slice(0, 20)
			.map(({ id }) => id),
	);
	const items =
		result.kind === "review.summary"
			? result.output.summary.text.trim()
				? [{ id: "summary", before: blockText(review.data.beforeSummary), after: result.output.summary.text }]
				: []
			: result.kind === "review.tailoring"
				? result.output.patches.map((patch) => ({ id: patch.id, before: patch.before, after: patch.after }))
				: [{ id: "report", before: "", after: "" }];
	const proposals: Proposal[] =
		result.kind === "review.summary"
			? items.map((item) => ({
					...item,
					target: { sectionId: "summary", field: "content" },
					location: sectionTitle("summary"),
					before: review.data.beforeSummary,
					after: `<p>${escapeHtml(segments[item.id]?.text ?? item.after)}</p>`,
					why: "",
					status: statuses[item.id] ?? "pending",
					source: "improve" as const,
				}))
			: result.kind === "review.tailoring"
				? result.output.patches.map((patch) => {
						const target = {
							sectionId: patch.target.sectionId,
							field: patch.target.field,
							...(patch.target.itemId ? { itemId: patch.target.itemId } : {}),
							...(patch.target.roleId ? { roleId: patch.target.roleId } : {}),
						};
						const original = sourceData && readTarget(sourceData, target);
						return {
							id: patch.id,
							target,
							location: sectionTitle(target.sectionId),
							before:
								original !== undefined && blockText(original) === patch.before
									? original
									: `<p>${escapeHtml(patch.before)}</p>`,
							after: `<p>${escapeHtml(segments[patch.id]?.text ?? patch.after)}</p>`,
							why: patch.why,
							status: statuses[patch.id] ?? "pending",
							source: "improve" as const,
						};
					})
				: [];

	const renderSegmentCard = (item: SegmentItem, label: string, content?: ReactNode) => {
		const allowEdit = item.id !== "report" && item.id !== "order";
		return (
			<SectionCard key={item.id} variant="compact" aria-label={label}>
				{content}
				{item.before && (
					<blockquote dir="auto" className="type-body break-words whitespace-pre-wrap text-ink-2">
						{item.before}
					</blockquote>
				)}
				{item.id === "report" && result.kind === "review.job-evidence" ? (
					<Clarification
						groupByContext
						kind="review.job-evidence"
						onContinued={onContinued}
						continued={continued ?? review.data?.continued}
						remainingAnswerSlots={review.data?.remainingAnswerSlots}
						saved={review.data?.questionAnswers}
						operationId={operationId}
						source={result.sourceRevision}
						questions={jobRequirements.map(({ id, spanIds, verdict, explanation, evidenceIds }) => ({
							id,
							context: requirementText(spanIds) || undefined,
							evidence: cvPassages
								.filter((passage) => evidenceIds.includes(passage.id))
								.map((passage) => (
									<div key={passage.id} className="grid gap-2">
										<blockquote dir="auto" className="wrap-anywhere">
											{passage.text}
										</blockquote>
										<div>
											<Button
												variant="secondary"
												nativeButton={false}
												render={
													<Link
														role="link"
														to="/builder/$resumeId"
														params={{ resumeId: result.sourceRevision.id }}
														search={{ source: passage.target }}
													/>
												}
											>
												{copy("jobs.evidence.showInCv")}
											</Button>
										</div>
									</div>
								)),
							prompt: onContinued && jobQuestionIds.has(id) ? copy("review.clarification.requirement") : undefined,
							finding: {
								verdict:
									verdict === "supported"
										? copy("jobs.evidence.status.found")
										: verdict === "partial"
											? copy("jobs.evidence.status.partial")
											: verdict === "no_evidence"
												? copy("jobs.evidence.status.absent")
												: t`Unclear`,
								explanation: interfaceText(explanation, "finding"),
							},
						}))}
						resolved={review.data?.answeredQuestionIds ?? []}
						dismissed={review.data?.dismissedQuestionIds}
						stale={stale}
						onSaved={() => void review.refetch()}
					/>
				) : item.after ? (
					<p dir="auto" className="type-body break-words whitespace-pre-wrap text-ink">
						{item.after}
					</p>
				) : null}
				<div className="flex flex-wrap items-center gap-2">
					<SuccessStatus complete={item.status === "accepted"}>
						{item.status === "accepted" ? (
							(stagedLabel ?? <Trans>Accepted</Trans>)
						) : item.status === "rejected" ? (
							<Trans>Rejected</Trans>
						) : (
							<Trans>Pending</Trans>
						)}
					</SuccessStatus>
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
						<ActionGroup responsive="stack">
							<Button
								size="sm"
								variant={acceptVariant}
								disabled={decisionsLocked || !editing.text.trim() || stale}
								onClick={() =>
									decision.mutate({ subjectIds: [item.id], decision: "accept_edited", editedText: editing.text })
								}
							>
								<Trans>Save wording</Trans>
							</Button>
							<Button size="sm" variant="secondary" disabled={decision.isPending} onClick={() => setEditing(null)}>
								<Trans>Cancel</Trans>
							</Button>
						</ActionGroup>
					</>
				) : item.status === "pending" ? (
					<ActionGroup responsive="stack">
						{item.status === "pending" && (
							<Button
								size="sm"
								variant={acceptVariant}
								disabled={stale || decisionsLocked}
								onClick={() => decision.mutate({ subjectIds: [item.id], decision: "accept" })}
							>
								<Trans>Accept</Trans>
							</Button>
						)}
						{allowEdit && (
							<Button
								size="sm"
								variant="secondary"
								disabled={stale || decisionsLocked}
								onClick={() => setEditing({ id: item.id, text: item.after })}
							>
								<Trans>Edit</Trans>
							</Button>
						)}
						{item.status === "pending" && (
							<Button
								size="sm"
								variant="secondary"
								disabled={decision.isPending}
								onClick={() => decision.mutate({ subjectIds: [item.id], decision: "reject" })}
							>
								<Trans>Reject</Trans>
							</Button>
						)}
					</ActionGroup>
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

	const lastGenericUndo = review.data.undoable.at(-1) ?? null;
	const uncheckedRequirements = result.withheld?.items?.filter((item) => !item.id.startsWith("note:"));
	const uncheckedRequirementCount = uncheckedRequirements?.length ?? result.withheld?.count ?? 0;
	const uncheckedTitles = [
		...new Set(
			uncheckedRequirements?.map((item, index) => {
				const span = jobSpans.find((entry) => item.spanIds?.includes(entry.id));
				const number = /^(?:req|requirement)-(\d+)$/u.exec(item.id)?.[1];
				return span?.text ?? copy("review.withheldRequirement", { number: number ? Number(number) : index + 1 });
			}),
		),
	];

	return (
		<div className="grid gap-4 text-content-start" aria-label={copy("language.translation.review")}>
			{stale && (
				<ReviewNotice retry={onRetry ?? (() => void review.refetch())}>
					<Trans>The source or this copy changed. Keep your work and request a new review.</Trans>
				</ReviewNotice>
			)}
			{result.withheld &&
				result.withheld.count > 0 &&
				(result.kind === "review.job-evidence" ? (
					<div className="grid min-w-0 gap-2">
						<p className="type-body text-ink-2">
							{uncheckedRequirementCount
								? copy("jobs.evidence.withheldSummary", { count: uncheckedRequirementCount })
								: copy("jobs.evidence.withheldNotes")}
						</p>
						{uncheckedTitles.length > 0 && (
							<Collapsible>
								<CollapsibleTrigger render={<Button variant="quiet" />}>
									{copy("jobs.evidence.withheldTitles")}
									<Icon name="caret-down" className="group-aria-expanded/button:rotate-180" aria-hidden />
								</CollapsibleTrigger>
								<CollapsibleContent>
									<ul className="grid min-w-0 gap-1 type-metadata text-ink-2">
										{uncheckedTitles.map((title) => (
											<li key={title} className="min-w-0">
												<bdi dir="auto" className="block truncate">
													{title}
												</bdi>
											</li>
										))}
									</ul>
								</CollapsibleContent>
							</Collapsible>
						)}
						{onRetry && !stale && (
							<Button variant="secondary" className="justify-self-start" onClick={onRetry}>
								<Trans>Retry</Trans>
							</Button>
						)}
					</div>
				) : (
					<ReviewNotice>{copy("review.withheldItems", { count: result.withheld.count })}</ReviewNotice>
				))}
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
								{interfaceText(note, "finding")}
							</p>
						))}
					</div>
				</SectionCard>
			) : (
				result.kind === "review.summary" &&
				result.output.notes.map((note, index) => (
					<p key={index} dir="auto" className="type-body break-words whitespace-pre-wrap">
						{interfaceText(note, "finding")}
					</p>
				))
			)}
			{proposals.length > 0 && (
				<ChangeSet
					proposals={proposals}
					states={proposals.map((proposal) => (stale ? "stale" : proposal.status)) as ProposalState[]}
					locked={decisionsLocked || stale}
					acceptedLabel={stagedLabel}
					acceptVariant={acceptVariant}
					allowAcceptAll={result.kind !== "review.tailoring"}
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
						item.id === "report"
							? copy("jobs.evidence.detailsTitle")
							: (proposals.find((proposal) => proposal.id === item.id)?.location ?? sectionTitle("summary")),
					),
				)}
			{order.length > 0 &&
				renderSegmentCard(
					{ id: "order", before: "", after: "", status: statuses.order ?? "pending" },
					copy("review.tailoring.order.title"),
					<TailoringOrder sections={order} sectionTitle={sectionTitle} />,
				)}
			{(primaryAction || lastGenericUndo) && (
				<footer className="grid gap-2">
					{footerHint}
					<ActionGroup responsive="stack">
						{primaryAction}
						{lastGenericUndo && (
							<Button variant="secondary" disabled={decisionsLocked} onClick={() => triggerUndo([lastGenericUndo])}>
								{copy("language.translation.undoLastAction")}
							</Button>
						)}
					</ActionGroup>
				</footer>
			)}
			{result.kind === "review.job-evidence" && onRetry && !stale && !result.withheld?.count && (
				<Button variant="secondary" className="justify-self-start" onClick={onRetry}>
					{copy("jobs.evidence.check")}
				</Button>
			)}
			{decision.error && (
				<div ref={errorNoticeRef}>
					<ReviewNotice retry={() => void review.refetch()}>
						<Trans>The decision was not saved. Reload the review before trying again.</Trans>
					</ReviewNotice>
				</div>
			)}
			{result.kind === "review.summary" && (
				<Clarification
					operationId={operationId}
					source={result.sourceRevision}
					kind="review.summary"
					onContinued={onContinued}
					continued={continued ?? review.data.continued}
					remainingAnswerSlots={review.data.remainingAnswerSlots}
					saved={review.data.questionAnswers}
					questions={result.output.questions}
					resolved={review.data.answeredQuestionIds}
					dismissed={review.data.dismissedQuestionIds}
					stale={stale}
					onSaved={() => void review.refetch()}
				/>
			)}
		</div>
	);
}
