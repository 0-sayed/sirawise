import { expect, it } from "vite-plus/test";
import { jobTermReportSchema } from "@reactive-resume/schema/job-evidence";
import { defaultResumeData } from "@reactive-resume/schema/resume/default";
import { analyzeJobTerms, buildJobPassages, JOB_NORMALIZATION_VERSION, JOB_RUBRIC_VERSION } from "./job-evidence";

const identity = {
	resumeId: "cv",
	resumeRevision: "r1",
	contentHash: "h1",
	jobId: "job",
	jobRevision: "j1",
	rubricVersion: "literal-v2",
	normalizationVersion: JOB_NORMALIZATION_VERSION,
};
const passage = (text: string, id = "summary") => ({ id, target: { sectionId: "summary", field: "content" }, text });

it("reports distinct literal React/SAP coverage without inferring ability", () => {
	const report = analyzeJobTerms({ identity, jobText: "React, SAP", passages: [passage("React")] });
	expect(report).toMatchObject({ state: "complete", denominator: 2, matchedCount: 1, unmatchedCount: 1 });
	expect(report.terms.map((term) => [term.term, term.matched])).toEqual([
		["react", true],
		["sap", false],
	]);
	expect(jobTermReportSchema.parse(report)).toEqual(report);
	expect(
		analyzeJobTerms({ identity, jobText: "React SAP", passages: [passage("React")] }).terms.map((term) => [
			term.term,
			term.matched,
		]),
	).toEqual([
		["react", true],
		["sap", false],
	]);
	expect(
		analyzeJobTerms({ identity, jobText: "React, REACT.js, react, SAP, sap", passages: [passage("React")] })
			.denominator,
	).toBe(2);
	expect(
		analyzeJobTerms({ identity, jobText: "React, SAP", passages: [passage("No React experience")] }).matchedCount,
	).toBe(1);
});

it("keeps empty and unusable jobs unknown and discloses selection limits", () => {
	expect(analyzeJobTerms({ identity, jobText: "", passages: [] })).toMatchObject({
		state: "not-checked",
		denominator: 0,
	});
	expect(analyzeJobTerms({ identity, jobText: "and the 123", passages: [] })).toMatchObject({
		state: "not-checkable",
		denominator: 0,
	});
	const report = analyzeJobTerms({
		identity,
		jobText: Array.from({ length: 70 }, (_, n) => `tech${String(n).padStart(2, "0")}`).join(", "),
		passages: [],
	});
	expect(report.denominator).toBe(35);
	expect(report.selection).toMatchObject({ limit: 35, truncated: true });
	expect(report.exclusions).toContain("ranked-selection-not-all-requirements");
});

it.each([
	["React.js, C++, C#", "😀 REACT, C++, C#"],
	["إِحْصَاء, تحليل", "😀 إِحْصَاء وتحليل"],
	["مهارة١٢, مـهارة", "مهارة12، مهارة"],
	["ﬁnance, Ｒｅａｃｔ, café", "finance; React; café"],
	["React, React", "“React” — React"],
])("retains original UTF-16 offsets across normalization: %s", (jobText, text) => {
	const report = analyzeJobTerms({ identity, jobText, passages: [passage(text)] });
	expect(report.matchedCount).toBeGreaterThan(0);
	for (const term of report.terms) {
		expect(term.jobSpans.length).toBeGreaterThan(0);
		for (const span of term.jobSpans) expect(jobText.slice(span.start, span.end)).toBe(span.quote);
		for (const span of term.cvSpans) expect(text.slice(span.start, span.end)).toBe(span.quote);
	}
});

it("excludes contact, hidden and unplaced content from selected CV evidence", () => {
	const data = structuredClone(defaultResumeData);
	data.basics.email = "SAP@example.test";
	data.summary.content = "<p>React</p>";
	data.summary.hidden = false;
	data.metadata.layout.pages = [{ fullWidth: false, main: ["summary"], sidebar: [] }];
	const passages = buildJobPassages(data);
	expect(passages.map((p) => p.text).join(" ")).toContain("React");
	expect(passages.map((p) => p.text).join(" ")).not.toContain("SAP");
	data.basics.headline = "Engineer";
	expect(buildJobPassages(data).find((p) => p.target.sectionId === "summary")?.id).toBe(passages[0]?.id);
	data.basics.headline = "";
	data.summary.hidden = true;
	expect(buildJobPassages(data)).toEqual([]);
});

it("rejects false policy identity and duplicate passage/target inventory", () => {
	const valid = { ...identity, rubricVersion: JOB_RUBRIC_VERSION, normalizationVersion: JOB_NORMALIZATION_VERSION };
	expect(() =>
		analyzeJobTerms({ identity: { ...valid, normalizationVersion: "wrong" }, jobText: "React", passages: [] }),
	).toThrow();
	expect(() =>
		analyzeJobTerms({ identity: valid, jobText: "React", passages: [passage("React"), passage("SAP")] }),
	).toThrow();
});

it("matches visible certification issuers, awarders and publishers as cited CV evidence", () => {
	const data = structuredClone(defaultResumeData);
	const common = { hidden: false, date: "", description: "", website: { url: "", label: "", inlineLink: false } };
	data.sections.certifications.items = [
		{ ...common, id: "certificate", title: "Cloud certificate", issuer: "Microsoft" },
	];
	data.sections.awards.items = [{ ...common, id: "award", title: "Research award", awarder: "IEEE" }];
	data.sections.publications.items = [{ ...common, id: "publication", title: "Research paper", publisher: "Springer" }];
	data.metadata.layout.pages = [{ fullWidth: false, main: ["certifications", "awards", "publications"], sidebar: [] }];
	const passages = buildJobPassages(data);
	for (const [sectionId, field, text] of [
		["certifications", "issuer", "Microsoft"],
		["awards", "awarder", "IEEE"],
		["publications", "publisher", "Springer"],
	]) {
		expect(passages).toContainEqual(
			expect.objectContaining({ target: expect.objectContaining({ sectionId, field }), text }),
		);
	}
	const report = analyzeJobTerms({ identity, jobText: "Microsoft, IEEE, Springer", passages });
	expect(report.matchedCount).toBe(3);
	expect(report.terms.every((term) => term.cvSpans.length > 0)).toBe(true);
});

it("cites Greek uppercase terms using whole-word lowercase normalization", () => {
	const text = "😀 ΟΔΟΣ";
	const report = analyzeJobTerms({ identity, jobText: "ΟΔΟΣ", passages: [passage(text)] });
	expect(report).toMatchObject({ matchedCount: 1 });
	expect(report.terms[0]?.jobSpans).toEqual([{ id: "job-0-0", start: 0, end: 4, quote: "ΟΔΟΣ" }]);
	expect(report.terms[0]?.cvSpans).toContainEqual(expect.objectContaining({ start: 3, end: 7, quote: "ΟΔΟΣ" }));
});

it("keeps meaningful job terms and drops generic wording from selected and excluded lists", () => {
	const report = analyzeJobTerms({
		identity,
		jobText:
			"take, help, existing, code, growing, launch, decisions, technical, technology, complex, React, Kubernetes, financial services, cloud security",
		passages: [passage("React cloud security")],
	});
	const terms = [...report.terms.map((t) => t.term), ...report.excludedTerms];
	for (const word of [
		"take",
		"help",
		"existing",
		"code",
		"growing",
		"launch",
		"decisions",
		"technical",
		"technology",
		"complex",
	])
		expect(terms).not.toContain(word);
	expect(terms).toContain("react");
	expect(terms).toContain("kubernetes");
	expect(terms).toContain("financial services");
	expect(report.matchedCount).toBe(report.terms.filter((t) => t.matched).length);
});

it("excludes Arabic function words and phrases made from them from literal coverage", () => {
	const report = analyzeJobTerms({
		identity,
		jobText: "على، في، إلى، مع، الذي، من أجل، وقد، بالإضافة إلى، Kubernetes",
		passages: [passage("على في إلى مع الذي من أجل وقد بالإضافة إلى")],
	});
	expect(report.terms.map(({ term, matched }) => [term, matched])).toEqual([["kubernetes", false]]);
});

it.each([
	[
		"TypeScript services, TypeScript stack, TypeScript solutions, TypeScript systems, TypeScript applications, TypeScript development, TypeScript experience",
	],
	[
		"خدمات TypeScript، TypeScript حلول، أنظمة TypeScript، تطبيقات TypeScript، تطوير TypeScript، خبرة TypeScript، حزمة TypeScript",
	],
])("drops generic skill phrases while preserving named skills (%s)", (examples) => {
	const skills = "system design, machine learning, React Native";
	const text = `${examples}, ${skills}`;
	const report = analyzeJobTerms({ identity, jobText: text, passages: [passage(text)] });
	const matches = report.terms.filter((term) => term.matched).map((term) => term.term);
	expect(matches).toEqual(expect.arrayContaining(["typescript", "system design", "machine-learning", "react-native"]));
	expect(
		[...report.terms.map((term) => term.term), ...report.excludedTerms].filter((term) => term.includes("typescript")),
	).toEqual(["typescript"]);
});

it.each([
	{
		// Adapted from Parloa's Lead Solutions Engineer posting and the ZynoStack engineering ad.
		jobText:
			"Work with clients and explain each client's needs across modern technology stacks. Requirements: AWS, React, Kubernetes, system design, React Native, product management, mobile, SQL, Figma, SAP, customer service, platform engineering.",
		kept: [
			"aws",
			"react",
			"kubernetes",
			"system design",
			"react-native",
			"product-management",
			"mobile",
			"sql",
			"figma",
			"sap",
			"customer-service",
			"platform-engineering",
		],
		noise: ["client", "clients", "explain", "technology stacks", "modern technology", "customer", "platform"],
	},
	{
		// Adapted from Taqweed's Ecommerce Project Manager posting.
		jobText:
			"توضيح الحلول مع عملاء سعوديين في بيئة عمل مثالية على منصة تعمل على مدار الساعة. المتطلبات: إدارة المشاريع، متجر إلكتروني، SAP.",
		kept: ["إدارة المشاريع", "متجر إلكتروني", "sap"],
		noise: ["توضيح", "عملاء", "بيئة عمل", "منصة", "مثالية"],
	},
])("keeps real job skills and omits boilerplate: $jobText", ({ jobText, kept, noise }) => {
	const report = analyzeJobTerms({ identity, jobText, passages: [] });
	const terms = [...report.terms.map(({ term }) => term), ...report.excludedTerms];
	expect(terms).toEqual(expect.arrayContaining(kept));
	for (const term of noise) expect(terms).not.toContain(term);
	expect(report.identity.normalizationVersion).toBe("matching-v3");
});

it("ranks curated skills before repeated free text and requirements before other free text", () => {
	const jobText = "widgets, widgets, widgets, widgets, AWS.\nQualifications: SQL, microbiology.";
	const report = analyzeJobTerms({ identity, jobText, passages: [] });
	expect(report.terms.map(({ term }) => term)).toEqual(["sql", "aws", "microbiology", "widgets"]);
});
