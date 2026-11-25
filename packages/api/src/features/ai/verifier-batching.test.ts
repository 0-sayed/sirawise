import type { VariantSnapshot } from "./variant-types";
import { expect, it } from "vite-plus/test";
import {
	mergeBatchedVariantVerifications,
	planVariantVerificationBatches,
	variantVerificationInventory,
} from "./variant-verifier";
import {
	bindVerificationPass,
	createVerificationJournal,
	makeVerificationCall,
	readVerificationJournal,
} from "./verification-journal";

it("binds the one backup call to the original candidate and batch", () => {
	const { snapshot, output } = largeJobEvidenceFixture();
	const plan = planVariantVerificationBatches(snapshot, output);
	const binding = bindVerificationPass(
		1,
		output,
		plan.batches.map((_, index) => ({
			itemIds: [String(index)],
			payload: { selections: [] },
		})),
	);
	const [first, second] = binding.batchKeys;
	if (!first || !second) throw new Error("Missing batches");
	const failed = {
		...makeVerificationCall(first, 0, 20_000),
		outcome: "transient" as const,
		costMicros: 0,
		failure: {
			errorClass: "Error",
			message: "Unavailable",
			httpStatus: 503,
			bytesReceived: false,
			generationId: null,
		},
	};
	const backup = makeVerificationCall(first, 1, 10_000, "backup");
	const read = (...calls: Parameters<typeof createVerificationJournal>[1]) =>
		readVerificationJournal(createVerificationJournal(binding, calls));
	expect(read(failed, backup)?.latest.get(first)).toEqual(backup);
	expect(read(failed, { ...backup, batchKey: second })).toBeNull();
	expect(read(failed, backup, makeVerificationCall(first, 2, 20_000))).toBeNull();
});

function largeJobEvidenceFixture() {
	const longJobText =
		"Required: backend services, AI gateway, observability, evaluation datasets, regression tests, monitoring, release validation, access controls, audit trails, distributed collaboration. ".repeat(
			62,
		); // ~11 KB
	const snapshot: VariantSnapshot = {
		category: "job-evidence",
		resumeId: "cv-large",
		sourceRevision: "2026-11-22T06:00:00.000Z",
		cv: Array.from({ length: 18 }, (_, i) => ({
			id: `cv-${i}`,
			section: "experience",
			text: `Project ${i}: Built backend services, AI gateway, RabbitMQ processing, PostgreSQL schemas, Docker deployment, and observability features for production systems. `.repeat(
				4,
			),
		})), // ~11.5 KB
		jobAd: { segments: [{ id: "job-1", text: longJobText }] },
	};
	const output = {
		requirements: Array.from({ length: 35 }, (_, i) => ({
			id: `req-${i + 1}`,
			spanIds: ["job-1"],
			importance: "essential" as const,
			verdict: (i % 5 === 0 ? "no_evidence" : "partial") as "no_evidence" | "partial",
			evidenceIds: i % 5 === 0 ? [] : [`cv-${i % 18}`, `cv-${(i + 1) % 18}`],
			explanation:
				i % 5 === 0
					? `No evidence of specialized domain requirement ${i + 1} with extended compliance controls was found in this CV.`
					: `The CV documents backend services, AI gateway, and observability tooling for project ${i % 18} and project ${(i + 1) % 18}. It does not establish all aspects of requirement ${i + 1} across production monitoring and release validation.`,
		})),
		notes: ["The pasted job ad was supplied as a single pre-segmented span."],
	};
	return { snapshot, output };
}

function makeBatchVerdict(
	snapshot: VariantSnapshot,
	batchOutput: Record<string, unknown>,
	overrides: { unsupportedClaimIds?: string[]; coverage?: "complete" | "uncovered" } = {},
) {
	const inventory = variantVerificationInventory(snapshot, batchOutput);
	return {
		schemaVersion: 1,
		verdicts: inventory.claims.map((claim) => ({
			claimId: claim.id,
			verdict: overrides.unsupportedClaimIds?.includes(claim.id) ? "unsupported" : "supported",
			evidenceIds: claim.evidenceIds,
			reason: "Checked.",
		})),
		retention: inventory.retention
			? { status: "retained", evidenceIds: [snapshot.cv[0]?.id ?? "cv-0"], reason: "Kept." }
			: null,
		absence: inventory.absence.map((entry) => ({
			id: entry.id,
			verdict: "confirmed_absent",
		})),
		premises: inventory.premises.map((entry) => ({
			id: entry.id,
			verdict: "supported",
			reason: "Supported.",
		})),
		coverage: { status: overrides.coverage ?? "complete", reason: "Checked." },
		quality: { status: "appropriate", reason: "Appropriate." },
	};
}

it("never delivers a rejected note beside a supported requirement", () => {
	const { snapshot, output } = largeJobEvidenceFixture();
	output.notes.push("A second note about verified evidence.");
	const plan = planVariantVerificationBatches(snapshot, output);
	const batchResults = plan.batches.map((batch) => {
		const verdict = makeBatchVerdict(batch.snapshot, batch.output);
		const rejected = verdict.premises.find((entry) => entry.id === "note:0");
		if (rejected) rejected.verdict = "unsupported";
		return { ...batch, verdict };
	});
	const merged = mergeBatchedVariantVerifications(snapshot, output, batchResults, plan.oversizeWithheld);
	expect(merged.output.notes).toEqual([output.notes[1]]);
	expect(merged.output.requirements).toEqual(output.requirements);
	expect(merged.withheld?.items).toContainEqual({ id: "note:0", reason: "AI_VERIFICATION_PREMISE" });
});

it("targets nine job items and shrinks to the effective completion capacity", () => {
	const { snapshot, output } = largeJobEvidenceFixture();
	const short = {
		...snapshot,
		cv: [{ id: "cv", text: "Built TypeScript services.", section: "skills" }],
		jobAd: { segments: [{ id: "job-1", text: "Develop services." }] },
		jobEvidenceContract: { maxInputCodePoints: 32000, maxOutputTokens: 8192 },
	};
	const requirements = output.requirements.slice(0, 18).map((item) => ({
		...item,
		verdict: "partial",
		explanation: "Built TypeScript services.",
		evidenceIds: ["cv"],
	}));
	expect(
		planVariantVerificationBatches(short, { requirements: requirements.slice(0, 9), notes: [] }).batches,
	).toHaveLength(1);
	expect(
		planVariantVerificationBatches(short, { requirements, notes: [] }).batches.map((batch) => batch.itemIds.length),
	).toEqual([9, 9]);
	const capacity = { ...short, jobEvidenceContract: { maxInputCodePoints: 32000, maxOutputTokens: 1200 } };
	const absence = requirements.slice(0, 9).map((item) => ({ ...item, verdict: "no_evidence", evidenceIds: [] }));
	const reduced = planVariantVerificationBatches(capacity, { requirements: absence, notes: [] });
	expect(reduced.batches.length).toBeGreaterThan(1);
	expect(reduced.batches.every((batch) => JSON.stringify(batch.snapshot.cv) === JSON.stringify(short.cv))).toBe(true);
});

it("splits ~40 KB job-evidence verification under 32000 code points and verifies every requirement exactly once", () => {
	const { snapshot, output } = largeJobEvidenceFixture();
	const plan = planVariantVerificationBatches(snapshot, output, 32000);

	expect(plan.batches.length).toBeGreaterThan(1);
	expect(plan.oversizeWithheld).toBeUndefined();
	const seenIds: string[] = [];
	for (const batch of plan.batches) {
		expect([...JSON.stringify(batch.payload)].length).toBeLessThanOrEqual(32000);
		expect(batch.itemIds.length).toBeLessThanOrEqual(5);
		seenIds.push(...batch.itemIds);
	}
	expect(seenIds).toHaveLength(output.requirements.length);
	expect(new Set(seenIds).size).toBe(output.requirements.length);
	expect(seenIds).toEqual(output.requirements.map((r) => r.id));
});

it("merges batched verdicts in order, withholds only rejected items per batch, and fails on batch-level global errors", () => {
	const { snapshot, output } = largeJobEvidenceFixture();
	const plan = planVariantVerificationBatches(snapshot, output, 32000);

	const batchResults = plan.batches.map((batch) => ({
		snapshot: batch.snapshot,
		output: batch.output,
		verdict: makeBatchVerdict(batch.snapshot, batch.output, {
			unsupportedClaimIds: ["requirement:req-2", "requirement:req-30"],
		}),
	}));

	const merged = mergeBatchedVariantVerifications(snapshot, output, batchResults, plan.oversizeWithheld);
	expect(merged.batchCount).toBe(plan.batches.length);
	expect(merged.withheld).toEqual({
		count: 2,
		rules: ["AI_VERIFICATION_CLAIM_SUPPORT"],
		items: [
			{ id: "req-2", spanIds: ["job-1"], reason: "AI_VERIFICATION_CLAIM_SUPPORT" },
			{ id: "req-30", spanIds: ["job-1"], reason: "AI_VERIFICATION_CLAIM_SUPPORT" },
		],
	});
	const keptIds = (merged.output as typeof output).requirements.map((r) => r.id);
	expect(keptIds).toHaveLength(33);
	expect(keptIds).not.toContain("req-2");
	expect(keptIds).not.toContain("req-30");
	expect(keptIds[0]).toBe("req-1");
	expect(keptIds[1]).toBe("req-3");

	// Batch-level global failure (coverage uncovered) fails the whole operation
	const failedBatchResults = plan.batches.map((batch, index) => ({
		snapshot: batch.snapshot,
		output: batch.output,
		verdict: makeBatchVerdict(batch.snapshot, batch.output, {
			coverage: index === 1 ? "uncovered" : "complete",
		}),
	}));
	expect(() => mergeBatchedVariantVerifications(snapshot, output, failedBatchResults, plan.oversizeWithheld)).toThrow(
		expect.objectContaining({ message: "AI_VERIFICATION_FAILED", rule: "AI_VERIFICATION_COVERAGE" }),
	);
});

it("withholds a single oversize item with AI_VERIFICATION_INPUT_LIMIT while verifying the remaining items", () => {
	const snapshot: VariantSnapshot = {
		category: "job-evidence",
		resumeId: "cv-1",
		sourceRevision: "2026-11-22T06:00:00.000Z",
		cv: [
			{ id: "cv-small", section: "experience", text: "Built Node.js APIs." },
			{ id: "cv-huge", section: "experience", text: "Detailed architecture work. ".repeat(800) },
		],
		jobAd: { segments: [{ id: "job-1", text: "Required: Node.js APIs." }] },
	};
	const output = {
		requirements: [
			{
				id: "req-ok",
				spanIds: ["job-1"],
				importance: "essential" as const,
				verdict: "supported" as const,
				evidenceIds: ["cv-small"],
				explanation: "The CV documents Node.js APIs.",
			},
			{
				id: "req-oversize",
				spanIds: ["job-1"],
				importance: "essential" as const,
				verdict: "supported" as const,
				evidenceIds: ["cv-huge"],
				explanation: "The CV documents detailed architecture work.",
			},
		],
		notes: [],
	};

	const plan = planVariantVerificationBatches(snapshot, output, 4000);
	expect(plan.oversizeWithheld).toEqual({ count: 1, rules: ["AI_VERIFICATION_INPUT_LIMIT"] });
	expect(plan.batches).toHaveLength(1);
	expect(plan.batches[0]?.itemIds).toEqual(["req-ok"]);

	const merged = mergeBatchedVariantVerifications(
		snapshot,
		output,
		plan.batches.map((batch) => ({
			snapshot: batch.snapshot,
			output: batch.output,
			verdict: makeBatchVerdict(batch.snapshot, batch.output),
		})),
		plan.oversizeWithheld,
	);
	expect((merged.output as typeof output).requirements.map((r) => r.id)).toEqual(["req-ok"]);
	expect(merged.withheld).toEqual({ count: 1, rules: ["AI_VERIFICATION_INPUT_LIMIT"] });
});

it("caps each job-evidence verification batch at 3 items so reasoning verifiers stay within the 60s call timeout", () => {
	const snapshot: VariantSnapshot = {
		category: "job-evidence",
		resumeId: "cv",
		sourceRevision: "r1",
		cv: Array.from({ length: 15 }, (_, i) => ({
			id: `cv-${i}`,
			section: "experience",
			text: `Delivered platform milestone ${i}.`,
		})),
		jobAd: {
			segments: Array.from({ length: 15 }, (_, i) => ({
				id: `job-${i}`,
				text: `Requirement ${i}: deliver platform milestone ${i}.`,
			})),
		},
	};
	const output = {
		requirements: Array.from({ length: 15 }, (_, i) => ({
			id: `req-${i}`,
			spanIds: [`job-${i}`],
			importance: "unstated",
			verdict: "supported",
			evidenceIds: [`cv-${i}`],
			explanation: `CV documents milestone ${i}.`,
		})),
		notes: [],
	};
	const plan = planVariantVerificationBatches(snapshot, output);
	expect(plan.batches.length).toBe(5);
	for (const batch of plan.batches) {
		expect(batch.itemIds.length).toBeLessThanOrEqual(3);
	}
});
