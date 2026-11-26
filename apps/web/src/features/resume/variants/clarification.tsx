import type { SourceRevision } from "@reactive-resume/schema/ai-operation";
import type { ReviewEvidence } from "@reactive-resume/schema/resume/ai-review";
import type { ReactNode } from "react";
import { Trans } from "@lingui/react/macro";
import { ORPCError } from "@orpc/client";
import { useMutation } from "@tanstack/react-query";
import { useId, useRef, useState } from "react";
import { Button } from "@reactive-resume/ui/components/button";
import { Disclosure, DisclosureContent, DisclosureSummary } from "@reactive-resume/ui/components/disclosure";
import { Label } from "@reactive-resume/ui/components/label";
import {
	TaskOverlay,
	TaskOverlayContent,
	TaskOverlayTitle,
	TaskOverlayDescription,
	TaskOverlayFooter,
} from "@reactive-resume/ui/components/task-overlay";
import { Textarea } from "@reactive-resume/ui/components/textarea";
import { savePendingChanges, useResumeStore } from "../builder/draft";
import { ReviewLaunch, ReviewNotice } from "../editor/proposals/review-operation";
import { useVariantsCopy } from "./copy.generated";
import { useReviewInterfaceText } from "./review-interface-copy";
import { extractVariantDecisionError } from "./translation-review-model";
import { client } from "@/libs/orpc/client";

type ClarificationItem = {
	id: string;
	prompt?: string | undefined;
	context?: string | undefined;
	evidence?: ReactNode[];
	finding?: { verdict: string; explanation: string };
};

const sentences = new Intl.Segmenter(undefined, { granularity: "sentence" });

function SourcePassage({ text }: { text: string }) {
	const normalized = text.trim().replace(/\s+/gu, " ");
	const characters = Array.from(normalized);
	if (characters.length <= 140) {
		return (
			<blockquote dir="auto" className="type-body wrap-anywhere whitespace-pre-wrap text-ink-2">
				{text}
			</blockquote>
		);
	}
	const [first, second] = sentences.segment(normalized);
	const opening = first?.segment.trim() ?? normalized;
	// Pasted headings can run into the number of the first list item.
	const endsWithListNumber = opening.length <= 64 && /(?:^|\p{L})\p{Nd}{1,2}[.)]$/u.test(opening);
	const sentence = endsWithListNumber ? (second?.segment.trim() ?? opening) : opening;
	const prefix = Array.from(sentence).slice(0, 140).join("");
	const excerpt = prefix === sentence ? sentence : `${prefix.replace(/\s+\S*$/u, "")}…`;
	return (
		<Disclosure>
			<DisclosureSummary>
				<span dir="auto" className="wrap-anywhere">
					{excerpt}
				</span>
			</DisclosureSummary>
			<DisclosureContent>
				<blockquote dir="auto" className="wrap-anywhere whitespace-pre-wrap">
					{text}
				</blockquote>
			</DisclosureContent>
		</Disclosure>
	);
}

/** Reuses the existing T006 answer ledger: supplied information is never confirmed candidate evidence. */
export function Clarification({
	operationId,
	source,
	questions,
	resolved,
	saved = [],
	kind,
	onContinued,
	continued = false,
	remainingAnswerSlots,
	dismissed = [],
	groupByContext = false,
	stale,
	onSaved,
}: {
	operationId: string;
	source: SourceRevision;
	questions: ClarificationItem[];
	resolved: string[];
	saved?: { questionId: string; evidence: ReviewEvidence }[] | undefined;
	kind?: "review.wording" | "review.summary" | "review.job-evidence" | undefined;
	onContinued?: ((id: string) => void) | undefined;
	continued?: boolean | undefined;
	remainingAnswerSlots?: number | undefined;
	dismissed?: string[];
	groupByContext?: boolean;
	stale: boolean;
	onSaved: () => void;
}) {
	const answerId = useId();
	const copy = useVariantsCopy();
	const interfaceText = useReviewInterfaceText();
	const questionType =
		kind === "review.summary" ? "summary" : kind === "review.job-evidence" ? "requirement" : "wording";
	const [selected, setSelected] = useState<string | null>(null);
	const [receipts, setReceipts] = useState<Record<string, ReviewEvidence>>({});
	const [drafts, setDrafts] = useState<Record<string, string>>({});
	const request = useRef<{ fingerprint: string; requestKey: string } | null>(null);
	const answer = useMutation({
		mutationFn: async (input: { questionId: string; text?: string }) => {
			const fingerprint = JSON.stringify(input);
			if (request.current?.fingerprint !== fingerprint)
				request.current = { fingerprint, requestKey: crypto.randomUUID() };
			if (input.text === undefined) {
				await client.ai.review.dismissQuestion({
					operationId,
					questionId: input.questionId,
					requestKey: request.current.requestKey,
				});
				return;
			}
			await flushClarificationDraft(source);
			return client.ai.review.answer({
				operationId,
				questionId: input.questionId,
				text: input.text,
				expectedSource: source,
				requestKey: request.current.requestKey,
			});
		},
		onSuccess: (evidence, input) => {
			if (evidence) setReceipts((current) => ({ ...current, [input.questionId]: evidence }));
			setDrafts(({ [input.questionId]: _completed, ...current }) => current);
			setSelected(null);
			request.current = null;
			onSaved();
		},
	});
	const retry = () => {
		if (answer.variables && !answer.isPending) answer.mutate(answer.variables);
	};

	const question = questions.find((item) => item.id === selected && item.prompt);
	const renderQuestion = (item: ClarificationItem) => {
		const evidence = saved.find(({ questionId }) => questionId === item.id)?.evidence ?? receipts[item.id];
		return (
			<>
				{item.finding && (
					<div className="type-body wrap-anywhere whitespace-pre-wrap text-ink">
						<p>{item.finding.verdict}</p>
						<p dir="auto">{item.finding.explanation}</p>
					</div>
				)}
				{Boolean(item.evidence?.length) && (
					<Disclosure>
						<DisclosureSummary>
							<Trans>Evidence</Trans>
						</DisclosureSummary>
						<DisclosureContent>{item.evidence}</DisclosureContent>
					</Disclosure>
				)}
				{item.prompt && (
					<>
						<p dir="auto" className="wrap-anywhere" data-review-question>
							{interfaceText(item.prompt, questionType)}
						</p>
						{dismissed.includes(item.id) ? (
							<p>
								<Trans>Skipped. You can request another review when you have more information.</Trans>
							</p>
						) : evidence || resolved.includes(item.id) ? (
							<div className="grid gap-2">
								{evidence && (
									<blockquote dir="auto" className="type-body wrap-anywhere whitespace-pre-wrap">
										{evidence.quote}
									</blockquote>
								)}
								<p role="status" className="type-metadata text-ink-2">
									<Trans>Your answer was saved. Your CV is unchanged.</Trans>
								</p>
								{evidence && kind && onContinued && !continued && (
									<ReviewLaunch
										continuation
										kind={kind}
										variant="secondary"
										disabled={stale}
										prepare={async () => {
											await flushClarificationDraft(source);
											return client.ai.review.continue({ operationId, answerId: evidence.id });
										}}
										onStarted={onContinued}
									>
										<Trans>Review with this answer</Trans>
									</ReviewLaunch>
								)}
							</div>
						) : (
							<div className="flex flex-wrap gap-2">
								<Button
									variant={groupByContext ? "secondary" : "primary"}
									disabled={stale || answer.isPending}
									onClick={() => {
										answer.reset();
										setSelected(item.id);
									}}
								>
									{groupByContext ? copy("jobs.evidence.addFact") : <Trans>Add information</Trans>}
								</Button>
								<Button
									variant="secondary"
									disabled={answer.isPending}
									onClick={() => answer.mutate({ questionId: item.id })}
								>
									<Trans context="Skip a review question">Skip</Trans>
								</Button>
							</div>
						)}
					</>
				)}
			</>
		);
	};
	if (questions.length === 0) return null;
	const passageGroups = new Map<string | undefined, ClarificationItem[]>();
	if (groupByContext) {
		for (const item of questions) {
			const group = passageGroups.get(item.context);
			if (group) group.push(item);
			else passageGroups.set(item.context, [item]);
		}
	}
	return (
		<div className="grid gap-3">
			{groupByContext
				? Array.from(passageGroups, ([context, items]) => (
						<div key={context ?? ""} className="grid min-w-0 gap-2">
							{context && <SourcePassage text={context} />}
							<ul className="grid gap-3">
								{items.map((item) => (
									<li key={item.id} className="grid gap-2">
										{renderQuestion(item)}
									</li>
								))}
							</ul>
						</div>
					))
				: questions.map((item) => (
						<div key={item.id} className="grid gap-2">
							{item.context && <blockquote dir="auto">{item.context}</blockquote>}
							{renderQuestion(item)}
						</div>
					))}
			{answer.error && !question && (
				<ReviewNotice retry={retry}>
					{answer.variables?.text === undefined ? (
						<Trans>Could not skip this question. Try again.</Trans>
					) : (
						<Trans>Could not save your answer. Your text is kept.</Trans>
					)}
				</ReviewNotice>
			)}
			<TaskOverlay
				open={Boolean(question)}
				onOpenChange={(open) => {
					if (!open && !answer.isPending) setSelected(null);
				}}
			>
				<TaskOverlayContent>
					<TaskOverlayTitle>
						{groupByContext ? copy("jobs.evidence.addFact") : <Trans>Add information</Trans>}
					</TaskOverlayTitle>
					<TaskOverlayDescription dir="auto">
						{question?.prompt && interfaceText(question.prompt, questionType)}
					</TaskOverlayDescription>
					{question?.finding && <p dir="auto">{question.finding.explanation}</p>}
					{question?.context &&
						(groupByContext ? (
							<SourcePassage text={question.context} />
						) : (
							<blockquote dir="auto">{question.context}</blockquote>
						))}
					<div className="grid gap-2">
						<Label htmlFor={answerId}>
							<Trans>Your answer</Trans>
						</Label>
						<Textarea
							id={answerId}
							dir="auto"
							maxLength={4000}
							value={drafts[selected ?? ""] ?? ""}
							onChange={(event) => setDrafts((previous) => ({ ...previous, [selected ?? ""]: event.target.value }))}
						/>
					</div>
					{answer.error && (
						<ReviewNotice retry={retry}>
							{answer.error instanceof ORPCError &&
							answer.error.code === "CONFLICT" &&
							extractVariantDecisionError(answer.error).reason === "AI_SOURCE_CHANGED" ? (
								<Trans>The source changed. Your answer is kept here. Open a current review to use it.</Trans>
							) : (
								<Trans>Could not save your answer. Your text is kept.</Trans>
							)}
						</ReviewNotice>
					)}
					<TaskOverlayFooter>
						<Button variant="secondary" disabled={answer.isPending} onClick={() => setSelected(null)}>
							<Trans>Cancel</Trans>
						</Button>
						{!continued && remainingAnswerSlots !== 0 && (
							<Button
								disabled={stale || answer.isPending || !(drafts[selected ?? ""] ?? "").trim()}
								onClick={() => {
									if (selected) answer.mutate({ questionId: selected, text: drafts[selected] ?? "" });
								}}
							>
								<Trans>Save answer</Trans>
							</Button>
						)}
					</TaskOverlayFooter>
				</TaskOverlayContent>
			</TaskOverlay>
		</div>
	);
}

async function flushClarificationDraft(source: SourceRevision) {
	if (
		source.kind === "resume" &&
		useResumeStore.getState().resume?.id === source.id &&
		!(await savePendingChanges(source.id))
	)
		throw new Error("AI_REVIEW_SAVE_REQUIRED");
}
