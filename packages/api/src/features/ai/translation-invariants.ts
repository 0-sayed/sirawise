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
	latinLabels?: ReadonlySet<string>;
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
	`(?:(?<leadingSign>[+-])?\\s*(?<prefix>%|\\p{Sc}|(?<![\\p{L}\\p{M}])(?:${currencyPrefix})(?![\\p{L}\\p{M}]))\\s*)?(?:(?<amountSign>[+-])\\s*)?(?<amount>\\d+(?:[.,:/-]\\d+)*)(?:\\s*(?<suffix>${unit})(?!\\s*[+-]?\\d))?`,
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

const hijriMonths = [
	["muharram", "محرم"],
	["safar", "صفر"],
	["rabi al-awwal", "ربيع الاول"],
	["rabi al-thani", "rabi al-akhir", "ربيع الثاني", "ربيع الاخر"],
	["jumada al-awwal", "jumada al-ula", "جمادى الاولى"],
	["jumada al-thani", "jumada al-akhir", "جمادى الثانية", "جمادى الاخرة"],
	["rajab", "رجب"],
	["shaban", "sha'ban", "شعبان"],
	["ramadan", "رمضان"],
	["shawwal", "شوال"],
	["dhu al-qidah", "dhu al-qadah", "ذو القعدة", "ذي القعدة"],
	["dhu al-hijjah", "ذو الحجة", "ذي الحجة"],
].flatMap((names, index) => names.map((name) => [name, String(index + 1).padStart(2, "0")] as const));
const hijriMonthNumber = new Map<string, string>(hijriMonths);
const namedHijriDate = new RegExp(
	String.raw`(?<![\p{L}\p{N}./-])(?:(0?[1-9]|[12]\d|30)\s+)?(${[...hijriMonthNumber.keys()].join("|")})\s+(\d{4})(?![\p{L}\p{N}]|[./-]\d)`,
	"giu",
);

function normalizeHijriDates(text: string, dates: string[] = []) {
	return text.replace(namedHijriDate, (match, day: string | undefined, month: string, year: string) => {
		const number = hijriMonthNumber.get(month.toLowerCase());
		if (!number) return match;
		const date = day ? `${year}-${number}-${day.padStart(2, "0")}` : `${year}-${number}`;
		dates.push(`hijri:${date}`);
		return date;
	});
}

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
		/(?<![\d./-])(\d{4}(?:-\d{2}){0,2})\s*(?:[–—-]|to|until|الى|حتى)\s*(\d{4}(?:-\d{2}){0,2}|present|now|الان|الحاضر|اليوم)(?![\p{L}\d]|[./-]\d)/giu;
	const dates: string[] = [];
	const canonicalDates = normalizeTranslationFactDates(normalizeHijriDates(normalized, dates));
	const withoutRanges = canonicalDates.replace(ranges, (_match, start: string, end: string) => {
		dates.push(start + "-" + (/^\d/u.test(end) ? end : "present"));
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
	const latinLabels = new Set<string>();
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
		const { sectionId, field } = segment.target;
		if (
			((sectionId === "skills" && field === "keywords") || (sectionId === "projects" && field === "name")) &&
			isLatinLabel(masked.trim())
		)
			latinLabels.add(masked.trim());
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
		latinLabels,
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

const same = (left: string[], right: string[]) =>
	JSON.stringify([...left].sort()) === JSON.stringify([...right].sort());

function changedValue(before: string[], after: string[]) {
	const remaining = [...after];
	return (
		before.find((value) => {
			const index = remaining.indexOf(value);
			if (index === -1) return true;
			remaining.splice(index, 1);
			return false;
		}) ?? remaining[0]
	);
}

const termAliases = [
	["Excel", "إكسل", "إكسيل", "اكسيل"],
	["SAP", "ساب"],
	["Word", "وورد"],
] as const;
// Acronyms in ordinary prose can be translated. Explicit aliases are matched separately.
const genericAcronym = /^(?:AI|APIs?|UI|UX|CVs?|FAQs?|QA|IT|HR|ML|LLMs?|NLP|KPIs?|POCs?|MVPs?)$/u;
const technicalTerm =
	/(?<![\p{L}\p{N}])(?:[A-Za-z]+[./+#][A-Za-z][A-Za-z0-9+#.]*|[A-Z][A-Za-z]*\+\+|[A-Z]#|SQL|Oracle|PowerBI|Tableau|Workday|Salesforce|Jira|Docker|Kubernetes|GitHub|GitLab|PostgreSQL)(?![\p{L}\p{N}])/gu;

function translationTerms(text: string, aliases: readonly { source: string; target: string }[]) {
	let prose = stripPlaceholders(text);
	const terms: string[] = [];
	for (const [name, ...forms] of [...aliases.map(({ source, target }) => [source, target] as const), ...termAliases]) {
		const alternatives = [name, ...forms].filter(Boolean).map(escaped).join("|");
		if (!alternatives) continue;
		const boundary = "[\\p{L}\\p{M}\\p{N}]";
		const pattern = new RegExp(`(?<!${boundary})[وف]?(?:${alternatives})(?!${boundary})`, "gu");
		prose = prose.replace(pattern, () => {
			terms.push(name);
			return " ";
		});
	}
	prose = prose.replace(/(?<![\p{L}\p{N}])[وف](?=[A-Za-z])/gu, "").replace(technicalTerm, (term) => {
		const name = term.replace(/\.+$/u, "");
		if (name.split("/").every((part) => genericAcronym.test(part))) return term;
		terms.push(name);
		return " ";
	});
	return { terms, prose };
}

const englishProseWords = new Set(
	(
		"a an and are as at be been being but by can did do does for from had has have he her his how i in is it its may " +
		"my no not of on or our she so than that the their them then there these they this to us was we were what when " +
		"where which who will with without would you your " +
		"added applied built checked completed contact created delivered designed developed drove enabled implemented improved " +
		"including increased led made maintained managed moved operated provided reduced reported reviewed saved " +
		"supported tested trained used using worked working wrote"
	).split(" "),
);
const ordinaryEnglishWords = new Set(
	(
		"about actions advanced analysis applications basic better change company content dark data description development " +
		"education engineer engineering english example experience factory field information language management manager " +
		"name overview products professional profile project projects report reports responsibilities results section senior " +
		"service services skills software summary system systems team technical technology tools work"
	).split(" "),
);
const latinLabel =
	/^[a-z][a-z0-9]*(?:[._/+-][a-z0-9]+|[+#]+)*(?:[ \t]+[a-z][a-z0-9]*(?:[._/+-][a-z0-9]+|[+#]+)*){0,3}$/iu;
const latinNameRun =
	/(?<![\p{L}\p{M}\p{N}_])(?:[وف])?((?:[A-Z][A-Za-z0-9]*(?:[._/+-][A-Za-z0-9]+|[+#]+)*|[a-z]+[A-Z_][A-Za-z0-9_]+)(?:[ \t]+[A-Z][A-Za-z0-9]*(?:[._/+-][A-Za-z0-9]+|[+#]+)*)*)(?![\p{L}\p{M}\p{N}_])/gu;
const isEnglishProseWord = (word: string) =>
	englishProseWords.has(word.toLowerCase()) || /^[A-Z][a-z]{3,}(?:ed|ing)$/u.test(word);

function isLatinLabel(text: string) {
	return latinLabel.test(text) && !text.split(/\s+/u).some(isEnglishProseWord);
}

function possibleLatinNames(text: string) {
	return [...stripPlaceholders(text).matchAll(latinNameRun)].flatMap(([, run = ""]) => {
		const words = run.split(/\s+/u);
		const names = words.filter((word) => !isEnglishProseWord(word) && !ordinaryEnglishWords.has(word.toLowerCase()));
		if (!names.length || words.length > 4) return [];
		return words.some(isEnglishProseWord) ? names : [run, ...names];
	});
}

function languageText(prose: string) {
	return normalizeTranslationFactDates(normalizeHijriDates(normalizeFact(prose)))
		.replace(/(?<!\p{L})(?:gregorian|ميلادي(?:ة)?|hijri|هجري(?:ة)?|ce|ad|ah)(?!\p{L})/giu, "")
		.replace(/(?<!\p{L})(?:from|من) (?=\d)/gu, "")
		.replace(/(?<=\d) (?:to|until|الى|حتى) (?=\d)/gu, "-");
}

function wrongTranslationLanguage(
	source: { text: string; prose: string },
	target: { text: string; prose: string },
	direction: TranslationCandidate["direction"],
	aliases: Parameters<typeof translationTerms>[1],
	latinLabels: ProtectedTranslation["latinLabels"],
) {
	const unchanged = source.text.trim() === target.text.trim();
	if (unchanged && latinLabels?.has(source.text.trim())) return false;

	// An unchanged Latin name is neutral in either direction. Use only names shared with this slot.
	const names = new Set(possibleLatinNames(source.text));
	for (const label of latinLabels ?? []) {
		if (source.text.includes(label)) names.add(label);
	}
	let { prose: sourceProse } = source;
	let { prose: targetProse } = target;
	let hasArabicConjunction = false;
	if (names.size) {
		const boundary = "[\\p{L}\\p{M}\\p{N}_]";
		const alternatives = [...names].sort((a, b) => b.length - a.length).map(escaped);
		const pattern = new RegExp(`(?<!${boundary})([وف])?(${alternatives.join("|")})(?!${boundary})`, "gu");
		const retained = new Set<string>();
		for (const [, conjunction, name] of stripPlaceholders(target.text).matchAll(pattern)) {
			if (name) retained.add(name);
			hasArabicConjunction ||= conjunction === "و";
		}
		const withoutNames = (value: string, keepConjunction = false) =>
			stripPlaceholders(value).replace(pattern, (match, conjunction: string | undefined, name: string) =>
				retained.has(name) ? ` ${keepConjunction ? (conjunction ?? "") : ""} ` : match,
			);
		sourceProse = translationTerms(withoutNames(source.text, direction === "ar-en"), aliases).prose;
		targetProse = translationTerms(withoutNames(target.text), aliases).prose;
	}

	const sourceText = languageText(sourceProse);
	const targetText = languageText(targetProse);
	const letters = targetText.match(/\p{L}/gu) ?? [];
	const targetScript = direction === "en-ar" ? /\p{Script=Arabic}/u : /\p{Script=Latin}/u;
	const targetLetters = letters.filter((letter) => targetScript.test(letter)).length;
	// In a list of names, Arabic can express the entire connector with a single attached letter.
	if (
		direction === "en-ar" &&
		!letters.length &&
		hasArabicConjunction &&
		/^(?:\s*and)+\s*$/u.test(sourceText.replace(/\p{P}/gu, " "))
	)
		return false;
	const sourceHasProse = /\p{L}/u.test(sourceText) || (!unchanged && /\p{L}/u.test(languageText(source.prose)));
	return targetLetters < letters.length - targetLetters || (!targetLetters && (letters.length > 0 || sourceHasProse));
}

type FactIssue = {
	id: string;
	kind: TranslationFactAssertion["kind"] | "name" | "organization" | "contact" | "term" | "language" | "missing";
	value?: string;
};

function changedAssertion(expected: TranslationFactAssertion[], actual: TranslationFactAssertion[]) {
	for (const kind of ["date", "calendar", "number", "negation"] as const) {
		const before = expected.filter((fact) => fact.kind === kind).map((fact) => fact.normalizedValue);
		const after = actual.filter((fact) => fact.kind === kind).map((fact) => fact.normalizedValue);
		if (kind === "negation" && (!before.length || !after.length)) continue;
		if (same(before, after)) continue;
		const value = changedValue(before, after);
		return { kind, ...(value && value.length <= 50 ? { value } : {}) };
	}
}

export function classifyTranslationFacts(
	prepared: ProtectedTranslation,
	raw: TranslationCandidate,
	aliases: readonly { source: string; target: string }[] = [],
) {
	const candidate = translationCandidateSchema.parse(raw);
	const sources = new Set(prepared.maskedSegments.map(({ id }) => id));
	if (
		sources.size !== prepared.maskedSegments.length ||
		new Set(candidate.segments.map(({ sourceId }) => sourceId)).size !== candidate.segments.length ||
		candidate.segments.some(({ sourceId }) => !sources.has(sourceId)) ||
		(prepared.binding &&
			(candidate.direction !== prepared.binding.direction ||
				candidate.sourceRevision !== prepared.binding.sourceRevision))
	)
		throw new Error("AI_SOURCE_BINDING");

	const keptIds: string[] = [];
	const issues: FactIssue[] = [];
	const output = new Map(candidate.segments.map(({ sourceId, text }) => [sourceId, text]));
	for (const { id: sourceId, text: source } of prepared.maskedSegments) {
		const text = output.get(sourceId);
		if (text === undefined) {
			issues.push({ id: sourceId, kind: "missing" });
			continue;
		}
		const received = translationPlaceholderOccurrences(text).map(({ token }) => token);
		const expected = translationPlaceholderOccurrences(source).map(({ token }) => token);
		const actual = factAssertions(sourceId, text);
		const expectedAssertions = prepared.assertions.filter((entry) => entry.sourceId === sourceId);
		const changed = changedAssertion(expectedAssertions, actual);
		const plain = stripPlaceholders(text).trim();
		const hasContact = plain && redactModelText(plain, [], { plainText: true }).redactedValues.length > 0;
		const before = translationTerms(source, aliases);
		const after = translationTerms(text, aliases);

		if (!same(received, expected)) {
			const missing = expected.find((token) => !received.includes(token));
			const kind = missing ? prepared.localMap.get(missing)?.kind : undefined;
			issues.push({ id: sourceId, kind: kind === "official" ? "organization" : (kind ?? "term") });
		} else if (hasContact) issues.push({ id: sourceId, kind: "contact" });
		else if (!same(before.terms, after.terms)) {
			const value = changedValue(before.terms, after.terms);
			issues.push({ id: sourceId, kind: "term", ...(value ? { value } : {}) });
		} else if (changed) issues.push({ id: sourceId, ...changed });
		else if (
			wrongTranslationLanguage(
				{ text: source, prose: before.prose },
				{ text, prose: after.prose },
				candidate.direction,
				aliases,
				prepared.latinLabels,
			)
		)
			issues.push({ id: sourceId, kind: "language" });
		else keptIds.push(sourceId);
	}
	return { keptIds, withheldIds: issues.map(({ id }) => id), issues };
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
