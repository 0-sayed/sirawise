import type { ExtractedDocument } from "@reactive-resume/resume/ats-pdf";
import type { RawExtraction } from "@reactive-resume/resume/ats-pdf";
import assert from "node:assert/strict";
import { expect, it } from "vite-plus/test";
import summaryItems from "./fixtures/pdf-summary-items.json";
import { documentToLines, pdfImportText } from "./pdf-lines";
import { parsePdfResume } from "./plain-text";

function document(rtl: boolean, columns = false): ExtractedDocument {
	const spans = [
		{ text: rtl ? "الأفق" : "Horizon", x: 100, width: 40, dir: rtl ? ("rtl" as const) : ("ltr" as const) },
		{ text: rtl ? "شركة" : "Systems", x: 145, width: 30, dir: rtl ? ("rtl" as const) : ("ltr" as const) },
	].map((span, streamIndex) => ({ ...span, y: 10, height: 10, fontSize: 10, fontRef: "font", streamIndex }));
	const lines = [
		{
			text: "",
			spans,
			x: 100,
			y: 10,
			width: 75,
			height: 10,
			page: 1,
			fontSize: 10,
			fontRef: "font",
			meanStreamIndex: 0,
		},
	];
	const page = {
		pageNumber: 1,
		width: 595,
		height: 842,
		lines,
		inversionRatio: 0,
		gutter: columns ? { x: 140, width: 5, coverage: 1, splitRatio: 0.5 } : null,
		margins: { top: 10, bottom: 10, left: 10, right: 10 },
		textAreaRatio: 0.1,
	};
	return {
		pages: [page],
		lines,
		fullText: "",
		charCount: 0,
		wordCount: 0,
		modalFontSize: 10,
		modalFontRef: "font",
		distinctFontRefs: 1,
	};
}
it("joins split RTL runs in logical order without reversing characters", () => {
	expect(documentToLines(document(true))).toEqual(["شركة الأفق"]);
	expect(documentToLines(document(false))).toEqual(["Horizon Systems"]);
});
it("reads RTL columns right first while retaining English left-first order", () => {
	expect(documentToLines(document(true, true))).toEqual(["شركة", "الأفق"]);
	expect(documentToLines(document(false, true))).toEqual(["Horizon", "Systems"]);
});

it("does not let a longer numeric date override an Arabic row", () => {
	const doc = document(true);
	const row = doc.pages[0]?.lines[0];
	const date = row?.spans[0];
	const role = row?.spans[1];
	assert(date && role);
	date.text = "2020 - 2022";
	date.dir = "ltr";
	role.text = "مهندس";
	expect(documentToLines(doc)).toEqual(["مهندس 2020 - 2022"]);
});

it("uses declared document direction for columns containing long Latin contacts", () => {
	const doc = document(true, true);
	Object.assign(doc, { direction: "rtl" });
	const contact = doc.pages[0]?.lines[0]?.spans[0];
	assert(contact);
	contact.text = "very.long.synthetic.contact@example.test";
	contact.dir = "ltr";
	expect(documentToLines(doc)[0]).toBe("شركة");
});

it.each([true, false])("keeps vertically separated header/body bands in page order (RTL=%s)", (rtl) => {
	const doc = document(rtl, true);
	const page = doc.pages[0];
	const first = page?.lines[0];
	const left = first?.spans[0];
	const right = first?.spans[1];
	assert(page && first && left && right);
	const header = { ...left, text: "Header", y: 10 };
	const body = { ...right, text: "Body", y: 40 };
	page.lines = [
		{ ...first, spans: [header], y: 10 },
		{ ...first, spans: [body], y: 40 },
	];
	Object.assign(doc, { direction: rtl ? "rtl" : "ltr" });
	expect(documentToLines(doc)).toEqual(["Header", "Body"]);
});

it("preserves Arabic word spaces from explicit PDF space items, avoids mid-word glyph-run splits, and orders mixed RTL lines cleanly", () => {
	const raw = {
		version: 1 as const,
		file: { name: "arabic-cv.pdf", sizeBytes: 1024, magicBytesOk: true },
		pageCount: 1,
		truncated: false,
		fonts: [
			{
				ref: "f1",
				name: "Cairo",
				isType3: false,
				isInvalid: false,
				missingFile: false,
				isMonospace: false,
				isSerif: false,
				vertical: false,
			},
		],
		links: [],
		metadata: {
			producer: null,
			creator: null,
			title: null,
			author: null,
			language: "ar-SA",
			pdfVersion: "1.7",
			isEncrypted: false,
			isXfa: false,
			isCollection: false,
			isTagged: true,
			hasAcroForm: false,
		},
		operatorsAvailable: false,
		pages: [
			{
				pageNumber: 1,
				width: 595,
				height: 842,
				rotation: 0,
				operators: null,
				items: [
					// Narrow 2pt space items between Arabic words (< 0.25 * 12 = 3pt), plus a mid-word glyph-run split ("برمج" + "يات") with 3.2pt box slack and NO space item
					{
						str: "مهندس",
						transform: [12, 0, 0, 12, 460, 750] as const,
						width: 40,
						height: 12,
						fontRef: "f1",
						hasEol: false,
						dir: "rtl" as const,
					},
					{
						str: " ",
						transform: [12, 0, 0, 12, 458, 750] as const,
						width: 2,
						height: 12,
						fontRef: "f1",
						hasEol: false,
						dir: "rtl" as const,
					},
					{
						str: "برمج",
						transform: [12, 0, 0, 12, 434, 750] as const,
						width: 24,
						height: 12,
						fontRef: "f1",
						hasEol: false,
						dir: "rtl" as const,
					},
					{
						str: "يات",
						transform: [12, 0, 0, 12, 412, 750] as const,
						width: 18.8,
						height: 12,
						fontRef: "f1",
						hasEol: false,
						dir: "rtl" as const,
					},
					{
						str: " ",
						transform: [12, 0, 0, 12, 410, 750] as const,
						width: 2,
						height: 12,
						fontRef: "f1",
						hasEol: false,
						dir: "rtl" as const,
					},
					{
						str: "أول",
						transform: [12, 0, 0, 12, 390, 750] as const,
						width: 20,
						height: 12,
						fontRef: "f1",
						hasEol: true,
						dir: "rtl" as const,
					},
					// Mixed RTL line with Latin employer name "BandAI"
					{
						str: "عمل",
						transform: [12, 0, 0, 12, 470, 720] as const,
						width: 25,
						height: 12,
						fontRef: "f1",
						hasEol: false,
						dir: "rtl" as const,
					},
					{
						str: " ",
						transform: [12, 0, 0, 12, 468, 720] as const,
						width: 2,
						height: 12,
						fontRef: "f1",
						hasEol: false,
						dir: "rtl" as const,
					},
					{
						str: "لدى",
						transform: [12, 0, 0, 12, 444, 720] as const,
						width: 24,
						height: 12,
						fontRef: "f1",
						hasEol: false,
						dir: "rtl" as const,
					},
					{
						str: " ",
						transform: [12, 0, 0, 12, 442, 720] as const,
						width: 2,
						height: 12,
						fontRef: "f1",
						hasEol: false,
						dir: "rtl" as const,
					},
					{
						str: "BandAI",
						transform: [12, 0, 0, 12, 395, 720] as const,
						width: 45,
						height: 12,
						fontRef: "f1",
						hasEol: true,
						dir: "ltr" as const,
					},
				],
			},
		],
	};
	expect(pdfImportText(raw).lines).toEqual(["مهندس برمجيات أول", "عمل لدى BandAI"]);
});

it("repairs word-tokenized Chromium Arabic PDFs with overlapping RTL word boxes and spurious intra-word spaces", () => {
	// Exact page-1 text items observed in import-long.pdf ("مهندسبرمج يات" -> "مهندس برمجيات", "الملخ ص" -> "الملخص")
	const raw = {
		version: 1 as const,
		file: { name: "import-long.pdf", sizeBytes: 2048, magicBytesOk: true },
		pageCount: 1,
		truncated: false,
		fonts: [
			{
				ref: "f1",
				name: "IBMPlexSansArabic",
				isType3: false,
				isInvalid: false,
				missingFile: false,
				isMonospace: false,
				isSerif: false,
				vertical: false,
			},
		],
		links: [],
		metadata: {
			producer: null,
			creator: null,
			title: null,
			author: null,
			language: "ar-SA",
			pdfVersion: "1.7",
			isEncrypted: false,
			isXfa: false,
			isCollection: false,
			isTagged: true,
			hasAcroForm: false,
		},
		operatorsAvailable: false,
		pages: [
			{
				pageNumber: 1,
				width: 595,
				height: 842,
				rotation: 0,
				operators: null,
				items: [
					{
						str: "Sayed Ashraf",
						transform: [21, 0, 0, 21, 447.49, 808.37] as const,
						width: 133.79,
						height: 21,
						fontRef: "f1",
						hasEol: false,
						dir: "ltr" as const,
					},
					{
						str: "",
						transform: [0, 0, 0, 0, 523.13, 789.24] as const,
						width: 0,
						height: 0,
						fontRef: "f1",
						hasEol: true,
						dir: "ltr" as const,
					},
					{
						str: "برمج يات",
						transform: [10, 0, 0, 10, 523.13, 789.24] as const,
						width: 35.93,
						height: 10,
						fontRef: "f1",
						hasEol: false,
						dir: "rtl" as const,
					},
					{
						str: "مهندس",
						transform: [10, 0, 0, 10, 555.12, 789.24] as const,
						width: 27.01,
						height: 10,
						fontRef: "f1",
						hasEol: false,
						dir: "rtl" as const,
					},
					{
						str: "",
						transform: [0, 0, 0, 0, 539.24, 726.74] as const,
						width: 0,
						height: 0,
						fontRef: "f1",
						hasEol: true,
						dir: "ltr" as const,
					},
					{
						str: "الملخ ص",
						transform: [14, 0, 0, 14, 539.24, 726.74] as const,
						width: 45.11,
						height: 14,
						fontRef: "f1",
						hasEol: false,
						dir: "rtl" as const,
					},
					{
						str: "",
						transform: [0, 0, 0, 0, 30.31, 708.74] as const,
						width: 0,
						height: 0,
						fontRef: "f1",
						hasEol: true,
						dir: "ltr" as const,
					},
					{
						str: "بالذ كاء",
						transform: [10, 0, 0, 10, 30.31, 708.74] as const,
						width: 25.42,
						height: 10,
						fontRef: "f1",
						hasEol: false,
						dir: "rtl" as const,
					},
					{
						str: "التطوير",
						transform: [10, 0, 0, 10, 55.82, 708.74] as const,
						width: 27.38,
						height: 10,
						fontRef: "f1",
						hasEol: false,
						dir: "rtl" as const,
					},
					{
						str: " ",
						transform: [0, 0, 0, 0, 83.2, 708.74] as const,
						width: 3.06,
						height: 0,
						fontRef: "f1",
						hasEol: false,
						dir: "ltr" as const,
					},
					{
						str: "ف ي",
						transform: [10, 0, 0, 10, 86.26, 708.74] as const,
						width: 12.22,
						height: 10,
						fontRef: "f1",
						hasEol: false,
						dir: "rtl" as const,
					},
					{
						str: "للمساعدة",
						transform: [10, 0, 0, 10, 98.53, 708.74] as const,
						width: 31.73,
						height: 10,
						fontRef: "f1",
						hasEol: false,
						dir: "rtl" as const,
					},
				],
			},
		],
	};
	expect(pdfImportText(raw).lines).toEqual(["Sayed Ashraf", "مهندس برمجيات", "الملخص", "للمساعدة في التطوير بالذكاء"]);
});

it("preserves word spaces in normal multi-word Arabic PDFs that have reversed city/company header pairs", () => {
	// Exact page-1 text items from exported Arabic CV PDF (run6-import-arabic.pdf):
	// Full multi-word RTL lines plus reversed [City] [Company] pairs on experience rows.
	const raw = {
		version: 1 as const,
		file: { name: "run6-import-arabic.pdf", sizeBytes: 2048, magicBytesOk: true },
		pageCount: 1,
		truncated: false,
		fonts: [
			{
				ref: "f1",
				name: "IBMPlexSansArabic",
				isType3: false,
				isInvalid: false,
				missingFile: false,
				isMonospace: false,
				isSerif: false,
				vertical: false,
			},
		],
		links: [],
		metadata: {
			producer: null,
			creator: null,
			title: null,
			author: null,
			language: "ar-SA",
			pdfVersion: "1.7",
			isEncrypted: false,
			isXfa: false,
			isCollection: false,
			isTagged: true,
			hasAcroForm: false,
		},
		operatorsAvailable: false,
		pages: [
			{
				pageNumber: 1,
				width: 595,
				height: 842,
				rotation: 0,
				operators: null,
				items: [
					{
						str: "نواف السهلي",
						transform: [21, 0, 0, 21, 451.1, 785.2] as const,
						width: 108.2,
						height: 21,
						fontRef: "f1",
						hasEol: false,
						dir: "rtl" as const,
					},
					{
						str: "مدير عمليات المنتجات وتحسين الخدمات",
						transform: [11, 0, 0, 11, 392.9, 765.1] as const,
						width: 166.3,
						height: 11,
						fontRef: "f1",
						hasEol: false,
						dir: "rtl" as const,
					},
					{
						str: "الرياض",
						transform: [11, 0, 0, 11, 448.6, 517.8] as const,
						width: 28.4,
						height: 11,
						fontRef: "f1",
						hasEol: false,
						dir: "rtl" as const,
					},
					{
						str: " ",
						transform: [11, 0, 0, 11, 477, 517.8] as const,
						width: 5.2,
						height: 0,
						fontRef: "f1",
						hasEol: false,
						dir: "ltr" as const,
					},
					{
						str: "استوديو جسر الغد",
						transform: [11, 0, 0, 11, 482.2, 517.8] as const,
						width: 77.1,
						height: 11,
						fontRef: "f1",
						hasEol: false,
						dir: "rtl" as const,
					},
					{
						str: "الرياض",
						transform: [11, 0, 0, 11, 448.8, 442.5] as const,
						width: 28.4,
						height: 11,
						fontRef: "f1",
						hasEol: false,
						dir: "rtl" as const,
					},
					{
						str: " ",
						transform: [11, 0, 0, 11, 477.2, 442.5] as const,
						width: 5.2,
						height: 0,
						fontRef: "f1",
						hasEol: false,
						dir: "ltr" as const,
					},
					{
						str: "شركة مرسى الأفكار",
						transform: [11, 0, 0, 11, 482.4, 442.5] as const,
						width: 76.9,
						height: 11,
						fontRef: "f1",
						hasEol: false,
						dir: "rtl" as const,
					},
				],
			},
		],
	};
	expect(pdfImportText(raw).lines).toEqual([
		"نواف السهلي",
		"مدير عمليات المنتجات وتحسين الخدمات",
		"استوديو جسر الغد الرياض",
		"شركة مرسى الأفكار الرياض",
	]);
});

it.each([true, false])("reads staggered real columns as complete columns (RTL=%s)", (rtl) => {
	const left = ["Skills", "TypeScript", "PostgreSQL", "React", "Docker", "Linux"];
	const right = ["Experience", "Engineer", "Horizon Labs", "2021 - 2024", "Built software", "Led delivery"];
	const doc = document(rtl, true);
	const page = doc.pages[0];
	const first = page?.lines[0];
	const span = first?.spans[0];
	assert(page && first && span);
	// Both columns occupy the same page region, but their 10pt rows are offset by 15pt.
	page.gutter = { x: 120, width: 210, coverage: 1, splitRatio: 0.5 };
	page.lines = left.flatMap((text, index) =>
		[text, right[index]].map((value, side) => {
			assert(value);
			const y = 60 + index * 30 + side * 15;
			return {
				...first,
				y,
				spans: [{ ...span, text: value, x: side === 0 ? 50 : 330, width: 70, y, height: 10 }],
			};
		}),
	);
	Object.assign(doc, { direction: rtl ? "rtl" : "ltr" });
	expect(documentToLines(doc)).toEqual(rtl ? [...right, ...left] : [...left, ...right]);
});

it.each([false, true])("spaces overlapping scripts and preserves attached prefixes (semantic=%s)", (semantic) => {
	// Real text items from exported Arabic CV (exported-long-cv.pdf):
	// "BandAI" overlaps "بصف ة" (-0.5pt) and "Salla" overlaps "وإض اف ة" (-3.7pt), while "و" attaches to "TypeScript".
	const raw = {
		version: 1 as const,
		file: { name: "exported-long-cv.pdf", sizeBytes: 2048, magicBytesOk: true },
		pageCount: 1,
		truncated: false,
		fonts: [
			{
				ref: "f1",
				name: "NotoNaskhArabic",
				isType3: false,
				isInvalid: false,
				missingFile: false,
				isMonospace: false,
				isSerif: false,
				vertical: false,
			},
		],
		links: [],
		metadata: {
			producer: "Forme",
			creator: "Forme",
			title: null,
			author: null,
			language: "ar-SA",
			pdfVersion: "1.7",
			isEncrypted: false,
			isXfa: false,
			isCollection: false,
			isTagged: true,
			hasAcroForm: false,
		},
		operatorsAvailable: false,
		pages: [
			{
				pageNumber: 1,
				width: 595,
				height: 842,
				rotation: 0,
				...(semantic ? { structure: [] } : {}),
				operators: null,
				items: [
					{
						str: "بصف ة",
						transform: [10, 0, 0, 10, 453.4, 693.7] as const,
						width: 20.9,
						height: 10,
						fontRef: "f1",
						hasEol: false,
						dir: "rtl" as const,
					},
					{
						str: "BandAI",
						transform: [10, 0, 0, 10, 473.8, 693.7] as const,
						width: 35.0,
						height: 10,
						fontRef: "f1",
						hasEol: false,
						dir: "ltr" as const,
					},
					{
						str: "ف ي",
						transform: [10, 0, 0, 10, 511.1, 693.7] as const,
						width: 12.2,
						height: 10,
						fontRef: "f1",
						hasEol: false,
						dir: "rtl" as const,
					},
					{
						str: "وإض اف ة",
						transform: [10, 0, 0, 10, 93.9, 693.7] as const,
						width: 31.2,
						height: 10,
						fontRef: "f1",
						hasEol: false,
						dir: "rtl" as const,
					},
					{
						str: "Salla",
						transform: [10, 0, 0, 10, 121.4, 693.7] as const,
						width: 21.8,
						height: 10,
						fontRef: "f1",
						hasEol: false,
						dir: "ltr" as const,
					},
					{
						str: "تطبيق",
						transform: [10, 0, 0, 10, 145.6, 693.7] as const,
						width: 25.0,
						height: 10,
						fontRef: "f1",
						hasEol: false,
						dir: "rtl" as const,
					},
					{
						str: "TypeScript",
						transform: [10, 0, 0, 10, 318.55, 708.7] as const,
						width: 51.63,
						height: 10,
						fontRef: "f1",
						hasEol: false,
						dir: "ltr" as const,
					},
					{
						str: "و",
						transform: [10, 0, 0, 10, 370.18, 708.7] as const,
						width: 4.68,
						height: 10,
						fontRef: "f1",
						hasEol: false,
						dir: "rtl" as const,
					},
					{
						str: " ",
						transform: [10, 0, 0, 10, 374.86, 708.7] as const,
						width: 2.32,
						height: 0,
						fontRef: "f1",
						hasEol: false,
						dir: "ltr" as const,
					},
					{
						str: "Node.js",
						transform: [10, 0, 0, 10, 377.18, 708.7] as const,
						width: 35.45,
						height: 10,
						fontRef: "f1",
						hasEol: false,
						dir: "ltr" as const,
					},
				],
			},
		],
	};
	expect(pdfImportText(raw).lines).toEqual(["Node.js وTypeScript", "ف ي BandAI بصف ة  تطبيق Salla وإض اف ة"]);
});

it.each([false, true])("normalizes leading RTL percent signs and preserves URLs (semantic=%s)", (semantic) => {
	const raw = {
		version: 1 as const,
		file: { name: "exported-arabic-cv.pdf", sizeBytes: 2048, magicBytesOk: true },
		pageCount: 1,
		truncated: false,
		fonts: [
			{
				ref: "f1",
				name: "NotoNaskhArabic",
				isType3: false,
				isInvalid: false,
				missingFile: false,
				isMonospace: false,
				isSerif: false,
				vertical: false,
			},
		],
		links: [],
		metadata: {
			producer: "Forme",
			creator: "Forme",
			title: null,
			author: null,
			language: "ar-SA",
			pdfVersion: "1.7",
			isEncrypted: false,
			isXfa: false,
			isCollection: false,
			isTagged: true,
			hasAcroForm: false,
		},
		operatorsAvailable: false,
		pages: [
			{
				pageNumber: 1,
				width: 595,
				height: 842,
				rotation: 0,
				...(semantic ? { structure: [] } : {}),
				operators: null,
				items: [
					{
						str: "طور تقارير الجودة الأسبوعية وخفض وقت إعدادها بنسبة %16. خفض زمن إعداد التقارير بنسبة %22",
						transform: [11, 0, 0, 11, 50.2, 605.6] as const,
						width: 511.7,
						height: 11,
						fontRef: "f1",
						hasEol: false,
						dir: "rtl" as const,
					},
					{
						str: "https://example.test/cv%20file.pdf",
						transform: [11, 0, 0, 11, 50.2, 585.6] as const,
						width: 200,
						height: 11,
						fontRef: "f1",
						hasEol: false,
						dir: "ltr" as const,
					},
				],
			},
		],
	};
	expect(pdfImportText(raw).lines).toEqual([
		"طور تقارير الجودة الأسبوعية وخفض وقت إعدادها بنسبة 16%. خفض زمن إعداد التقارير بنسبة 22%",
		"https://example.test/cv%20file.pdf",
	]);
});

it.each([false, true])("recovers the long Arabic PDF summary (semantic=%s)", (semantic) => {
	const raw = summaryItems.long as unknown as RawExtraction;
	const { lines } = pdfImportText({
		...raw,
		pages: raw.pages.map((page) => (semantic ? { ...page, structure: [] } : page)),
	});
	expect(lines[0]).toBe("الملخص");
	expect(lines[1]).toMatch(/^مهندس برمجيات يطور/u);
	expect(lines.join("\n")).toContain("Salla وإضافة");
});

it.each(["arabic", "english"] as const)("imports the actual %s PDF summary as one paragraph", (name) => {
	const raw = summaryItems[name] as unknown as RawExtraction;
	const { paragraphUnits, locale } = pdfImportText({
		...raw,
		pages: raw.pages.map((page) => ({ ...page, structure: [] })),
	});
	const summary = parsePdfResume(paragraphUnits, locale ? { locale } : {}).summary.content;
	expect(summary.match(/<p>/gu)).toHaveLength(1);
	if (name === "english") {
		expect(summary).toContain("daily for AI-assisted development.");
	} else {
		expect(summary).toContain("بنسبة 22%");
		expect(summary).not.toContain("%22");
	}
});

it("keeps indistinguishable number and acronym order available only as partial import", () => {
	const source = summaryItems.arabic as unknown as RawExtraction;
	const page = source.pages[0];
	const sample = page?.items[0];
	assert(page && sample);
	const span = (str: string, x: number, width: number, dir: "ltr" | "rtl") => ({
		...sample,
		str,
		width,
		dir,
		markedContentId: "paragraph",
		transform: [10, 0, 0, 10, x, 200] as const,
	});
	const raw: RawExtraction = {
		...source,
		pages: [
			{
				...page,
				structure: [{ role: "P", contentIds: ["paragraph"] }],
				items: [
					span("قبل النشر.", 246.43, 41.35, "rtl"),
					span(" ", 287.78, 2.6, "ltr"),
					span("KPI", 290.38, 15.63, "ltr"),
					span(" ", 306.01, 2.6, "ltr"),
					span("راجعت 12", 308.61, 43, "rtl"),
				],
			},
		],
	};
	expect(() => pdfImportText(raw)).toThrow("The PDF text could not be read completely.");
	expect(pdfImportText(raw, { allowPartial: true })).toMatchObject({
		lines: ["راجعت 12 KPI قبل النشر."],
		partial: true,
	});
});
