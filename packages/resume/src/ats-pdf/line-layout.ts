import type { PageGeometry, PdfLogicalLine, PdfTextRun, RawPage, TextLine, TextSpan } from "./types";
import { normalizeArabicPresentationForms } from "@reactive-resume/utils/string";
import { normalizeSectionHeading, PDF_SECTION_HEADING_LOOKUP } from "../ats/section-aliases";
import { bidi, resolvePdfLineOrder } from "./bidi";
import { buildPage, hasIndependentColumns, isPdfSpanScriptBoundary, isReversedPdfRtlWordPair, toLine } from "./extract";

type Direction = PdfLogicalLine["direction"];
type PreparedLine = { line: TextLine; runs: PdfTextRun[]; logical: PdfLogicalLine; isolatedFields: boolean };
type Block = { id: string; role: string };

const RTL = /[\p{Script=Arabic}\p{Script=Hebrew}]/u;
const LATIN = /\p{Script=Latin}/u;
const ARABIC_FORMS = /[\uFB50-\uFDFF\uFE70-\uFEFC]/u;
const DIGITS = /^\p{Nd}+$/u;
const ALPHABETIC_LATIN = /^\p{Script=Latin}+$/u;
const HIJRI_DATE = /^\d{4}\s+هـ(?:\s*-\s*\d{4}\s+هـ)?$/u;
const NUMERIC_RANGE = /^(?:\p{Nd}{1,2}\/)?\p{Nd}{4}\s*[-–—]\s*(?:\p{Nd}{1,2}\/)?\p{Nd}{4}$/u;

function explicitSpace(a: TextSpan, b: TextSpan): boolean {
	const [first, last] = a.streamIndex < b.streamIndex ? [a, b] : [b, a];
	return last.streamIndex - first.streamIndex === 2 && Boolean(first.spaceAfter && last.spaceBefore);
}

function spanGap(a: Pick<TextSpan, "x" | "width">, b: Pick<TextSpan, "x" | "width">): number {
	return Math.max(b.x - (a.x + a.width), a.x - (b.x + b.width));
}

function separator(previous: TextSpan, current: TextSpan, explicitOnly = false): string {
	if (
		/^[،؛؟.,:!?%٪+)]/u.test(current.text) ||
		/[-(]$/u.test(previous.text) ||
		previous.text === "+" ||
		/^-$/u.test(current.text)
	)
		return "";
	if (/\s$/u.test(previous.text) || /^\s/u.test(current.text)) return "";
	if (explicitOnly) return explicitSpace(previous, current) ? " " : "";
	if (previous.text === "|" || current.text === "|") return " ";
	if (NUMERIC_RANGE.test(current.text) && /\p{L}/u.test(previous.text)) return "  ";
	const size = Math.max(previous.fontSize, current.fontSize, 1);
	const gap = spanGap(previous, current);
	if (gap > 1.5 * size) return "  ";
	const arabicFragments = RTL.test(previous.text.slice(-1)) && RTL.test(current.text[0] ?? "");
	return explicitSpace(previous, current) ||
		isPdfSpanScriptBoundary(previous, current) ||
		isReversedPdfRtlWordPair(previous, current) ||
		gap > (arabicFragments ? 0.3 : 0.18) * size
		? " "
		: "";
}

function directionOf(spans: readonly TextSpan[], declared: Direction | undefined, forme: boolean): Direction {
	const rtl = spans.some((span) => RTL.test(span.text));
	const latin = spans.some((span) => LATIN.test(span.text));
	const first = spans[0]?.text ?? "";
	if (!rtl) return forme && declared === "rtl" && NUMERIC_RANGE.test(first) && latin ? "rtl" : "ltr";
	if (!latin) return "rtl";
	if (spans.some((span) => span.text.trim() === "|") && RTL.test(first)) return "ltr";
	const firstStrong = spans
		.filter((span) => LATIN.test(span.text) || RTL.test(span.text))
		.reduce((first, span) => (span.streamIndex < first.streamIndex ? span : first));
	return declared ?? (LATIN.test(firstStrong.text) ? "ltr" : "rtl");
}

// PDF.js can return a visual Forme line when Latin names outnumber Arabic words.
function recoverFormeRtlLine(span: TextSpan, declared: Direction | undefined): string | undefined {
	if (
		declared !== "rtl" ||
		span.dir !== "ltr" ||
		!/^[.!؟]\p{Script=Latin}.*\p{Script=Arabic}$/u.test(span.text.trim()) ||
		!/\p{Script=Latin}و\s+/u.test(span.text)
	)
		return;
	const reorder = (value: string) =>
		bidi
			.getReorderedString(value, bidi.getEmbeddingLevels(value, "rtl"))
			.replace(/\p{Script=Arabic}+(?: +\p{Script=Arabic}+)*/gu, (run) => [...run].reverse().join(""));
	const extracted = span.text.trim();
	const logical = reorder(extracted);
	if (RTL.test(logical[0] ?? "") && reorder(logical) === extracted) return logical;
}

function spanDirection(span: TextSpan): Direction | undefined {
	if (span.dir === "ltr" && HIJRI_DATE.test(span.text)) return "ltr";
	if (RTL.test(span.text)) return "rtl";
	if (LATIN.test(span.text) || /\p{N}/u.test(span.text)) return "ltr";
}

function logicalOrder(spans: readonly TextSpan[], direction: Direction): TextSpan[] {
	if (
		direction === "rtl" &&
		spans[0] &&
		NUMERIC_RANGE.test(spans[0].text) &&
		spans.slice(1).every((span) => !RTL.test(span.text))
	)
		return [...spans.slice(1), spans[0]];
	const groups: { spans: TextSpan[]; direction: Direction }[] = [];
	const directions = spans.map(spanDirection);
	for (const [index, span] of spans.entries()) {
		const previousDirection = directions[index - 1];
		const strongDirection =
			directions[index] ??
			(previousDirection && previousDirection === directions[index + 1] ? previousDirection : direction);
		const previous = groups.at(-1);
		if (previous?.direction === strongDirection) previous.spans.push(span);
		else groups.push({ spans: [span], direction: strongDirection });
	}
	if (direction === "rtl") groups.reverse();
	return groups.flatMap((group) => (group.direction === "rtl" ? group.spans.reverse() : group.spans));
}

function formeRtlFragments(spans: readonly TextSpan[], page: RawPage): TextSpan[] | undefined {
	if (spans.length < 4) return;
	const stream = [...spans].sort((a, b) => b.streamIndex - a.streamIndex);
	const [first, ...fragments] = stream;
	if (first?.dir !== "ltr") return;
	const mixed = /^(\p{Script=Arabic}+) ([\p{Script=Latin}][\p{Script=Latin}\p{Nd}-]*)$/u.exec(first.text);
	const block = page.items[first.streamIndex]?.markedContentId;
	if (!mixed || !block) return;
	if (fragments.some((span) => span.dir !== "rtl" || page.items[span.streamIndex]?.markedContentId !== block)) return;
	const overlappingLetters = fragments.filter((span, index) => {
		const previous = stream[index];
		return previous && /^\p{Script=Arabic}$/u.test(span.text) && spanGap(previous, span) < -span.width / 2;
	});
	if (overlappingLetters.length < 2) return;
	// The marked run stores these fragments in visual stream order. Overlapping glyph boxes
	// scramble their x order, and PDF.js attaches the first Arabic fragment to the Latin token.
	return [
		{ ...first, text: `${mixed[2]} ${mixed[1]}` },
		...fragments.map((span) => {
			const item = page.items[span.streamIndex];
			return { ...span, text: item?.glyphText ?? item?.str ?? span.text };
		}),
	];
}

function restoreNumericOrder(spans: TextSpan[], direction: Direction): boolean {
	if (direction !== "rtl") return false;
	let ambiguous = false;
	for (let index = 1; index < spans.length; index++) {
		const previous = spans[index - 1];
		const current = spans[index];
		if (!previous || !current) continue;
		if (spanGap(previous, current) > Math.max(previous.fontSize, current.fontSize) * 0.6) continue;
		const latinThenDigits = ALPHABETIC_LATIN.test(previous.text) && DIGITS.test(current.text);
		const digitsThenLatin = ALPHABETIC_LATIN.test(current.text) && /(?:^|\s)\p{Nd}+$/u.test(previous.text);
		const latinThenAttachedDigits =
			ALPHABETIC_LATIN.test(previous.text) && /^\p{Nd}+\s/u.test(current.text) && RTL.test(current.text);
		if (!latinThenDigits && !digitsThenLatin && !latinThenAttachedDigits) continue;
		// UAX #9 admits both Arabic + number + Latin and Arabic + Latin + number at these positions.
		// Keep the source order when it supplies the other reading, but do not call the result complete.
		if (latinThenDigits && current.streamIndex < previous.streamIndex) {
			spans[index - 1] = current;
			spans[index] = previous;
		}
		ambiguous = true;
	}
	return ambiguous;
}

function taggedContactFields(line: TextLine, page: RawPage, direction: Direction): TextSpan[][] {
	if (!line.spans.some((span) => span.text.includes("@"))) return [];
	const fields: { id: string; spans: TextSpan[] }[] = [];
	for (const span of line.spans) {
		const id = page.items[span.streamIndex]?.markedContentId;
		if (!id) return [];
		const previous = fields.at(-1);
		if (previous?.id === id) previous.spans.push(span);
		else fields.push({ id, spans: [span] });
	}
	if (fields.length < 2) return [];
	if (direction === "rtl") fields.reverse();
	return fields.map(({ spans }) => logicalOrder(spans, spans.some((span) => RTL.test(span.text)) ? "rtl" : "ltr"));
}

function prepareLine(
	line: TextLine,
	page: RawPage,
	blocks: ReadonlyMap<string, Block>,
	declared: Direction | undefined,
	producer: string | null,
	column?: number,
): PreparedLine {
	const forme = producer === "Forme";
	const chromiumGlyphs = line.spans.filter((span) => ARABIC_FORMS.test(span.text)).length >= 3;
	const onlySpan = line.spans.length === 1 ? line.spans[0] : undefined;
	const recovered = forme && onlySpan ? recoverFormeRtlLine(onlySpan, declared) : undefined;
	const direction = recovered ? "rtl" : directionOf(line.spans, declared, forme);
	const fields = taggedContactFields(line, page, direction);
	const fragments = forme && direction === "rtl" && !fields.length ? formeRtlFragments(line.spans, page) : undefined;
	const ordered = fragments ?? (fields.length ? fields.flat() : logicalOrder(line.spans, direction));
	const numericOrderAmbiguous = !fields.length && !fragments && restoreNumericOrder(ordered, direction);
	const fieldStarts = new Set(fields.map((field) => field[0]));
	const runs: PdfTextRun[] = [];
	const blocksOnLine = new Set<string>();
	let role: PdfLogicalLine["role"] = "line";

	for (const [index, span] of ordered.entries()) {
		const item = page.items[span.streamIndex];
		const block = item?.markedContentId ? blocks.get(item.markedContentId) : undefined;
		if (block) {
			blocksOnLine.add(block.id);
			if (block.role === "P") role = "paragraph";
			if (/^H[1-6]?$/u.test(block.role)) role = "heading";
			if (/^(?:LI|LBody|Lbl)$/u.test(block.role)) role = "list-item";
			if (/^(?:Table|TR|TH|TD)$/u.test(block.role)) role = "table";
		}
		let value = normalizeArabicPresentationForms(recovered ?? span.text);
		if ((direction === "rtl" || declared === "rtl") && /^[%٪]\p{Nd}+(?:[.,٫]\p{Nd}+)?$/u.test(value))
			value = value.slice(1) + value[0];
		// Neighboring shaped glyphs do not establish the character order inside this cluster.
		const clusterOrderUncertain =
			chromiumGlyphs &&
			/^[\p{Script=Arabic}]{2}$/u.test(value) &&
			!ARABIC_FORMS.test(span.text) &&
			span.width <= span.fontSize * 1.1;
		if (forme && direction === "rtl" && /^\+{2}\p{Script=Latin}$/u.test(value))
			value = value.slice(2) + value.slice(0, 2);
		if (direction === "ltr" && span.dir === "rtl" && /^[.!؟]/u.test(value) && index === ordered.length - 1)
			value = value.slice(1) + value[0];
		const previous = ordered[index - 1];
		const separatorText = previous
			? fieldStarts.has(span)
				? "  "
				: separator(previous, { ...span, text: value }, Boolean(fragments))
			: "";
		runs.push({
			id: `${page.pageNumber}:${item?.rawStart ?? span.streamIndex}`,
			text: separatorText + value,
			direction: spanDirection(span) ?? direction,
			box: { x: span.x, y: span.y, width: span.width, height: span.height },
			logicalOrderKnown:
				!fragments && !clusterOrderUncertain && !item?.geometryUncertain && !item?.glyphRecoveryUncertain,
			endOfLine: item?.hasEol ?? false,
		});
	}
	const text = runs
		.map((run) => run.text)
		.join("")
		.trim();
	if (PDF_SECTION_HEADING_LOOKUP.has(normalizeSectionHeading(text))) role = "heading";
	else if (/^(?:[•●▪◦]|[-*]\s)/u.test(text)) role = "list-item";
	const { x, y, width, height } = line;
	const id = `${page.pageNumber}:${Math.min(...line.spans.map((span) => span.streamIndex))}`;
	return {
		line,
		runs,
		isolatedFields: fields.length > 0,
		logical: {
			id,
			text,
			words: text.split(/\s+/u).filter(Boolean),
			box: { x, y, width, height },
			blockId: blocksOnLine.size === 1 ? (blocksOnLine.values().next().value ?? null) : null,
			role,
			direction,
			recovery: !numericOrderAmbiguous && runs.every((run) => run.logicalOrderKnown) ? "exact" : "ambiguous",
			...(ordered[0]?.fontRef ? { fontRef: ordered[0].fontRef } : {}),
			...(forme ? { producer } : {}),
			...(column !== undefined ? { column } : {}),
		},
	};
}

function splitSeparatedBlocks(
	entry: { line: TextLine; column?: number },
	page: RawPage,
	blocks: ReadonlyMap<string, Block>,
): { line: TextLine; column?: number }[] {
	const groups: TextSpan[][] = [];
	let previousBlock: Block | undefined;
	for (const span of entry.line.spans) {
		const contentId = page.items[span.streamIndex]?.markedContentId;
		const block = contentId ? blocks.get(contentId) : undefined;
		if (!block) return [entry];
		const group = groups.at(-1);
		const previous = group?.at(-1);
		if (
			group &&
			previous &&
			block !== previousBlock &&
			spanGap(previous, span) <= Math.max(previous.fontSize, span.fontSize) * 1.5
		)
			return [entry];
		if (group && block === previousBlock) group.push(span);
		else groups.push([span]);
		previousBlock = block;
	}
	return groups.map((group) => ({ ...entry, line: toLine(group, page.pageNumber, true) }));
}

function selectColumns(
	page: PageGeometry,
	direction: Direction | undefined,
): { line: TextLine; column?: number; ambiguous?: boolean }[] {
	const gutter = page.gutter;
	if (!gutter || gutter.coverage < 0.85 || !hasIndependentColumns(page)) return page.lines.map((line) => ({ line }));
	const split = gutter.x + gutter.width / 2;
	const columns = [[], []] as [TextLine[], TextLine[]];
	const fullWidth: TextLine[] = [];
	for (const line of page.lines) {
		if (line.spans.some((span) => span.x < gutter.x && span.x + span.width > gutter.x + gutter.width)) {
			fullWidth.push(line);
			continue;
		}
		const left = line.spans.filter((span) => span.x + span.width / 2 < split);
		const right = line.spans.filter((span) => span.x + span.width / 2 >= split);
		if (left.length) columns[0].push(toLine(left, page.pageNumber, true));
		if (right.length) columns[1].push(toLine(right, page.pageNumber, true));
	}

	const bottom = (lines: TextLine[]) => Math.max(...lines.map((line) => line.y + line.height));
	const top = (lines: TextLine[]) => Math.min(...lines.map((line) => line.y));
	const bodyStart = Math.max(...columns.map(top));
	if (bodyStart >= Math.min(...columns.map(bottom))) return page.lines.map((line) => ({ line }));
	if (
		gutter.splitRatio < 0.25 &&
		!columns.every((lines) =>
			lines.some(
				(line) =>
					line.y >= bodyStart &&
					line.spans.some((span) => PDF_SECTION_HEADING_LOOKUP.has(normalizeSectionHeading(span.text))),
			),
		)
	)
		return page.lines.map((line) => ({ line }));
	const headers = columns.flatMap((lines, column) =>
		lines
			.filter(
				(line) =>
					line.y < bodyStart &&
					line === lines[0] &&
					!line.spans.some((span) => PDF_SECTION_HEADING_LOOKUP.has(normalizeSectionHeading(span.text))),
			)
			.map((line) => ({ line, column })),
	);
	const headerLines = new Set(headers.map(({ line }) => line));
	const body = columns.map((lines, column) =>
		lines.filter((line) => !headerLines.has(line)).map((line) => ({ line, column })),
	);
	const bodyLines = body.flat().map(({ line }) => line);
	const firstBodyY = top(bodyLines);
	const lastBodyY = bottom(bodyLines);
	const fullWidthHeaders = fullWidth.filter((line) => line.y + line.height <= firstBodyY);
	const footers = fullWidth.filter((line) => line.y >= lastBodyY);
	const inBody = new Set(fullWidth.filter((line) => !fullWidthHeaders.includes(line) && !footers.includes(line)));
	if (inBody.size) return page.lines.map((line) => ({ line, ambiguous: inBody.has(line) }));

	return [
		...[...fullWidthHeaders, ...headerLines].sort((a, b) => a.y - b.y).map((line) => ({ line })),
		...(direction === "rtl" ? body.reverse() : body).flat(),
		...footers.map((line) => ({ line })),
	];
}

function keepTaggedContinuationsTogether(lines: PreparedLine[]): void {
	const previousByBlock = new Map<string, PreparedLine>();
	for (let index = 0; index < lines.length; index++) {
		const current = lines[index];
		const block = current?.logical.blockId;
		if (!current || !block) continue;
		const previous = previousByBlock.get(block);
		previousByBlock.set(block, current);
		if (!previous || previous.logical.column !== current.logical.column) continue;
		const previousIndex = lines.indexOf(previous);
		const { line } = current;
		const verticalGap = line.y - previous.line.y;
		if (
			previousIndex === index - 1 ||
			verticalGap <= 0 ||
			verticalGap > 1.8 * Math.max(line.height, previous.line.height)
		)
			continue;
		if (spanGap(line, previous.line) > 0) continue;
		const blockLeft = Math.min(line.x, previous.line.x);
		const blockRight = Math.max(line.x + line.width, previous.line.x + previous.line.width);
		if (
			lines.slice(previousIndex + 1, index).some(({ line }) => line.x < blockRight && line.x + line.width > blockLeft)
		)
			continue;
		lines.splice(index, 1);
		lines.splice(previousIndex + 1, 0, current);
	}
}

export function layoutPdfPage(
	page: RawPage,
	geometry: PageGeometry,
	declared?: Direction,
	producer: string | null = null,
): PageGeometry {
	const blocks = new Map(
		page.structure?.flatMap((block, index) =>
			block.contentIds.map((key) => [key, { id: `${page.pageNumber}:${index}`, role: block.role }] as const),
		),
	);
	const prepared = selectColumns(geometry, declared).flatMap(({ line, column, ambiguous }) => {
		const separated = splitSeparatedBlocks(column === undefined ? { line } : { line, column }, page, blocks);
		if (declared === "rtl") separated.reverse();
		return separated.map(({ line, column }) => {
			const entry = prepareLine(line, page, blocks, declared, producer, column);
			if (ambiguous) entry.logical.recovery = "ambiguous";
			return entry;
		});
	});
	keepTaggedContinuationsTogether(prepared);

	const paragraphs = new Map<string, { text: string; lines: { entry: PreparedLine; start: number; end: number }[] }>();
	for (const entry of prepared) {
		const key = entry.logical.blockId ?? `line:${entry.logical.id}`;
		const paragraph = paragraphs.get(key) ?? { text: "", lines: [] };
		const start = paragraph.text.length;
		paragraph.text += entry.runs.map((run) => run.text).join("");
		paragraph.lines.push({ entry, start, end: paragraph.text.length - 1 });
		paragraph.text += " ";
		paragraphs.set(key, paragraph);
	}
	for (const paragraph of paragraphs.values()) {
		for (const { entry, start, end } of paragraph.lines) {
			const result = resolvePdfLineOrder(entry.runs, {
				text: paragraph.text,
				start,
				end,
				baseDirection: entry.logical.direction,
			});
			const overlappingDirections = entry.runs.some((run, index) =>
				entry.runs
					.slice(0, index)
					.some(
						(previous) =>
							run.direction !== previous.direction &&
							spanGap(run.box, previous.box) < -Math.min(run.box.width, previous.box.width) * 0.25,
					),
			);
			if (overlappingDirections || (result.recovery === "ambiguous" && !entry.isolatedFields))
				entry.logical.recovery = "ambiguous";
		}
	}
	return {
		...geometry,
		lines: prepared.map(({ line, logical }) => ({ ...line, logical, text: logical.text })),
	};
}

export function assemblePdfLines(page: RawPage): PdfLogicalLine[] {
	const geometry = buildPage(page, 2, true);
	return layoutPdfPage(page, geometry).lines.flatMap((line) => (line.logical ? [line.logical] : []));
}
