import { describe, expect, it } from "vite-plus/test";
import { computeWordingDiff } from "./wording-diff";

describe("computeWordingDiff", () => {
	it.each([
		["<p>A  B</p>", "<p>A\nB</p>"],
		["<p>A <strong>B</strong></p>", "<p>A B</p>"],
	])("classifies equivalent visible passages as formatting", (before, after) => {
		expect(computeWordingDiff(before, after)).toMatchObject({
			kind: "formatting",
			beforeText: "A B",
			afterText: "A B",
			segments: [],
			hasNewWording: false,
		});
	});

	it.each([
		["Reviewed logs.", "Reviewed logs;", ".", ";"],
		["راجعت السجلات, ثم أرسلتها.", "راجعت السجلات، ثم أرسلتها.", ",", "،"],
		["Reviewed the customer's records.", "Reviewed the customer’s records.", "'", "’"],
		["Follow-up tasks were recorded.", "Follow up tasks were recorded.", "-", ""],
	])("isolates punctuation changes", (before, after, removed, added) => {
		const diff = computeWordingDiff(before, after);
		expect(diff.kind).toBe("punctuation");
		expect(diff.hasNewWording).toBe(false);
		expect(diff.segments.filter(({ type }) => type !== "equal")).toEqual([
			{ type: "delete", text: removed },
			...(added ? [{ type: "insert", text: added }] : []),
		]);
	});

	it("does not label a symbol replacement as punctuation", () => {
		expect(computeWordingDiff("Built ⭐ tools.", "Built 🔧 tools.").kind).toBe("inline");
	});

	it("classifies more than 65 percent word churn as a rewrite", () => {
		expect(computeWordingDiff("led a team and built", "guided the squad and shipped").kind).toBe("rewrite");
		expect(computeWordingDiff("Built reliable services", "Developed secure services").kind).toBe("rewrite");
	});

	it.each([
		[
			"en-US",
			"In my previous role, I led a team and built reusable tools for the business.",
			"In my previous role, I guided the squad and shipped reusable tools for the business.",
			"led a team and built",
			"guided the squad and shipped",
		],
		[
			"ar-SA",
			"في عملي السابق جَمعتُ في المكتب و رتبتُ الملفات الرسمية مع باقي أعضاء الفريق.",
			"في عملي السابق صَنفتُ في المركز و حفظتُ الملفات الرسمية مع باقي أعضاء الفريق.",
			"جَمعتُ في المكتب و رتبتُ",
			"صَنفتُ في المركز و حفظتُ",
		],
	])("coalesces connector bridges and preserves whole words in %s", (locale, before, after, removed, added) => {
		const diff = computeWordingDiff(before, after, locale);
		expect(diff.kind).toBe("inline");
		expect(diff.hasNewWording).toBe(true);
		expect(diff.segments.filter(({ type }) => type !== "equal")).toEqual([
			{ type: "delete", text: removed },
			{ type: "insert", text: added },
		]);
	});

	it("includes a neighboring word when a connector changes alone", () => {
		const diff = computeWordingDiff("Built a service for internal teams.", "Built the service for internal teams.");
		expect(diff.kind).toBe("inline");
		expect(diff.hasNewWording).toBe(false);
		expect(diff.segments.filter(({ type }) => type !== "equal")).toEqual([
			{ type: "delete", text: "a service" },
			{ type: "insert", text: "the service" },
		]);
	});

	it("shows word order changes without labeling moved words as new", () => {
		const diff = computeWordingDiff(
			"Reviewed requests, logs, and metrics each week.",
			"Reviewed logs, requests, and metrics each week.",
		);
		expect(diff.kind).toBe("inline");
		expect(diff.segments.some(({ type }) => type === "delete")).toBe(true);
		expect(diff.segments.some(({ type }) => type === "insert")).toBe(true);
		expect(diff.hasNewWording).toBe(false);
	});
});
