import type { TranslationSegment } from "@reactive-resume/resume/translation";
import assert from "node:assert/strict";
import { expect, it } from "vite-plus/test";
import { defaultResumeData } from "@reactive-resume/schema/resume/default";
import { classifyTranslationFacts, prepareTranslationFacts, restoreTranslationFacts } from "./translation-invariants";
import { buildTranslationCheck } from "./translation-verifier";
import { buildCompactTranslationWriter } from "./variant-contracts";
import { prepareCompactTranslationVerification } from "./variant-handlers";

const data = structuredClone(defaultResumeData);
data.basics.name = "نواف Al-Sahli";
data.basics.email = "synthetic@example.test";
function fact(id: string, text: string): TranslationSegment {
	return { id, text, source: text, official: false, target: { sectionId: "basics", field: "headline" } };
}
const candidate = (segments: Array<[string, string]>) => ({
	direction: "en-ar" as const,
	sourceRevision: "revision",
	segments: segments.map(([sourceId, text]) => ({ sourceId, text })),
});

it("provides masked context for a wrapped sentence while keeping its original slots and facts", () => {
	const wrapped = (id: string, blockIndex: number, text: string, itemId = "first"): TranslationSegment => ({
		...fact(id, text),
		source: `<p>${text}</p>`,
		target: { sectionId: "experience", itemId, field: "description", blockIndex },
	});
	const protection = prepareTranslationFacts(data, [
		wrapped("first-line", 0, "Built a gateway for synthetic@example.test that also"),
		wrapped("second-line", 1, "supports direct API calls for 15 customers."),
		wrapped("other-entry", 0, "Completed a separate review.", "second"),
		wrapped("fork-line", 0, "Maintained the original integration and a forked", "third"),
		wrapped("version-line", 1, "version of an automation tool.", "third"),
	]);
	expect(protection.continuations?.get("fork-line")).toEqual({ next: "version of an automation tool." });
	expect(protection.continuations?.get("version-line")).toEqual({
		previous: "Maintained the original integration and a forked",
	});
	const payload = buildCompactTranslationWriter({
		category: "translation",
		resumeId: "synthetic",
		sourceRevision: "revision",
		direction: "en-ar",
		jobAd: null,
		cv: protection.maskedSegments.filter(({ id }) => id === "second-line"),
		translationProtection: protection,
	});
	const task = JSON.parse(payload.selections[0]?.text ?? "");
	expect(task.segments).toEqual([
		{ id: "second-line", section: "experience", text: "supports direct API calls for 15 customers." },
	]);
	expect(task.continuationContext).toEqual({
		"second-line": { previous: "Built a gateway for [LOCAL_1] that also" },
	});
	expect(JSON.stringify(task)).not.toContain("synthetic@example.test");
	expect(JSON.stringify(task)).not.toContain("Completed a separate review.");
	expect(
		classifyTranslationFacts(
			protection,
			candidate([
				["first-line", "بنى بوابة لصالح [LOCAL_1] لـ15 عميلا وهي أيضا"],
				["second-line", "تدعم استدعاءات API المباشرة."],
				["other-entry", "أكمل مراجعة مستقلة."],
				["fork-line", "حافظ على التكامل الأصلي ونسخة متفرعة"],
				["version-line", "نسخة من أداة للأتمتة."],
			]),
		).withheldIds,
	).toEqual(["first-line", "second-line"]);
});

it.each([
	["03/2026-04/2026", "مارس ٢٠٢٦ – أبريل ٢٠٢٦", "مارس ٢٠٢٦ – مايو ٢٠٢٦"],
	["مارس ٢٠٢٦ – أبريل ٢٠٢٦", "Mar 2026 – Apr 2026", "Mar 2026 – Apr 2027"],
	["مارس ٢٠٢٦ – أبريل ٢٠٢٦", "2026-03-2026-04", "2026-04-2026-03"],
	["مارس ٢٠٢٦ – أبريل ٢٠٢٦", "03/2026-04/2026", "03/2026-04/2026 AH"],
	["من آذار ٢٠٢٦ إلى نيسان ٢٠٢٦.", "From 03/2026 to 04/2026.", "From 03/2026 to 05/2026."],
	["استمر العمل من مارس ٢٠٢٦ إلى أبريل ٢٠٢٦.", "Worked from 2026-03-2026-04.", "Worked from 2026-04-2026-03."],
])("retains equivalent Gregorian dates %s and %s", (source, faithful, changed) => {
	const prepared = prepareTranslationFacts(data, [fact("range", source)]);
	expect(classifyTranslationFacts(prepared, candidate([["range", faithful]])).withheldIds).toEqual([]);
	expect(classifyTranslationFacts(prepared, candidate([["range", changed]])).withheldIds).toEqual(["range"]);
});

it("preserves a separated sign and disambiguates ALL before a count", () => {
	const prepared = prepareTranslationFacts(data, [
		fact("change", "Change: − 5%."),
		fact("count", "Reviewed ALL 5 reports."),
		fact("currency", "Billed 5 ALL."),
	]);
	expect(prepared.assertions).toEqual([
		{ sourceId: "change", kind: "number", normalizedValue: "-5%" },
		{ sourceId: "count", kind: "number", normalizedValue: "5" },
		{ sourceId: "currency", kind: "number", normalizedValue: "5all" },
	]);
	expect(
		classifyTranslationFacts(
			prepared,
			candidate([
				["change", "التغيير: ٥٪."],
				["count", "راجعت ٥ تقارير."],
				["currency", "بلغت الفاتورة ٥ ALL."],
			]),
		).withheldIds,
	).toEqual(["change"]);
});

it.each(["name@example.com", "https://example.test/contact", "+1 555 123 4567", "@private_handle"])(
	"masks the bracketed contact %s in both model requests",
	(contact) => {
		const source = fact("contact", `Contact <${contact}> for details.`);
		const protection = prepareTranslationFacts(data, [source]);
		const snapshot = {
			category: "translation" as const,
			resumeId: "synthetic",
			sourceRevision: "revision",
			direction: "en-ar" as const,
			jobAd: null,
			cv: [...protection.maskedSegments],
			translationProtection: protection,
		};
		const [masked] = protection.maskedSegments;
		assert(masked);
		const translation = candidate([[source.id, masked.text]]);
		const writer = buildCompactTranslationWriter(snapshot);
		const verifier = prepareCompactTranslationVerification(snapshot, translation, "part-1").payload;
		expect(verifier).not.toBeNull();
		expect(JSON.stringify(writer)).not.toContain(contact);
		expect(JSON.stringify(verifier)).not.toContain(contact);
		expect(restoreTranslationFacts(protection, translation).segments[0]?.text).toBe(source.text);
	},
);

it.each([
	["$50", "٥٠ دولار", "€50"],
	["EUR 50", "٥٠ يورو", "USD 50"],
	["50 AED", "AED ٥٠", "50 CAD"],
	["£50", "GBP ٥٠", "¥50"],
	["﷼ 50", "٥٠ ريال سعودي", "50 AED"],
])("preserves the currency attached to %s", (source, equivalent, changed) => {
	const prepared = prepareTranslationFacts(data, [fact("cost", `Saved ${source}.`)]);
	expect(classifyTranslationFacts(prepared, candidate([["cost", `Saved ${changed}.`]])).withheldIds).toEqual(["cost"]);
	expect(classifyTranslationFacts(prepared, candidate([["cost", `وفرت ${equivalent}.`]])).keptIds).toEqual(["cost"]);
});

it("preserves names numbers dates calendars and protected entities", () => {
	const company: TranslationSegment = {
		...fact("company", "Cedar Labs"),
		official: true,
		target: { sectionId: "experience", itemId: "experience-id", field: "company" },
	};
	const source = [
		fact("name", "نواف Al-Sahli at synthetic@example.test"),
		company,
		fact("date", "2020–2024 Gregorian"),
		fact("quantity", "Change: −2.5%; five days and twelve weeks."),
	];
	const prepared = prepareTranslationFacts(data, source);
	expect(prepared.localMap.get("[LOCAL_2]")).toMatchObject({
		target: company.target,
		sourceId: "company",
		start: 0,
		end: 10,
		kind: "official",
	});
	expect(prepareTranslationFacts(structuredClone(data), source)).toEqual(prepared);
	expect(JSON.stringify(prepared.maskedSegments)).not.toMatch(/Al-Sahli|Cedar Labs|synthetic@example\.test/u);
	const valid = candidate([
		["name", "[NAME_1] على [LOCAL_1]"],
		["company", "[LOCAL_2]"],
		["date", "٢٠٢٠–٢٠٢٤ ميلادي"],
		["quantity", "التغيير: −٢٫٥٪؛ خمسة أيام واثنا عشر أسبوعا."],
	]);
	expect(JSON.stringify(buildTranslationCheck(prepared, valid, "part-1"))).not.toContain("synthetic@example.test");
	expect(classifyTranslationFacts(prepared, valid).withheldIds).toEqual([]);
	expect(restoreTranslationFacts(prepared, valid).segments[0]?.text).toBe("نواف Al-Sahli على synthetic@example.test");
	for (const [id, text] of [
		["date", "٢٠٢٠–٢٠٢٤ هجري"],
		["quantity", "التغيير ٢٫٥٪؛ خمسة أيام واثنا عشر أسبوعا."],
	] as const) {
		const changed = {
			...valid,
			segments: valid.segments.map((item) => (item.sourceId === id ? { ...item, text } : item)),
		};
		expect(classifyTranslationFacts(prepared, changed).withheldIds).toEqual([id]);
	}
});

it("keeps measured units and rejects an explicit reversal about direct reports", () => {
	const prepared = prepareTranslationFacts(data, [
		fact("metric", "Moved 5 kg over 12 km."),
		fact("role", "Had no direct reports."),
	]);
	const good = candidate([
		["metric", "نقلت ٥ كغ لمسافة ١٢ كم."],
		["role", "لم يكن لدي مرؤوسون مباشرون."],
	]);
	expect(classifyTranslationFacts(prepared, good).withheldIds).toEqual([]);
	const bad = candidate([
		["metric", "نقلت ٥ كم لمسافة ١٢ كغ."],
		["role", "كان لدي مرؤوسون مباشرون."],
	]);
	expect(classifyTranslationFacts(prepared, bad).withheldIds).toEqual(["metric", "role"]);
});

it("keeps the original range when Unicode normalization changes a protected name", () => {
	const data = structuredClone(defaultResumeData);
	data.basics.name = "نواف Al-Sahli";
	const original = "ﻧﻮﺍﻑ Al-Sahli checked the report.";
	const segment = {
		id: "summary",
		text: original,
		source: original,
		official: false,
		target: { sectionId: "summary", field: "content" } as const,
	};
	const protectedFacts = prepareTranslationFacts(data, [segment]);
	expect(protectedFacts.maskedSegments[0]?.text).toBe("[NAME_1] checked the report.");
	expect(protectedFacts.localMap.get("[NAME_1]")).toMatchObject({
		start: 0,
		end: 13,
		value: "ﻧﻮﺍﻑ Al-Sahli",
		kind: "name",
	});
});

it("rejects missing extra and reassigned protected tokens", () => {
	const prepared = prepareTranslationFacts(data, [fact("a", "نواف Al-Sahli"), fact("b", "synthetic@example.test")]);
	expect(
		classifyTranslationFacts(
			prepared,
			candidate([
				["a", "[LOCAL_1]"],
				["b", "[NAME_1]"],
			]),
		).withheldIds,
	).toEqual(["a", "b"]);
	expect(
		classifyTranslationFacts(
			prepared,
			candidate([
				["a", "شخص"],
				["b", "[LOCAL_1] [LOCAL_1]"],
			]),
		).withheldIds,
	).toEqual(["a", "b"]);
	expect(() =>
		classifyTranslationFacts(
			prepared,
			candidate([
				["a", "[NAME_1]"],
				["a", "[NAME_1]"],
			]),
		),
	).toThrow("AI_SOURCE_BINDING");
});

it.each([
	["one day", "يوم واحد"],
	["two days", "يومان"],
	["three days", "ثلاثة أيام"],
	["ten days", "عشرة أيام"],
	["eleven days", "أحد عشر يوما"],
])("keeps unambiguous quantities through Arabic agreement: %s", (english, arabic) => {
	const prepared = prepareTranslationFacts(data, [fact("time", english)]);
	expect(classifyTranslationFacts(prepared, candidate([["time", arabic]])).withheldIds).toEqual([]);
	expect(classifyTranslationFacts(prepared, candidate([["time", "٩٩ يوما"]])).withheldIds).toEqual(["time"]);
});
