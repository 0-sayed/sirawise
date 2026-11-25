import type { ReviewSourceSnapshot } from "./review-sources";
import type { ReviewCandidate } from "@reactive-resume/schema/resume/ai-review";
import { expect, it } from "vite-plus/test";
import { filterExtractionProvenance, matchReviewProvenance } from "./review-provenance";

const source = { kind: "import", id: "source", revision: "r1" } as const;
function snapshot(...quotes: string[]): ReviewSourceSnapshot {
	const evidence = quotes.map((quote, index) => ({
		id: `e${index}`,
		quote,
		source,
		target: null,
		factId: null,
		factRevision: null,
		confirmation: "source_unconfirmed" as const,
	}));
	return {
		source,
		evidence,
		selections: evidence.map(({ id, quote }) => ({
			id,
			text: quote,
			kind: "unconfirmed_source",
			section: "experience",
		})),
		expiresAt: null,
		partial: false,
	};
}
function candidate(value: string, evidenceIds = ["e0"]): ReviewCandidate {
	return {
		id: "company",
		section: "experience",
		entityId: "entry",
		field: "company",
		value,
		rawDateText: null,
		evidenceIds,
		confirmation: "needs_review",
	};
}
it("binds a clipped description only to its selected text across two experience entries", () => {
	const first = "Reviewed the first release.";
	const second = "Coordinated releases and roll";
	const quote = `Employer: First Labs\nDescription: ${first}\n\nEmployer: Second Labs\nDescription: ${second}`;
	const excerpt = { ...snapshot(quote), partial: true };
	const description = { ...candidate(second), field: "description" as const };
	expect(matchReviewProvenance(description, excerpt)).toEqual({
		evidenceId: "e0",
		start: quote.indexOf(second),
		end: quote.length,
	});
	expect(
		matchReviewProvenance({ ...description, value: second + "out checks. Recorded results." }, excerpt),
	).toBeNull();
	expect(matchReviewProvenance({ ...description, value: first + " " + second }, excerpt)).toBeNull();
});
it("maps harmless mixed-script spacing to the original quote", () => {
	const quote = "Employer: شركة\u00a0  Acme";
	expect(matchReviewProvenance(candidate("شركةAcme"), snapshot(quote))).toEqual({
		evidenceId: "e0",
		start: 10,
		end: quote.length,
	});
});
it.each([
	["Acme Labs", ["Acme", "Labs"]],
	["C", ["C++"]],
	["C", ["C#"]],
	["30", ["30%"]],
	["30", ["-30"]],
	["12", ["12.5"]],
	["١٢", ["١٢٫٥"]],
	["٣٠", ["٣٠٪"]],
	["Acme", ["Employer: Acme\nEmployer: Acme"]],
	["Beta", ["Employer: Acme\nPosition: Beta"]],
	["Engineer", ["Employer: Acme\nPosition:\nEngineer"]],
	["Employer", ["Employer: Acme"]],
])("rejects an altered or misbound literal %s", (value, quotes) => {
	expect(
		matchReviewProvenance(
			candidate(
				value,
				quotes.map((_, i) => `e${i}`),
			),
			snapshot(...quotes),
		),
	).toBeNull();
});

it("keeps wrapped values within their field until the next label", () => {
	const quote = "Employer:\r\nAcme\r\n  Labs\r\nPosition:\r\nEngineer";
	const excerpt = snapshot(quote);
	const employer = matchReviewProvenance(candidate("Acme Labs"), excerpt);
	expect(employer && quote.slice(employer.start, employer.end)).toBe("Acme\r\n  Labs");
	expect(matchReviewProvenance(candidate("Acme Labs Position"), excerpt)).toBeNull();
	expect(matchReviewProvenance({ ...candidate("Engineer"), field: "position" }, excerpt)).toMatchObject({
		start: quote.indexOf("Engineer"),
		end: quote.length,
	});
});

it("binds literals under combined record labels without accepting them from unrelated fields", () => {
	const quote = "Role register: clerk | Acme Labs | Jeddah\nPosition: Engineer\nTools: Oracle";
	const excerpt = snapshot(quote);
	expect(matchReviewProvenance(candidate("Acme Labs"), excerpt)).toMatchObject({
		start: quote.indexOf("Acme Labs"),
		end: quote.indexOf("Acme Labs") + "Acme Labs".length,
	});
	expect(matchReviewProvenance(candidate("Engineer"), excerpt)).toBeNull();
	expect(matchReviewProvenance(candidate("Oracle"), excerpt)).toBeNull();
});

it("binds an inline education label after a sentence without using text from the previous field", () => {
	const quote = "الأدوات: مدد؛ قوى؛ SAP. الشهادة: دبلوم إدارة أعمال من معهد ضياء.";
	const excerpt = snapshot(quote);
	const selection = excerpt.selections[0];
	if (selection && "id" in selection) selection.section = "education";
	const degree = { ...candidate("دبلوم"), section: "education", field: "degree" } as const;
	expect(matchReviewProvenance(degree, excerpt)).toEqual({
		evidenceId: "e0",
		start: quote.indexOf("دبلوم"),
		end: quote.indexOf("دبلوم") + "دبلوم".length,
	});
	expect(matchReviewProvenance({ ...degree, value: "SAP" }, excerpt)).toBeNull();
});

it("binds repeated education subjects and locations to the cited school record", () => {
	const quote = "North College Diploma\nDesign London • 2020\nSouth College Diploma\nDesign London • 2022";
	const excerpt = snapshot(quote);
	const selection = excerpt.selections[0];
	if (selection && "id" in selection) selection.section = "education";
	const school = { ...candidate("South College"), section: "education", field: "school" } as const;
	const result = filterExtractionProvenance(excerpt, {
		schemaVersion: 2,
		kind: "extraction",
		sourceRevision: source,
		evidence: excerpt.evidence,
		questions: [],
		candidates: [
			school,
			{ ...school, id: "degree", field: "degree", value: "Diploma" },
			{ ...school, id: "area", field: "area", value: "Design" },
			{ ...school, id: "location", field: "location", value: "London" },
			{
				...school,
				id: "dates",
				field: "dates",
				rawDateText: "2022",
				value: { start: "2022", end: null, present: false },
			},
		],
	});
	expect(result).toEqual({ keptIds: ["company", "degree", "area", "location", "dates"], withheld: [] });
});

it("rejects a graduation year presented as the school or degree", () => {
	const quote = "North College 2020\nBachelor of Arts in History";
	const excerpt = snapshot(quote);
	const selection = excerpt.selections[0];
	if (selection && "id" in selection) selection.section = "education";
	const school = { ...candidate("North College 2020"), section: "education", field: "school" } as const;
	expect(matchReviewProvenance(school, excerpt)).toBeNull();
	expect(matchReviewProvenance({ ...school, field: "degree", value: "2020" }, excerpt)).toBeNull();
});

it.each([
	["15 %", ["15", "%"]],
	["١٥ ٪", ["١٥", "٪"]],
	["٪ ١٥", ["١٥", "٪"]],
	[".5", ["5"]],
	["1e-3", ["1", "-3"]],
	["2021 - 2024", ["2021", "2024", "2021 -"]],
	["2021–2024", ["2021", "2024"]],
	["Jun 2021 — May 2024", ["Jun 2021", "May 2024"]],
	["May 5, 2021 - June 6, 2024", ["May 5, 2021", "June 6, 2024"]],
	["2021 to 2024", ["2021", "2024"]],
	["٢٠٢١ إلى ٢٠٢٤", ["٢٠٢١", "٢٠٢٤"]],
	["2021 — Present", ["2021", "Present"]],
	["٢٠٢١ – حتى الآن", ["٢٠٢١", "الآن"]],
	["May 2024", ["May", "2024"]],
	["+ 15", ["15"]],
	["1 500", ["1", "500"]],
])("requires the complete numeric value in %s", (value, fragments) => {
	const quote = `Description: Reported ${value}.`;
	const excerpt = snapshot(quote);
	const field = (text: string) => ({ ...candidate(text), field: "description" as const });
	for (const fragment of fragments) expect(matchReviewProvenance(field(fragment), excerpt)).toBeNull();
	const match = matchReviewProvenance(field(value), excerpt);
	expect(match && quote.slice(match.start, match.end)).toBe(value);
});

it.each(["\n\n", "\n"])("keeps cited fields within one labeled entity", (separator) => {
	const excerpt = snapshot(`Employer: Acme\nPosition: Engineer${separator}Employer: Beta\nPosition: Director`);
	const scoped: ReviewCandidate = { ...candidate("Engineer"), id: "field-valid", field: "position" };
	const wrongSection: ReviewCandidate = {
		...candidate("Beta"),
		id: "wrong-section",
		section: "education",
		field: "school",
	};
	const wrongField = { ...candidate("Director"), id: "wrong-field" };
	const wrongEmployer = { ...candidate("Beta"), id: "wrong-employer" };
	const result = (candidates: ReviewCandidate[]) =>
		filterExtractionProvenance(excerpt, {
			schemaVersion: 2,
			kind: "extraction",
			sourceRevision: source,
			evidence: excerpt.evidence,
			candidates,
			questions: [],
		});
	expect(result([scoped, wrongSection, wrongField]).keptIds).toEqual(["field-valid"]);
	expect(result([scoped, wrongEmployer]).withheld.map(({ reason }) => reason)).toEqual([
		"AI_SOURCE_BINDING",
		"AI_SOURCE_BINDING",
	]);
});

it.each(["Employer: Alpha\nLocation: Riyadh\nEmployer: Beta\nLocation: Riyadh", "Alpha | Riyadh\nBeta | Riyadh"])(
	"binds a repeated location to the entry identified by its employer: %s",
	(quote) => {
		const candidates: ReviewCandidate[] = [
			{ ...candidate("Beta"), id: "beta-company", entityId: "beta" },
			{ ...candidate("Riyadh"), id: "beta-location", entityId: "beta", field: "location" },
		];
		const excerpt = snapshot(quote);
		expect(
			filterExtractionProvenance(excerpt, {
				schemaVersion: 2,
				kind: "extraction",
				sourceRevision: source,
				candidates,
				questions: [],
				evidence: excerpt.evidence,
			}),
		).toEqual({ keptIds: ["beta-company", "beta-location"], withheld: [] });
	},
);

it("binds exact Arabic titles and repeated locations to their dated PDF records", () => {
	const quote =
		"استوديو جسر الغد الرياض\nمدير عمليات المنتجات 01/2024 - 01/2026\nراجع التقارير.\n" +
		"شركة مرسى الأفكار الرياض\nمدير عمليات 01/2022 - 01/2024\n• تابع التسليم.";
	const excerpt = snapshot(quote);
	const candidates = [
		{ ...candidate("استوديو جسر الغد"), id: "first-company", entityId: "first" },
		{ ...candidate("مدير عمليات المنتجات"), id: "first-position", entityId: "first", field: "position" },
		{ ...candidate("شركة مرسى الأفكار"), id: "second-company", entityId: "second" },
		{ ...candidate("مدير عمليات"), id: "second-position", entityId: "second", field: "position" },
		{ ...candidate("الرياض"), id: "second-location", entityId: "second", field: "location" },
	] satisfies ReviewCandidate[];
	const result = (items: ReviewCandidate[]) =>
		filterExtractionProvenance(excerpt, {
			schemaVersion: 2,
			kind: "extraction",
			sourceRevision: source,
			evidence: excerpt.evidence,
			candidates: items,
			questions: [],
		});
	expect(result(candidates)).toEqual({ keptIds: candidates.map(({ id }) => id), withheld: [] });
	expect(result(candidates.filter(({ field }) => field === "position"))).toEqual({
		keptIds: ["first-position", "second-position"],
		withheld: [],
	});
	const crossed = candidates.filter(({ id }) => id === "first-company" || id === "second-position");
	expect(result(crossed.map((item) => ({ ...item, entityId: "first" }))).keptIds).toEqual([]);
});
