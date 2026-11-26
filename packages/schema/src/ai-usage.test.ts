import { expect, it } from "vite-plus/test";
import { allowanceFailureSchema, startUsageViewSchema, resumeCreationKindSchema } from "./ai-usage";

it("preserves once-only Start limits and consistent available operations", () => {
	const usage = {
		plan: "start",
		operations: { limit: 5, used: 3, reserved: 1, remaining: 1 },
		baseCvs: { limit: 1, used: 2 },
	};
	expect(startUsageViewSchema.parse(usage)).toEqual(usage);
	expect(
		startUsageViewSchema.safeParse({ ...usage, operations: { limit: 5, used: 3, reserved: 1, remaining: 0 } }).success,
	).toBe(false);
	expect(resumeCreationKindSchema.safeParse({ variantKind: "language" }).success).toBe(false);
	expect(resumeCreationKindSchema.parse({ variantKind: "job", baseResumeId: "root" })).toEqual({
		variantKind: "job",
		baseResumeId: "root",
	});
});

it("returns an exhausted balance after administrator privileges are removed", () => {
	expect(
		startUsageViewSchema.parse({
			plan: "start",
			operations: { limit: 5, used: 6, reserved: 0, remaining: 0 },
			baseCvs: { limit: 1, used: 2 },
		}).operations.remaining,
	).toBe(0);
});

it("validates the scoped local allowance without accepting inconsistent balances", () => {
	const usage = {
		plan: "start",
		operations: { limit: 50, used: 5, reserved: 1, remaining: 44 },
		baseCvs: { limit: 1, used: 1 },
	};
	expect(startUsageViewSchema.parse(usage)).toEqual(usage);
	expect(startUsageViewSchema.safeParse({ ...usage, operations: { ...usage.operations, remaining: 45 } }).success).toBe(
		false,
	);
});

it("accepts only known allowance reasons and consistent public balances", () => {
	for (const reason of [
		"AI_OPERATIONS_LIMIT",
		"BASE_CV_LIMIT",
		"LANGUAGE_COPY_LIMIT",
		"JOB_COPY_LIMIT",
		"AI_CONCURRENCY_LIMIT",
		"AI_TARGET_BUSY",
		"AI_PROVIDER_CHANGED",
		"AI_BUDGET_LIMIT",
	])
		expect(allowanceFailureSchema.parse({ reason })).toEqual({ reason });
	const failure = {
		reason: "AI_OPERATIONS_LIMIT",
		allowance: { limit: 5, used: 4, reserved: 1, remaining: 0 },
	};
	expect(allowanceFailureSchema.parse(failure)).toEqual(failure);
	for (const invalid of [
		{ reason: "UNKNOWN_LIMIT" },
		{ ...failure, allowance: { ...failure.allowance, remaining: 1 } },
		{ ...failure, allowance: { ...failure.allowance, resetAt: "tomorrow" } },
		{ reason: "AI_BUDGET_LIMIT", spentMicros: 10000 },
	])
		expect(allowanceFailureSchema.safeParse(invalid).success).toBe(false);
});
