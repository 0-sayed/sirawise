import type { ResumeData } from "@reactive-resume/schema/resume/data";
import { Trans } from "@lingui/react/macro";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { useRef, useState } from "react";
import { buildTranslationInventory } from "@reactive-resume/resume/translation";
import { ActionGroup } from "@reactive-resume/ui/components/action-group";
import { Alert, AlertActions, AlertDescription } from "@reactive-resume/ui/components/alert";
import { BackNavigation } from "@reactive-resume/ui/components/back-navigation";
import { Badge } from "@reactive-resume/ui/components/badge";
import { Button } from "@reactive-resume/ui/components/button";
import { Icon } from "@reactive-resume/ui/components/icon";
import { SectionCard, SectionCardHeader, SectionCardTitle } from "@reactive-resume/ui/components/section-card";
import { SuccessStatus } from "@reactive-resume/ui/components/success-celebration";
import {
	isReviewRunning,
	ReviewLaunch,
	ReviewNotice,
	ReviewOperationPanel,
	useReviewOperationStatus,
} from "../editor/proposals/review-operation";
import { useVariantsCopy } from "./copy.generated";
import { TranslationReview } from "./translation-review";
import { PageHeader } from "@/components/layout/page-header";
import { QuerySkeleton } from "@/components/query-skeleton";
import { getAllowanceReason } from "@/features/usage/allowance-limit";
import { client, orpc } from "@/libs/orpc/client";

export function LanguageVersions({ resumeId }: { resumeId: string }) {
	const copy = useVariantsCopy();
	const family = useQuery(orpc.resume.variants.list.queryOptions({ input: { resumeId } }));
	const base = family.data?.find((cv) => cv.variantKind === "base");
	const language = family.data?.find((cv) => cv.variantKind === "language");
	const original = useQuery({
		...orpc.resume.getById.queryOptions({ input: { id: base?.resumeId ?? resumeId } }),
		enabled: !!base,
	});
	const actual = useQuery({
		...orpc.resume.getById.queryOptions({ input: { id: language?.resumeId ?? resumeId } }),
		enabled: !!language,
	});
	const freshness = useQuery({
		...orpc.resume.variants.freshness.queryOptions({ input: { resumeId: language?.resumeId ?? resumeId } }),
		enabled: !!language,
	});
	const [startedOperationId, setStartedOperationId] = useState<string | null>(null);
	const [view, setView] = useState<{ id: string; mode: "overview" | "review" | "compare" } | null>(null);
	const [savedOperationId, setSavedOperationId] = useState<string | null>(null);
	const request = useRef<{ fingerprint: string; requestKey: string } | null>(null);
	const operationId = startedOperationId ?? language?.operationId ?? null;
	const status = useReviewOperationStatus(operationId);
	const running = !!status.data && isReviewRunning(status.data);
	const previewReview = useQuery({
		...orpc.ai.variantReview.get.queryOptions({ input: { operationId: operationId ?? "" } }),
		enabled: !!status.data?.resultId && !running,
	});
	const waiting = status.data?.state === "waiting_review" || previewReview.data?.statuses.translation === "pending";
	const stale =
		(status.data?.failureCode === "AI_SOURCE_CHANGED" && !status.data.retryable) || !!previewReview.data?.stale;
	const active = running || (waiting && !stale) || (!!status.data?.retryable && !status.data.resultId);
	const mode =
		view && view.id === operationId ? view.mode : active || (operationId && !status.data) ? "review" : "overview";
	const justSaved = !!operationId && operationId === savedOperationId;
	const saved = freshness.data?.reviewState === "accepted" || justSaved;
	const draftPreview =
		waiting && original.data && previewReview.data
			? translationExcerpt(original.data.data, previewReview.data.segments)
			: null;
	const targetLocale = language?.targetLocale ?? (base?.documentLocale === "ar-SA" ? "en-US" : "ar-SA");
	const arabic = targetLocale === "ar-SA";
	const title = copy("language.copies.title");
	const translateLabel = copy(
		arabic ? "language.translation.translateToArabic" : "language.translation.translateToEnglish",
	);
	const backToOverview = () => {
		if (operationId) setView({ id: operationId, mode: "overview" });
	};
	const finish = (approved: boolean) => {
		if (approved) setSavedOperationId(operationId);
		backToOverview();
		void actual.refetch();
		void freshness.refetch();
		void family.refetch();
	};
	const start = (id: string) => {
		setStartedOperationId(id);
		setView({ id, mode: "review" });
		void family.refetch();
	};
	const prepare = async () => {
		if (!base) throw new Error("AI_SOURCE_CHANGED");
		if (language && actual.data && !request.current) {
			return client.ai.variantReview.prepare({
				kind: "review.translation",
				resumeId: language.resumeId,
				expectedUpdatedAt: actual.data.updatedAt.toISOString(),
				expectedSourceRevision: base.updatedAt,
			});
		}
		const fingerprint = JSON.stringify([base.resumeId, base.updatedAt, base.documentLocale]);
		if (request.current?.fingerprint !== fingerprint)
			request.current = { fingerprint, requestKey: crypto.randomUUID() };
		const created = await client.resume.variants
			.create({
				sourceResumeId: base.resumeId,
				expectedUpdatedAt: base.updatedAt,
				variantKind: "language",
				targetLocale,
				requestKey: request.current.requestKey,
			})
			.catch((error: unknown) => {
				if (getAllowanceReason(error) === "LANGUAGE_COPY_LIMIT") {
					request.current = null;
					void family.refetch();
				}
				throw error;
			});
		request.current = null;
		return client.ai.variantReview.prepare({
			kind: "review.translation",
			resumeId: created.resumeId,
			expectedUpdatedAt: created.updatedAt,
			expectedSourceRevision: base.updatedAt,
		});
	};

	if (operationId && mode !== "overview" && !family.error) {
		return (
			<>
				<div>
					<BackNavigation onClick={backToOverview}>{title}</BackNavigation>
				</div>
				<div className={running || !status.data ? "mx-auto w-full max-w-(--dashboard-form-width)" : "min-w-0"}>
					<ReviewOperationPanel
						operationId={operationId}
						kind="review.translation"
						progressLabel={copy("language.translation.translatingCv")}
						draftDescription={copy("language.translation.originalSafe")}
					>
						<TranslationReview
							key={operationId + ":" + mode}
							operationId={operationId}
							sourceData={original.data?.data}
							comparingSaved={mode === "compare"}
							onSaved={() => finish(true)}
							onDiscarded={() => finish(false)}
						/>
					</ReviewOperationPanel>
				</div>
			</>
		);
	}

	const sourceChanged = saved && (freshness.data?.state === "stale" || stale);
	const sourceUnavailable = freshness.data?.state === "unavailable";
	const launch = (label: string, variant: "primary" | "secondary") => (
		<ReviewLaunch
			kind="review.translation"
			variant={variant}
			disabled={!!language && !actual.data}
			prepare={prepare}
			onStarted={start}
		>
			{label}
		</ReviewLaunch>
	);

	return (
		<>
			<PageHeader
				title={title}
				description={copy("language.interface.independenceHint")}
				back={
					<BackNavigation render={<Link to="/dashboard" />}>
						<Trans>Back to documents</Trans>
					</BackNavigation>
				}
			/>
			{family.error ? (
				<ReviewNotice retry={() => void family.refetch()}>
					<Trans>Could not load language versions.</Trans>
				</ReviewNotice>
			) : family.isPending ? (
				<QuerySkeleton shape="rows" />
			) : base ? (
				<>
					{justSaved && (
						<SuccessStatus complete>
							{copy(arabic ? "language.translation.savedArabic" : "language.translation.savedEnglish")}
						</SuccessStatus>
					)}
					<div className="grid items-start gap-4 lg:grid-cols-2">
						<SectionCard className="min-w-0">
							<SectionCardHeader className="flex-wrap justify-between">
								<SectionCardTitle as="h2" dir="auto" className="wrap-anywhere">
									{base.name}
								</SectionCardTitle>
								<Badge variant="neutral">
									{copy(
										base.documentLocale === "ar-SA"
											? "language.translation.originalArabic"
											: "language.translation.originalEnglish",
									)}
								</Badge>
							</SectionCardHeader>
							<SavedPreview
								data={original.data?.data}
								retry={original.error ? () => void original.refetch() : undefined}
							/>
							<ActionGroup>
								<OpenCopy id={base.resumeId} variant="secondary" label={copy("language.translation.openOriginal")} />
							</ActionGroup>
						</SectionCard>
						<SectionCard className="min-w-0">
							<SectionCardHeader className="flex-wrap justify-between">
								<SectionCardTitle as="h2">
									{copy(arabic ? "language.translation.copyArabic" : "language.translation.copyEnglish")}
								</SectionCardTitle>
								{waiting ? (
									<Badge variant="warn">{copy("language.translation.status.pending")}</Badge>
								) : (
									saved && (
										<Badge variant="accent">
											{copy(arabic ? "language.translation.readyArabic" : "language.translation.readyEnglish")}
										</Badge>
									)
								)}
							</SectionCardHeader>
							{draftPreview ? (
								<CopyExcerpt {...draftPreview} />
							) : saved ? (
								<SavedPreview data={actual.data?.data} retry={actual.error ? () => void actual.refetch() : undefined} />
							) : (
								!active && <p className="type-body text-ink-2">{copy("language.translation.copyHint")}</p>
							)}
							{freshness.error && (
								<ReviewNotice retry={() => void freshness.refetch()}>
									<Trans>Could not check the source revision.</Trans>
								</ReviewNotice>
							)}
							{sourceChanged || sourceUnavailable || stale ? (
								<Alert variant="info" role="status">
									<Icon name="info" />
									<AlertDescription>
										{copy(
											sourceUnavailable
												? "language.translation.sourceUnavailable"
												: stale
													? "language.translation.staleReview"
													: "language.translation.sourceChanged",
										)}
									</AlertDescription>
									{sourceChanged && !sourceUnavailable && !active && (
										<AlertActions>{launch(copy("language.translation.updateCopy"), "secondary")}</AlertActions>
									)}
								</Alert>
							) : null}
							<ActionGroup>
								{operationId && active && (
									<Button onClick={() => setView({ id: operationId, mode: "review" })}>
										{copy(
											waiting && !running ? "language.translation.reviewDraft" : "language.translation.viewProgress",
										)}
									</Button>
								)}
								{saved && language && (
									<OpenCopy
										id={language.resumeId}
										variant={active ? "secondary" : "primary"}
										label={copy(
											active
												? "language.translation.openSavedCopy"
												: arabic
													? "language.translation.openArabic"
													: "language.translation.openEnglish",
										)}
									/>
								)}
								{!active &&
									!sourceChanged &&
									!sourceUnavailable &&
									launch(
										saved ? copy("language.translation.retranslate") : translateLabel,
										saved ? "secondary" : "primary",
									)}
							</ActionGroup>
							{saved &&
								!active &&
								operationId &&
								previewReview.data?.statuses.translation === "accepted" &&
								!previewReview.data.stale && (
									<div>
										<Button variant="quiet" onClick={() => setView({ id: operationId, mode: "compare" })}>
											{copy("language.translation.compareWithOriginal")}
										</Button>
									</div>
								)}
						</SectionCard>
					</div>
				</>
			) : null}
		</>
	);
}

function OpenCopy({ id, label, variant }: { id: string; label: string; variant: "primary" | "secondary" }) {
	return (
		<Button variant={variant} nativeButton={false} render={<Link to="/builder/$resumeId" params={{ resumeId: id }} />}>
			{label}
		</Button>
	);
}

function SavedPreview({ data, retry }: { data: ResumeData | undefined; retry?: (() => void) | undefined }) {
	if (retry)
		return (
			<ReviewNotice retry={retry}>
				<Trans>Could not load the saved preview.</Trans>
			</ReviewNotice>
		);
	if (!data) return null;
	const summary = data.summary.content.replace(/<[^>]*>/gu, " ").trim();
	return <CopyExcerpt headline={data.basics.headline} summary={summary} />;
}

function translationExcerpt(data: ResumeData, reviewed: Record<string, { text: string }>) {
	const { segments } = buildTranslationInventory(data);
	const headline = segments.find(({ target }) => target.sectionId === "basics" && target.field === "headline");
	return {
		headline: headline ? (reviewed[headline.id]?.text ?? headline.text) : "",
		summary: segments
			.filter(({ target }) => target.sectionId === "summary" && target.field === "content")
			.map(({ id, text }) => reviewed[id]?.text ?? text)
			.join(" "),
	};
}

function CopyExcerpt({ headline, summary }: { headline: string; summary: string }) {
	return (
		<div className="grid min-w-0 gap-1 text-start">
			{headline && (
				<p className="line-clamp-1 wrap-anywhere">
					<bdi>{headline}</bdi>
				</p>
			)}
			{summary && (
				<p className="line-clamp-2 wrap-anywhere text-ink-2">
					<bdi>{summary}</bdi>
				</p>
			)}
		</div>
	);
}
