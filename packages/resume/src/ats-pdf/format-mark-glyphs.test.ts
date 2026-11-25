import type { RawTextItem } from "./types";
import { expect, it } from "vite-plus/test";
import { restoreFormatMarkGlyphs } from "./extract";
import fixture from "./fixtures/arabic-format-mark.json";

it("recovers the real Arabic letter that PDF.js drops with a direction mark", () => {
	const items = restoreFormatMarkGlyphs(fixture.items as unknown as RawTextItem[], fixture.operators);
	expect(items.find((item) => item.str === "هندس")).toMatchObject({ str: "هندس", glyphText: "مهندس" });
	expect(fixture.items.find((item) => item.str === "هندس")).not.toHaveProperty("glyphText");
});

it("does not guess a repair when the damaged text is ambiguous", () => {
	const damaged = fixture.items.find((item) => item.str === "هندس");
	if (!damaged) throw new Error("Missing fixture item");
	const items = restoreFormatMarkGlyphs([damaged, damaged] as unknown as RawTextItem[], fixture.operators);
	expect(items.every((item) => !("glyphText" in item))).toBe(true);
});

it.each([false, true])("repairs only the damaged duplicate by position (damaged first: %s)", (damagedFirst) => {
	const glyph = (unicode: string) => ({ unicode, width: 400 });
	const operators = {
		fnArray: [31, 37, 42, 44, 42, 44, 32],
		argsArray: [
			null,
			["f1", 10],
			[1, 0, 0, 1, 20, 40],
			[[glyph("ن"), ...(damagedFirst ? [glyph("م\u200f")] : [])]],
			[1, 0, 0, 1, 60, 40],
			[[glyph("ن"), ...(damagedFirst ? [] : [glyph("م\u200f")])]],
			null,
		],
	};
	const items: RawTextItem[] = [20, 60].map((x) => ({
		str: "ن",
		width: 4,
		height: 10,
		transform: [10, 0, 0, 10, x, 40],
		fontRef: "f1",
		dir: "rtl",
		hasEol: false,
	}));
	const repaired = restoreFormatMarkGlyphs(items, operators);
	expect(repaired.map(({ str, glyphText = str }) => glyphText)).toEqual(damagedFirst ? ["من", "ن"] : ["ن", "من"]);
	expect(repaired.every(({ glyphRecoveryUncertain }) => !glyphRecoveryUncertain)).toBe(true);
});
