import type { TranslationSegment } from "@reactive-resume/resume/translation";
import type { ResumeData } from "@reactive-resume/schema/resume/data";
import { translationCandidateSchema, type TranslationCandidate } from "@reactive-resume/schema/resume/variant-outputs";
import { normalizeFact, normalizeTranslationFactDates, normalizeNumberWords } from "./hard-facts";
import { redactModelText, resumeContactValues } from "./payload";
import { translationPlaceholderOccurrences } from "./translation-placeholders";

type ProtectedFact = {
	sourceId: string;
	target: TranslationSegment["target"];
	start: number;
	end: number;
	token: string;
	kind: "contact" | "name" | "official";
	value: string;
};
export type TranslationFactAssertion = {
	sourceId: string;
	kind: "number" | "date" | "calendar" | "negation";
	normalizedValue: string;
};
type MaskedSegment = { id: string; section: string; text: string };
type Continuation = { previous?: string; next?: string };
export type CompactProseSizing = true | "measured" | "ar-en-dense";
export type ProtectedTranslation = {
	maskedSegments: readonly MaskedSegment[];
	localMap: ReadonlyMap<string, ProtectedFact>;
	assertions: readonly TranslationFactAssertion[];
	continuations?: ReadonlyMap<string, Continuation>;
	compactProseSizing?: CompactProseSizing;
	binding?: Pick<TranslationCandidate, "direction" | "sourceRevision">;
};

const escaped = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
const stripPlaceholders = (text: string) =>
	text.replace(/\[(?:redacted|LOCAL[\s_-]*[\d٠-٩۰-۹]+|NAME[\s_-]*[\d٠-٩۰-۹]+)\]/giu, " ");
const normalizeProtectedText = (text: string) => text.normalize("NFKC").replace(/\p{Cf}/gu, "");

function normalizedRanges(text: string) {
	return Array.from(new Intl.Segmenter().segment(text)).flatMap(({ segment, index }) =>
		Array.from({ length: normalizeProtectedText(segment).length }, () => ({
			start: index,
			end: index + segment.length,
		})),
	);
}

const currencyCodes = Intl.supportedValuesOf("currency");
const namedCurrencies = "[Ss][Aa][Rr]|[Uu][Ss][Dd]|[Ee][Uu][Rr]|ر[يی]ال(?: سعودي)?|دولار(?: امريكي)?|يورو";
const currencyWord = `${currencyCodes.join("|")}|${namedCurrencies}`;
// Before a number, ALL can be an emphatic English determiner. The suffix 5 ALL remains a currency amount.
const currencyPrefix = `${currencyCodes.filter((code) => code !== "ALL").join("|")}|${namedCurrencies}`;
const currency = `(?:\\p{Sc}|(?:${currencyWord})(?![\\p{L}\\p{M}]))`;
const unit = `(?:${currency}|%|(?:[Kk][Gg]|[Kk][Mm]|[Mm][Ss]|كغ|كم|مللي ثانية)(?![\\p{L}\\p{M}]))`;
const measure = new RegExp(
	`(?:(?<leadingSign>[+-])?\\s*(?<prefix>\\p{Sc}|(?<![\\p{L}\\p{M}])(?:${currencyPrefix})(?![\\p{L}\\p{M}]))\\s*)?(?:(?<amountSign>[+-])\\s*)?(?<amount>\\d+(?:[.,:/-]\\d+)*)(?:\\s*(?<suffix>${unit})(?!\\s*[+-]?\\d))?`,
	"gu",
);
const normalizeUnit = (unit: string) =>
	unit
		.toLowerCase()
		.replace(/^ر[يی]ال(?: سعودي)?$/u, "sar")
		.replace(/^(?:\$|دولار(?: امريكي)?)$/u, "usd")
		.replace(/^(?:€|يورو)$/u, "eur")
		.replace(/^£$/u, "gbp")
		.replace(/^كغ$/u, "kg")
		.replace(/^كم$/u, "km")
		.replace(/^مللي ثانية$/u, "ms");

function factAssertions(sourceId: string, text: string): TranslationFactAssertion[] {
	const normalized = normalizeFact(stripPlaceholders(text), { preserveCase: true })
		.replace(/[−﹣]/gu, "-")
		.replaceAll("٫", ".")
		.replaceAll("٬", ",")
		.replaceAll("٪", "%")
		.replace(/(?<!\p{L})و(?=(?:احد|احدى|اثنا|اثني|اثنتا|اثنتي) عشر)/gu, "")
		.replace(/(?<!\p{L})(?:احد عشر|احدى عشرة)(?!\p{L})/gu, "11")
		.replace(/(?<!\p{L})(?:اثنا عشر|اثني عشر|اثنتا عشرة|اثنتي عشرة)(?!\p{L})/gu, "12")
		.replace(/(?<!\p{L})(?:يومان|يومين|اسبوعان|اسبوعين|شهران|شهرين|سنتان|سنتين)(?!\p{L})/gu, "2");
	const ranges =
		/(?<![\d./-])(\d{4}(?:-(?:0[1-9]|1[0-2]))?)\s*(?:[–—-]|to|الى|حتى)\s*(\d{4}(?:-(?:0[1-9]|1[0-2]))?)(?!\d|[./-]\d)/giu;
	const canonicalDates = normalizeTranslationFactDates(normalized);
	const dates: string[] = [];
	const withoutRanges = canonicalDates.replace(ranges, (match, start: string, end: string) => {
		if (start.length !== end.length) return match;
		dates.push(`${start}-${end}`);
		return " ";
	});
	const digits = normalizeNumberWords(withoutRanges).replace(
		/\s+(?:percent|per cent|بالمئة|بالمائة|في المئة|في المائة)(?!\p{L})/giu,
		"%",
	);
	const assertions: TranslationFactAssertion[] = dates.map((normalizedValue) => ({
		sourceId,
		kind: "date",
		normalizedValue,
	}));
	for (const match of digits.matchAll(measure)) {
		const { leadingSign = "", prefix = "", amountSign = "", amount = "", suffix = "" } = match.groups ?? {};
		const units = new Set([normalizeUnit(prefix), normalizeUnit(suffix)]);
		const normalizedValue =
			leadingSign + amountSign + amount.replace(/(?<=\d),(?=\d{3}(?!\d))/gu, "") + [...units].sort().join("");
		assertions.push({
			sourceId,
			kind: /^(?:\d{4}[-/]\d{1,2}(?:[-/]\d{1,2})?)$/u.test(normalizedValue) ? "date" : "number",
			normalizedValue,
		});
	}
	for (const [pattern, calendar] of [
		[/(?<!\p{L})(?:gregorian|ميلادي(?:ة)?|ce|ad)(?!\p{L})/giu, "gregorian"],
		[/(?<!\p{L})(?:hijri|هجري(?:ة)?|ah)(?!\p{L})/giu, "hijri"],
	] as const) {
		if (dates.length || assertions.some(({ kind }) => kind === "date" || kind === "number"))
			for (const _match of normalized.matchAll(pattern))
				assertions.push({ sourceId, kind: "calendar", normalizedValue: calendar });
	}
	const explicitReports = normalized.match(
		/^(?:(?:i )?had (no )?direct reports|(لم )?(?:يكن|كان) لدي مرؤوسون مباشرون)[.!؟]?$/iu,
	);
	if (explicitReports)
		assertions.push({
			sourceId,
			kind: "negation",
			normalizedValue: explicitReports[1] || explicitReports[2] ? "direct-reports:absent" : "direct-reports:present",
		});
	return assertions;
}

function protectedRanges(
	segment: TranslationSegment,
	data: ResumeData,
	officialNames: readonly string[],
): Omit<ProtectedFact, "token">[] {
	const text = segment.text;
	if (translationPlaceholderOccurrences(text).length) throw new Error("AI_SOURCE_BINDING");
	const contacts = [
		...resumeContactValues(data),
		...data.customSections.flatMap((section) =>
			section.type === "references" ? section.items.flatMap(({ name, phone }) => [name, phone]) : [],
		),
	];
	const ranges: Omit<ProtectedFact, "token">[] = [];
	const add = (start: number, value: string, kind: ProtectedFact["kind"]) => {
		const end = start + value.length;
		if (ranges.some((entry) => start < entry.end && entry.start < end)) return;
		ranges.push({ sourceId: segment.id, target: segment.target, start, end, kind, value });
	};
	const kindOf = (value: string) =>
		value.replace(/\s/gu, "").toLowerCase() ===
		normalizeProtectedText(data.basics.name).replace(/\s/gu, "").toLowerCase()
			? "name"
			: "contact";
	const normalized = normalizeProtectedText(text);
	let position = 0;
	let offsets: ReturnType<typeof normalizedRanges> | undefined;
	for (const value of redactModelText(text, contacts, { plainText: true }).redactedValues) {
		const index = normalized.indexOf(value, position);
		if (index < 0) throw new Error("AI_SOURCE_BINDING");
		position = index + value.length;
		if (normalized === text) add(index, value, kindOf(value));
		else {
			offsets ??= normalizedRanges(text);
			const start = offsets[index]?.start;
			const end = offsets[position - 1]?.end;
			if (start === undefined || end === undefined || normalizeProtectedText(text.slice(start, end)) !== value)
				throw new Error("AI_SOURCE_BINDING");
			add(start, text.slice(start, end), kindOf(value));
		}
	}
	if (segment.official && !ranges.length) add(0, text, "official");
	else {
		for (const official of officialNames) {
			const pattern = new RegExp(`(?<![\\p{L}\\p{M}\\p{N}_])${escaped(official)}(?![\\p{L}\\p{M}\\p{N}_])`, "gu");
			for (const match of text.matchAll(pattern)) add(match.index, match[0], "official");
		}
	}
	return ranges.sort((a, b) => a.start - b.start);
}

export function prepareTranslationFacts(
	data: ResumeData,
	segments: readonly TranslationSegment[],
): ProtectedTranslation {
	const localMap = new Map<string, ProtectedFact>();
	const officialNames = [...new Set(segments.filter(({ official }) => official).map(({ text }) => text))]
		.filter(Boolean)
		.sort((a, b) => b.length - a.length);
	let nextLocalId = 1;
	const maskedSegments = segments.map((segment) => {
		const ranges = protectedRanges(segment, data, officialNames);
		let text = "";
		let from = 0;
		for (const range of ranges) {
			const token = range.kind === "name" && !localMap.has("[NAME_1]") ? "[NAME_1]" : `[LOCAL_${nextLocalId++}]`;
			localMap.set(token, { ...range, token });
			text += segment.text.slice(from, range.start) + token;
			from = range.end;
		}
		const masked = normalizeProtectedText(text + segment.text.slice(from));
		if (redactModelText(masked, resumeContactValues(data), { plainText: true }).redactedValues.length)
			throw new Error("AI_SOURCE_BINDING");
		return { id: segment.id, section: segment.target.sectionId, text: masked };
	});
	const continuations = new Map<string, Continuation>();
	for (const [index, segment] of segments.entries()) {
		const next = segments[index + 1];
		const left = maskedSegments[index];
		const right = maskedSegments[index + 1];
		if (!next || !left || !right || !("blockIndex" in segment.target) || !("blockIndex" in next.target)) continue;
		const { blockIndex, ...parent } = segment.target;
		const { blockIndex: nextBlockIndex, ...nextParent } = next.target;
		const connects =
			/(?:[,،]|\b(?:and|or|also|with|the|to|through|using))$/iu.test(left.text) ||
			(/\s\S+$/u.test(left.text) && !/[.!?؟…:;؛]$/u.test(left.text) && /^\p{Ll}/u.test(right.text));
		if (
			blockIndex === undefined ||
			nextBlockIndex !== blockIndex + 1 ||
			JSON.stringify(parent) !== JSON.stringify(nextParent) ||
			!/^<p[\s>]/iu.test(segment.source) ||
			!/^<p[\s>]/iu.test(next.source) ||
			left.text.length > 240 ||
			right.text.length > 240 ||
			!connects
		)
			continue;
		continuations.set(left.id, { ...continuations.get(left.id), next: right.text });
		continuations.set(right.id, { previous: left.text });
	}
	return {
		maskedSegments,
		localMap,
		assertions: maskedSegments.flatMap(({ id, text }) => factAssertions(id, text)),
		...(continuations.size ? { continuations } : {}),
	};
}

export function bindTranslationPart(
	prepared: ProtectedTranslation,
	maskedSegments: readonly MaskedSegment[],
): ProtectedTranslation {
	const localMap = new Map<string, ProtectedFact>();
	for (const { id, text } of maskedSegments) {
		for (const { token } of translationPlaceholderOccurrences(text)) {
			const fact = prepared.localMap.get(token);
			if (!fact || localMap.has(token)) throw new Error("AI_SOURCE_BINDING");
			localMap.set(token, { ...fact, sourceId: id });
		}
	}
	return {
		...prepared,
		maskedSegments,
		localMap,
		assertions: maskedSegments.flatMap(({ id, text }) => factAssertions(id, text)),
	};
}

const same = (left: string[], right: string[]) => JSON.stringify(left.sort()) === JSON.stringify(right.sort());

export function classifyTranslationFacts(prepared: ProtectedTranslation, raw: TranslationCandidate) {
	const candidate = translationCandidateSchema.parse(raw);
	const sources = new Set(prepared.maskedSegments.map(({ id }) => id));
	if (
		sources.size !== prepared.maskedSegments.length ||
		sources.size !== candidate.segments.length ||
		new Set(candidate.segments.map(({ sourceId }) => sourceId)).size !== sources.size ||
		candidate.segments.some(({ sourceId }) => !sources.has(sourceId)) ||
		(prepared.binding &&
			(candidate.direction !== prepared.binding.direction ||
				candidate.sourceRevision !== prepared.binding.sourceRevision))
	)
		throw new Error("AI_SOURCE_BINDING");

	const keptIds: string[] = [];
	const withheldIds: string[] = [];
	const factKeys = (assertions: readonly TranslationFactAssertion[], includePolarity: boolean) =>
		assertions
			.filter(({ kind }) => kind !== "negation" || includePolarity)
			.map(({ kind, normalizedValue }) => `${kind}:${normalizedValue}`);
	const sourceSegments = new Map(prepared.maskedSegments.map((segment) => [segment.id, segment.text]));
	for (const { sourceId, text } of candidate.segments) {
		const received = translationPlaceholderOccurrences(text).map(({ token }) => token);
		const expected = translationPlaceholderOccurrences(sourceSegments.get(sourceId) ?? "").map(({ token }) => token);
		const actual = factAssertions(sourceId, text);
		const expectedAssertions = prepared.assertions.filter((entry) => entry.sourceId === sourceId);
		const boundedPolarity =
			actual.some(({ kind }) => kind === "negation") && expectedAssertions.some(({ kind }) => kind === "negation");
		const actualFacts = factKeys(actual, boundedPolarity);
		const expectedFacts = factKeys(expectedAssertions, boundedPolarity);
		const plain = stripPlaceholders(text).trim();
		const hasContact = plain && redactModelText(plain, [], { plainText: true }).redactedValues.length > 0;
		(same(received, expected) && same(actualFacts, expectedFacts) && !hasContact ? keptIds : withheldIds).push(
			sourceId,
		);
	}
	return { keptIds, withheldIds };
}

export function restoreTranslationFacts(
	prepared: ProtectedTranslation,
	candidate: TranslationCandidate,
): TranslationCandidate {
	return {
		...candidate,
		segments: candidate.segments.map(({ sourceId, text }) => {
			let restored = text;
			for (const { raw, token } of translationPlaceholderOccurrences(text)) {
				const fact = prepared.localMap.get(token);
				if (!fact || fact.sourceId !== sourceId) throw new Error("AI_SOURCE_BINDING");
				restored = restored.replace(raw, () => fact.value);
			}
			return { sourceId, text: restored };
		}),
	};
}
