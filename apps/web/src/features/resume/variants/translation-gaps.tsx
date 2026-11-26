import { useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Alert, AlertActions, AlertDescription, AlertTitle } from "@reactive-resume/ui/components/alert";
import { Badge } from "@reactive-resume/ui/components/badge";
import { Button } from "@reactive-resume/ui/components/button";
import { Disclosure, DisclosureContent, DisclosureSummary } from "@reactive-resume/ui/components/disclosure";
import { Icon } from "@reactive-resume/ui/components/icon";
import { useTranslationRetryConsent } from "../editor/proposals/processing-consent";
import { isReviewRunning } from "../editor/proposals/review-operation";
import { useVariantsCopy } from "./copy.generated";
import { client, orpc } from "@/libs/orpc/client";

export type TranslationGap = {
	id: string;
	text: string;
	partIndex?: number | undefined;
	reason?: string | undefined;
	section?: string | undefined;
};

export const isTranslationFactGap = (reason?: string) => reason?.startsWith("TRANSLATION_FACT_") ?? false;

export function useTranslationGapRetry(operationId: string, stale?: boolean) {
	const copy = useVariantsCopy();
	const cache = useQueryClient();
	const [retryKey, setRetryKey] = useState(() => crypto.randomUUID());
	return useTranslationRetryConsent(
		async (notice, partIndex, segmentId) => {
			await client.ai.operations.retryTranslation({
				id: operationId,
				requestKey: retryKey,
				...(partIndex === undefined ? { scope: "failed_parts" } : { partIndex }),
				...(segmentId === undefined ? {} : { segmentId }),
				execution: { route: notice.route, consentVersion: notice.noticeVersion },
			});
			setRetryKey(crypto.randomUUID());
			const statusQuery = orpc.ai.operations.get.queryOptions({ input: { id: operationId } });
			const reviewKey = orpc.ai.variantReview.get.queryOptions({ input: { operationId } }).queryKey;
			await cache.invalidateQueries({ queryKey: reviewKey, refetchType: "none" });
			await cache.invalidateQueries({ queryKey: statusQuery.queryKey });
			const status = cache.getQueryData(statusQuery.queryKey);
			await Promise.all([
				!status || !isReviewRunning(status) ? cache.invalidateQueries({ queryKey: reviewKey }) : undefined,
				cache.invalidateQueries({ queryKey: orpc.resume.key() }),
			]);
		},
		stale,
		copy("review.translation.retryThisPart"),
		copy("review.translation.retryThisSegment"),
	);
}

export function UntranslatedBadge() {
	const copy = useVariantsCopy();
	return <Badge variant="warn">{copy("review.translation.notTranslated")}</Badge>;
}

export function TranslationGapReason({ reason }: { reason?: string | undefined }) {
	const copy = useVariantsCopy();
	const [rule, ...valueParts] = reason?.split(":") ?? [];
	const value = valueParts.join(":");
	const message =
		rule === "TRANSLATION_FACT_NUMBER" && value
			? copy("review.translation.factNumberValue", { value })
			: rule === "TRANSLATION_FACT_NUMBER"
				? copy("review.translation.factNumber")
				: rule === "TRANSLATION_FACT_DATE" || rule === "TRANSLATION_FACT_CALENDAR"
					? copy("review.translation.factDate")
					: rule === "TRANSLATION_FACT_NAME"
						? copy("review.translation.factName")
						: rule === "TRANSLATION_FACT_ORGANIZATION"
							? copy("review.translation.factOrganization")
							: rule === "TRANSLATION_FACT_CONTACT"
								? copy("review.translation.factContact")
								: rule === "TRANSLATION_FACT_TERM"
									? value
										? copy("review.translation.factTermValue", { value })
										: copy("review.translation.factTerm")
									: rule === "TRANSLATION_FACT_LANGUAGE"
										? copy("review.translation.factLanguage")
										: rule === "TRANSLATION_FACT_MISSING"
											? copy("review.translation.factMissing")
											: rule === "TRANSLATION_FACT_NEGATION"
												? copy("review.translation.factNegation")
												: reason
													? copy("review.withheldReason.default")
													: null;
	return message && <span className="type-metadata text-ink-2">{message}</span>;
}

export function TranslationPartRetry({
	partIndex,
	segmentId,
	retry,
	disabled,
}: {
	partIndex: number;
	segmentId?: string | undefined;
	retry: (partIndex: number, segmentId?: string) => void;
	disabled?: boolean | undefined;
}) {
	const copy = useVariantsCopy();
	return (
		<Button variant="secondary" size="row" disabled={disabled} onClick={() => retry(partIndex, segmentId)}>
			{copy(segmentId ? "review.translation.retryThisSegment" : "review.translation.retryThisPart")}
		</Button>
	);
}

export function TranslationGaps({
	gaps,
	retry,
	disabled,
}: {
	gaps: TranslationGap[];
	retry: (partIndex?: number, segmentId?: string) => void;
	disabled?: boolean | undefined;
}) {
	const copy = useVariantsCopy();
	if (gaps.length === 0) return null;
	return (
		<Alert variant="warn">
			<Icon name="warning" />
			<AlertTitle>{copy("review.translation.gapsTitle", { count: gaps.length })}</AlertTitle>
			<AlertDescription>{copy("review.translation.gapsBody")}</AlertDescription>
			<AlertActions>
				<Button variant="secondary" size="row" disabled={disabled} onClick={() => retry()}>
					{copy("review.translation.retryUntranslated")}
				</Button>
			</AlertActions>
			<div className="col-span-full min-w-0">
				<Disclosure>
					<DisclosureSummary>{copy("review.translation.gapDetails", { count: gaps.length })}</DisclosureSummary>
					<DisclosureContent>
						<ul className="divide-y divide-line">
							{gaps.map(({ id, section, text, partIndex, reason }) => (
								<li key={id} className="flex min-w-0 flex-col gap-2 py-2 sm:flex-row sm:items-center">
									<div className="grid min-w-0 flex-1 gap-1">
										{(section || partIndex !== undefined) && (
											<span className="type-label" dir="auto">
												{section ?? copy("review.translation.partLabel", { part: (partIndex ?? 0) + 1 })}
											</span>
										)}
										{section && partIndex !== undefined && !isTranslationFactGap(reason) && (
											<span className="type-metadata">
												{copy("review.translation.partLabel", { part: partIndex + 1 })}
											</span>
										)}
										<bdi className="block truncate">{text}</bdi>
										<TranslationGapReason reason={reason} />
									</div>
									{partIndex !== undefined && (
										<div className="self-end sm:self-auto">
											<TranslationPartRetry
												partIndex={partIndex}
												segmentId={isTranslationFactGap(reason) ? id : undefined}
												retry={retry}
												disabled={disabled}
											/>
										</div>
									)}
								</li>
							))}
						</ul>
					</DisclosureContent>
				</Disclosure>
			</div>
		</Alert>
	);
}
