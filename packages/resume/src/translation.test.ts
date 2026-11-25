import assert from "node:assert/strict";
import { expect, it } from "vite-plus/test";
import { customSectionSchema, sectionTypeSchema } from "@reactive-resume/schema/resume/data";
import { defaultResumeData } from "@reactive-resume/schema/resume/default";
import {
	alignRichTextStructure,
	buildTranslationInventory,
	protectTranslationPlaceholders,
	translationBlockOnlyDivergence,
	translationStructureMatches,
	writeTranslationTarget,
} from "./translation";

it("preserves existing tokens beside whole-term legacy replacements", () => {
	const text = "Cedar Labs and [NAME_1] used Cedar Labstore and [LOCAL_9].";
	expect(protectTranslationPlaceholders(text, [{ token: "[LOCAL_1]", value: "Cedar Labs" }])).toBe(
		"[LOCAL_1] and [NAME_1] used Cedar Labstore and [LOCAL_9].",
	);
});

it.each(sectionTypeSchema.options)(
	"covers rendered prose for custom %s without sending contacts or extra properties",
	(type) => {
		const data = structuredClone(defaultResumeData);
		const values = Object.fromEntries(
			[
				"company",
				"position",
				"description",
				"school",
				"degree",
				"area",
				"grade",
				"location",
				"period",
				"name",
				"proficiency",
				"language",
				"fluency",
				"title",
				"awarder",
				"date",
				"issuer",
				"publisher",
				"organization",
				"network",
				"username",
				"phone",
				"recipient",
				"content",
			].map((field) => [field, field === "description" || field === "content" ? `<p>${field}</p>` : field]),
		);
		data.customSections = [
			customSectionSchema.parse({
				id: "custom",
				type,
				title: "Heading",
				hidden: false,
				items: [
					{
						...values,
						id: "item",
						hidden: false,
						icon: "code",
						website: { url: "https://private.example.test", label: "" },
						keywords: ["keyword"],
						ignored: "Do not send",
					},
				],
			}),
		];
		data.metadata.layout.pages = [{ fullWidth: true, main: ["custom"], sidebar: [] }];
		const inventory = buildTranslationInventory(data);
		expect(inventory.blocking).toEqual([]);
		expect(inventory.segments[0]?.text).toBe("Heading");
		expect(inventory.segments.length).toBeGreaterThan(1);
		expect(JSON.stringify(inventory.segments)).not.toMatch(
			/private.example|Do not send|"source":"(?:location|period|date|username|phone|recipient|grade)"/u,
		);
		for (const segment of inventory.segments)
			writeTranslationTarget(data, segment.target, `Translated ${segment.text}`);
		expect(data.customSections[0]?.title).toBe("Translated Heading");
		for (const segment of inventory.segments.slice(1)) {
			const item = data.customSections[0]?.items[0];
			expect(item?.[segment.target.field]).toEqual(
				segment.target.field === "keywords"
					? ["Translated keyword"]
					: segment.target.field === "description" || segment.target.field === "content"
						? `<p>Translated ${segment.text}</p>`
						: `Translated ${segment.text}`,
			);
		}
	},
);

it("only blocks named sections whose renderer type is unsupported", () => {
	const data = structuredClone(defaultResumeData);
	data.customSections = [
		customSectionSchema.parse({
			id: "legacy",
			type: "summary",
			title: "Legacy content",
			hidden: false,
			items: [{ id: "body", hidden: false, content: "<p>Legacy prose</p>" }],
		}),
	];
	const section = data.customSections[0];
	assert(section);
	section.type = "legacy-renderer" as never;
	data.metadata.layout.pages = [{ fullWidth: true, main: ["legacy"], sidebar: [] }];
	expect(buildTranslationInventory(data)).toMatchObject({ blocking: ["legacy"], blockingSections: ["Legacy content"] });
	section.hidden = true;
	expect(buildTranslationInventory(data).blocking).toEqual([]);
});

it("translates custom headings, rich text and keywords by stable section and item IDs", () => {
	const data = structuredClone(defaultResumeData);
	data.customSections = [
		customSectionSchema.parse({
			id: "notes",
			type: "summary",
			title: "ملاحظات",
			hidden: false,
			items: [{ id: "note", hidden: false, content: "<p>واحد</p><ul><li>اثنان</li></ul>" }],
		}),
		customSectionSchema.parse({
			id: "tools",
			type: "skills",
			title: "أدوات",
			hidden: false,
			items: [{ id: "tool", hidden: false, icon: "code", name: "برمجة", proficiency: "متقدم", keywords: ["اختبار"] }],
		}),
	];
	data.metadata.layout.pages = [{ fullWidth: true, main: ["notes", "tools"], sidebar: [] }];
	const inventory = buildTranslationInventory(data);
	expect(inventory.blocking).toEqual([]);
	expect(inventory.segments.map((segment) => segment.text)).toEqual([
		"ملاحظات",
		"واحد",
		"اثنان",
		"أدوات",
		"برمجة",
		"متقدم",
		"اختبار",
	]);
	for (const segment of inventory.segments) writeTranslationTarget(data, segment.target, `EN ${segment.text}`);
	expect(data.customSections[0]?.title).toBe("EN ملاحظات");
	expect(data.customSections[0]?.items[0]?.content).toBe("<p>EN واحد</p><ul><li>EN اثنان</li></ul>");
	expect(data.customSections[1]?.items[0]?.keywords).toEqual(["EN اختبار"]);
	const copy = structuredClone(data);
	expect(translationStructureMatches(data, copy)).toBe(true);
	const section = copy.customSections[0];
	assert(section);
	section.type = "projects";
	expect(translationStructureMatches(data, copy)).toBe(false);
});

it("preserves official custom names, hidden content and missing-target guards", () => {
	const data = structuredClone(defaultResumeData);
	data.customSections = [
		customSectionSchema.parse({
			id: "courses",
			type: "certifications",
			title: "دورات",
			hidden: false,
			items: [
				{
					id: "course",
					hidden: false,
					title: "شهادة",
					issuer: "المعهد",
					date: "1445",
					website: { url: "https://example.test", label: "" },
					description: "<p>دراسة</p>",
				},
				{
					id: "hidden",
					hidden: true,
					title: "مخفي",
					issuer: "خاص",
					date: "",
					website: { url: "", label: "", inlineLink: false },
					description: "",
				},
			],
		}),
	];
	data.metadata.layout.pages = [{ fullWidth: true, main: ["courses"], sidebar: [] }];
	const inventory = buildTranslationInventory(data);
	expect(inventory.blocking).toEqual([]);
	expect(inventory.segments.filter((segment) => segment.official).map((segment) => segment.text)).toEqual([
		"شهادة",
		"المعهد",
	]);
	expect(JSON.stringify(inventory)).not.toMatch(/1445|example.test|مخفي|خاص/u);
	const segment = inventory.segments.find((segment) => segment.text === "دراسة");
	const section = data.customSections[0];
	assert(segment && section);
	section.items = [];
	expect(() => writeTranslationTarget(data, segment.target, "Study")).toThrow("TRANSLATION_TARGET_CHANGED");
});

it("inventories visible prose and headings while keeping contacts, dates and hidden content local", () => {
	const data = structuredClone(defaultResumeData);
	data.basics.headline = "مهندس";
	data.basics.email = "private@example.test";
	data.summary.content = "<p>لم أدر ميزانية.</p>";
	data.summary.hidden = false;
	data.summary.title = "نبذة";
	data.metadata.layout.pages = [{ fullWidth: false, main: ["summary"], sidebar: [] }];
	const inventory = buildTranslationInventory(data);
	expect(inventory.segments.map((segment) => segment.target)).toEqual(
		expect.arrayContaining([
			{ sectionId: "basics", field: "headline" },
			{ sectionId: "summary", field: "content", blockIndex: 0 },
			{ sectionId: "summary", field: "title" },
		]),
	);
	expect(JSON.stringify(inventory)).not.toContain("private@example.test");
	expect(inventory.blocking).toEqual([]);
	writeTranslationTarget(data, { sectionId: "basics", field: "headline" }, "Engineer");
	writeTranslationTarget(data, { sectionId: "summary", field: "content" }, "Did not manage a budget.");
	expect(data.basics.email).toBe("private@example.test");
	expect(data.basics.headline).toBe("Engineer");
	expect(data.summary.content).toBe("<p>Did not manage a budget.</p>");
	expect(() => writeTranslationTarget(data, { sectionId: "basics", field: "email" } as never, "changed")).toThrow();
});

it("translates repeated paragraphs and nested list blocks independently without flattening their structure", () => {
	const data = structuredClone(defaultResumeData);
	data.summary.hidden = false;
	data.summary.content = "<p>One</p><p>One</p><ul><li><p>Two</p></li><li>Three</li></ul>";
	data.metadata.layout.pages = [{ fullWidth: false, main: ["summary"], sidebar: [] }];
	const segments = buildTranslationInventory(data).segments.filter((segment) => segment.target.field === "content");
	expect(segments.map((segment) => segment.text)).toEqual(["One", "One", "Two", "Three"]);
	expect(new Set(segments.map((segment) => segment.id)).size).toBe(4);
	segments.forEach((segment, index) => writeTranslationTarget(data, segment.target, `Translated ${index} & safe`));
	expect(data.summary.content).toBe(
		"<p>Translated 0 &amp; safe</p><p>Translated 1 &amp; safe</p><ul><li><p>Translated 2 &amp; safe</p></li><li>Translated 3 &amp; safe</li></ul>",
	);
});

it("detects source/copy translation structure changes while permitting independent wording and metadata", () => {
	const source = structuredClone(defaultResumeData);
	source.summary.hidden = false;
	source.summary.content = "<p>One</p><p>Two</p>";
	source.metadata.layout.pages = [{ fullWidth: false, main: ["summary"], sidebar: [] }];
	const copy = structuredClone(source);
	copy.summary.content = "<p>Independent wording</p><p>Translated wording</p>";
	copy.basics.email = "independent@example.test";
	expect(translationStructureMatches(source, copy)).toBe(true);
	copy.summary.content = "<p>One block</p>";
	expect(translationStructureMatches(source, copy)).toBe(false);
	copy.summary.content = "<p>One</p><p>Two</p><p>Added</p>";
	expect(translationStructureMatches(source, copy)).toBe(false);
});

it("detects rich-text block-only divergence and safely realigns rich-text skeletons without touching sections or local contacts", () => {
	const source = structuredClone(defaultResumeData);
	source.basics.email = "source@example.test";
	source.summary.hidden = false;
	source.summary.content = "<p>Updated single paragraph summary</p>";
	source.metadata.layout.pages = [{ fullWidth: false, main: ["summary"], sidebar: [] }];

	const copy = structuredClone(source);
	copy.basics.email = "copy-local@example.test";
	copy.metadata.page.locale = "ar-SA";
	copy.summary.content = "<p>فقرة قديمة أولى</p><p>فقرة قديمة ثانية</p>";

	expect(translationStructureMatches(source, copy)).toBe(false);
	expect(translationBlockOnlyDivergence(source, copy)).toBe(true);

	const aligned = alignRichTextStructure(source, copy);
	expect(translationStructureMatches(source, aligned)).toBe(true);
	expect(aligned.basics.email).toBe("copy-local@example.test");
	expect(aligned.metadata.page.locale).toBe("ar-SA");

	// Section/item additions or removals are NOT block-only divergence
	const withExtraItem = structuredClone(copy);
	withExtraItem.sections.education.hidden = false;
	withExtraItem.sections.education.items.push({
		id: "extra-edu",
		hidden: false,
		school: "School",
		degree: "BS",
		area: "CS",
		grade: "",
		location: "",
		period: "",
		website: { url: "", label: "", inlineLink: false },
		description: "",
	});
	withExtraItem.metadata.layout.pages = [{ fullWidth: false, main: ["summary", "education"], sidebar: [] }];
	expect(translationBlockOnlyDivergence(source, withExtraItem)).toBe(false);
});
