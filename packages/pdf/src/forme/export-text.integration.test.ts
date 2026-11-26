import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { expect, it } from "vite-plus/test";
import * as forme from "@formepdf/core";
import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";
import { act } from "react";
import { getWebFontSource } from "@reactive-resume/fonts";
import { defaultResumeData } from "@reactive-resume/schema/resume/default";
import { DOCUMENT_FONT_PAIRINGS } from "@reactive-resume/schema/resume/font-policy";
import { createResumePdfFile } from "../server";
import { configureFontReader } from "./fonts";
import { lostCharacters, renderResume } from "./render";

function summaryResume(html: string, font = "Noto Sans", locale = "en-US") {
	const data = structuredClone(defaultResumeData);
	data.picture.hidden = true;
	data.summary.content = html;
	data.metadata.page.locale = locale;
	data.metadata.layout.pages = [{ fullWidth: true, main: ["summary"], sidebar: [] }];
	data.metadata.typography.body.fontFamily = font;
	data.metadata.typography.heading.fontFamily = font;
	return data;
}

async function exportText(html: string, font = "Noto Sans", locale = "en-US") {
	const data = summaryResume(html, font, locale);
	const file = await act(() => createResumePdfFile({ data, filename: "text.pdf" }));
	// PDF.js ignores /ActualText and infers separators from glyph positions, which corrupts
	// shaped clusters and emoji. Poppler reads the PDF's logical text, including these spans.
	const text = execFileSync("pdftotext", ["-enc", "UTF-8", "-", "-"], {
		input: Buffer.from(await file.arrayBuffer()),
		encoding: "utf8",
	});
	// Poppler adds directional wrappers and page/line separators; keep source marks and joiners.
	return text.replace(/[\u202A-\u202E]/g, "").replace(/\s+/g, " ");
}

it.each([
	["שלום עולם ניסיון עבודה", "Noto Sans Hebrew", "he-IL"],
	["שָׁלוֹם עוֹלָם", "Noto Sans Hebrew", "he-IL"],
	["مرحبا بالعالم مهندس برمجيات", "Noto Sans Arabic", "ar-SA"],
	["नमस्ते दुनिया अनुभव कौशल", "Noto Sans Devanagari", "hi-IN"],
	["प्रशिक्षण क्षेत्र दृष्टि क्षत्रिय", "Noto Sans Devanagari", "hi-IN"],
	["Hello 💻 engineer 🚀 coding 😀", "Noto Sans", "en-US"],
	["Family 👨‍👩‍👧‍👦 love 👩‍❤️‍💋‍👩 ❤️", "Noto Sans", "en-US"],
	["LessPass 6.1k⭐★ rated ★★★☆☆", "IBM Plex Sans", "en-US"],
] as const)("preserves exported Unicode text: %s", { timeout: 60_000 }, async (text, font, locale) => {
	expect(await exportText(`<p>${text}</p>`, font, locale)).toContain(text);
});

it("preserves exported Unicode text: 日本語の履歴書 職務経験", { timeout: 60_000 }, async () => {
	// Subsets of the catalog faces, including the two families requested as fallbacks.
	const fixtures = new Map(
		["Noto Sans JP", "Noto Sans SC", "Noto Sans"].flatMap((family) =>
			(["400", "700"] as const).map(
				(weight) =>
					[
						getWebFontSource(family, weight),
						new URL(`./__fixtures__/japanese-export/${family.replaceAll(" ", "")}-${weight}.ttf`, import.meta.url),
					] as const,
			),
		),
	);
	configureFontReader((source) => {
		const fixture = fixtures.get(source);
		if (!fixture) throw new Error(`No Japanese export font fixture for ${source}`);
		return readFile(fixture);
	});
	const text = "日本語の履歴書 職務経験";
	expect(await exportText(`<p>${text}</p>`, "Noto Sans JP", "ja-JP")).toContain(text);
});

it("exports Arabic without tashkeel per D33", { timeout: 60_000 }, async () => {
	const text = await exportText("<p>مَرْحَبًا بِالْعَالَمِ</p>", "Noto Sans Arabic", "ar-SA");
	expect(text).toContain("مرحبا بالعالم");
	expect(text).not.toMatch(/[ً-ْٰ]/u);
});

it.each(["span", "em", "a"])(
	"preserves word separators inside unmarked inline %s",
	{ timeout: 60_000 },
	async (tag) => {
		expect(
			await exportText(`<p>Hello<${tag}${tag === "a" ? ' href="https://example.com"' : ""}> world</${tag}></p>`),
		).toContain("Hello world");
	},
);

it('exports characters no font can draw as "?" and names them', { timeout: 60_000 }, async () => {
	expect(await exportText("<p>Unsupported \u{10FFFF}</p>")).toContain("Unsupported ?");
	const result = await act(() => renderResume(forme, { data: summaryResume("<p>Unsupported \u{10FFFF}</p>") }));
	expect(lostCharacters(result.warnings)).toEqual([expect.stringContaining("U+10FFFF")]);
});

it.each([
	...DOCUMENT_FONT_PAIRINGS.map(({ body, heading }) => [body, heading] as const),
	...[defaultResumeData.metadata.typography.body.fontFamily, "Noto Naskh Arabic", "Noto Sans Arabic"].map(
		(family) => [family, family] as const,
	),
])("preserves Arabic words and dates with %s body and %s headings", { timeout: 60_000 }, async (body, heading) => {
	const paragraph = "مهندس برمجيات يطور تطبيقات ويب.";
	const firstItem = "استدعاءات مباشرة لواجهات البرمجة.";
	const secondItem = "الدمج التلقائي للبيانات.";
	const bold = "لؤي يقرأ الوثائق ويكتب اختبارات واضحة.";
	const wrapped = "صممنا حلولا مرنة لحماية البيانات وتحسين جودة الخدمات.";
	const marked = [
		["\u200fتحليل البيانات ومراجعة النتائج.", "تحليل البيانات ومراجعة النتائج."],
		["طو\u200fرت خدمات الويب.", "طورت خدمات الويب."],
		["\u200eأدرت شؤون الفريق.", "أدرت شؤون الفريق."],
		["خطط\u061cت لتوسيع المشروع.", "خططت لتوسيع المشروع."],
	] as const;
	const raw = "١٤٤٥ هـ - ١٤٤٦ هـ";
	const date = "1445 هـ - 1446 هـ";
	const project = "مشروع التقويم";
	const data = summaryResume(
		`<p>${paragraph}</p><ul><li>${firstItem}</li><li>${secondItem}</li></ul><p><strong>${bold}</strong></p><p>${wrapped}</p>${marked.map(([source]) => `<p>${source}</p>`).join("")}`,
		body,
		"ar-SA",
	);
	data.metadata.typography.heading.fontFamily = heading;
	const name = "أحمد العتيبي";
	data.basics.name = `\u200f${name}`;
	data.metadata.template = "onyx";
	data.metadata.layout.pages[0]?.main.push("projects");
	data.sections.projects.items = [
		{
			id: "project",
			hidden: false,
			name: project,
			period: raw,
			dates: { start: null, end: null, present: false, raw },
			website: { url: "", label: "", inlineLink: false },
			description: "",
		},
	];
	const file = await act(() => createResumePdfFile({ data, filename: "arabic-leading.pdf" }));
	const bytes = new Uint8Array(await file.arrayBuffer());
	const popplerText = execFileSync("pdftotext", ["-enc", "UTF-8", "-", "-"], { input: bytes, encoding: "utf8" });
	const task = getDocument({ data: bytes.slice() });
	let pdfjsText = "";
	try {
		const doc = await task.promise;
		for (let pageNumber = 1; pageNumber <= doc.numPages; pageNumber++) {
			const page = await doc.getPage(pageNumber);
			const content = await page.getTextContent({ disableNormalization: true });
			pdfjsText +=
				content.items.flatMap((item) => ("str" in item ? [item.str + (item.hasEOL ? "\n" : "")] : [])).join("") + "\n";
		}
	} finally {
		await task.destroy();
	}
	expect(pdfjsText).toContain("مهندس");
	expect(pdfjsText).toContain("استدعاءات");
	expect(pdfjsText).toContain("الدمج");
	for (const [reader, output] of [
		["PDF.js", pdfjsText],
		["Poppler", popplerText],
	] as const) {
		const lines = output.replace(/[\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/gu, "").split("\n");
		const text = lines.join(" ").replace(/\s+/gu, " ");
		expect
			.soft(
				lines.map((line) => line.trim()),
				reader,
			)
			.toContain(name);
		const sentences = [paragraph, firstItem, secondItem, bold, wrapped, ...marked.map(([, expected]) => expected)];
		// Each sentence must appear verbatim. Allow the readers to position the list markers differently.
		const sentencePattern = sentences.map((sentence) => sentence.replaceAll(".", "\\.")).join("[ •]*");
		expect.soft(text, reader).toMatch(new RegExp(sentencePattern, "u"));
		const entry = lines.find((line) => line.includes(project)) ?? "";
		expect.soft(entry.replace(/\s+/gu, " "), `${reader} project date`).toContain(date);
	}
});
