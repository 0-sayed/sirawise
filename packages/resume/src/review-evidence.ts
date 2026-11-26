import type { ReviewEvidence, ReviewProposal, ReviewResult } from "@reactive-resume/schema/resume/ai-review";
import type { ResumeData } from "@reactive-resume/schema/resume/data";
import { proposalTargetSchema, reviewProposalSchema } from "@reactive-resume/schema/resume/ai-review";
import { parseResumeDataForWrite } from "@reactive-resume/schema/resume/write";
import {
	applyTo,
	blockText,
	canApplyTo,
	proposalStart,
	readTarget,
	replaceBlockText,
	splitBlocks,
	writeTarget,
} from "./proposals";

/** An optimistic field fingerprint, never an authorization or evidence authenticity check. */
export function hashReviewTarget(value: string): string {
	let hash = 0xcbf29ce484222325n;
	for (const character of value) {
		hash ^= BigInt(character.codePointAt(0) ?? 0);
		hash = BigInt.asUintN(64, hash * 0x100000001b3n);
	}
	return `${value.length}:${hash.toString(16)}`;
}

export type ReviewValidation = { ok: true } | { ok: false; reason: string; proposalIds: string[] };
const sameSource = (a: ReviewEvidence["source"], b: ReviewEvidence["source"]) =>
	a.kind === b.kind && a.id === b.id && a.revision === b.revision;
const sameTarget = (a: ReviewEvidence["target"], b: ReviewEvidence["target"]) =>
	a?.sectionId === b?.sectionId && a?.itemId === b?.itemId && a?.roleId === b?.roleId && a?.field === b?.field;

/** Legacy pending proposals can cite a wider span than the one they show for approval. */
export function hasCompleteReviewScope(proposal: ReviewProposal, evidence: readonly ReviewEvidence[]) {
	const citedPassages = evidence.filter(
		(entry) => sameSource(entry.source, proposal.base) && proposal.evidenceIds.includes(entry.id),
	);
	const originalCount = splitBlocks(proposal.before).length;
	return originalCount > 1 ? citedPassages.length === originalCount : citedPassages.length <= originalCount;
}

export function replaceReviewPassageText(before: string, text: string) {
	const blocks = splitBlocks(before);
	const first = blocks[0];
	if (!first || blocks.length === 1) return replaceBlockText(before, text);
	// A merge can only remove adjacent paragraph siblings. List boundaries, empty blocks,
	// and other intervening markup cannot be consumed by a wording proposal.
	let remaining = before;
	for (const { html } of blocks) {
		if (!/^<p[\s>]/i.test(html) || !remaining.startsWith(html)) throw new Error("INVALID_REVIEW_MARKUP");
		remaining = remaining.slice(html.length).trimStart();
	}
	if (remaining) throw new Error("INVALID_REVIEW_MARKUP");
	return replaceBlockText(first.html, text);
}

export function repeatsUntouchedReviewPassage(
	value: string,
	proposal: Pick<ReviewProposal, "before" | "after" | "blockIndex">,
) {
	const start = proposalStart(value, proposal);
	if (start < 0) return false;
	const words = (text: string) =>
		` ${text
			.toLowerCase()
			.replace(/[^\p{L}\p{M}\p{N}]+/gu, " ")
			.trim()} `;
	const original = words(blockText(proposal.before));
	const replacement = words(blockText(proposal.after));
	const untouched = value.slice(0, start) + value.slice(start + proposal.before.length);
	return splitBlocks(untouched).some(({ text }) => {
		const passage = words(text);
		return passage.length > 2 && replacement.includes(passage) && !original.includes(passage);
	});
}

/** Positions in stored proposals always refer to the document before this review's changes. */
export function reviewProposalPosition(proposal: ReviewProposal, activeChanges: readonly ReviewProposal[]) {
	const index = proposal.blockIndex;
	if (index === undefined) return proposal;
	let position = index;
	for (const change of activeChanges) {
		if (!sameTarget(change.target, proposal.target) || change.blockIndex === undefined || change.blockIndex >= index)
			continue;
		position += splitBlocks(change.after).length - splitBlocks(change.before).length;
	}
	return { ...proposal, blockIndex: position };
}

export function validateReviewEvidence(result: ReviewResult, sources: readonly ReviewEvidence[]): ReviewValidation {
	const fail = (reason: string, proposalIds: string[] = []): ReviewValidation => ({ ok: false, reason, proposalIds });
	const authoritative = new Map(sources.map((evidence) => [evidence.id, evidence]));
	const supplied = new Map(result.evidence.map((evidence) => [evidence.id, evidence]));
	if (authoritative.size !== sources.length || supplied.size !== result.evidence.length)
		return fail("DUPLICATE_EVIDENCE");
	for (const evidence of result.evidence) {
		const actual = authoritative.get(evidence.id);
		if (
			!actual ||
			!sameSource(actual.source, evidence.source) ||
			actual.quote !== evidence.quote ||
			actual.factId !== evidence.factId ||
			actual.factRevision !== evidence.factRevision ||
			actual.confirmation !== evidence.confirmation ||
			!sameTarget(actual.target, evidence.target)
		)
			return fail("INVALID_EVIDENCE");
	}
	const entries = result.kind === "wording" ? result.proposals : result.candidates;
	if (
		new Set(entries.map((entry) => entry.id)).size !== entries.length ||
		new Set(result.questions.map((question) => question.id)).size !== result.questions.length
	)
		return fail("DUPLICATE_SUBJECT");
	for (const entry of [...entries, ...result.questions]) {
		if (!entry.evidenceIds.length) return fail("MISSING_EVIDENCE", [entry.id]);
		for (const evidenceId of entry.evidenceIds) {
			const evidence = supplied.get(evidenceId);
			if (!evidence) return fail("INVALID_EVIDENCE", [entry.id]);
			if (
				result.kind === "wording" &&
				(evidence.confirmation === "source_unconfirmed" ||
					("target" in entry && evidence.target && !sameTarget(evidence.target, entry.target)))
			)
				return fail("UNSUPPORTED_CLAIM", [entry.id]);
		}
	}
	if (
		result.kind === "wording" &&
		result.proposals.some((proposal) => !sameSource(proposal.base, result.sourceRevision))
	)
		return fail("STALE_SOURCE");
	return { ok: true };
}

function assertTarget(data: ResumeData, proposal: ReviewProposal): string {
	const target = proposalTargetSchema.parse(proposal.target);
	if (target.sectionId !== "summary") {
		const builtin = Object.hasOwn(data.sections, target.sectionId)
			? data.sections[target.sectionId as keyof typeof data.sections]
			: undefined;
		const custom = data.customSections.find((section) => section.id === target.sectionId);
		const type = builtin ? target.sectionId : custom?.type;
		if (
			!type ||
			![
				"experience",
				"education",
				"projects",
				"certifications",
				"volunteer",
				"awards",
				"publications",
				"references",
			].includes(type) ||
			(target.roleId && type !== "experience")
		)
			throw new Error("INVALID_REVIEW_TARGET");
	}
	const value = readTarget(data, target);
	if (value === undefined || hashReviewTarget(value) !== proposal.targetHash || !canApplyTo(value, proposal))
		throw new Error("STALE_REVIEW_TARGET");
	// Model replacements may only change a passage's plain text, retaining its existing wrapper.
	if (proposal.after !== replaceReviewPassageText(proposal.before, blockText(proposal.after)))
		throw new Error("INVALID_REVIEW_MARKUP");
	return value;
}

/** Rebase only across this review's active accepted changes, preserving the original full-field guard. */
export function rebaseReviewProposal(
	data: ResumeData,
	proposal: ReviewProposal,
	acceptedChanges: readonly ReviewProposal[],
): ReviewProposal {
	const current = readTarget(data, proposal.target);
	if (current === undefined) throw new Error("STALE_REVIEW_TARGET");
	let baseline = current;
	const active = acceptedChanges
		.filter((change) => sameTarget(change.target, proposal.target))
		.toSorted((a, b) => (a.blockIndex ?? -1) - (b.blockIndex ?? -1));
	// Restoring earlier blocks first puts each later change back at its original index.
	for (const change of active) {
		const restored = applyTo(baseline, { ...change, before: change.after, after: change.before });
		if (restored === undefined) throw new Error("STALE_REVIEW_TARGET");
		baseline = restored;
	}
	if (hashReviewTarget(baseline) !== proposal.targetHash) throw new Error("STALE_REVIEW_TARGET");
	const start = proposal.before ? proposalStart(baseline, proposal) : 0;
	if (
		start < 0 ||
		active.some((change) => {
			const changedStart = proposalStart(baseline, change);
			return changedStart < start + proposal.before.length && start < changedStart + change.before.length;
		})
	)
		throw new Error("STALE_REVIEW_TARGET");
	if (repeatsUntouchedReviewPassage(baseline, proposal)) throw new Error("DUPLICATE_REVIEW_CONTENT");
	const rebased = { ...reviewProposalPosition(proposal, active), targetHash: hashReviewTarget(current) };
	assertTarget(data, rebased);
	return rebased;
}

export function applyReviewProposals(
	data: ResumeData,
	proposals: readonly ReviewProposal[],
	acceptedChanges: readonly ReviewProposal[] = [],
): ResumeData {
	if (!proposals.length || new Set(proposals.map((proposal) => proposal.id)).size !== proposals.length)
		throw new Error("INVALID_REVIEW_BATCH");
	const grouped = new Map<
		string,
		{
			target: ReviewProposal["target"];
			value: string;
			spans: { start: number; end: number; proposal: ReviewProposal }[];
		}
	>();
	for (const input of proposals) {
		const proposal = rebaseReviewProposal(data, reviewProposalSchema.parse(input), acceptedChanges);
		const value = readTarget(data, proposal.target);
		if (value === undefined) throw new Error("STALE_REVIEW_TARGET");
		const key = JSON.stringify([
			proposal.target.sectionId,
			proposal.target.itemId,
			proposal.target.roleId,
			proposal.target.field,
		]);
		const group = grouped.get(key) ?? { target: proposal.target, value, spans: [] };
		const start = proposalStart(value, proposal);
		const end = start + proposal.before.length;
		if (group.spans.some((span) => (start < span.end && end > span.start) || start === span.start))
			throw new Error("OVERLAPPING_REVIEW_PROPOSALS");
		group.spans.push({ start, end, proposal });
		grouped.set(key, group);
	}
	const next = structuredClone(data);
	for (const group of grouped.values()) {
		let value = group.value;
		// Work right-to-left against the original indices, so a replacement cannot create a later match.
		for (const { start, end, proposal } of group.spans.sort((a, b) => b.start - a.start)) {
			if (applyTo(group.value, proposal) === undefined) throw new Error("STALE_REVIEW_TARGET");
			value = value.slice(0, start) + proposal.after + value.slice(end);
		}
		writeTarget(next, group.target, value);
	}
	return parseResumeDataForWrite(next);
}
