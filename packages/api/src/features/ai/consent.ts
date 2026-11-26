import type { ApprovedRoute } from "./route-policy";
import { createHash } from "node:crypto";
import { ORPCError } from "@orpc/client";
import { and, eq, isNull, sql } from "drizzle-orm";
import { z } from "zod";
import { withOwnerDatabase } from "@reactive-resume/db/owner-scope";
import { aiProcessingConsent } from "@reactive-resume/db/schema";
import { routeBindingSchema } from "@reactive-resume/schema/ai-operation";
import { accountProcessingNotice, processingPurposes } from "./processing-scope";
import { canonicalJson, getAiAvailability, getAiRuntime } from "./route-policy";

export const processingLocaleSchema = z.enum(["ar-SA", "en-US"]);
export const processingNoticeInputSchema = z.strictObject({
	purpose: z.string().min(1).max(200),
	locale: processingLocaleSchema,
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
export const processingStatusSchema = z.strictObject({
	notices: z.array(z.strictObject({ content: z.string(), grantedAt: z.iso.datetime().nullable() })),
	canWithdraw: z.boolean(),
});
type NoticeRequest = z.infer<typeof processingNoticeInputSchema>;
type ProcessingAcceptance = z.infer<typeof processingAcceptanceSchema>;

function resolveNotice(route: ApprovedRoute, { purpose, locale }: NoticeRequest) {
	const runtime = getAiRuntime();
	const handler = Object.hasOwn(runtime.handlers, purpose) ? runtime.handlers[purpose] : undefined;
	if (!handler || !route.evidenceVersion) return null;
	const scope = accountProcessingNotice(route, runtime);
	const isAccountNotice = scope.purposes.includes(purpose);
	if (!isAccountNotice && !runtime.fetch) return null;
	const content = isAccountNotice
		? scope.content(locale)
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
	return {
		notice: { ...fields, noticeSha256: createHash("sha256").update(canonicalJson(fields)).digest("hex") },
		grantPurpose: isAccountNotice ? scope.purpose : purpose,
		grantPurposes: scope.grantPurposes(purpose),
	};
}

function availableNotices(input: NoticeRequest) {
	if (getAiAvailability().state !== "ready") return [];
	return getAiRuntime().routes.flatMap((route) => resolveNotice(route, input) ?? []);
}

function activeGrants(userId: string) {
	return withOwnerDatabase(userId, (tx) =>
		tx
			.select()
			.from(aiProcessingConsent)
			.where(and(eq(aiProcessingConsent.userId, userId), isNull(aiProcessingConsent.revokedAt))),
	);
}

type ResolvedNotice = NonNullable<ReturnType<typeof resolveNotice>>;
function findGrant(
	grants: Awaited<ReturnType<typeof activeGrants>>,
	{ notice, grantPurposes }: Pick<ResolvedNotice, "notice" | "grantPurposes">,
) {
	return grants.find(
		(grant) =>
			grantPurposes.includes(grant.purpose) &&
			grant.routeId === notice.route.routeId &&
			grant.routeRevision === notice.route.routeRevision &&
			grant.configRevision === notice.route.configRevision &&
			grant.noticeVersion === notice.noticeVersion,
	);
}

export async function getProcessingNotices(userId: string, input: NoticeRequest) {
	const notices = availableNotices(input);
	if (!notices.length) return [];
	const grants = await activeGrants(userId);
	return notices.map((resolved) => ({ ...resolved.notice, alreadyGranted: Boolean(findGrant(grants, resolved)) }));
}

export async function getProcessingStatus(userId: string, locale: NoticeRequest["locale"]) {
	const runtime = getAiRuntime();
	const purpose = processingPurposes.find((kind) => Object.hasOwn(runtime.handlers, kind));
	const grants = await activeGrants(userId);
	return {
		notices: purpose
			? runtime.routes.flatMap((route) => {
					const resolved = resolveNotice(route, { purpose, locale });
					if (!resolved) return [];
					return [
						{
							content: resolved.notice.content,
							grantedAt: findGrant(grants, resolved)?.grantedAt.toISOString() ?? null,
						},
					];
				})
			: [],
		canWithdraw: grants.length > 0,
	};
}

export const processingConsentService = {
	grant: (userId: string, input: ProcessingAcceptance) => {
		const resolved = availableNotices(input).find(
			({ notice: n }) =>
				n.route.routeId === input.route.routeId &&
				n.route.routeRevision === input.route.routeRevision &&
				n.route.configRevision === input.route.configRevision &&
				n.noticeVersion === input.noticeVersion &&
				n.noticeSha256 === input.noticeSha256,
		);
		if (!resolved) throw new ORPCError("PRECONDITION_FAILED", { data: { reason: "AI_CONSENT_NOTICE_CHANGED" } });
		return withOwnerDatabase(userId, async (tx) => {
			const [row] = await tx
				.insert(aiProcessingConsent)
				.values({
					userId,
					routeId: input.route.routeId,
					routeRevision: input.route.routeRevision,
					configRevision: input.route.configRevision,
					noticeVersion: input.noticeVersion,
					purpose: resolved.grantPurpose,
				})
				.onConflictDoUpdate({
					target: [
						aiProcessingConsent.userId,
						aiProcessingConsent.routeId,
						aiProcessingConsent.routeRevision,
						aiProcessingConsent.noticeVersion,
						aiProcessingConsent.purpose,
					],
					set: {
						configRevision: input.route.configRevision,
						grantedAt: sql`case when ${aiProcessingConsent.revokedAt} is null
							and ${aiProcessingConsent.configRevision} = excluded.config_revision
							then ${aiProcessingConsent.grantedAt} else now() end`,
						revokedAt: null,
					},
				})
				.returning({ id: aiProcessingConsent.id });
			if (!row) throw new ORPCError("INTERNAL_SERVER_ERROR");
			return row;
		});
	},
	revoke: (userId: string, routeId?: string) =>
		withOwnerDatabase(userId, async (tx) => {
			await tx
				.update(aiProcessingConsent)
				.set({ revokedAt: new Date() })
				.where(
					and(
						eq(aiProcessingConsent.userId, userId),
						isNull(aiProcessingConsent.revokedAt),
						routeId === undefined ? undefined : eq(aiProcessingConsent.routeId, routeId),
					),
				);
		}),
};
