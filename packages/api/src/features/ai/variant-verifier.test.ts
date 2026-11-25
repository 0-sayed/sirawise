import type { VariantSnapshot } from "./variant-types";
import { readFileSync } from "node:fs";
import { expect, it } from "vite-plus/test";
import { variantReviewHandlers } from "./variant-handlers";
import {
	assertVariantVerification,
	buildVariantVerificationPayload,
	filterVariantVerification,
	variantVerifierPrompt,
	variantVerifierSchema,
} from "./variant-verifier";
import { verificationFailureDetail } from "./verification-failure";

const snapshot: VariantSnapshot = {
	category: "translation",
	resumeId: "language-copy",
	sourceRevision: "revision",
	direction: "en-ar",
	cv: [{ id: "fact", section: "summary", text: "Used React." }],
	jobAd: null,
};
const output = {
	direction: "en-ar",
	sourceRevision: "revision",
	segments: [
		{
			sourceId: "fact",
			text: "استخدم React.",
			claims: [{ id: "claim", text: "استخدم React.", evidenceIds: ["fact"], kind: "translation" }],
		},
	],
	notes: [],
};
const verdict = {
	schemaVersion: 1,
	verdicts: [
		{ claimId: "segment:fact:claim", verdict: "supported", evidenceIds: ["fact"], reason: "The source supports it." },
	],
	retention: { status: "retained", evidenceIds: ["fact"], reason: "All source facts survive." },
	absence: [],
	coverage: { status: "complete", reason: "Every response assertion was checked." },
	premises: [],
	quality: {
		status: "unclear",
		reason: "No translation-quality assessment was requested for this claim-verification output.",
	},
};

it("explicitly requests a separate translation-quality assessment in the complete verifier task", () => {
	const payload = buildVariantVerificationPayload(snapshot, output);
	const task = payload.selections.find((entry) => "id" in entry && entry.id === "variant-verification-task");
	expect(JSON.parse(task?.text ?? "null")).toMatchObject({
		category: "translation",
		translationQuality: {
			requested: true,
			scope: "every_segment",
			dimensions: ["accuracy", "fluency", "terminology", "locale", "style"],
			report: "quality.reason",
			format: "compact_mqm_json",
			offsets: "UTF-16",
			maxErrors: 4,
		},
	});
	const response = payload.selections.find((entry) => "id" in entry && entry.id === "variant-response");
	expect(JSON.parse(response?.text ?? "null")).toEqual(output);
});

it("keeps the observed unassessed quality response advisory after complete factual verification", () => {
	expect(variantVerifierSchema.safeParse(verdict).success).toBe(true);
	expect(() => assertVariantVerification(snapshot, output, verdict)).not.toThrow();
});

it("requires translation facts to stay bound to their source segment when adjacent segments split a phrase", () => {
	expect(variantVerifierPrompt).toContain("source-to-segment association is mandatory");
	expect(variantVerifierPrompt).toContain("use neighboring text only to resolve the phrase's meaning");
	expect(variantVerifierPrompt).toContain(
		"Verify every segment against its own source without moving, adding, omitting, or altering facts.",
	);
});

it.each(["partially", "unsupported", "contradicted"])(
	"still withholds %s factual claims when translation quality is unclear",
	(status) => {
		expect(() =>
			assertVariantVerification(snapshot, output, {
				...verdict,
				verdicts: [{ ...verdict.verdicts[0], verdict: status }],
			}),
		).toThrow("AI_VERIFICATION_FAILED");
	},
);

it.each(["lost", "unclear"])("still withholds %s fact retention with advisory quality", (status) => {
	expect(() =>
		assertVariantVerification(snapshot, output, { ...verdict, retention: { ...verdict.retention, status } }),
	).toThrow("AI_VERIFICATION_FAILED");
});

it("still requires exact claim coverage and valid evidence with advisory quality", () => {
	expect(() => assertVariantVerification(snapshot, output, { ...verdict, verdicts: [] })).toThrow(
		"AI_VERIFICATION_INCOMPLETE",
	);
	expect(() =>
		assertVariantVerification(snapshot, output, {
			...verdict,
			verdicts: [{ ...verdict.verdicts[0], evidenceIds: ["job-only"] }],
		}),
	).toThrow("AI_VERIFICATION_CITATION");
	expect(() =>
		assertVariantVerification(snapshot, output, {
			...verdict,
			coverage: { status: "unclear", reason: "Incomplete inspection." },
		}),
	).toThrow("AI_VERIFICATION_FAILED");
});

it("rejects adjacent and invented CV segment citations in translation verdicts", () => {
	const splitSnapshot: VariantSnapshot = {
		...snapshot,
		cv: [
			{ id: "s1q", section: "experience", text: "Built a gateway that routes requests and also" },
			{ id: "s1r", section: "experience", text: "supports direct AI API calls." },
		],
	};
	const splitOutput = {
		...output,
		segments: [
			{
				sourceId: "s1q",
				text: "بنيت بوابة توجّه الطلبات وتدعم أيضًا",
				claims: [
					{ id: "s1q-1", kind: "translation", text: "بنيت بوابة توجّه الطلبات وتدعم أيضًا", evidenceIds: ["s1q"] },
				],
			},
			{
				sourceId: "s1r",
				text: "إجراء طلبات مباشرة إلى واجهات برمجة تطبيقات الذكاء الاصطناعي.",
				claims: [
					{
						id: "s1r-1",
						kind: "translation",
						text: "إجراء طلبات مباشرة إلى واجهات برمجة تطبيقات الذكاء الاصطناعي.",
						evidenceIds: ["s1r"],
					},
				],
			},
		],
		notes: [],
	};
	const splitVerdict = {
		...verdict,
		retention: { status: "retained", evidenceIds: ["s1q", "s1r"], reason: "Both source segments retained." },
		verdicts: [
			{ claimId: "segment:s1q:s1q-1", verdict: "supported", evidenceIds: ["s1q", "s1r"], reason: "Split sentence." },
			{ claimId: "segment:s1r:s1r-1", verdict: "supported", evidenceIds: ["s1q", "s1r"], reason: "Split sentence." },
		],
	};
	expect(() => assertVariantVerification(splitSnapshot, splitOutput, splitVerdict)).toThrow("AI_VERIFICATION_CITATION");
	expect(() =>
		assertVariantVerification(splitSnapshot, splitOutput, {
			...splitVerdict,
			verdicts: [
				{ claimId: "segment:s1q:s1q-1", verdict: "supported", evidenceIds: ["s1r"], reason: "Missing own source." },
				splitVerdict.verdicts[1],
			],
		}),
	).toThrow("AI_VERIFICATION_CITATION");
	expect(() =>
		assertVariantVerification(splitSnapshot, splitOutput, {
			...splitVerdict,
			verdicts: [
				{ claimId: "segment:s1q:s1q-1", verdict: "supported", evidenceIds: ["s1q-1"], reason: "Claim id not source." },
				splitVerdict.verdicts[1],
			],
		}),
	).toThrow("AI_VERIFICATION_CITATION");

	// Per-segment translation withholding: throws on first pass (so worker regenerates), then withholds rejected segment with source text on second pass.
	const partialVerdict = {
		...splitVerdict,
		verdicts: [
			{ claimId: "segment:s1q:s1q-1", verdict: "supported", evidenceIds: ["s1q"], reason: "Supported." },
			{ claimId: "segment:s1r:s1r-1", verdict: "unsupported", evidenceIds: ["s1r"], reason: "Invented fact." },
		],
	};
	expect(() => filterVariantVerification(splitSnapshot, splitOutput, partialVerdict)).toThrow("AI_VERIFICATION_FAILED");
	const withheld = filterVariantVerification(splitSnapshot, splitOutput, partialVerdict, {
		allowSegmentWithholding: true,
	});
	const keptSegments = (withheld.output as typeof splitOutput).segments;
	expect(keptSegments[0]?.text).toBe("بنيت بوابة توجّه الطلبات وتدعم أيضًا");
	expect(keptSegments[1]?.text).toBe("supports direct AI API calls.");
	expect(withheld.withheld).toEqual({
		count: 1,
		rules: ["AI_VERIFICATION_CLAIM_SUPPORT"],
		items: [{ id: "s1r", reason: "AI_VERIFICATION_CLAIM_SUPPORT" }],
	});
	expect(() =>
		filterVariantVerification(
			splitSnapshot,
			splitOutput,
			{
				...partialVerdict,
				verdicts: partialVerdict.verdicts.map((v) => ({ ...v, verdict: "unsupported" })),
			},
			{ allowSegmentWithholding: true },
		),
	).toThrow("AI_VERIFICATION_FAILED");
});

it("keeps the translation quality task explicit while accepting supported unassessed checker JSON", () => {
	const schema = variantReviewHandlers["review.translation"].verifier?.output;
	expect(schema?.safeParse(verdict).success).toBe(true);
	expect(
		schema?.safeParse({ ...verdict, quality: { ...verdict.quality, assessment: "translation_language_quality" } })
			.success,
	).toBe(true);
});
it("accepts the exact observed unclear-quality response after all safety checks pass", () => {
	expect(() =>
		assertVariantVerification(snapshot, output, {
			...verdict,
			quality: {
				status: "unclear",
				reason:
					"Translation quality was not requested by the verifier task; no independent language-quality assessment can be inferred",
			},
		}),
	).not.toThrow();
});
it.each([
	["Used React for 12 projects.", "Used React for 13 projects."],
	["Used React at [NAME_0].", "Used React at another company."],
	["Used React.", "Used Salesforce."],
])("does not let advisory quality bypass deterministic checks for %s", (source, target) => {
	const segment = output.segments[0];
	const fact = snapshot.cv[0];
	const claim = segment?.claims[0];
	if (!segment || !fact || !claim) throw new Error("Missing translation fixture");
	const changed = { ...output, segments: [{ ...segment, text: target, claims: [{ ...claim, text: target }] }] };
	expect(() => assertVariantVerification({ ...snapshot, cv: [{ ...fact, text: source }] }, changed, verdict)).toThrow();
});

const recordedProductionVerdict = JSON.parse(
	readFileSync(new URL("./testing/fixtures/translation-verifier-supported.json", import.meta.url), "utf8"),
);
const productionSources = recordedProductionVerdict.verdicts.map((entry: { evidenceIds: string[] }) => ({
	id: entry.evidenceIds[0],
	section: "summary",
	text: "Used React for 12 projects.",
}));
const productionVerdict = {
	...recordedProductionVerdict,
	retention: {
		status: "retained",
		evidenceIds: productionSources.map(({ id }: { id: string }) => id),
		reason: "All segment facts retained.",
	},
};
const productionSnapshot: VariantSnapshot = { ...snapshot, cv: productionSources };
const productionOutput = {
	...output,
	segments: productionVerdict.verdicts.map((entry: { claimId: string; evidenceIds: string[] }) => ({
		sourceId: entry.evidenceIds[0],
		text: "استخدم React في 12 مشروعًا.",
		claims: [
			{
				id: entry.claimId.split(":").at(-1),
				text: "استخدم React في 12 مشروعًا.",
				evidenceIds: entry.evidenceIds,
				kind: "translation",
			},
		],
	})),
};
it("rejects the recorded production checker JSON with supported claims and null retention", () => {
	expect(recordedProductionVerdict.retention).toBeNull();
	expect(() => assertVariantVerification(productionSnapshot, productionOutput, recordedProductionVerdict)).toThrow(
		"AI_VERIFICATION_RETENTION_SCOPE",
	);
	expect(() => assertVariantVerification(productionSnapshot, productionOutput, productionVerdict)).not.toThrow();
});
it.each(["appropriate", "unclear", "no_change_needed"])(
	"accepts supported production claims with %s quality and explicit retention",
	(status) => {
		expect(() =>
			assertVariantVerification(productionSnapshot, productionOutput, {
				...productionVerdict,
				quality: { ...productionVerdict.quality, status },
			}),
		).not.toThrow();
	},
);
it.each(["unsupported", "contradicted"])("records the specific rejecting gate for %s production claims", (status) => {
	try {
		assertVariantVerification(productionSnapshot, productionOutput, {
			...productionVerdict,
			verdicts: productionVerdict.verdicts.map((entry: Record<string, unknown>, index: number) =>
				index ? entry : { ...entry, verdict: status },
			),
		});
		throw new Error("Expected factual rejection");
	} catch (error) {
		expect(error).toMatchObject({ message: "AI_VERIFICATION_FAILED", rule: "AI_VERIFICATION_CLAIM_SUPPORT" });
	}
});
it.each([
	["AI_VERIFICATION_CLAIM_IDS", { ...productionVerdict, verdicts: productionVerdict.verdicts.slice(1) }],
	[
		"AI_VERIFICATION_COVERAGE",
		{ ...productionVerdict, coverage: { status: "uncovered", reason: "Missing assertions." } },
	],
	[
		"AI_VERIFICATION_RETENTION",
		{ ...productionVerdict, retention: { status: "lost", evidenceIds: ["sbg"], reason: "Lost facts." } },
	],
	[
		"AI_VERIFICATION_CITATION",
		{
			...productionVerdict,
			verdicts: productionVerdict.verdicts.map((entry: Record<string, unknown>, index: number) =>
				index ? entry : { ...entry, evidenceIds: ["other"] },
			),
		},
	],
])("retains the private rejecting rule %s", (rule, checker) => {
	try {
		assertVariantVerification(productionSnapshot, productionOutput, checker);
		throw new Error("Expected verification rejection");
	} catch (error) {
		expect(verificationFailureDetail(error)).toEqual({ rule });
	}
});
it("requires complete segment coverage even with supported production verdicts", () => {
	try {
		assertVariantVerification(
			productionSnapshot,
			{ ...productionOutput, segments: productionOutput.segments.slice(1) },
			productionVerdict,
		);
		throw new Error("Expected segment rejection");
	} catch (error) {
		expect(verificationFailureDetail(error)).toEqual({ rule: "TRANSLATION_SEGMENT_IDS" });
	}
});
it("does not retain unknown exception text in private gate diagnostics", () => {
	expect(verificationFailureDetail(new Error("Private candidate text and sk-secret"))).toEqual({
		rule: "AI_VERIFICATION_UNKNOWN",
	});
});
it.each([
	["Used React for 12 projects.", "Used React for 13 projects.", "AI_UNSUPPORTED_CLAIM"],
	["Used React at [NAME_0].", "Used React.", "AI_LOST_FACT"],
	["Used React.", "Used Salesforce.", "AI_UNSUPPORTED_CLAIM"],
])("keeps deterministic safeguards for %s with null retention", (source, target, rule) => {
	const changedSource = {
		...productionSnapshot,
		cv: productionSources.map((fact: { id: string; section: string; text: string }, index: number) =>
			index ? fact : { ...fact, text: source },
		),
	};
	const changedOutput = {
		...productionOutput,
		segments: productionOutput.segments.map(
			(segment: { sourceId: string; text: string; claims: Array<Record<string, unknown>> }, index: number) =>
				index
					? segment
					: { ...segment, text: target, claims: segment.claims.map((claim) => ({ ...claim, text: target })) },
		),
	};
	try {
		assertVariantVerification(changedSource, changedOutput, productionVerdict);
		throw new Error("Expected deterministic rejection");
	} catch (error) {
		expect(verificationFailureDetail(error)).toEqual({ rule });
	}
});

it("compacts translation verifier task payloads and constrains translation schema retention to null", () => {
	const payload = buildVariantVerificationPayload(productionSnapshot, productionOutput);
	const taskSelection = payload.selections.find((entry) => "id" in entry && entry.id === "variant-verification-task");
	if (!taskSelection) throw new Error("Missing task selection");
	const task = JSON.parse(taskSelection.text);
	expect(task.claims[0]).not.toHaveProperty("text");
	expect(task.claims[0]).toEqual({
		id: expect.any(String),
		evidenceIds: expect.any(Array),
	});
});

it("splits large translation parts into two balanced verifier batches and merges per-segment withholding", async () => {
	const { buildVariantVerifierSchema, planVariantVerificationBatches, mergeBatchedVariantVerifications } =
		await import("./variant-verifier");
	const { isContentRejection } = await import("./content-retry");
	const { validateAndFilterVariantOutput } = await import("./variant-validation");

	expect(isContentRejection(new Error("TRANSLATION_UNCOVERED_TEXT"))).toBe(true);

	const manyCv = Array.from({ length: 14 }, (_, idx) => ({
		id: `s${idx}`,
		section: idx < 7 ? "experience" : "projects",
		text: `Built system ${idx} with Node.js.`,
	}));
	const manySnapshot: VariantSnapshot = {
		category: "translation",
		resumeId: "copy",
		sourceRevision: "rev-1",
		direction: "en-ar",
		jobAd: null,
		cv: manyCv,
	};
	const manyOutput = {
		direction: "en-ar" as const,
		sourceRevision: "rev-1",
		segments: manyCv.map((fact) => ({
			sourceId: fact.id,
			text: `أنشأت النظام ${fact.id.slice(1)} باستخدام Node.js.`,
			claims: [
				{
					id: `${fact.id}-1`,
					text: `أنشأت النظام ${fact.id.slice(1)} باستخدام Node.js.`,
					evidenceIds: [fact.id],
					kind: "translation" as const,
				},
			],
		})),
		notes: [],
	};

	// Translation verifier schema allows null, retained, or lost (never unclear) so valid retained/lost
	// assessments pass schema checks while unclear "not applicable" responses are disallowed.
	const singlePayload = buildVariantVerificationPayload(manySnapshot, manyOutput);
	const schema = buildVariantVerifierSchema(singlePayload);
	const baseVerdict = {
		schemaVersion: 1,
		verdicts: manyCv.map((fact) => ({
			claimId: `segment:${fact.id}:${fact.id}-1`,
			verdict: "supported",
			evidenceIds: [fact.id],
			reason: "Supported.",
		})),
		absence: [],
		coverage: { status: "complete", reason: "Complete." },
		premises: [],
		quality: { assessment: "translation_language_quality", status: "appropriate", reason: '{"mqm":[]}' },
	};
	expect(schema.safeParse({ ...baseVerdict, retention: null }).success).toBe(false);
	expect(
		schema.safeParse({
			...baseVerdict,
			retention: { status: "retained", evidenceIds: ["s0"], reason: "Retained." },
		}).success,
	).toBe(true);
	expect(
		schema.safeParse({
			...baseVerdict,
			retention: { status: "lost", evidenceIds: ["s0"], reason: "Dropped fact." },
		}).success,
	).toBe(true);
	expect(
		schema.safeParse({
			...baseVerdict,
			retention: { status: "unclear", evidenceIds: ["s0"], reason: "Unable to verify." },
		}).success,
	).toBe(true);

	// 14 segments split into 2 balanced verifier batches (7 + 7), cutting single-call verifier latency in half.
	const plan = planVariantVerificationBatches(manySnapshot, manyOutput);
	expect(plan.batches).toHaveLength(2);
	expect(plan.batches[0]?.itemIds).toHaveLength(7);
	expect(plan.batches[1]?.itemIds).toHaveLength(7);

	const verdicts = plan.batches.map((batch) => ({
		schemaVersion: 1,
		verdicts: batch.snapshot.cv.map((fact) => ({
			claimId: `segment:${fact.id}:${fact.id}-1`,
			verdict: fact.id === "s3" ? "unsupported" : "supported",
			evidenceIds: [fact.id],
			reason: fact.id === "s3" ? "Unsupported detail." : "Supported.",
		})),
		retention: { status: "retained", evidenceIds: batch.snapshot.cv.map(({ id }) => id), reason: "Retained." },
		absence: [],
		coverage: { status: "complete", reason: "Complete." },
		premises: [],
		quality: { assessment: "translation_language_quality", status: "appropriate", reason: '{"mqm":[]}' },
	}));

	// Without allowSegmentWithholding (first generation), rejected segment triggers regenerate.
	expect(() =>
		mergeBatchedVariantVerifications(
			manySnapshot,
			manyOutput,
			plan.batches.map((batch, index) => ({
				snapshot: batch.snapshot,
				output: batch.output,
				verdict: verdicts[index],
			})),
		),
	).toThrow("AI_VERIFICATION_FAILED");

	// With allowSegmentWithholding (after regenerate), only s3 is kept at original source text.
	const merged = mergeBatchedVariantVerifications(
		manySnapshot,
		manyOutput,
		plan.batches.map((batch, index) => ({
			snapshot: batch.snapshot,
			output: batch.output,
			verdict: verdicts[index],
		})),
		undefined,
		{ allowSegmentWithholding: true },
	);
	expect(merged.withheld).toMatchObject({
		count: 1,
		rules: ["AI_VERIFICATION_CLAIM_SUPPORT"],
		items: [{ id: "s3", reason: "AI_VERIFICATION_CLAIM_SUPPORT" }],
	});
	const mergedSegments = (merged.output as typeof manyOutput).segments;
	expect(mergedSegments.find((s) => s.sourceId === "s3")?.text).toBe("Built system 3 with Node.js.");
	expect(mergedSegments.find((s) => s.sourceId === "s0")?.text).toBe("أنشأت النظام 0 باستخدام Node.js.");

	// Deterministic guard withholding on regenerate: one TRANSLATION_UNCOVERED_TEXT segment only withholds that segment.
	const uncoveredOutput = {
		...manyOutput,
		segments: manyOutput.segments.map((seg) =>
			seg.sourceId === "s2"
				? {
						...seg,
						text: "New Valley Innovates Hackathon",
						claims: seg.claims.map((claim) => ({ ...claim, text: "هاكاثون New Valley Innovates" })),
					}
				: seg,
		),
	};
	expect(() => validateAndFilterVariantOutput(manySnapshot, uncoveredOutput)).toThrow("TRANSLATION_UNCOVERED_TEXT");
	const guardFiltered = validateAndFilterVariantOutput(manySnapshot, uncoveredOutput, {
		allowSegmentWithholding: true,
	});
	expect(guardFiltered.withheld).toMatchObject({
		count: 1,
		rules: ["TRANSLATION_UNCOVERED_TEXT"],
		items: [{ id: "s2", reason: "TRANSLATION_UNCOVERED_TEXT" }],
	});
	if (guardFiltered.kind !== "review.translation") throw new Error("Expected translation");
	expect(guardFiltered.output.segments.find((s) => s.sourceId === "s2")?.text).toBe("Built system 2 with Node.js.");
});
