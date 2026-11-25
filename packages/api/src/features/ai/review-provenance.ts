import type { ReviewSourceSnapshot } from "./review-sources";
import type { ReviewCandidate, ReviewResult } from "@reactive-resume/schema/resume/ai-review";
import { normalizeImportedText } from "@reactive-resume/import/normalize";
import {
	findPeriod,
	looksLikeEntryHeader,
	looksLikeRole,
	readEducationDates,
	readEducationEntries,
	readEducationHeader,
} from "@reactive-resume/import/plain-text";
import { readLegacyDates } from "@reactive-resume/schema/resume/dates";
import { ONGOING_TOKENS_BY_LANGUAGE, readSingleDate } from "@reactive-resume/schema/resume/period";
import { normalizeNumericDigits } from "@reactive-resume/utils/string";

export type ProvenanceMatch = { evidenceId: string; start: number; end: number };
export type ExtractionWithholding = {
	id: string;
	section: string;
	field: string;
	reason: "AI_UNSUPPORTED_CLAIM" | "AI_UNSUPPORTED_DATE" | "AI_AMBIGUOUS_DATE" | "AI_SOURCE_BINDING";
};

const arabic = /\p{Script=Arabic}/u;
const latin = /\p{Script=Latin}/u;
const letter = /\p{L}/u;
const whitespace = /\s/u;
const tokenPart = /[\p{L}\p{N}\p{M}_+#%٪−]/u;
const magnitude = /(?:(?:\p{Nd}{1,3}(?: \p{Nd}{3})+(?!\p{Nd})|\p{Nd}+)(?:[.,:/٫٬]\p{Nd}+)*|[.٫]\p{Nd}+)/u;
const percentSuffix = /(?: *[%٪]| +(?:percent|per cent|بالمئة|بالمائة|في المئة|في المائة)(?![\p{L}\p{M}\p{N}]))/u;
const numericToken = new RegExp(
	String.raw`(?:[%٪+−-] *)?${magnitude.source}(?:e[+−-]?\p{Nd}+)?${percentSuffix.source}?`,
	"giu",
);
const namedDatePrefix = /(?:^|[^\p{L}\p{M}])([\p{L}\p{M}]+\.? (?:\d{1,2},? )?)$/u;
const rangeConnector = /(?: *[-‐–—−~] *| +(?:to|through|until|إلى|الى) +)/iu;
const rangeGap = new RegExp(`^${rangeConnector.source}$`, "iu");
const ongoingEnds = [...(ONGOING_TOKENS_BY_LANGUAGE.en ?? []), ...(ONGOING_TOKENS_BY_LANGUAGE.ar ?? [])];
const ongoingRange = new RegExp(`^${rangeConnector.source}(?:${ongoingEnds.join("|")})(?![\\p{L}\\p{M}\\p{N}])`, "iu");
const fieldPrefix = /^[^\S\n]*([\p{L}\p{M} ]+)[^\S\n]*:/u;
const aliases: Record<string, string> = {
	employer: "company",
	"جهة العمل": "company",
	الشركة: "company",
	position: "position",
	role: "position",
	المسمى: "position",
	"المسمى الوظيفي": "position",
	school: "school",
	university: "school",
	الجامعة: "school",
	degree: "degree",
	الدرجة: "degree",
	dates: "dates",
	period: "dates",
	الفترة: "dates",
	location: "location",
	الموقع: "location",
	skill: "name",
	المهارة: "name",
	proficiency: "proficiency",
	language: "language",
	اللغة: "language",
	fluency: "fluency",
	certificate: "title",
	الشهادة: "title",
	issuer: "issuer",
	description: "description",
	grade: "grade",
	area: "area",
};

const entityAnchor: Record<ReviewCandidate["section"], string> = {
	experience: "company",
	education: "school",
	skills: "name",
	languages: "language",
	certifications: "title",
};

const experienceRecordFields = ["company", "position", "location", "dates"];
const educationRecordFields = ["school", "degree", "area"];
const recordFields: Partial<Record<ReviewCandidate["section"], Record<string, readonly string[]>>> = {
	experience: {
		profile: experienceRecordFields,
		assignment: experienceRecordFields,
		"assignment record": experienceRecordFields,
		"role register": experienceRecordFields,
		"الملف المهني": experienceRecordFields,
		"سجل الخدمة": experienceRecordFields,
		"بطاقة العمل": experienceRecordFields,
		"المسمى والجهة": ["position", "company"],
		"الدور والجهة": experienceRecordFields,
		"الجهة والمكان": ["company", "location"],
	},
	education: {
		qualification: educationRecordFields,
		التعليم: educationRecordFields,
		التأهيل: educationRecordFields,
		الشهادة: educationRecordFields,
	},
};

function readField(line: string, section: ReviewCandidate["section"]) {
	const prefix = fieldPrefix.exec(line);
	const label = prefix?.[1]?.trim().toLowerCase();
	if (prefix && label) {
		const record = recordFields[section];
		const fields = record && Object.hasOwn(record, label) ? record[label] : undefined;
		return {
			fields: fields ?? [Object.hasOwn(aliases, label) ? (aliases[label] ?? label) : label],
			valueOffset: prefix[0].length,
			record: Boolean(fields),
		};
	}
}

function fieldBoundaries(quote: string, section: ReviewCandidate["section"]) {
	const boundaries: Array<{
		fields: readonly string[] | undefined;
		start: number;
		valueStart: number;
		record: boolean;
	}> = [];
	let offset = 0;
	for (const line of quote.split("\n")) {
		if (!line.trim()) {
			const valueStart = offset + line.length + 1;
			if (valueStart <= quote.length) boundaries.push({ fields: undefined, start: offset, valueStart, record: true });
		} else {
			const starts = [
				0,
				...Array.from(line.matchAll(/[.!?؟][^\S\r\n]+(?=[\p{L}\p{M}])/gu), (match) => match.index + match[0].length),
			];
			for (const start of starts) {
				const label = readField(line.slice(start), section);
				if (!label) continue;
				boundaries.push({
					fields: label.fields,
					start: offset + start,
					valueStart: offset + start + label.valueOffset,
					record: label.record || label.fields[0] === entityAnchor[section],
				});
			}
		}
		offset += line.length + 1;
	}
	return boundaries;
}

function fieldSpans(quote: string, section: ReviewCandidate["section"]) {
	const spans: Array<{ fields: readonly string[] | undefined; start: number; end: number }> = [];
	let fields: readonly string[] | undefined;
	let start = 0;
	for (const boundary of fieldBoundaries(quote, section)) {
		spans.push({ fields, start, end: boundary.start });
		fields = boundary.fields;
		start = boundary.valueStart;
	}
	spans.push({ fields, start, end: quote.length });
	return spans;
}

function rawExperienceLines(quote: string) {
	let start = 0;
	return quote.split("\n").map((line) => {
		const text = normalizeImportedText(line.trim());
		const raw = !fieldPrefix.test(text) && !/^[-–—•*◦‣·]\s/u.test(text);
		const period = raw ? findPeriod(text, arabic.test(text) ? "ar-SA" : "en-US") : "";
		const dated = period !== "" && text.endsWith(period);
		const header = dated
			? text
					.slice(0, -period.length)
					.replace(/[|·,،]\s*$/u, "")
					.trim()
			: text;
		const row = { start, dated, header, heading: raw && looksLikeEntryHeader(header) };
		start += line.length + 1;
		return row;
	});
}

function recordStarts(quote: string, section: ReviewCandidate["section"]) {
	const boundaries = fieldBoundaries(quote, section);
	const starts = new Set(boundaries.filter(({ record }) => record).map(({ valueStart }) => valueStart));
	if (section === "education" && !boundaries.some(({ fields }) => fields)) {
		let offset = 0;
		const lines = quote.split("\n").map((text) => {
			const line = { text, start: offset };
			offset += text.length + 1;
			return line;
		});
		for (const { startLine } of readEducationEntries(
			lines.map(({ text }) => text),
			arabic.test(quote) ? "ar-SA" : "en-US",
		)) {
			const line = lines[startLine];
			if (line) starts.add(line.start);
		}
	}
	if (section !== "experience") return [...starts];
	const lines = rawExperienceLines(quote);
	for (const [index, line] of lines.entries()) {
		if (!line.dated || (line.header && !line.heading)) continue;
		const previous = lines[index - 1];
		// A PDF can place the dates beside the title, beside the company or on a separate line.
		const title = !line.header && previous?.heading && !previous.dated ? previous : line;
		if (!title.header && previous && !previous.heading) continue;
		const above = lines[title === line ? index - 1 : index - 2];
		const employer =
			above?.heading && !above.dated && !looksLikeRole(above.header) && looksLikeRole(title.header) ? above : title;
		starts.add(employer.start);
	}
	return [...starts];
}

function normalizedSpan(raw: string) {
	const characters = Array.from(raw);
	const offsets: Array<{ start: number; end: number }> = [];
	let text = "";
	let offset = 0;
	for (let i = 0; i < characters.length; i++) {
		const start = offset;
		const character = characters[i] ?? "";
		offset += character.length;
		let chunk = normalizeNumericDigits(character.normalize("NFC"));
		if (whitespace.test(character)) {
			let sameLine = character !== "\n" && character !== "\r";
			while (whitespace.test(characters[i + 1] ?? "")) {
				i++;
				const space = characters[i] ?? "";
				offset += space.length;
				sameLine &&= space !== "\n" && space !== "\r";
			}
			const left = text.at(-1) ?? "";
			const right = characters[i + 1] ?? "";
			if (!left || !right) continue;
			if (
				sameLine &&
				letter.test(left) &&
				letter.test(right) &&
				((arabic.test(left) && latin.test(right)) || (latin.test(left) && arabic.test(right)))
			)
				continue;
			chunk = " ";
		}
		text += chunk;
		for (let unit = 0; unit < chunk.length; unit++) offsets.push({ start, end: offset });
	}
	return { text, offsets };
}

function boundary(text: string, index: number) {
	return !(tokenPart.test(text[index - 1] ?? "") && tokenPart.test(text[index] ?? ""));
}

function numericInteriors(text: string) {
	const spans: Array<{ start: number; end: number }> = [];
	for (const match of text.matchAll(numericToken)) {
		const value = match[0];
		let start = match.index;
		const end = start + value.length;
		if (/^\d{4}$/u.test(value)) {
			const prefix = namedDatePrefix.exec(text.slice(0, start))?.[1];
			if (prefix && readSingleDate(prefix + value, arabic.test(prefix) ? "ar-SA" : "en-US")) {
				start -= prefix.length;
				// A named date can include a day already read as a separate number.
				while ((spans.at(-1)?.start ?? -1) >= start) spans.pop();
			}
		}
		const previous = spans.at(-1);
		const gap = previous ? text.slice(previous.end, start) : "";
		if (previous && (rangeGap.test(gap) || rangeGap.test(gap + value[0]))) previous.end = end;
		else spans.push({ start, end });
	}
	const interiors = new Set<number>();
	for (const { start, end } of spans) {
		const ongoing = ongoingRange.exec(text.slice(end))?.[0];
		for (let index = start + 1; index < end + (ongoing?.length ?? 0); index++) interiors.add(index);
	}
	return interiors;
}

function boundQuotes(candidate: ReviewCandidate, snapshot: ReviewSourceSnapshot) {
	return snapshot.evidence.filter(
		(evidence) =>
			candidate.evidenceIds.includes(evidence.id) &&
			snapshot.selections.some(
				(selection) =>
					"id" in selection &&
					selection.id === evidence.id &&
					selection.kind === "unconfirmed_source" &&
					selection.section === candidate.section &&
					selection.text === evidence.quote,
			),
	);
}

function provenanceMatches(candidate: ReviewCandidate, snapshot: ReviewSourceSnapshot): ProvenanceMatch[] {
	const literal =
		candidate.field === "dates" ? candidate.rawDateText : typeof candidate.value === "string" ? candidate.value : null;
	if (!literal || /<[^>]*>/u.test(literal)) return [];
	if (candidate.section === "education" && (candidate.field === "school" || candidate.field === "degree")) {
		const header = readEducationHeader(literal, arabic.test(literal) ? "ar-SA" : "en-US");
		if (header.period || (candidate.field === "school" && header.school && header.degree)) return [];
	}
	const expected = normalizedSpan(literal).text;
	if (!expected) return [];
	const matches: ProvenanceMatch[] = [];
	for (const evidence of boundQuotes(candidate, snapshot)) {
		for (const span of fieldSpans(evidence.quote, candidate.section)) {
			if (span.fields && !span.fields.includes(candidate.field)) continue;
			const { text, offsets } = normalizedSpan(evidence.quote.slice(span.start, span.end));
			const interior = numericInteriors(text);
			for (let index = text.indexOf(expected); index >= 0; index = text.indexOf(expected, index + 1)) {
				const endIndex = index + expected.length;
				if (!boundary(text, index) || !boundary(text, endIndex) || interior.has(index) || interior.has(endIndex))
					continue;
				const start = offsets[index]?.start;
				const end = offsets[endIndex - 1]?.end;
				if (start === undefined || end === undefined) continue;
				matches.push({ evidenceId: evidence.id, start: span.start + start, end: span.start + end });
			}
		}
	}
	return matches;
}

function preferExactPosition(candidate: ReviewCandidate, matches: ProvenanceMatch[], evidence: Map<string, string>) {
	if (candidate.section !== "experience" || candidate.field !== "position" || matches.length < 2) return matches;
	const exact = matches.filter((match) => {
		const quote = evidence.get(match.evidenceId) ?? "";
		const start = quote.lastIndexOf("\n", match.start - 1) + 1;
		const end = quote.indexOf("\n", match.end);
		const line = quote.slice(start, end < 0 ? undefined : end);
		const label = readField(line, candidate.section);
		if (label && label.fields.length !== 1) return false;
		const text = normalizeImportedText(line.slice(label?.valueOffset ?? 0).trim());
		const period = findPeriod(text, arabic.test(text) ? "ar-SA" : "en-US");
		const header = period ? text.replace(period, "") : text;
		const value = normalizedSpan(normalizeImportedText(quote.slice(match.start, match.end))).text;
		return header.split(/\s*[|·]\s*|\s{2,}/u).some((part) => normalizedSpan(part.trim()).text === value);
	});
	return exact.length > 0 ? exact : matches;
}

export function matchReviewProvenance(
	candidate: ReviewCandidate,
	snapshot: ReviewSourceSnapshot,
): ProvenanceMatch | null {
	const matches = preferExactPosition(
		candidate,
		provenanceMatches(candidate, snapshot),
		new Map(snapshot.evidence.map(({ id, quote }) => [id, quote])),
	);
	return matches.length === 1 ? (matches[0] ?? null) : null;
}

export function filterExtractionProvenance(
	snapshot: ReviewSourceSnapshot,
	result: Extract<ReviewResult, { kind: "extraction" }>,
): { keptIds: string[]; withheld: ExtractionWithholding[] } {
	const keptIds: string[] = [];
	const withheld: ExtractionWithholding[] = [];
	const evidence = new Map(snapshot.evidence.map(({ id, quote }) => [id, quote]));
	const possible = result.candidates.map((candidate) => ({
		candidate,
		matches: preferExactPosition(candidate, provenanceMatches(candidate, snapshot), evidence),
	}));
	const startsByEvidence = new Map<string, number[]>();
	const recordOf = (match: ProvenanceMatch, section: ReviewCandidate["section"]) => {
		const key = `${section}:${match.evidenceId}`;
		let starts = startsByEvidence.get(key);
		if (!starts) {
			starts = recordStarts(evidence.get(match.evidenceId) ?? "", section);
			startsByEvidence.set(key, starts);
		}
		return starts.filter((start) => start <= match.start).length;
	};
	const matched = possible.map(({ candidate, matches }) => {
		if (matches.length < 2) return { candidate, match: matches[0] };
		const peers = possible.flatMap(({ candidate: peer, matches: locations }) => {
			const match = locations[0];
			return match &&
				peer.section === candidate.section &&
				peer.entityId === candidate.entityId &&
				locations.length === 1 &&
				boundQuotes(peer, snapshot).length === peer.evidenceIds.length
				? [{ match, field: peer.field }]
				: [];
		});
		const scoped = matches.filter(
			(match) =>
				peers.length > 0 &&
				peers.every(
					({ match: anchor }) =>
						match.evidenceId === anchor.evidenceId &&
						recordOf(match, candidate.section) === recordOf(anchor, candidate.section),
				),
		);
		if (scoped.length === 1) return { candidate, match: scoped[0] };
		const anchors = peers.filter(({ field }) => field === entityAnchor[candidate.section]);
		const onAnchorLine = scoped.filter((match) => {
			const quote = evidence.get(match.evidenceId) ?? "";
			return (
				anchors.length > 0 &&
				anchors.every(({ match: anchor }) => {
					const start = Math.min(match.start, anchor.start);
					const end = Math.max(match.end, anchor.end);
					return !/[\r\n]/u.test(quote.slice(start, end));
				})
			);
		});
		return { candidate, match: onAnchorLine.length === 1 ? onAnchorLine[0] : undefined };
	});
	for (const { candidate, match } of matched) {
		const { id, section, field, value } = candidate;
		let reason: ExtractionWithholding["reason"] | undefined;
		if (boundQuotes(candidate, snapshot).length !== candidate.evidenceIds.length) reason = "AI_SOURCE_BINDING";
		else if (!match && value !== null) reason = field === "dates" ? "AI_UNSUPPORTED_DATE" : "AI_UNSUPPORTED_CLAIM";
		else if (!match && candidate.rawDateText) reason = "AI_UNSUPPORTED_DATE";
		else if (match) {
			const quote = evidence.get(match.evidenceId);
			if (quote === undefined) throw new Error("AI_SOURCE_BINDING");
			const span = quote.slice(match.start, match.end);
			const record = recordOf(match, section);
			if (
				matched.some(
					({ candidate: peer, match: other }) =>
						peer.id !== id &&
						peer.section === section &&
						peer.entityId === candidate.entityId &&
						other &&
						(other.evidenceId !== match.evidenceId || recordOf(other, section) !== record),
				)
			)
				reason = "AI_SOURCE_BINDING";
			if (!reason && field === "dates" && value !== null && typeof value === "object") {
				const suffix = quote.slice(match.end);
				if (/(?:هـ|هجري|hijri|summer|winter|تقريب)/iu.test(span) || /^\s*(?:هـ|هجري|hijri)/iu.test(suffix))
					reason = "AI_AMBIGUOUS_DATE";
				else {
					const text = normalizeNumericDigits(span).replace(/^(?:from|من)\s+/iu, "");
					const locale = arabic.test(span) ? "ar-SA" : "en-US";
					const parsed =
						section === "education"
							? readEducationDates(text, locale)
							: readLegacyDates(text, { locale, single: section === "certifications" });
					if (
						parsed.raw ||
						parsed.start !== value.start ||
						parsed.end !== value.end ||
						parsed.present !== value.present
					)
						reason = "AI_UNSUPPORTED_DATE";
				}
			}
		}
		if (reason) withheld.push({ id, section, field, reason });
		else keptIds.push(id);
	}
	return { keptIds, withheld };
}
