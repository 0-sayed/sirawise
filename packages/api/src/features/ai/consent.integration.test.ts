import { describe, expect, it } from "vite-plus/test";
import { createRouterClient } from "@orpc/server";
import { getProcessingNotices, processingConsentService } from "./consent";
import { resolveApprovedRoute, withAiRuntime } from "./route-policy";
import { aiRouter } from "./router";
import { aiTestDatabase } from "./testing/database";
import { syntheticReviewRuntime, syntheticRoute, syntheticRuntime } from "./testing/runtime";

describe.skipIf(!process.env.COVER_LETTER_TEST_DATABASE_URL)("processing consent configuration binding", () => {
	const database = aiTestDatabase();
	it.each(["ar-SA", "en-US"] as const)(
		"rejects a stale or altered %s notice before creating a grant",
		async (locale) => {
			const owner = locale === "ar-SA" ? "alice" : "bob";
			const client = createRouterClient(aiRouter, {
				context: { authentication: { kind: "session", permissions: ["read", "write"], user: { id: owner } } } as never,
			});
			const effects = async () =>
				(
					await database.admin().query(
						`SELECT
				(SELECT count(*)::int FROM ai_processing_consent WHERE user_id=$1 AND purpose='review') AS grants,
				(SELECT count(*)::int FROM ai_operation_attempt WHERE user_id=$1) AS dispatches,
				(SELECT count(*)::int FROM ai_usage_ledger WHERE user_id=$1) AS charges`,
						[owner],
					)
				).rows[0];
			const input = { purpose: "review", locale };
			await database.run(async () => {
				const [displayed] = await withAiRuntime(syntheticRuntime, () => client.processing.notices(input));
				if (!displayed) throw new Error("Missing displayed notice");
				expect(displayed).toMatchObject({ ...input, alreadyGranted: false });
				expect(displayed.content).toMatch(locale === "ar-SA" ? /[\u0600-\u06ff]/ : /test/i);
				const { content: _content, alreadyGranted: _alreadyGranted, ...acceptance } = displayed;
				const revised = { ...syntheticRuntime, routes: [{ ...syntheticRoute, configRevision: "updated" }] };
				await withAiRuntime(revised, async () => {
					await expect(client.processing.grant(acceptance)).rejects.toMatchObject({
						data: { reason: "AI_CONSENT_NOTICE_CHANGED" },
					});
					const [current] = await client.processing.notices(input);
					if (!current) throw new Error("Missing current notice");
					expect(current.alreadyGranted).toBe(false);
					const { content: _newContent, alreadyGranted: _newGrant, ...currentAcceptance } = current;
					await expect(
						client.processing.grant({ ...currentAcceptance, noticeSha256: acceptance.noticeSha256 }),
					).rejects.toMatchObject({
						data: { reason: "AI_CONSENT_NOTICE_CHANGED" },
					});
					expect((await client.processing.notices(input))[0]?.alreadyGranted).toBe(false);
					expect(await effects()).toEqual({ grants: 0, dispatches: 0, charges: 0 });
					await client.processing.grant(currentAcceptance);
					expect(await effects()).toEqual({ grants: 1, dispatches: 0, charges: 0 });
					expect((await client.processing.notices(input))[0]?.alreadyGranted).toBe(true);
					await client.processing.revoke({ routeId: current.route.routeId });
					expect((await client.processing.notices(input))[0]?.alreadyGranted).toBe(false);
				});
			});
		},
	);

	it("shows the expanded notice only for eligible purposes and requires fresh localized acceptance", async () => {
		const [original] = syntheticReviewRuntime.routes;
		if (!original?.verifier) throw new Error("Missing synthetic review route");
		const proof = "synthetic";
		const model = "deepseek/deepseek-v4.1-flash-1017";
		const route = {
			...original,
			noticeVersion: "2",
			configRevision: "synthetic-expanded",
			verifier: {
				...original.verifier,
				backup: {
					endpoint: original.endpoint,
					model,
					downstreamProvider: "parasail",
					providerEndpoint: "parasail/bf16",
					precision: "bf16" as const,
					evidenceVersion: proof,
					maxCallCostMicros: 2000,
					processor: {
						availability: proof,
						location: proof,
						contract: proof,
						retention: proof,
						zdr: proof,
						dataCollectionDenial: proof,
						fullPrecision: proof,
						structuredOutput: proof,
						callBound: proof,
						purposes: ["review.translation"] as const,
					},
					qualified: [{ kind: "review.translation" as const, writerModel: original.model, verifierModel: model }],
				},
			},
		};
		await database.run(async () => {
			const purpose = "review.translation";
			const [originalNotice] = await withAiRuntime(syntheticReviewRuntime, async () => {
				const notices = await getProcessingNotices("alice", { purpose, locale: "en-US" });
				const [notice] = notices;
				if (!notice) throw new Error("Missing original notice");
				const { content: _content, alreadyGranted: _alreadyGranted, ...acceptance } = notice;
				await processingConsentService.grant("alice", acceptance);
				return notices;
			});
			expect(originalNotice?.content).not.toContain("Parasail");
			await withAiRuntime({ ...syntheticReviewRuntime, routes: [route] }, async () => {
				for (const locale of ["ar-SA", "en-US"] as const) {
					const [notice] = await getProcessingNotices("alice", { purpose, locale });
					const [other] = await getProcessingNotices("alice", { purpose: "review.wording", locale });
					expect(notice).toMatchObject({
						route: { routeRevision: original.routeRevision, configRevision: route.configRevision },
						alreadyGranted: false,
						noticeVersion: "2",
						locale,
					});
					expect(notice?.content).toContain("Parasail");
					expect(other?.content).not.toContain("Parasail");
				}
			});
		});
	});

	it("requires a new grant after a configuration revision and invalidates the old configuration", async () => {
		const request = {
			requestKey: "consent",
			kind: "review",
			sources: [{ kind: "resume" as const, id: "cv", revision: "1" }],
			route: { routeId: "synthetic", routeRevision: "1", configRevision: "1" },
			consentVersion: "1",
			parameters: {},
		};
		const grant = async (route: typeof request.route) => {
			const [notice] = await getProcessingNotices("alice", { purpose: "review", locale: "en-US" });
			if (!notice) throw new Error("Missing synthetic processing notice");
			const { content: _content, alreadyGranted: _alreadyGranted, ...acceptance } = notice;
			expect(acceptance.route).toEqual(route);
			return processingConsentService.grant("alice", acceptance);
		};
		await database.run(() =>
			withAiRuntime(syntheticRuntime, async () => {
				await grant(request.route);
				expect(await resolveApprovedRoute("alice", request)).toMatchObject({ configRevision: "1" });
			}),
		);
		const route = { ...request.route, configRevision: "2" };
		await database.run(() =>
			withAiRuntime({ ...syntheticRuntime, routes: [{ ...syntheticRoute, configRevision: "2" }] }, async () => {
				await expect(resolveApprovedRoute("alice", { ...request, route })).rejects.toMatchObject({
					data: { reason: "AI_CONSENT_REQUIRED" },
				});
				await grant(route);
				expect(await resolveApprovedRoute("alice", { ...request, route })).toMatchObject({ configRevision: "2" });
			}),
		);
		await database.run(() =>
			withAiRuntime(syntheticRuntime, async () => {
				await expect(resolveApprovedRoute("alice", request)).rejects.toMatchObject({
					data: { reason: "AI_CONSENT_REQUIRED" },
				});
			}),
		);
	});
});
