import type { ApprovedRoute } from "./route-policy";
import { createHash } from "node:crypto";
import { ORPCError } from "@orpc/client";
import { and, eq, isNull } from "drizzle-orm";
import { z } from "zod";
import { withOwnerDatabase } from "@reactive-resume/db/owner-scope";
import { aiProcessingConsent } from "@reactive-resume/db/schema";
import { routeBindingSchema } from "@reactive-resume/schema/ai-operation";
import { processingCopy } from "./processing-copy.generated";
import { canonicalJson, getAiAvailability, getAiRuntime } from "./route-policy";
import { resolveReviewVerifierRoutes } from "./verifier-policy";

export const processingNoticeInputSchema = z.strictObject({
	purpose: z.string().min(1).max(200),
	locale: z.enum(["ar-SA", "en-US"]),
});
export const processingAcceptanceSchema = processingNoticeInputSchema.extend({
	route: routeBindingSchema,
	noticeVersion: z.string().min(1).max(200),
	noticeSha256: z.string().regex(/^[a-f0-9]{64}$/u),
});
export const processingNoticeSchema = processingAcceptanceSchema.extend({
	content: z.string(),
	alreadyGranted: z.boolean(),
});
type NoticeRequest = z.infer<typeof processingNoticeInputSchema>;
type ProcessingAcceptance = z.infer<typeof processingAcceptanceSchema>;

function resolveNotice(route: ApprovedRoute, { purpose, locale }: NoticeRequest) {
	const runtime = getAiRuntime();
	const handler = Object.hasOwn(runtime.handlers, purpose) ? runtime.handlers[purpose] : undefined;
	if (!handler || !route.evidenceVersion) return null;
	const scopeKey = `privacy.ai.scope.${purpose.slice("review.".length)}` as keyof typeof processingCopy;
	const scope =
		purpose.startsWith("review.") && Object.hasOwn(processingCopy, scopeKey) ? processingCopy[scopeKey] : null;
	if (!scope && !runtime.fetch) return null;
	const backup =
		handler.verifier &&
		route.verifier?.backup &&
		[route.model, ...(route.writers?.map((writer) => writer.model) ?? [])].some(
			(model) => resolveReviewVerifierRoutes({ ...route, model }, purpose).backup,
		);
	const content = scope
		? [
				scope[locale],
				processingCopy["privacy.ai.overseasNotice"][locale],
				...(backup ? [processingCopy["privacy.ai.backupNotice"][locale]] : []),
			].join(" ")
		: locale === "ar-SA"
			? "يستخدم هذا الاختبار بيانات اصطناعية."
			: "This test uses synthetic data.";
	const fields = {
		route: { routeId: route.routeId, routeRevision: route.routeRevision, configRevision: route.configRevision },
		noticeVersion: route.noticeVersion,
		purpose,
		locale,
		content,
	};
	return { ...fields, noticeSha256: createHash("sha256").update(canonicalJson(fields)).digest("hex") };
}

function availableNotices(input: NoticeRequest) {
	if (getAiAvailability().state !== "ready") return [];
	return getAiRuntime().routes.flatMap((route) => resolveNotice(route, input) ?? []);
}

export async function getProcessingNotices(userId: string, input: NoticeRequest) {
	const notices = availableNotices(input);
	if (!notices.length) return [];
	const grants = await withOwnerDatabase(userId, (tx) =>
		tx
			.select()
			.from(aiProcessingConsent)
			.where(
				and(
					eq(aiProcessingConsent.userId, userId),
					eq(aiProcessingConsent.purpose, input.purpose),
					isNull(aiProcessingConsent.revokedAt),
				),
			),
	);
	return notices.map((notice) => ({
		...notice,
		alreadyGranted: grants.some(
			(grant) =>
				grant.routeId === notice.route.routeId &&
				grant.routeRevision === notice.route.routeRevision &&
				grant.configRevision === notice.route.configRevision &&
				grant.noticeVersion === notice.noticeVersion,
		),
	}));
}

export const processingConsentService = {
	grant: (userId: string, input: ProcessingAcceptance) => {
		const notice = availableNotices(input).find(
			(n) =>
				n.route.routeId === input.route.routeId &&
				n.route.routeRevision === input.route.routeRevision &&
				n.route.configRevision === input.route.configRevision &&
				n.noticeVersion === input.noticeVersion &&
				n.noticeSha256 === input.noticeSha256,
		);
		if (!notice) throw new ORPCError("PRECONDITION_FAILED", { data: { reason: "AI_CONSENT_NOTICE_CHANGED" } });
		return withOwnerDatabase(userId, async (tx) => {
			const [row] = await tx
				.insert(aiProcessingConsent)
				.values({
					userId,
					routeId: input.route.routeId,
					routeRevision: input.route.routeRevision,
					configRevision: input.route.configRevision,
					noticeVersion: input.noticeVersion,
					purpose: input.purpose,
				})
				.onConflictDoUpdate({
					target: [
						aiProcessingConsent.userId,
						aiProcessingConsent.routeId,
						aiProcessingConsent.routeRevision,
						aiProcessingConsent.noticeVersion,
						aiProcessingConsent.purpose,
					],
					set: { configRevision: input.route.configRevision, grantedAt: new Date(), revokedAt: null },
				})
				.returning({ id: aiProcessingConsent.id });
			if (!row) throw new ORPCError("INTERNAL_SERVER_ERROR");
			return row;
		});
	},
	revoke: (userId: string, routeId: string) =>
		withOwnerDatabase(userId, async (tx) => {
			await tx
				.update(aiProcessingConsent)
				.set({ revokedAt: new Date() })
				.where(and(eq(aiProcessingConsent.userId, userId), eq(aiProcessingConsent.routeId, routeId)));
		}),
};
