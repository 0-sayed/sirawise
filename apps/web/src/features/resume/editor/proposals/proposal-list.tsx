import type { ReviewEditFeedback } from "../../preview/edit-highlight";
import type { Proposal, ProposalState } from "@reactive-resume/resume/proposals";
import type { ResumeData } from "@reactive-resume/schema/resume/data";
import type { KeyboardEvent, ReactNode } from "react";
import { t } from "@lingui/core/macro";
import { useLingui } from "@lingui/react";
import { Plural, Trans } from "@lingui/react/macro";
import { useId, useState } from "react";
import { blockText, getProposalState } from "@reactive-resume/resume/proposals";
import { ActionGroup } from "@reactive-resume/ui/components/action-group";
import { Badge } from "@reactive-resume/ui/components/badge";
import { Button } from "@reactive-resume/ui/components/button";
import { SegmentedControl, SegmentedControlItem } from "@reactive-resume/ui/components/segmented-control";
import { SuccessStatus } from "@reactive-resume/ui/components/success-celebration";
import { escapeHtml } from "@reactive-resume/utils/string";
import { useEditorStore } from "../store";
import { acceptResumeProposals } from "./proposals";
import { WordingDiff } from "./wording-diff";
import { useAssistantCopy } from "@/features/assistant/copy.generated";
import { useIsResumeLocked } from "@/features/resume/builder/draft";

type ProposalListProps = {
	proposals: readonly Proposal[];
	data: ResumeData;
	/** "Suggest again" on an out-of-date proposal. */
	onSuggestAgain: () => void;
};

/** Check → Writing's change set, applied to the resume. */
export function ProposalList({ proposals, data, onSuggestAgain }: ProposalListProps) {
	const setProposalStatus = useEditorStore((state) => state.setProposalStatus);
	const locked = useIsResumeLocked();

	return (
		<ChangeSet
			proposals={proposals}
			states={proposals.map((proposal) => getProposalState(data, proposal))}
			locked={locked}
			onAccept={(accepted) => {
				acceptResumeProposals(accepted);
				setProposalStatus(
					accepted.map((proposal) => proposal.id),
					"accepted",
				);
			}}
			onReject={(rejected) =>
				setProposalStatus(
					rejected.map((proposal) => proposal.id),
					"rejected",
				)
			}
			onSuggestAgain={onSuggestAgain}
		/>
	);
}

type ChangeSetProps = {
	feedback?: ReviewEditFeedback | undefined;
	proposals: readonly Proposal[];
	/** Each proposal's state as the document reads now (out of date once its passage changed). */
	states: readonly ProposalState[];
	locked: boolean;
	onAccept: (proposals: readonly Proposal[]) => void;
	onReject: (proposals: readonly Proposal[]) => void;
	/** "Suggest again" on an out-of-date proposal. */
	onSuggestAgain?: (() => void) | undefined;
	/** The set's title; "n proposed edits" by default. */
	title?: ReactNode;
	renderDetails?: ((proposal: Proposal, state: ProposalState) => ReactNode) | undefined;
	onEdit?: ((proposal: Proposal) => void) | undefined;
	acceptedLabel?: ReactNode;
	acceptVariant?: "primary" | "secondary";
	allowAcceptAll?: boolean;
};

/**
 * A change set with a shared display mode. A accepts and R rejects the focused edit; ↑ and ↓ move between edits.
 */
export function ChangeSet({
	feedback,
	proposals,
	states,
	locked,
	onAccept,
	onReject,
	onSuggestAgain,
	title,
	renderDetails,
	onEdit,
	acceptedLabel,
	acceptVariant,
	allowAcceptAll = true,
}: ChangeSetProps) {
	const [focused, setFocused] = useState(0);
	const [mode, setMode] = useState<"changes" | "final">("changes");
	const copy = useAssistantCopy();
	const { i18n } = useLingui();
	const pending = proposals.filter((_, index) => states[index] === "pending");
	const headingId = useId();
	const shortcutsId = useId();

	const onKeyDown = (event: KeyboardEvent<HTMLOListElement>) => {
		if (event.metaKey || event.ctrlKey || event.altKey) return;
		if ((event.target as HTMLElement).closest("button,input,textarea,select,a,summary")) return;
		const item = (event.target as HTMLElement).closest<HTMLElement>("[data-proposal-index]");
		const index = Number(item?.dataset.proposalIndex ?? focused);
		const proposal = proposals[index];

		const move = (next: number) => {
			event.preventDefault();
			const target = Math.min(proposals.length - 1, Math.max(0, next));
			setFocused(target);
			event.currentTarget.querySelector<HTMLElement>(`[data-proposal-index="${target}"]`)?.focus();
		};

		if (event.key === "ArrowDown") return move(index + 1);
		if (event.key === "ArrowUp") return move(index - 1);
		if (!proposal || states[index] !== "pending" || locked) return;
		if (event.key === "a" || event.key === "A") {
			event.preventDefault();
			onAccept([proposal]);
		}
		if (event.key === "r" || event.key === "R") {
			event.preventDefault();
			onReject([proposal]);
		}
	};

	return (
		<section aria-labelledby={headingId} className="overflow-hidden rounded-xl border border-line">
			<header className="flex min-h-11 flex-wrap items-center justify-between gap-2 border-b border-line bg-bg px-3 py-2">
				<h3 id={headingId} className="type-label">
					{title ?? <Plural value={proposals.length} one="# proposed edit" other="# proposed edits" />}
				</h3>
				{pending.length > 0 && (
					<SegmentedControl
						aria-label={copy("review.diff.view")}
						dir={i18n.locale === "ar-SA" ? "rtl" : "ltr"}
						value={mode}
						onValueChange={(value) => setMode(value === "final" ? "final" : "changes")}
					>
						<SegmentedControlItem value="changes">{copy("review.diff.showChanges")}</SegmentedControlItem>
						<SegmentedControlItem value="final">{copy("review.diff.showFinal")}</SegmentedControlItem>
					</SegmentedControl>
				)}
				{allowAcceptAll && pending.length > 1 && (
					<Button size="sm" variant={acceptVariant} disabled={locked} onClick={() => onAccept(pending)}>
						<Trans>Accept all</Trans>
					</Button>
				)}
			</header>

			<span id={shortcutsId} hidden>
				{copy("review.diff.shortcuts")}
			</span>
			<ol aria-label={t`Proposed edits`} onKeyDown={onKeyDown} className="divide-y divide-line">
				{proposals.map((proposal, index) => (
					<ProposalItem
						key={proposal.id}
						feedback={feedback?.proposalIds.includes(proposal.id) ? feedback : undefined}
						proposal={proposal}
						mode={mode}
						locale={i18n.locale}
						number={index + 1}
						state={states[index] ?? "pending"}
						index={index}
						focusable={index === Math.min(focused, proposals.length - 1)}
						locked={locked}
						onFocus={() => setFocused(index)}
						onAccept={() => onAccept([proposal])}
						onReject={() => onReject([proposal])}
						onSuggestAgain={onSuggestAgain}
						onEdit={onEdit ? () => onEdit(proposal) : undefined}
						keepLabel={copy("review.suggestion.keepOriginal")}
						shortcutsId={shortcutsId}
						acceptedLabel={acceptedLabel}
						acceptVariant={acceptVariant}
						details={renderDetails?.(proposal, states[index] ?? "pending")}
					/>
				))}
			</ol>
		</section>
	);
}

type ProposalItemProps = {
	feedback?: ReviewEditFeedback | undefined;
	proposal: Proposal;
	mode: "changes" | "final";
	locale: string;
	number: number;
	state: ProposalState;
	index: number;
	focusable: boolean;
	locked: boolean;
	onFocus: () => void;
	onAccept: () => void;
	onReject: () => void;
	onSuggestAgain?: (() => void) | undefined;
	onEdit?: (() => void) | undefined;
	keepLabel: string;
	shortcutsId: string;
	acceptedLabel?: ReactNode;
	acceptVariant?: "primary" | "secondary" | undefined;
	details?: ReactNode;
};

function ProposalItem(props: ProposalItemProps) {
	const { proposal, number, state, index, focusable, locked } = props;
	const labelId = useId();

	return (
		<li
			data-proposal-index={index}
			// oxlint-disable-next-line jsx-a11y/no-noninteractive-tabindex -- Roving focus: one edit in the tab order, ↑ and ↓ move between them.
			tabIndex={focusable ? 0 : -1}
			aria-labelledby={labelId}
			aria-describedby={props.shortcutsId}
			onFocus={props.onFocus}
			className="grid min-w-0 gap-2 p-3 outline-none focus-visible:bg-hover"
		>
			<header className="flex flex-wrap items-center gap-2">
				<span
					aria-hidden="true"
					className="grid size-5 shrink-0 place-items-center rounded-full bg-accent text-[11px] font-bold text-on-accent"
				>
					{number}
				</span>
				<span id={labelId} className="min-w-0 text-[11px] break-words text-ink-3">
					<span className="sr-only">
						<Trans>Edit {number}:</Trans>{" "}
					</span>
					{proposal.location}
				</span>
				<SuccessStatus
					complete={state === "accepted"}
					className={state === "pending" || state === "stale" ? "sr-only" : "ms-auto"}
				>
					{state === "accepted" && (
						<Badge variant="accent">
							{props.acceptedLabel ?? <Trans context="A proposed change has been applied">Applied</Trans>}
						</Badge>
					)}
					{state === "rejected" && (
						<Badge>
							<Trans>Rejected</Trans>
						</Badge>
					)}
				</SuccessStatus>
			</header>

			<div
				key={props.feedback?.id ?? "original"}
				data-review-action={props.feedback?.action}
				className="review-wording grid min-w-0 gap-2 type-body"
			>
				{state === "rejected" || state === "stale" ? (
					<p dir="auto" className="wrap-anywhere text-ink-2">
						{blockText(proposal.before)}
					</p>
				) : (
					<WordingDiff
						before={proposal.before}
						after={props.feedback?.editedText === undefined ? proposal.after : escapeHtml(props.feedback.editedText)}
						mode={state === "accepted" ? "final" : props.mode}
						locale={props.locale}
					/>
				)}
			</div>

			{state === "pending" && (
				<ActionGroup responsive="stack">
					<Button size="sm" variant={props.acceptVariant} disabled={locked} onClick={props.onAccept}>
						<Trans>Accept</Trans>
					</Button>
					{props.onEdit && (
						<Button size="sm" variant="secondary" disabled={locked} onClick={props.onEdit}>
							<Trans>Edit</Trans>
						</Button>
					)}
					<Button size="sm" variant="secondary" disabled={locked} onClick={props.onReject}>
						{props.keepLabel}
					</Button>
				</ActionGroup>
			)}
			{state === "stale" && (
				<div role="status" className="inline-flex items-center gap-2 type-metadata text-warn-text">
					<Trans>Out of date: the text has changed since.</Trans>
					{props.onSuggestAgain && (
						<Button
							variant="link"
							size="link-touch"
							type="button"
							className="justify-self-start"
							onClick={props.onSuggestAgain}
						>
							<Trans>Suggest again</Trans>
						</Button>
					)}
				</div>
			)}
			{props.details}
		</li>
	);
}
