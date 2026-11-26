import type { PdfLineOrder, PdfTextRun } from "./types";
import bidiFactory from "bidi-js";

export type PdfBidiParagraph = {
	text: string;
	baseDirection: "ltr" | "rtl";
	start: number;
	end: number;
};

export const bidi = bidiFactory();

/** UAX #9 maps logical text to display positions, within inclusive UTF-16 line boundaries. */
export function pdfDisplayIndices({ text, baseDirection, start, end }: PdfBidiParagraph): number[] {
	const embedding = bidi.getEmbeddingLevels(text, baseDirection);
	return bidi.getReorderedIndices(text, embedding, start, end).slice(start, end + 1);
}

/** Compare forward display positions without reordering characters inside known logical runs. */
export function resolvePdfLineOrder(runs: readonly PdfTextRun[], paragraph: PdfBidiParagraph): PdfLineOrder {
	const stream = runs.map((_, index) => index);
	const text = runs.map((run) => run.text).join("");
	const visual = runs.map((run, index) => ({ run, index })).sort((a, b) => a.run.box.x - b.run.box.x);
	const ambiguous = { text, runOrder: stream, recovery: "ambiguous" } as const;
	if (runs.some(({ box }) => !Object.values(box).every(Number.isFinite) || box.width <= 0)) return ambiguous;
	if (runs.some((run) => !run.logicalOrderKnown)) return ambiguous;
	if (runs.length < 2) return { text, runOrder: stream, recovery: "exact" };

	const indices = pdfDisplayIndices(paragraph);
	const offsets: number[] = [];
	for (const [index, run] of runs.entries()) {
		for (let offset = 0; offset < run.text.length; offset++) offsets.push(index);
	}
	const display = [...new Set(indices.map((index) => offsets[index - paragraph.start]))];
	if (display.length === visual.length && visual.every(({ index }, position) => display[position] === index))
		return { text, runOrder: stream, recovery: "exact" };
	if (runs.every(({ direction }) => direction === runs[0]?.direction)) {
		const order = runs[0]?.direction === "rtl" ? visual.reverse() : visual;
		return {
			text: order.map(({ run }) => run.text).join(""),
			runOrder: order.map(({ index }) => index),
			recovery: "exact",
		};
	}
	return ambiguous;
}
