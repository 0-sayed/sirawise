import type { HarvestOptions, RawExtraction } from "@reactive-resume/resume/ats-pdf";
import { readFile } from "node:fs/promises";
import { expect, it, vi } from "vite-plus/test";
import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";
import { normalizeImportedText } from "@reactive-resume/import/normalize";
import { harvestPdfDocument } from "@reactive-resume/resume/ats-pdf";
import { getImportPassageSelection, getImportSectionText } from "./ai-assistance";
import { extractPdfText } from "./pdf-text";

const pdf = vi.hoisted(() => ({
	extract: vi.fn<(file: File, options: Partial<HarvestOptions>) => Promise<RawExtraction>>(),
}));
vi.mock("@/features/ats-checker/extract-client", () => ({ extractPdf: pdf.extract }));

it.each([
	{ language: "en", school: "Example University", company: "Horizon Systems" },
	{ language: "ar", school: "جامعة الملك سعود", company: "شركة الأفق" },
	{ language: "mixed", school: "جامعة جدة", company: "شركة النور" },
])("keeps readable page lines and section/page selection for the real native $language PDF", async (fixture) => {
	const bytes = await readFile(
		new URL(`../../../../../../tooling/document-qualification/native/${fixture.language}.pdf`, import.meta.url),
	);
	const task = getDocument({ data: Uint8Array.from(bytes), fontExtraProperties: true });
	try {
		const raw = await harvestPdfDocument(await task.promise, {
			file: { name: `${fixture.language}.pdf`, sizeBytes: bytes.length, magicBytesOk: true },
		});
		pdf.extract.mockResolvedValue(raw);
		const extracted = await extractPdfText(new File([bytes], `${fixture.language}.pdf`));
		expect(extracted.pages.flatMap((page) => page.text.split("\n"))).toEqual(extracted.lines);
		const section = getImportSectionText(extracted.pages, "education", extracted.locale ?? "en-US");
		expect(section.matched).toBe(true);
		expect(normalizeImportedText(section.text)).toContain(fixture.school);
		expect(normalizeImportedText(section.text)).not.toContain(fixture.company);
		const quote = extracted.lines.find((line) => normalizeImportedText(line).includes(fixture.school));
		if (!quote) throw new Error("Missing original native school passage");
		const start = section.text.indexOf(quote);
		expect(getImportPassageSelection(section, start, start + quote.length)).toEqual({ text: quote, pages: [1] });
	} finally {
		await task.destroy();
	}
});

it.each([
	{ name: "ambiguous", partial: true, operatorCalls: 0, text: "Retained rotated text" },
	{ name: "app-arabic", partial: false, operatorCalls: 1, text: "مهندس برمجيات يعمل على خدمات آمنة." },
])(
	"keeps $name text with the expected coverage and operator budget",
	async ({ name, partial, operatorCalls, text }) => {
		const bytes = await readFile(
			new URL(`../../../../../../tooling/document-qualification/import-layout/${name}.pdf`, import.meta.url),
		);
		const task = getDocument({ data: Uint8Array.from(bytes) });
		try {
			const document = await task.promise;
			const page = await document.getPage(1);
			const operators = vi.spyOn(page, "getOperatorList");
			pdf.extract.mockImplementation(async (file, options) =>
				harvestPdfDocument(document, {
					...options,
					file: { name: file.name, sizeBytes: bytes.length, magicBytesOk: true },
				}),
			);
			const extracted = await extractPdfText(new File([bytes], `${name}.pdf`));
			expect(operators).toHaveBeenCalledTimes(operatorCalls);
			expect(extracted.partial).toBe(partial);
			expect(extracted.lines).toContain(text);
			expect(extracted.paragraphUnits.map((unit) => unit.text)).toContain(text);
			expect(extracted.pages.flatMap((item) => item.text.split("\n"))).toEqual(extracted.lines);
		} finally {
			await task.destroy();
		}
	},
);
