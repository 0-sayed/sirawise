import { expect, it } from "vite-plus/test";
import {
	buildTranslationInventory,
	protectTranslationPlaceholders,
	translationPlaceholders,
} from "@reactive-resume/resume/translation";
import { educationItemSchema, experienceItemSchema } from "@reactive-resume/schema/resume/data";
import { defaultResumeData } from "@reactive-resume/schema/resume/default";
import { minimizeModelText } from "./payload";
import { hasUnresolvedTranslationPlaceholder, resolveTranslationText } from "./translation-placeholders";

it("restores inline contact values redacted to [redacted] without sending real values to AI", () => {
	const sourceText = "مرجع مهني وزميل سابق. reviewer1@sirawise.test";
	const sentToAi = minimizeModelText(sourceText, []);
	expect(sentToAi).toBe("مرجع مهني وزميل سابق. [redacted]");
	expect(sentToAi).not.toContain("reviewer1@sirawise.test");

	const resolved = resolveTranslationText({
		text: "Professional reference and former colleague. [redacted]",
		sourceText,
		placeholders: [],
		terms: [],
		contactValues: [],
	});

	expect(resolved).toBe("Professional reference and former colleague. reviewer1@sirawise.test");
	expect(hasUnresolvedTranslationPlaceholder(resolved)).toBe(false);
});

it("restores [LOCAL_n] placeholders including lowercase, space, and Arabic-digit variants", () => {
	const placeholders = [
		{ token: "[LOCAL_1]", value: "مجلس الواحة" },
		{ token: "[LOCAL_2]", value: "جامعة الرياض" },
	];
	const terms = [{ source: "جامعة الرياض", value: "Riyadh University" }];

	const resolved = resolveTranslationText({
		text: "Led operations at [local_1], [LOCAL 1], and [LOCAL_٢].",
		sourceText: "قاد العمليات في مجلس الواحة وجامعة الرياض.",
		placeholders,
		terms,
		contactValues: [],
	});

	expect(resolved).toBe("Led operations at مجلس الواحة, مجلس الواحة, and Riyadh University.");
	expect(hasUnresolvedTranslationPlaceholder(resolved)).toBe(false);
});

it("resolves both [LOCAL_n] and inline [redacted] in the same segment without miscounting", () => {
	const placeholders = [{ token: "[LOCAL_1]", value: "owner@sirawise.test" }];
	const sourceText = "تواصل مع owner@sirawise.test أو reviewer1@sirawise.test";

	const resolved = resolveTranslationText({
		text: "Contact [LOCAL_1] or [redacted]",
		sourceText,
		placeholders,
		terms: [],
		contactValues: ["owner@sirawise.test"],
	});

	expect(resolved).toBe("Contact owner@sirawise.test or reviewer1@sirawise.test");
	expect(hasUnresolvedTranslationPlaceholder(resolved)).toBe(false);
});

it("keeps truly unresolvable placeholders flagged instead of guessing", () => {
	const hallucinatedRedacted = resolveTranslationText({
		text: "Professional reference [redacted]",
		sourceText: "مرجع مهني بدون بريد",
		placeholders: [],
		terms: [],
		contactValues: [],
	});
	expect(hallucinatedRedacted).toBe("Professional reference [redacted]");
	expect(hasUnresolvedTranslationPlaceholder(hallucinatedRedacted)).toBe(true);

	const unknownLocal = resolveTranslationText({
		text: "Worked at [LOCAL_99]",
		sourceText: "عمل في جهة",
		placeholders: [{ token: "[LOCAL_1]", value: "مجلس الواحة" }],
		terms: [],
		contactValues: [],
	});
	expect(unknownLocal).toBe("Worked at [LOCAL_99]");
	expect(hasUnresolvedTranslationPlaceholder(unknownLocal)).toBe(true);
});

it("translates degrees, fields of study, and job titles normally instead of locking them as official names", () => {
	const data = structuredClone(defaultResumeData);
	data.basics.headline = "مدير عمليات المنتجات وتحسين الخدمات";
	data.summary.hidden = false;
	data.summary.content = "<p>مدير عمليات سعودي بخبرة عشرين عامًا.</p>";
	data.sections.experience.hidden = false;
	data.sections.experience.items = [
		experienceItemSchema.parse({
			id: "exp-1",
			hidden: false,
			company: "مجلس الواحة",
			position: "مدير عمليات المنتجات",
			location: "",
			period: "2020-2026",
			website: { url: "", label: "" },
			description: "",
		}),
	];
	data.sections.education.hidden = false;
	data.sections.education.items = [
		educationItemSchema.parse({
			id: "edu-1",
			hidden: false,
			school: "معهد واحة المعرفة 1",
			degree: "بكالوريوس",
			area: "نظم المعلومات وإدارة العمليات",
			grade: "",
			location: "",
			period: "2006",
			website: { url: "", label: "" },
			description: "",
		}),
	];
	data.metadata.layout.pages = [{ fullWidth: false, main: ["summary", "experience", "education"], sidebar: [] }];

	const inventory = buildTranslationInventory(data);
	const officialTexts = inventory.segments.filter((seg) => seg.official).map((seg) => seg.text);
	expect(officialTexts).toEqual(["مجلس الواحة", "معهد واحة المعرفة 1"]);
	expect(officialTexts).not.toContain("بكالوريوس");
	expect(officialTexts).not.toContain("نظم المعلومات وإدارة العمليات");
	expect(officialTexts).not.toContain("مدير عمليات المنتجات");

	const placeholders = translationPlaceholders(data);
	expect(protectTranslationPlaceholders(data.basics.headline, placeholders)).toBe(
		"مدير عمليات المنتجات وتحسين الخدمات",
	);
	expect(protectTranslationPlaceholders("عمل في مجلس الواحة.", placeholders)).toContain("[LOCAL_");
	expect(protectTranslationPlaceholders("ومجلس الواحةالمتقدم", [{ token: "[LOCAL_1]", value: "مجلس الواحة" }])).toBe(
		"ومجلس الواحةالمتقدم",
	);
});
