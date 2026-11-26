import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { useState } from "react";
import { Badge } from "@reactive-resume/ui/components/badge";
import { IconButton } from "@reactive-resume/ui/components/icon-button";
import { cn } from "@reactive-resume/utils/style";
import { isReviewRunning, useReviewOperationStatus } from "../editor/proposals/review-operation";
import { TranslationGaps, UntranslatedBadge, useTranslationGapRetry } from "./translation-gaps";
import { browserStorage, storageKey } from "@/libs/browser-storage";
import { orpc } from "@/libs/orpc/client";
/** A copy's stored identity is independent from the interface language and review status. */
export function VariantBanner({ resumeId, className }: { resumeId: string; className?: string }) {
	const family = useQuery(orpc.resume.variants.list.queryOptions({ input: { resumeId } }));
	const { data: documents } = useQuery(orpc.documents.list.queryOptions({ input: { trashed: false } }));
	const key = storageKey("variantContext", resumeId);
	const [collapsed, setCollapsed] = useState(() => {
		try {
			return browserStorage.session.getItem(key) === "collapsed";
		} catch {
			return false;
		}
	});
	const toggle = () =>
		setCollapsed((previous) => {
			try {
				browserStorage.session.setItem(key, previous ? "open" : "collapsed");
			} catch {
				/* Keep the session's in-memory choice. */
			}
			return !previous;
		});
	const current = family.data?.find((document) => document.resumeId === resumeId);
	if (!current || current.variantKind === "base") return null;
	const job = documents?.find((document) => document.id === resumeId)?.application;
	return (
		<section aria-label={t`Copy context`} className={cn("grid gap-2 rounded-lg border border-line p-3", className)}>
			<div className="flex min-w-0 items-center gap-2">
				<Badge>{current.variantKind === "language" ? <Trans>Language copy</Trans> : <Trans>Job copy</Trans>}</Badge>
				<span className="type-metadata text-ink-2">
					{current.documentLocale.startsWith("ar") ? (
						<Trans>Arabic</Trans>
					) : current.documentLocale.startsWith("en") ? (
						<Trans>English</Trans>
					) : (
						current.documentLocale
					)}
				</span>
				<IconButton
					className="ms-auto"
					size="icon-sm"

					label={collapsed ? t`Expand copy context` : t`Collapse copy context`}
					aria-expanded={!collapsed}
					onClick={toggle}
					icon="caret-down"
				/>
			</div>
			{!collapsed && (
				<>
					<p dir="auto" className="type-body wrap-anywhere">
						{job ? `${job.role} · ${job.company}` : current.name}
					</p>
					<div className="flex flex-wrap items-center gap-3 type-metadata text-accent-text *:hover:underline">
						{current.sourceResumeId && (
							<Link to="/builder/$resumeId" params={{ resumeId: current.sourceResumeId }}>
								<Trans>Open source CV</Trans>
							</Link>
						)}
						{current.variantKind === "language" ? (
							<Link to="/dashboard/resumes/$resumeId/languages" params={{ resumeId }}>
								<Trans>Review language copy</Trans>
							</Link>
						) : (
							<Link to="/dashboard/resumes/$resumeId/job" params={{ resumeId }}>
								<Trans>Review job copy</Trans>
							</Link>
						)}
					</div>
				</>
			)}
			{current.variantKind === "language" && current.operationId && (
				<LanguageCopyGaps operationId={current.operationId} collapsed={collapsed} />
			)}
		</section>
	);
}

function LanguageCopyGaps({ operationId, collapsed }: { operationId: string; collapsed: boolean }) {
	const status = useReviewOperationStatus(operationId);
	const running = !!status.data && isReviewRunning(status.data);
	const review = useQuery({
		...orpc.ai.variantReview.get.queryOptions({ input: { operationId } }),
		enabled: !!status.data?.resultId && !running,
	});
	const retry = useTranslationGapRetry(operationId, review.data?.stale);
	if (running || review.data?.stale || review.data?.statuses.translation === "rejected") return null;
	const result = review.data?.result;
	const withheld = new Map(
		result?.kind === "review.translation" ? result.withheld?.items?.map((item) => [item.id, item]) : [],
	);
	const gaps =
		review.data?.sourceSegments.flatMap(({ id, text, untranslated }) =>
			untranslated
				? [{ id, text, partIndex: untranslated.partIndex, reason: untranslated.reason ?? withheld.get(id)?.reason }]
				: [],
		) ?? [];
	if (gaps.length === 0) return null;
	if (collapsed) return <UntranslatedBadge />;
	return (
		<>
			<TranslationGaps gaps={gaps} retry={retry.open} disabled={retry.pending} />
			{retry.dialog}
		</>
	);
}
