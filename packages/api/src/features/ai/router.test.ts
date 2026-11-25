import { expect, it, vi } from "vite-plus/test";
import { createRouterClient } from "@orpc/server";
import { rateLimitConfig } from "@reactive-resume/utils/rate-limit";
import { operationService } from "./operations";

vi.mock("../../redis", async () => {
	const { MemoryRatelimiter } = await import("@orpc/experimental-ratelimit/memory");
	return {
		createRateLimiter: (_name: string, configuration: ConstructorParameters<typeof MemoryRatelimiter>[0]) =>
			new MemoryRatelimiter(configuration),
	};
});
vi.mock("@reactive-resume/env/server", () => ({ env: { FLAG_DISABLE_API_RATE_LIMIT: false } }));

vi.mock("../../context", async () => {
	const { os } = await vi.importActual<typeof import("@orpc/server")>("@orpc/server");
	return { protectedProcedure: os.$context<{ user: { id: string } }>() };
});
vi.mock("./operations", () => ({
	operationService: {
		preflight: vi.fn(async () => ({
			available: true,
			operationCost: 1,
			reason: null,
			requestFingerprint: "synthetic",
		})),
	},
}));

it("rate limits preflight before it reaches budget admission", async () => {
	vi.stubEnv("NODE_ENV", "production");
	const { aiRouter } = await import("./router").finally(() => vi.unstubAllEnvs());
	const client = createRouterClient(aiRouter, { context: { user: { id: "preflight-rate-limit" } } as never });
	const request = {
		requestKey: "test",
		kind: "review",
		sources: [{ kind: "resume" as const, id: "cv", revision: "1" }],
		route: { routeId: "synthetic", routeRevision: "1", configRevision: "1" },
		consentVersion: "1",
		parameters: {},
	};
	const limit = rateLimitConfig.orpc.aiRequest.maxRequests;
	for (let i = 0; i < limit; i++) {
		await expect(client.operations.preflight({ ...request, requestKey: `request-${i}` })).resolves.toMatchObject({
			available: true,
		});
	}
	await expect(client.operations.preflight(request)).rejects.toMatchObject({ code: "TOO_MANY_REQUESTS" });
	expect(operationService.preflight).toHaveBeenCalledTimes(limit);
});
