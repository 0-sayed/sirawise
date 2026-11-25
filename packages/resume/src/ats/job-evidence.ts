import type { JobSpan, JobTermAnalysisInput, JobTermReport } from "@reactive-resume/schema/job-evidence";
import type { ProposalTarget } from "@reactive-resume/schema/resume/ai-review";
import type { ResumeData } from "@reactive-resume/schema/resume/data";
import { jobTermAnalysisInputSchema } from "@reactive-resume/schema/job-evidence";
import { decodeHtmlEntities } from "@reactive-resume/utils/string";
import { surfaceFormsOf } from "../ats-pdf/jd/aliases";
import { matchJobDescription } from "../ats-pdf/jd/match";
import { MAX_NGRAM_LENGTH } from "../ats-pdf/jd/ngrams";
import { stemFreeText } from "../ats-pdf/jd/stem";
import { matchingWindows } from "../ats-pdf/jd/tokenize";
import { hashReviewTarget } from "../review-evidence";
import { isRenderedSection, walkSections } from "./walk";

export const JOB_NORMALIZATION_VERSION = "matching-v2";
export const JOB_RUBRIC_VERSION = "literal-v1";
const TERM_LIMIT = 35;
const GENERIC_JOB_WORDS = new Set(
	`take help existing code growing launch decision decisions technical technology complex
work working works team teams role job jobs candidate candidates company companies business good great strong excellent effective efficiently ability able responsible responsibilities responsibility required requirements require experience experienced knowledge understanding proven demonstrate demonstrated environment environments opportunity opportunities looking seeking join provide support ensure including include using use used new develop development deliver delivery manage management lead leading driven focus focused passionate passion skill skills communication collaborative collaboration collaborate people person professional highly preferred minimum must need needs want relevant across within various related through achieve contributing contribute maintain drive build building successful success solution solutions process processes tasks daily activities additional value
عمل العمل يعمل فريق الفريق وظيفة الوظيفة وظائف شركة الشركة شركات مطلوب المطلوبة متطلبات خبرة الخبرة مهارات المهارات القدرة قدرة قادر يساعد مساعدة دعم تطوير تنفيذ مسؤول مسؤوليات مسؤولية جيد جيدة ممتاز ممتازة قوي قوية تقني تقنية تقنيه التقنيه التقنية تكنولوجيا معقد معقدة قرارات قرار نمو إطلاق الحالي الحالية الموجودة استخدام يستخدم جديد جديدة يعملون المرشح المتقدم فرصة فرص بيئة البيئة تتضمن تشمل ضمان تحقيق تقديم الادارة الاداره الادارية`.split(
		/\s+/u,
	),
);
const meaningfulJobTerm = (term: string) => term.split(/\s+/u).some((word) => !GENERIC_JOB_WORDS.has(word));
const plain = (value: string) => decodeHtmlEntities(value.replace(/<[^>]*>/gu, " ")).trim();

export function analyzeJobTerms(raw: JobTermAnalysisInput): JobTermReport {
	const input = jobTermAnalysisInputSchema.parse(raw);
	if (
		input.identity.normalizationVersion !== JOB_NORMALIZATION_VERSION ||
		input.identity.rubricVersion !== JOB_RUBRIC_VERSION
	)
		throw new Error("JOB_POLICY_CHANGED");
	const resumeText = input.passages.map((passage) => passage.text).join("\n");
	const options = { jobDescription: input.jobText, resumeText };
	const all = matchJobDescription({ ...options, maxTerms: Number.MAX_SAFE_INTEGER });
	const meaningful = all.terms.filter((term) => meaningfulJobTerm(term.term));
	const jobWindows = matchingWindows(input.jobText, MAX_NGRAM_LENGTH);
	const cvWindows = input.passages.map((passage) => ({
		passage,
		windows: matchingWindows(passage.text, MAX_NGRAM_LENGTH),
	}));
	const terms = meaningful.slice(0, TERM_LIMIT).map((term, index) => {
		const forms = new Set(surfaceFormsOf(term.term));
		const stem = term.term.split(" ").map(stemFreeText).join(" ");
		const matches = (value: string) => forms.has(value) || value.split(" ").map(stemFreeText).join(" ") === stem;
		const spans = (windows: typeof jobWindows, prefix: string): JobSpan[] =>
			windows
				.filter((window) => matches(window.text))
				.map((window, n) => ({
					id: `${prefix}-${index}-${n}`,
					start: window.start,
					end: window.end,
					quote: window.quote,
				}));
		const jobSpans = spans(jobWindows, "job");
		const cvSpans = cvWindows.flatMap(({ passage, windows }) =>
			spans(windows, passage.id).map((span) => ({ ...span, passageId: passage.id, target: passage.target })),
		);
		return {
			term: term.term,
			matched: term.resumeCount > 0,
			surfaceForms: [...new Set(jobSpans.map((span) => span.quote))],
			jobSpans,
			cvSpans,
		};
	});
	const excludedTerms = meaningful
		.filter((term) => !terms.some((selected) => selected.term === term.term))
		.map((term) => term.term);
	return {
		identity: input.identity,
		state: !input.jobText.trim() ? "not-checked" : !terms.length ? "not-checkable" : "complete",
		denominator: terms.length,
		matchedCount: terms.filter((term) => term.matched).length,
		unmatchedCount: terms.filter((term) => !term.matched).length,
		terms,
		selection: { limit: TERM_LIMIT, truncated: excludedTerms.length > 0 },
		excludedTerms,
		exclusions: [
			"text-occurrence-not-ability",
			"hidden-terms-affect-presentation-only",
			...(excludedTerms.length ? ["ranked-selection-not-all-requirements"] : []),
			...(terms.some((term) => !term.jobSpans.length || (term.matched && !term.cvSpans.length))
				? ["source-span-unavailable"]
				: []),
		],
	};
}

/** Visible field inventory only: never contacts, links, references or hidden/unplaced content. */
export function buildJobPassages(data: ResumeData): JobTermAnalysisInput["passages"] {
	const passages: JobTermAnalysisInput["passages"] = [];
	const add = (target: ProposalTarget, value: unknown) => {
		if (typeof value !== "string") return;
		const text = plain(value);
		if (!text) return;
		passages.push({
			id: `cv-${hashReviewTarget(JSON.stringify([target.sectionId, target.itemId ?? null, target.roleId ?? null, target.field]))}`,
			target,
			text,
		});
	};
	add({ sectionId: "basics", field: "headline" }, data.basics.headline);
	for (const section of walkSections(data).filter(isRenderedSection)) {
		if (["references", "profiles", "cover-letter"].includes(section.type)) continue;
		if (section.id === "summary") {
			add({ sectionId: "summary", field: "content" }, data.summary.content);
			continue;
		}
		for (const item of section.items) {
			const itemId = item.value.id;
			if (typeof itemId !== "string") continue;
			for (const field of [
				"title",
				"name",
				"company",
				"organization",
				"awarder",
				"issuer",
				"publisher",
				"school",
				"degree",
				"area",
				"position",
				"description",
				"language",
				"fluency",
				"proficiency",
			])
				add({ sectionId: section.id, itemId, field }, item.value[field]);
			if (Array.isArray(item.value.keywords))
				add({ sectionId: section.id, itemId, field: "keywords" }, item.value.keywords.join(", "));
			if (Array.isArray(item.value.roles))
				for (const role of item.value.roles) {
					if (!role || typeof role !== "object" || !("id" in role) || typeof role.id !== "string") continue;
					for (const field of ["position", "description"] as const)
						if (field in role) add({ sectionId: section.id, itemId, roleId: role.id, field }, role[field]);
				}
		}
	}
	return passages;
}
