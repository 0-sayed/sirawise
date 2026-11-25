import { describe, expect, it } from "vite-plus/test";
import { locateResumeTextSections } from "./plain-text";

describe("native resume section ranges", () => {
	it("returns original offsets for CRLF and parser-recognized Arabic presentation headings", () => {
		const text = "Sara\r\nEXPERIENCE\r\nEngineer\r\nﺍﻟﻤﻬﺎﺭﺍﺕ\r\nTypeScript\r\nEDUCATION\r\nCollege";
		const sections = locateResumeTextSections(text, "ar-SA");
		expect(sections.map(({ key, start, end }) => [key, text.slice(start, end)])).toEqual([
			["experience", "EXPERIENCE\r\nEngineer\r\n"],
			["skills", "ﺍﻟﻤﻬﺎﺭﺍﺕ\r\nTypeScript\r\n"],
			["education", "EDUCATION\r\nCollege"],
		]);
	});
	it("shares the native parser's unknown-heading and entry-preamble boundaries", () => {
		const text =
			"Sara\nEXPERIENCE\nSENIOR ENGINEER\nExample Labs\n2020 – Present\nBuilt software.\n\nSelected Work\nInternal tool";
		const sections = locateResumeTextSections(text, "en-US");
		expect(sections.map(({ key }) => key)).toEqual(["experience", null]);
		const section = sections[0];
		if (!section) throw new Error("Expected experience section");
		expect(text.slice(section.start, section.end)).toContain("SENIOR ENGINEER");
		expect(text.slice(section.start, section.end)).not.toContain("Selected Work");
	});
});
