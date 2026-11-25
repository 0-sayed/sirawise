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
			([notice]) => {
				if (active) setResult(notice?.purpose === purpose && notice.locale === locale ? { key, notice } : { key });
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

export function ProcessingNoticeContent({ notice, failed, reload }: ReturnType<typeof useProcessingNotice>) {
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
	return (
		<DialogDescription lang={notice?.locale} dir={notice?.locale === "ar-SA" ? "rtl" : "ltr"}>
			{notice?.content ?? copy("review.launch.loadingConsent")}
		</DialogDescription>
	);
}

export function useTranslationRetryConsent(
	retry: (notice: ProcessingNotice, partIndex?: number) => Promise<unknown>,
	disabled = false,
	partLabel?: string,
) {
	const copy = useAssistantCopy();
	const [target, setTarget] = useState<{ partIndex: number | undefined } | null>(null);
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
			else await retry(notice, target.partIndex);
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
		open: (partIndex?: number) => {
			if (open || disabled) return;
			setError(null);
			setNeedsReview(false);
			autoSubmit.current = true;
			setTarget({ partIndex });
		},
		pending,
		error,
		dialog: (
			<Dialog
				open={open}
				onOpenChange={(next) => {
					if (!next && !pending) close();
				}}
			>
				<DialogContent>
					<DialogTitle>{copy("review.launch.reviewConsent")}</DialogTitle>
					<ProcessingNoticeContent {...processing} />
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
							{target?.partIndex === undefined ? copy("review.translation.retryFailedParts") : partLabel}
						</Button>
					</DialogFooter>
				</DialogContent>
			</Dialog>
		),
	};
}
