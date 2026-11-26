import "../../tooling/local/test-ai-guard.mjs";
/* eslint-disable no-restricted-imports -- Test-only composition exercises real, private server startup and synthetic runtime without exposing production exports. */
// Test-only composition. This entry is never imported by the application or production build.
import { createRequire } from "node:module";
import { setTimeout as wait } from "node:timers/promises";
import { createApp } from "../../apps/server/src/http/app";
import { resolvePrimaryContract } from "../../apps/server/src/startup/ai-qualification";
import { bindQualifiedReviewHandlers } from "../../apps/server/src/startup/ai-runtime";
import { startAiScheduler } from "../../apps/server/src/startup/ai-scheduler";
import { startCareerScheduler } from "../../apps/server/src/startup/career-scheduler";
import { runStartupChecks } from "../../apps/server/src/startup/checks";
import { initializeAuth } from "../../packages/auth/src/config";
import { getPool } from "../../packages/db/src/client";
import { getRedis } from "../../packages/db/src/redis";
const { serve } = createRequire(new URL("../../apps/server/package.json", import.meta.url))("@hono/node-server");
import { extractionCandidateHandler, reviewHandlers } from "../../packages/api/src/features/ai/review-handlers";
import { withAiRuntime } from "../../packages/api/src/features/ai/route-policy";
import { syntheticReviewRuntime as syntheticRuntime } from "../../packages/api/src/features/ai/testing/runtime";
import { jobEvidenceCandidateContract } from "../../packages/api/src/features/ai/variant-contracts";
import {
	createTranslationCandidateHandler,
	variantReviewHandlers,
} from "../../packages/api/src/features/ai/variant-handlers";
import { resolveReviewVerifierRoutes } from "../../packages/api/src/features/ai/verifier-policy";
import { canonicalVerifierRouteSha256 } from "../../packages/api/src/features/ai/verifier-policy";
import { resolveWriterRoute } from "../../packages/api/src/features/ai/writer-policy";
import { splitReviewClaims } from "../../packages/schema/src/resume/ai-review";
import { scriptedLetterResponse } from "./fixtures/letter-transport";
import { scriptedVariantResponse } from "./fixtures/variant-transport";

type Selection = { id: string; kind: string; section: string; text: string };
const [syntheticRoute] = syntheticRuntime.routes;
if (!syntheticRoute) throw new Error("Missing synthetic review route");
const proof = "synthetic-only";
const backupKind = "review.job-evidence" as const;
const verifierModel = "deepseek/deepseek-v4.1-flash-1017";
const backupRoute = {
	...syntheticRoute,
	routeId: "synthetic-backup",
	configRevision: "synthetic-backup-1",
	noticeVersion: "2",
	verifier: {
		evidenceVersion: proof,
		maxCallCostMicros: 3333,
		backup: {
			endpoint: syntheticRoute.endpoint,
			model: verifierModel,
			downstreamProvider: "parasail",
			providerEndpoint: "parasail/bf16",
			precision: "bf16" as const,
			evidenceVersion: proof,
			maxCallCostMicros: 3333,
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
				purposes: [backupKind],
			},
			qualified: [{ kind: backupKind, writerModel: "openai/gpt-6.1-terra", verifierModel }],
		},
	},
};
const syntheticQualifications = [
	resolvePrimaryContract(syntheticRoute, "job-evidence", jobEvidenceCandidateContract),
	resolvePrimaryContract(syntheticRoute, "extraction", extractionCandidateHandler),
].map(({ tuple }) => ({ ...tuple, manifestSha256: "a".repeat(64), scoredReceiptsSha256: "b".repeat(64) }));
const runtime = {
	...bindQualifiedReviewHandlers(
		{
			...syntheticRuntime,
			handlers: { ...syntheticRuntime.handlers, ...reviewHandlers, ...variantReviewHandlers },
		},
		syntheticQualifications,
	),
	fetch: async (_url: unknown, init?: RequestInit) => {
		const body = JSON.parse(String(init?.body));
		const selections: Selection[] = JSON.parse(body.messages.at(-1).content).selections;
		if (
			body.provider.only[0] === "together" &&
			selections.some(
				(selection) => selection.id === "variant-job-context" && selection.text.includes("Synthetic backup recovery"),
			)
		)
			return Response.json({ error: "Synthetic primary verifier unavailable" }, { status: 503 });
		// Only explicitly tagged browser fixtures wait; the real worker records and exposes the active attempt.
		if (selections.some((selection) => selection.text.includes("Synthetic delayed review")))
			await wait(
				selections.some((selection) => selection.id === "verification-claims") ? 3000 : 7000,
				undefined,
				init?.signal ? { signal: init.signal } : {},
			);
		if (selections.some((selection) => selection.text.includes("Synthetic batched translation")))
			await wait(1000, undefined, init?.signal ? { signal: init.signal } : {});
		if (selections.some((selection) => selection.text.includes("Compact retry")))
			await wait(2500, undefined, init?.signal ? { signal: init.signal } : {});
		const letter = scriptedLetterResponse(selections);
		if (letter !== undefined)
			return Promise.resolve(
				Response.json({
					id: "synthetic-letter",
					model: body.model,
					provider: body.provider.only[0],
					choices: [
						{ index: 0, message: { role: "assistant", content: JSON.stringify(letter) }, finish_reason: "stop" },
					],
					usage: { prompt_tokens: 5, completion_tokens: 5, total_tokens: 10, cost: 0.00001 },
				}),
			);
		const variantResult = scriptedVariantResponse(selections);
		if (variantResult instanceof Response) return Promise.resolve(variantResult);
		if (variantResult !== undefined)
			return Promise.resolve(
				new Response(
					JSON.stringify({
						id: "synthetic-variant",
						model: body.model,
						provider: body.provider.only[0].split("/")[0],
						choices: [
							{
								index: 0,
								message: { role: "assistant", content: JSON.stringify(variantResult) },
								finish_reason: "stop",
							},
						],
						usage: { prompt_tokens: 5, completion_tokens: 5, total_tokens: 10, cost: 0.00001 },
					}),
					{ headers: { "content-type": "application/json" } },
				),
			);
		const intent = selections.find((selection) => selection.id === "intent")?.text ?? "";
		const source =
			intent === "custom: Review the second reporting bullet"
				? selections.find((selection) => selection.text === "Built reporting tools.")
				: selections.find((selection) => selection.id !== "intent");
		if (!source) throw new Error("Missing synthetic source");
		const arabicSource =
			(source.text.match(/\p{Script=Arabic}/gu) ?? []).length > (source.text.match(/\p{Script=Latin}/gu) ?? []).length;
		const answer = intent.startsWith("result")
			? selections.find((selection) => selection.kind === "user_supplied" && selection.id !== "intent")
			: undefined;
		const merged = source.text === "Built a gateway that also" ? selections.slice(0, 3) : null;
		const evidenceIds = merged ? merged.map((passage) => passage.id) : [source.id];
		const extraction = source.kind === "unconfirmed_source";
		const mixedExtraction = extraction && source.text === "Built secure services";
		const arabicPdfExcerpt = extraction
			? /(?:• ?)?(?<fragment>قاد تنسيق العمليات[^\n]*المتابعة والتسل)$/u.exec(source.text)?.groups?.fragment
			: undefined;
		const arabicPdfExperience = source.text.startsWith("استوديو جسر الغد الرياض") && arabicPdfExcerpt;
		const currentPdfRole = extraction
			? /^(?:BandAI Saudi Arabia · Remote\s+)?مهندس برمجيات أول\s+(07\/2026\s*[-–]\s*حتى الآن)$/u.exec(source.text)?.[1]
			: undefined;
		const result = extraction
			? {
					candidates: arabicPdfExperience
						? (
								[
									["first", "company", "استوديو جسر الغد"],
									["first", "position", "مدير عمليات المنتجات"],
									["first", "location", "الرياض"],
									["second", "company", "شركة مرسى الأفكار"],
									["second", "position", "مدير عمليات"],
									["second", "location", "الرياض"],
									["second", "description", arabicPdfExperience],
								] as const
							).map(([entityId, field, value]) => ({
								id: `${entityId}-${field}`,
								section: "experience",
								entityId,
								field,
								value,
								confirmation: "needs_review",
								evidenceIds: [source.id],
								rawDateText: null,
							}))
						: currentPdfRole
							? [
									{ id: "position", field: "position", value: "مهندس برمجيات أول", rawDateText: null },
									{ id: "dates", field: "dates", value: null, rawDateText: currentPdfRole },
									{
										id: "company",
										field: "company",
										value: source.text.startsWith("BandAI") ? "BandAI Saudi Arabia" : "BandAI",
										rawDateText: null,
									},
									...(source.text.startsWith("BandAI")
										? [{ id: "location", field: "location", value: "Remote", rawDateText: null }]
										: []),
								].map((candidate) => ({
									...candidate,
									entityId: "current-role",
									section: "experience",
									confirmation: "needs_review",
									evidenceIds: [source.id],
								}))
							: [
									{
										id: "candidate",
										section: source.section,
										entityId: "synthetic-entry",
										field: "description",
										value: source.text,
										confirmation: "needs_review",
										evidenceIds: [source.id],
										rawDateText: null,
									},
									...(mixedExtraction
										? [
												{
													id: "field-invalid",
													section: source.section,
													entityId: "synthetic-entry",
													field: "company",
													value: "Invented Employer",
													confirmation: "needs_review",
													evidenceIds: [source.id],
													rawDateText: null,
												},
											]
										: []),
								],
					questions: mixedExtraction
						? [
								{
									id: "source-question",
									passageId: null,
									prompt: "Which employer can you confirm?",
									evidenceIds: [source.id],
								},
							]
						: [],
				}
			: {
					proposals:
						intent.startsWith("result") && !answer
							? []
							: [
									{
										id: "proposal",
										passageId: source.id,
										text: intent.includes("INVALID_METRIC")
											? "Led delivery with a 30% increase."
											: answer
												? `${source.text} ${answer.text}`
												: merged
													? "Built a gateway that routes service requests. Maintained the service logs."
													: source.text.replace(/Built/gu, "Developed").replace(/بنيت/gu, "طورت"),
										reason: arabicSource ? "صياغة أوضح للنص الأصلي" : "Synthetic wording fixture",
										evidenceIds: answer ? [...evidenceIds, answer.id] : evidenceIds,
									},
								],
					questions: answer
						? []
						: [
								{
									id: "outcome",
									passageId: source.id,
									prompt: arabicSource ? "ما النتيجة التي يمكنك تأكيدها؟" : "What result can you confirm?",
									evidenceIds: [source.id],
								},
							],
					notes: [],
				};
		const verify = selections.find((s) => s.id === "verification-claims");
		const verificationTask = selections.find((s) => s.id === "verification-task");
		const task = verificationTask ? JSON.parse(verificationTask.text) : null;
		const retentionApplies = task?.operation !== "extraction" || task.retentionApplicable === true;
		if ("proposals" in result)
			for (const proposal of result.proposals)
				Object.assign(proposal, { claims: splitReviewClaims(proposal.text, proposal.evidenceIds) });
		const finalResult = verify
			? {
					schemaVersion: 3,
					responseAssessment: { status: "appropriate", reason: "Synthetic response assessment." },
					factRetention: {
						...(task?.operation === "extraction" ? { failedClaimIds: [] } : {}),
						status: retentionApplies ? "retained" : "not_applicable",
						evidenceIds: retentionApplies
							? [...new Set((JSON.parse(verify.text) as { evidenceIds: string[] }[]).flatMap((c) => c.evidenceIds))]
							: [],
						reason: "Synthetic retention verdict.",
					},
					verdicts: (JSON.parse(verify.text) as { claimId: string; evidenceIds: string[] }[]).map((c) => ({
						claimId: c.claimId,
						evidenceIds: c.evidenceIds,
						verdict: "supported",
						reason: "Synthetic supported source",
					})),
				}
			: result;
		return Promise.resolve(
			new Response(
				JSON.stringify({
					id: "synthetic-review",
					model: body.model,
					provider: body.provider.only[0],
					choices: [
						{ index: 0, message: { role: "assistant", content: JSON.stringify(finalResult) }, finish_reason: "stop" },
					],
					usage: { prompt_tokens: 5, completion_tokens: 5, total_tokens: 10, cost: 0.00001 },
				}),
				{ headers: { "content-type": "application/json" } },
			),
		);
	},
};

const compactHandler = createTranslationCandidateHandler();
const compactRuntime = {
	...runtime,
	handlers: { ...runtime.handlers, "review.translation": compactHandler },
};
const backupWriter = resolveWriterRoute(backupRoute, { kind: backupKind, parameters: {} });
const backupVerifier = resolveReviewVerifierRoutes(backupWriter, backupKind).backup;
if (!backupVerifier) throw new Error("Missing synthetic backup verifier");
const { tuple: backupPrimary } = resolvePrimaryContract(backupRoute, "job-evidence", jobEvidenceCandidateContract);
const backupRuntime = bindQualifiedReviewHandlers({ ...runtime, routes: [backupRoute] }, [
	...syntheticQualifications,
	{ ...backupPrimary, manifestSha256: "a".repeat(64), scoredReceiptsSha256: "b".repeat(64) },
	{
		...backupPrimary,
		endpointSlot: "backup",
		routeSha256: canonicalVerifierRouteSha256(backupVerifier),
		manifestSha256: "a".repeat(64),
		scoredReceiptsSha256: "b".repeat(64),
	},
]);

async function start() {
	await runStartupChecks();
	await initializeAuth();
	const app = createApp();
	const server = serve({
		port: Number(process.env.PORT),
		fetch: (...args: Parameters<typeof app.fetch>) =>
			withAiRuntime(
				args[0].headers.get("x-synthetic-translation-contract") === "compact"
					? compactRuntime
					: args[0].headers.get("x-synthetic-verifier") === "backup-recovery"
						? backupRuntime
						: runtime,
				() => app.fetch(...args),
			),
	});
	const ai = withAiRuntime(
		{
			...runtime,
			routes: [...runtime.routes, ...backupRuntime.routes],
			historicalHandlers: { ...runtime.historicalHandlers, "review.translation": [compactHandler] },
		},
		() => startAiScheduler(),
	);
	const career = startCareerScheduler();
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
void start().catch((error) => {
	console.error(error);
	process.exit(1);
});
