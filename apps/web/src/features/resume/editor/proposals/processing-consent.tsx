import { useLingui } from "@lingui/react";
import { Trans } from "@lingui/react/macro";
import { ORPCError } from "@orpc/client";
import { useEffect, useEffectEvent, useRef, useState } from "react";
import { Alert, AlertActions, AlertDescription, AlertTitle } from "@reactive-resume/ui/components/alert";
import { Button } from "@reactive-resume/ui/components/button";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogTitle,
} from "@reactive-resume/ui/components/dialog";
import { Icon } from "@reactive-resume/ui/components/icon";
import { IconButton } from "@reactive-resume/ui/components/icon-button";
import { Popover, PopoverContent, PopoverTitle, PopoverTrigger } from "@reactive-resume/ui/components/popover";
import { useAssistantCopy } from "@/features/assistant/copy.generated";
import { client } from "@/libs/orpc/client";

export type ProcessingNotice = Awaited<ReturnType<typeof client.ai.processing.notices>>[number];

function needsProcessingConsent(error: unknown) {
	return (
		error instanceof ORPCError &&
		["AI_CONSENT_REQUIRED", "AI_CONSENT_NOTICE_CHANGED", "AI_PROVIDER_CHANGED"].includes(error.data?.reason)
	);
}

export async function acceptProcessingNotice(notice: ProcessingNotice) {
	if (notice.alreadyGranted) return;
	const { content: _content, alreadyGranted: _alreadyGranted, ...acceptance } = notice;
	await client.ai.processing.grant(acceptance);
}

export function useProcessingNotice(open: boolean, purpose: string) {
	const { i18n } = useLingui();
	const locale = i18n.locale === "ar-SA" ? "ar-SA" : "en-US";
	const [revision, setRevision] = useState(0);
	const [result, setResult] = useState<{ key: string; notice?: ProcessingNotice } | null>(null);
	const key = `${purpose}:${locale}:${revision}`;
	const current = open && result?.key === key ? result : null;
	useEffect(() => {
		if (!open) return;
		let active = true;
		void client.ai.processing.notices({ purpose, locale }).then(
			(notices) => {
				const matching = notices.filter((notice) => notice.purpose === purpose && notice.locale === locale);
				const notice = matching.find((notice) => notice.alreadyGranted) ?? matching[0];
				if (active) setResult(notice ? { key, notice } : { key });
			},
			() => {
				if (active) setResult({ key });
			},
		);
		return () => {
			active = false;
		};
	}, [key, open, purpose, locale]);
	return {
		notice: current?.notice,
		failed: current !== null && !current.notice,
		reload: () => setRevision((value) => value + 1),
	};
}

export function ProcessingNoticeContent({
	notice,
	failed,
	reload,
	description = true,
}: ReturnType<typeof useProcessingNotice> & { description?: boolean }) {
	const copy = useAssistantCopy();
	if (failed)
		return (
			<Alert variant="warn">
				<Icon name="warning-circle" />
				<AlertTitle>{copy("review.assistant.environmentUnavailable")}</AlertTitle>
				<AlertDescription>{copy("review.assistant.error.unavailableHint")}</AlertDescription>
				<AlertActions>
					<Button variant="secondary" onClick={reload}>
						<Trans>Retry</Trans>
					</Button>
				</AlertActions>
			</Alert>
		);
	const Text = description ? DialogDescription : "p";
	return (
		<Text lang={notice?.locale} dir={notice?.locale === "ar-SA" ? "rtl" : "ltr"}>
			{notice?.content ?? copy("review.launch.loadingConsent")}
		</Text>
	);
}

export function ProcessingDetails({ purpose }: { purpose: string }) {
	const copy = useAssistantCopy();
	const [open, setOpen] = useState(false);
	const processing = useProcessingNotice(open, purpose);
	return (
		<Popover open={open} onOpenChange={setOpen}>
			<PopoverTrigger
				render={<IconButton icon="info" variant="quiet" size="icon-sm" label={copy("privacy.ai.details")} />}
			/>
			<PopoverContent align="start">
				<PopoverTitle>{copy("privacy.ai.title")}</PopoverTitle>
				<ProcessingNoticeContent {...processing} description={false} />
			</PopoverContent>
		</Popover>
	);
}

export function useTranslationRetryConsent(
	retry: (notice: ProcessingNotice, partIndex?: number, segmentId?: string) => Promise<unknown>,
	disabled = false,
	partLabel?: string,
	segmentLabel?: string,
) {
	const copy = useAssistantCopy();
	const [target, setTarget] = useState<{ partIndex?: number | undefined; segmentId?: string | undefined } | null>(null);
	const open = target !== null;
	const [pending, setPending] = useState(false);
	const [error, setError] = useState<unknown>(null);
	const [needsReview, setNeedsReview] = useState(false);
	const submitting = useRef(false);
	const processing = useProcessingNotice(open, "review.translation");
	const autoSubmit = useRef(false);
	const close = () => {
		setTarget(null);
		processing.reload();
	};
	const submit = async (notice: ProcessingNotice) => {
		if (submitting.current || disabled) return;
		submitting.current = true;
		setPending(true);
		setError(null);
		autoSubmit.current = false;
		try {
			await acceptProcessingNotice(notice);
			if (target?.partIndex === undefined) await retry(notice);
			else await retry(notice, target.partIndex, target.segmentId);
			close();
		} catch (error) {
			setError(error);
			if (needsProcessingConsent(error)) setNeedsReview(true);
		} finally {
			setPending(false);
			submitting.current = false;
		}
	};
	const notice = processing.notice;
	const submitAutomatically = useEffectEvent(submit);
	useEffect(() => {
		if (!open || !autoSubmit.current) return;
		if (processing.failed || (notice && !notice.alreadyGranted)) autoSubmit.current = false;
		if (!notice?.alreadyGranted) return;
		let active = true;
		void Promise.resolve().then(() => {
			if (active) void submitAutomatically(notice);
		});
		return () => {
			active = false;
		};
	}, [open, notice, processing.failed]);
	return {
		open: (partIndex?: number, segmentId?: string) => {
			if (open || disabled) return;
			setError(null);
			setNeedsReview(false);
			autoSubmit.current = true;
			setTarget({ partIndex, segmentId });
		},
		pending: pending || (open && !notice && !processing.failed),
		error,
		dialog: (
			<Dialog
				open={open && Boolean(processing.failed || (notice && !notice.alreadyGranted) || error)}
				onOpenChange={(next) => {
					if (!next && !pending) close();
				}}
			>
				<DialogContent>
					<DialogTitle>{copy("review.launch.reviewConsent")}</DialogTitle>
					<ProcessingNoticeContent {...processing} />
					{notice && !notice.alreadyGranted && !error && (
						<p className="type-body text-ink-2">{copy("privacy.ai.retryConsent")}</p>
					)}
					{needsReview && (
						<Alert variant="warn">
							<Icon name="warning-circle" />
							<AlertTitle>{copy("review.launch.reviewConsent")}</AlertTitle>
							<AlertDescription>{copy("review.launch.consentRequired")}</AlertDescription>
							<AlertActions>
								<Button
									variant="secondary"
									onClick={() => {
										setNeedsReview(false);
										setError(null);
										processing.reload();
									}}
								>
									{copy("review.launch.reviewConsent")}
								</Button>
							</AlertActions>
						</Alert>
					)}
					{Boolean(error) && !needsReview && (
						<Alert variant="warn">
							<Icon name="warning-circle" />
							<AlertTitle>{copy("review.assistant.error.unavailableTitle")}</AlertTitle>
							<AlertDescription>{copy("review.assistant.error.unavailableHint")}</AlertDescription>
						</Alert>
					)}
					<DialogFooter>
						<Button variant="secondary" disabled={pending} onClick={close}>
							{copy("common.actions.cancel")}
						</Button>
						<Button
							disabled={disabled || pending || needsReview || !notice}
							onClick={() => {
								if (notice) void submit(notice);
							}}
						>
							{target?.partIndex === undefined
								? copy("review.translation.retryFailedParts")
								: target.segmentId
									? segmentLabel
									: partLabel}
						</Button>
					</DialogFooter>
				</DialogContent>
			</Dialog>
		),
	};
}
