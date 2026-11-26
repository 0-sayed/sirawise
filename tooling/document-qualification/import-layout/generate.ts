import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { mock } from "node:test";
import { buildDocx } from "@reactive-resume/docx";
import { createResumePdfFile } from "@reactive-resume/pdf/server";
import { defaultResumeData } from "@reactive-resume/schema/resume/default";
import expectations from "./expected.json" with { type: "json" };
import sources from "./source-resumes.json" with { type: "json" };

const output = (filename: string) => new URL(filename, import.meta.url);
const title = (locale: string, ar: string, en: string) => (locale === "ar-SA" ? ar : en);

function resume(source: (typeof sources)[keyof typeof sources], sidebar: readonly string[] = []) {
	const data = structuredClone(defaultResumeData);
	data.picture.hidden = true;
	data.basics.name = source.name;
	data.summary.title = title(source.locale, "الملخص", "Summary");
	data.summary.content = source.summary.map((text) => `<p>${text}</p>`).join("");
	if ("summaryBullets" in source)
		data.summary.content += `<ul>${source.summaryBullets.map((text) => `<li>${text}</li>`).join("")}</ul>`;
	data.sections.experience.title = title(source.locale, "الخبرة العملية", "Work Experience");
	data.sections.experience.items = source.jobs.map(([company, position], index) => {
		if (!company || !position) throw new Error(`Missing employer or role in fixture job ${index + 1}`);
		return {
			id: `job-${index}`,
			hidden: false,
			company,
			position,
			period: "",
			dates: { start: "2020", end: "2022", present: false },
			description:
				index === 0 && "experienceDescription" in source
					? source.experienceDescription.map((text) => `<p>${text}</p>`).join("")
					: "",
			location: "",
			website: { url: "", label: "", inlineLink: false },
			roles: [],
		};
	});
	data.sections.skills.title = title(source.locale, "المهارات", "Skills");
	data.sections.skills.items = sidebar.map((name, index) => ({
		id: `skill-${index}`,
		hidden: false,
		name,
		icon: "",
		iconColor: "",
		proficiency: "",
		level: 0,
		keywords: [],
	}));
	data.metadata.page.locale = source.locale;
	data.metadata.page.hideIcons = true;
	data.metadata.typography.body.fontFamily = "Noto Sans Arabic";
	data.metadata.typography.heading.fontFamily = "Noto Sans Arabic";
	if (sidebar.length > 0) data.metadata.template = "azurill";
	data.metadata.layout.pages = [
		{ fullWidth: sidebar.length === 0, main: ["summary", "experience"], sidebar: sidebar.length ? ["skills"] : [] },
	];
	return data;
}

function ambiguousPdf() {
	const stream = "BT /F1 12 Tf 0 1 -1 0 90 710 Tm (Retained rotated text) Tj ET";
	const objects = [
		"<< /Type /Catalog /Pages 2 0 R >>",
		"<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
		"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
		"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
		`<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
	];
	let pdf = "%PDF-1.4\n";
	const offsets = objects.map((object, index) => {
		const offset = pdf.length;
		pdf += `${index + 1} 0 obj\n${object}\nendobj\n`;
		return offset;
	});
	const xref = pdf.length;
	const rows = offsets.map((offset) => `${String(offset).padStart(10, "0")} 00000 n \n`).join("");
	return `${pdf}xref\n0 6\n0000000000 65535 f \n${rows}trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
}

const [mode, officePdf] = process.argv.slice(2);
if (mode === "--record-office" && officePdf) {
	await writeFile(output("office-mixed.pdf"), await readFile(officePdf));
	const office = execFileSync("libreoffice", ["--version"], { encoding: "utf8" }).trim();
	const entries = await Promise.all(
		Object.entries(expectations).map(async ([id, expected]) => {
			const chromium = id.startsWith("chromium-");
			const file = chromium ? `../native/${id.slice("chromium-".length)}.pdf` : `${id}.pdf`;
			const producer = chromium
				? "Chromium 150.0.7871.128"
				: id === "office-mixed"
					? office
					: id === "ambiguous"
						? "Authored PDF 1.4"
						: "Forme 0.31.0";
			const source = chromium
				? file.replace(/\.pdf$/u, ".html")
				: id === "office-mixed"
					? "office-mixed.docx"
					: id === "ambiguous"
						? "generate.ts"
						: "source-resumes.json";
			const fonts = chromium
				? "Noto Sans Arabic / Noto Sans (20201225-1build1)"
				: id === "ambiguous"
					? "Helvetica"
					: id === "office-mixed"
						? "Noto Sans Arabic (20201225-1build1) / DejaVu Sans 2.37"
						: "Noto Sans Arabic 2.009 / Noto Sans (20201225-1build1)";
			const sha256 = createHash("sha256")
				.update(await readFile(output(file)))
				.digest("hex");
			return { id, file, source, producer, fonts, sha256, ...expected };
		}),
	);
	await writeFile(output("manifest.json"), `${JSON.stringify({ version: 1, entries }, null, "\t")}\n`);
} else if (!mode) {
	const localFonts = new Map([
		["/s/notosans/v42/o-0mIpQlx3QUlC5A4PNB6Ryti20_6n1iPHjcz6L1SoM-jCpoiyD9A99d41P6zHtY.ttf", "Regular"],
		["/s/notosans/v42/o-0mIpQlx3QUlC5A4PNB6Ryti20_6n1iPHjcz6L1SoM-jCpoiyAaBN9d41P6zHtY.ttf", "Bold"],
	]);
	const readLocalFont = mock.method(globalThis, "fetch", async (source: URL) => {
		const weight = localFonts.get(source.pathname);
		if (!weight || !["fonts.gstatic.com", "fonts.gstatic.cn"].includes(source.hostname))
			throw new Error(`Unexpected fixture font: ${source}`);
		const bytes = await readFile(`/usr/share/fonts/truetype/noto/NotoSans-${weight}.ttf`);
		return new Response(new Uint8Array(bytes));
	});
	try {
		for (const id of ["app-arabic", "app-english", "app-mixed"] as const) {
			const file = await createResumePdfFile({
				data: resume(sources[id], id === "app-mixed" ? sources[id].sidebar : []),
				filename: `${id}.pdf`,
			});
			await writeFile(output(file.name), new Uint8Array(await file.arrayBuffer()));
		}
	} finally {
		readLocalFont.mock.restore();
	}
	const docx = await buildDocx(resume(sources["office-mixed"]));
	await writeFile(output("office-mixed.docx"), new Uint8Array(await docx.arrayBuffer()));
	await writeFile(output("ambiguous.pdf"), ambiguousPdf());
} else {
	throw new Error("Expected --record-office followed by the exported PDF path.");
}
