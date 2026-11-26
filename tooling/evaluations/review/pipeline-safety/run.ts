import type {
	CaseReceipt,
	QualificationCase,
	QualificationManifest,
	QualificationReceipts,
	QualificationRoute,
	SafetyExpected,
} from "./types";
import { createHash } from "node:crypto";

export const sha256 = (value: string | Buffer): string => createHash("sha256").update(value).digest("hex");

function requireSafety(condition: unknown, reason: string): asserts condition {
	if (!condition) throw new Error(`SAFETY_GATE_FAILED: ${reason}`);
}

function exact(actual: string[], expected: string[]) {
	return JSON.stringify([...actual].sort()) === JSON.stringify([...expected].sort());
}

function assertCase(
	receipt: CaseReceipt,
	planned: QualificationCase,
	label: SafetyExpected,
	route: QualificationRoute,
) {
	const id = receipt.caseId;
	requireSafety(receipt.status === "evaluated" && receipt.stage === label.mode, `${id}: ${receipt.status}`);
	requireSafety(
		receipt.inputSha256 === planned.inputSha256 && receipt.logicalInputSha256 === planned.logicalInputSha256,
		`${id}: input binding`,
	);
	const issueKey = ({ itemId, issueClass, stage }: CaseReceipt["issues"][number]) =>
		JSON.stringify([itemId, issueClass, stage]);
	requireSafety(exact(receipt.issues.map(issueKey), label.caught.map(issueKey)), `${id}: issue coverage`);
	requireSafety(exact(receipt.retainedIds, label.retainedIds), `${id}: retained coverage`);
	requireSafety(
		exact(
			receipt.calls.map((call) => call.batchKey),
			planned.batches.map((batch) => batch.batchKey),
		),
		`${id}: batch coverage`,
	);
	if (label.mode === "deterministic") requireSafety(receipt.calls.length === 0, `${id}: deterministic egress`);
	else requireSafety(receipt.calls.length > 0, `${id}: missing real verifier evidence`);

	for (const call of receipt.calls) {
		const batch = planned.batches.find((entry) => entry.batchKey === call.batchKey);
		requireSafety(
			batch &&
				call.transport === "real" &&
				call.endpointSlot === route.endpointSlot &&
				call.routeSha256 === route.routeSha256 &&
				call.promptSha256 === batch.promptSha256 &&
				call.schemaSha256 === batch.schemaSha256 &&
				call.observedModel === route.model &&
				call.observedProvider?.toLowerCase() === route.downstreamProvider.toLowerCase() &&
				Boolean(call.responseId),
			`${id}: verifier provenance`,
		);
		requireSafety(
			exact(
				call.verdicts.map(({ itemId }) => itemId),
				batch.itemIds,
			),
			`${id}: batch verdict coverage`,
		);
		requireSafety(
			call.costMicros === null
				? call.heldMicros === batch.boundMicros
				: Number.isSafeInteger(call.costMicros) &&
						call.costMicros >= 0 &&
						call.costMicros <= batch.boundMicros &&
						call.heldMicros === 0,
			`${id}: verifier cost`,
		);
	}
	if (label.mode === "semantic") {
		const expectedVerdicts = [
			...label.retainedIds.map((itemId) => JSON.stringify([itemId, null])),
			...label.caught
				.filter((issue) => issue.stage === "semantic")
				.map(({ itemId, issueClass }) => JSON.stringify([itemId, issueClass])),
		];
		const actualVerdicts = receipt.calls.flatMap((call) =>
			call.verdicts.map(({ itemId, issueClass }) => JSON.stringify([itemId, issueClass])),
		);
		requireSafety(exact(actualVerdicts, expectedVerdicts), `${id}: semantic coverage`);
	}
	const measured = receipt.calls.reduce((sum, call) => sum + (call.costMicros ?? 0), 0);
	const held = receipt.calls.reduce((sum, call) => sum + call.heldMicros, 0);
	requireSafety(measured + held <= 200000, `${id}: case cap`);
	return { measured, held };
}

type SuiteVerdict = { suite: string; passed: true } | { suite: string; passed: false; reason: string };

export function scorePipelineSafety(
	manifest: QualificationManifest,
	expected: readonly SafetyExpected[],
	receipts: QualificationReceipts,
): SuiteVerdict[] {
	requireSafety(
		receipts.version === 1 &&
			manifest.version === 1 &&
			receipts.manifestSha256 === sha256(JSON.stringify(manifest)) &&
			receipts.buildSha256 === manifest.buildSha256 &&
			receipts.campaignId === manifest.campaignId,
		"manifest or build binding",
	);
	const labels = new Map(expected.map((label) => [label.id, label]));
	requireSafety(labels.size === expected.length && labels.size > 0, "expectation coverage");
	const plannedLabels = new Set(manifest.suites.flatMap(({ cases }) => cases.map(({ id }) => id)));
	requireSafety(
		plannedLabels.size === labels.size && [...plannedLabels].every((id) => labels.has(id)),
		"expectation coverage",
	);
	const suites = new Map(manifest.suites.map((suite) => [suite.id, new Map<string, CaseReceipt[]>()]));
	requireSafety(suites.size === manifest.suites.length, "duplicate suite");
	let totalMeasured = 0;
	let totalHeld = 0;
	for (const receipt of receipts.cases) {
		const cases = suites.get(receipt.suite);
		requireSafety(cases, "unexpected receipt suite");
		const matches = cases.get(receipt.caseId) ?? [];
		matches.push(receipt);
		cases.set(receipt.caseId, matches);
		for (const call of receipt.calls) {
			requireSafety(
				(call.costMicros === null || (Number.isSafeInteger(call.costMicros) && call.costMicros >= 0)) &&
					Number.isSafeInteger(call.heldMicros) &&
					call.heldMicros >= 0,
				"campaign cap or receipt totals",
			);
			totalMeasured += call.costMicros ?? 0;
			totalHeld += call.heldMicros;
		}
	}
	requireSafety(
		totalMeasured === receipts.totalMeasuredMicros &&
			totalHeld === receipts.totalHeldMicros &&
			totalMeasured + totalHeld <= manifest.maxRunMicros,
		"campaign cap or receipt totals",
	);

	return manifest.suites.map((suite): SuiteVerdict => {
		try {
			const cases = suites.get(suite.id) ?? new Map<string, CaseReceipt[]>();
			let spent = 0;
			for (const planned of suite.cases) {
				const matches = cases.get(planned.id);
				const receipt = matches?.[0];
				const label = labels.get(planned.id);
				const route = manifest.routes.find(
					(route) =>
						route.routeSha256 === (planned.routeSha256 ?? suite.routeSha256) &&
						(!planned.feature || planned.feature === route.feature),
				);
				requireSafety(
					matches?.length === 1 && receipt && label && route && planned.writerModel === route.writerModel,
					`${suite.id}/${planned.id}: case binding`,
				);
				const { measured, held } = assertCase(receipt, planned, label, route);
				spent += measured + held;
				cases.delete(planned.id);
			}
			requireSafety(cases.size === 0, `${suite.id}: unexpected receipts`);
			requireSafety(spent <= suite.capMicros, `${suite.id}: suite cap`);
			return { suite: suite.id, passed: true };
		} catch (error) {
			if (!(error instanceof Error) || !error.message.startsWith("SAFETY_GATE_FAILED: ")) throw error;
			return { suite: suite.id, passed: false, reason: error.message };
		}
	});
}

export function assertPipelineSafety(
	manifest: QualificationManifest,
	expected: readonly SafetyExpected[],
	receipts: QualificationReceipts,
): void {
	const failed = scorePipelineSafety(manifest, expected, receipts).find((verdict) => !verdict.passed);
	if (failed) throw new Error(failed.reason);
}
