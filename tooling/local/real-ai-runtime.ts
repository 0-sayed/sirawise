import type { AiRuntime } from "@reactive-resume/api/features/ai/route-policy";
import { extractionCandidateHandler, reviewHandlers } from "@reactive-resume/api/features/ai/review-handlers";
import { withMeasuredReviewExecution } from "@reactive-resume/api/features/ai/route-policy";
import {
	createJobEvidenceCandidateHandler,
	createTranslationCandidateHandler,
	variantReviewHandlers,
} from "@reactive-resume/api/features/ai/variant-handlers";
import { resolveReviewVerifierRoute } from "@reactive-resume/api/features/ai/verifier-policy";
import { resolveWriterRoute } from "@reactive-resume/api/features/ai/writer-policy";
import { letterReviewHandler } from "@reactive-resume/api/features/cover-letters/review-handler";
import { realAiConfig } from "./real-ai-config";

export function createRealAiRuntime(environment: Record<string, string | undefined>): AiRuntime {
	const config = realAiConfig(environment);
	const route = withMeasuredReviewExecution(config.route);
	const runtime: AiRuntime = {
		routes: [route],
		handlers: { ...reviewHandlers, ...variantReviewHandlers, "review.cover-letter": letterReviewHandler },
		workerAvailable: true,
		localOwnerAllowance: config.allowance,
	};
	if (config.candidatePipelines) {
		const jobKind = "review.job-evidence";
		const jobWriter = resolveWriterRoute(route, { kind: jobKind, parameters: {} });
		const candidates = {
			"review.translation": createTranslationCandidateHandler(),
			[jobKind]: createJobEvidenceCandidateHandler(resolveReviewVerifierRoute(jobWriter)),
			"review.extraction": extractionCandidateHandler,
		};
		// Both selected passages and saved jobs use the same job-evidence operation kind.
		runtime.historicalHandlers = {
			"review.translation": [variantReviewHandlers["review.translation"]],
			[jobKind]: [variantReviewHandlers[jobKind]],
			"review.extraction": [reviewHandlers["review.extraction"]],
		};
		runtime.handlers = { ...runtime.handlers, ...candidates };
	}
	if (config.stubBaseUrl) {
		const base = config.stubBaseUrl;
		// Keep the production adapter's canonical endpoint gate. Only this dev transport
		// rewrites it to an explicitly enabled loopback stub, with redirects forbidden.
		runtime.fetch = (url, init) => {
			const target = String(url);
			if (target !== config.route.endpoint + "/chat/completions") throw new Error("LOCAL_STUB_PATH_DENIED");
			return globalThis.fetch(base + "/chat/completions", { ...init, redirect: "error" });
		};
	}
	return runtime;
}
