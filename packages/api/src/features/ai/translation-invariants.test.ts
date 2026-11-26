import type { TranslationSegment } from "@reactive-resume/resume/translation";
import assert from "node:assert/strict";
import { expect, it } from "vite-plus/test";
import { defaultResumeData } from "@reactive-resume/schema/resume/default";
import { classifyTranslationFacts, prepareTranslationFacts, restoreTranslationFacts } from "./translation-invariants";
import { buildCompactTranslationWriter } from "./variant-contracts";

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
	const direction = /\p{Script=Arabic}/u.test(source) ? "ar-en" : "en-ar";
	const prepared = prepareTranslationFacts(data, [fact("range", source)]);
	expect(classifyTranslationFacts(prepared, { ...candidate([["range", faithful]]), direction }).withheldIds).toEqual(
		[],
	);
	expect(classifyTranslationFacts(prepared, { ...candidate([["range", changed]]), direction }).withheldIds).toEqual([
		"range",
	]);
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
	"masks the bracketed contact %s in the writer request",
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
		expect(JSON.stringify(writer)).not.toContain(contact);
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

it.each([
	["date", "Completed on March 15, 2026.", "اكتمل في ١٥ مارس ٢٠٢٦.", "اكتمل في ١٦ مارس ٢٠٢٦.", "date"],
	[
		"range",
		"Worked from March 15, 2026 to April 16, 2026.",
		"عمل من ١٥ آذار ٢٠٢٦ إلى ١٦ نيسان ٢٠٢٦.",
		"عمل من ١٦ نيسان ٢٠٢٦ إلى ١٥ آذار ٢٠٢٦.",
		"date",
	],
	["number", "Reviewed 12 reports.", "راجع ١٢ تقريرا.", "راجع ١٣ تقريرا.", "number"],
	["percentage", "Improved by 22%.", "تحسن بنسبة ٢٢٪.", "تحسن بنسبة ٢٣٪.", "number"],
])("keeps equivalent %s and identifies changes in both directions", (_type, en, ar, changedAr, reason) => {
	for (const [direction, source, faithful, changed] of [
		["en-ar", en, ar, changedAr],
		["ar-en", ar, en, en.replace(/[0-9]+/u, "99")],
	] as const) {
		const prepared = prepareTranslationFacts(data, [fact("s1", source)]);
		expect(classifyTranslationFacts(prepared, { ...candidate([["s1", faithful]]), direction }).withheldIds).toEqual([]);
		expect(classifyTranslationFacts(prepared, { ...candidate([["s1", changed]]), direction })).toMatchObject({
			withheldIds: ["s1"],
			issues: [{ id: "s1", kind: reason }],
		});
	}
});

it.each(["en-ar", "ar-en"] as const)("withholds a wrong-language segment in %s", (direction) => {
	const source = direction === "en-ar" ? "Reviewed completed applications." : "راجع الطلبات المكتملة.";
	const prepared = prepareTranslationFacts(data, [fact("s1", source)]);
	expect(classifyTranslationFacts(prepared, { ...candidate([["s1", source]]), direction })).toMatchObject({
		withheldIds: ["s1"],
		issues: [{ id: "s1", kind: "language" }],
	});
});

it.each(["en-ar", "ar-en"] as const)(
	"accepts unchanged Latin names, keywords and protected values in %s",
	(direction) => {
		const names = [
			...[
				"Codex",
				"Claude Code",
				"GitHub Copilot",
				"NestJS",
				"Fastify",
				"React",
				"Redis",
				"RabbitMQ",
				"Prisma",
				"Drizzle ORM",
				"WebSockets",
				"GitHub Actions",
			].map((text, index): TranslationSegment => ({
				...fact(`skill-${index}`, text),
				target: { sectionId: "skills", itemId: "skills-id", field: "keywords", index },
			})),
			...["Dark Factory", "Auto PR", "Hena Wadeena", "Lyrebird"].map((text, index): TranslationSegment => ({
				...fact(`project-${index}`, text),
				target: { sectionId: "projects", itemId: `project-${index}`, field: "name" },
			})),
			fact("name", "Tandemware"),
			fact("identifier", "render_item"),
			fact("email", "synthetic@example.test"),
			fact("url", "https://example.test/portfolio"),
			fact("alias", "Cedar Tools"),
		];
		const prepared = prepareTranslationFacts(data, names);
		const output = candidate(prepared.maskedSegments.map(({ id, text }) => [id, text]));
		expect(
			classifyTranslationFacts(prepared, { ...output, direction }, [{ source: "Cedar Tools", target: "أدوات الأرز" }])
				.issues,
		).toEqual([]);
	},
);

it.each([
	["en-ar", "Used Redis, RabbitMQ, and Better Auth.", "استخدمت Redis وRabbitMQ وBetter Auth."],
	[
		"en-ar",
		"RabbitMQ, PostgreSQL/TimescaleDB, Drizzle, Better Auth, Docker, and GitHub Actions.",
		"وRabbitMQ وPostgreSQL/TimescaleDB وDrizzle وBetter Auth وDocker وGitHub Actions.",
	],
	[
		"en-ar",
		"products using Node.js, NestJS, Fastify, Drizzle, Prisma, PostgreSQL, React, and TypeScript.",
		"باستخدام Node.js وNestJS وFastify وDrizzle وPrisma وPostgreSQL وReact وTypeScript.",
	],
	["ar-en", "استخدمت Redis وRabbitMQ وBetter Auth.", "Used Redis, RabbitMQ, and Better Auth."],
	["ar-en", "راجع PostgreSQL/TimescaleDB وGitHub Actions.", "Reviewed PostgreSQL/TimescaleDB and GitHub Actions."],
] as const)("requires %s prose while allowing retained Latin names in %s", (direction, source, translated) => {
	const prepared = prepareTranslationFacts(data, [fact("sentence", source)]);
	const classify = (text: string) =>
		classifyTranslationFacts(prepared, { ...candidate([["sentence", text]]), direction });
	expect(classify(source).issues).toEqual([{ id: "sentence", kind: "language" }]);
	expect(classify(translated).keptIds).toEqual(["sentence"]);
});

it("recognizes a lowercase tool and an ordinary-word project name from their CV fields", () => {
	const prepared = prepareTranslationFacts(data, [
		{
			...fact("skill", "pnpm"),
			target: { sectionId: "skills", field: "keywords", itemId: "skills-id", index: 0 },
		},
		{
			...fact("project", "Dark Factory"),
			target: { sectionId: "projects", field: "name", itemId: "project-id" },
		},
		fact("sentence", "Built Dark Factory with pnpm."),
	]);
	expect(
		classifyTranslationFacts(
			prepared,
			candidate([
				["skill", "pnpm"],
				["project", "Dark Factory"],
				["sentence", "بنيت Dark Factory باستخدام pnpm."],
			]),
		).issues,
	).toEqual([]);
});

it.each([
	["en-ar", "Built Redis.", "وRedis."],
	["en-ar", "Used Redis.", "Used Redis. نعم"],
	["en-ar", "Reviewed Applications", "Reviewed Applications"],
	["en-ar", "Senior Software Engineer", "Senior Software Engineer"],
	["en-ar", "Tandemware", "Another Product"],
	["en-ar", "Tandemware", "Tandemware."],
	["ar-en", "راجع Tandemware.", "راجع Tandemware."],
	["ar-en", "راجع Tandemware.", "Tandemware."],
	["ar-en", "وDocker وRabbitMQ.", "وDocker وRabbitMQ."],
] as const)("rejects missing or untranslated prose in %s for %s", (direction, source, text) => {
	const prepared = prepareTranslationFacts(data, [fact("sentence", source)]);
	expect(classifyTranslationFacts(prepared, { ...candidate([["sentence", text]]), direction }).issues).toEqual([
		{ id: "sentence", kind: "language" },
	]);
});

it.each([
	[
		"en-ar",
		"Worked from 10 Ramadan 1447 to 12 Shawwal 1447.",
		"عمل من ١٠ رمضان ١٤٤٧ إلى ١٢ شوال ١٤٤٧.",
		"شوال",
		"رمضان",
	],
	[
		"ar-en",
		"عمل من ١٠ رمضان ١٤٤٧ إلى ١٢ شوال ١٤٤٧.",
		"Worked from 10 Ramadan 1447 to 12 Shawwal 1447.",
		"Shawwal",
		"Ramadan",
	],
] as const)("preserves the Hijri month and range in %s", (direction, source, target, month, wrongMonth) => {
	const prepared = prepareTranslationFacts(data, [fact("range", source)]);
	const classify = (text: string) => classifyTranslationFacts(prepared, { ...candidate([["range", text]]), direction });
	expect(classify(target).withheldIds).toEqual([]);
	expect(classify(target.replace(month, wrongMonth)).issues).toMatchObject([{ id: "range", kind: "date" }]);
});

it.each(["en-ar", "ar-en"] as const)("preserves protected facts and slot bindings in %s", (direction) => {
	const phrases =
		direction === "en-ar"
			? { source: "Contact", target: "تواصل مع", wrong: "Contact" }
			: { source: "تواصل مع", target: "Contact", wrong: "تواصل مع" };
	for (const [kind, value] of [
		["name", data.basics.name],
		["email", data.basics.email],
		["url", "https://example.test/portfolio"],
		["phone", "+1 555 123 4567"],
		["organization", direction === "en-ar" ? "Cedar Labs" : "مختبرات الأرز"],
	] as const) {
		const official = { ...fact("official", value), official: true };
		const sources = [fact("s1", `${phrases.source} ${value}.`), ...(kind === "organization" ? [official] : [])];
		const prepared = prepareTranslationFacts(data, sources);
		const token = [...prepared.localMap.values()].find(({ sourceId }) => sourceId === "s1")?.token;
		expect(token).toBeDefined();
		const make = (text: string) => ({
			...candidate([["s1", text]]),
			direction,
		});
		const bound = { ...prepared, binding: { direction, sourceRevision: "revision" } };
		expect(classifyTranslationFacts(bound, make(`${phrases.target} ${token}.`)).keptIds).toContain("s1");
		expect(classifyTranslationFacts(bound, make(`${phrases.target}.`)).issues[0]).toMatchObject({
			id: "s1",
			kind: ["email", "url", "phone"].includes(kind) ? "contact" : kind,
		});
		expect(classifyTranslationFacts(bound, make(`${phrases.wrong} ${token}.`)).issues[0]?.kind).toBe("language");
		expect(() => classifyTranslationFacts(bound, { ...make(phrases.target), sourceRevision: "stale" })).toThrow(
			"AI_SOURCE_BINDING",
		);
		expect(() =>
			classifyTranslationFacts(bound, {
				...make(phrases.target),
				segments: [{ sourceId: "extra", text: phrases.target }],
			}),
		).toThrow("AI_SOURCE_BINDING");
		expect(classifyTranslationFacts(bound, { ...make(phrases.target), segments: [] }).issues[0]?.kind).toBe("missing");
	}
});

it.each([
	["en-ar", "Used SQL and Cedar Tools.", "استخدمت SQL وأدوات الأرز.", "استخدمت API وأدوات الأرز."],
	["ar-en", "استخدمت SQL وأدوات الأرز.", "Used SQL and Cedar Tools.", "Used SQL and Pine Tools."],
] as const)("preserves protected terms and approved aliases in %s", (direction, source, faithful, changed) => {
	const prepared = prepareTranslationFacts(data, [fact("s1", source)]);
	const aliases = [{ source: "Cedar Tools", target: "أدوات الأرز" }];
	const output = (text: string) => ({ ...candidate([["s1", text]]), direction });
	expect(classifyTranslationFacts(prepared, output(faithful), aliases).keptIds).toEqual(["s1"]);
	expect(classifyTranslationFacts(prepared, output(changed), aliases).issues).toEqual([
		{ id: "s1", kind: "term", value: direction === "en-ar" ? "SQL" : "Cedar Tools" },
	]);
});

it.each([
	["en-ar", "Reviewed the completed applications.", "Reviewed the completed applications. نعم"],
	["ar-en", "راجع الطلبات المكتملة.", "راجع الطلبات المكتملة. OK"],
] as const)("rejects a mostly untranslated segment in %s", (direction, source, text) => {
	const prepared = prepareTranslationFacts(data, [fact("s1", source)]);
	expect(classifyTranslationFacts(prepared, { ...candidate([["s1", text]]), direction }).issues).toEqual([
		{ id: "s1", kind: "language" },
	]);
});

it.each([
	[
		"en-ar",
		"Supports direct AI API calls and CV review.",
		"يدعم الاستدعاءات المباشرة لواجهة الذكاء الاصطناعي ومراجعة السيرة الذاتية.",
	],
	["ar-en", "يدعم الذكاء الاصطناعي وواجهات البرمجة وتصميم تجربة المستخدم.", "Supports AI, APIs and UX design."],
	["en-ar", "Built the UI/UX and CV tools.", "أنشأت أدوات السيرة الذاتية وصممت واجهة المستخدم وتجربته."],
] as const)("allows common acronyms to be translated in %s", (direction, source, text) => {
	const prepared = prepareTranslationFacts(data, [fact("s1", source)]);
	expect(classifyTranslationFacts(prepared, { ...candidate([["s1", text]]), direction }).keptIds).toEqual(["s1"]);
});

it("keeps a generic acronym protected when it is an approved alias", () => {
	const prepared = prepareTranslationFacts(data, [fact("s1", "Worked with AI.")]);
	const aliases = [{ source: "AI", target: "شركة أي آي" }];
	expect(classifyTranslationFacts(prepared, candidate([["s1", "عملت مع الذكاء الاصطناعي."]]), aliases).issues).toEqual([
		{ id: "s1", kind: "term", value: "AI" },
	]);
});
