import type { ReviewState } from "./review-draft";
import { Trans, useLingui } from "@lingui/react/macro";
import { useQuery } from "@tanstack/react-query";
import { useEffect, useId, useRef, useState } from "react";
import { masterSectionSchema } from "@reactive-resume/schema/career-master";
import { formatResumeDates, type ResumeDates } from "@reactive-resume/schema/resume/dates";
import { Button } from "@reactive-resume/ui/components/button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@reactive-resume/ui/components/collapsible";
import { Icon } from "@reactive-resume/ui/components/icon";
import { NativeSelect } from "@reactive-resume/ui/components/native-select";
import {
	SectionCard,
	SectionCardBody,
	SectionCardHeader,
	SectionCardTitle,
} from "@reactive-resume/ui/components/section-card";
import { Textarea } from "@reactive-resume/ui/components/textarea";
import { ReviewLaunch, ReviewNotice, ReviewOperationPanel } from "../editor/proposals/review-operation";
import { getEntries, resolveSection, describeEntry } from "../editor/write/model";
import { useVariantsCopy } from "../variants/copy.generated";
import { useReviewInterfaceText } from "../variants/review-interface-copy";
import {
	applyImportReviewCandidate,
	applyImportReviewCandidates,
	undoImportReviewCandidate,
	getImportCandidateTarget,
	getImportPassageSelection,
	getImportSectionText,
	importDraftGeneration,
} from "./ai-assistance";
import { ImportAssistanceGuide } from "./assistance-guide";
import { fieldLabel } from "./field-label";
import { FeatureBetaBadge } from "@/components/feature-beta-badge";
import { QuerySkeleton } from "@/components/query-skeleton";
import { client, orpc } from "@/libs/orpc/client";
import { getSectionTitle } from "@/libs/resume/section";

export function ImportAssistance({
	state,
	flowId,
	pages,
	partial,
	onChange,
	onSourcePage,
}: {
	state: ReviewState;
	flowId: string;
	pages: { page: number; text: string }[];
	partial: boolean;
	onChange: (state: ReviewState) => void;
	onSourcePage?: (page: number) => void;
}) {
	const { t } = useLingui();
	const [retryRequest, setRetryRequest] = useState(0);
	const [open, setOpen] = useState(false);
	const currentState = useRef(state);
	useEffect(() => {
		currentState.current = state;
	}, [state]);
	const [section, setSection] = useState<"experience" | "education" | "skills" | "languages" | "certifications">(
		"experience",
	);
	const [selectedRange, setSelectedRange] = useState<{
		section: string;
		sourceText: string;
		start: number;
		end: number;
	} | null>(null);
	const pending = useRef<ReviewState["aiReview"]>(undefined);
	const source = getImportSectionText(pages, section, state.data.metadata.page.locale);
	const sourceText = source.text;
	const passage =
		selectedRange?.section === section && selectedRange.sourceText === sourceText
			? getImportPassageSelection(source, selectedRange.start, selectedRange.end)
			: { text: "", pages: [] };
	const selection = passage.text;
	const selectionCount = selection.replace(/\r\n/g, "\n").length;
	const firstPage = passage.pages[0];
	const lastPage = passage.pages.at(-1);
	const id = useId();
	return (
		<SectionCard variant="flush" className="text-content-start">
			<Collapsible open={open} onOpenChange={setOpen}>
				<SectionCardHeader className="flex-wrap">
					<Icon name="sparkle" />
					<div className="grid min-w-0 flex-1 gap-1">
						<div className="flex flex-wrap items-center gap-2">
							<SectionCardTitle>
								<Trans context="review.import.help.title">Get AI help with text the import was unsure about</Trans>
							</SectionCardTitle>
							<FeatureBetaBadge />
						</div>
						<p className="type-body text-ink-2">
							<Trans context="review.import.help.description">
								Choose a section and highlight the uncertain text before requesting a review.
							</Trans>
						</p>
					</div>
					<CollapsibleTrigger className="w-full sm:w-auto" render={<Button variant="secondary" />}>
						{open
							? t({ context: "review.import.help.collapse", message: "Close text assistance" })
							: t({ context: "review.import.help.expand", message: "Open text assistance" })}
						<Icon name="caret-down" className={open ? "rotate-180" : undefined} />
					</CollapsibleTrigger>
				</SectionCardHeader>
				<CollapsibleContent>
					<SectionCardBody>
						<p className="type-body">
							<Trans>
								Select text from the native extraction below. Only that selection is reviewed; the original file stays
								on this device. Contact details are removed. Review every proposed field yourself.
							</Trans>
						</p>
						<div>
							<ImportAssistanceGuide sectionId={`${id}-section`} textId={`${id}-text`} reviewId={`${id}-review`} />
						</div>
						<label htmlFor={`${id}-section`}>
							<Trans>Section to review</Trans>
						</label>
						<NativeSelect
							id={`${id}-section`}
							value={section}
							onChange={(event) => {
								setSection(masterSectionSchema.parse(event.target.value));
								setSelectedRange(null);
							}}
						>
							{masterSectionSchema.options.map((section) => (
								<option key={section} value={section}>
									{getSectionTitle(section)}
								</option>
							))}
						</NativeSelect>
						{sourceText.trim() && !source.matched && (
							<p className="type-body text-ink-2">
								<Trans>
									No heading was found for this section. Highlight the relevant text in the full extraction.
								</Trans>
							</p>
						)}
						<label htmlFor={`${id}-text`}>
							<Trans>Native extracted text — select the uncertain passage</Trans>
						</label>
						<Textarea
							id={`${id}-text`}
							dir="auto"
							value={sourceText}
							readOnly
							aria-describedby={`${id}-selection-help ${id}-selection-count`}
							onSelect={(event) => {
								const field = event.currentTarget;
								setSelectedRange({ section, sourceText, start: field.selectionStart, end: field.selectionEnd });
								const selected = getImportPassageSelection(source, field.selectionStart, field.selectionEnd);
								if (selected.pages[0] !== undefined) onSourcePage?.(selected.pages[0]);
							}}
						/>
						{!sourceText.trim() && (
							<ReviewNotice>
								<Trans>No native text is available. Enter the information manually.</Trans>
							</ReviewNotice>
						)}
						<p id={`${id}-selection-help`} className="type-body text-ink-2">
							<Trans>Highlight the text you want help with</Trans>
						</p>
						<p id={`${id}-selection-count`} className="type-meta text-ink-3" role="status">
							<Trans>{selectionCount} characters selected</Trans>
							{firstPage !== undefined && (
								<>
									{" "}
									·{" "}
									{firstPage === lastPage ? (
										<Trans>PDF page {firstPage}</Trans>
									) : (
										<Trans>
											PDF pages {firstPage}–{lastPage}
										</Trans>
									)}
								</>
							)}
						</p>
						<ReviewLaunch
							retryRequest={retryRequest}
							id={`${id}-review`}
							key={JSON.stringify([flowId, section, selection])}
							kind="review.extraction"
							disabled={!selection.trim()}
							prepare={async () => {
								const draftGeneration = importDraftGeneration(state.data);
								const staged = await client.ai.review.importSource({
									flowId,
									section,
									text: selection,
									partial,
									contactValues: [
										state.data.basics.name,
										state.data.basics.email,
										state.data.basics.phone,
										state.data.basics.location,
										state.data.basics.website.url,
									],
								});
								pending.current = {
									version: 1,
									source: staged.source,
									operationId: "pending",
									result: null,
									draftGeneration,
									appliedCandidateIds: [],
								};
								return { sources: [staged.source], parameters: { sourceId: staged.source.id } };
							}}
							onStarted={(operationId) => {
								if (!pending.current) return;
								const previous = currentState.current.aiReview;
								const earlierFieldKeys = [
									...new Set([
										...(previous?.earlierFieldKeys ?? []),
										...(previous?.appliedChanges ?? []).map(
											({ section, entryId, field }) => `${section}:${entryId}:${field}`,
										),
									]),
								];
								onChange({ ...currentState.current, aiReview: { ...pending.current, operationId, earlierFieldKeys } });
							}}
						>
							<Trans>Review selected text</Trans>
						</ReviewLaunch>
						{state.aiReview && (
							<ReviewOperationPanel
								kind="review.extraction"
								onRetry={() => setRetryRequest((n) => n + 1)}
								operationId={state.aiReview.operationId}
							>
								<ExtractionCandidates state={state} onChange={onChange} onRetry={() => setRetryRequest((n) => n + 1)} />
							</ReviewOperationPanel>
						)}
					</SectionCardBody>
				</CollapsibleContent>
			</Collapsible>
		</SectionCard>
	);
}
export function ExtractionCandidates({
	state,
	onChange,
	onRetry,
}: {
	state: ReviewState;
	onChange: (state: ReviewState) => void;
	onRetry?: () => void;
}) {
	const review = state.aiReview;
	const query = useQuery(orpc.ai.review.get.queryOptions({ input: { operationId: review?.operationId ?? "" } }));
	const [targets, setTargets] = useState<Record<string, string>>({});
	const [error, setError] = useState(false);
	const id = useId();
	const variantsCopy = useVariantsCopy();
	const interfaceText = useReviewInterfaceText();
	useEffect(() => {
		if (review && query.data?.result.kind === "extraction" && !review.result)
			onChange({ ...state, aiReview: { ...review, result: query.data.result } });
	}, [query.data, review, state, onChange]);
	if (!review) return null;
	if (query.error)
		return (
			<ReviewNotice
				retry={() => {
					void query.refetch();
				}}
			>
				<Trans>Could not reload this review. Your draft is kept.</Trans>
			</ReviewNotice>
		);
	if (!query.data) return <QuerySkeleton shape="rows" label={<Trans>Loading review…</Trans>} />;
	const result = query.data.result;
	if (result.kind !== "extraction") return null;
	const stale =
		review.draftGeneration !== importDraftGeneration(state.data) ||
		review.source.id !== result.sourceRevision.id ||
		review.source.revision !== result.sourceRevision.revision;
	const assignments = Object.fromEntries(
		result.candidates.map((candidate) => {
			const section = resolveSection(state.data, candidate.section);
			const entries = section ? getEntries(state.data, section) : [];
			const chosen = targets[candidate.id];
			return [
				candidate.id,
				chosen && (chosen === "new" || entries.some((entry) => entry.id === chosen))
					? chosen
					: getImportCandidateTarget(state, candidate),
			];
		}),
	);
	const groups = new Map<string, typeof result.candidates>();
	for (const candidate of result.candidates) {
		const target = assignments[candidate.id];
		const key = `${candidate.section}:${target}:${target === "new" ? candidate.entityId : ""}`;
		groups.set(key, [...(groups.get(key) ?? []), candidate]);
	}
	const applyOne = (candidateId: string) => {
		try {
			const target = assignments[candidateId];
			if (!target) return;
			const next = applyImportReviewCandidate(state, candidateId, target);
			const change = next.aiReview?.appliedChanges?.at(-1);
			if (target === "new" && change) {
				const candidate = result.candidates.find((c) => c.id === candidateId);
				setTargets((current) => ({
					...current,
					...Object.fromEntries(
						result.candidates
							.filter((c) => c.section === candidate?.section && c.entityId === candidate.entityId)
							.map((c) => [c.id, change.entryId]),
					),
				}));
			}
			onChange(next);
			setError(false);
		} catch {
			setError(true);
		}
	};

	return (
		<div className="grid gap-3">
			<div>
				<FeatureBetaBadge />
			</div>
			{(stale || error) && (
				<ReviewNotice>
					<Trans>This draft or source changed. Keep your manual corrections and request a new review.</Trans>
				</ReviewNotice>
			)}
			{result.withheld && result.withheld.count > 0 && (
				<ReviewNotice retry={onRetry}>
					{variantsCopy("review.withheldItems", { count: result.withheld.count })}
					{result.withheld.items && result.withheld.items.length > 0 && (
						<ul className="mt-1 grid gap-1 type-metadata text-ink-2">
							{result.withheld.items.map((item) => (
								<li key={item.id} dir="auto">
									{item.field
										? `${fieldLabel(item.field)} — ${variantsCopy("review.withheldReason.extraction")}`
										: variantsCopy("review.withheldReason.extraction")}
								</li>
							))}
						</ul>
					)}
				</ReviewNotice>
			)}
			{result.candidates.length === 0 && (
				<p role="status">
					<Trans>No fields were extracted from this selection. Continue manually.</Trans>
				</p>
			)}
			<Button
				disabled={
					stale ||
					!review.result ||
					!result.candidates.some((c) => c.value !== null && !review.appliedCandidateIds.includes(c.id))
				}
				onClick={() => {
					try {
						onChange(applyImportReviewCandidates(state, assignments));
						setError(false);
					} catch {
						setError(true);
					}
				}}
			>
				<Trans context="import.help.useAll">Use all in draft</Trans>
			</Button>
			<p className="type-metadata text-ink-2">
				<Trans context="import.help.localOnly">
					These choices update this draft only. Review and confirm the import to save them.
				</Trans>
			</p>
			{[...groups].map(([key, candidates]) => {
				const first = candidates[0];
				if (!first) return null;
				const section = resolveSection(state.data, first.section);
				const entries = section ? getEntries(state.data, section) : [];
				return (
					<SectionCard key={key}>
						<h3 className="type-label">{getSectionTitle(first.section)}</h3>
						<label htmlFor={`${id}-${key}`}>
							<Trans context="import.help.targetEntry">Add to which entry?</Trans>
						</label>
						<NativeSelect
							id={`${id}-${key}`}
							value={assignments[first.id]}
							disabled={stale || candidates.every((c) => review.appliedCandidateIds.includes(c.id))}
							onChange={(event) =>
								setTargets((current) => ({
									...current,
									...Object.fromEntries(candidates.map((c) => [c.id, event.target.value])),
								}))
							}
						>
							{entries.map((entry) => (
								<option key={entry.id} value={entry.id}>
									{describeEntry(first.section, entry).title}
								</option>
							))}
							<option value="new">
								<Trans>New entry</Trans>
							</option>
						</NativeSelect>
						{candidates.map((candidate) => {
							const applied = review.appliedCandidateIds.includes(candidate.id);
							return (
								<div key={candidate.id} className="grid gap-2 rounded-md bg-warn-soft p-3 text-warn-text">
									<p className="type-metadata">{fieldLabel(candidate.field)}</p>
									<p className="type-metadata">{variantsCopy("review.import.aiUncertain")}</p>
									<p dir="auto" className="wrap-anywhere">
										{candidate.value === null ? (
											<Trans>Unknown — enter this yourself</Trans>
										) : typeof candidate.value === "string" ? (
											candidate.value
										) : (
											formatResumeDates(candidate.value as ResumeDates, {
												locale: state.data.metadata.page.locale,
												format: "iso",
											})
										)}
									</p>
									{candidate.rawDateText && <p dir="auto">{candidate.rawDateText}</p>}
									<details>
										<summary className="type-metadata underline">
											<Trans context="import.help.source">Source</Trans>
										</summary>
										{result.evidence
											.filter((entry) => candidate.evidenceIds.includes(entry.id))
											.map((entry) => (
												<blockquote key={entry.id} dir="auto" className="wrap-anywhere">
													{entry.quote}
												</blockquote>
											))}
									</details>
									{applied ? (
										<>
											<p role="status">
												{review.appliedChanges?.some(
													(change) => change.candidateId === candidate.id && change.retained,
												) ? (
													variantsCopy("review.importRetainedField")
												) : (
													<Trans>Added to local draft — review before confirming</Trans>
												)}
											</p>
											<Button
												variant="secondary"
												disabled={
													stale || !review.appliedChanges?.some((change) => change.candidateId === candidate.id)
												}
												onClick={() => {
													try {
														onChange(undoImportReviewCandidate(state, candidate.id));
														setError(false);
													} catch {
														setError(true);
													}
												}}
											>
												<Trans context="import.help.undo">Undo this item</Trans>
											</Button>
										</>
									) : (
										<Button
											variant="secondary"
											disabled={stale || candidate.value === null || !review.result}
											onClick={() => applyOne(candidate.id)}
										>
											<Trans>Use in draft</Trans>
										</Button>
									)}
								</div>
							);
						})}
					</SectionCard>
				);
			})}

			{result.questions.map((question) => (
				<p key={question.id} dir="auto">
					{interfaceText(question.prompt, "import")}
				</p>
			))}
		</div>
	);
}
