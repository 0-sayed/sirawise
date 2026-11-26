import type { ModelPayload } from "./payload";
import { z } from "zod";
import { reviewClaimsSchema } from "@reactive-resume/schema/resume/ai-review";
import { claimKinds } from "./hard-facts";
import { buildModelPayload } from "./payload";
import { VerificationGateError } from "./verification-failure";

export const VERIFIER_VERSION = "t006-verifier-v5";
export const EXTRACTION_VERIFIER_VERSION = "extraction-verifier-v6-field-retention";
const identifier = z.string().min(1).max(500);
export const reviewVerifierSchema = z.strictObject({
	schemaVersion: z.literal(3),
	responseAssessment: z.strictObject({
		status: z.enum(["appropriate", "no_change_needed", "inappropriate", "unclear"]),
		reason: z.string().trim().min(1).max(600),
	}),
	factRetention: z.strictObject({
		status: z.enum(["retained", "lost", "unclear", "not_applicable"]),
		evidenceIds: z.array(identifier).max(50),
		reason: z.string().trim().min(1).max(600),
	}),
	verdicts: z
		.array(
			z.strictObject({
				claimId: identifier,
				verdict: z.enum(["supported", "partially", "unsupported", "contradicted"]),
				evidenceIds: z.array(identifier).min(1).max(50),
				reason: z.string().trim().min(1).max(600),
			}),
		)
		.max(200),
});
export type ReviewVerification = z.infer<typeof reviewVerifierSchema>;
export const extractionVerifierSchema = reviewVerifierSchema.extend({
	factRetention: reviewVerifierSchema.shape.factRetention.extend({
		failedClaimIds: z.array(identifier).max(100).optional(),
	}),
});

function readVerifierClaims(payload: ModelPayload) {
	const selection = payload.selections.find((entry) => "id" in entry && entry.id === "verification-claims");
	return z
		.array(z.object({ claimId: identifier, evidenceIds: z.array(identifier) }))
		.parse(JSON.parse(selection?.text ?? "null"));
}

function bindReviewVerdicts(items: ReturnType<typeof readVerifierClaims>) {
	const ids = items.map(({ claimId }) => claimId);
	const evidenceById = new Map(items.map(({ claimId, evidenceIds }) => [claimId, new Set(evidenceIds)]));
	const evidenceIds = [...new Set(items.flatMap((item) => item.evidenceIds))];
	return z
		.array(
			reviewVerifierSchema.shape.verdicts.element.extend({
				claimId: ids.length ? z.enum(ids) : identifier,
				evidenceIds: z
					.array(evidenceIds.length ? z.enum(evidenceIds) : identifier)
					.min(1)
					.max(50),
			}),
		)
		.length(ids.length)
		.refine(
			(rows) =>
				new Set(rows.map(({ claimId }) => claimId)).size === rows.length &&
				rows.every(
					({ claimId, evidenceIds }) =>
						new Set(evidenceIds).size === evidenceIds.length &&
						evidenceIds.every((id) => evidenceById.get(claimId)?.has(id)),
				),
			"Return each required claim ID exactly once with its own evidence IDs.",
		)
		.describe("One verdict per required claim ID, including each question.");
}

export function buildWordingVerifierSchema(payload: ModelPayload) {
	return reviewVerifierSchema.extend({ verdicts: bindReviewVerdicts(readVerifierClaims(payload)) });
}

export function buildExtractionVerifierSchema(payload: ModelPayload) {
	const items = readVerifierClaims(payload);
	const task = payload.selections.find((entry) => "id" in entry && entry.id === "verification-task");
	const { retentionApplicable } = z
		.object({ retentionApplicable: z.boolean() })
		.parse(JSON.parse(task?.text ?? "null"));
	const retention = extractionVerifierSchema.shape.factRetention;
	const candidateIds = items.map(({ claimId }) => claimId).filter((id) => !id.startsWith("question:"));
	return extractionVerifierSchema.extend({
		factRetention: retentionApplicable
			? retention.extend({
					status: z.enum(["retained", "lost", "unclear"]),
					failedClaimIds: z.array(z.enum(candidateIds)).max(candidateIds.length),
				})
			: retention.extend({
					status: z.literal("not_applicable"),
					evidenceIds: z.array(identifier).length(0),
					failedClaimIds: z.array(identifier).length(0),
				}),
		verdicts: bindReviewVerdicts(items),
	});
}

export function hasReviewEdits(output: Record<string, unknown>): boolean {
	return Array.isArray(output.proposals) && output.proposals.length > 0;
}
function hasExtractionValues(output: Record<string, unknown>): boolean {
	return Array.isArray(output.candidates) && output.candidates.some((candidate) => candidate.value !== null);
}

const claimsInput = z.object({
	proposals: z.array(z.object({ id: identifier, claims: reviewClaimsSchema })).optional(),
	candidates: z
		.array(
			z.object({
				id: identifier,
				section: identifier,
				field: identifier,
				value: z.unknown(),
				rawDateText: z.string().nullable(),
				evidenceIds: z.array(identifier),
			}),
		)
		.optional(),
});
export function verificationClaims(output: Record<string, unknown>) {
	const parsed = claimsInput.parse(output);
	const questions = z
		.array(z.object({ id: identifier, prompt: z.string(), evidenceIds: z.array(identifier) }))
		.parse(output.questions ?? []);
	const claims =
		parsed.proposals?.flatMap((p) =>
			p.claims.map((c) => ({ claimId: `${p.id}/${c.id}`, text: c.text, evidenceIds: c.evidenceIds })),
		) ??
		(parsed.candidates ?? [])
			.filter((c) => c.value !== null)
			.map((c) => ({
				claimId: c.id,
				text: JSON.stringify({ section: c.section, field: c.field, value: c.value, rawDateText: c.rawDateText }),
				evidenceIds: c.evidenceIds,
			}));
	return [
		...claims,
		...questions.map((q) => ({ claimId: `question:${q.id}`, text: q.prompt, evidenceIds: q.evidenceIds })),
	];
}
export function buildVerificationPayload(payload: ModelPayload, output: Record<string, unknown>): ModelPayload {
	const minimize = (text: string) =>
		text.trim()
			? (buildModelPayload({
					selections: [{ id: "response", kind: "model_proposed", section: "summary", text }],
					contactValues: [],
				}).selections[0]?.text ?? "")
			: "";
	const minimizeValue = (value: unknown): unknown => {
		if (typeof value === "string") return minimize(value);
		if (Array.isArray(value)) return value.map(minimizeValue);
		if (value && typeof value === "object")
			return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, minimizeValue(v)]));
		return value;
	};
	const claims = verificationClaims(output).map((c) => {
		const minimized = buildModelPayload({
			selections: [{ id: "claim", kind: "model_proposed", section: "summary", text: c.text }],
			contactValues: [],
		});
		return {
			...c,
			...("candidates" in output
				? {
						itemId: c.claimId.replace(/^question:/u, ""),
						itemType: c.claimId.startsWith("question:") ? "question" : "field",
					}
				: {}),
			text: minimized.selections[0]?.text ?? "",
			claimKinds: c.claimId.startsWith("question:") ? ["question-premises"] : claimKinds(c.text),
		};
	});
	// Source text was minimized by T005 already. Identifiers are structure, never redact them as phone numbers.
	return {
		selections: [
			...payload.selections.filter((s) => "id" in s && s.id !== "intent"),
			{
				id: "verification-task",
				kind: "model_proposed",
				section: "summary",
				text: JSON.stringify({
					intent: payload.selections.filter((s) => "id" in s && s.id === "intent").map((s) => s.text),
					operation: "candidates" in output ? "extraction" : "wording",
					retentionApplicable: "candidates" in output ? hasExtractionValues(output) : hasReviewEdits(output),
					...("candidates" in output ? { requiredClaimIds: claims.map(({ claimId }) => claimId) } : {}),
				}),
			},
			{
				id: "verification-response",
				kind: "model_proposed",
				section: "summary",
				text: JSON.stringify({
					proposals: Array.isArray(output.proposals)
						? output.proposals.map((p) => ({
								id: p.id,
								passageId: p.passageId,
								text: minimize(String(p.text ?? "")),
								reason: minimize(String(p.reason ?? "")),
								evidenceIds: p.evidenceIds,
							}))
						: [],
					candidates: Array.isArray(output.candidates)
						? output.candidates.map((c) => ({
								id: c.id,
								entityId: c.entityId,
								section: c.section,
								field: c.field,
								value: minimizeValue(c.value),
								rawDateText: c.rawDateText == null ? c.rawDateText : minimize(String(c.rawDateText)),
								evidenceIds: c.evidenceIds,
							}))
						: [],
					questions: Array.isArray(output.questions)
						? output.questions.map((q) => ({ ...q, prompt: minimize(String(q.prompt)) }))
						: [],
					notes: Array.isArray(output.notes) ? output.notes.map((n) => minimize(String(n))) : [],
				}),
			},
			{ id: "verification-claims", kind: "model_proposed", section: "summary", text: JSON.stringify(claims) },
		],
	};
}
export function assertVerification(output: Record<string, unknown>, raw: unknown): void {
	const result = reviewVerifierSchema.parse(raw);
	const claims = verificationClaims(output);
	// Response appropriateness is advisory quality, never permission to publish facts.
	if (
		result.factRetention.status !== "retained" &&
		(hasReviewEdits(output) || result.factRetention.status !== "not_applicable")
	)
		throw new VerificationGateError("AI_VERIFICATION_RETENTION", "AI_FACT_RETENTION_FAILED");
	const allowedIds = new Set(claims.flatMap((c) => c.evidenceIds));
	if (result.factRetention.evidenceIds.some((id) => !allowedIds.has(id))) throw new Error("AI_VERIFICATION_CITATION");
	if (
		new Set(claims.map((c) => c.claimId)).size !== claims.length ||
		new Set(result.verdicts.map((v) => v.claimId)).size !== result.verdicts.length ||
		result.verdicts.length !== claims.length
	)
		throw new VerificationGateError("AI_VERIFICATION_CLAIM_IDS", "AI_VERIFICATION_INCOMPLETE");
	for (const c of claims) {
		const v = result.verdicts.find((v) => v.claimId === c.claimId);
		if (!v || v.evidenceIds.some((id) => !c.evidenceIds.includes(id))) throw new Error("AI_VERIFICATION_CITATION");
		// Partial support leaves an unverified portion. Do not publish it as a safe proposal.
		if (v.verdict !== "supported") throw new VerificationGateError("AI_VERIFICATION_CLAIM_SUPPORT");
	}
}

export function filterReviewVerification(
	output: Record<string, unknown>,
	raw: unknown,
	options?: { completeWithholding: boolean; allowEmptyExtraction?: boolean | undefined },
) {
	const result = reviewVerifierSchema.parse(raw);
	if (
		result.factRetention.status !== "retained" &&
		(hasReviewEdits(output) || result.factRetention.status !== "not_applicable")
	)
		throw new VerificationGateError("AI_VERIFICATION_RETENTION", "AI_FACT_RETENTION_FAILED");
	return filterVerifiedClaims(output, result, options);
}

function filterVerifiedClaims(
	output: Record<string, unknown>,
	result: ReviewVerification,
	options?: {
		completeWithholding: boolean;
		allowEmptyExtraction?: boolean | undefined;
		retentionFailures?: Set<string>;
	},
): {
	output: Record<string, unknown>;
	withheld?: {
		count: number;
		rules: string[];
		items?: Array<{ id: string; field?: string; section?: string; reason?: string }>;
	};
} {
	const claims = verificationClaims(output);
	const allowedIds = new Set(claims.flatMap((c) => c.evidenceIds));
	if (result.factRetention.evidenceIds.some((id) => !allowedIds.has(id))) throw new Error("AI_VERIFICATION_CITATION");
	if (
		new Set(claims.map((c) => c.claimId)).size !== claims.length ||
		new Set(result.verdicts.map((v) => v.claimId)).size !== result.verdicts.length ||
		result.verdicts.length !== claims.length
	)
		throw new VerificationGateError("AI_VERIFICATION_CLAIM_IDS", "AI_VERIFICATION_INCOMPLETE");

	const rejectedClaimIds = new Set(options?.retentionFailures);
	for (const c of claims) {
		const v = result.verdicts.find((entry) => entry.claimId === c.claimId);
		if (!v || v.evidenceIds.some((id) => !c.evidenceIds.includes(id))) throw new Error("AI_VERIFICATION_CITATION");
		if (v.verdict !== "supported") rejectedClaimIds.add(c.claimId);
	}
	if (rejectedClaimIds.size === 0) return { output };

	const questions = Array.isArray(output.questions) ? (output.questions as Array<{ id: string }>) : [];
	const keptQuestions = questions.filter((q) => !rejectedClaimIds.has(`question:${q.id}`));
	const withheldItems: Array<{ id: string; field?: string; section?: string; reason?: string }> = [];

	if (Array.isArray(output.candidates)) {
		const candidates = output.candidates as Array<{ id: string; field?: string; section?: string; value?: unknown }>;
		const keptCandidates = candidates.filter((c) => !rejectedClaimIds.has(c.id));
		for (const c of candidates) {
			if (rejectedClaimIds.has(c.id)) {
				withheldItems.push({
					id: c.id,
					...(c.field ? { field: c.field } : {}),
					...(c.section ? { section: c.section } : {}),
					reason: options?.retentionFailures?.has(c.id) ? "AI_VERIFICATION_RETENTION" : "AI_VERIFICATION_CLAIM_SUPPORT",
				});
			}
		}
		for (const q of questions) {
			if (rejectedClaimIds.has(`question:${q.id}`)) {
				withheldItems.push({ id: `question:${q.id}`, reason: "AI_VERIFICATION_CLAIM_SUPPORT" });
			}
		}
		if (keptCandidates.length === 0 && keptQuestions.length === 0 && !options?.allowEmptyExtraction) {
			throw new VerificationGateError("AI_VERIFICATION_CLAIM_SUPPORT");
		}
		return {
			output: { ...output, candidates: keptCandidates, questions: keptQuestions },
			withheld: {
				count: withheldItems.length,
				rules: [...new Set(withheldItems.flatMap(({ reason }) => (reason ? [reason] : [])))],
				items: options?.completeWithholding ? withheldItems : withheldItems.slice(0, 50),
			},
		};
	}

	if (Array.isArray(output.proposals)) {
		const proposals = output.proposals as Array<{ id: string; claims?: Array<{ id: string }> }>;
		const keptProposals = proposals.filter((p) => {
			const pClaims = p.claims ?? [];
			return !pClaims.some((c) => rejectedClaimIds.has(`${p.id}/${c.id}`));
		});
		for (const p of proposals) {
			const pClaims = p.claims ?? [];
			if (pClaims.some((c) => rejectedClaimIds.has(`${p.id}/${c.id}`))) {
				withheldItems.push({ id: p.id, reason: "AI_VERIFICATION_CLAIM_SUPPORT" });
			}
		}
		for (const q of questions) {
			if (rejectedClaimIds.has(`question:${q.id}`)) {
				withheldItems.push({ id: `question:${q.id}`, reason: "AI_VERIFICATION_CLAIM_SUPPORT" });
			}
		}
		if (keptProposals.length === 0 && keptQuestions.length === 0) {
			throw new VerificationGateError("AI_VERIFICATION_CLAIM_SUPPORT");
		}
		return {
			output: { ...output, proposals: keptProposals, questions: keptQuestions },
			withheld: {
				count: withheldItems.length,
				rules: ["AI_VERIFICATION_CLAIM_SUPPORT"],
				items: withheldItems.slice(0, 50),
			},
		};
	}

	throw new VerificationGateError("AI_VERIFICATION_CLAIM_SUPPORT");
}

export function filterExtractionVerification(
	output: Record<string, unknown>,
	raw: unknown,
	options?: { allowEmptyResult: boolean },
) {
	const result = extractionVerifierSchema.parse(raw);
	const { status, evidenceIds, failedClaimIds = [] } = result.factRetention;
	const retentionFailures = new Set(failedClaimIds);
	const candidateClaims = new Map(
		verificationClaims(output)
			.filter(({ claimId }) => !claimId.startsWith("question:"))
			.map((claim) => [claim.claimId, claim]),
	);
	if (
		retentionFailures.size !== failedClaimIds.length ||
		(hasExtractionValues(output)
			? status === "retained"
				? retentionFailures.size > 0
				: status === "not_applicable" ||
					retentionFailures.size === 0 ||
					failedClaimIds.some((id) => !candidateClaims.get(id)?.evidenceIds.some((e) => evidenceIds.includes(e)))
			: status !== "not_applicable" || evidenceIds.length || retentionFailures.size)
	)
		throw new VerificationGateError("AI_VERIFICATION_RETENTION", "AI_FACT_RETENTION_FAILED");
	return filterVerifiedClaims(output, result, {
		completeWithholding: true,
		allowEmptyExtraction: options?.allowEmptyResult,
		retentionFailures,
	});
}
