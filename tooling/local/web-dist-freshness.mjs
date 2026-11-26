import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";

export const webBuildInputs = [
	"apps/web/src",
	"apps/web/index.html",
	"apps/web/locales",
	"apps/web/public",
	"apps/web/vite.config.ts",
	"packages/import/src",
	"packages/resume/src",
	"packages/pdf/src",
	"packages/ui",
	"packages/schema",
];

function* buildInputs(root, path) {
	const info = statSync(join(root, path));
	yield { path, modified: info.mtimeMs };
	if (!info.isDirectory()) return;
	for (const entry of readdirSync(join(root, path))) {
		if (entry === "node_modules" || entry === "dist" || entry.startsWith(".")) continue;
		yield* buildInputs(root, join(path, entry));
	}
}

export function assertFreshWebDist(root) {
	const index = statSync(join(root, "apps/web/dist/index.html"), { throwIfNoEntry: false });
	const build = "Run pnpm --filter web build before starting local real AI.";
	if (!index?.isFile()) throw new Error(`Missing apps/web/dist/index.html. ${build}`);
	for (const input of webBuildInputs)
		for (const { path, modified } of buildInputs(root, input))
			if (modified > index.mtimeMs) throw new Error(`Stale apps/web/dist: ${path} is newer. ${build}`);
}
