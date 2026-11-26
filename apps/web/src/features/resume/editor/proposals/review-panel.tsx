import type { Proposal } from "@reactive-resume/resume/proposals";
import type { ReviewDecisionInput, ReviewProposal } from "@reactive-resume/schema/resume/ai-review";
import { t } from "@lingui/core/macro";
import { useLingui } from "@lingui/react";
import { Trans } from "@lingui/react/macro";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useId, useRef, useState } from "react";
import { blockText, collectPassages } from "@reactive-resume/resume/proposals";
import { hasCompleteReviewScope, rebaseReviewProposal } from "@reactive-resume/resume/review-evidence";
import { ActionGroup } from "@reactive-resume/ui/components/action-group";
import { Badge } from "@reactive-resume/ui/components/badge";
import { Button } from "@reactive-resume/ui/components/button";
import {
	Dialog,
	DialogContent,
	DialogTitle,
	DialogDescription,
	DialogFooter,
} from "@reactive-resume/ui/components/dialog";
import { Disclosure, DisclosureContent, DisclosureSummary } from "@reactive-resume/ui/components/disclosure";
import { EmptyState } from "@reactive-resume/ui/components/empty-state";
import { NativeSelect } from "@reactive-resume/ui/components/native-select";
import { Textarea } from "@reactive-resume/ui/components/textarea";
import { getSectionName } from "../check/issues";
import { useEditorStore } from "../store";
import { describeEntry } from "../write/model";
import { ChangeSet } from "./proposal-list";
import { submitReviewDecision } from "./review-client";
import { ReviewLaunch, ReviewNotice, ReviewOperationPanel } from "./review-operation";
import { QuerySkeleton } from "@/components/query-skeleton";
import { useAssistantCopy } from "@/features/assistant/copy.generated";
import { assistantAvailability } from "@/features/assistant/operation-state";
import { savePendingChanges, useResumeStore } from "@/features/resume/builder/draft";
import { Clarification } from "@/features/resume/variants/clarification";
import { useVariantsCopy } from "@/features/resume/variants/copy.generated";
import { useReviewInterfaceText, useReviewSectionTitle } from "@/features/resume/variants/review-interface-copy";
import { SummaryReview } from "@/features/resume/variants/summary-review";
import { TranslationReview } from "@/features/resume/variants/translation-review";
import { formatInterfaceDate, formatRelativeTime } from "@/libs/locale";
import { client, orpc } from "@/libs/orpc/client";

export function useResumeReviewSummary(): {
	state: "loading" | "off" | "available" | "unavailable";
	pendingCount: number | null;
} {
	const resumeId = useResumeStore((state) => state.resume?.id);
	const availability = useQuery(orpc.ai.availability.queryOptions());
	const usage = useQuery(orpc.ai.usage.get.queryOptions());
	const status = assistantAvailability(
		availability.data,
		usage.data?.operations.remaining,
		usage.data?.operations.reserved,
	);
	const enabled = Boolean(resumeId) && status !== "not_enabled" && status !== "loading";
	const history = useQuery({ ...orpc.ai.review.list.queryOptions({ input: { resumeId: resumeId ?? "" } }), enabled });
	const state =
		availability.error || usage.error
			? "unavailable"
			: status === "loading"
				? "loading"
				: status === "not_enabled"
					? "off"
					: status === "unavailable" || status === "exhausted"
						? "unavailable"
						: "available";
	const pendingCount =
		state === "off" || history.error || !history.data
			? null
			: history.data.reduce(
					(total, operation) => total + operation.pendingCount + operation.unansweredQuestionCount,
					0,
				);
	return { state, pendingCount };
}

export function ReviewResultPanel({
	operationId,
	onRequestNew,
	onContinued,
	continued,
	onChanged,
}: {
	operationId: string;
	onRequestNew?: (() => void) | undefined;
	onContinued?: ((id: string) => void) | undefined;
	continued?: boolean | undefined;
	onChanged?: (() => void) | undefined;
}) {
	const copy = useAssistantCopy();
	const variantsCopy = useVariantsCopy();
	const sectionTitle = useReviewSectionTitle();
	const interfaceText = useReviewInterfaceText();
	const review = useQuery(orpc.ai.review.get.queryOptions({ input: { operationId } }));
	const queryClient = useQueryClient();
	useEffect(() => {
		if (review.dataUpdatedAt) void queryClient.invalidateQueries({ queryKey: orpc.ai.review.list.key() });
	}, [review.dataUpdatedAt, queryClient]);
	const data = useResumeStore((state) => state.resume?.data);
	const revision = useResumeStore((state) => state.acknowledgedUpdatedAt);
	const locked = useResumeStore(
		(state) =>
			!state.resume || state.resume.isLocked || Boolean(state.recoveryDraft) || state.saveStatus === "conflict",
	);
	const feedback = useEditorStore((state) => state.reviewFeedback);
	const [localError, setLocalError] = useState(false);
	const [editing, setEditing] = useState<ReviewProposal | null>(null);
	const [drafts, setDrafts] = useState<Record<string, string>>({});
	const [openEvidence, setOpenEvidence] = useState<Record<string, boolean>>({});
	const pending = useRef<ReviewDecisionInput | null>(null);
	const textId = useId();
	const evidenceId = useId();
	const decision = useMutation({
		mutationFn: (input: ReviewDecisionInput) => submitReviewDecision(input),
		onSuccess: (response, input) => {
			const restoresText =
				input.decision === "undo" &&
				review.data?.undoable.some((event) => event.decisionId === input.undoDecisionId && event.changes.length > 0);
			if (
				(input.decision === "accept" || input.decision === "accept_edited" || restoresText) &&
				review.data?.result.kind === "wording"
			) {
				const proposals = review.data.result.proposals.filter((proposal) => input.proposalIds.includes(proposal.id));
				useEditorStore.getState().setReviewFeedback({
					id: response.decisionId,
					action: input.decision === "undo" ? "undo" : "accept",
					startedAt: Date.now(),
					resumeId: response.resumeId,
					operationId: input.operationId,
					revision: response.updatedAt,
					generation: useResumeStore.getState().editGeneration,
					proposalIds: input.proposalIds,
					editedText: input.editedText,
					targets: proposals.map(({ target }) =>
						target.itemId
							? { kind: "item", sectionId: target.sectionId, itemId: target.itemId }
							: { kind: "section", sectionId: target.sectionId },
					),
				});
			}
			setEditing(null);
			onChanged?.();
			void review.refetch();
		},
		onError: () => {
			void review.refetch();
		},
	});
	if (review.error)
		return (
			<ReviewNotice
				retry={() => {
					void review.refetch();
				}}
			>
				<Trans>Could not reload this review. Your draft is kept.</Trans>
			</ReviewNotice>
		);
	if (!review.data) return <QuerySkeleton shape="rows" label={<Trans>Loading review…</Trans>} />;
	const { result, statuses, undoable } = review.data;
	if (result.kind !== "wording") return null;
	const currentResume = useResumeStore.getState().resume;
	const bound = currentResume?.id === result.sourceRevision.id;
	const choose = async (
		proposals: readonly Proposal[],
		action: ReviewDecisionInput["decision"],
		editedText?: string,
		undoDecisionId?: string,
	) => {
		const resume = useResumeStore.getState().resume;
		if (!resume || !bound || !(await savePendingChanges(resume.id))) {
			decision.reset();
			setLocalError(true);
			return;
		}
		setLocalError(false);
		const expectedUpdatedAt = useResumeStore.getState().acknowledgedUpdatedAt?.toISOString();
		if (!expectedUpdatedAt) {
			setLocalError(true);
			return;
		}
		const value = {
			operationId,
			proposalIds: proposals.map((proposal) => proposal.id),
			expectedUpdatedAt,
			decision: action,
			...(editedText !== undefined ? { editedText } : {}),
			...(undoDecisionId ? { undoDecisionId } : {}),
		};
		if (!pending.current || JSON.stringify({ ...pending.current, requestKey: undefined }) !== JSON.stringify(value))
			pending.current = { ...value, requestKey: crypto.randomUUID() };
		decision.mutate(pending.current);
	};
	const busy = decision.isPending;
	const stateOf = (proposal: ReviewProposal) => {
		if (statuses[proposal.id] !== "pending") return statuses[proposal.id] ?? "pending";
		try {
			if (!data || !hasCompleteReviewScope(proposal, result.evidence)) return "stale";
			rebaseReviewProposal(
				data,
				proposal,
				undoable.flatMap((event) => event.changes),
			);
			return "pending";
		} catch {
			return "stale";
		}
	};
	return (
		<div className="grid min-w-0 gap-4" data-testid="durable-review" data-review-operation={operationId}>
			{!bound && (
				<ReviewNotice>
					<Trans>Open this CV in the editor to review its changes.</Trans>
				</ReviewNotice>
			)}
			{(localError || decision.error) && (
				<ReviewNotice
					retry={() => {
						if (pending.current) decision.mutate(pending.current);
						else void review.refetch();
					}}
				>
					<Trans>
						The change could not be applied locally. Your writing is kept. Reload the saved review and resolve any draft
						conflict before trying again.
					</Trans>
				</ReviewNotice>
			)}
			{result.withheld && result.withheld.count > 0 && (
				<ReviewNotice>
					{variantsCopy("review.withheldItems", { count: result.withheld.count })}
					<span className="mt-1 block type-metadata text-ink-2">{variantsCopy("review.withheldReason.default")}</span>
				</ReviewNotice>
			)}
			{result.proposals.length > 0 && (
				<ChangeSet
					feedback={feedback?.operationId === operationId ? feedback : undefined}
					proposals={result.proposals.map((proposal) => ({
						...(undoable.flatMap((event) => event.changes).find((change) => change.id === proposal.id) ?? proposal),
						location: sectionTitle(proposal.target.sectionId, data),
					}))}
					states={result.proposals.map(stateOf)}
					locked={!bound || locked || busy}
					onAccept={(proposals) => {
						void choose(proposals, "accept");
					}}
					onReject={(proposals) => {
						void choose(proposals, "reject");
					}}
					onEdit={(proposal) => {
						const selected = result.proposals.find((entry) => entry.id === proposal.id);
						if (selected) {
							setEditing(selected);
							setDrafts((current) => ({
								...current,
								[selected.id]: current[selected.id] ?? blockText(selected.after),
							}));
						}
					}}
					onSuggestAgain={onRequestNew}
					renderDetails={(proposal, state) => {
						const evidenceIds = result.proposals.find((entry) => entry.id === proposal.id)?.evidenceIds;
						const evidence = result.evidence.filter((entry) => evidenceIds?.includes(entry.id));
						const expanded = openEvidence[proposal.id] ?? false;
						const panelId = `${evidenceId}-${proposal.id}`;
						const events =
							state === "accepted" || state === "rejected"
								? undoable.filter((event) => event.proposalIds.includes(proposal.id))
								: [];
						return (
							<>
								{state === "accepted" && events.length > 0 && (
									<p className="type-metadata">
										{events.some((event) => event.userSupplied) ? (
											<Trans>Your wording was saved to this CV.</Trans>
										) : (
											copy("review.suggestion.undoHint")
										)}
									</p>
								)}
								{(evidence.length > 0 || events.length > 0 || state === "stale") && (
									<ActionGroup>
										{evidence.length > 0 && (
											<Button
												size="sm"
												variant="secondary"
												aria-expanded={expanded}
												aria-controls={panelId}
												onClick={() => setOpenEvidence((current) => ({ ...current, [proposal.id]: !expanded }))}
											>
												<Trans>Evidence</Trans>
											</Button>
										)}
										{events.map((event) => (
											<Button
												key={event.decisionId}
												size="sm"
												variant="secondary"
												disabled={!bound || locked || busy}
												onClick={() => {
													void choose(
														result.proposals.filter((entry) => event.proposalIds.includes(entry.id)),
														"undo",
														undefined,
														event.decisionId,
													);
												}}
											>
												{copy("common.actions.undo")}
											</Button>
										))}
										{state === "stale" && (
											<Button
												size="sm"
												variant="secondary"
												disabled={!bound || locked || busy}
												onClick={() => {
													void choose([proposal], "reject");
												}}
											>
												{copy("review.suggestion.keepOriginal")}
											</Button>
										)}
									</ActionGroup>
								)}
								{evidence.length > 0 && (
									<ul id={panelId} hidden={!expanded} className={expanded ? "grid gap-2 type-body" : undefined}>
										{expanded &&
											evidence.map((entry) => (
												<li key={entry.id}>
													<blockquote dir="auto" className="wrap-anywhere">
														{entry.quote}
													</blockquote>
													<span className="type-metadata text-ink-3">
														{entry.confirmation === "user_supplied" ? (
															<Trans>Information you supplied</Trans>
														) : (
															<Trans>Saved source</Trans>
														)}
													</span>
													{entry.target && (
														<Button
															size="sm"
															variant="secondary"
															disabled={!bound}
															onClick={() => {
																const target = entry.target;
																if (!target) return;
																useEditorStore
																	.getState()
																	.select(
																		target.itemId
																			? { kind: "item", sectionId: target.sectionId, itemId: target.itemId }
																			: { kind: "section", sectionId: target.sectionId },
																	);
															}}
														>
															<Trans>Show source</Trans>
														</Button>
													)}
												</li>
											))}
									</ul>
								)}
							</>
						);
					}}
				/>
			)}
			{result.proposals.length === 0 && result.questions.length === 0 && (
				<p role="status">
					<Trans>No wording suggestions were found. Your CV is unchanged.</Trans>
				</p>
			)}
			{result.notes.map((note, index) => (
				<p key={index} dir="auto" className="type-body">
					{interfaceText(note, "finding")}
				</p>
			))}
			<Clarification
				key={operationId}
				operationId={operationId}
				source={result.sourceRevision}
				kind="review.wording"
				questions={result.questions}
				resolved={review.data.answeredQuestionIds}
				dismissed={review.data.dismissedQuestionIds}
				saved={review.data.questionAnswers}
				remainingAnswerSlots={review.data.remainingAnswerSlots}
				stale={!bound || locked || revision?.toISOString() !== result.sourceRevision.revision}
				continued={continued}
				onContinued={onContinued}
				onSaved={() => {
					onChanged?.();
					void review.refetch();
				}}
			/>
			<Dialog
				open={editing !== null}
				onOpenChange={(open) => {
					if (!open && !busy) setEditing(null);
				}}
			>
				<DialogContent>
					<DialogTitle>{copy("review.suggestion.inputLabel")}</DialogTitle>
					<DialogDescription>
						<Trans>Save your wording to this CV only.</Trans>
					</DialogDescription>
					<label htmlFor={textId}>{copy("review.fact.descriptionLabel")}</label>
					<Textarea
						id={textId}
						dir="auto"
						maxLength={4000}
						value={drafts[editing?.id ?? ""] ?? ""}
						onChange={(event) => {
							if (editing) setDrafts((current) => ({ ...current, [editing.id]: event.target.value }));
						}}
					/>
					<DialogFooter>
						<Button variant="secondary" disabled={busy} onClick={() => setEditing(null)}>
							{copy("common.actions.cancel")}
						</Button>
						<Button
							disabled={busy || !(drafts[editing?.id ?? ""] ?? "").trim()}
							onClick={() => {
								if (editing) void choose([editing], "accept_edited", drafts[editing.id]);
							}}
						>
							{copy("review.suggestion.saveWording")}
						</Button>
					</DialogFooter>
				</DialogContent>
			</Dialog>
		</div>
	);
}

type HistoryEntry = Awaited<ReturnType<typeof client.ai.review.list>>[number];

function isActiveReview(entry: HistoryEntry) {
	return (
		["queued", "running", "cancel_requested"].includes(entry.state) ||
		entry.pendingCount + entry.unansweredQuestionCount > 0 ||
		entry.continuationAvailable
	);
}

function reviewOutcome(entry: HistoryEntry) {
	if (entry.stale) return t`Out of date`;
	if (entry.state === "failed") return t`Failed`;
	if (entry.state === "cancelled") return t`Cancelled`;
	if (entry.acceptedCount) return t({ message: "Applied", context: "Review history outcome" });
	if (entry.rejectedCount) return t`Kept original`;
	if (entry.answeredCount) return t`Answer saved`;
	return t`Completed`;
}

export function ResumeReviewWorkspace({
	target,
	action = "review",
	request,
}: {
	target?: ReviewProposal["target"] | undefined;
	action?: "review" | "verb" | "shorter" | "result" | "custom";
	request?: string | undefined;
}) {
	const copy = useAssistantCopy();
	const { i18n } = useLingui();
	const resume = useResumeStore((state) => state.resume);
	const revision = useResumeStore((state) => state.acknowledgedUpdatedAt);
	const queryClient = useQueryClient();
	const history = useQuery({
		...orpc.ai.review.list.queryOptions({ input: { resumeId: resume?.id ?? "" } }),
		enabled: Boolean(resume),
		refetchInterval: ({ state }) =>
			state.data?.some(({ state }) => ["queued", "running", "cancel_requested"].includes(state)) ? 1000 : false,
	});
	useEffect(() => {
		if (revision) void queryClient.invalidateQueries({ queryKey: orpc.ai.review.list.key() });
	}, [revision, queryClient]);
	const [retryRequest, setRetryRequest] = useState(0);
	const [selectedTarget, setSelectedTarget] = useState("");
	const [scope, setScope] = useState<"wording" | "summary">("wording");
	const [focused, setFocused] = useState<string | null>(null);
	const [started, setStarted] = useState<{ operationId: string; kind: HistoryEntry["kind"] } | null>(null);
	const [openHistory, setOpenHistory] = useState<boolean | undefined>();
	const [openEntries, setOpenEntries] = useState<Record<string, boolean>>({});
	const selectId = useId();
	const scopeId = useId();
	const needsId = useId();
	const usage = useQuery(orpc.ai.usage.get.queryOptions());
	if (!resume) return null;
	const passages = collectPassages(resume.data, {
		summary: t`Summary`,
		sectionTitle: (id) => getSectionName(resume.data, id),
		entryTitle: (type, entry) => describeEntry(type as never, entry as never).title,
		bullet: String,
		paragraph: String,
	});
	const targetKey = (value: ReviewProposal["target"]) =>
		JSON.stringify([value.sectionId, value.itemId, value.roleId, value.field]);
	const choices = [...new Map(passages.map((passage) => [targetKey(passage.target), passage])).values()];
	const selectedAddress =
		target ?? choices.find(({ target }) => JSON.stringify(target) === selectedTarget)?.target ?? choices[0]?.target;
	const selected = selectedAddress ? JSON.stringify(selectedAddress) : "";
	const reviews = (history.data ?? []).filter(
		(entry) =>
			!target ||
			(entry.kind === "review.wording" && entry.targets.some((item) => targetKey(item.target) === targetKey(target))),
	);
	const active = reviews.filter(isActiveReview);
	const past = reviews.filter((entry) => !isActiveReview(entry));
	const pastCount = past.length;
	const needsCount = active.reduce((sum, entry) => sum + entry.pendingCount + entry.unansweredQuestionCount, 0);
	const refresh = () => void queryClient.invalidateQueries({ queryKey: orpc.ai.review.list.key() });
	const focus = (id: string) => {
		setFocused(id);
		setOpenHistory(true);
		setOpenEntries((previous) => ({ ...previous, [id]: true }));
	};
	const launch = (id: string, kind: HistoryEntry["kind"]) => {
		setStarted({ operationId: id, kind });
		focus(id);
		refresh();
	};
	const requestNew = (entry?: HistoryEntry) => {
		const address = entry?.targets[0]?.target;
		if (address && !target) setSelectedTarget(JSON.stringify(address));
		setScope("wording");
		setRetryRequest((n) => n + 1);
	};
	const prepare = async () => {
		if (!(await savePendingChanges(resume.id))) throw new Error("AI_REVIEW_SAVE_REQUIRED");
		const saved = useResumeStore.getState();
		if (!selectedAddress || saved.resume?.id !== resume.id || !saved.acknowledgedUpdatedAt)
			throw new Error("AI_REVIEW_SAVE_REQUIRED");
		const targets = [selectedAddress];
		const prepared = await client.ai.review.prepare({
			resumeId: resume.id,
			expectedUpdatedAt: saved.acknowledgedUpdatedAt.toISOString(),
			targets,
		});
		return {
			sources: prepared.sources,
			parameters: { resumeId: resume.id, targets, action, ...(request ? { request } : {}) },
		};
	};
	const title = (entry: HistoryEntry) => {
		if (entry.kind === "review.summary") return t`Summary review`;
		if (entry.kind === "review.job-evidence") return t`Job evidence`;
		if (entry.kind === "review.tailoring") return t`Job tailoring`;
		if (entry.kind === "review.translation") return t`Translation`;
		const address = entry.targets[0]?.target;
		if (!address) return t`Wording review`;
		const section =
			choices.find((choice) => targetKey(choice.target) === targetKey(address))?.location ??
			getSectionName(resume.data, address.sectionId);
		return t`Wording review · ${section}`;
	};
	const renderReview = (id: string, kind: HistoryEntry["kind"], entry?: HistoryEntry) => (
		<ReviewOperationPanel
			key={id}
			kind={kind}
			operationId={id}
			{...(kind === "review.wording" && !entry?.continuationOf ? { onRetry: () => requestNew(entry) } : {})}
		>
			{kind === "review.wording" ? (
				<ReviewResultPanel
					operationId={id}
					onRequestNew={() => requestNew(entry)}
					onChanged={() => focus(id)}
					onContinued={(nextId) => launch(nextId, kind)}
					continued={entry?.continued}
				/>
			) : (
				<TranslationReview
					operationId={id}
					sourceData={resume.data}
					onSaved={() => {
						focus(id);
						refresh();
					}}
					onContinued={(nextId) => launch(nextId, kind)}
					continued={entry?.continued}
				/>
			)}
		</ReviewOperationPanel>
	);
	const startedNotListed = started && !reviews.some((entry) => entry.operationId === started.operationId);
	const hasActive = active.length > 0 || startedNotListed;
	const remaining = usage.data?.operations.remaining;
	return (
		<div className="grid min-w-0 gap-4">
			{!target && (
				<div className="grid gap-2">
					<label htmlFor={scopeId} className="type-label">
						<Trans>Review type</Trans>
					</label>
					<NativeSelect
						id={scopeId}
						value={scope}
						onChange={(event) => setScope(event.target.value === "summary" ? "summary" : "wording")}
					>
						<option value="wording">
							<Trans>Wording review</Trans>
						</option>
						<option value="summary">
							<Trans>Summary review</Trans>
						</option>
					</NativeSelect>
				</div>
			)}
			{scope === "summary" ? (
				<SummaryReview locked={resume.isLocked} launchOnly onStarted={(id) => launch(id, "review.summary")} />
			) : (
				<div className="grid gap-2">
					{!target && choices.length > 0 && (
						<>
							<label htmlFor={selectId} className="type-label">
								<Trans>Text to review</Trans>
							</label>
							<NativeSelect id={selectId} value={selected} onChange={(event) => setSelectedTarget(event.target.value)}>
								{choices.map(({ target, location }) => (
									<option key={targetKey(target)} value={JSON.stringify(target)}>
										{location}
									</option>
								))}
							</NativeSelect>
						</>
					)}
					<ReviewLaunch
						retryRequest={retryRequest}
						key={resume.id}
						kind="review.wording"
						prepare={prepare}
						disabled={resume.isLocked || !selected}
						onStarted={(id) => launch(id, "review.wording")}
					>
						<Trans>Review wording</Trans>
					</ReviewLaunch>
					{!target && (
						<p className="type-metadata text-ink-2">
							<Trans>Only this field and its related confirmed facts are reviewed.</Trans>
						</p>
					)}
				</div>
			)}
			{!target && remaining != null && (
				<p className="type-metadata text-ink-2">{copy("billing.usage.remainingOperations", { remaining })}</p>
			)}
			{history.error ? (
				<ReviewNotice retry={refresh}>
					<Trans>Could not reload this review. Your draft is kept.</Trans>
				</ReviewNotice>
			) : history.isPending && !started ? (
				<QuerySkeleton shape="rows" label={<Trans>Loading review…</Trans>} />
			) : !hasActive && !past.length && !target ? (
				<EmptyState
					density="compact"
					title={<Trans>No reviews yet</Trans>}
					description={
						<Trans>Choose a section to improve wording or review your summary. Your results stay saved here.</Trans>
					}
				/>
			) : null}
			{hasActive && (
				<section className="grid min-w-0 gap-3" aria-labelledby={needsId}>
					<h2 id={needsId} className="type-section">
						<Trans>Needs your review ({needsCount})</Trans>
					</h2>
					{startedNotListed && renderReview(started.operationId, started.kind)}
					{active.map((entry) => (
						<div key={entry.operationId} className="grid min-w-0 gap-2 border-t border-line pt-3">
							<h3 className="min-w-0 type-label wrap-anywhere" dir="auto">
								{title(entry)}
							</h3>
							{renderReview(entry.operationId, entry.kind, entry)}
						</div>
					))}
				</section>
			)}
			{past.length > 0 && (
				<Disclosure open={openHistory ?? !hasActive} onToggle={(event) => setOpenHistory(event.currentTarget.open)}>
					<DisclosureSummary>
						<Trans>Past reviews ({pastCount})</Trans>
					</DisclosureSummary>
					<DisclosureContent>
						{past.map((entry) => {
							const id = entry.operationId;
							const open = openEntries[id] ?? (focused === id || (!hasActive && past.length === 1));
							return (
								<Disclosure
									key={id}
									open={open}
									onToggle={(event) => {
										const next = event.currentTarget.open;
										setOpenEntries((previous) => (previous[id] === next ? previous : { ...previous, [id]: next }));
									}}
								>
									<DisclosureSummary
										description={
											<time dateTime={entry.createdAt} title={formatInterfaceDate(entry.createdAt, i18n.locale)}>
												{formatRelativeTime(entry.createdAt, i18n.locale)}
											</time>
										}
									>
										<span dir="auto" className="min-w-0 wrap-anywhere">
											{title(entry)}
										</span>
										<Badge shape="tag" variant={entry.stale || entry.state === "failed" ? "warn" : "neutral"}>
											{reviewOutcome(entry)}
										</Badge>
									</DisclosureSummary>
									{open && <DisclosureContent>{renderReview(id, entry.kind, entry)}</DisclosureContent>}
								</Disclosure>
							);
						})}
					</DisclosureContent>
				</Disclosure>
			)}
		</div>
	);
}
