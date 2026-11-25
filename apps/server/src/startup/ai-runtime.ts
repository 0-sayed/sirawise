import type { AiRuntime, ApprovedRoute } from "@reactive-resume/api/features/ai/route-policy";
import { extractionCandidateHandler, reviewHandlers } from "@reactive-resume/api/features/ai/review-handlers";
import {
	jobEvidenceCandidateContract,
	translationCandidateContract,
} from "@reactive-resume/api/features/ai/variant-contracts";
import {
	createJobEvidenceCandidateHandler,
	createTranslationCandidateHandler,
	variantReviewHandlers,
} from "@reactive-resume/api/features/ai/variant-handlers";
import {
	canonicalVerifierRouteSha256,
	resolveReviewVerifierRoutes,
} from "@reactive-resume/api/features/ai/verifier-policy";
import { resolveWriterRoute } from "@reactive-resume/api/features/ai/writer-policy";
import { letterReviewHandler } from "@reactive-resume/api/features/cover-letters/review-handler";
import { resolvePrimaryContract, selectQualifiedContract, type QualificationSelection } from "./ai-qualification";
import qualifications from "./ai-qualification.json" with { type: "json" };
import productionAiRouteData from "./ai-route.json" with { type: "json" };

type ProductionAiRoute = Omit<ApprovedRoute, "apiKey"> & { concurrency: number };

export const productionAiRoute = productionAiRouteData as ProductionAiRoute;

export function bindQualifiedReviewHandlers(
	runtime: AiRuntime,
	selections: readonly QualificationSelection[],
): AiRuntime {
	const route = runtime.routes[0];
	if (!route) return runtime;
	const handlers = { ...runtime.handlers };
	const historicalHandlers = { ...runtime.historicalHandlers };
	const job = resolvePrimaryContract(route, "job-evidence", jobEvidenceCandidateContract, runtime.writerConfig);
	const extraction = resolvePrimaryContract(route, "extraction", extractionCandidateHandler, runtime.writerConfig);
	const translation = resolvePrimaryContract(route, "translation", translationCandidateContract, runtime.writerConfig);
	const candidates = [
		[job.tuple, createJobEvidenceCandidateHandler(job.verifier)],
		[extraction.tuple, extractionCandidateHandler],
		[translation.tuple, createTranslationCandidateHandler()],
	] as const;
	const backup = route.verifier?.backup;
	const backupReceipts = new Set<string>();
	for (const [tuple, candidate] of candidates) {
		const kind = `review.${tuple.feature}`;
		const previous = handlers[kind];
		if (!previous) continue;
		const qualified = selectQualifiedContract(tuple, selections);
		if (
			qualified &&
			backup &&
			route.noticeVersion !== "1" &&
			route.configRevision !== "pilot-writers-full-cv-2026-11-21-v4" &&
			(tuple.feature === "translation" || tuple.feature === "job-evidence")
		) {
			const request = { kind, parameters: {} };
			const writer = resolveWriterRoute(route, request, runtime.writerConfig);
			const verifier = resolveReviewVerifierRoutes(writer, kind).backup;
			if (
				verifier &&
				selectQualifiedContract(
					{
						...tuple,
						endpointSlot: "backup",
						verifierModel: verifier.model,
						routeSha256: canonicalVerifierRouteSha256(verifier),
					},
					selections,
				)
			)
				backupReceipts.add(`${kind}:${writer.model}:${verifier.model}`);
		}
		const active = qualified ? candidate : previous;
		handlers[kind] = active;
		const byVersion = new Map(
			[...(historicalHandlers[kind] ?? []), previous, candidate, active].map((handler) => [
				`${handler.promptVersion}:${handler.schemaVersion}`,
				handler,
			]),
		);
		byVersion.delete(`${active.promptVersion}:${active.schemaVersion}`);
		historicalHandlers[kind] = [...byVersion.values()];
	}
	const routes =
		backup && route.verifier
			? [
					{
						...route,
						verifier: {
							...route.verifier,
							backup: {
								...backup,
								qualified: backup.qualified.filter(({ kind, writerModel, verifierModel }) =>
									backupReceipts.has(`${kind}:${writerModel}:${verifierModel}`),
								),
							},
						},
					},
					...runtime.routes.slice(1),
				]
			: runtime.routes;
	return { ...runtime, routes, handlers, historicalHandlers };
}

export function createProductionAiRuntime(environment: { OPENROUTER_API_KEY?: string | undefined }): AiRuntime | null {
	const apiKey = environment.OPENROUTER_API_KEY?.trim();
	if (!apiKey) return null;

	const { concurrency: _concurrency, ...approvedRoute } = productionAiRoute;
	const route = { ...approvedRoute, apiKey, extendJobAndTranslationTiming: true };
	return bindQualifiedReviewHandlers(
		{
			routes: [route],
			handlers: { ...reviewHandlers, ...variantReviewHandlers, "review.cover-letter": letterReviewHandler },
			workerAvailable: true,
		},
		qualifications.selections as QualificationSelection[],
	);
}
