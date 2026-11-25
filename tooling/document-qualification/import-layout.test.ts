import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { expect, it } from "vite-plus/test";
import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";
import { assemblePdfParagraphs, pdfImportText } from "@reactive-resume/import/pdf-lines";
import { parsePdfResume, parseResumeText } from "@reactive-resume/import/plain-text";
import { buildExtractedDocument, harvestPdfDocument, summarizePdfCoverage } from "@reactive-resume/resume/ats-pdf";
import expected from "./import-layout/expected.json" with { type: "json" };
import manifest from "./import-layout/manifest.json" with { type: "json" };
import sources from "./import-layout/source-resumes.json" with { type: "json" };

type Gold = {
	name: string;
	summary: readonly string[];
	fields: readonly (readonly string[])[];
	status: string;
	lines?: readonly string[];
	duplicates?: readonly string[];
	summaryBullets?: readonly string[];
	experienceDescription?: readonly string[];
};

type ReaderOutput = Gold & { lines: readonly string[]; duplicates: readonly string[] };

function assertGolden(output: ReaderOutput, gold: Gold) {
	expect(output.name).toBe(gold.name);
	expect(output.summary).toEqual(gold.summary);
	expect(output.fields).toEqual(gold.fields);
	expect(output.status).toBe(gold.status);
	if (gold.lines) expect(output.lines).toEqual(gold.lines);
	if (gold.duplicates) expect(output.duplicates).toEqual(gold.duplicates);
	if (gold.summaryBullets) expect(output.summaryBullets).toEqual(gold.summaryBullets);
	if (gold.experienceDescription) expect(output.experienceDescription).toEqual(gold.experienceDescription);
}

function project(
	lines: readonly string[],
	units: Parameters<typeof parsePdfResume>[0],
	status: string,
	locale?: string,
): ReaderOutput {
	const data = parsePdfResume(units, locale ? { locale } : {});
	return {
		name: data.basics.name,
		summary: [...data.summary.content.matchAll(/<p>(.*?)<\/p>/gu)].map(([, paragraph]) => paragraph ?? ""),
		fields: data.sections.experience.items.map((item) => [item.company, item.position]),
		status,
		lines,
		duplicates: lines.filter((line) => line === "TypeScript"),
		summaryBullets: [...data.summary.content.matchAll(/<li>(.*?)<\/li>/gu)].map(([, bullet]) => bullet ?? ""),
		experienceDescription: [...(data.sections.experience.items[0]?.description ?? "").matchAll(/<p>(.*?)<\/p>/gu)].map(
			([, paragraph]) => paragraph ?? "",
		),
	};
}

it("recognizes clean controls and rejects employer, percentage and glyph mutations", () => {
	const gold = expected["app-english"];
	const clean: ReaderOutput = { ...gold, lines: [], duplicates: [] };
	expect(() => assertGolden(clean, gold)).not.toThrow();
	expect(() =>
		assertGolden(
			{
				...clean,
				fields: [
					["Northstar Labs", "Software Engineer"],
					["Horizon Systems", "Release Engineer"],
				],
			},
			gold,
		),
	).toThrow();
	expect(() =>
		assertGolden(
			{
				...clean,
				summary: clean.summary.map((text) => text.replace("22%", "%22")),
			},
			gold,
		),
	).toThrow();
	expect(() => assertGolden({ ...clean, name: clean.name.slice(1) }, gold)).toThrow();
});

it.each(manifest.entries)("binds $id to its independently authored source and PDF bytes", async (fixture) => {
	const path = new URL("./import-layout/", import.meta.url);
	const bytes = await readFile(new URL(fixture.file, path));
	expect(createHash("sha256").update(bytes).digest("hex")).toBe(fixture.sha256);
	expect((await readFile(new URL(fixture.source, path))).length).toBeGreaterThan(0);
	expect(fixture).toMatchObject(expected[fixture.id as keyof typeof expected]);
});

it.each(manifest.entries)("$id matches the exact ordered fields and paragraphs in both readers", async (fixture) => {
	const bytes = await readFile(new URL(`./import-layout/${fixture.file}`, import.meta.url));
	const task = getDocument({ data: Uint8Array.from(bytes), fontExtraProperties: true });
	try {
		const raw = await harvestPdfDocument(await task.promise, {
			file: { name: fixture.file, sizeBytes: bytes.length, magicBytesOk: true },
		});
		const parsed = pdfImportText(raw, { allowPartial: true });
		if (fixture.id === "app-english") {
			const source = sources["app-english"];
			const importedText = parseResumeText(parsed.lines.join("\n"));
			expect(importedText.summary.content).toContain(
				`<ul>${source.summaryBullets.map((text) => `<li>${text}</li>`).join("")}</ul>`,
			);
			expect(parsed.lines).not.toContain(source.experienceDescription[0]);
		}
		const status = summarizePdfCoverage(raw, []).status;
		const importer = project(parsed.lines, parsed.paragraphUnits, status, parsed.locale);
		const atsLines = buildExtractedDocument(raw).lines;
		const atsUnits = assemblePdfParagraphs(atsLines.flatMap((line) => (line.logical ? [line.logical] : [])));
		const atsReader = project(
			atsLines.map((line) => line.text),
			atsUnits,
			status,
			parsed.locale,
		);
		expect(parsed.pages.flatMap((page) => page.text.split("\n"))).toEqual(parsed.lines);
		if (fixture.id === "app-mixed")
			expect(
				new Set(atsLines.flatMap(({ logical }) => (logical?.column === undefined ? [] : [logical.column]))),
			).toEqual(new Set([0, 1]));
		for (const output of [importer, atsReader]) {
			assertGolden(output, fixture);
			if (fixture.fields.length === 2) {
				const [[firstEmployer, firstRole], [secondEmployer, secondRole]] = output.fields as [
					[string, string],
					[string, string],
				];
				expect(() =>
					assertGolden(
						{
							...output,
							fields: [
								[secondEmployer, firstRole],
								[firstEmployer, secondRole],
							],
						},
						fixture,
					),
				).toThrow();
			}
			if (fixture.summary.some((text) => text.includes("22%")))
				expect(() =>
					assertGolden(
						{
							...output,
							summary: output.summary.map((text) => text.replace("22%", "%22")),
						},
						fixture,
					),
				).toThrow();
			expect(() => assertGolden({ ...output, name: output.name.slice(1) }, fixture)).toThrow();
		}
	} finally {
		await task.destroy();
	}
});
