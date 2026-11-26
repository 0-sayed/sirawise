import { strFromU8, strToU8, unzlibSync, zlibSync } from "fflate";

export const HIJRI_DASH_RUN = " هـ \u200f - \u200f ";

// The writer emits visual glyph order. PDF.js uses the glyphs directly and gets
// the date right. Poppler reorders this line again and moves inferred spaces
// across the years. Its ActualText path preserves literal spaces in the span.
const visualHijriRange = /ـه\s*(\d{4})[\s\u200f]+-[\s\u200f]+ـه\s*(\d{4})/gu;

function decodeUtf16(hex: string): string {
	return hex.replace(/.{4}/gu, (unit) => String.fromCharCode(Number.parseInt(unit, 16)));
}

function encodeUtf16(text: string): string {
	return text
		.split("")
		.map((character) => character.charCodeAt(0).toString(16).padStart(4, "0"))
		.join("")
		.toUpperCase();
}

function hijriActualText(visualText: string): string {
	// Keep each year and its following no-break space in Poppler's numeric
	// run. The hyphen and second year share a single left-to-right run.
	return visualText.replace(
		visualHijriRange,
		(_date, end: string, start: string) => `ـه- ${end}\u00a0 ـه${start}\u00a0`,
	);
}

function stringStream(object: Uint8Array): { header: string; text: string } | undefined {
	// Forme owns the bytes here. The stream dictionaries contain a direct length
	// and a single FlateDecode filter, with no binary data before the stream.
	const header = strFromU8(object.subarray(0, 128), true).match(
		/^\d+ 0 obj\n<< \/Length (\d+) \/Filter \/FlateDecode >>\nstream\n/u,
	);
	if (!header) return undefined;
	const start = header[0].length;
	return { header: header[0], text: strFromU8(unzlibSync(object.subarray(start, start + Number(header[1]))), true) };
}

function unicodeMap(cmap: string): ReadonlyMap<string, string> {
	return new Map(
		[...cmap.matchAll(/beginbfchar\n([\s\S]*?)endbfchar/gu)].flatMap((block) =>
			[...(block[1] ?? "").matchAll(/^<([\dA-F]{4})> <([\dA-F]+)>$/gmu)].map(([, cid, hex]) => [
				cid ?? "",
				decodeUtf16(hex ?? ""),
			]),
		),
	);
}

function rewriteTextRuns(stream: string, fonts: ReadonlyMap<string, ReadonlyMap<string, string>>): string {
	return stream.replace(
		/(\/F\d+ [\d.]+ Tf\n)([\s\S]*?)(?=\/F\d+ [\d.]+ Tf\n|\nET\b)/gu,
		(originalRun, fontOperator: string, originalContent: string) => {
			const characters = fonts.get(fontOperator.split(" ")[0] ?? "");
			if (!characters) return originalRun;
			// PDF.js skips format glyphs and drops a TJ adjustment attached to the last
			// glyph in a string. Naskh uses zero-width glyphs for positioned dots. Keep
			// the return from the dot's position as its own TJ operand.
			const content = originalContent.replace(/^\[(.*)\] TJ$/gmu, (show: string, operands: string) => {
				const corrected = operands.replace(
					/(<[\dA-F]*([\dA-F]{4})>)[ \t]+(-?[\d.]+)[ \t]*/gu,
					(operand: string, glyphs: string, cid: string, offset: string) =>
						/^\p{Cf}$/u.test(characters.get(cid) ?? "") ? `${glyphs}] TJ\n[${offset}] TJ\n[` : operand,
				);
				return corrected === operands ? show : `[${corrected}] TJ`.replace(/\n\[\] TJ$/u, "");
			});
			const run = fontOperator + content;
			const span = /\/Span << \/ActualText <FEFF([\dA-F]+)> >> BDC/u;
			const existingText = span.exec(content)?.[1];
			if (existingText) {
				const text = decodeUtf16(existingText);
				const date = hijriActualText(text);
				return date === text ? run : fontOperator + content.replace(existingText, encodeUtf16(date));
			}

			const shows = [...content.matchAll(/^.*(?:Tj|TJ)$/gmu)];
			const first = shows[0];
			const last = shows.at(-1);
			if (!first || !last) return run;
			const start = first.index;
			const end = last.index + last[0].length;
			const operators = content.slice(start, end);
			const text = [...operators.matchAll(/<([\dA-F]+)>/gu)]
				.map(([, glyphs]) => glyphs?.replace(/.{4}/gu, (cid) => characters.get(cid) ?? "\ufffd"))
				.join("")
				.replaceAll("\u200b", "");
			const date = hijriActualText(text);
			if (date === text) return run;
			return (
				fontOperator +
				content.slice(0, start) +
				`/Span << /ActualText <FEFF${encodeUtf16(date)}> >> BDC\n${operators}\nEMC` +
				content.slice(end)
			);
		},
	);
}

/** Preserve Arabic text and Hijri dates in the extraction layer of Forme PDFs. */
export function writeArabicTextLayer(pdf: Uint8Array): Uint8Array {
	// Forme 0.31 writes a classic cross-reference table with one contiguous
	// subsection. Use offsets so binary font and image streams stay untouched.
	const start = /startxref\n(\d+)\n%%EOF\n$/u.exec(strFromU8(pdf.subarray(-64), true));
	if (!start) return pdf;
	const xrefOffset = Number(start[1]);
	const xref = strFromU8(pdf.subarray(xrefOffset), true);
	const table = /^xref\n0 (\d+)\n0000000000 65535 f \n((?:\d{10} 00000 n \n)+)(trailer\n[\s\S]*?)startxref\n/u.exec(
		xref,
	);
	if (!table?.[2] || !table[3]) return pdf;
	const offsets = [...table[2].matchAll(/^(\d{10}) /gmu)].map((row) => Number(row[1]));
	if (offsets.length + 1 !== Number(table[1])) return pdf;
	const objects = offsets.map((offset, index) => pdf.subarray(offset, offsets[index + 1] ?? xrefOffset));
	const patches = new Map<number, Uint8Array[]>();
	const cmapCache = new Map<number, ReadonlyMap<string, string>>();
	for (const object of objects) {
		if (!/^\d+ 0 obj\n<< \/Type \/Page /u.test(strFromU8(object.subarray(0, 48), true))) continue;
		const page = strFromU8(object, true);
		const contentIndex = Number(/\/Contents (\d+) 0 R/u.exec(page)?.[1]) - 1;
		const content = objects[contentIndex];
		if (!content) continue;
		const fonts = new Map<string, ReadonlyMap<string, string>>();
		for (const [, name, id] of page.matchAll(/(\/F\d+) (\d+) 0 R/gu)) {
			const font = objects[Number(id) - 1];
			if (!font || !name) continue;
			const cmapId = Number(/\/ToUnicode (\d+) 0 R/u.exec(strFromU8(font, true))?.[1]);
			const cmap = objects[cmapId - 1];
			if (!cmap) continue;
			let characters = cmapCache.get(cmapId);
			if (!characters) {
				const stream = stringStream(cmap);
				if (!stream) continue;
				characters = unicodeMap(stream.text);
				cmapCache.set(cmapId, characters);
			}
			fonts.set(name, characters);
		}
		const stream = stringStream(content);
		if (!stream) continue;
		const rewritten = rewriteTextRuns(stream.text, fonts);
		if (rewritten === stream.text) continue;
		const bytes = zlibSync(strToU8(rewritten, true));
		patches.set(contentIndex, [
			strToU8(stream.header.replace(/\/Length \d+/u, `/Length ${bytes.length}`)),
			bytes,
			strToU8("\nendstream\nendobj\n\n"),
		]);
	}
	if (patches.size === 0) return pdf;

	const header = pdf.subarray(0, offsets[0]);
	let offset = header.length;
	const xrefRows = ["0000000000 65535 f \n"];
	const result = [header];
	for (const [index, object] of objects.entries()) {
		xrefRows.push(`${String(offset).padStart(10, "0")} 00000 n \n`);
		for (const bytes of patches.get(index) ?? [object]) {
			result.push(bytes);
			offset += bytes.length;
		}
	}
	const tail = strToU8(`xref\n0 ${xrefRows.length}\n${xrefRows.join("")}${table[3]}startxref\n${offset}\n%%EOF\n`);
	result.push(tail);
	const bytes = new Uint8Array(offset + tail.length);
	let cursor = 0;
	for (const chunk of result) {
		bytes.set(chunk, cursor);
		cursor += chunk.length;
	}
	return bytes;
}
