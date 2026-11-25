import type { ReviewSourceSnapshot } from "./review-sources";
import type { ReviewResult } from "@reactive-resume/schema/resume/ai-review";
import { blockText } from "@reactive-resume/resume/proposals";
import { replaceReviewPassageText, validateReviewEvidence } from "@reactive-resume/resume/review-evidence";
import { reviewResultSchema } from "@reactive-resume/schema/resume/ai-review";
import { assertHardFacts } from "./hard-facts";
import { filterExtractionProvenance } from "./review-provenance";
import { sameReviewSource } from "./review-sources";

export function parseReviewResultForSource(snapshot: ReviewSourceSnapshot, output: ReviewResult): ReviewResult {
	const result = reviewResultSchema.parse(output);
	if (!sameReviewSource(snapshot.source, result.sourceRevision)) throw new Error("AI_SOURCE_CHANGED");
	const validation = validateReviewEvidence(result, snapshot.evidence);
	if (!validation.ok) throw new Error(`AI_${validation.reason}`);
	return result;
}

export function validateReviewResult(snapshot: ReviewSourceSnapshot, output: ReviewResult): ReviewResult {
	const result = parseReviewResultForSource(snapshot, output);
	const evidence = new Map(snapshot.evidence.map((entry) => [entry.id, entry]));
	const quotesFor = (ids: string[]) => ids.map((id) => evidence.get(id)?.quote ?? "").join(" ");
	if (result.kind === "wording") {
		for (const proposal of result.proposals) {
			const after = blockText(proposal.after);
			if (/<[^>]*>/u.test(after) || proposal.after !== replaceReviewPassageText(proposal.before, after))
				throw new Error("AI_INVALID_MARKUP");
			assertHardFacts(blockText(proposal.before), after, quotesFor(proposal.evidenceIds));
			for (const claim of proposal.claims) {
				if (claim.evidenceIds.some((id) => !proposal.evidenceIds.includes(id))) throw new Error("AI_INVALID_EVIDENCE");
				assertHardFacts(claim.text, claim.text, quotesFor(claim.evidenceIds));
			}
		}
		const sourceText = snapshot.evidence
			.filter((entry) => sameReviewSource(entry.source, snapshot.source))
			.map((entry) => entry.quote)
			.join(" ");
		const arabic = (sourceText.match(/\p{Script=Arabic}/gu) ?? []).length;
		const latin = (sourceText.match(/\p{Script=Latin}/gu) ?? []).length;
		// Accept either language in bilingual prose. A borrowed name or technical term is not enough.
		const arabicProse = /(?:\p{Script=Arabic}+[\p{M}]*[^\S\r\n]+){2}\p{Script=Arabic}/u.test(sourceText);
		const latinProse = /(?:\p{Script=Latin}+[\p{M}]*[^\S\r\n]+){2}\p{Script=Latin}/u.test(sourceText);
		const explanations = [
			...result.notes,
			...result.questions.map((question) => question.prompt),
			...result.proposals.map((proposal) => proposal.why),
		];
		for (const text of explanations) {
			const ar = (text.match(/\p{Script=Arabic}/gu) ?? []).length;
			const en = (text.match(/\p{Script=Latin}/gu) ?? []).length;
			if ((arabic > latin && en > ar && !latinProse) || (latin > arabic && ar > en && !arabicProse))
				throw new Error("AI_WRONG_LANGUAGE");
		}
	} else {
		const { withheld } = filterExtractionProvenance(snapshot, result);
		if (withheld[0]) throw new Error(withheld[0].reason);
	}
	return result;
}
