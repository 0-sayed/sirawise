import type { PdfParagraph } from "./pdf-paragraphs";
import type { ExtractedDocument, PdfLogicalLine, RawExtraction } from "@reactive-resume/resume/ats-pdf";
import {
	orderTextSpans,
	isRtlText,
	buildExtractedDocument,
	pdfTextCoverage,
	isPdfSpanScriptBoundary,
	isReversedPdfRtlWordPair,
} from "@reactive-resume/resume/ats-pdf";
import { assemblePdfParagraphs } from "./pdf-paragraphs";
import { isPdfEntryDate, isRecognizedLocation, knownHeading } from "./plain-text";

/**
 * Turns a PDF into the plain lines `parseResumeText` reads.
 *
 * The extraction itself is the ATS checker's — same worker configuration, same size and password
 * guards, same font-relative line clustering and column-gutter detection. Only the joining differs:
 * the ATS text is prose, while the importer splits header rows on runs of two or more spaces, so a
 * tabbed "Company    Role    Location" has to survive as three fields rather than one phrase.
 */

/** Horizontal gap, relative to font size, above which two spans are separate header fields. */
const FIELD_GAP_RATIO = 1.5;
/** Narrower gaps are still a word break; matches the ratio the ATS extractor joins prose with. */
const SPACE_GAP_RATIO = 0.25;

/** The evidence the ATS layout rules require before calling a page two-column. */
const GUTTER_COVERAGE = 0.85;
const GUTTER_SPLIT_RATIO = 0.25;

type PageGeometry = ExtractedDocument["pages"][number];
type TextSpan = PageGeometry["lines"][number]["spans"][number];

const ARABIC_LETTER = /\p{Script=Arabic}/u;

function joinSpans(spans: readonly TextSpan[], direction?: "ltr" | "rtl"): string {
	let text = "";
	let previous: TextSpan | null = null;

	for (const span of orderTextSpans(spans, direction)) {
		if (previous) {
			const gap = Math.max(span.x - (previous.x + previous.width), previous.x - (span.x + span.width));
			const fontSize = Math.max(previous.fontSize, span.fontSize, 1);
			const streamDistance = Math.abs(span.streamIndex - previous.streamIndex);
			const explicitSpace =
				streamDistance <= 2 &&
				((span.streamIndex > previous.streamIndex && (previous.spaceAfter || span.spaceBefore)) ||
					(span.streamIndex < previous.streamIndex && (span.spaceAfter || previous.spaceBefore)));
			const reversedRtlWordPair = isReversedPdfRtlWordPair(previous, span);
			const arabicMidWordRun =
				streamDistance === 1 &&
				!explicitSpace &&
				!reversedRtlWordPair &&
				ARABIC_LETTER.test(text.slice(-1)) &&
				ARABIC_LETTER.test(span.text[0] ?? "");
			if (gap > FIELD_GAP_RATIO * fontSize) text += "  ";
			else if (
				(explicitSpace ||
					isPdfSpanScriptBoundary(previous, span) ||
					reversedRtlWordPair ||
					(!arabicMidWordRun && gap > SPACE_GAP_RATIO * fontSize) ||
					gap > 0.45 * fontSize) &&
				!/\s$/.test(text) &&
				!/^\s/.test(span.text) &&
				!/^[،؛؟.,:!?]/.test(span.text)
			)
				text += " ";
		}

		text += span.text;
		previous = span;
	}

	return text.trim();
}

/** Mid-point of a convincing gutter, or null on a page that reads as one column. */
function columnSplitX(page: PageGeometry): number | null {
	const gutter = page.gutter;
	if (!gutter || gutter.coverage < GUTTER_COVERAGE || gutter.splitRatio < GUTTER_SPLIT_RATIO) return null;

	const splitX = gutter.x + gutter.width / 2;
	// A centered header above a right-aligned body leaves an empty vertical band too.
	// Only treat it as columns when text on both sides actually shares vertical space.
	let leftTop = Infinity;
	let rightTop = Infinity;
	let leftBottom = -Infinity;
	let rightBottom = -Infinity;
	for (const span of page.lines.flatMap((line) => line.spans)) {
		if (span.x + span.width / 2 < splitX) {
			leftTop = Math.min(leftTop, span.y);
			leftBottom = Math.max(leftBottom, span.y + span.height);
		} else {
			rightTop = Math.min(rightTop, span.y);
			rightBottom = Math.max(rightBottom, span.y + span.height);
		}
	}
	// Compare column regions: genuine columns may have staggered baselines with no touching glyph boxes.
	return Math.max(leftTop, rightTop) < Math.min(leftBottom, rightBottom) ? splitX : null;
}

/**
 * Lines grouped by baseline alone interleave a sidebar with the body, which drops a whole work
 * history into the skills section. On a two-column page each column is read out in full instead.
 */
function pageToLines(page: PageGeometry, direction?: "ltr" | "rtl"): string[] {
	if (page.lines.some((line) => line.logical)) return page.lines.map((line) => line.text);
	const splitX = columnSplitX(page);
	if (splitX === null) return page.lines.map((line) => joinSpans(line.spans, direction));

	const left: string[] = [];
	const right: string[] = [];

	for (const line of page.lines) {
		const leftSpans = line.spans.filter((span) => span.x + span.width / 2 < splitX);
		if (leftSpans.length > 0) left.push(joinSpans(leftSpans, direction));

		const rightSpans = line.spans.filter((span) => span.x + span.width / 2 >= splitX);
		if (rightSpans.length > 0) right.push(joinSpans(rightSpans, direction));
	}

	const rtl = direction ? direction === "rtl" : isRtlText(page.lines.flatMap((line) => line.spans));
	return rtl ? [...right, ...left] : [...left, ...right];
}

export function documentToLines(doc: ExtractedDocument): string[] {
	return doc.pages.flatMap((page) => pageToLines(page, doc.direction)).filter((line) => line.length > 0);
}

export { assemblePdfParagraphs } from "./pdf-paragraphs";

/** Shared API/browser import boundary. Interface locale must never enter this decision. */
export function pdfImportText(
	raw: RawExtraction,
	options: { allowPartial?: boolean } = {},
): {
	lines: string[];
	pages: { page: number; text: string }[];
	paragraphUnits: PdfParagraph[];
	partial: boolean;
	locale?: string;
} {
	const doc = buildExtractedDocument(raw);
	const { partial } = pdfTextCoverage(raw, doc);
	if (!options.allowPartial && partial) throw new Error("The PDF text could not be read completely.");
	const language = raw.metadata.language?.replaceAll("_", "-");
	let locale: string | undefined;
	if (language) {
		try {
			const source = new Intl.Locale(language);
			if (source.language === "ar" || source.language === "en")
				locale = source.region ? source.baseName : source.language === "ar" ? "ar-SA" : "en-US";
		} catch {
			/* Invalid language metadata supplies no parsing locale. */
		}
	}
	let section: ReturnType<typeof knownHeading> = null;
	const logical: PdfLogicalLine[] = doc.lines.flatMap(({ logical, spans }) => {
		if (!logical) return [];
		if (logical.role === "heading") section = knownHeading(logical.text);
		if (section !== "experience" || spans.length !== 2) return [logical];
		const [left, right] = spans;
		if (!left || !right || !left.fontRef || left.fontRef === right.fontRef) return [logical];
		if (logical.producer === "Forme" && doc.direction === "rtl") {
			const date = spans.find((span) => isPdfEntryDate(span.text.trim()));
			const title = spans.find((span) => span !== date);
			// Forme can store a right-aligned title as one visual LTR run alongside a date.
			const visualTitle =
				title?.dir === "ltr" &&
				/^([\p{Script=Latin}\p{N}][^\p{Script=Arabic}]*?)\s+([\p{Script=Arabic}\p{M} ]+)$/u.exec(title.text.trim());
			if (date && visualTitle)
				return [{ ...logical, text: `${visualTitle[2]} ${visualTitle[1]}  ${date.text.trim()}` }];
		}
		// An employer and location can use different fonts with only a word gap between them.
		const texts = [left.text.trim(), right.text.trim()];
		if (logical.direction === "rtl") texts.reverse();
		const [employer, location] = texts;
		if (
			!employer ||
			!location ||
			logical.text !== `${employer} ${location}` ||
			!location.split(/[,،·]/u).every((part) => isRecognizedLocation(part.trim()))
		)
			return [logical];
		return [{ ...logical, text: `${employer}  ${location}` }];
	});
	const pageLines = doc.pages.map((page) => ({
		page: page.pageNumber,
		lines: pageToLines(page, doc.direction).filter((line) => line.length > 0),
	}));
	return {
		lines: pageLines.flatMap((page) => page.lines),
		pages: pageLines.map((page) => ({ page: page.page, text: page.lines.join("\n") })),
		paragraphUnits: assemblePdfParagraphs(logical),
		partial,
		...(locale ? { locale } : {}),
	};
}
