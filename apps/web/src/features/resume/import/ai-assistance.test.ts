import type { ReviewState } from "./review-draft";
import type { ReviewCandidate, ReviewResult } from "@reactive-resume/schema/resume/ai-review";
import { describe, expect, it } from "vite-plus/test";
import { parseResumeText } from "@reactive-resume/import/plain-text";
import {
	applyImportReviewCandidate,
	getImportCandidateTarget,
	applyImportReviewCandidates,
	undoImportReviewCandidate,
	getImportSectionText,
	getImportPassageSelection,
	importDraftGeneration,
} from "./ai-assistance";
import { createReviewState } from "./review-draft";

describe("native import passage selection", () => {
	it("shows only the parser's section boundaries and preserves original line breaks", () => {
		const pages = [
			{ page: 1, text: "Sara\r\nEXPERIENCE\r\nEngineer\r\n\r\nSKILLS\r\nTypeScript\r\nPROJECTS\r\nParser" },
		];
		const source = getImportSectionText(pages, "skills", "en-US");
		expect(source.matched).toBe(true);
		expect(source.text).toBe("SKILLS\r\nTypeScript\r\n");
		expect(source.text).not.toContain("Engineer");
	});
	it("recognizes Arabic parser headings and stops at an unknown custom heading", () => {
		const source = getImportSectionText(
			[{ page: 1, text: "سارة\nالمهارات التقنية\nTypeScript\n\nCUSTOM SECTION\nOther content" }],
			"skills",
			"ar-SA",
		);
		expect(source.text).toBe("المهارات التقنية\nTypeScript\n\n");
	});
	it("maps textarea-normalized line-ending offsets back to the exact source passage", () => {
		const source = getImportSectionText(
			[{ page: 3, text: "SKILLS\r\nTypeScript\r\nDatabase queries" }],
			"skills",
			"en-US",
		);
		const displayed = source.text.replace(/\r\n?/g, "\n");
		const start = displayed.indexOf("TypeScript");
		expect(getImportPassageSelection(source, start, displayed.length)).toEqual({
			text: "TypeScript\r\nDatabase queries",
			pages: [3],
		});
	});
	it("maps a repeated quote to its actual page by selection offsets", () => {
		const source = getImportSectionText(
			[
				{ page: 1, text: "SKILLS\nTypeScript" },
				{ page: 4, text: "SKILLS\nTypeScript\nEDUCATION\nCollege" },
			],
			"skills",
			"en-US",
		);
		expect(source.text).toBe("SKILLS\nTypeScript\n\nSKILLS\nTypeScript\n");
		const start = source.text.lastIndexOf("TypeScript");
		expect(getImportPassageSelection(source, start, start + 10)).toEqual({ text: "TypeScript", pages: [4] });
	});
	it("retains a section continuing across pages and maps a cross-page selection", () => {
		const source = getImportSectionText(
			[
				{ page: 2, text: "EXPERIENCE\nFirst role" },
				{ page: 3, text: "Second role\nEDUCATION\nCollege" },
			],
			"experience",
			"en-US",
		);
		const start = source.text.indexOf("First role");
		expect(getImportPassageSelection(source, start, source.text.indexOf("Second role") + 11)).toEqual({
			text: "First role\n\nSecond role",
			pages: [2, 3],
		});
	});
	it("keeps the complete source available when no matching heading exists without selecting it", () => {
		const text = "Sara\nEngineer\nNo recognizable headings";
		const source = getImportSectionText([{ page: 7, text }], "education", "en-US");
		expect(source).toMatchObject({ text, matched: false });
		expect(getImportPassageSelection(source, 0, 0)).toEqual({ text: "", pages: [] });
		expect(getImportPassageSelection(source, -1, 5)).toEqual({ text: "", pages: [] });
	});
});

function fixture() {
	const data = parseResumeText("Sara Example\nEXPERIENCE\nExample Labs | Engineer | 2024");
	const state = createReviewState(data, "550e8400-e29b-41d4-a716-446655440000");
	const entry = data.sections.experience.items[0];
	if (!entry) throw new Error("Missing fixture entry");
	const source = { kind: "import", id: "source", revision: "digest" } as const;
	const candidate: ReviewCandidate = {
		id: "c1",
		section: "experience",
		entityId: "source-entity",
		field: "position",
		value: "Software Engineer",
		rawDateText: null,
		evidenceIds: ["e1"],
		confirmation: "needs_review",
	} as const;
	const result: ReviewResult = {
		schemaVersion: 2,
		kind: "extraction",
		sourceRevision: source,
		questions: [],
		evidence: [],
		candidates: [candidate],
	};
	return {
		state: {
			...state,
			confirmed: { [`experience:${entry.id}:position`]: JSON.stringify("Engineer") },
			reviewed: { [`experience:${entry.id}`]: "reviewed" },
			aiReview: {
				version: 1 as const,
				source,
				operationId: "op",
				result: structuredClone(result),
				draftGeneration: importDraftGeneration(state.data),
				appliedCandidateIds: [],
			},
		} as ReviewState,
		entry,
		candidate: structuredClone(candidate),
	};
}

it("matches a flattened education suggestion and protects the native split and graduation year", () => {
	const { state, candidate } = fixture();
	state.data.sections.education.items = parseResumeText(
		"Example Person\nEducation\nNorth College\n2019",
	).sections.education.items;
	const native = state.data.sections.education.items[0];
	const review = state.aiReview;
	if (!native || review?.result?.kind !== "extraction") throw new Error("Missing education fixture");
	Object.assign(native, {
		school: "North College",
		degree: "Diploma",
		area: "Design",
		location: "London",
		dates: { start: "2019", end: null, present: false },
	});
	state.data.sections.education.items.push({ ...native, id: "second", school: "South College" });
	review.draftGeneration = importDraftGeneration(state.data);
	const school = { ...candidate, section: "education", field: "school", value: "North College Diploma" } as const;
	review.result.candidates = [
		school,
		{ ...school, id: "degree", field: "degree", value: "Design London" },
		{ ...school, id: "area", field: "area", value: "London" },
		{ ...school, id: "location", field: "location", value: "Design London" },
		{ ...school, id: "dates", field: "dates", value: { start: "2017", end: "2019", present: false } },
	];
	expect(getImportCandidateTarget(state, school)).toBe(native.id);
	const next = applyImportReviewCandidates(state, {});
	expect(next.data.sections.education.items).toEqual(state.data.sections.education.items);
	expect(next.aiReview?.appliedChanges?.filter(({ retained }) => retained)).toHaveLength(5);
});

describe("local extraction candidate application", () => {
	it("keeps the rest of both rich descriptions when the approved selection ends mid-word", () => {
		const { state, candidate } = fixture();
		const original = state.data.sections.experience.items[0];
		if (!original) throw new Error("Missing initial entry");
		state.data.sections.experience.items.push({ ...original, id: "second", company: "Second Labs" });
		const [first, second] = state.data.sections.experience.items;
		if (!first || !second || state.aiReview?.result?.kind !== "extraction") throw new Error("Missing entries");
		first.description = "<p>Reviewed the initial proposal.</p>";
		second.description =
			"<ul><li><strong>Coordinated</strong> releases and rollout checks.</li><li>Recorded results.</li></ul>";
		const excerpt = { ...candidate, field: "description" as const, value: "Coordinated releases and roll" };
		state.aiReview.result.candidates = [
			{ ...candidate, id: "first", entityId: "first", field: "description", value: "Reviewed the initial proposal." },
			excerpt,
		];
		state.aiReview.draftGeneration = importDraftGeneration(state.data);
		expect(getImportCandidateTarget(state, excerpt)).toBe(second.id);
		const applied = applyImportReviewCandidates(state, { first: first.id, [excerpt.id]: second.id });
		expect(applied.data.sections.experience.items.map(({ description }) => description)).toEqual([
			first.description,
			second.description,
		]);
		expect(applied.aiReview?.appliedCandidateIds).toEqual(["first", excerpt.id]);
	});

	it("adds a missing literal description to an existing entry without overwriting its text and can undo it", () => {
		const { state, candidate, entry } = fixture();
		if (state.aiReview?.result?.kind !== "extraction") throw new Error("Missing review");
		const current = state.data.sections.experience.items[0];
		if (!current) throw new Error("Missing entry");
		current.description = "<p>Reviewed the earlier release.</p>";
		state.aiReview.draftGeneration = importDraftGeneration(state.data);
		state.aiReview.result.candidates = [{ ...candidate, field: "description", value: "Checked A & B." }];
		const applied = applyImportReviewCandidate(state, candidate.id, entry.id);
		expect(applied.data.sections.experience.items[0]?.description).toBe(
			"<p>Reviewed the earlier release.</p><p>Checked A &amp; B.</p>",
		);
		expect(undoImportReviewCandidate(applied, candidate.id).data).toEqual(state.data);
	});

	it("changes only the chosen draft field and invalidates confirmation and submission", () => {
		const f = fixture();
		const next = applyImportReviewCandidate(f.state, "c1", f.entry.id);
		expect(next.data.sections.experience.items[0]?.position).toBe("Software Engineer");
		expect(next.confirmed[`experience:${f.entry.id}:position`]).toBeUndefined();
		expect(next.reviewed[`experience:${f.entry.id}`]).toBeUndefined();
		expect(next.submission).toBeUndefined();
		expect(f.state.data.sections.experience.items[0]?.position).toBe("Engineer");
	});
	it("rejects stale local edits and mismatched source digests", () => {
		const f = fixture();
		f.state.data.basics.headline = "Manual work";
		expect(() => applyImportReviewCandidate(f.state, "c1", f.entry.id)).toThrow("AI_IMPORT_STALE");
		const other = fixture();
		if (!other.state.aiReview) throw new Error("Missing fixture review");
		other.state.aiReview.source = { ...other.state.aiReview.source, revision: "foreign" };
		expect(() => applyImportReviewCandidate(other.state, "c1", other.entry.id)).toThrow("AI_IMPORT_STALE");
	});
	it("withholds null unknowns and does not overwrite reused confirmed master facts", () => {
		const f = fixture();
		if (f.state.aiReview?.result?.kind !== "extraction") throw new Error("fixture");
		f.state.aiReview.result.candidates[0] = { ...f.candidate, value: null };
		expect(() => applyImportReviewCandidate(f.state, "c1", f.entry.id)).toThrow("AI_IMPORT_UNKNOWN");
		const other = fixture();
		other.state.reused = [
			{
				confirmation: "confirmed",
				structured: { section: "experience", entityId: other.entry.id, field: "position", value: "Engineer" },
			},
		] as never;
		expect(() => applyImportReviewCandidate(other.state, "c1", other.entry.id)).toThrow("AI_IMPORT_CONFIRMED_MASTER");
	});
});

describe("grouped skill suggestions", () => {
	it("preselects the only skill group, adds all names as keywords, and undoes one without losing the rest", () => {
		const f = fixture();
		const group = {
			id: crypto.randomUUID(),
			hidden: false,
			name: "AI-Assisted Development",
			description: "",
			icon: "",
			iconColor: "",
			proficiency: "",
			level: 0,
			keywords: [] as string[],
		};
		f.state.data.sections.skills.items = [group];
		const candidates = ["Codex", "Claude Code", "GitHub Copilot"].map((value, index) => ({
			...f.candidate,
			id: `skill-${index}`,
			section: "skills" as const,
			entityId: `skill-${index}`,
			field: "name" as const,
			value,
		}));
		if (!f.state.aiReview || f.state.aiReview.result?.kind !== "extraction") throw new Error("Missing fixture review");
		f.state.aiReview.result.candidates = candidates;
		f.state.aiReview.draftGeneration = importDraftGeneration(f.state.data);
		const targets = Object.fromEntries(candidates.map((c) => [c.id, getImportCandidateTarget(f.state, c)]));
		expect(Object.values(targets)).toEqual(candidates.map(() => group.id));
		const next = applyImportReviewCandidates(f.state, targets);
		expect(next.data.sections.skills.items[0]?.name).toBe("AI-Assisted Development");
		expect(next.data.sections.skills.items[0]?.keywords).toEqual(["Codex", "Claude Code", "GitHub Copilot"]);
		const undone = undoImportReviewCandidate(next, "skill-0");
		expect(undone.data.sections.skills.items[0]?.keywords).toEqual(["Claude Code", "GitHub Copilot"]);
		expect(undone.aiReview?.appliedCandidateIds).toEqual(["skill-1", "skill-2"]);
		expect(undone.confirmed).toEqual({ [`experience:${f.entry.id}:position`]: JSON.stringify("Engineer") });
	});
});

it("shares one new record across its fields and removes it after undoing every item", () => {
	const f = fixture();
	if (!f.state.aiReview || f.state.aiReview.result?.kind !== "extraction") throw new Error("Missing review");
	f.state.aiReview.result.candidates.push({ ...f.candidate, id: "c2", field: "company", value: "Example Labs" });
	const next = applyImportReviewCandidates(f.state, { c1: "new", c2: "new" });
	expect(next.data.sections.experience.items).toHaveLength(2);
	const undone = undoImportReviewCandidate(undoImportReviewCandidate(next, "c1"), "c2");
	expect(undone.data.sections.experience.items).toHaveLength(1);
	expect(undone.aiReview?.appliedCandidateIds).toEqual([]);
	const changed = structuredClone(next);
	changed.data.summary.content = "Manual correction";
	expect(() => undoImportReviewCandidate(changed, "c1")).toThrow("AI_IMPORT_STALE");
});

it("creates separate experience entries when bulk-applying two employers that share one evidence quote", () => {
	const f = fixture();
	if (!f.state.aiReview || f.state.aiReview.result?.kind !== "extraction") throw new Error("Missing review");
	f.state.data.sections.experience.items = [];
	f.state.aiReview.draftGeneration = importDraftGeneration(f.state.data);
	f.state.aiReview.result.evidence = [
		{
			id: "source-1",
			source: { kind: "import", id: "source-1", revision: "rev-1" },
			factId: null,
			factRevision: null,
			target: null,
			confirmation: "source_unconfirmed",
			quote: "استوديو جسر الغد مدير عمليات المنتجات شركة مرسى الأفكار مدير عمليات",
		},
	];
	f.state.aiReview.result.candidates = [
		{
			id: "c1",
			section: "experience",
			entityId: "exp-1",
			field: "company",
			value: "استوديو جسر الغد",
			rawDateText: null,
			evidenceIds: ["source-1"],
			confirmation: "needs_review",
		},
		{
			id: "c2",
			section: "experience",
			entityId: "exp-1",
			field: "position",
			value: "مدير عمليات المنتجات",
			rawDateText: null,
			evidenceIds: ["source-1"],
			confirmation: "needs_review",
		},
		{
			id: "c3",
			section: "experience",
			entityId: "exp-2",
			field: "company",
			value: "شركة مرسى الأفكار",
			rawDateText: null,
			evidenceIds: ["source-1"],
			confirmation: "needs_review",
		},
		{
			id: "c4",
			section: "experience",
			entityId: "exp-2",
			field: "position",
			value: "مدير عمليات",
			rawDateText: null,
			evidenceIds: ["source-1"],
			confirmation: "needs_review",
		},
	];
	const next = applyImportReviewCandidates(f.state, {});
	expect(next.data.sections.experience.items.map((item) => item.company)).toEqual([
		"استوديو جسر الغد",
		"شركة مرسى الأفكار",
	]);
	expect(next.data.sections.experience.items.map((item) => item.position)).toEqual([
		"مدير عمليات المنتجات",
		"مدير عمليات",
	]);
});

it("uses the employer from the candidate's entity to target an existing entry", () => {
	const f = fixture();
	if (f.state.aiReview?.result?.kind !== "extraction") throw new Error("Missing review");
	f.state.data.sections.experience.items = [
		{ ...f.entry, id: "first", company: "Alpha", position: "Engineer" },
		{ ...f.entry, id: "second", company: "Beta", position: "Engineer" },
	];
	const position = { ...f.candidate, field: "position", value: "Engineer" } as const;
	f.state.aiReview.result.candidates = [
		position,
		{ ...position, id: "beta-employer", field: "company", value: "Beta" },
		{ ...position, id: "alpha-employer", entityId: "another", field: "company", value: "Alpha" },
	];
	expect(getImportCandidateTarget(f.state, position)).toBe("second");
});

it("matches PDF experience where the parser kept the city in the employer field", () => {
	const f = fixture();
	const entry = f.state.data.sections.experience.items[0];
	if (!entry) throw new Error("Missing experience");
	entry.company = "استوديو جسر الغد الرياض";
	entry.position = "مدير عمليات المنتجات";
	const candidates = [
		{ ...f.candidate, field: "company", value: "استوديو جسر الغد" },
		{ ...f.candidate, id: "c2", field: "location", value: "الرياض" },
	] satisfies ReviewCandidate[];
	if (!f.state.aiReview || f.state.aiReview.result?.kind !== "extraction") throw new Error("Missing review");
	f.state.aiReview.result.candidates = candidates;
	f.state.aiReview.draftGeneration = importDraftGeneration(f.state.data);
	const targets = Object.fromEntries(
		candidates.map((candidate) => [candidate.id, getImportCandidateTarget(f.state, candidate)]),
	);
	expect(targets).toEqual({ c1: f.entry.id, c2: f.entry.id });
	const next = applyImportReviewCandidates(f.state, targets);
	expect(next.data.sections.experience.items).toMatchObject([
		{ id: f.entry.id, company: "استوديو جسر الغد", location: "الرياض", position: "مدير عمليات المنتجات" },
	]);
});

it.each([
	{ company: "Example Labs Saudi Arabia", location: "Remote" },
	{ company: "Example", location: "Labs Saudi Arabia · Remote" },
])(
	"preserves the native employer split and mixed-script role against $company / $location",
	({ company, location }) => {
		const f = fixture();
		const { state, candidate } = f;
		const entry = state.data.sections.experience.items[0];
		const review = state.aiReview;
		if (!entry || review?.result?.kind !== "extraction") throw new Error("Missing review");
		Object.assign(entry, { company: "Example Labs", location: "Saudi Arabia · Remote", position: "مطوّر Full Stack" });
		state.reviewed = { ["experience:" + entry.id]: JSON.stringify(entry) };
		review.draftGeneration = importDraftGeneration(state.data);
		review.result.candidates = [
			{ ...candidate, id: "employer", field: "company", value: company },
			{ ...candidate, id: "place", field: "location", value: location },
			{ ...candidate, id: "role", field: "position", value: "Full Stack مطور" },
		];
		const next = applyImportReviewCandidates(state, {});
		expect(next.data.sections.experience.items).toEqual([entry]);
		expect(next.reviewed["experience:" + entry.id]).toBeUndefined();
		expect(next.aiReview?.appliedChanges?.filter(({ retained }) => retained)).toHaveLength(3);
	},
);

it.each([
	{ company: "BandAI", location: "Saudi Arabia · Remote", adjacent: false },
	{ company: "BandAI Saudi Arabia", location: "Remote", adjacent: false, nativeSplit: true },
	{ company: "BandAI", location: "Saudi Arabia", adjacent: false },
	{ company: "BandAI", location: undefined, adjacent: false },
	{ company: undefined, location: undefined, adjacent: false },
	{ company: undefined, location: undefined, adjacent: true },
])(
	"merges a dated PDF role with its native row ($company, $location, adjacent $adjacent)",
	({ company, location, adjacent, nativeSplit }) => {
		const f = fixture();
		const data = f.state.data;
		const role = "مهندس برمجيات أول";
		data.metadata.page.locale = "ar-SA";
		data.sections.experience.items = [
			{
				...f.entry,
				id: "current",
				company: nativeSplit ? "BandAI" : "BandAI Saudi Arabia",
				location: nativeSplit ? "Saudi Arabia · Remote" : "Remote",
				position: role,
				dates: { start: "2026-07", end: null, present: true },
			},
			{
				...f.entry,
				id: "previous",
				company: "Example Company",
				position: role,
				dates: { start: "2025-04", end: "2026-07", present: false },
			},
		];
		const position = { ...f.candidate, value: role };
		const candidates = [
			position,
			{ ...position, id: "dates", field: "dates", value: null, rawDateText: "07/2026 – حتى الآن" },
			...(company ? ([{ ...position, id: "company", field: "company", value: company }] as const) : []),
			...(location ? ([{ ...position, id: "location", field: "location", value: location }] as const) : []),
		] satisfies ReviewCandidate[];
		if (!f.state.aiReview || f.state.aiReview.result?.kind !== "extraction") throw new Error("Missing review");
		f.state.aiReview.result.candidates = candidates;
		f.state.aiReview.result.evidence = [
			{
				id: "e1",
				source: f.state.aiReview.source,
				factId: null,
				factRevision: null,
				target: null,
				quote: adjacent ? `BandAI 07/2026-حتى الآن\r\n${role}` : `${role} | 07/2026 – حتى الآن`,
				confirmation: "source_unconfirmed",
			},
		];
		f.state.aiReview.draftGeneration = importDraftGeneration(data);
		const targets = Object.fromEntries(
			candidates.map((candidate) => [candidate.id, getImportCandidateTarget(f.state, candidate)]),
		);
		expect(Object.values(targets)).toEqual(candidates.map(() => "current"));
		const next = applyImportReviewCandidates(f.state, targets);
		expect(next.data.sections.experience.items.map(({ id }) => id)).toEqual(["current", "previous"]);
		expect(next.data.sections.experience.items[0]?.position).toBe(role);
	},
);
