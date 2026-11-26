import { Trans } from "@lingui/react/macro";

export function TranslationPartFailure({ part, code }: { part: number; code?: string | null | undefined }) {
	return (
		<p>
			<Trans context="review.translation.partFailure">Part {part}:</Trans>{" "}
			{code === "AI_TIMEOUT" || code === "AI_DEADLINE" ? (
				<Trans context="review.translation.partTimeout">The assistant ran out of time for this part.</Trans>
			) : code === "AI_CALL_LIMIT" ? (
				<Trans context="review.translation.partCallLimit">This part needed more retry steps than allowed.</Trans>
			) : code === "AI_VERIFICATION_INCOMPLETE" ? (
				<ReviewFailureReason code={code} />
			) : code?.startsWith("AI_VERIFICATION") || code === "AI_REVIEW_INVALID" ? (
				<Trans context="review.translation.partSafety">
					This segment did not pass the translation checks. The original text is kept.
				</Trans>
			) : (
				<ReviewFailureReason code={code} />
			)}
		</p>
	);
}

export function ReviewFailureReason({ code }: { code: string | null | undefined }) {
	if (code === "AI_QUEUE_EXPIRED")
		return (
			<Trans context="review.failure.queueExpired">
				This request expired while waiting to start. Your draft is kept. Retry to put it back in the queue.
			</Trans>
		);
	if (code === "AI_CALL_LIMIT")
		return <Trans context="review.translation.partCallLimit">This part needed more retry steps than allowed.</Trans>;
	if (code === "AI_VERIFICATION_INCOMPLETE")
		return (
			<Trans context="review.failure.checkerIncomplete">
				The checker did not answer every item after two attempts. Nothing was applied. Try the review again.
			</Trans>
		);
	if (code === "AI_TIMEOUT" || code === "AI_DEADLINE")
		return (
			<Trans context="review.failure.timeout">
				The assistant ran out of time. Your draft is kept. Retry to start a new review.
			</Trans>
		);
	if (code === "AI_PROVIDER_UNAVAILABLE")
		return (
			<Trans context="review.failure.providerUnavailable">
				The AI service is unavailable right now. Your draft is kept.
			</Trans>
		);
	if (
		code === "AI_PROVIDER_ERROR" ||
		code === "AI_VERIFIER_UNAVAILABLE" ||
		code === "AI_TRANSIENT" ||
		code === "AI_OUTCOME_UNKNOWN"
	)
		return (
			<Trans context="review.failure.provider">
				The AI service did not finish this review. Your draft is kept. Retry can help after a temporary service failure.
			</Trans>
		);
	if (code === "AI_VERIFICATION_FAILED" || code === "AI_REVIEW_INVALID")
		return (
			<Trans context="review.failure.safety">
				The response did not pass the factual safety checks. Nothing was applied. Retry can produce a different
				response.
			</Trans>
		);
	if (code === "AI_INPUT_LIMIT")
		return (
			<Trans context="review.failure.inputLimit">
				This request is too large. Select fewer facts or a shorter passage, then start a new review.
			</Trans>
		);
	if (code === "AI_SOURCE_CHANGED" || code === "AI_STALE_SOURCE" || code === "AI_HANDLER_CHANGED")
		return (
			<Trans context="review.failure.changed">
				The saved source or review settings changed. Retry to prepare a fresh request from the current draft.
			</Trans>
		);
	if (code === "AI_REQUEST_COST_LIMIT")
		return (
			<Trans context="review.failure.budget">
				This review reached its processing budget. Use a shorter passage or fewer selected facts before starting again.
			</Trans>
		);
	return (
		<Trans context="review.failure.unknown">
			No review was delivered. Your draft is kept. Retry to review the current draft again, or keep editing manually.
		</Trans>
	);
}
