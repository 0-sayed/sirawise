import { mkdirSync, writeFileSync, utimesSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vite-plus/test";
import { assertFreshWebDist, webBuildInputs } from "./web-dist-freshness.mjs";

it("requires a built web index newer than nested sources and bundled package inputs", () => {
	const root = mkdtempSync(join(tmpdir(), "web-dist-freshness-"));
	for (const input of [...webBuildInputs, "apps/web/dist"]) mkdirSync(join(root, input), { recursive: true });
	expect(() => assertFreshWebDist(root)).toThrow(/pnpm --filter web build/u);
	const index = join(root, "apps/web/dist/index.html");
	writeFileSync(index, "<main></main>");
	const file = join(root, "packages/import/src/pdf.ts");
	writeFileSync(file, "export {};");
	const buildTime = Math.ceil(Date.now() / 1000) + 10;
	utimesSync(index, buildTime, buildTime);
	expect(() => assertFreshWebDist(root)).not.toThrow();
	utimesSync(file, buildTime + 10, buildTime + 10);
	expect(() => assertFreshWebDist(root)).toThrow(/stale.*pdf\.ts/isu);
	utimesSync(file, buildTime - 10, buildTime - 10);
	const source = join(root, "packages/import/src");
	utimesSync(source, buildTime + 10, buildTime + 10);
	expect(() => assertFreshWebDist(root)).toThrow(/stale.*packages\/import\/src/isu);
});
