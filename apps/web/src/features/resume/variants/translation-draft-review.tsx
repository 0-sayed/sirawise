import type { TranslationGap } from "./translation-gaps";
import type { SegmentItem, TermGroup } from "./translation-review-model";
import type { ResumeData } from "@reactive-resume/schema/resume/data";
import type { VariantDecisionInput, VariantReviewView } from "@reactive-resume/schema/resume/variants";
import { Trans } from "@lingui/react/macro";
import { useId, useState } from "react";
import { ActionGroup } from "@reactive-resume/ui/components/action-group";
import { Alert, AlertDescription, AlertTitle } from "@reactive-resume/ui/components/alert";
import { Badge, CountBadge } from "@reactive-resume/ui/components/badge";
import { Button } from "@reactive-resume/ui/components/button";
import { Disclosure, DisclosureContent, DisclosureSummary } from "@reactive-resume/ui/components/disclosure";
import { Icon } from "@reactive-resume/ui/components/icon";
import {
	SectionCard,
	SectionCardHeader,
	SectionCardRow,
	SectionCardTitle,
} from "@reactive-resume/ui/components/section-card";
import { StickyActions } from "@reactive-resume/ui/components/sticky-actions";
import { Textarea } from "@reactive-resume/ui/components/textarea";
import { ReviewNotice } from "../editor/proposals/review-operation";
import { useVariantsCopy } from "./copy.generated";
import { useReviewSectionTitle } from "./review-interface-copy";
import { TermDialog } from "./term-dialog";
import {
	isTranslationFactGap,
	TranslationGapReason,
	TranslationGaps,
	TranslationPartRetry,
	UntranslatedBadge,
	useTranslationGapRetry,
} from "./translation-gaps";
import {
	extractVariantDecisionError,
	groupTranslationSegments,
	groupTranslationTerms,
} from "./translation-review-model";
import { PageHeader } from "@/components/layout/page-header";

export type DraftDecision = Pick<VariantDecisionInput, "subjectIds" | "decision"> &
	Partial<Pick<VariantDecisionInput, "editedText" | "undoDecisionId">> & { approveSegmentIds?: string[] };

export function TranslationDraftReview({
	operationId,
	review,
	result,
	sourceData,
	comparingSaved,
	locked,
	saving,
	error,
	decide,
	reload,
}: {
	operationId: string;
	review: VariantReviewView;
	result: Extract<VariantReviewView["result"], { kind: "review.translation" }>;
	sourceData?: ResumeData | undefined;
	comparingSaved: boolean;
	locked: boolean;
	saving: boolean;
	error: unknown;
	decide: (input: DraftDecision, onSuccess?: () => void) => void;
	reload: () => void;
}) {
	const copy = useVariantsCopy();
	const sectionTitle = useReviewSectionTitle();
	const blockerId = useId();
	const [showOriginal, setShowOriginal] = useState(comparingSaved);
	const [editing, setEditing] = useState<{ id: string; text: string } | null>(null);
	const [termSource, setTermSource] = useState<string | null>(null);
	const retry = useTranslationGapRetry(operationId, review.stale);
	const arabic = result.output.direction === "en-ar";
	const sourceLocale = arabic ? "en-US" : "ar-SA";
	const targetLocale = arabic ? "ar-SA" : "en-US";
	const draft = review.statuses.translation === "pending";
	const disabled = locked || review.stale || retry.pending;
	const { pending, confirmed, pendingTermIds } = groupTranslationTerms(review.terms.terms);
	const selectedTerm = [...pending, ...confirmed].find(({ source }) => source === termSource);
	const termSegmentIds = new Set(review.terms.terms.map(({ id }) => id.slice("term:".length)));
	const withheld = new Map(result.withheld?.items?.map((item) => [item.id, item]));
	const gaps = review.sourceSegments.flatMap(({ id, text, untranslated }) => {
		const gap = untranslated ?? withheld.get(id);
		if (!gap) return [];
		return [{ id, text, partIndex: gap.partIndex, reason: gap.reason ?? withheld.get(id)?.reason }];
	});
	const gapById = new Map(gaps.map((gap) => [gap.id, gap]));
	const { groups, actionableCount, pendingSegmentIds } = groupTranslationSegments({
		resultSegments: result.output.segments,
		sourceSegments: review.sourceSegments,
		segments: review.segments,
		statuses: review.statuses,
		sourceData,
		terms: review.terms.terms,
		gapIds: new Set(gapById.keys()),
	});
	const labelFor = (group?: (typeof groups)[number]) =>
		group?.customTitle ??
		(!group || group.sectionId === "other"
			? copy("language.translation.otherSection")
			: sectionTitle(group.sectionId, sourceData));
	const bySection = new Map(groups.flatMap((group) => group.items.map(({ id }) => [id, labelFor(group)] as const)));
	const issue = extractVariantDecisionError(error);
	const errorSegmentId = issue.reason === "TRANSLATION_LOCAL_VALUE_UNRESOLVED" ? issue.segmentId : null;
	const unresolved = groups.flatMap((group) =>
		group.items.filter((item) => item.hasUnresolvedPlaceholder || item.id === errorSegmentId),
	);
	const unresolvedIds = new Set(unresolved.map(({ id }) => id));
	const blocker = review.stale
		? copy("language.translation.blockedStale")
		: pending.length
			? copy("language.translation.blockedNames")
			: unresolved.length
				? copy("language.translation.needsAttention")
				: actionableCount === 0
					? copy("language.translation.blockedEmpty")
					: null;
	const undoBySegment = new Map(
		review.undoable.flatMap(({ subjectIds, decisionId }) =>
			subjectIds.length === 1 && subjectIds[0] ? [[subjectIds[0], decisionId] as const] : [],
		),
	);

	const renderTerm = (group: TermGroup) => (
		<SectionCardRow key={group.source} align="start" className="justify-between">
			<div className="grid min-w-0 flex-1 gap-1">
				<div className="flex flex-wrap items-center gap-2">
					<bdi className="type-label wrap-anywhere">{group.source}</bdi>
					<Badge variant="neutral">{copy("language.terms.occurrences", { count: group.count })}</Badge>
				</div>
				{group.value !== group.source && (
					<p dir="auto" className="wrap-anywhere">
						{group.value}
					</p>
				)}
			</div>
			{draft && (
				<Button variant="secondary" size="row" disabled={disabled} onClick={() => setTermSource(group.source)}>
					{copy("language.translation.edit")}
				</Button>
			)}
		</SectionCardRow>
	);

	const saveWording = (id: string, editedText: string) =>
		decide({ subjectIds: [id], decision: "accept_edited", editedText }, () => setEditing(null));

	const renderEditor = (item: SegmentItem) =>
		editing?.id === item.id ? (
			<div className="grid gap-2">
				<Textarea
					aria-label={copy("language.translation.editedText")}
					dir="auto"
					maxLength={4000}
					value={editing.text}
					onChange={(event) => setEditing({ id: item.id, text: event.target.value })}
				/>
				<ActionGroup>
					<Button
						variant="secondary"
						disabled={disabled || !editing.text.trim()}
						onClick={() => saveWording(item.id, editing.text)}
					>
						{copy("language.translation.saveWording")}
					</Button>
					<Button variant="secondary" disabled={locked} onClick={() => setEditing(null)}>
						{copy("language.translation.cancel")}
					</Button>
				</ActionGroup>
			</div>
		) : (
			<div className="flex flex-wrap justify-end gap-2">
				<Button
					variant="quiet"
					size="row"
					disabled={disabled}
					onClick={() => setEditing({ id: item.id, text: item.after })}
				>
					{copy("language.translation.edit")}
				</Button>
				{item.before && item.before !== item.after && (
					<Button variant="quiet" size="row" disabled={disabled} onClick={() => saveWording(item.id, item.before)}>
						{copy("language.translation.keepOriginal")}
					</Button>
				)}
				{item.edited && undoBySegment.has(item.id) && (
					<Button
						variant="quiet"
						size="row"
						disabled={disabled}
						onClick={() => {
							const undoDecisionId = undoBySegment.get(item.id);
							if (undoDecisionId) decide({ subjectIds: [item.id], decision: "undo", undoDecisionId });
						}}
					>
						{copy("language.translation.undo")}
					</Button>
				)}
			</div>
		);

	const renderSegment = (item: SegmentItem, gap?: TranslationGap) => (
		<div key={item.id} data-slot="translation-segment" className="grid min-w-0 gap-1 py-2 text-content-start">
			{showOriginal && item.before && !gap && (
				<blockquote dir="auto" className="type-body wrap-anywhere whitespace-pre-wrap text-ink-2">
					<bdi>{item.before}</bdi>
				</blockquote>
			)}
			<p
				dir={gap || item.status === "rejected" || item.edited ? "auto" : arabic ? "rtl" : "ltr"}
				lang={gap || item.status === "rejected" ? sourceLocale : item.edited ? undefined : targetLocale}
				className="type-body wrap-anywhere whitespace-pre-wrap text-ink"
			>
				<bdi>{gap ? item.before || item.after : item.after}</bdi>
			</p>
			{gap ? (
				<div className="flex flex-wrap items-center justify-between gap-2">
					<div className="flex min-w-0 flex-wrap items-center gap-2">
						<UntranslatedBadge />
						<TranslationGapReason reason={gap.reason} />
					</div>
					{gap.partIndex !== undefined && (
						<TranslationPartRetry
							partIndex={gap.partIndex}
							segmentId={isTranslationFactGap(gap.reason) ? item.id : undefined}
							disabled={disabled}
							retry={retry.open}
						/>
					)}
				</div>
			) : (
				<>
					{item.edited && (
						<div>
							<Badge variant="neutral">{copy("language.translation.edited")}</Badge>
						</div>
					)}
					{draft && !unresolvedIds.has(item.id) && !termSegmentIds.has(item.id) && renderEditor(item)}
				</>
			)}
		</div>
	);

	const header = (
		<div className="grid min-w-0 gap-2">
			<PageHeader
				title={copy(arabic ? "language.translation.reviewArabic" : "language.translation.reviewEnglish")}
				titleVariant="functional"
				description={draft ? copy("language.translation.trustNote") : undefined}
			/>
			{draft && (
				<div className="flex flex-wrap gap-2">
					<Badge variant="accent">
						{copy("language.translation.sectionsTranslated", {
							count: groups.filter((group) => group.totalCount > group.gapCount).length,
						})}
					</Badge>
					{gaps.length > 0 && (
						<Badge variant="warn">
							{copy(arabic ? "language.translation.keptEnglish" : "language.translation.keptArabic", {
								count: gaps.length,
							})}
						</Badge>
					)}
				</div>
			)}
		</div>
	);
	const content = (
		<>
			{draft && pending.length > 0 && (
				<SectionCard>
					<SectionCardHeader className="flex-wrap justify-between">
						<div className="grid gap-1">
							<SectionCardTitle as="h2">
								{copy("language.terms.confirmationCount", { count: pending.length })}
							</SectionCardTitle>
							<p className="type-metadata text-ink-2">{copy("language.terms.officialNamesHint")}</p>
						</div>
						<Button
							variant="secondary"
							disabled={disabled}
							onClick={() => decide({ subjectIds: pendingTermIds, decision: "accept" })}
						>
							{copy("language.terms.keepAllNames")}
						</Button>
					</SectionCardHeader>
					{pending.map(renderTerm)}
				</SectionCard>
			)}
			{draft && unresolved.length > 0 && (
				<Alert variant="warn">
					<Icon name="warning" />
					<AlertTitle>{copy("language.translation.unresolvedNotice")}</AlertTitle>
					<AlertDescription>
						<div className="grid gap-2">
							{unresolved.map((item) => (
								<div key={item.id} className="grid min-w-0 gap-1">
									<p dir="auto" className="wrap-anywhere">
										<bdi>{item.after}</bdi>
									</p>
									{renderEditor(item)}
								</div>
							))}
						</div>
					</AlertDescription>
				</Alert>
			)}
			<TranslationGaps
				gaps={gaps.map((gap) => ({ ...gap, section: bySection.get(gap.id) }))}
				retry={retry.open}
				disabled={disabled}
			/>
			{groups.length > 0 && (
				<SectionCard variant="flush">
					<SectionCardHeader className="flex-wrap justify-between">
						<SectionCardTitle as="h2">{copy("language.translation.previewTitle")}</SectionCardTitle>
						<Button variant="quiet" aria-pressed={showOriginal} onClick={() => setShowOriginal(!showOriginal)}>
							{copy("language.translation.showOriginal")}
						</Button>
					</SectionCardHeader>
					{groups.map((group) => (
						<Disclosure
							key={group.key}
							open={group.sectionId === "basics" || group.sectionId === "summary" || undefined}
						>
							<DisclosureSummary>
								<bdi>{labelFor(group)}</bdi>
								<CountBadge variant="neutral">{group.totalCount}</CountBadge>
								{group.gapCount > 0 && (
									<Badge variant="warn">{copy("language.translation.keptCount", { count: group.gapCount })}</Badge>
								)}
							</DisclosureSummary>
							<DisclosureContent className="divide-y divide-line">
								{group.items.map((item) => renderSegment(item, gapById.get(item.id)))}
							</DisclosureContent>
						</Disclosure>
					))}
				</SectionCard>
			)}
			{confirmed.length > 0 && (
				<Disclosure>
					<DisclosureSummary>{copy("language.terms.showConfirmed", { count: confirmed.length })}</DisclosureSummary>
					<DisclosureContent>{confirmed.map(renderTerm)}</DisclosureContent>
				</Disclosure>
			)}
			{error != null && (
				<ReviewNotice retry={reload}>
					{issue.reason === "TRANSLATION_LOCAL_VALUE_UNRESOLVED" ? (
						errorSegmentId && bySection.has(errorSegmentId) ? (
							copy("language.translation.errorUnresolved", { section: bySection.get(errorSegmentId) ?? "" })
						) : (
							copy("language.translation.errorUnresolvedGeneric")
						)
					) : issue.reason === "TRANSLATION_REVIEW_INCOMPLETE" ? (
						copy("language.translation.errorIncomplete")
					) : issue.reason === "TRANSLATION_STRUCTURE_CHANGED" ? (
						copy("language.translation.errorStructureChanged")
					) : (
						<Trans>The decision was not saved. Reload the review before trying again.</Trans>
					)}
				</ReviewNotice>
			)}
			{selectedTerm && (
				<TermDialog
					term={selectedTerm.representative}
					pending={locked}
					error={error != null}
					onCancel={() => setTermSource(null)}
					onConfirm={(text) =>
						decide({ subjectIds: selectedTerm.ids, decision: "accept_edited", editedText: text }, () =>
							setTermSource(null),
						)
					}
				/>
			)}
			{retry.dialog}
		</>
	);
	return draft ? (
		<StickyActions
			header={header}
			hint={
				blocker && (
					<p id={blockerId} className="type-metadata text-ink-2">
						{blocker}
					</p>
				)
			}
			actions={
				<>
					<Button
						size="row"
						disabled={disabled || Boolean(blocker)}
						aria-describedby={blocker ? blockerId : undefined}
						loading={saving}
						onClick={() =>
							decide({ subjectIds: ["translation"], decision: "accept", approveSegmentIds: pendingSegmentIds })
						}
					>
						{copy(
							saving
								? "language.translation.saving"
								: arabic
									? "language.translation.approveArabic"
									: "language.translation.approveEnglish",
						)}
					</Button>
					<Button
						variant="secondary"
						size="row"
						disabled={locked || retry.pending}
						onClick={() => decide({ subjectIds: ["translation"], decision: "reject" })}
					>
						{copy("language.translation.discard")}
					</Button>
				</>
			}
		>
			{content}
		</StickyActions>
	) : (
		<div className="grid min-w-0 gap-4">
			{header}
			{content}
		</div>
	);
}
