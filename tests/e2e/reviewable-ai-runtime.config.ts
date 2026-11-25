import { resolve } from "node:path";
import { defineConfig } from "@playwright/test";
import base from "../../playwright.config";

if (!base.webServer) throw new Error("Expected the browser web servers");
const servers = Array.isArray(base.webServer) ? base.webServer : [base.webServer];
export default defineConfig({
	...base,
	testDir: resolve(process.cwd(), "tests/e2e/specs"),
	testIgnore: [],
	testMatch: ["**/reviewable-ai*.spec.ts", "**/cover-letter-review.spec.ts"],
	webServer: servers.map((server, index) =>
		index === 1 && server
			? {
					...server,
					// Playwright must own the process group so it can stop the test server.
					cwd: resolve(process.cwd(), "apps/server"),
					command: "node --import tsx ../../tests/e2e/reviewable-ai-runtime-server.ts",
					env: { ...server.env, TSX_TSCONFIG_PATH: "../../tsconfig.json" },
				}
			: { ...server, cwd: process.cwd() },
	),
});
