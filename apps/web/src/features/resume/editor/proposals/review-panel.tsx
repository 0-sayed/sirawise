import type { Proposal } from "@reactive-resume/resume/proposals";
import type { ReviewDecisionInput, ReviewProposal } from "@reactive-resume/schema/resume/ai-review";
import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useId, useRef, useState } from "react";
import { blockText, collectPassages } from "@reactive-resume/resume/proposals";
import { hasCompleteReviewScope, rebaseReviewProposal } from "@reactive-resume/resume/review-evidence";
import { Button } from "@reactive-resume/ui/components/button";
import {
	Dialog,
	DialogContent,
	DialogTitle,
	DialogDescription,
	DialogFooter,
} from "@reactive-resume/ui/components/dialog";
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
import { useVariantsCopy } from "@/features/resume/variants/copy.generated";
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
					(total, operation) => total + operation.targets.reduce((count, entry) => count + entry.pendingCount, 0),
					0,
				);
	return { state, pendingCount };
}

export function ReviewResultPanel({
	operationId,
	onRequestNew,
}: {
	operationId: string;
	onRequestNew?: (() => void) | undefined;
}) {
	const copy = useAssistantCopy();
	const variantsCopy = useVariantsCopy();
	const review = useQuery(orpc.ai.review.get.queryOptions({ input: { operationId } }));
	const queryClient = useQueryClient();
	useEffect(() => {
		if (review.dataUpdatedAt) void queryClient.invalidateQueries({ queryKey: orpc.ai.review.list.key() });
	}, [review.dataUpdatedAt, queryClient]);
	const data = useResumeStore((state) => state.resume?.data);
	const locked = useResumeStore(
		(state) =>
			!state.resume || state.resume.isLocked || Boolean(state.recoveryDraft) || state.saveStatus === "conflict",
	);
	const feedback = useEditorStore((state) => state.reviewFeedback);
	const [localError, setLocalError] = useState(false);
	const [editing, setEditing] = useState<ReviewProposal | null>(null);
	const [answering, setAnswering] = useState<string | null>(null);
	const [drafts, setDrafts] = useState<Record<string, string>>({});
	const pending = useRef<ReviewDecisionInput | null>(null);
	const textId = useId();
	const decision = useMutation({
		mutationFn: (input: ReviewDecisionInput) => submitReviewDecision(input),
		onSuccess: (response, input) => {
			if (input.decision !== "reject" && review.data?.result.kind === "wording") {
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
			void review.refetch();
		},
		onError: () => {
			void review.refetch();
		},
	});
	const answers = useMutation({
		mutationFn: async ({ questionId, text, requestKey }: { questionId: string; text?: string; requestKey: string }) => {
			if (!review.data) throw new Error("AI_REVIEW_UNAVAILABLE");
			if (text === undefined) {
				await client.ai.review.dismissQuestion({ operationId, questionId, requestKey });
				return;
			}
			await client.ai.review.answer({
				operationId,
				questionId,
				requestKey,
				expectedSource: review.data.result.sourceRevision,
				text,
			});
		},
		onSuccess: () => {
			setAnswering(null);
			void review.refetch();
		},
	});
	const answerRequest = useRef<{ questionId: string; text?: string; requestKey: string } | null>(null);
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
	const busy = decision.isPending || answers.isPending;
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
	const resolvedQuestions = new Set([...review.data.dismissedQuestionIds, ...review.data.answeredQuestionIds]);
	const sendAnswer = (questionId: string, text?: string) => {
		if (
			!answerRequest.current ||
			answerRequest.current.questionId !== questionId ||
			answerRequest.current.text !== text
		)
			answerRequest.current = { questionId, ...(text === undefined ? {} : { text }), requestKey: crypto.randomUUID() };
		answers.mutate(answerRequest.current);
	};
	return (
		<div className="grid min-w-0 gap-4" data-testid="durable-review">
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
			{answers.error && (
				<ReviewNotice
					retry={() => {
						if (answerRequest.current) answers.mutate(answerRequest.current);
					}}
				>
					<Trans>Could not save your answer. Your text is kept.</Trans>
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
					proposals={result.proposals.map(
						(proposal) =>
							undoable.flatMap((event) => event.changes).find((change) => change.id === proposal.id) ?? proposal,
					)}
					states={result.proposals.map(stateOf)}
					locked={!bound || locked || busy}
					keepLabel={copy("review.suggestion.keepOriginal")}
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
					renderDetails={(proposal, state) => (
						<>
							<details className="type-body">
								<summary className="cursor-pointer text-ink-2">
									<Trans>Evidence</Trans>
								</summary>
								<ul className="grid gap-2">
									{result.evidence
										.filter((entry) =>
											result.proposals.find((entry) => entry.id === proposal.id)?.evidenceIds.includes(entry.id),
										)
										.map((entry) => (
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
							</details>
							{state === "accepted" &&
								undoable
									.filter((event) => event.proposalIds.includes(proposal.id))
									.map((event) => (
										<div key={event.decisionId}>
											<p className="type-metadata">
												{event.userSupplied ? (
													<Trans>Your wording was saved to this CV.</Trans>
												) : (
													copy("review.suggestion.undoHint")
												)}
											</p>
											<Button
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
										</div>
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
						</>
					)}
				/>
			)}
			{result.proposals.length === 0 && result.questions.length === 0 && (
				<p role="status">
					<Trans>No wording suggestions were found. Your CV is unchanged.</Trans>
				</p>
			)}
			{result.notes.map((note, index) => (
				<p key={index} dir="auto" className="type-body">
					{note}
				</p>
			))}
			{result.questions
				.filter((question) => !resolvedQuestions.has(question.id))
				.map((question) => (
					<div key={question.id} className="grid gap-2 rounded-lg border border-line p-3">
						<p dir="auto">{question.prompt}</p>
						<div className="flex flex-wrap gap-2">
							<Button variant="secondary" disabled={!bound || busy} onClick={() => setAnswering(question.id)}>
								{copy("jobs.letter.addInformation")}
							</Button>
							<Button variant="ghost" disabled={busy} onClick={() => sendAnswer(question.id)}>
								<Trans>Dismiss</Trans>
							</Button>
						</div>
					</div>
				))}
			<Dialog
				open={editing !== null || answering !== null}
				onOpenChange={(open) => {
					if (!open && !busy) {
						setEditing(null);
						setAnswering(null);
					}
				}}
			>
				<DialogContent>
					<DialogTitle>
						{editing ? copy("review.suggestion.inputLabel") : copy("jobs.letter.addInformation")}
					</DialogTitle>
					<DialogDescription>
						{editing ? (
							<Trans>Save your wording to this CV only.</Trans>
						) : (
							<Trans>
								Write the information you want to supply. It will not change your CV or career information. Requesting a
								new suggestion uses another operation.
							</Trans>
						)}
					</DialogDescription>
					<label htmlFor={textId}>{copy("review.fact.descriptionLabel")}</label>
					<Textarea
						id={textId}
						dir="auto"
						maxLength={4000}
						value={drafts[editing?.id ?? answering ?? ""] ?? ""}
						onChange={(event) =>
							setDrafts((current) => ({ ...current, [editing?.id ?? answering ?? ""]: event.target.value }))
						}
					/>
					<DialogFooter>
						<Button
							variant="secondary"
							disabled={busy}
							onClick={() => {
								setEditing(null);
								setAnswering(null);
							}}
						>
							{copy("common.actions.cancel")}
						</Button>
						<Button
							disabled={busy || !(drafts[editing?.id ?? answering ?? ""] ?? "").trim()}
							onClick={() => {
								if (editing) void choose([editing], "accept_edited", drafts[editing.id]);
								else if (answering) sendAnswer(answering, drafts[answering]);
							}}
						>
							{editing ? copy("review.suggestion.saveWording") : copy("review.fact.save")}
						</Button>
					</DialogFooter>
				</DialogContent>
			</Dialog>
		</div>
	);
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
	const resume = useResumeStore((state) => state.resume);
	const history = useQuery({
		...orpc.ai.review.list.queryOptions({ input: { resumeId: resume?.id ?? "" } }),
		enabled: Boolean(resume),
	});
	const [retryRequest, setRetryRequest] = useState(0);
	const [selectedTarget, setSelectedTarget] = useState("");
	const selectId = useId();
	const [chosenReview, setChosenReview] = useState<{ resumeId: string; target: string; operationId: string } | null>(
		null,
	);
	const historySelectId = useId();
	const queryClient = useQueryClient();
	if (!resume) return null;
	const passages = collectPassages(resume.data, {
		summary: t`Summary`,
		sectionTitle: (id) => getSectionName(resume.data, id),
		entryTitle: (type, entry) => describeEntry(type as never, entry as never).title,
		bullet: (n) => String(n),
		paragraph: (n) => String(n),
	});
	const choices = [...new Map(passages.map((passage) => [JSON.stringify(passage.target), passage])).entries()];
	const selected = target
		? JSON.stringify(target)
		: choices.some(([key]) => key === selectedTarget)
			? selectedTarget
			: (choices[0]?.[0] ?? "");
	const sameTarget = (candidate: ReviewProposal["target"], selected: ReviewProposal["target"]) =>
		candidate.sectionId === selected.sectionId &&
		candidate.itemId === selected.itemId &&
		candidate.roleId === selected.roleId &&
		candidate.field === selected.field;
	const selectedAddress = target ?? choices.find(([key]) => key === selected)?.[1].target;
	const reviews =
		history.data?.filter((operation) =>
			operation.targets.some((entry) => selectedAddress && sameTarget(entry.target, selectedAddress)),
		) ?? [];
	const operationId =
		chosenReview?.resumeId === resume.id && chosenReview.target === selected
			? chosenReview.operationId
			: reviews[0]?.operationId;
	const pendingFor = (target: ReviewProposal["target"]) =>
		(history.data ?? []).reduce(
			(total, operation) =>
				total +
				operation.targets
					.filter((entry) => sameTarget(entry.target, target))
					.reduce((count, entry) => count + entry.pendingCount, 0),
			0,
		);
	const prepare = async () => {
		if (!(await savePendingChanges(resume.id))) throw new Error("AI_REVIEW_SAVE_REQUIRED");
		const saved = useResumeStore.getState();
		if (!saved.resume || saved.resume.id !== resume.id || !saved.acknowledgedUpdatedAt)
			throw new Error("AI_REVIEW_SAVE_REQUIRED");
		const savedData = saved.resume.data;
		const passages = collectPassages(savedData, {
			summary: t`Summary`,
			sectionTitle: (id) => getSectionName(savedData, id),
			entryTitle: (type, entry) => describeEntry(type as never, entry as never).title,
			bullet: (n) => String(n),
			paragraph: (n) => String(n),
		});
		const targets = target
			? [target]
			: passages
					.filter((passage) => JSON.stringify(passage.target) === selected)
					.slice(0, 1)
					.map((passage) => passage.target);
		const prepared = await client.ai.review.prepare({
			resumeId: resume.id,
			expectedUpdatedAt: saved.acknowledgedUpdatedAt.toISOString(),
			targets,
		});
		const previousStatus = operationId ? await client.ai.operations.get({ id: operationId }) : null;
		const previous = operationId && previousStatus?.resultId ? await client.ai.review.get({ operationId }) : null;
		const answers =
			previous?.result.sourceRevision.id === resume.id &&
			previous.result.sourceRevision.revision === saved.acknowledgedUpdatedAt.toISOString()
				? previous.answers
						.filter(
							(answer) =>
								answer.target &&
								targets.some(
									(target) =>
										target.sectionId === answer.target?.sectionId &&
										target.itemId === answer.target.itemId &&
										target.roleId === answer.target.roleId &&
										target.field === answer.target.field,
								),
						)
						.slice(-8)
				: [];
		return {
			sources: [...prepared.sources, ...answers.map((answer) => answer.source)],
			parameters: {
				resumeId: resume.id,
				targets,
				action,
				...(request ? { request } : {}),
				...(answers.length ? { answerIds: answers.map((answer) => answer.source.id) } : {}),
			},
		};
	};
	return (
		<div className="grid min-w-0 gap-4">
			{!target && choices.length > 0 && (
				<div className="grid gap-2">
					<label htmlFor={selectId}>
						<Trans>Text to review</Trans>
					</label>
					<NativeSelect id={selectId} value={selected} onChange={(event) => setSelectedTarget(event.target.value)}>
						{choices.map(([key, passage]) => (
							<option key={key} value={key}>
								{passage.location}
								{pendingFor(passage.target) > 0
									? ` · ${copy("review.wording.pendingCount", { count: pendingFor(passage.target) })}`
									: ""}
							</option>
						))}
					</NativeSelect>
					<p className="type-metadata text-ink-2">
						<Trans>Only this field and its related confirmed facts are reviewed.</Trans>
					</p>
				</div>
			)}
			<ReviewLaunch
				retryRequest={retryRequest}
				key={JSON.stringify([resume.id, selected, action, request])}
				kind="review.wording"
				prepare={prepare}
				disabled={resume.isLocked || !selected}
				onStarted={(id) => {
					setChosenReview({ resumeId: resume.id, target: selected, operationId: id });
					void queryClient.invalidateQueries({ queryKey: orpc.ai.review.list.key() });
				}}
			>
				<Trans>Review wording</Trans>
			</ReviewLaunch>
			{history.error && (
				<ReviewNotice
					retry={() => {
						void history.refetch();
					}}
				>
					<Trans>Could not reload this review. Your draft is kept.</Trans>
				</ReviewNotice>
			)}
			{reviews.length > 1 && (
				<div className="grid gap-2">
					<label htmlFor={historySelectId}>{copy("review.wording.savedReviews")}</label>
					<NativeSelect
						id={historySelectId}
						value={operationId ?? ""}
						onChange={(event) =>
							setChosenReview({ resumeId: resume.id, target: selected, operationId: event.target.value })
						}
					>
						{reviews.map((review, index) => (
							<option key={review.operationId} value={review.operationId}>
								{copy("review.wording.savedReview", {
									number: reviews.length - index,
									count: review.targets
										.filter((entry) => selectedAddress && sameTarget(entry.target, selectedAddress))
										.reduce((total, entry) => total + entry.pendingCount, 0),
								})}
							</option>
						))}
					</NativeSelect>
				</div>
			)}
			{operationId && (
				<ReviewOperationPanel
					kind="review.wording"
					onRetry={() => setRetryRequest((n) => n + 1)}
					key={operationId}
					operationId={operationId}
				>
					<ReviewResultPanel operationId={operationId} />
				</ReviewOperationPanel>
			)}
		</div>
	);
}
