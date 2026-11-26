import { isAbsolute } from "node:path";
import { parseArgs } from "node:util";

process.loadEnvFile = () => {};

try {
	const { values } = parseArgs({
		options: { manifest: { type: "string" }, port: { type: "string" }, "ledger-dir": { type: "string" } },
	});
	if (!values.manifest) throw new Error("QUALIFICATION_MANIFEST_REQUIRED");
	const ledgerDirectory = values["ledger-dir"];
	if (!ledgerDirectory || !isAbsolute(ledgerDirectory)) throw new Error("QUALIFICATION_LEDGER_DIRECTORY_REQUIRED");
	// @boundaries-ignore Dev-only composition entry lives outside production workspace packages.
	const { startQualificationServer } = await import("../../../../tests/e2e/dev-real-ai-server.ts");
	await startQualificationServer(values.manifest, values.port ?? "3060", ledgerDirectory);
} catch (error) {
	const reason =
		error instanceof Error && /^QUALIFICATION_[A-Z_]+$/u.test(error.message)
			? error.message
			: "QUALIFICATION_START_FAILED";
	process.stderr.write(`${reason}\n`);
	process.exitCode = 1;
}
