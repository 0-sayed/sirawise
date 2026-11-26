import { expect, it } from "vite-plus/test";
import {
	canRetryPreResponseTransient,
	computePreResponseRetryDelayMs,
	PRE_RESPONSE_TRANSIENT_DELAY_MAX_MS,
	PRE_RESPONSE_TRANSIENT_DELAY_MIN_MS,
	PRE_RESPONSE_TRANSIENT_MIN_DEADLINE_MS,
	transportFailureDetail,
} from "./operation-worker";

const basePreResponseOutcome = {
	outcome: "transient" as const,
	responseId: null,
	inputTokens: null,
	outputTokens: null,
	cachedTokens: null,
	costMicros: null,
	failure: {
		errorClass: "TypeError",
		httpStatus: null,
		message: "fetch failed",
		bytesReceived: false,
		generationId: null,
		timedOut: false,
	},
};

it("allows exactly one retry for a pre-response transient transport error with remaining deadline and reservation", () => {
	const now = 100_000;
	expect(
		canRetryPreResponseTransient({
			outcome: basePreResponseOutcome,
			stepId: "generate",
			alreadyRetried: false,
			nowMs: now,
			deadlineAtMs: now + 30_000,
			consumedMicros: 100_000,
			maxCallCostMicros: 100_000,
			reservedMicros: 200_000,
		}),
	).toBe(true);

	// Second pre-response transient -> no retry (stops with AI_OUTCOME_UNKNOWN)
	expect(
		canRetryPreResponseTransient({
			outcome: basePreResponseOutcome,
			stepId: "generate",
			alreadyRetried: true,
			nowMs: now,
			deadlineAtMs: now + 30_000,
			consumedMicros: 100_000,
			maxCallCostMicros: 100_000,
			reservedMicros: 200_000,
		}),
	).toBe(false);
});

it("refuses pre-response retry when HTTP status, usage, responseId, timeout, or bytesReceived are present", () => {
	const now = 100_000;
	const baseArgs = {
		stepId: "generate",
		alreadyRetried: false,
		nowMs: now,
		deadlineAtMs: now + 30_000,
		consumedMicros: 100_000,
		maxCallCostMicros: 100_000,
		reservedMicros: 200_000,
	};

	expect(
		canRetryPreResponseTransient({
			...baseArgs,
			outcome: { ...basePreResponseOutcome, failure: { ...basePreResponseOutcome.failure, httpStatus: 503 } },
		}),
	).toBe(false);

	expect(
		canRetryPreResponseTransient({
			...baseArgs,
			outcome: { ...basePreResponseOutcome, inputTokens: 120 },
		}),
	).toBe(false);

	expect(
		canRetryPreResponseTransient({
			...baseArgs,
			outcome: { ...basePreResponseOutcome, responseId: "resp_123" },
		}),
	).toBe(false);

	expect(
		canRetryPreResponseTransient({
			...baseArgs,
			outcome: { ...basePreResponseOutcome, failure: { ...basePreResponseOutcome.failure, timedOut: true } },
		}),
	).toBe(false);

	expect(
		canRetryPreResponseTransient({
			...baseArgs,
			outcome: { ...basePreResponseOutcome, failure: { ...basePreResponseOutcome.failure, bytesReceived: true } },
		}),
	).toBe(false);
});

it("refuses pre-response retry when deadline is nearly spent or reservation is exhausted", () => {
	const now = 100_000;
	expect(
		canRetryPreResponseTransient({
			outcome: basePreResponseOutcome,
			stepId: "generate",
			alreadyRetried: false,
			nowMs: now,
			deadlineAtMs: now + PRE_RESPONSE_TRANSIENT_MIN_DEADLINE_MS - 100,
			consumedMicros: 100_000,
			maxCallCostMicros: 100_000,
			reservedMicros: 200_000,
		}),
	).toBe(false);

	expect(
		canRetryPreResponseTransient({
			outcome: basePreResponseOutcome,
			stepId: "generate",
			alreadyRetried: false,
			nowMs: now,
			deadlineAtMs: now + 30_000,
			consumedMicros: 150_000,
			maxCallCostMicros: 100_000,
			reservedMicros: 200_000,
		}),
	).toBe(false);
});

it.each(["call_timeout", "operation_deadline", "cancelled"] as const)(
	"does not consume the pre-response retry slot on %s",
	(abortCause) => {
		expect(
			canRetryPreResponseTransient({
				outcome: { ...basePreResponseOutcome, failure: { ...basePreResponseOutcome.failure, abortCause } },
				stepId: "verify",
				alreadyRetried: false,
				nowMs: 1,
				deadlineAtMs: 30_000,
				consumedMicros: 10_000,
				maxCallCostMicros: 100_000,
				reservedMicros: 200_000,
			}),
		).toBe(false);
	},
);

it("computes a jittered 1-3s delay before the single pre-response retry while respecting the deadline buffer", () => {
	const now = 100_000;
	expect(PRE_RESPONSE_TRANSIENT_DELAY_MIN_MS).toBeGreaterThanOrEqual(1000);
	expect(PRE_RESPONSE_TRANSIENT_DELAY_MAX_MS).toBeGreaterThan(PRE_RESPONSE_TRANSIENT_DELAY_MIN_MS);

	expect(computePreResponseRetryDelayMs(now, now + 30_000, () => 0)).toBe(PRE_RESPONSE_TRANSIENT_DELAY_MIN_MS);
	expect(computePreResponseRetryDelayMs(now, now + 30_000, () => 0.5)).toBe(
		Math.floor((PRE_RESPONSE_TRANSIENT_DELAY_MIN_MS + PRE_RESPONSE_TRANSIENT_DELAY_MAX_MS) / 2),
	);
	expect(computePreResponseRetryDelayMs(now, now + 30_000, () => 1)).toBe(PRE_RESPONSE_TRANSIENT_DELAY_MAX_MS);

	// Tight deadline: never eat into PRE_RESPONSE_TRANSIENT_MIN_DEADLINE_MS
	expect(computePreResponseRetryDelayMs(now, now + PRE_RESPONSE_TRANSIENT_MIN_DEADLINE_MS + 400, () => 1)).toBe(400);
	expect(computePreResponseRetryDelayMs(now, now + PRE_RESPONSE_TRANSIENT_MIN_DEADLINE_MS, () => 1)).toBe(0);
});

it("builds sanitized transport failure detail with cause code and requestSent for AI_OUTCOME_UNKNOWN", () => {
	expect(transportFailureDetail(undefined)).toBeUndefined();
	expect(
		transportFailureDetail({
			errorClass: "TypeError",
			message: "fetch failed",
			httpStatus: null,
			bytesReceived: false,
			generationId: null,
			requestSent: true,
			causes: [{ errorClass: "Error", code: "ECONNRESET", message: "socket hang up" }],
		}),
	).toEqual({
		errorClass: "TypeError",
		message: "fetch failed",
		causeCode: "ECONNRESET",
		httpStatus: null,
		bytesReceived: false,
		requestSent: true,
		causes: [{ errorClass: "Error", code: "ECONNRESET", message: "socket hang up" }],
	});
});
