/* eslint-disable no-restricted-imports -- Dev-only composition reuses private server startup; never imported by app/build. */
import { createRequire } from "node:module";
import { join } from "node:path";
import { createApp } from "../../apps/server/src/http/app";
import { startAiScheduler } from "../../apps/server/src/startup/ai-scheduler";
import { startCareerScheduler } from "../../apps/server/src/startup/career-scheduler";
import { runStartupChecks } from "../../apps/server/src/startup/checks";
import { completionTokenLimit, withAiRuntime } from "../../packages/api/src/features/ai/route-policy";
import { initializeAuth } from "../../packages/auth/src/config";
import { getPool } from "../../packages/db/src/client";
import { getRedis } from "../../packages/db/src/redis";
import {
	approvedQualificationConfig,
	loadQualificationBatch,
	previousQualificationCampaignCap,
	qualificationBaseUrl,
	qualificationCallCost,
	qualificationRouteBase,
	requireDispatchableManifest,
	requireQualificationLimits,
} from "../../tooling/evaluations/review/pipeline-safety/cli";
import { ensureLocalAiBudget } from "../../tooling/local/real-ai-budget";
import { realAiConfig } from "../../tooling/local/real-ai-config";

const { serve } = createRequire(new URL("../../apps/server/package.json", import.meta.url))("@hono/node-server");
import { createRealAiRuntime } from "../../tooling/local/real-ai-runtime";
export async function startRealAiServer() {
	const config = realAiConfig(process.env);
	const runtime = createRealAiRuntime(process.env);
	await runStartupChecks();
	await ensureLocalAiBudget(process.env, config.route);
	await initializeAuth();
	const app = createApp();
	const server = serve({
		hostname: "127.0.0.1",
		port: config.port,
		fetch: (...args: Parameters<typeof app.fetch>) => withAiRuntime(runtime, () => app.fetch(...args)),
	});
	const ai = withAiRuntime(runtime, () => startAiScheduler());
	const career = startCareerScheduler();
	console.info("LOCAL REAL AI — dev only, provisional models");
	if (config.candidatePipelines) console.info("Local candidate pipelines: translation, job evidence, extraction");
	console.info(`${config.appUrl} · synthetic/sample CVs only · writer Luna/Azure low · verifier DeepSeek/Together low`);
	console.info(
		config.allowance
			? "Selected local owner allowance: 50 operations"
			: "Set LOCAL_REAL_AI_OWNER_ID for the local owner's 50-operation allowance",
	);
	let shuttingDown = false;
	const shutdown = () => {
		if (shuttingDown) return;
		shuttingDown = true;
		const httpDrain = new Promise<void>((resolve, reject) =>
			server.close((error?: Error) => (error ? reject(error) : resolve())),
		);
		void Promise.allSettled([httpDrain, ai.stop(), career.stop()]).then(async (results) => {
			await getPool().end();
			getRedis()?.disconnect();
			process.exit(results.some((result) => result.status === "rejected") ? 1 : 0);
		});
	};
	process.once("SIGTERM", shutdown);
	process.once("SIGINT", shutdown);
}

export async function startQualificationServer(manifestFile: string, port: string, ledgerDirectory: string) {
	if (port !== "0") qualificationBaseUrl(`http://127.0.0.1:${port}`);
	const { manifest, manifestSha256, fixtures } = await loadQualificationBatch(manifestFile);
	requireDispatchableManifest(manifest);
	if (process.env.QUALIFICATION_ARMED_MANIFEST !== manifestSha256) throw new Error("QUALIFICATION_NOT_ARMED");
	const config = realAiConfig(process.env);
	const approved = approvedQualificationConfig();
	if (config.stubBaseUrl || approved.campaignId !== manifest.campaignId)
		throw new Error("QUALIFICATION_TRANSPORT_DENIED");
	const baseRoute = qualificationRouteBase(config.route.apiKey);
	const {
		batchHashes,
		batchInputBytes,
		effectiveQualificationRoute,
		prepareFixedCase,
		qualificationBatchBound,
		QualificationLedger,
		runFixedCase,
	} = await import("../../tooling/evaluations/review/pipeline-safety/local-runtime");
	const { canonicalVerifierRouteSha256 } = await import("../../packages/api/src/features/ai/verifier-policy");
	const ledger = new QualificationLedger(
		join(ledgerDirectory, `campaign-${manifest.campaignId}.json`),
		manifest.campaignId,
		manifest.maxRunMicros,
		previousQualificationCampaignCap,
	);
	const pinned = new Map(fixtures.map((fixture) => [fixture.id, fixture]));
	for (const suite of manifest.suites) {
		if (approved.suiteCaps[suite.id as keyof typeof approved.suiteCaps] !== suite.capMicros)
			throw new Error("QUALIFICATION_SUITE_CAP");
		for (const planned of suite.cases) {
			const input = pinned.get(planned.id);
			const route = manifest.routes.find(
				(route) => route.feature === input?.feature && route.routeSha256 === (planned.routeSha256 ?? suite.routeSha256),
			);
			if (!input || !route) throw new Error("QUALIFICATION_CASE_CHANGED");
			const effective = effectiveQualificationRoute(input, baseRoute);
			const rate = requireQualificationLimits(effective, route.feature, approved);
			if (canonicalVerifierRouteSha256(effective) !== route.routeSha256) throw new Error("QUALIFICATION_ROUTE_CHANGED");
			const prepared = prepareFixedCase(input, route, manifest.fixtureIdentifierSeed);
			if (prepared.batches.length !== planned.batches.length) throw new Error("QUALIFICATION_CALL_CHANGED");
			for (const [index, batch] of prepared.batches.entries()) {
				const plan = planned.batches[index];
				const hashes = batchHashes(batch);
				const boundMicros = await qualificationBatchBound(batch, effective);
				const wireBytes = await batchInputBytes(batch, effective, boundMicros);
				if (
					plan?.batchKey !== batch.key ||
					JSON.stringify(plan.itemIds) !== JSON.stringify(batch.itemIds) ||
					plan.promptSha256 !== hashes.promptSha256 ||
					plan.schemaSha256 !== hashes.schemaSha256 ||
					plan.wireBytes !== wireBytes ||
					plan.boundMicros !== boundMicros
				)
					throw new Error("QUALIFICATION_CALL_CHANGED");
				if (qualificationCallCost(wireBytes, completionTokenLimit(effective), rate) > effective.maxCallCostMicros)
					throw new Error("QUALIFICATION_CALL_LIMIT");
			}
		}
	}
	let inFlight = false;
	return serve({
		hostname: "127.0.0.1",
		port: Number(port),
		fetch: async (request: Request) => {
			const path = new URL(request.url).pathname;
			if (request.method === "GET" && path === "/__local/qualification")
				return Response.json({ manifestSha256, buildSha256: manifest.buildSha256 });
			if (request.method !== "POST" || path !== "/__local/qualification/case")
				return new Response(null, { status: 404 });
			if (inFlight) return new Response(null, { status: 409 });
			inFlight = true;
			try {
				if (request.headers.get("origin") || !request.headers.get("content-type")?.startsWith("application/json"))
					return new Response(null, { status: 400 });
				const raw = await request.text();
				if (raw.length > 1024) return new Response(null, { status: 400 });
				const body = JSON.parse(raw) as { manifestSha256?: string; suite?: string; caseId?: string };
				if (
					!body ||
					Object.keys(body).length !== 3 ||
					body.manifestSha256 !== manifestSha256 ||
					typeof body.caseId !== "string"
				)
					return new Response(null, { status: 400 });
				const suite = manifest.suites.find(({ id }) => id === body.suite);
				const planned = suite?.cases.find(({ id }) => id === body.caseId);
				const input = pinned.get(body.caseId);
				const route = manifest.routes.find(
					(route) =>
						route.feature === input?.feature && route.routeSha256 === (planned?.routeSha256 ?? suite?.routeSha256),
				);
				if (!suite || !planned || !input || !route) return new Response(null, { status: 404 });
				const receipt = await runFixedCase(input, route, {
					suite: suite.id,
					manifestSha256,
					fixtureIdentifierSeed: manifest.fixtureIdentifierSeed,
					planned,
					capMicros: suite.capMicros,
					ledger,
					writer: baseRoute,
				});
				return Response.json(receipt);
			} catch {
				return new Response(null, { status: 409 });
			} finally {
				inFlight = false;
			}
		},
	});
}
