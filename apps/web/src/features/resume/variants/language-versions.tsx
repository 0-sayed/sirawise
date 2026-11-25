import { Trans } from "@lingui/react/macro";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { useRef, useState } from "react";
import { BackNavigation } from "@reactive-resume/ui/components/back-navigation";
import { Button } from "@reactive-resume/ui/components/button";
import { SectionCard } from "@reactive-resume/ui/components/section-card";
import { ReviewLaunch, ReviewNotice, ReviewOperationPanel } from "../editor/proposals/review-operation";
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
	const [startedOperationId, setStartedOperationId] = useState<string | null>(null);
	const [creatingCopy, setCreatingCopy] = useState(false);
	const request = useRef<{ fingerprint: string; requestKey: string } | null>(null);
	const targetLocale = base?.documentLocale === "ar-SA" ? "en-US" : "ar-SA";
	const translateLabel =
		targetLocale === "en-US"
			? copy("language.translation.translateToEnglish")
			: copy("language.translation.translateToArabic");
	return (
		<>
			<PageHeader
				title={copy("language.copies.title")}
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
			) : (
				<>
					{family.data
						?.filter((cv) => cv.variantKind !== "job")
						.map((cv) => (
							<VersionCard
								key={cv.resumeId}
								document={cv}
								initialOperationId={cv.variantKind === "language" ? startedOperationId : null}
								onSaved={() => void family.refetch()}
							/>
						))}
					{(!language || creatingCopy) && base && (
						<ReviewLaunch
							kind="review.translation"
							prepare={async () => {
								setCreatingCopy(true);
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
										if (getAllowanceReason(error) === "LANGUAGE_COPY_LIMIT") void family.refetch();
										throw error;
									});
								request.current = null;
								return client.ai.variantReview.prepare({
									kind: "review.translation",
									resumeId: created.resumeId,
									expectedUpdatedAt: created.updatedAt,
									expectedSourceRevision: base.updatedAt,
								});
							}}
							onStarted={(opId) => {
								setStartedOperationId(opId);
								setCreatingCopy(false);
								void family.refetch();
							}}
						>
							{translateLabel}
						</ReviewLaunch>
					)}
				</>
			)}
		</>
	);
}
type Document = {
	resumeId: string;
	name: string;
	variantKind: "base" | "job" | "language";
	sourceResumeId: string | null;
	documentLocale: string;
	targetLocale: "ar-SA" | "en-US" | null;
	updatedAt: string;
	operationId: string | null;
};
function VersionCard({
	document,
	initialOperationId,
	onSaved,
}: {
	document: Document;
	initialOperationId: string | null;
	onSaved: () => void;
}) {
	const copy = useVariantsCopy();
	const [started, setStarted] = useState<string | null>(null);
	const source = useQuery({
		...orpc.resume.getById.queryOptions({ input: { id: document.sourceResumeId ?? document.resumeId } }),
		enabled: document.variantKind === "language",
	});
	const actual = useQuery(orpc.resume.getById.queryOptions({ input: { id: document.resumeId } }));
	const freshness = useQuery({
		...orpc.resume.variants.freshness.queryOptions({ input: { resumeId: document.resumeId } }),
		enabled: document.variantKind !== "base",
	});
	const operationId = started ?? initialOperationId ?? document.operationId;
	const isAccepted = freshness.data?.reviewState === "accepted";
	const translateLabel =
		document.targetLocale === "ar-SA"
			? copy("language.translation.translateToArabic")
			: copy("language.translation.translateToEnglish");
	return (
		<SectionCard>
			<h2 className="type-section" dir="auto">
				{document.name}
			</h2>
			<p>
				{document.variantKind === "language"
					? (document.targetLocale ?? document.documentLocale)
					: document.documentLocale}{" "}
				· {document.variantKind === "base" ? <Trans>Original</Trans> : <Trans>Language copy</Trans>}
			</p>
			{actual.data && (
				<div dir={document.documentLocale === "ar-SA" ? "rtl" : "ltr"} className="grid gap-2">
					<p>{actual.data.data.basics.headline}</p>
					<p>{actual.data.data.summary.content.replace(/<[^>]*>/gu, " ")}</p>
				</div>
			)}
			{actual.error && (
				<ReviewNotice retry={() => void actual.refetch()}>
					<Trans>Could not load the saved preview.</Trans>
				</ReviewNotice>
			)}
			{document.variantKind === "language" ? (
				<div className="flex flex-wrap items-center gap-2">
					<Button
						variant={isAccepted ? "primary" : "secondary"}
						nativeButton={false}
						render={<Link to="/builder/$resumeId" params={{ resumeId: document.resumeId }} />}
					>
						{copy("language.translation.openCopy")}
					</Button>
					{source.data && actual.data && (
						<ReviewLaunch
							kind="review.translation"
							variant={isAccepted ? "secondary" : "primary"}
							prepare={() =>
								client.ai.variantReview.prepare({
									kind: "review.translation",
									resumeId: document.resumeId,
									expectedUpdatedAt: actual.data.updatedAt.toISOString(),
									expectedSourceRevision: source.data.updatedAt.toISOString(),
								})
							}
							onStarted={setStarted}
						>
							{translateLabel}
						</ReviewLaunch>
					)}
				</div>
			) : (
				<Link to="/builder/$resumeId" params={{ resumeId: document.resumeId }}>
					<Trans>Open saved CV</Trans>
				</Link>
			)}
			{document.variantKind === "language" && (
				<>
					<p role="status">
						{isAccepted ? <Trans>Reviewed translation saved</Trans> : copy("language.translation.status.pending")}
					</p>
					{freshness.data && freshness.data.state !== "current" && (
						<ReviewNotice retry={() => void freshness.refetch()}>
							<Trans>The source changed or is unavailable. Update deliberately; saved copies stay independent.</Trans>
						</ReviewNotice>
					)}
					{freshness.error && (
						<ReviewNotice retry={() => void freshness.refetch()}>
							<Trans>Could not check the source revision.</Trans>
						</ReviewNotice>
					)}
					{operationId && (
						<ReviewOperationPanel operationId={operationId} kind="review.translation">
							<TranslationReview
								operationId={operationId}
								sourceData={source.data?.data}
								onSaved={() => {
									void actual.refetch();
									void freshness.refetch();
									onSaved();
								}}
							/>
						</ReviewOperationPanel>
					)}
				</>
			)}
		</SectionCard>
	);
}
