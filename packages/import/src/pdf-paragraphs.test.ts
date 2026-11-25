import type { PdfLogicalLine } from "@reactive-resume/resume/ats-pdf";
import { expect, it } from "vite-plus/test";
import { assemblePdfParagraphs } from "./pdf-paragraphs";
import { parsePdfResume } from "./plain-text";

function line(text: string, y: number, options: Partial<PdfLogicalLine> = {}): PdfLogicalLine {
	return {
		id: `1:${y}`,
		text,
		words: text.split(" "),
		box: { x: 20, y, width: 220, height: 10 },
		blockId: null,
		role: "paragraph",
		direction: "ltr",
		recovery: "exact",
		...options,
	};
}

it("recognizes aligned label and value rows with their own fonts in Arabic lists", () => {
	const options = { direction: "rtl" } as const;
	const heading = { ...options, role: "heading", fontRef: "section" } as const;
	const label = { ...options, fontRef: "bold" };
	const value = { ...options, fontRef: "regular" };
	const indentedLabel = (y: number) => ({ ...label, box: { x: 20, y, width: 208, height: 10 } });
	const data = parsePdfResume(
		assemblePdfParagraphs([
			line("المهارات", 0, heading),
			line("البيانات", 24, indentedLabel(24)),
			line("SQL، Redis", 40, value),
			line("التطوير", 60, indentedLabel(60)),
			line("TypeScript، React", 76, value),
			line("اللغات", 103, heading),
			line("العربية", 125, label),
			line("اللغة الأم", 140, value),
			line("الإنجليزية", 171, label),
			line("إجادة مهنية", 186, value),
		]),
		{ locale: "ar-SA" },
	);
	expect(data.sections.skills.items.map(({ name, keywords }) => [name, keywords])).toEqual([
		["البيانات", ["SQL", "Redis"]],
		["التطوير", ["TypeScript", "React"]],
	]);
	expect(data.sections.languages.items.map(({ language, fluency }) => [language, fluency])).toEqual([
		["العربية", "اللغة الأم"],
		["الإنجليزية", "إجادة مهنية"],
	]);
});

it("unwraps a summary without merging headings bullets or columns", () => {
	const result = assemblePdfParagraphs([
		line("Summary", 0, { role: "heading" }),
		line("Built AI-", 20, { blockId: "summary-a" }),
		line("assisted tools.", 34, { blockId: "summary-a" }),
		line("Recorded decision-", 62, { blockId: "summary-b" }),
		line("next day.", 76, { blockId: "summary-b" }),
		line("• Kept a list", 103, { role: "list-item" }),
		line("Work Experience", 121, { role: "heading" }),
		line("Horizon Systems | Software Engineer", 140, { role: "line" }),
		line("2020 - 2022", 155, { role: "line" }),
		line("• Built secure services", 172, { role: "list-item" }),
		line("Skills", 20, { role: "heading", column: 1 }),
		line("TypeScript", 35, { role: "line", column: 1 }),
	]);
	expect(result.filter((paragraph) => paragraph.role === "paragraph").map((paragraph) => paragraph.text)).toEqual([
		"Built AI-assisted tools.",
		"Recorded decision- next day.",
	]);
	expect(result[1]?.sourceLineIds).toEqual(["1:20", "1:34"]);
	expect(result.filter(({ role }) => role === "list-item")).toHaveLength(2);
	const data = parsePdfResume(result);
	expect(data.summary.content).toContain("AI-assisted");
	expect(data.summary.content).not.toContain("<p>AI-</p>");
	expect(data.summary.content.match(/<p>/gu)).toHaveLength(2);
	expect(data.summary.content).toContain("decision- next");
	expect(data.sections.experience.items[0]?.company).toBe("Horizon Systems");
});

it("removes a soft hyphen only at a proven wrap", () => {
	expect(
		assemblePdfParagraphs([line("Used docu\u00ad", 0, { blockId: "p" }), line("mentation.", 14, { blockId: "p" })])[0]
			?.text,
	).toBe("Used documentation.");
});

it("unwraps hyphenated words on untagged summary lines", () => {
	const paragraphs = assemblePdfParagraphs([
		line("Summary", 0, { role: "heading" }),
		line("Built AI-", 20, { role: "line" }),
		line("assisted tools for full-", 34, { role: "line" }),
		line("stack development.", 48, { role: "line" }),
	]);
	expect(paragraphs[1]).toMatchObject({
		text: "Built AI-assisted tools for full-stack development.",
		sourceLineIds: ["1:20", "1:34", "1:48"],
	});
});

it.each([
	["Experience", "Built and maintained application services", "for the customer portal."],
	["Projects", "Built and maintained application services", "for the customer portal."],
	["الخبرة العملية", "طورت وصنت خدمات التطبيقات", "الخاصة ببوابة العملاء."],
])("unwraps prose in %s without merging entry metadata", (heading, first, second) => {
	const options = { role: "line", direction: heading === "الخبرة العملية" ? "rtl" : "ltr" } as const;
	const paragraphs = assemblePdfParagraphs([
		line(heading, 0, { role: "heading" }),
		line("Horizon Systems | Software Engineer", 14, options),
		line("2020 - 2022", 28, options),
		line(first, 42, options),
		line(second, 56, options),
	]);
	expect(paragraphs.map(({ text }) => text)).toEqual([
		heading,
		"Horizon Systems | Software Engineer",
		"2020 - 2022",
		`${first} ${second}`,
	]);
	expect(paragraphs[3]?.sourceLineIds).toEqual(["1:42", "1:56"]);
});

it("continues an ambiguous Arabic bullet across a Latin lead and a short tail", () => {
	const rtl = { direction: "rtl", role: "line" } as const;
	expect(
		assemblePdfParagraphs([
			line("الخبرة العملية", 0, { ...rtl, role: "heading" }),
			line("• عملت مع الفريق باستخدام أدوات", 14, { ...rtl, role: "list-item", recovery: "ambiguous" }),
			line("Codex في مراجعة الشيفرة", 28, rtl),
			line("والدمج.", 42, rtl),
		])[1],
	).toMatchObject({
		text: "• عملت مع الفريق باستخدام أدوات Codex في مراجعة الشيفرة والدمج.",
		role: "list-item",
		sourceLineIds: ["1:14", "1:28", "1:42"],
		recovery: "ambiguous",
	});
});

it("unwraps capitalized English education prose", () => {
	const body = { role: "line" } as const;
	expect(
		assemblePdfParagraphs([
			line("Education", 0, { role: "heading" }),
			line("Developed an independent research project using", 14, body),
			line("Chrome and open web tooling.", 28, body),
		]).map(({ text }) => text),
	).toEqual(["Education", "Developed an independent research project using Chrome and open web tooling."]);
});

it("keeps adjacent school and qualification lines distinct even within one PDF block", () => {
	const options = { blockId: "education", producer: "Forme" } as const;
	const paragraphs = assemblePdfParagraphs([
		line("Education", 0, { role: "heading" }),
		line("Western Institute for Applied Arts 2020", 20, options),
		line("Bachelor of Arts in Design", 34, options),
		line("Design Studies | London", 48, options),
	]);
	expect(paragraphs.slice(1).map(({ sourceLineIds }) => sourceLineIds)).toEqual([["1:20"], ["1:34"], ["1:48"]]);
});

it("keeps undated project titles in their own entries", () => {
	const title = { role: "line", fontRef: "bold" } as const;
	const body = { role: "line", fontRef: "regular" } as const;
	const data = parsePdfResume(
		assemblePdfParagraphs([
			line("Projects", 0, { role: "heading" }),
			line("Dark Factory", 20, title),
			line("Built a system for review automation.", 34, body),
			line("Hena Wadeena", 55, title),
			line("Created a directory for local events.", 69, body),
			line("Auto PR", 90, title),
			line("Integrated checks with pull requests.", 104, body),
		]),
	);
	expect(data.sections.projects.items.map(({ name }) => name)).toEqual(["Dark Factory", "Hena Wadeena", "Auto PR"]);
});

it("keeps a project link label from becoming the header of the dated project below it", () => {
	const title = { fontRef: "bold" };
	const body = { fontRef: "regular" };
	const data = parsePdfResume(
		assemblePdfParagraphs([
			line("Projects", 0, { role: "heading" }),
			line("Dark Factory", 22, title),
			line("Built a system for review automation.", 38, body),
			line("Repository", 54, body),
			line("Hena Wadeena", 75, title),
			line("03/2026 – 04/2026", 75, { ...body, id: "1:76" }),
			line("Created a directory for local events.", 91, body),
		]),
	);
	expect(data.sections.projects.items.map(({ name }) => name)).toEqual(["Dark Factory", "Hena Wadeena"]);
});
