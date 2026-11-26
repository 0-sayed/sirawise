import { execFile } from "node:child_process";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { scenarios } from "./pdf-import-roundtrip";

const execute = promisify(execFile);
const pdfs = new Map<string, Promise<Buffer>>();

export function renderPdf(name: string) {
	const existing = pdfs.get(name);
	if (existing) return existing;
	const rendered = execute(
		process.execPath,
		["--import", "tsx", "../../tests/e2e/fixtures/render-import-pdf.ts", "--render-roundtrip-pdf", name],
		{
			cwd: "apps/server",
			env: { ...process.env, TSX_TSCONFIG_PATH: "../../tsconfig.json" },
			encoding: "buffer",
			maxBuffer: 25_000_000,
		},
	).then(({ stdout }) => stdout);
	pdfs.set(name, rendered);
	return rendered;
}

async function main() {
	const scenario = scenarios.find(({ name }) => name === process.argv[3]);
	if (!scenario) throw new Error("Unknown PDF import scenario");
	const serverRequire = createRequire(resolve("package.json"));
	const { createResumePdfFile } = await import(
		pathToFileURL(serverRequire.resolve("@reactive-resume/pdf/server")).href
	);
	const file = await createResumePdfFile({ data: scenario.data, filename: scenario.name + ".pdf" });
	process.stdout.write(Buffer.from(await file.arrayBuffer()));
}

if (process.argv[2] === "--render-roundtrip-pdf") void main();
