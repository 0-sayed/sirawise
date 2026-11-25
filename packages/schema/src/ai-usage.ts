import { z } from "zod";

const count = z.number().int().nonnegative();
export const allowanceReasonSchema = z.enum([
	"AI_OPERATIONS_LIMIT",
	"BASE_CV_LIMIT",
	"LANGUAGE_COPY_LIMIT",
	"JOB_COPY_LIMIT",
	"AI_CONCURRENCY_LIMIT",
	"AI_TARGET_BUSY",
	"AI_PLATFORM_BUSY",
	"AI_PROVIDER_CHANGED",
	"AI_BUDGET_LIMIT",
]);
export type AllowanceReason = z.infer<typeof allowanceReasonSchema>;
export const allowanceBalanceSchema = z
	.strictObject({ limit: count.nullable(), used: count, reserved: count, remaining: count.nullable() })
	.refine((v) =>
		v.limit === null ? v.remaining === null : v.remaining === Math.max(0, v.limit - v.used - v.reserved),
	);
export type AllowanceBalance = z.infer<typeof allowanceBalanceSchema>;
export const allowanceFailureSchema = z.strictObject({
	reason: allowanceReasonSchema,
	allowance: allowanceBalanceSchema.optional(),
});
export type AllowanceFailure = z.infer<typeof allowanceFailureSchema>;
export const resumeCreationKindSchema = z.discriminatedUnion("variantKind", [
	z.strictObject({ variantKind: z.literal("base") }),
	z.strictObject({ variantKind: z.enum(["language", "job"]), baseResumeId: z.string().min(1).max(200) }),
]);
export type ResumeCreationKind = z.infer<typeof resumeCreationKindSchema>;
export const startUsageViewSchema = z.strictObject({
	plan: z.literal("start"),
	operations: allowanceBalanceSchema,
	baseCvs: z.strictObject({ limit: z.literal(1).nullable(), used: count }),
});
export type StartUsageView = z.infer<typeof startUsageViewSchema>;
