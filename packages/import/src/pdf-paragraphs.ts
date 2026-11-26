import type { PdfLogicalLine } from "@reactive-resume/resume/ats-pdf";
import { knownHeading, isPdfEntryDate, isEducationFieldLine } from "./plain-text";

export type PdfParagraph = {
	text: string;
	role: PdfLogicalLine["role"];
	sourceLineIds: string[];
	recovery: PdfLogicalLine["recovery"];
	entryStart?: true;
	fieldContinuation?: true;
};

const terminal = /[.!؟?…][”’"')\]]*$/u;
const fieldLabel = /^[\p{L}\p{M} ]{1,30}:/u;
const narrativeSections = new Set(["summary", "experience", "projects", "education", "volunteer", "publications"]);

function samePageColumn(previous: PdfLogicalLine, next: PdfLogicalLine): boolean {
	return previous.column === next.column && previous.id.split(":")[0] === next.id.split(":")[0];
}

function canWrap(previous: PdfLogicalLine, next: PdfLogicalLine, sameBlock: boolean): boolean {
	if (!samePageColumn(previous, next) || previous.direction !== next.direction) return false;
	const size = Math.max(previous.box.height, next.box.height);
	const distance = next.box.y - previous.box.y;
	if (distance <= 0 || distance > size * (previous.producer === "Forme" ? 2.2 : 1.6)) return false;
	if (!sameBlock && previous.fontRef !== next.fontRef) return false;
	const edge = (line: PdfLogicalLine) => line.box.x + (line.direction === "rtl" ? line.box.width : 0);
	// An untagged bullet's marker can hang outside the continuation's text edge.
	return Math.abs(edge(previous) - edge(next)) <= size * (previous.role === "list-item" ? 1.5 : 1);
}

function joinWrap(text: string, next: string, layoutOnly: boolean): string {
	if (text.endsWith("\u00ad")) return text.slice(0, -1) + next;
	const hyphenated = layoutOnly ? /\b[A-Za-z]{2,}-$/u : /\b[A-Z]{2,}-$/u;
	if (hyphenated.test(text) && /^\p{Ll}/u.test(next)) return text + next;
	return `${text} ${next}`;
}

function geometryWrap(previous: PdfLogicalLine, next: PdfLogicalLine, continuing: boolean): boolean {
	// Forme emits separate P tags for some visual wraps. Other producers' block boundaries
	// remain authoritative when present.
	if ((previous.blockId || next.blockId) && previous.producer !== "Forme") return false;
	if ((next.role !== "line" && next.role !== "paragraph") || previous.role === "table") return false;
	if (
		terminal.test(previous.text) ||
		/[|]|\s{2,}/u.test(previous.text + next.text) ||
		fieldLabel.test(previous.text) ||
		fieldLabel.test(next.text) ||
		isPdfEntryDate(previous.text) ||
		isPdfEntryDate(next.text)
	)
		return false;
	return continuing || previous.words.filter((word) => /^\p{L}/u.test(word)).length >= 4;
}

function projectStart(
	line: PdfLogicalLine,
	next: PdfLogicalLine | undefined,
	previous: PdfLogicalLine | undefined,
): boolean {
	if (!next || !samePageColumn(line, next) || (line.role !== "line" && line.role !== "paragraph")) return false;
	if (knownHeading(next.text) || terminal.test(line.text) || fieldLabel.test(line.text)) return false;
	if (line.words.length > 8 || /^\p{Ll}/u.test(line.text)) return false;
	if (
		previous &&
		samePageColumn(previous, line) &&
		previous.role !== "heading" &&
		line.box.y - previous.box.y <= line.box.height * 1.8
	)
		return false;
	return (
		(Boolean(line.fontRef) && line.fontRef !== next.fontRef && line.fontRef !== previous?.fontRef) ||
		/^(?:Links?|الروابط)\s*:/iu.test(next.text)
	);
}

function followsField(previous: PdfLogicalLine, line: PdfLogicalLine, heading: PdfLogicalLine): boolean {
	const size = Math.max(previous.box.height, line.box.height);
	const edge = (item: PdfLogicalLine) => item.box.x + (heading.direction === "rtl" ? item.box.width : 0);
	// A label can be inset by an icon or list marker, even when its value shares the alignment.
	if (previous.column !== line.column || Math.abs(edge(previous) - edge(line)) > size * 1.5) return false;
	if (!samePageColumn(previous, line)) return line.box.y <= size * 3;
	const distance = line.box.y - previous.box.y;
	return distance > 0 && distance <= size * 2.6;
}

function repeatsFieldPair(
	label: PdfLogicalLine,
	value: PdfLogicalLine,
	nextLabel: PdfLogicalLine | undefined,
	nextValue: PdfLogicalLine | undefined,
	heading: PdfLogicalLine,
): boolean {
	return Boolean(
		nextLabel &&
		nextValue &&
		nextLabel.fontRef === label.fontRef &&
		nextValue.fontRef === value.fontRef &&
		nextLabel.role !== "heading" &&
		nextValue.role !== "heading" &&
		!knownHeading(nextLabel.text) &&
		!knownHeading(nextValue.text) &&
		samePageColumn(value, nextLabel) &&
		nextLabel.box.y - value.box.y > value.box.y - label.box.y &&
		followsField(nextLabel, nextValue, heading),
	);
}

export function assemblePdfParagraphs(lines: readonly PdfLogicalLine[]): PdfParagraph[] {
	const paragraphs: PdfParagraph[] = [];
	let section: ReturnType<typeof knownHeading> = null;
	let sectionHeading: PdfLogicalLine | undefined;
	let fieldHeading: PdfLogicalLine | undefined;
	let fieldFonts: { label: string; value: string } | undefined;
	let previousLine: PdfLogicalLine | undefined;
	for (const [index, line] of lines.entries()) {
		const heading = knownHeading(line.text);
		if (heading || line.role === "heading" || (previousLine && previousLine.column !== line.column)) {
			section = heading;
			sectionHeading = heading ? line : undefined;
			fieldHeading = undefined;
			fieldFonts = undefined;
		}
		const role = heading ? "heading" : section === "summary" && line.role === "line" ? "paragraph" : line.role;
		const previous = paragraphs.at(-1);
		const sameBlock = Boolean(line.blockId && previousLine?.blockId === line.blockId);
		const entryStart = section === "projects" && projectStart(line, lines[index + 1], previousLine);
		const listField = section === "skills" || section === "languages";
		const labeledField = section === "skills" && /[:：]/u.test(line.text);
		const fieldContinuation = Boolean(
			listField &&
			role !== "heading" &&
			!labeledField &&
			fieldHeading?.fontRef &&
			line.fontRef &&
			fieldHeading.fontRef !== line.fontRef &&
			previousLine &&
			previous &&
			sectionHeading &&
			(fieldHeading.fontRef === sectionHeading.fontRef ||
				(section === "skills" && /[:：]/u.test(fieldHeading.text)) ||
				(fieldFonts?.label === fieldHeading.fontRef && fieldFonts?.value === line.fontRef) ||
				repeatsFieldPair(fieldHeading, line, lines[index + 1], lines[index + 2], sectionHeading)) &&
			(section === "skills" || !previous.fieldContinuation) &&
			(previousLine === fieldHeading || previousLine.fontRef === line.fontRef) &&
			followsField(previousLine, line, sectionHeading),
		);
		if (fieldContinuation && fieldHeading?.fontRef && line.fontRef)
			fieldFonts = { label: fieldHeading.fontRef, value: line.fontRef };
		if (listField && role !== "heading" && !fieldContinuation) fieldHeading = line;
		if (
			previousLine &&
			previous &&
			!entryStart &&
			!listField &&
			!previous.entryStart &&
			previous.role !== "heading" &&
			role !== "heading" &&
			(section !== "education" || (!isEducationFieldLine(previousLine.text) && !isEducationFieldLine(line.text))) &&
			canWrap(previousLine, line, sameBlock) &&
			((sameBlock && previous.role === "paragraph" && role === "paragraph") ||
				(section !== null &&
					narrativeSections.has(section) &&
					(section === "summary" && !line.blockId && previous.role === "paragraph" && role === "paragraph"
						? !terminal.test(previousLine.text)
						: geometryWrap(previousLine, line, previous.sourceLineIds.length > 1))))
		) {
			previous.text = joinWrap(previous.text, line.text, !sameBlock);
			if (previous.role !== "list-item") previous.role = "paragraph";
			if (line.recovery === "ambiguous") previous.recovery = "ambiguous";
			previous.sourceLineIds.push(line.id);
		} else {
			paragraphs.push({
				text: line.text,
				role,
				sourceLineIds: [line.id],
				recovery: line.recovery,
				...(entryStart ? { entryStart: true } : {}),
				...(fieldContinuation ? { fieldContinuation: true } : {}),
			});
		}
		previousLine = line;
	}
	return paragraphs;
}
