import { expect, it } from "vite-plus/test";
import { createTagSelection, getTagOptions, getTagUpdates, readTagDraft } from "./tag-selection";

const document = (id: string, tags: string[], isLocked = false) => ({ type: "resume" as const, id, tags, isLocked });

it("sorts suggestions by document usage and matches normalized input", () => {
	const library = [
		{ tag: "Zulu", count: 1 },
		{ tag: "Alpha", count: 1 },
		{ tag: "Product Design", count: 4 },
		{ tag: "رقم ١", count: 2 },
	];
	expect(getTagOptions(library, "", "en-US").matches.map(({ tag }) => tag)).toEqual([
		"Product Design",
		"رقم ١",
		"Alpha",
		"Zulu",
	]);
	expect(getTagOptions(library, " PRODUCT   design ", "en-US")).toMatchObject({
		exact: "Product Design",
		create: null,
	});
	expect(getTagOptions(library, "رقم 1", "ar-SA").exact).toBe("رقم ١");
	expect(getTagOptions(library, "new  work", "en-US").create).toBe("new work");
	expect(getTagOptions(library, "x".repeat(41), "en-US").create).toBeNull();
});

it("splits comma-separated input and keeps the final pending tag", () => {
	expect(readTagDraft(" First, ,بحث  وظائف، Final  tag ")).toEqual({
		completed: ["First", "بحث وظائف"],
		draft: " Final  tag ",
	});
});

it("leaves mixed tags in place, promotes or removes them explicitly, and excludes locked documents", () => {
	const documents = [
		document("a", ["Design", "  Job  Search "]),
		document("b", ["design", "Personal"]),
		document("c", ["Locked"], true),
	];
	expect(createTagSelection(documents)).toEqual([
		{ tag: "Design", count: 2 },
		{ tag: "Job Search", count: 1 },
		{ tag: "Personal", count: 1 },
	]);
	expect(getTagUpdates(documents, [{ tag: "Priority", selected: true }])).toEqual({
		error: null,
		updates: [
			{ type: "resume", id: "a", tags: ["Design", "Job Search", "Priority"] },
			{ type: "resume", id: "b", tags: ["design", "Personal", "Priority"] },
		],
	});
	expect(getTagUpdates(documents, [{ tag: "job search", selected: true }]).updates).toEqual([
		{ type: "resume", id: "b", tags: ["design", "Personal", "job search"] },
	]);
	expect(getTagUpdates(documents, [{ tag: "job search", selected: false }]).updates).toEqual([
		{ type: "resume", id: "a", tags: ["Design"] },
	]);
});

it("rejects a batch when one target would exceed the cap and allows removal at capacity", () => {
	const full = Array.from({ length: 20 }, (_, index) => `Tag ${index}`);
	const documents = [document("a", full), document("b", ["Spare"])];
	expect(getTagUpdates(documents, [{ tag: "New", selected: true }])).toEqual({ error: "count", updates: [] });
	expect(
		getTagUpdates(documents, [
			{ tag: "Tag 0", selected: false },
			{ tag: "New", selected: true },
		]).error,
	).toBeNull();
	expect(getTagUpdates(documents, [{ tag: "x".repeat(41), selected: true }])).toEqual({
		error: "length",
		updates: [],
	});
});
