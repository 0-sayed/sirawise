import { describe, expect, it } from "vite-plus/test";
import { createRouterClient } from "@orpc/server";
import { getProcessingNotices, processingConsentService } from "./consent";
import { processingPurposes } from "./processing-scope";
import { resolveApprovedRoute, withAiRuntime } from "./route-policy";
import { aiRouter } from "./router";
import { aiTestDatabase } from "./testing/database";
import { syntheticReviewRuntime, syntheticRoute, syntheticRuntime } from "./testing/runtime";

describe.skipIf(!process.env.COVER_LETTER_TEST_DATABASE_URL)("processing consent configuration binding", () => {
	const database = aiTestDatabase();
	it("honors matching local feature grants in the notice and at dispatch until withdrawal or a new notice", async () => {
		const [original] = syntheticReviewRuntime.routes;
		if (!original) throw new Error("Missing synthetic review route");
		const route = { ...original, routeId: "local-legacy-consent" };
		const { fetch: _transport, ...composition } = syntheticReviewRuntime;
		const runtime = { ...composition, routes: [route], legacyFeatureConsentVersion: route.noticeVersion };
		await database.run(() =>
			withAiRuntime(runtime, async () => {
				for (const purpose of processingPurposes) {
					const input = { purpose, locale: "ar-SA" } as const;
					const [notice] = await getProcessingNotices("alice", input);
					if (!notice) throw new Error(`Missing notice for ${purpose}`);
					expect(notice.alreadyGranted).toBe(false);
					const request = {
						kind: purpose,
						requestKey: "legacy-consent",
						sources: [{ kind: "resume" as const, id: "cv", revision: "1" }],
						parameters: {},
						route: notice.route,
						consentVersion: notice.noticeVersion,
					};
					await database.admin().query(
						`INSERT INTO ai_processing_consent
						(id, user_id, route_id, route_revision, config_revision, notice_version, purpose)
						VALUES ($1, 'alice', $2, $3, $4, $5, $6)`,
						[purpose, route.routeId, route.routeRevision, route.configRevision, route.noticeVersion, purpose],
					);
					expect((await getProcessingNotices("alice", input))[0]?.alreadyGranted).toBe(true);
					expect((await getProcessingNotices("bob", input))[0]?.alreadyGranted).toBe(false);
					await expect(resolveApprovedRoute("alice", request)).resolves.toMatchObject(notice.route);
					await withAiRuntime({ ...runtime, routes: [{ ...route, noticeVersion: "next" }] }, async () => {
						expect((await getProcessingNotices("alice", input))[0]?.alreadyGranted).toBe(false);
						await expect(resolveApprovedRoute("alice", { ...request, consentVersion: "next" })).rejects.toMatchObject({
							data: { reason: "AI_CONSENT_REQUIRED" },
						});
					});
				}
				await processingConsentService.revoke("alice", route.routeId);
				expect(
					(await getProcessingNotices("alice", { purpose: "review.translation", locale: "ar-SA" }))[0]?.alreadyGranted,
				).toBe(false);
			}),
		);
	});
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

	it("discloses the expanded processor only for eligible work in the shared account notice", async () => {
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
					expect(notice?.content).toContain(locale === "ar-SA" ? "في ترجمة السيرة" : "for CV translation.");
					expect(other?.content).toBe(notice?.content);
					expect(other?.alreadyGranted).toBe(false);
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

	it("shares a current notice grant across features and languages for its owner until withdrawal", async () => {
		const [original] = syntheticReviewRuntime.routes;
		if (!original) throw new Error("Missing synthetic review route");
		const route = { ...original, routeId: "account-consent" };
		const runtime = { ...syntheticReviewRuntime, routes: [route] };
		const request = { purpose: "review.wording", locale: "en-US" } as const;
		const other = { purpose: "review.summary", locale: "ar-SA" } as const;
		const client = (id: string) =>
			createRouterClient(aiRouter, {
				context: { authentication: { kind: "session", permissions: ["read", "write"], user: { id } } } as never,
			});
		const alice = client("alice");
		const bob = client("bob");
		await database.run(() =>
			withAiRuntime(runtime, async () => {
				const [notice] = await alice.processing.notices(request);
				if (!notice) throw new Error("Missing displayed notice");
				const { content: _content, alreadyGranted, ...acceptance } = notice;
				expect(alreadyGranted).toBe(false);
				const { id } = await alice.processing.grant(acceptance);
				const status = await alice.processing.status({ locale: request.locale });
				expect(status).toEqual({
					notices: [{ content: notice.content, grantedAt: expect.any(String) }],
					canWithdraw: true,
				});
				expect(await alice.processing.grant(acceptance)).toEqual({ id });
				expect(await alice.processing.status({ locale: request.locale })).toEqual(status);
				const operation = {
					kind: other.purpose,
					requestKey: "other-feature",
					sources: [{ kind: "resume" as const, id: "cv", revision: "1" }],
					parameters: {},
					route: notice.route,
					consentVersion: notice.noticeVersion,
				};
				expect((await alice.processing.notices(other))[0]?.alreadyGranted).toBe(true);
				expect((await bob.processing.notices(other))[0]?.alreadyGranted).toBe(false);
				await expect(resolveApprovedRoute("alice", operation)).resolves.toMatchObject(notice.route);
				await expect(resolveApprovedRoute("bob", operation)).rejects.toMatchObject({
					data: { reason: "AI_CONSENT_REQUIRED" },
				});
				await database.admin().query(
					`INSERT INTO ai_processing_consent
					(id, user_id, route_id, route_revision, config_revision, notice_version, purpose)
					VALUES ('previous-consent', 'bob', $1, $2, $3, $4, $5)`,
					[route.routeId, route.routeRevision, route.configRevision, route.noticeVersion, other.purpose],
				);
				const { fetch: _transport, ...production } = runtime;
				await withAiRuntime(production, async () => {
					await expect(resolveApprovedRoute("alice", operation)).resolves.toMatchObject(notice.route);
					await expect(resolveApprovedRoute("bob", operation)).rejects.toMatchObject({
						data: { reason: "AI_CONSENT_REQUIRED" },
					});
				});
				await withAiRuntime({ ...runtime, routes: [{ ...route, noticeVersion: "next" }] }, async () => {
					expect((await alice.processing.notices(other))[0]?.alreadyGranted).toBe(false);
					await expect(resolveApprovedRoute("alice", { ...operation, consentVersion: "next" })).rejects.toMatchObject({
						data: { reason: "AI_CONSENT_REQUIRED" },
					});
				});
				await alice.processing.revoke({});
				expect(await alice.processing.status({ locale: request.locale })).toEqual({
					notices: [{ content: notice.content, grantedAt: null }],
					canWithdraw: false,
				});
				expect((await alice.processing.notices(request))[0]?.alreadyGranted).toBe(false);
				await expect(resolveApprovedRoute("alice", operation)).rejects.toMatchObject({
					data: { reason: "AI_CONSENT_REQUIRED" },
				});
			}),
		);
	});
});
