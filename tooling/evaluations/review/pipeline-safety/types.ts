export type SafetyFeature = "translation" | "job-evidence" | "extraction" | "wording";
export type SafetyStage = "deterministic" | "semantic";
export type SafetyIssue = { itemId: string; issueClass: string; stage: SafetyStage };
export type SafetyInput = {
	id: string;
	feature: SafetyFeature;
	locale: "ar-SA" | "en-US";
	source: Record<string, unknown>;
	candidate: Record<string, unknown>;
};
export type SafetyExpected = { id: string; mode: SafetyStage; caught: SafetyIssue[]; retainedIds: string[] };
export type QualificationRoute = {
	feature: SafetyFeature;
	endpointSlot: "primary" | "backup";
	endpoint: string;
	model: string;
	downstreamProvider: string;
	reasoningEffort: string;
	writerModel: string;
	promptVersion: string;
	schemaVersion: string;
	verifierPromptVersion?: string;
	verifierSchemaVersion?: string;
	routeSha256: string;
	promptSha256: string;
	schemaSha256: string;
	limits: {
		maxInputCodePoints: number;
		maxOutputTokens: number;
		maxCallCostMicros: number;
		callTimeoutMs: number;
		completionTokenLimit?: number;
	};
};
export type QualificationBatch = {
	batchKey: string;
	itemIds: string[];
	promptSha256: string;
	schemaSha256: string;
	boundMicros: number;
	wireBytes?: number;
};
export type QualificationCase = {
	id: string;
	inputSha256: string;
	logicalInputSha256: string;
	writerModel: string;
	feature?: SafetyFeature;
	batches: QualificationBatch[];
	routeSha256?: string;
};
export function plannedVerifier(planned: QualificationCase, suiteRouteSha256: string) {
	return {
		routeSha256: planned.routeSha256 ?? suiteRouteSha256,
		batches: planned.batches.map(({ batchKey, promptSha256, schemaSha256 }) => ({
			batchKey,
			promptSha256,
			schemaSha256,
		})),
	};
}
export type QualificationSuite = {
	id: string;
	routeSha256: string;
	capMicros: number;
	cases: QualificationCase[];
};
export type QualificationManifest = {
	version: 1;
	campaignId: string;
	fixtureIdentifierSeed: string;
	fixturesSha256: string;
	expectedSha256: string;
	buildSha256: string;
	implementationSha256: string;
	maxRunMicros: number;
	routes: QualificationRoute[];
	executables: { path: string; sha256: string }[];
	suites: QualificationSuite[];
	callLimitViolations?: {
		suite: string;
		caseId: string;
		batchKey: string;
		wireBytes: number;
		derivedMicros: number;
		capMicros: number;
	}[];
};
export type QualificationCall = {
	batchKey: string;
	endpointSlot: "primary" | "backup";
	transport: "real" | "stub";
	routeSha256: string;
	promptSha256: string;
	schemaSha256: string;
	observedModel: string | null;
	observedProvider: string | null;
	responseId: string | null;
	costMicros: number | null;
	heldMicros: number;
	elapsedMs: number;
	adapterOutcome?: ApprovedStepResult["outcome"];
	outputTokens?: number | null;
	reasoningTokens?: number | null;
	verdicts: { itemId: string; issueClass: string | null }[];
};
export type CaseReceipt = {
	suite: string;
	caseId: string;
	inputSha256: string;
	logicalInputSha256: string;
	plannedVerifier: ReturnType<typeof plannedVerifier>;
	elapsedMs: number;
	stage: SafetyStage;
	status: "evaluated" | "transport_failed" | "refused" | "invalid_verdict" | "incomplete_verdict" | "budget_exhausted";
	unavailableHttpStatus?: number;
	retainedIds: string[];
	issues: SafetyIssue[];
	calls: QualificationCall[];
};
export type QualificationReceipts = {
	version: 1;
	manifestSha256: string;
	buildSha256: string;
	campaignId: string;
	startedAt: string;
	finishedAt: string;
	totalMeasuredMicros: number;
	totalHeldMicros: number;
	cases: CaseReceipt[];
};
import type { ApprovedStepResult } from "@reactive-resume/api/features/ai/adapter";
