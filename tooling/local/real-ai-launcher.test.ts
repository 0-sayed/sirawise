import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { expect, it } from "vite-plus/test";

it("runs startup checks when launched through real-ai.mjs", () => {
	// Freshness has its own filesystem tests. This startup test runs without a web build.
	const preloaded = `
		import { registerHooks } from "node:module";
		process.loadEnvFile = () => {};
		registerHooks({
			resolve(specifier, context, nextResolve) {
				if (specifier === "./web-dist-freshness.mjs" && context.parentURL.endsWith("/tooling/local/real-ai.mjs")) {
					return { url: "data:text/javascript,export function assertFreshWebDist() {}", shortCircuit: true };
				}
				return nextResolve(specifier, context);
			}
		});
	`;
	const result = spawnSync(
		process.execPath,
		["--import", `data:text/javascript,${encodeURIComponent(preloaded)}`, "tooling/local/real-ai.mjs"],
		{
			cwd: fileURLToPath(new URL("../../", import.meta.url)),
			encoding: "utf8",
			env: {
				AUTH_SECRET: "synthetic-real-ai-launcher-only",
				DATABASE_URL: "postgresql://unused:unused@127.0.0.1:1/unused",
				OPENROUTER_API_KEY: "offline-placeholder",
			},
			timeout: 20_000,
		},
	);

	// The unavailable database stops startup before a listener or AI worker can start.
	expect(result.stdout, result.stderr).toContain("Running database migrations...");
	expect(result.stderr).toContain("ECONNREFUSED");
	expect(result.status).toBe(1);
});
