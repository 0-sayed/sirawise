import type { CaseReceipt, QualificationManifest, QualificationReceipts, SafetyExpected } from "./types";
import { expect, it } from "vite-plus/test";
import { completionTokenLimit } from "@reactive-resume/api/features/ai/route-policy";
import { qualificationBaseUrl, qualificationRouteBase, requireQualificationLimits } from "./cli";
import { effectiveQualificationRoute } from "./local-runtime";
import { assertPipelineSafety, scorePipelineSafety, sha256 } from "./run";

const issue = { itemId: "bad", issueClass: "addition", stage: "semantic" } as const;

it("qualifies all candidates at the runtime verifier limits and pricing policy", () => {
	const base = qualificationRouteBase("synthetic-key");
	for (const feature of ["translation", "job-evidence", "extraction", "wording"] as const) {
		const verifier = effectiveQualificationRoute({ feature }, base);
		const measured = feature === "translation" || feature === "job-evidence";
		expect(verifier).toMatchObject({
			model: "deepseek/deepseek-v4.1-flash-1017",
			downstreamProvider: "together",
			reasoningEffort: "low",
			maxOutputTokens: 16384,
			maxCallCostMicros: 100000,
			requestCapMicros: 200000,
			callTimeoutMs: measured ? 90000 : 60000,
			boundByTogetherPricing: measured,
		});
		expect(completionTokenLimit(verifier)).toBe(20480);
	}
});

it("rejects qualification approvals that would narrow the application route", () => {
	const verifier = effectiveQualificationRoute({ feature: "translation" }, qualificationRouteBase("synthetic-key"));
	const approval = {
		maxInputCodePoints: 32000,
		maxOutputTokens: 16384,
		maxCallCostMicros: 100000,
		inputMicrosPerMillionTokens: 300000,
		completionMicrosPerMillionTokens: 1200000,
		feeBasisPoints: 550,
		fixedFeeMicros: 0,
		protocolOverheadTokens: 1024,
	};
	const approved = {
		campaignId: "synthetic",
		suiteCaps: {
			"job-evidence-primary": 672401,
			"extraction-primary": 1091956,
		} as const,
		routes: { translation: approval },
	};
	expect(requireQualificationLimits(verifier, "translation", approved)).toEqual(approval);
	expect(() =>
		requireQualificationLimits(verifier, "translation", {
			...approved,
			routes: { translation: { ...approval, maxOutputTokens: 3276 } },
		}),
	).toThrow("QUALIFICATION_LIMITS_UNAPPROVED");
});
const expected: SafetyExpected[] = [
	{ id: "mixed", mode: "semantic", caught: [issue], retainedIds: ["good"] },
	{ id: "local", mode: "deterministic", caught: [{ ...issue, stage: "deterministic" }], retainedIds: [] },
];
const route = {
	feature: "translation" as const,
	endpointSlot: "primary" as const,
	endpoint: "https://openrouter.ai/api/v1",
	model: "fixture/verifier",
	downstreamProvider: "Test",
	writerModel: "fixture/writer",
	promptVersion: "compact",
	schemaVersion: "compact",
	reasoningEffort: "low" as const,
	routeSha256: "a".repeat(64),
	promptSha256: "b".repeat(64),
	schemaSha256: "c".repeat(64),
	limits: { maxInputCodePoints: 2000, maxOutputTokens: 500, maxCallCostMicros: 50, callTimeoutMs: 1000 },
};
const batch = {
	batchKey: "part",
	itemIds: ["bad", "good"],
	promptSha256: route.promptSha256,
	schemaSha256: route.schemaSha256,
	boundMicros: 50,
};
const inputSha256 = "d".repeat(64);
const manifest: QualificationManifest = {
	version: 1,
	campaignId: "synthetic",
	fixtureIdentifierSeed: "a".repeat(64),
	fixturesSha256: "e".repeat(64),
	expectedSha256: "f".repeat(64),
	buildSha256: "1".repeat(64),
	implementationSha256: "2".repeat(64),
	maxRunMicros: 100,
	executables: [],
	routes: [route],
	suites: [
		{
			id: "translation-primary",
			routeSha256: route.routeSha256,
			capMicros: 100,
			cases: [
				{ id: "mixed", inputSha256, logicalInputSha256: inputSha256, writerModel: route.writerModel, batches: [batch] },
				{ id: "local", inputSha256, logicalInputSha256: inputSha256, writerModel: route.writerModel, batches: [] },
			],
		},
	],
};
const mixed: CaseReceipt = {
	suite: "translation-primary",
	caseId: "mixed",
	inputSha256,
	logicalInputSha256: inputSha256,
	plannedVerifier: { routeSha256: route.routeSha256, batches: [batch] },
	elapsedMs: 12,
	stage: "semantic",
	status: "evaluated",
	retainedIds: ["good"],
	issues: [issue],
	calls: [
		{
			batchKey: batch.batchKey,
			endpointSlot: "primary",
			transport: "real",
			routeSha256: route.routeSha256,
			promptSha256: batch.promptSha256,
			schemaSha256: batch.schemaSha256,
			observedModel: route.model,
			observedProvider: "Test",
			responseId: "synthetic-response",
			costMicros: 20,
			heldMicros: 0,
			elapsedMs: 10,
			verdicts: [
				{ itemId: "bad", issueClass: "addition" },
				{ itemId: "good", issueClass: null },
			],
		},
	],
};
const local: CaseReceipt = {
	...mixed,
	plannedVerifier: { routeSha256: route.routeSha256, batches: [] },
	caseId: "local",
	stage: "deterministic",
	retainedIds: [],
	issues: [{ ...issue, stage: "deterministic" }],
	calls: [],
};

function score(cases: CaseReceipt[], override: Partial<QualificationReceipts> = {}) {
	assertPipelineSafety(manifest, expected, {
		version: 1,
		campaignId: "synthetic",
		manifestSha256: sha256(JSON.stringify(manifest)),
		buildSha256: manifest.buildSha256,
		startedAt: "2026-11-24T00:00:00.000Z",
		finishedAt: "2026-11-24T00:01:00.000Z",
		totalMeasuredMicros: 20,
		totalHeldMicros: 0,
		cases,
		...override,
	});
}

it("accepts complete exact semantic and zero-egress deterministic evidence", () => {
	expect(() => score([mixed, local])).not.toThrow();
});

it.each(["missing", "failed", "duplicate"] as const)(
	"scores the other suites when one suite has %s evidence",
	(failure) => {
		const first = manifest.suites[0];
		if (!first) throw new Error("Missing suite fixture");
		const suites = [first, { ...first, id: "job-evidence-primary" }, { ...first, id: "extraction-primary" }];
		const plan = { ...manifest, suites };
		const broken =
			failure === "missing"
				? [local]
				: failure === "failed"
					? [{ ...mixed, status: "transport_failed" as const }, local]
					: [mixed, local, local];
		const cases = [
			...broken,
			...suites.slice(1).flatMap(({ id }) => [mixed, local].map((receipt) => ({ ...receipt, suite: id }))),
		];
		const receipts: QualificationReceipts = {
			version: 1,
			manifestSha256: sha256(JSON.stringify(plan)),
			buildSha256: plan.buildSha256,
			campaignId: plan.campaignId,
			startedAt: "2026-11-24T00:00:00.000Z",
			finishedAt: "2026-11-24T00:01:00.000Z",
			totalMeasuredMicros: failure === "missing" ? 40 : 60,
			totalHeldMicros: 0,
			cases,
		};
		expect(scorePipelineSafety(plan, expected, receipts)).toEqual([
			{ suite: "translation-primary", passed: false, reason: expect.stringContaining("SAFETY_GATE_FAILED") },
			{ suite: "job-evidence-primary", passed: true },
			{ suite: "extraction-primary", passed: true },
		]);
		expect(() => assertPipelineSafety(plan, expected, receipts)).toThrow("SAFETY_GATE_FAILED");
		expect(() => scorePipelineSafety(plan, expected, { ...receipts, totalHeldMicros: 1 })).toThrow(
			"campaign cap or receipt totals",
		);
	},
);

it.each([
	["missing", [mixed]],
	["duplicate", [mixed, local, local]],
	["unexpected", [mixed, { ...local, caseId: "extra" }]],
	["wrong sibling", [{ ...mixed, retainedIds: ["bad"], issues: [{ ...issue, itemId: "good" }] }, local]],
	["wrong class", [{ ...mixed, issues: [{ ...issue, issueClass: "omission" }] }, local]],
	["transport failure", [{ ...mixed, status: "transport_failed" }, local]],
	["refusal", [{ ...mixed, status: "refused" }, local]],
	["invalid schema", [{ ...mixed, status: "invalid_verdict" }, local]],
	["missing verdict", [{ ...mixed, status: "incomplete_verdict" }, local]],
	["deterministic dispatch", [mixed, { ...local, calls: mixed.calls }]],
] satisfies [string, CaseReceipt[]][])("rejects %s evidence", (_name, cases) => {
	expect(() => score(cases)).toThrow("SAFETY_GATE_FAILED");
});

it.each([
	{ transport: "stub" },
	{ endpointSlot: "backup" },
	{ routeSha256: "3".repeat(64) },
	{ observedModel: null },
	{ observedModel: "fixture/other" },
	{ observedProvider: null },
	{ observedProvider: "Other" },
	{ verdicts: [{ itemId: "good", issueClass: null }] },
] satisfies Partial<CaseReceipt["calls"][number]>[])("rejects unsound verifier evidence %o", (override) => {
	const [call] = mixed.calls;
	if (!call) throw new Error("Missing fixture call");
	expect(() => score([{ ...mixed, calls: [{ ...call, ...override }] }, local])).toThrow("SAFETY_GATE_FAILED");
});

it("rejects stale manifest and build digests", () => {
	expect(() => score([mixed, local], { manifestSha256: "4".repeat(64) })).toThrow("SAFETY_GATE_FAILED");
	expect(() => score([mixed, local], { buildSha256: "4".repeat(64) })).toThrow("SAFETY_GATE_FAILED");
});

it("rejects verdicts swapped between independently bound batches", () => {
	const plan = structuredClone(manifest);
	const planned = plan.suites[0]?.cases[0];
	const [call] = mixed.calls;
	const [bad, good] = call?.verdicts ?? [];
	if (!planned || !call || !bad || !good) throw new Error("Missing fixture case");
	planned.batches = [
		{ ...batch, itemIds: ["bad"] },
		{ ...batch, batchKey: "part-2", itemIds: ["good"] },
	];
	const receipts: QualificationReceipts = {
		version: 1,
		manifestSha256: sha256(JSON.stringify(plan)),
		buildSha256: plan.buildSha256,
		campaignId: plan.campaignId,
		startedAt: "2026-11-24T00:00:00.000Z",
		finishedAt: "2026-11-24T00:01:00.000Z",
		totalMeasuredMicros: 40,
		totalHeldMicros: 0,
		cases: [
			{
				...mixed,
				calls: [
					{ ...call, verdicts: [good] },
					{ ...call, batchKey: "part-2", verdicts: [bad] },
				],
			},
			local,
		],
	};
	expect(() => assertPipelineSafety(plan, expected, receipts)).toThrow("SAFETY_GATE_FAILED");
});

it("accepts only an explicit IPv4 loopback origin on a dedicated qualification port", () => {
	expect(qualificationBaseUrl("http://127.0.0.1:3140")).toBe("http://127.0.0.1:3140");
	for (const value of [
		"http://127.0.0.1",
		"http://127.0.0.1:0",
		"http://localhost:3140",
		"http://127.0.0.1:3140/",
		"http://127.0.0.1:3140?x=1",
		"http://127.0.0.1:3140@elsewhere.test",
		"https://127.0.0.1:3140",
	]) {
		expect(() => qualificationBaseUrl(value)).toThrow("QUALIFICATION_LOOPBACK_REQUIRED");
	}
});
