import type { RawPage, RawTextItem } from "./types";
import { expect, it } from "vite-plus/test";
import { buildPage } from "./extract";
import { assemblePdfLines, layoutPdfPage } from "./line-layout";

const run = (str: string, x: number, width: number, dir: "ltr" | "rtl" = "rtl"): RawTextItem => ({
	str,
	dir,
	width,
	height: 10,
	transform: [10, 0, 0, 10, x, 200],
	fontRef: "body",
	hasEol: false,
});
const page = (...items: RawTextItem[]): RawPage => ({
	pageNumber: 1,
	width: 500,
	height: 300,
	rotation: 0,
	items,
	operators: null,
});

it("preserves real Arabic spaces across same-run words", () => {
	expect(assemblePdfLines(page(run("نواف السهلي", 20, 60)))).toMatchObject([
		{ text: "نواف السهلي", recovery: "exact" },
	]);
});

it("preserves an LTR number before an acronym inside an RTL line", () => {
	expect(
		assemblePdfLines(page(run("راجعت", 57, 28), run("12", 40, 12, "ltr"), run("KPI", 20, 16, "ltr"))),
	).toMatchObject([{ text: "راجعت 12 KPI", recovery: "ambiguous" }]);
});

it("marks overlapping mixed-direction text as ambiguous even when tagged", () => {
	const tagged = (item: RawTextItem) => ({ ...item, markedContentId: "p" });
	const source = page(tagged(run("KPI", 20, 26, "ltr")), tagged(run("راجعت", 32, 28)));
	source.structure = [{ role: "P", contentIds: ["p"] }];
	expect(assemblePdfLines(source)).toMatchObject([{ recovery: "ambiguous" }]);
});

it("marks indistinguishable Forme number and acronym orders as ambiguous", () => {
	const source = page(
		run("قبل النشر.", 246.43, 41.35),
		run(" ", 287.78, 2.6, "ltr"),
		run("KPI", 290.38, 15.63, "ltr"),
		run(" ", 306.01, 2.6, "ltr"),
		run("راجعت 12", 308.61, 43),
	);
	source.items = source.items.map((item) => ({ ...item, markedContentId: "p" }));
	source.structure = [{ role: "P", contentIds: ["p"] }];
	expect(assemblePdfLines(source)).toMatchObject([{ text: "راجعت 12 KPI قبل النشر.", recovery: "ambiguous" }]);
});

it("separates script transitions with a measurable item gap", () => {
	expect(assemblePdfLines(page(run("BandAI", 20, 30, "ltr"), run("بصفة", 56, 18)))[0]?.text).toBe("BandAI بصفة");
	expect(assemblePdfLines(page(run("22%", 20, 20, "ltr"), run("تحسن", 44, 24)))[0]?.text).toContain("22%");
});

it("puts the percent sign after a standalone number on an RTL page", () => {
	const source = page(run("%22", 20, 20, "ltr"));
	const geometry = buildPage(source, 2, true);
	expect(layoutPdfPage(source, geometry, "rtl").lines[0]?.text).toBe("22%");
	expect(layoutPdfPage(source, geometry, "ltr").lines[0]?.text).toBe("%22");
});

it.each(["01/2024-02/2026", "02/2026-01/2024"])("keeps the source order of RTL month interval %s", (range) => {
	const source = page(run(range, 20, 75, "ltr"), run("BandAI", 105, 30, "ltr"));
	expect(layoutPdfPage(source, buildPage(source, 2, true), "rtl", "Forme").lines[0]?.text).toBe(`BandAI  ${range}`);
});

it("preserves Forme Arabic word fragments with overlapping glyph bounds after a page break", () => {
	const fragments = [
		["ذ،", 343.36, 7.46],
		["ي", 348.24, 3.6],
		["ف", 347.23, 3.87],
		["ن", 348.16, 2.92],
		["ت", 346.96, 3.6],
		["ة وال", 346.73, 16.35],
		["ي", 360.5, 3.6],
		["محل", 360.6, 12.78],
		["ر ال", 369.55, 10.93],
		["طوي", 377.73, 13],
		["ت", 386.61, 3.6],
		["ة ال", 386.38, 11.67],
		["ئ", 394.79, 2.92],
		["ي", 395.13, 3.6],
		["ة إعداد ب", 393.76, 30.43],
		["مت", 420.07, 6.97],
		["أت", 422.75, 7.05],
		["ل worktree-compose", 426.03, 93.28, "ltr"],
	] as const;
	const source = page(
		...fragments.map(([text, x, width, direction]) => ({ ...run(text, x, width, direction), markedContentId: "p" })),
	);
	source.structure = [{ role: "P", contentIds: ["p"] }];
	expect(layoutPdfPage(source, buildPage(source, 2, true), "rtl", "Forme").lines[0]?.logical).toMatchObject({
		text: "worktree-compose لأتمتة إعداد بيئة التطوير المحلية والتنفيذ،",
		recovery: "ambiguous",
	});
});

it("does not reverse logical runs twice and preserves a soft glyph boundary", () => {
	expect(assemblePdfLines(page(run("مهندس", 52, 35), run("برمج", 28, 20), run("يات", 15, 13)))[0]?.text).toBe(
		"مهندس برمجيات",
	);
});

it("keeps text when the item geometry cannot establish a reading order", () => {
	expect(assemblePdfLines(page({ ...run("Readable", 0, 0, "ltr"), geometryUncertain: true }))).toMatchObject([
		{ text: "Readable", recovery: "ambiguous" },
	]);
});

it("keeps tagged contact fields and their punctuation together in an Arabic row", () => {
	const tagged = (markedContentId: string, item: RawTextItem) => ({ ...item, markedContentId });
	const source = page(
		tagged("city", run("الرياض", 20, 25)),
		tagged("phone", run("+", 52, 5, "ltr")),
		tagged("phone", run("966 50 123 4567", 57, 65, "ltr")),
		tagged("email", run("s", 131, 5, "ltr")),
		tagged("email", run("ynthetic@example", 131, 76, "ltr")),
		tagged("email", run(".", 207, 3, "ltr")),
		tagged("email", run("test", 210, 18, "ltr")),
	);
	expect(assemblePdfLines(source)).toMatchObject([
		{ text: "synthetic@example.test  +966 50 123 4567  الرياض", recovery: "exact" },
	]);
});

it("keeps an already logical Arabic cluster when neighboring shaped glyphs do not establish its order", () => {
	expect(assemblePdfLines(page(run("ﻡ", 20, 5), run("ﺎ", 25, 5), run("ﻋ", 30, 5), run("في", 40, 10)))).toMatchObject([
		{ text: "في عام", recovery: "ambiguous" },
	]);
});

it("decodes a single Arabic presentation ligature in its Unicode logical order", () => {
	expect(assemblePdfLines(page(run("ﲆ", 20, 12), run("ﻴ", 32, 5), run("ﻟ", 37, 4)))).toMatchObject([
		{ text: "ليلى", recovery: "exact" },
	]);
});

it.each(["ltr", "rtl"] as const)("keeps a full-width footer below a two-column %s body", (direction) => {
	const at = (text: string, x: number, y: number, width: number) => ({
		...run(text, x, width, "ltr"),
		transform: [10, 0, 0, 10, x, y] as RawTextItem["transform"],
	});
	const columns = [
		Array.from({ length: 15 }, (_, index) => (index ? `Left row ${index}` : "Skills")),
		Array.from({ length: 15 }, (_, index) => (index ? `Right row ${index}` : "Education")),
	];
	const source = page(
		at("Page header", 30, 280, 440),
		...columns.flatMap((lines, index) => lines.map((text, row) => at(text, index ? 300 : 30, 250 - row * 14, 125))),
		at("Page footer", 30, 30, 440),
	);
	const lines = layoutPdfPage(source, buildPage(source, 2, true), direction).lines;
	expect(lines.map(({ text }) => text)).toEqual([
		"Page header",
		...(direction === "ltr" ? columns : [...columns].reverse()).flat(),
		"Page footer",
	]);
});

it("keeps a wrapped tagged heading together beside a different tagged paragraph", () => {
	const first = { ...run("عنوان القسم", 310, 130), markedContentId: "heading-1" };
	const second = {
		...run("متابعة العنوان", 310, 130),
		markedContentId: "heading-2",
		transform: [10, 0, 0, 10, 310, 185] as const,
	};
	const body = { ...run("مؤسسة النور", 140, 120), markedContentId: "company" };
	const source = page(body, first, second);
	source.structure = [
		{ role: "P", contentIds: ["company"] },
		{ role: "P", contentIds: ["heading-1", "heading-2"] },
	];
	expect(layoutPdfPage(source, buildPage(source, 2, true), "rtl", "Forme").lines.map(({ text }) => text)).toEqual([
		"عنوان القسم",
		"متابعة العنوان",
		"مؤسسة النور",
	]);
});
