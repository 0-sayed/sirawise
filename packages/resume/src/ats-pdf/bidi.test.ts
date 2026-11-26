import type { PdfTextRun } from "./types";
import type { Bidi } from "bidi-js";
import { expect, it } from "vite-plus/test";
import { bidi, pdfDisplayIndices, resolvePdfLineOrder } from "./bidi";

type BidiAdapter = Pick<Bidi, "getEmbeddingLevels" | "getReorderedIndices" | "getMirroredCharactersMap">;
type BidiConformanceResult = { passed: number; failed: { caseId: string; expected: string; actual: string }[] };

const cases = [
	{ id: "arabic", line: "نواف السهلي", direction: "rtl", display: "يلهسلا فاون" },
	{ id: "percent", line: "تحسن 22%", direction: "rtl", display: "%22 نسحت" },
	{ id: "brackets", line: "نتيجة (22%)", direction: "rtl", display: "(%22) ةجيتن" },
	{ id: "url", line: "رابط https://example.test", direction: "rtl", display: "https://example.test طبار" },
	{ id: "combining", line: "بِت", direction: "rtl", display: "تِب" },
	{ id: "mixed", line: "Update مرحبا", direction: "ltr", display: "Update ابحرم" },
] as const;

function qualifyBidiImplementation(adapter: BidiAdapter): BidiConformanceResult {
	const result: BidiConformanceResult = { passed: 0, failed: [] };
	for (const { id, line, direction, display } of cases) {
		const text = `Header\n${line}\nFooter`;
		const start = "Header\n".length;
		const end = start + line.length - 1;
		const embedding = adapter.getEmbeddingLevels(text, direction);
		const mirrored = adapter.getMirroredCharactersMap(text, embedding.levels, start, end);
		const actual = adapter
			.getReorderedIndices(text, embedding, start, end)
			.slice(start, end + 1)
			.map((index) => mirrored.get(index) ?? text[index])
			.join("");
		if (actual === display) result.passed++;
		else result.failed.push({ caseId: id, expected: display, actual });
	}
	return result;
}

it("qualifies bounded lines against authored Unicode 13 display order", () => {
	expect(qualifyBidiImplementation(bidi)).toEqual({ passed: cases.length, failed: [] });
});

it("returns only the requested inclusive range in the paragraph", () => {
	expect(pdfDisplayIndices({ text: "نواف السهلي", baseDirection: "rtl", start: 5, end: 10 })).toEqual([
		10, 9, 8, 7, 6, 5,
	]);
});

it("leaves already logical Arabic unchanged on repeated checks", () => {
	const runs: PdfTextRun[] = [
		{
			id: "name",
			text: "نواف ",
			direction: "rtl",
			box: { x: 50, y: 0, width: 20, height: 10 },
			logicalOrderKnown: true,
			endOfLine: false,
		},
		{
			id: "surname",
			text: "السهلي",
			direction: "rtl",
			box: { x: 12, y: 0, width: 30, height: 10 },
			logicalOrderKnown: true,
			endOfLine: true,
		},
	];
	const paragraph = { text: "نواف السهلي", baseDirection: "rtl", start: 0, end: 10 } as const;
	const result = resolvePdfLineOrder(runs, paragraph);
	expect(result).toEqual({ text: paragraph.text, runOrder: [0, 1], recovery: "exact" });
	expect(
		resolvePdfLineOrder(
			result.runOrder.flatMap((index) => runs.slice(index, index + 1)),
			paragraph,
		),
	).toEqual(result);
	expect(
		resolvePdfLineOrder(
			runs.map((run) => ({ ...run, logicalOrderKnown: false })),
			paragraph,
		),
	).toEqual({
		...result,
		recovery: "ambiguous",
	});
});
