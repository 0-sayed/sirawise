import type { OperatorListLike } from "./analyze/operators";
import type {
	ColumnGutter,
	ExtractedDocument,
	PageGeometry,
	RawExtraction,
	RawPage,
	TextLine,
	TextSpan,
} from "./types";
import { normalizeArabicPresentationForms } from "@reactive-resume/utils/string";
import { normalizeSectionHeading, PDF_SECTION_HEADING_LOOKUP } from "../ats/section-aliases";
import { IDENTITY, multiply, toMatrix } from "./analyze/operators";
import { bidi } from "./bidi";
import { layoutPdfPage } from "./line-layout";
import { PDF_OPS } from "./pdf-ops";

/** Vertical slack when deciding two spans share a line, as a share of the modal font size. */
const LINE_TOLERANCE_RATIO = 0.35;
const MIN_LINE_TOLERANCE_PT = 2;

/** Horizontal gap, as a share of font size, above which two spans need a space between them. */
const SPACE_GAP_RATIO = 0.25;

/** Horizontal gap, as a share of font size, above which two spans sit in different columns. */
const COLUMN_GAP_RATIO = 1.5;
const MIN_COLUMN_GAP_PT = 12;

const HISTOGRAM_BIN_PT = 2;
const ROW_BIN_PT = 6;
const MIN_GUTTER_WIDTH_PT = 14;
/** Order statistic used for margins, so one stray run cannot define the page's edge. */
const MARGIN_PERCENTILE = 0.05;
/** A gutter has to sit somewhere near the middle; a wide right margin is not a column break. */
const GUTTER_SEARCH_MIN = 0.2;
const GUTTER_SEARCH_MAX = 0.8;

function fontSizeOf(item: RawPage["items"][number]): number {
	if (item.height > 0) return item.height;

	const [, b, , d] = item.transform;
	const derived = Math.hypot(b, d);
	return derived > 0 ? derived : 0;
}

const ARABIC_LETTER = /\p{Script=Arabic}/u;

export function isPdfSpanScriptBoundary(previous: TextSpan, current: TextSpan): boolean {
	return (
		previous.dir !== current.dir &&
		((/\p{Script=Latin}$/u.test(previous.text) &&
			/^\p{Script=Arabic}/u.test(current.text) &&
			current.text.length > 1) ||
			(/\p{Script=Arabic}$/u.test(previous.text) &&
				/^\p{Script=Latin}/u.test(current.text) &&
				previous.text.length > 1))
	);
}

export function isReversedPdfRtlWordPair(previous: TextSpan, current: TextSpan): boolean {
	return (
		previous.dir === "rtl" &&
		current.dir === "rtl" &&
		current.streamIndex < previous.streamIndex &&
		previous.text.length >= 2 &&
		current.text.length >= 2
	);
}

type GlyphPosition = { left: number; right: number; baseline: number };

function pdfTextPosition() {
	let state = { matrix: IDENTITY, size: 0, spacing: 0, wordSpacing: 0, scale: 1, rise: 0 };
	const saved: (typeof state)[] = [];
	let textMatrix = IDENTITY;
	let lineX = 0;
	let y = 0;
	let x = 0;
	let positioned = false;
	let hasAdvance = true;
	return {
		update(operator: number | undefined, args: unknown) {
			if (operator === PDF_OPS.save) saved.push({ ...state });
			if (operator === PDF_OPS.restore) state = saved.pop() ?? state;
			if (operator === PDF_OPS.beginText) {
				textMatrix = IDENTITY;
				x = lineX = y = 0;
				positioned = false;
				hasAdvance = true;
			}
			const values = Array.isArray(args) ? args : [];
			const [first, second] = values;
			if (operator === PDF_OPS.transform) {
				const matrix = toMatrix(values);
				if (matrix) state.matrix = multiply(state.matrix, matrix);
			}
			if (operator === PDF_OPS.setTextMatrix) {
				const matrix = toMatrix(first) ?? toMatrix(values);
				if (!matrix) return;
				textMatrix = matrix;
				x = lineX = y = 0;
				positioned = hasAdvance = true;
			}
			if (
				(operator === PDF_OPS.moveText || operator === PDF_OPS.setLeadingMoveText) &&
				typeof first === "number" &&
				typeof second === "number"
			) {
				x = lineX += first;
				y += second;
				positioned = hasAdvance = true;
			}
			if (operator === PDF_OPS.setFont && typeof second === "number") state.size = second;
			if (typeof first !== "number") return;
			if (operator === PDF_OPS.setCharSpacing) state.spacing = first;
			if (operator === PDF_OPS.setWordSpacing) state.wordSpacing = first;
			if (operator === PDF_OPS.setHScale) state.scale = first / 100;
			if (operator === PDF_OPS.setTextRise) state.rise = first;
		},
		show(glyphs: readonly unknown[]): GlyphPosition | undefined {
			const start = x;
			const reliableStart = hasAdvance;
			for (const glyph of glyphs) {
				if (typeof glyph === "number") x -= (glyph * state.size * state.scale) / 1000;
				else if (glyph && typeof glyph === "object" && "width" in glyph && typeof glyph.width === "number")
					x +=
						((glyph.width * state.size) / 1000 +
							state.spacing +
							("isSpace" in glyph && glyph.isSpace === true ? state.wordSpacing : 0)) *
						state.scale;
				else hasAdvance = false;
			}
			const [a, b, c, d, e, f] = multiply(state.matrix, textMatrix);
			if (!positioned || !reliableStart || Math.abs(b) > 0.001 || a <= 0) return;
			return {
				left: a * start + c * (y + state.rise) + e,
				right: a * x + c * (y + state.rise) + e,
				baseline: d * (y + state.rise) + f,
			};
		},
	};
}

/** Match damaged runs to their embedded glyphs before transferring missing letters. */
export function restoreFormatMarkGlyphs(items: RawPage["items"], operators: OperatorListLike): RawPage["items"] {
	type GlyphRun = { damaged: string; original: string; missing: string; missingAt?: number; position?: GlyphPosition };
	const emptyRun = (): GlyphRun => ({ damaged: "", original: "", missing: "" });
	const repairs = new Map<string, Map<number, { value: string; position: GlyphPosition | undefined }>>();
	const position = pdfTextPosition();
	const logical = (text: string) =>
		normalizeArabicPresentationForms(bidi.getReorderedString(text, bidi.getEmbeddingLevels(text, "rtl"))).trim();
	let font = "";
	let block = emptyRun();
	const record = ({ damaged, original, missing, missingAt, position }: GlyphRun) => {
		if (missingAt === undefined) return;
		const before = logical(damaged);
		const after = logical(original);
		if (!before || [...after].length - [...before].length !== [...missing].length) return;
		let cursor = 0;
		for (const character of after) if (character === before[cursor]) cursor += character.length;
		if (cursor !== before.length) return;
		const key = `${font}\0${before}`;
		const occurrences = repairs.get(key) ?? new Map();
		if (!occurrences.has(missingAt)) occurrences.set(missingAt, { value: after, position });
		repairs.set(key, occurrences);
	};
	for (let index = 0; index < operators.fnArray.length; index++) {
		const operator = operators.fnArray[index];
		const args = operators.argsArray[index];
		if (
			operator === PDF_OPS.beginText ||
			operator === PDF_OPS.endText ||
			operator === PDF_OPS.beginMarkedContentProps ||
			operator === PDF_OPS.endMarkedContent ||
			operator === PDF_OPS.setFont ||
			operator === PDF_OPS.setTextMatrix
		) {
			record(block);
			block = emptyRun();
		}
		position.update(operator, args);
		if (operator === PDF_OPS.setFont && Array.isArray(args) && typeof args[0] === "string") font = args[0];
		if (operator !== PDF_OPS.showText || !Array.isArray(args) || !Array.isArray(args[0])) continue;
		const run = emptyRun();
		const bounds = position.show(args[0]);
		if (bounds) {
			run.position = bounds;
			const previous = block.position;
			if (!previous) block.position = bounds;
			else if (Math.abs(previous.baseline - bounds.baseline) <= 1)
				block.position = {
					...previous,
					left: Math.min(previous.left, bounds.left),
					right: Math.max(previous.right, bounds.right),
				};
		}
		for (const glyph of args[0]) {
			if (!glyph || typeof glyph !== "object" || typeof glyph.unicode !== "string") continue;
			const value = glyph.unicode.replace(/\p{Cf}/gu, "");
			run.original += value;
			if (value !== glyph.unicode && ARABIC_LETTER.test(value)) {
				run.missing += value;
				run.missingAt = index;
			} else run.damaged += value;
		}
		record(run);
		block.damaged += run.damaged;
		block.original += run.original;
		block.missing += run.missing;
		if (run.missingAt !== undefined) block.missingAt ??= run.missingAt;
	}
	record(block);
	const matchingItems = new Map<string, { item: RawPage["items"][number]; index: number }[]>();
	for (const [index, item] of items.entries()) {
		if (item.dir !== "rtl") continue;
		const key = `${item.fontRef}\0${normalizeArabicPresentationForms(item.str).trim()}`;
		if (!repairs.has(key)) continue;
		const indices = matchingItems.get(key) ?? [];
		indices.push({ item, index });
		matchingItems.set(key, indices);
	}
	const output = [...items];
	for (const [key, matches] of matchingItems) {
		const occurrences = [...(repairs.get(key)?.values() ?? [])];
		const byItem = new Map<number, string[]>();
		let unmatched = 0;
		const propose = (index: number, value: string) => {
			const options = byItem.get(index) ?? [];
			options.push(value);
			byItem.set(index, options);
		};
		for (const { value, position } of occurrences) {
			const candidates = position
				? matches.filter(({ item }) => {
						const {
							transform: [, , , , x, y],
							width,
						} = item;
						return (
							Math.abs(y - position.baseline) <= 1.5 && x + width > position.left + 0.5 && x < position.right - 0.5
						);
					})
				: [];
			const [candidate] = candidates;
			if (candidate && candidates.length === 1) propose(candidate.index, value);
			else unmatched++;
		}
		const values = new Set(occurrences.map(({ value }) => value));
		const [onlyValue] = values;
		if (unmatched && onlyValue && values.size === 1 && occurrences.length === matches.length)
			for (const { index } of matches) byItem.set(index, [onlyValue]);
		for (const { item, index } of matches) {
			const choices = byItem.get(index);
			const [value] = choices ?? [];
			if (choices?.length === 1 && value)
				output[index] = { ...item, glyphText: item.str.replace(/\S(?:[\s\S]*\S)?/u, () => value) };
			else if (choices || unmatched) output[index] = { ...item, glyphRecoveryUncertain: true };
		}
	}
	return output;
}

function isMultiWordArabicPhrase(text: string): boolean {
	const arabicTokens = text.match(/\p{Script=Arabic}+/gu) ?? [];
	if (arabicTokens.length >= 5) return true;
	return arabicTokens.filter((token) => token.length >= 3).length >= 3;
}

/**
 * Chromium/Skia Arabic PDFs often emit one `dir: "rtl"` text item per word in visual-LTR order
 * (left word first, right word second on the same baseline) and insert spurious internal spaces
 * inside single words at glyph-kerning boundaries (e.g. "برمج يات", "الملخ ص").
 * Single-glyph RTL PDFs (length 1) and full-line/multi-word RTL PDFs (which contain multi-word
 * phrases and may still emit reversed city/company header pairs) are excluded.
 */
function isWordTokenizedRtlPage(page: RawPage): boolean {
	let prevY = Number.NaN;
	let prevX = Number.NaN;
	let reversedWordPairs = 0;
	for (const item of page.items) {
		const trimmed = item.str.trim();
		if (trimmed.length === 0) continue;
		if (item.dir === "rtl" && ARABIC_LETTER.test(trimmed)) {
			if (isMultiWordArabicPhrase(trimmed)) return false;
			if (trimmed.length >= 2) {
				const [, , , , x, y] = item.transform;
				if (!Number.isNaN(prevY) && Math.abs(y - prevY) <= 3 && x > prevX) {
					reversedWordPairs += 1;
				}
				prevY = y;
				prevX = x;
			} else {
				prevY = Number.NaN;
				prevX = Number.NaN;
			}
		} else {
			prevY = Number.NaN;
			prevX = Number.NaN;
		}
	}
	return reversedWordPairs >= 2;
}

function cleanWordTokenizedRtlText(text: string): string {
	return text
		.replace(/(?<=\p{Script=Arabic}) +(?=\p{Script=Arabic})/gu, "")
		.replace(/(?<=\p{Script=Arabic}) +(?=[،؛؟.,:!?])/gu, "")
		.trim();
}

function buildSpans(page: RawPage): TextSpan[] {
	const spans: TextSpan[] = [];
	const wordTokenizedRtl = isWordTokenizedRtlPage(page);
	let pendingSpaceBefore = false;

	page.items.forEach((item, streamIndex) => {
		if (item.str.trim().length === 0) {
			if (item.str.length > 0 && !item.hasEol) {
				const prev = spans.at(-1);
				if (prev) prev.spaceAfter = true;
				pendingSpaceBefore = true;
			} else {
				pendingSpaceBefore = false;
			}
			return;
		}

		const fontSize = fontSizeOf(item);
		const [, , , , e, f] = item.transform;

		// PDF user space puts the origin bottom-left and `f` on the baseline; every consumer above
		// this file works in top-left points, so the flip happens once, here.
		const y = page.height - f - fontSize;
		const sourceText = item.glyphText ?? item.str;
		let text = wordTokenizedRtl && item.dir === "rtl" ? cleanWordTokenizedRtlText(sourceText) : sourceText;
		if (item.dir === "rtl" && ARABIC_LETTER.test(text))
			text = text.replace(/(?<!\S)([%٪])(\p{Nd}+(?:[.,٫]\p{Nd}+)?)/gu, "$2$1");

		spans.push({
			...(item.dir ? { dir: item.dir } : {}),
			...(pendingSpaceBefore ? { spaceBefore: true } : {}),
			text,
			x: e,
			y,
			width: item.width,
			height: fontSize,
			fontRef: item.fontRef,
			fontSize,
			streamIndex,
		});
		pendingSpaceBefore = false;
	});

	return spans;
}

function modalOf(values: readonly number[]): number | null {
	if (values.length === 0) return null;

	const counts = new Map<number, number>();
	for (const value of values) {
		// Bucket to a quarter point so 9.98 and 10.02 count as the same size.
		const key = Math.round(value * 4) / 4;
		counts.set(key, (counts.get(key) ?? 0) + 1);
	}

	let best: number | null = null;
	let bestCount = -1;

	for (const [value, count] of [...counts.entries()].sort((a, b) => a[0] - b[0])) {
		if (count > bestCount) {
			best = value;
			bestCount = count;
		}
	}

	return best;
}

/**
 * Groups spans into lines by baseline proximity.
 *
 * Deliberately order-independent: spans are sorted by geometry with a text tiebreak, never by
 * their position in the content stream, so the same file yields the same lines however the
 * stream happened to be written. Stream order is measured separately, as inversion.
 */
function clusterLines(
	spans: readonly TextSpan[],
	pageNumber: number,
	tolerance: number,
	semantic: boolean,
): TextLine[] {
	const baseline = (span: TextSpan) => (semantic ? span.y + span.height : span.y);
	const sorted = [...spans].sort(
		(a, b) => baseline(a) - baseline(b) || a.x - b.x || (a.text < b.text ? -1 : a.text > b.text ? 1 : 0),
	);

	const groups: TextSpan[][] = [];
	let current: TextSpan[] = [];
	let anchor = Number.NaN;

	for (const span of sorted) {
		if (current.length === 0 || Math.abs(baseline(span) - anchor) <= tolerance) {
			if (current.length === 0) anchor = baseline(span);
			current.push(span);
			continue;
		}

		groups.push(current);
		current = [span];
		anchor = baseline(span);
	}

	if (current.length > 0) groups.push(current);

	return groups.map((group) => toLine(group, pageNumber, semantic));
}

export function isRtlText(spans: readonly TextSpan[]): boolean {
	// Numeric/contact islands do not establish a paragraph base. When Arabic/Hebrew letters are at
	// least as numerous as Latin letters (e.g. an Arabic line mentioning "BandAI" or "React"), treat
	// the line as RTL; otherwise preserve LTR order.
	const lexical = spans.map((span) => span.text.replace(/\S+@\S+|(?:https?:\/\/|www\.)\S+/gu, "")).join(" ");
	const rtlCount = (lexical.match(/[\p{Script=Arabic}\p{Script=Hebrew}]/gu) ?? []).length;
	if (rtlCount === 0) return false;
	const latinCount = (lexical.match(/\p{Script=Latin}/gu) ?? []).length;
	return latinCount === 0 || rtlCount >= latinCount;
}

/** Logical runs inferred from reader direction and geometry; LTR islands stay intact. */
export function orderTextSpans(spans: readonly TextSpan[], direction?: "ltr" | "rtl"): TextSpan[] {
	const ordered = [...spans].sort((a, b) => a.x - b.x);
	const groups: TextSpan[][] = [];
	for (const span of ordered) {
		const previous = groups.at(-1);
		if (previous && span.dir === previous[0]?.dir) previous.push(span);
		else groups.push([span]);
	}
	const rtl = direction === "rtl" || (!direction && isRtlText(spans));
	if (rtl) groups.reverse();
	return groups.flatMap((group) =>
		group[0]?.dir === "rtl" || (rtl && group.every((span) => span.dir === undefined)) ? group.reverse() : group,
	);
}

export function toLine(group: readonly TextSpan[], pageNumber: number, semantic = false): TextLine {
	const ordered = [...group].sort(
		(a, b) => a.x - b.x || (semantic ? a.streamIndex - b.streamIndex : a.text < b.text ? -1 : a.text > b.text ? 1 : 0),
	);

	let text = "";
	let previous: TextSpan | null = null;

	for (const span of semantic ? [] : orderTextSpans(ordered)) {
		if (previous) {
			const gap = Math.max(span.x - (previous.x + previous.width), previous.x - (span.x + span.width));
			const threshold = SPACE_GAP_RATIO * Math.max(previous.fontSize, span.fontSize, 1);
			const reversedRtlWordPair =
				previous.dir === "rtl" &&
				span.dir === "rtl" &&
				span.streamIndex < previous.streamIndex &&
				previous.text.length >= 2 &&
				span.text.length >= 2;
			const needsSpace =
				(gap > threshold || reversedRtlWordPair) &&
				!/\s$/.test(text) &&
				!/^\s/.test(span.text) &&
				!/^[،؛؟.,:!?]/.test(span.text);
			if (needsSpace) text += " ";
		}

		text += span.text;
		previous = span;
	}

	const x = Math.min(...ordered.map((span) => span.x));
	const right = Math.max(...ordered.map((span) => span.x + span.width));
	const y = Math.min(...ordered.map((span) => span.y));
	const bottom = Math.max(...ordered.map((span) => span.y + span.height));

	const meanStreamIndex = ordered.reduce((total, span) => total + span.streamIndex, 0) / ordered.length;

	return {
		page: pageNumber,
		text,
		spans: ordered,
		x,
		y,
		width: right - x,
		height: bottom - y,
		fontSize: modalOf(ordered.map((span) => span.fontSize)) ?? 0,
		fontRef: dominantFontRef(ordered),
		meanStreamIndex,
	};
}

/** The font that sets the most characters on a line, so a stray glyph cannot claim the line. */
function dominantFontRef(spans: readonly TextSpan[]): string | null {
	const weights = new Map<string, number>();

	for (const span of spans) {
		if (!span.fontRef) continue;
		weights.set(span.fontRef, (weights.get(span.fontRef) ?? 0) + span.text.length);
	}

	let best: string | null = null;
	let bestWeight = 0;

	for (const [ref, weight] of [...weights.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
		if (weight > bestWeight) {
			best = ref;
			bestWeight = weight;
		}
	}

	return best;
}

/**
 * Share of adjacent line pairs whose stream order runs backwards against reading order.
 *
 * Single-column text threads at roughly zero. A two-column page whose columns are stored one
 * after the other alternates on every pair and lands near 0.5, which is precisely the file
 * whose extracted text comes out interleaved.
 */
function inversionRatioOf(lines: readonly TextLine[]): number {
	if (lines.length < 2) return 0;

	let inversions = 0;
	for (let index = 1; index < lines.length; index += 1) {
		const previous = lines[index - 1];
		const line = lines[index];
		if (!previous || !line) continue;
		if (line.meanStreamIndex < previous.meanStreamIndex) inversions += 1;
	}

	return inversions / (lines.length - 1);
}

/**
 * Looks for a full-height empty vertical band near the middle of the page.
 *
 * Built from spans rather than lines on purpose: baseline clustering merges spans that sit at
 * the same height in *different* columns into one line, whose box would span the gutter and
 * hide the very thing being looked for.
 */
function findGutter(spans: readonly TextSpan[], page: RawPage): ColumnGutter | null {
	if (spans.length < 12 || page.width <= 0 || page.height <= 0) return null;

	const binCount = Math.max(1, Math.ceil(page.width / HISTOGRAM_BIN_PT));
	const rowsByBin = Array.from({ length: binCount }, () => new Set<number>());
	const textRows = new Set<number>();

	for (const span of spans) {
		const from = Math.max(0, Math.floor(span.x / HISTOGRAM_BIN_PT));
		const to = Math.min(binCount - 1, Math.floor((span.x + span.width) / HISTOGRAM_BIN_PT));
		const firstRow = Math.max(0, Math.floor(span.y / ROW_BIN_PT));
		const lastRow = Math.floor((span.y + span.height) / ROW_BIN_PT);
		for (let row = firstRow; row <= lastRow; row += 1) {
			textRows.add(row);
			for (let bin = from; bin <= to; bin += 1) rowsByBin[bin]?.add(row);
		}
	}
	// A full-width contact row or heading can cross a genuine two-column body.
	const strictOccupied = rowsByBin.map((rows) => rows.size > 0);

	const textLeft = Math.min(...spans.map((span) => span.x));
	const textRight = Math.max(...spans.map((span) => span.x + span.width));
	const textWidth = textRight - textLeft;
	if (textWidth <= 0) return null;

	const searchFrom = Math.floor((textLeft + textWidth * GUTTER_SEARCH_MIN) / HISTOGRAM_BIN_PT);
	const searchTo = Math.ceil((textLeft + textWidth * GUTTER_SEARCH_MAX) / HISTOGRAM_BIN_PT);

	const emptyBand = (occupied: readonly boolean[]) => {
		let best: { start: number; end: number } | null = null;
		let runStart: number | null = null;
		for (let bin = Math.max(0, searchFrom); bin <= Math.min(binCount - 1, searchTo) + 1; bin += 1) {
			if (bin <= searchTo && !occupied[bin]) {
				runStart ??= bin;
				continue;
			}
			if (runStart !== null) {
				if (!best || bin - runStart > best.end - best.start) best = { start: runStart, end: bin };
				runStart = null;
			}
		}
		return best;
	};
	let best = emptyBand(strictOccupied);
	if (!best || (best.end - best.start) * HISTOGRAM_BIN_PT < MIN_GUTTER_WIDTH_PT) {
		best = emptyBand(rowsByBin.map((rows) => rows.size / Math.max(1, textRows.size) > 0.15));
	}

	if (!best) return null;

	const x = best.start * HISTOGRAM_BIN_PT;
	const width = (best.end - best.start) * HISTOGRAM_BIN_PT;
	if (width < MIN_GUTTER_WIDTH_PT) return null;

	const bandLeft = x;
	const bandRight = x + width;

	const rowCount = Math.max(1, Math.ceil(page.height / ROW_BIN_PT));
	const rowHasText = new Array<boolean>(rowCount).fill(false);
	const rowCrossesBand = new Array<boolean>(rowCount).fill(false);

	let leftSpans = 0;
	let rightSpans = 0;

	for (const span of spans) {
		const from = Math.max(0, Math.floor(span.y / ROW_BIN_PT));
		const to = Math.min(rowCount - 1, Math.floor((span.y + span.height) / ROW_BIN_PT));
		const crosses = span.x < bandRight && span.x + span.width > bandLeft;

		for (let row = from; row <= to; row += 1) {
			rowHasText[row] = true;
			if (crosses) rowCrossesBand[row] = true;
		}

		if (span.x + span.width <= bandLeft) leftSpans += 1;
		else if (span.x >= bandRight) rightSpans += 1;
	}

	const textRowCount = rowHasText.filter(Boolean).length;
	if (textRowCount === 0) return null;

	const crossedRows = rowCrossesBand.filter(Boolean).length;
	const coverage = 1 - crossedRows / textRowCount;

	const sided = leftSpans + rightSpans;
	const splitRatio = sided === 0 ? 0 : Math.min(leftSpans, rightSpans) / sided;

	return { x, width, coverage, splitRatio };
}

/** Distinguish independent columns from right-aligned dates within one section. */
export function hasIndependentColumns(page: PageGeometry): boolean {
	const gutter = page.gutter;
	if (!gutter) return false;
	const spans = page.lines.flatMap((line) => line.spans);
	const left = spans.filter((span) => span.x + span.width <= gutter.x);
	const right = spans.filter((span) => span.x >= gutter.x + gutter.width);
	const minority = left.length <= right.length ? left : right;
	if (minority.some((span) => PDF_SECTION_HEADING_LOOKUP.has(normalizeSectionHeading(span.text)))) return true;
	return (
		minority.length > 0 &&
		minority.filter((span) => /\p{L}/u.test(span.text) && !/\b(?:19|20)\d{2}\b/u.test(span.text)).length /
			minority.length >=
			0.6
	);
}

/**
 * Splits a clustered line at column-sized gaps between its spans.
 *
 * Baseline clustering joins every span that shares a baseline however far apart the spans sit,
 * which is what a heading set in its own narrow column looks like beside the section's first
 * content line ("Profiles GitHub"). The pieces are still analysed as one line everywhere else;
 * this view exists for consumers that need the column-separated parts.
 */
export function columnSegments(line: TextLine): TextLine[] {
	const [first, ...rest] = line.spans;
	if (!first || rest.length === 0) return [line];

	const groups: TextSpan[][] = [[first]];
	let previous = first;
	for (const span of rest) {
		const gap = span.x - (previous.x + previous.width);
		const threshold = Math.max(MIN_COLUMN_GAP_PT, COLUMN_GAP_RATIO * Math.max(previous.fontSize, span.fontSize, 1));

		if (gap > threshold) groups.push([span]);
		else groups[groups.length - 1]?.push(span);
		previous = span;
	}

	if (groups.length === 1) return [line];

	return groups.map((group) => toLine(group, line.page));
}

/**
 * Robust order statistic. Margins are measured at the 5th and 95th percentile rather than at the
 * extremes because a single right-aligned run whose reported width overshoots by a few points
 * would otherwise report a two-point margin on a page that plainly has sixteen.
 */
function percentile(values: readonly number[], fraction: number): number {
	if (values.length === 0) return 0;

	const sorted = [...values].sort((a, b) => a - b);
	const index = Math.min(sorted.length - 1, Math.max(0, Math.round((sorted.length - 1) * fraction)));
	return sorted[index] ?? 0;
}

export function buildPage(page: RawPage, tolerance: number, semantic = false): PageGeometry {
	const spans = buildSpans(page);
	const lines = clusterLines(spans, page.pageNumber, tolerance, semantic);

	const margins =
		spans.length === 0
			? { top: 0, right: 0, bottom: 0, left: 0 }
			: {
					top: percentile(
						spans.map((span) => span.y),
						MARGIN_PERCENTILE,
					),
					left: percentile(
						spans.map((span) => span.x),
						MARGIN_PERCENTILE,
					),
					right:
						page.width -
						percentile(
							spans.map((span) => span.x + span.width),
							1 - MARGIN_PERCENTILE,
						),
					bottom:
						page.height -
						percentile(
							spans.map((span) => span.y + span.height),
							1 - MARGIN_PERCENTILE,
						),
				};

	const pageArea = page.width * page.height;
	const lineArea = lines.reduce((total, line) => total + Math.max(0, line.width) * Math.max(0, line.height), 0);

	return {
		pageNumber: page.pageNumber,
		width: page.width,
		height: page.height,
		lines,
		inversionRatio: inversionRatioOf(lines),
		gutter: findGutter(spans, page),
		margins,
		textAreaRatio: pageArea > 0 ? Math.min(1, lineArea / pageArea) : 0,
	};
}

/**
 * Derives page geometry from a raw extraction. Pure: an identical raw extraction always produces the
 * same document. Inversion diagnostics retain the reader's original item-stream order.
 */
export function buildExtractedDocument(raw: RawExtraction): ExtractedDocument {
	const allFontSizes = raw.pages.flatMap((page) => page.items.filter((item) => item.str.trim()).map(fontSizeOf));
	const modalFontSize = modalOf(allFontSizes.filter((size) => size > 0));
	const tolerance = Math.max(MIN_LINE_TOLERANCE_PT, LINE_TOLERANCE_RATIO * (modalFontSize ?? MIN_LINE_TOLERANCE_PT));

	const language = raw.metadata.language?.split(/[-_]/)[0]?.toLowerCase();
	const direction =
		language === "ar" || language === "he" || language === "fa" || language === "ur"
			? "rtl"
			: language === "en"
				? "ltr"
				: undefined;
	const pages = raw.pages.map((page) => {
		const geometry = buildPage(page, tolerance, page.structure !== undefined);
		return page.structure === undefined ? geometry : layoutPdfPage(page, geometry, direction, raw.metadata.producer);
	});
	const lines = pages.flatMap((page) => page.lines);

	const fullText = pages.map((page) => page.lines.map((line) => line.text).join("\n")).join("\n\n");
	const words = fullText.split(/\s+/).filter(Boolean);

	const fontRefs = new Set<string>();
	const fontWeights = new Map<string, number>();

	for (const page of raw.pages) {
		for (const item of page.items) {
			if (!item.fontRef) continue;
			fontRefs.add(item.fontRef);
			fontWeights.set(item.fontRef, (fontWeights.get(item.fontRef) ?? 0) + item.str.trim().length);
		}
	}

	const modalFontRef =
		[...fontWeights.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0]?.[0] ?? null;

	return {
		...(direction ? { direction } : {}),
		pages,
		lines,
		fullText,
		charCount: fullText.length,
		wordCount: words.length,
		modalFontSize,
		modalFontRef,
		distinctFontRefs: fontRefs.size,
	};
}
