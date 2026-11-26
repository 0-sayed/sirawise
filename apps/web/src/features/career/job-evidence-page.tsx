import type { jobEvidenceViewSchema } from "@reactive-resume/schema/job-evidence";
import type { z } from "zod";
import { Trans } from "@lingui/react/macro";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { useState } from "react";
import { buildJobPassages } from "@reactive-resume/resume/ats";
import { Button } from "@reactive-resume/ui/components/button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@reactive-resume/ui/components/collapsible";
import { Icon } from "@reactive-resume/ui/components/icon";
import { SectionCard, SectionCardTitle } from "@reactive-resume/ui/components/section-card";
import { SuccessStatus } from "@reactive-resume/ui/components/success-celebration";
import { LiteralJobEvidence } from "./literal-job-evidence";
import { FeatureBetaBadge } from "@/components/feature-beta-badge";
import { ReviewLaunch, ReviewNotice, ReviewOperationPanel } from "@/features/resume/editor/proposals/review-operation";
import { useVariantsCopy } from "@/features/resume/variants/copy.generated";
import { TranslationReview } from "@/features/resume/variants/translation-review";
import { AllowanceLimitNotice, getAllowanceReason } from "@/features/usage/allowance-limit";
import { client, orpc } from "@/libs/orpc/client";
export function JobEvidencePage({
	resumeId,
	data,
	onRefresh,
}: {
	resumeId: string;
	data: z.infer<typeof jobEvidenceViewSchema>;
	onRefresh: () => void;
}) {
	const copy = useVariantsCopy();
	const selection = data.selection;
	const job = selection ? { jobId: selection.jobId, jobRevision: selection.jobRevision } : undefined;
	const family = useQuery(orpc.resume.variants.list.queryOptions({ input: { resumeId, job } }));
	const current = family.data?.find((document) => document.resumeId === resumeId);
	const isJobCopy = current?.variantKind === "job";
	const cv = useQuery(orpc.resume.getById.queryOptions({ input: { id: resumeId } }));
	const passages = cv.data ? buildJobPassages(cv.data.data) : [];
	const [retryRequests, setRetryRequests] = useState({ evidence: 0, tailoring: 0 });
	const [evidenceOpen, setEvidenceOpen] = useState<boolean | undefined>();
	const [startedEvidence, setStartedEvidence] = useState<string | null>(null);
	const [evidenceParent, setEvidenceParent] = useState<string | null>(null);
	const [startedTailoring, setStartedTailoring] = useState<string | null>(null);
	const operationId = startedEvidence ?? ("operationId" in data.semantic ? data.semantic.operationId : null);
	const tailoringId = startedTailoring ?? current?.operationId;
	// The review panel loads the result after delivery. Subscribe to the same query for the page actions.
	const tailoring = useQuery({
		...orpc.ai.variantReview.get.queryOptions({ input: { operationId: tailoringId ?? "" } }),
		enabled: false,
	});
	const decisionId = tailoring.data?.latestDecisionId;
	const accepted =
		tailoring.data?.result.kind === "review.tailoring" &&
		!tailoring.data.stale &&
		Object.values(tailoring.data.statuses).includes("accepted");
	const reviewed = tailoringId && decisionId && accepted ? { operationId: tailoringId, decisionId } : null;
	const jobCopies =
		family.data?.filter((document) => document.variantKind === "job" && document.jobId === job?.jobId) ?? [];
	const saved = reviewed
		? jobCopies.find((document) => document.tailoringDecisionId === reviewed.decisionId)
		: undefined;
	const create = useMutation({
		mutationFn: (review: NonNullable<typeof reviewed>) => {
			if (!cv.data || !job) throw new Error("SOURCE_UNAVAILABLE");
			return client.resume.variants.create({
				sourceResumeId: resumeId,
				expectedUpdatedAt: cv.data.updatedAt.toISOString(),
				variantKind: "job",
				requestKey: crypto.randomUUID(),
				...job,
				review,
			});
		},
		onSuccess: () => {
			void family.refetch();
		},
	});
	const createdId =
		saved?.resumeId ?? (create.variables?.operationId === tailoringId ? create.data?.resumeId : undefined);
	const openId = createdId ?? (isJobCopy && accepted ? resumeId : undefined);
	const canCreate = Boolean(reviewed && cv.data && !cv.data.isLocked && job && current && !isJobCopy);
	const retryTailoring = () => setRetryRequests((r) => ({ ...r, tailoring: r.tailoring + 1 }));
	const retryEvidence = () => {
		if (evidenceParent) {
			setStartedEvidence(evidenceParent);
			setEvidenceParent(null);
			return;
		}
		setRetryRequests((r) => ({ ...r, evidence: r.evidence + 1 }));
	};
	return (
		<div className="grid min-w-0 gap-4">
			{data.literal && <LiteralJobEvidence report={data.literal} resumeId={resumeId} passages={passages} />}
			<SectionCard className="min-w-0">
				<SectionCardTitle as="h2">{copy("jobs.tailoring.copyTitle")}</SectionCardTitle>
				{!isJobCopy && !createdId && <p className="type-body text-ink-2">{copy("jobs.tailoring.copyHint")}</p>}
				{createdId && <SuccessStatus complete>{copy("jobs.copy.toast.created")}</SuccessStatus>}
				{(openId || jobCopies.length > 0) && (
					<section aria-label={copy("jobs.tailoring.savedCopies")} className="grid gap-2">
						{openId && (
							<div>
								<Button
									nativeButton={false}
									render={<Link role="link" to="/builder/$resumeId" params={{ resumeId: openId }} />}
								>
									{copy("jobs.tailoring.openCopy")}
								</Button>
							</div>
						)}
						{jobCopies.some((document) => document.resumeId !== openId) && (
							<>
								<h3 className="type-label">{copy("jobs.tailoring.savedCopies")}</h3>
								<ul className="grid gap-2">
									{jobCopies
										.filter((document) => document.resumeId !== openId)
										.map((document) => (
											<li key={document.resumeId}>
												<Button
													nativeButton={false}
													variant="secondary"
													render={<Link role="link" to="/builder/$resumeId" params={{ resumeId: document.resumeId }} />}
												>
													<bdi dir="auto">{document.name}</bdi>
												</Button>
											</li>
										))}
								</ul>
							</>
						)}
					</section>
				)}
				{current && cv.data && selection && !createdId && (
					<ReviewLaunch
						hideTrigger={Boolean(tailoringId)}
						disabled={cv.data.isLocked || create.isPending}
						retryRequest={retryRequests.tailoring}
						kind="review.tailoring"
						prepare={() =>
							client.ai.variantReview.prepare({
								kind: "review.tailoring",
								resumeId,
								expectedUpdatedAt: cv.data.updatedAt.toISOString(),
								jobId: selection.jobId,
								jobRevision: selection.jobRevision,
								expectedSelectionRevision: selection.revision,
							})
						}
						onStarted={setStartedTailoring}
					>
						{copy("jobs.tailoring.suggest")}
					</ReviewLaunch>
				)}
				{tailoringId && !createdId && (
					<ReviewOperationPanel kind="review.tailoring" onRetry={retryTailoring} operationId={tailoringId}>
						<TranslationReview
							key={tailoringId}
							operationId={tailoringId}
							sourceData={cv.data?.data}
							onSaved={onRefresh}
							onRetry={retryTailoring}
							stageTailoring={!isJobCopy}
							lockDecisions={create.isPending}
							footerHint={!accepted && <p className="type-metadata text-ink-2">{copy("jobs.tailoring.acceptHint")}</p>}
							primaryAction={
								!isJobCopy &&
								tailoring.data?.result.kind === "review.tailoring" &&
								!tailoring.data.stale && (
									<Button
										disabled={!canCreate || create.isPending}
										onClick={() => {
											if (reviewed) create.mutate(reviewed);
										}}
									>
										{copy("jobs.tailoring.saveCopy")}
									</Button>
								)
							}
						/>
					</ReviewOperationPanel>
				)}
			</SectionCard>
			<SectionCard className="min-w-0">
				<Collapsible
					open={evidenceOpen ?? Boolean(operationId)}
					onOpenChange={setEvidenceOpen}
					className="group/requirements"
				>
					<h2>
						<CollapsibleTrigger variant="heading" className="w-full text-start">
							<Icon name="caret-down" className="group-data-panel-open/requirements:rotate-180" aria-hidden />
							<span>{copy("jobs.evidence.detailsTitle")}</span>
							<FeatureBetaBadge />
						</CollapsibleTrigger>
					</h2>
					<CollapsibleContent>
						<div className="grid gap-3 pt-2">
							<p className="type-body text-ink-2">{copy("jobs.evidence.detailsHint")}</p>
							{cv.data && selection && (
								<ReviewLaunch
									variant="secondary"
									hideTrigger={Boolean(operationId)}
									retryRequest={retryRequests.evidence}
									kind="review.job-evidence"
									prepare={() =>
										client.ai.variantReview.prepare({
											kind: "review.job-evidence",
											resumeId,
											expectedUpdatedAt: cv.data.updatedAt.toISOString(),
											jobId: selection.jobId,
											jobRevision: selection.jobRevision,
											expectedSelectionRevision: selection.revision,
										})
									}
									onStarted={(id) => {
										setEvidenceParent(null);
										setStartedEvidence(id);
									}}
								>
									{copy("jobs.evidence.check")}
								</ReviewLaunch>
							)}
							{operationId && (
								<ReviewOperationPanel kind="review.job-evidence" onRetry={retryEvidence} operationId={operationId}>
									<TranslationReview
										key={operationId}
										operationId={operationId}
										sourceData={cv.data?.data}
										onSaved={onRefresh}
										onRetry={retryEvidence}
										onContinued={(id) => {
											setEvidenceParent(operationId);
											setStartedEvidence(id);
										}}
									/>
								</ReviewOperationPanel>
							)}
						</div>
					</CollapsibleContent>
				</Collapsible>
			</SectionCard>
			{getAllowanceReason(create.error) ? (
				<AllowanceLimitNotice
					error={create.error}
					actions={
						<>
							{family.data
								?.filter((document) => document.variantKind === "job")
								.map((document) => (
									<Button
										key={document.resumeId}
										nativeButton={false}
										variant="secondary"
										render={<Link to="/dashboard/resumes/$resumeId/job" params={{ resumeId: document.resumeId }} />}
									>
										<Trans>Open saved CV</Trans>
									</Button>
								))}
							<Button variant="secondary" onClick={() => void family.refetch()}>
								<Trans>Retry</Trans>
							</Button>
						</>
					}
				/>
			) : (
				create.error && (
					<ReviewNotice retry={() => create.reset()}>
						<Trans>
							Could not create a copy. Check the included copy allowance and current source. Your CV is unchanged.
						</Trans>
					</ReviewNotice>
				)
			)}
		</div>
	);
}
