import type { ApprovedRoute } from "./route-policy";

// OpenRouter takes USD per million tokens, which also equals microdollars per token.
const togetherPrice = { prompt: 0.3, completion: 1.2, request: 0 } as const;

export function togetherVerifierPrice(route: ApprovedRoute) {
	if (
		route.boundByTogetherPricing &&
		route.endpoint === "https://openrouter.ai/api/v1" &&
		route.model === "deepseek/deepseek-v4.1-flash-1017" &&
		route.downstreamProvider === "together" &&
		!route.providerEndpoint
	)
		return togetherPrice;
}

/** Budget for uncached input plus chat framing and the full, enforced completion allowance. */
export function togetherVerifierCallBound(promptBytes: number, maxOutputTokens: number): number {
	// The byte tokenizer uses at most one token per UTF-8 byte. Allow extra tokens for provider framing.
	return Math.ceil((promptBytes + 4096) * togetherPrice.prompt + maxOutputTokens * togetherPrice.completion);
}

/** Fit the ordered prefix before reserving any requests in the wave. */
export function fitVerificationWave(
	reservedMicros: number,
	incurredMicros: number,
	bounds: readonly number[],
	concurrency: number,
): number {
	let remaining = reservedMicros - incurredMicros;
	let count = 0;
	for (const bound of bounds) {
		if (count >= concurrency || !Number.isSafeInteger(bound) || bound <= 0 || bound > remaining) break;
		remaining -= bound;
		count++;
	}
	return count;
}
