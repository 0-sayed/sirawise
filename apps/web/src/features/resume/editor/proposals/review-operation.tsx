import type { OperationRequest, OperationView, SourceRevision } from "@reactive-resume/schema/ai-operation";
import type { ReactNode } from "react";
import { useLingui } from "@lingui/react";
import { Trans } from "@lingui/react/macro";
import { ORPCError } from "@orpc/client";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useEffectEvent, useId, useRef, useState } from "react";
import { ActionGroup } from "@reactive-resume/ui/components/action-group";
import { Alert, AlertTitle, AlertDescription, AlertActions } from "@reactive-resume/ui/components/alert";
import { Button } from "@reactive-resume/ui/components/button";
import { Dialog, DialogContent, DialogTitle, DialogFooter } from "@reactive-resume/ui/components/dialog";
import { Icon } from "@reactive-resume/ui/components/icon";
import { Progress } from "@reactive-resume/ui/components/progress";
import { isUiLocale } from "@reactive-resume/utils/locale";
import {
	acceptProcessingNotice,
	type ProcessingNotice,
	ProcessingDetails,
	ProcessingNoticeContent,
	useProcessingNotice,
	useTranslationRetryConsent,
} from "./processing-consent";
import { ReviewFailureReason, TranslationPartFailure } from "./review-failure";
import { QuerySkeleton } from "@/components/query-skeleton";
import { useAssistantCopy } from "@/features/assistant/copy.generated";
import { assistantAvailability } from "@/features/assistant/operation-state";
import { AllowanceLimitNotice, getAllowanceReason } from "@/features/usage/allowance-limit";
import { client, orpc } from "@/libs/orpc/client";

export function ReviewNotice({
	children,
	retry,
	title,
	actions,
}: {
	children: ReactNode;
	retry?: (() => void) | undefined;
	title?: ReactNode;
	actions?: ReactNode;
}) {
	return (
		<Alert variant="warn">
			<Icon name="warning-circle" />
			<AlertTitle>{title ?? <Trans>Review needs attention</Trans>}</AlertTitle>
			<AlertDescription>{children}</AlertDescription>

			<AlertActions>
				{actions}
				{retry && (
					<Button variant="secondary" onClick={retry}>
						<Trans>Retry</Trans>
					</Button>
				)}
			</AlertActions>
		</Alert>
	);
}
export function launchIssue(error: Error | null) {
	if (!error) return null;
	const code = error instanceof ORPCError ? error.code : undefined;
	const reason =
		error instanceof ORPCError
			? (error.data?.reason ?? (/^[A-Z][A-Z_]+$/u.test(error.message) ? error.message : code))
			: error.message;
	const recovery = {
		SAVE_REQUIRED: "review.launch.saveRequired",
		AI_REVIEW_SAVE_REQUIRED: "review.launch.saveRequired",
		LETTER_EVIDENCE_REQUIRED: "review.launch.jobRequired",
		LETTER_JOB_TEXT_REQUIRED: "review.launch.jobTextRequired",
		LETTER_SOURCE_REQUIRED: "review.launch.cvRequired",
		LETTER_LANGUAGE_REQUIRED: "review.launch.languageRequired",
		AI_SOURCE_CHANGED: "review.launch.sourceChanged",
		AI_REVIEW_ALREADY_CONTINUED: "review.launch.sourceChanged",
		SOURCE_CHANGED: "review.launch.sourceChanged",
		RESUME_VERSION_CHANGED: "review.launch.sourceChanged",
		JOB_SELECTION_CHANGED: "review.launch.sourceChanged",
		JOB_REVISION_CHANGED: "review.launch.sourceChanged",
		JOB_DIGEST_CHANGED: "review.launch.sourceChanged",
		LETTER_REVIEW_STALE: "review.launch.sourceChanged",
		CONFLICT: "review.launch.sourceChanged",
		AI_SOURCE_UNAVAILABLE: "review.launch.sourceUnavailable",
		AI_REVIEW_UNAVAILABLE: "review.launch.sourceUnavailable",
		REVIEW_UNAVAILABLE: "review.launch.sourceUnavailable",
		SOURCE_UNAVAILABLE: "review.launch.sourceUnavailable",
		NOT_FOUND: "review.launch.sourceUnavailable",
		AI_SOURCE_EXPIRED: "review.launch.sourceExpired",
		AI_SOURCE_LOCKED: "review.launch.sourceLocked",
		RESUME_LOCKED: "review.launch.sourceLocked",
		LETTER_LOCKED: "review.launch.sourceLocked",
		SUBMITTED_DOCUMENT_IMMUTABLE: "review.launch.sourceLocked",
		AI_INVALID_REQUEST: "review.launch.invalidSelection",
		BAD_REQUEST: "review.launch.invalidSelection",
		AI_AMBIGUOUS_PASSAGE: "review.launch.ambiguousPassage",
		AI_REQUEST_KEY_REUSED: "review.launch.requestReused",
		REQUEST_KEY_REUSED: "review.launch.requestReused",
		TRANSLATION_BATCH_INCOMPLETE: "review.launch.batchIncomplete",
	} as const;
	if (reason && Object.hasOwn(recovery, reason))
		return { key: recovery[reason as keyof typeof recovery], action: "none" } as const;
	if (
		["AI_UNAVAILABLE", "AI_NOT_ENABLED", "NO_APPROVED_ROUTE", "WORKER_UNAVAILABLE", "FEATURE_UNAVAILABLE"].includes(
			reason,
		)
	)
		return { key: "review.assistant.environmentUnavailable", action: "none" } as const;
	if (reason === "AI_INPUT_LIMIT") return { key: "review.launch.inputTooLarge", action: "none" } as const;
	if (reason === "AI_CONSENT_REQUIRED" || reason === "AI_CONSENT_NOTICE_CHANGED")
		return { key: "review.launch.consentRequired", action: "consent" } as const;
	if (reason === "TRANSLATION_STRUCTURE_CHANGED")
		return { key: "review.launch.translationStructure", action: "none" } as const;
	if (reason === "TRANSLATION_PARTIAL_COVERAGE")
		return {
			key: "review.launch.translationUnsupported",
			action: "none",
			sections:
				error instanceof ORPCError && Array.isArray(error.data?.sections)
					? error.data.sections.filter((section: unknown): section is string => typeof section === "string")
					: [],
		} as const;
	if (
		[
			"AI_PROVIDER_ERROR",
			"PROVIDER_ERROR",
			"TIMEOUT",
			"AI_TIMEOUT",
			"INTERNAL_SERVER_ERROR",
			"BAD_GATEWAY",
			"SERVICE_UNAVAILABLE",
			"TOO_MANY_REQUESTS",
		].includes(reason) ||
		(error instanceof ORPCError && error.status >= 500) ||
		(error instanceof TypeError && /fetch|network|load failed/i.test(error.message))
	)
		return { key: "review.launch.providerError", action: "retry" } as const;
	return { key: "review.launch.unexpectedError", action: "none" } as const;
}

type ReviewKind =
	`review.${"wording" | "extraction" | "job-evidence" | "tailoring" | "translation" | "summary" | "cover-letter"}`;

/** Consent is an explicit choice before preparation/staging; a decline makes no mutation request. */
export function ReviewLaunch({
	id,
	kind,
	prepare,
	onStarted,
	children,
	disabled = false,
	running = false,
	retryRequest = 0,
	variant = "primary",
	hideTrigger = false,
	continuation = false,
}: {
	id?: string;
	retryRequest?: number;
	kind: ReviewKind;
	prepare: () => Promise<{ sources: SourceRevision[]; parameters: Record<string, unknown> }>;
	onStarted: (operationId: string) => void;
	children: ReactNode;
	disabled?: boolean;
	running?: boolean;
	variant?: "primary" | "secondary";
	hideTrigger?: boolean;
	continuation?: boolean;
}) {
	const copy = useAssistantCopy();
	const { i18n } = useLingui();
	const availability = useQuery(orpc.ai.availability.queryOptions());
	const usage = useQuery(orpc.ai.usage.get.queryOptions());
	const [open, setOpen] = useState(false);
	const processing = useProcessingNotice(open, kind);
	const [request, setRequest] = useState<OperationRequest | null>(null);
	const [acceptedNotice, setAcceptedNotice] = useState<ProcessingNotice | null>(null);
	const autoLaunch = useRef(false);
	const launching = useRef(false);
	const state = assistantAvailability(
		availability.data,
		continuation && usage.data ? null : usage.data?.operations.remaining,
		usage.data?.operations.reserved,
	);
	const start = useMutation({
		mutationFn: async (accept: boolean) => {
			const notice = processing.notice;
			if (!notice) throw new Error("AI_UNAVAILABLE");
			if (accept) {
				await acceptProcessingNotice(notice);
				setAcceptedNotice(notice);
			}
			if (!accept && !notice.alreadyGranted && acceptedNotice !== notice)
				throw new ORPCError("PRECONDITION_FAILED", { data: { reason: "AI_CONSENT_REQUIRED" } });
			let pending = request;
			if (
				pending &&
				(pending.kind !== kind ||
					pending.route.routeId !== notice.route.routeId ||
					pending.route.routeRevision !== notice.route.routeRevision ||
					pending.route.configRevision !== notice.route.configRevision ||
					pending.consentVersion !== notice.noticeVersion)
			)
				pending = null;
			if (!pending) {
				const prepared = await prepare();
				pending = {
					sources: prepared.sources,
					parameters:
						kind !== "review.translation" && isUiLocale(i18n.locale)
							? { ...prepared.parameters, interfaceLocale: i18n.locale }
							: prepared.parameters,
					requestKey: crypto.randomUUID(),
					kind,
					route: notice.route,
					consentVersion: notice.noticeVersion,
				};
				setRequest(pending);
			}
			const preflight = await client.ai.operations.preflight(pending);
			if (!preflight.available)
				throw new ORPCError("PRECONDITION_FAILED", {
					data: {
						reason: preflight.reason ?? "AI_UNAVAILABLE",
						...("allowance" in preflight ? { allowance: preflight.allowance } : {}),
					},
				});
			return client.ai.operations.start(pending);
		},
		onError: (error) => {
			if (!getAllowanceReason(error) && launchIssue(error)?.key === "review.launch.unexpectedError")
				console.error("AI review launch failed", { kind, error });
			if (getAllowanceReason(error) === "AI_OPERATIONS_LIMIT") void usage.refetch();
		},
		onSuccess: (operation) => {
			setOpen(false);
			processing.reload();
			setRequest(null);
			setAcceptedNotice(null);
			onStarted(operation.id);
			void usage.refetch();
		},
	});
	const lastRetry = useRef(retryRequest);
	const resetStart = start.reset;
	useEffect(() => {
		if (lastRetry.current === retryRequest) return;
		lastRetry.current = retryRequest;
		setRequest(null);
		setAcceptedNotice(null);
		resetStart();
		autoLaunch.current = true;
		setOpen(true);
	}, [retryRequest, resetStart]);

	const submit = (accept: boolean) => {
		if (launching.current || disabled || running || (!continuation && usage.data?.operations.remaining === 0)) return;
		autoLaunch.current = false;
		launching.current = true;
		start.mutate(accept, {
			onSettled: () => {
				launching.current = false;
			},
		});
	};
	const submitAutomatically = useEffectEvent(() => submit(false));
	const notice = processing.notice;
	useEffect(() => {
		if (!open || !notice?.alreadyGranted || !autoLaunch.current) return;
		submitAutomatically();
	}, [open, notice]);
	const close = () => {
		autoLaunch.current = false;
		setAcceptedNotice(null);
		setOpen(false);
		processing.reload();
		setRequest(null);
	};
	const reviewConsent = () => {
		setRequest(null);
		setAcceptedNotice(null);
		autoLaunch.current = true;
		processing.reload();
		start.reset();
	};

	const allowanceReason = getAllowanceReason(start.error);
	const issue = allowanceReason ? null : launchIssue(start.error);
	const exhausted = state === "exhausted" || allowanceReason === "AI_OPERATIONS_LIMIT";
	const startDisabled =
		disabled || start.isPending || (!continuation && usage.data?.operations.remaining === 0) || exhausted;
	if (hideTrigger && !open && !exhausted) return null;
	if (running)
		return (
			<Button id={id} variant={variant} disabled aria-busy="true">
				{children}
			</Button>
		);
	if ((availability.error || usage.error) && !exhausted)
		return (
			<ReviewNotice
				retry={() => {
					void availability.refetch();
					void usage.refetch();
				}}
			>
				<Trans>Could not check assistant availability. Your draft is kept.</Trans>
			</ReviewNotice>
		);
	if (state === "loading") return <QuerySkeleton shape="rows" label={<Trans>Loading assistant availability…</Trans>} />;
	if (state === "not_enabled")
		return (
			<Alert variant="info">
				<Icon name="info" />
				<AlertTitle>{copy("review.assistant.status.disabled")}</AlertTitle>
				<AlertDescription>{copy("review.assistant.disabledHint")}</AlertDescription>
			</Alert>
		);
	if (state === "unavailable")
		return (
			<ReviewNotice
				title={copy("review.assistant.environmentUnavailable")}
				retry={() => {
					void availability.refetch();
					void usage.refetch();
				}}
			>
				{copy("review.assistant.error.unavailableHint")}
			</ReviewNotice>
		);
	if (exhausted && !open)
		return (
			<>
				{!hideTrigger && (
					<Button id={id} variant={variant} disabled>
						{children}
					</Button>
				)}
				<AllowanceLimitNotice
					reason="AI_OPERATIONS_LIMIT"
					error={start.error}
					{...(usage.data ? { usage: usage.data } : {})}
				/>
			</>
		);
	if (state === "busy" && !open)
		return (
			<>
				<Button id={id} variant={variant} disabled>
					{children}
				</Button>
				<AllowanceLimitNotice reason="AI_CONCURRENCY_LIMIT" />
			</>
		);
	const needsConsent = notice && !notice.alreadyGranted && (acceptedNotice !== notice || start.isPending);
	const showDialog = open && Boolean(needsConsent || processing.failed || start.error || exhausted);
	return (
		<>
			{!hideTrigger && (
				<ActionGroup>
					<Button
						id={id}
						variant={variant}
						disabled={startDisabled || open}
						aria-busy={running || (open && !showDialog)}
						onClick={() => {
							start.reset();
							autoLaunch.current = true;
							setOpen(true);
						}}
					>
						{children}
					</Button>
					<ProcessingDetails purpose={kind} />
				</ActionGroup>
			)}
			<Dialog
				open={showDialog}
				onOpenChange={(next) => {
					if (!next && !start.isPending) close();
				}}
			>
				<DialogContent>
					<DialogTitle>
						{needsConsent || processing.failed ? (
							<Trans>Review with the assistant</Trans>
						) : (
							<Trans>Review needs attention</Trans>
						)}
					</DialogTitle>
					{(needsConsent || processing.failed) && <ProcessingNoticeContent {...processing} />}
					{needsConsent && !start.error && <p className="type-body text-ink-2">{copy("privacy.ai.startConsent")}</p>}
					{usage.data?.operations.remaining != null && (
						<p className="type-metadata text-ink-2">
							{copy("billing.usage.remainingOperations", { remaining: usage.data.operations.remaining })}
						</p>
					)}
					{(allowanceReason || exhausted) && (
						<AllowanceLimitNotice
							reason={allowanceReason ?? "AI_OPERATIONS_LIMIT"}
							error={start.error}
							target={
								kind === "review.cover-letter" ? "cover-letter" : kind === "review.extraction" ? "import" : "resume"
							}
							{...(usage.data ? { usage: usage.data } : {})}
							actions={
								allowanceReason === "AI_PROVIDER_CHANGED" ? (
									<Button variant="secondary" onClick={reviewConsent}>
										{copy("review.launch.reviewConsent")}
									</Button>
								) : allowanceReason === "AI_CONCURRENCY_LIMIT" ||
								  allowanceReason === "AI_TARGET_BUSY" ||
								  allowanceReason === "AI_PLATFORM_BUSY" ? (
									<Button variant="secondary" disabled={start.isPending} onClick={() => submit(false)}>
										<Trans>Retry</Trans>
									</Button>
								) : undefined
							}
						/>
					)}
					{issue && (
						<ReviewNotice
							retry={issue.action === "retry" ? () => submit(false) : undefined}
							actions={
								issue.action === "consent" && (
									<Button variant="secondary" onClick={reviewConsent}>
										{copy("review.launch.reviewConsent")}
									</Button>
								)
							}
						>
							{copy(issue.key, "sections" in issue ? { sections: issue.sections.join(", ") } : undefined)}
						</ReviewNotice>
					)}
					<DialogFooter>
						<Button variant="secondary" disabled={start.isPending} onClick={close}>
							{copy("common.actions.cancel")}
						</Button>
						{needsConsent && !issue && !allowanceReason && (
							<Button disabled={startDisabled} onClick={() => submit(true)}>
								<Trans>Start review</Trans>
							</Button>
						)}
					</DialogFooter>
				</DialogContent>
			</Dialog>
		</>
	);
}

type ReviewElapsedProps = { startedAt: string };

function ReviewElapsed({ startedAt }: ReviewElapsedProps) {
	const copy = useAssistantCopy();
	const [now, setNow] = useState(Date.now);
	useEffect(() => {
		const timer = window.setInterval(() => setNow(Date.now()), 1000);
		return () => window.clearInterval(timer);
	}, []);
	const seconds = Math.max(0, Math.floor((now - Date.parse(startedAt)) / 1000));
	if (seconds < 5) return null;
	return (
		<p className="type-metadata" aria-live="off">
			{copy("review.progress.elapsed", { seconds })}
		</p>
	);
}

export function ReviewOperationPanel({
	operationId,
	children,
	kind,
	onRetry,
	progressLabel,
	draftDescription,
}: {
	operationId: string;
	children: ReactNode;
	kind?: ReviewKind;
	onRetry?: () => void;
	progressLabel?: string;
	draftDescription?: string;
}) {
	const copy = useAssistantCopy();
	const draftDescriptionId = useId();
	const status = useReviewOperationStatus(operationId);
	const queryClient = useQueryClient();
	const operationState = status.data?.state;
	const running = !!status.data && isReviewRunning(status.data);
	useEffect(() => {
		if (!running && operationState && ["waiting_review", "succeeded", "failed", "cancelled"].includes(operationState)) {
			void queryClient.invalidateQueries({ queryKey: orpc.ai.usage.get.queryOptions().queryKey });
			if (orpc.ai.review?.list?.key) {
				void queryClient.invalidateQueries({ queryKey: orpc.ai.review.list.key() });
			}
			if (operationState === "succeeded" && orpc.resume?.key) {
				void queryClient.invalidateQueries({ queryKey: orpc.resume.key() });
			}
		}
	}, [operationState, queryClient, running]);
	const [retryKey, setRetryKey] = useState(() => crypto.randomUUID());
	const retryPart = useTranslationRetryConsent(async (notice) => {
		await client.ai.operations.retryTranslation({
			id: operationId,
			requestKey: retryKey,
			scope: "failed_parts",
			execution: { route: notice.route, consentVersion: notice.noticeVersion },
		});
		setRetryKey(crypto.randomUUID());
		void status.refetch();
		void queryClient.invalidateQueries({ queryKey: orpc.ai.usage.get.queryOptions().queryKey });
	});
	const cancel = useMutation({
		mutationFn: () => client.ai.operations.cancel({ id: operationId }),
		onSuccess: () => {
			void status.refetch();
		},
	});
	const retryAllowance = getAllowanceReason(retryPart.error);
	const retryIssue = retryAllowance || !(retryPart.error instanceof Error) ? null : launchIssue(retryPart.error);
	const failureAllowance = getAllowanceReason({ data: { reason: status.data?.failureCode } });
	if (status.error)
		return (
			<ReviewNotice
				retry={() => {
					void status.refetch();
				}}
			>
				<Trans>Could not reload this review. Your draft is kept.</Trans>
			</ReviewNotice>
		);
	if (!status.data) return <QuerySkeleton shape="rows" label={<Trans>Loading review…</Trans>} />;
	if (!running && status.data.resultId) return children;
	if (
		(!running || status.data.state === "failed") &&
		status.data.retryable &&
		status.data.progress?.part &&
		status.data.progress.total
	)
		return (
			<ReviewNotice
				actions={
					<Button variant="secondary" disabled={retryPart.pending} onClick={() => retryPart.open()}>
						{copy("review.translation.retryFailedParts")}
					</Button>
				}
			>
				<p>
					{copy("review.translation.failedParts", {
						count: status.data.progress.failedParts ?? 1,
					})}
				</p>
				{status.data.progress.failedPartDetails?.length
					? status.data.progress.failedPartDetails.map((part) => (
							<TranslationPartFailure key={part.part} part={part.part} code={part.failureCode} />
						))
					: status.data.failureCode && <ReviewFailureReason code={status.data.failureCode} />}
				{retryPart.dialog}
				{retryIssue && <p>{copy(retryIssue.key)}</p>}
				{retryAllowance && <AllowanceLimitNotice error={retryPart.error} />}
				{failureAllowance && <AllowanceLimitNotice reason={failureAllowance} />}
			</ReviewNotice>
		);
	if (status.data.state === "failed" || status.data.state === "cancelled") {
		const unavailable = status.data.failureCode === "AI_PROVIDER_UNAVAILABLE";
		return (
			<ReviewNotice retry={unavailable ? undefined : onRetry}>
				{status.data.failureCode === "AI_INPUT_LIMIT" ? (
					copy("review.launch.inputTooLarge")
				) : status.data.failureCode === "AI_QUEUE_EXPIRED" && !onRetry ? (
					copy("review.progress.queueExpired")
				) : (
					<ReviewFailureReason code={status.data.failureCode} />
				)}
				{kind === "review.translation" && status.data.charged && !unavailable && (
					<p>{copy("review.translation.startChargedFailure")}</p>
				)}
				{status.data.failureCode === "AI_QUEUE_EXPIRED" && !status.data.charged && (
					<p>{copy("review.progress.queueNoCharge")}</p>
				)}
			</ReviewNotice>
		);
	}
	const progress = status.data.progress;
	const step =
		status.data.state === "cancel_requested"
			? "cancelling"
			: (progress?.step ?? (status.data.state === "queued" ? "queued" : null));
	const waiting = step === "queued";
	const queuePosition = status.data.queuePosition;
	const total = progress?.total;
	const completed = progress?.completedParts ?? 0;
	const parts = total === undefined ? null : copy("review.progress.completedParts", { completed, total });
	return (
		<Alert data-slot="review-progress" aria-describedby={draftDescriptionId}>
			<span id={draftDescriptionId} className={draftDescription ? "type-metadata" : "sr-only"}>
				{draftDescription ?? <Trans>Your draft is kept while the assistant works.</Trans>}
			</span>
			<div className="flex flex-wrap items-center justify-between gap-2">
				<div className="min-w-0">
					<p role="status" className="type-label">
						{step === "drafting" && progressLabel ? (
							progressLabel
						) : step ? (
							copy(`review.progress.${step}`)
						) : (
							<Trans>Review in progress</Trans>
						)}
						{waiting && queuePosition !== undefined && (
							<span className="block">{copy("review.progress.queuePosition", { position: queuePosition })}</span>
						)}
					</p>
					{progress && !waiting && <ReviewElapsed key={progress.startedAt} startedAt={progress.startedAt} />}
				</div>
				<Button
					variant="quiet"
					disabled={cancel.isPending || status.data.state === "cancel_requested"}
					onClick={() => cancel.mutate()}
				>
					<Trans>Cancel</Trans>
				</Button>
			</div>
			{total !== undefined && parts && (
				<div className="grid gap-1">
					<Progress max={total} value={completed} aria-label={parts} aria-describedby={draftDescriptionId} />
					<p className="type-metadata">{parts}</p>
				</div>
			)}
			{total === undefined && progressLabel && (
				<Progress aria-label={progressLabel} aria-describedby={draftDescriptionId} />
			)}
			{cancel.error && (
				<ReviewNotice retry={() => cancel.mutate()}>
					<Trans>Cancellation could not be confirmed.</Trans>
				</ReviewNotice>
			)}
		</Alert>
	);
}

export function isReviewRunning(operation: OperationView): boolean {
	return (
		["queued", "running", "cancel_requested"].includes(operation.state) ||
		(operation.progress?.activeParts ?? 0) > 0 ||
		(operation.progress?.pendingRetryParts ?? 0) > 0
	);
}

export function useReviewOperationStatus(operationId: string | null) {
	return useQuery({
		...orpc.ai.operations.get.queryOptions({ input: { id: operationId ?? "" } }),
		enabled: operationId !== null,
		refetchInterval: ({ state }) => (state.data && isReviewRunning(state.data) ? 1000 : false),
	});
}
