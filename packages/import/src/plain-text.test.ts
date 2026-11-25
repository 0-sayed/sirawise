import { describe, expect, it } from "vite-plus/test";
import { resumeDataSchema } from "@reactive-resume/schema/resume/data";
import { parseResumeText } from "./plain-text";

const SAMPLE = `Ada Lovelace
Senior Software Engineer
Berlin, Germany | ada@example.com | +44 20 7946 0100 | https://ada.dev

SUMMARY
Engineer with 10 years building analytical systems.

WORK EXPERIENCE
Analytical Engines  Senior Engineer  Berlin
Jan 2020 - Present
• Led the difference engine rewrite
• Mentored four junior engineers
Babbage Ltd  Engineer  London
Mar 2016 - Dec 2019
• Built the punch card pipeline

EDUCATION
University of London  BSc Mathematics
2012 - 2016

SKILLS
TypeScript, Rust, PostgreSQL

LANGUAGES
English (Native)
German (B2)

CERTIFICATIONS
AWS Solutions Architect  Amazon  2021
`;

const educationFields = (lines: string, locale: string) =>
	parseResumeText(`Example Person\nEducation\n${lines}`, { locale }).sections.education.items.map(
		({ school, degree, area, location, dates }) => [school, degree, area, location, dates],
	);

it("reads every Arabic PDF education entry with its own date range", () => {
	const lines = `معهد واحة المعرفة 3 ماجستير
نظم المعلومات وإدارة العمليات الرياض • 01/2019-01/2021
معهد واحة المعرفة 2 دبلوم مهني
نظم المعلومات وإدارة العمليات الرياض • 01/2010-01/2012
معهد واحة المعرفة 1 بكالوريوس
نظم المعلومات وإدارة العمليات الرياض • 01/2004-01/2006`;
	expect(educationFields(lines, "ar-SA")).toEqual([
		[
			"معهد واحة المعرفة 3",
			"ماجستير",
			"نظم المعلومات وإدارة العمليات",
			"الرياض",
			{ start: "2019-01", end: "2021-01", present: false },
		],
		[
			"معهد واحة المعرفة 2",
			"دبلوم مهني",
			"نظم المعلومات وإدارة العمليات",
			"الرياض",
			{ start: "2010-01", end: "2012-01", present: false },
		],
		[
			"معهد واحة المعرفة 1",
			"بكالوريوس",
			"نظم المعلومات وإدارة العمليات",
			"الرياض",
			{ start: "2004-01", end: "2006-01", present: false },
		],
	]);
});

it.each([
	{
		lines: "Ain Shams University 2020\nدرجة البكالوريوس في علوم الحاسب",
		locale: "ar-SA",
		expected: ["Ain Shams University", "درجة البكالوريوس", "علوم الحاسب", "", "2020", null],
	},
	{
		lines: "2021\nMaster of Science in Statistics — North Coast University · Halifax, Canada",
		locale: "en-US",
		expected: ["North Coast University", "Master of Science", "Statistics", "Halifax, Canada", "2021", null],
	},
	{
		lines: "West College, Diploma, Industrial Design | Lisbon - 2018-2020",
		locale: "en-US",
		expected: ["West College", "Diploma", "Industrial Design", "Lisbon", "2018", "2020"],
	},
	{
		lines: "Bachelor of Arts\nRiver Academy\nHistory\nBristol\n٢٠١٩",
		locale: "en-US",
		expected: ["River Academy", "Bachelor of Arts", "History", "Bristol", "2019", null],
	},
	{
		lines: "Master of Arts in history\nUniversity of London|New Haven, CT\n2001",
		locale: "en-US",
		expected: ["University of London", "Master of Arts", "history", "New Haven, CT", "2001", null],
	},
])("maps education fields independently in $lines", ({ lines, locale, expected }) => {
	const [school, degree, area, location, start, end] = expected;
	expect(educationFields(lines, locale)).toEqual([[school, degree, area, location, { start, end, present: false }]]);
});

it("keeps dates attached to the school on the same line across separate entries", () => {
	const data = parseResumeText("Example Person\nEducation\nEast Institute\n2024 | City College | Diploma");
	expect(data.sections.education.items.map(({ school, degree, dates }) => [school, degree, dates?.start])).toEqual([
		["East Institute", "", null],
		["City College", "Diploma", "2024"],
	]);
});

describe("parseResumeText", () => {
	const data = parseResumeText(SAMPLE);

	it("keeps roles under a shared dated company header as separate experience entries", () => {
		const imported = parseResumeText(`
Riyadh, Saudi Arabia   Saudi   Visa sponsorship not required

EXPERIENCE
Acme Labs | Riyadh, Saudi Arabia                Mar 2024 - Jul 2026
Senior Software Engineer, Apr 2026 - Jul 2026
• Led platform delivery
Full Stack Developer, Mar 2024 - Apr 2026
• Built customer workflows
Northwind | Jeddah, Saudi Arabia    Nov 2021 - Mar 2023
Backend Developer
• Built service APIs
`);
		const entries = imported.sections.experience.items;
		expect(imported.basics.location).toBe("Riyadh, Saudi Arabia");
		expect(imported.basics.name).toBe("");
		expect(entries).toHaveLength(3);
		expect(entries.map(({ company, position, location, period }) => ({ company, position, location, period }))).toEqual(
			[
				{
					company: "Acme Labs",
					position: "Senior Software Engineer",
					location: "Riyadh, Saudi Arabia",
					period: "Apr 2026 – Jul 2026",
				},
				{
					company: "Acme Labs",
					position: "Full Stack Developer",
					location: "Riyadh, Saudi Arabia",
					period: "Mar 2024 – Apr 2026",
				},
				{
					company: "Northwind",
					position: "Backend Developer",
					location: "Jeddah, Saudi Arabia",
					period: "Nov 2021 – Mar 2023",
				},
			],
		);
	});

	it("reads the contact block", () => {
		expect(data.basics).toMatchObject({
			name: "Ada Lovelace",
			headline: "Senior Software Engineer",
			email: "ada@example.com",
			phone: "+44 20 7946 0100",
			location: "Berlin, Germany",
		});
		expect(data.basics.website.url).toBe("https://ada.dev");
	});

	it("splits experience into one entry per role", () => {
		expect(data.sections.experience.items).toHaveLength(2);
		expect(data.sections.experience.items[0]).toMatchObject({
			company: "Analytical Engines",
			position: "Senior Engineer",
			location: "Berlin",
			period: "Jan 2020 – Present",
		});
		expect(data.sections.experience.items[1]).toMatchObject({
			company: "Babbage Ltd",
			position: "Engineer",
			period: "Mar 2016 – Dec 2019",
		});
	});

	it("keeps bullets as a list in the description", () => {
		expect(data.sections.experience.items[0]?.description).toBe(
			"<ul><li>Led the difference engine rewrite</li><li>Mentored four junior engineers</li></ul>",
		);
	});

	it("reads education", () => {
		expect(data.sections.education.items[0]).toMatchObject({
			school: "University of London",
			degree: "BSc Mathematics",
			period: "2012 – 2016",
		});
	});

	it("splits a comma separated skills line", () => {
		expect(data.sections.skills.items.map((item) => item.name)).toEqual(["TypeScript", "Rust", "PostgreSQL"]);
	});

	it("splits a language from its fluency", () => {
		expect(data.sections.languages.items).toMatchObject([
			{ language: "English", fluency: "Native" },
			{ language: "German", fluency: "B2" },
		]);
	});

	it("reads a trailing year as the certification date", () => {
		expect(data.sections.certifications.items[0]).toMatchObject({
			title: "AWS Solutions Architect",
			issuer: "Amazon",
			date: "2021",
		});
	});

	it("places every populated section on the page in document order", () => {
		expect(data.metadata.layout.pages[0]?.main).toEqual([
			"summary",
			"experience",
			"education",
			"skills",
			"languages",
			"certifications",
		]);
	});
});

describe("parseResumeText edge cases", () => {
	it("reads a comma-formatted name before location detection", () => {
		const imported = parseResumeText("Smith, John\nSenior Engineer\n");
		expect(imported.basics.name).toBe("Smith, John");
		expect(imported.basics.location).toBe("");
	});

	it("removes a separate visa sponsorship tail from an imported location", () => {
		const imported = parseResumeText("Jane Doe\nRiyadh, Saudi Arabia, visa sponsorship\n");
		expect(imported.basics.location).toBe("Riyadh, Saudi Arabia");
	});

	it("identifies an uncertain experience location by section and entry", () => {
		const issues: unknown[] = [];
		parseResumeText("EXPERIENCE\nExample Labs | Engineer | Mystery City, Very Unclear Extra Name\n• Built a service.", {
			onUncertain: (issue) => issues.push(issue),
		});
		expect(issues).toContainEqual({
			field: "location",
			source: "Mystery City, Very Unclear Extra Name",
			section: "experience",
			entryIndex: 0,
		});
	});

	it("keeps experience issue indexes stable across repeated sections", () => {
		const issues: unknown[] = [];
		parseResumeText(
			"EXPERIENCE\nFirst Labs | Engineer | Cairo\nEXPERIENCE\nSecond Labs | Engineer | Mystery City, Very Unclear Extra Name",
			{ onUncertain: (issue) => issues.push(issue) },
		);
		expect(issues).toContainEqual({
			field: "location",
			source: "Mystery City, Very Unclear Extra Name",
			section: "experience",
			entryIndex: 1,
		});
	});

	it("returns usable data for empty input", () => {
		const data = parseResumeText("");
		expect(() => resumeDataSchema.parse(data)).not.toThrow();
		expect(data.basics.name).toBe("");
		expect(data.metadata.layout.pages[0]?.main).toEqual([]);
	});

	it("does not mistake a date range for a phone number", () => {
		const data = parseResumeText("Ada Lovelace\nBerlin\n2016 - 2019\n");
		expect(data.basics.phone).toBe("");
	});

	it("keeps an unrecognized heading as a custom section", () => {
		const data = parseResumeText("Ada\n\nSKILLS\nRust\n\nSPEAKING\nGave a talk at a conference\n");
		expect(data.customSections).toHaveLength(1);
		expect(data.customSections[0]).toMatchObject({ type: "summary", title: "SPEAKING" });
		expect(data.metadata.layout.pages[0]?.main).toContain(data.customSections[0]?.id);
	});

	it("keeps unclassified header parts in the description rather than dropping them", () => {
		const data = parseResumeText("EXPERIENCE\nAcme  Engineer  Berlin  Remote  Contract\n2020 - 2022\n");
		expect(data.sections.experience.items[0]?.location).toBe("Berlin · Remote");
		expect(data.sections.experience.items[0]?.description).toContain("Contract");
	});

	it("escapes markup found in the source text", () => {
		const data = parseResumeText("SUMMARY\nI write <script>alert(1)</script> safely\n");
		expect(data.summary.content).toContain("&lt;script&gt;");
		expect(data.summary.content).not.toContain("<script>");
	});

	it("treats a heading with a trailing colon as a heading", () => {
		const data = parseResumeText("Ada\n\nSkills:\nRust, Go\n");
		expect(data.sections.skills.items.map((item) => item.name)).toEqual(["Rust", "Go"]);
	});
});

describe("parseResumeText multi-line entry preambles", () => {
	it("keeps an uppercase company followed by a separate role line as one entry", () => {
		const data = parseResumeText(
			"EXPERIENCE\nACME CORPORATION\nSenior Engineer\nJan 2020 - Present\n• Led the rewrite\n",
		);

		expect(data.customSections).toHaveLength(0);
		expect(data.sections.experience.items).toHaveLength(1);
		expect(data.sections.experience.items[0]).toMatchObject({
			company: "ACME CORPORATION",
			position: "Senior Engineer",
			period: "Jan 2020 – Present",
		});
	});

	it("still recognizes a real heading whose section starts with bullets", () => {
		const data = parseResumeText("Ada\nada@example.com\n\nCAREER HIGHLIGHTS\n• Shipped in 2019\n• Grew the team\n");

		expect(data.customSections).toHaveLength(1);
		expect(data.customSections[0]).toMatchObject({ title: "CAREER HIGHLIGHTS" });
	});
});

describe("parseResumeText four-line entry preambles", () => {
	it("keeps company, role, location and dates as one entry", () => {
		const data = parseResumeText(
			"EXPERIENCE\nACME CORPORATION\nSenior Engineer\nBerlin, Germany\nJan 2020 - Present\n• Led the rewrite\n",
		);

		expect(data.customSections).toHaveLength(0);
		expect(data.sections.experience.items).toHaveLength(1);
		expect(data.sections.experience.items[0]).toMatchObject({
			company: "ACME CORPORATION",
			position: "Senior Engineer",
			location: "Berlin, Germany",
			period: "Jan 2020 – Present",
		});
	});
});

describe("parseResumeText keeps content the layout hides", () => {
	it("recognizes isolated title-case custom section headings", () => {
		const initial = parseResumeText(
			"Ada Lovelace\nada@example.com\n\nConferences\nReactConf\nBerlin\n2021\nSpoke about parsers\n",
		);
		const subsequent = parseResumeText(
			"Ada Lovelace\nada@example.com\n\nEXPERIENCE\nAcme  Engineer\n2020 - 2022\nBuilt products.\n\nConferences\nReactConf\nBerlin\n2021\nSpoke about parsers\n",
		);

		expect(initial.customSections[0]).toMatchObject({ title: "Conferences" });
		expect(subsequent.customSections[0]).toMatchObject({ title: "Conferences" });
		expect(subsequent.sections.experience.items).toHaveLength(1);
	});

	it("keeps a dated custom section that opens the body", () => {
		const data = parseResumeText(
			"Ada Lovelace\nada@example.com\n\nCONFERENCES\nReactConf\nBerlin\n2021\nSpoke about parsers\n",
		);

		expect(data.basics.headline).not.toBe("CONFERENCES");
		expect(data.customSections).toHaveLength(1);
		expect(data.customSections[0]).toMatchObject({ title: "CONFERENCES" });

		const content = data.customSections[0]?.items[0]?.content ?? "";
		for (const line of ["ReactConf", "Berlin", "2021", "Spoke about parsers"]) {
			expect(content).toContain(line);
		}
	});

	it("keeps unbulleted descriptions with their own role", () => {
		const data = parseResumeText(
			"EXPERIENCE\nAcme  Engineer  Berlin\nJan 2020 - Present\nBuilt the thing end to end.\nWorked with a team of five.\nBabbage Ltd  Engineer  London\nMar 2016 - Dec 2019\nDid other work.\n",
		);

		expect(data.sections.experience.items).toHaveLength(2);
		expect(data.sections.experience.items[0]?.description).toContain("Built the thing end to end.");
		expect(data.sections.experience.items[0]?.description).toContain("Worked with a team of five.");
		expect(data.sections.experience.items[1]).toMatchObject({ company: "Babbage Ltd", location: "London" });
	});

	it("does not split an entry on a bare year in a section that ignores single dates", () => {
		const data = parseResumeText(
			"EXPERIENCE\nAcme  Engineer\nJan 2020 - Present\nGrew the team.\nMore work here.\n2022\n",
		);

		expect(data.sections.experience.items).toHaveLength(1);

		const description = data.sections.experience.items[0]?.description ?? "";
		for (const line of ["Grew the team.", "More work here.", "2022"]) {
			expect(description).toContain(line);
		}
	});

	it("stays schema-valid when a section starts with its dates", () => {
		const data = parseResumeText(
			"EXPERIENCE\nJan 2020 - Present\nAcme Corp\nSenior Engineer\n\nEDUCATION\n2012 - 2016\nUniversity of London\n\nCERTIFICATIONS\n2021\n",
		);

		expect(() => resumeDataSchema.parse(data)).not.toThrow();
		expect(data.sections.experience.items[0]).toMatchObject({ company: "Acme Corp", period: "Jan 2020 – Present" });
		expect(data.sections.education.items[0]).toMatchObject({ school: "University of London" });
		expect(data.sections.certifications.items).toHaveLength(0);
	});
});

it.each(["٢٠٢٠ - ٢٠٢٢", "۲۰۲۰ - ۲۰۲۲", "2020 - حتى الآن"])(
	"imports Arabic facts and period %s with Western-digit import normalization",
	(period) => {
		const data = parseResumeText(
			`أحمد العتيبي\n+٩٦٦ ٥٠ ١٢٣ ٤٥٦٧\n\nالخِبْـرَة العَمَلِيَّة\nشركة الأفق | مهندس برمجيات | الرياض\n${period}\n• طورت نظام المدفوعات\nالتعليم\nجامعة الملك سعود | علوم الحاسب\n2016 - 2020\nالمهارات\nTypeScript`,
			{ locale: "ar-SA" },
		);
		expect(data.basics.name).toBe("أحمد العتيبي");
		expect(data.basics.phone).toBe("+966 50 123 4567");
		expect(data.basics.headline).not.toContain("٩٦٦");
		expect(data.sections.experience.items).toHaveLength(1);
		expect(data.sections.experience.items[0]).toMatchObject({
			company: "شركة الأفق",
			position: "مهندس برمجيات",
			dates: { start: "2020", end: period.includes("الآن") ? null : "2022", present: period.includes("الآن") },
		});
		expect(data.sections.education.items[0]?.school).toBe("جامعة الملك سعود");
		expect(data.sections.skills.items[0]?.name).toBe("TypeScript");
	},
);
it("recognizes Arabic aliases with omitted source locale and Persian contact digits", () => {
	const data = parseResumeText("ليلى\n+۹۶۶ ۵۰ ۱۲۳ ۴۵۶۷\nالخبرة العملية\nشركة ألف | مديرة\n2020 - 2022");
	expect(data.basics.phone).toBe("+966 50 123 4567");
	expect(data.sections.experience.items[0]?.company).toBe("شركة ألف");
});
it("keeps Arabic role heads and punctuated titles out of experience descriptions", () => {
	const positions = [
		"مدير عمليات المنتجات",
		"مدير عمليات",
		"مدير برامج",
		"مدير مشاريع",
		"قائد فريق",
		"محلل أول",
		"محلل عمليات",
		"منسق عمليات",
		"(قائد فريق)",
		"قائد-فريق",
		"مشرف عمليات",
		"رئيسة التحرير",
	];
	const issues: unknown[] = [];
	const headers = positions.map((position) => `شركة المثال | ${position} | 2020 - 2022\n• طورت إجراءات العمل`);
	const data = parseResumeText(`أحمد\nالخبرة\n${headers.join("\n")}`, {
		locale: "ar-SA",
		onUncertain: (issue) => issues.push(issue),
	});
	const items = data.sections.experience.items;
	expect(items.map(({ position }) => position)).toEqual(positions);
	expect(issues).toEqual([]);
	for (const { position, description } of items) expect(description).not.toContain(position);
});

it.each(["مسير إنتاج", "مراقبة الجودة الصناعية", "Scrum Master", "Site Supervisor", "Product Steward"])(
	"keeps %s as a position in a two-part dated header",
	(position) => {
		const issues: unknown[] = [];
		const data = parseResumeText(
			`Sara Example\nEXPERIENCE\nExample Labs | ${position}\n2020 - 2022\n• Planned releases.`,
			{
				onUncertain: (issue) => issues.push(issue),
			},
		);
		expect(data.sections.experience.items).toMatchObject([{ position, description: "<p>Planned releases.</p>" }]);
		expect(issues).toEqual(
			["مسير إنتاج", "Product Steward"].includes(position)
				? [{ field: "position", source: position, section: "experience", entryIndex: 0 }]
				: [],
		);
	},
);
it("decodes Arabic presentation forms without folding hamza", () => {
	const data = parseResumeText(
		"أﺣﻤﺪ اﻟﻌﺘﻴﺒﻲ\nsynthetic@example.test\nاﻟﺨﺒﺮة اﻟﻌﻤﻠﻴﺔ\nﺷﺮﻛﺔ اﻷﻓﻖ | ﻣﻬﻨﺪس ﺑﺮﻣﺠﻴﺎت\n2020 - 2022",
		{ locale: "ar-SA" },
	);
	expect(data.basics.name).toBe("أحمد العتيبي");
	expect(data.sections.experience.items[0]).toMatchObject({ company: "شركة الأفق", position: "مهندس برمجيات" });
});
it.each([
	["١٤٤٥ هـ - ١٤٤٦ هـ", "1445 هـ - 1446 هـ"],
	["٠١/٠٢/٢٠٢٤", "01/02/2024"],
])("keeps explicitly uncertain date evidence in editable raw dates: %s", (period, normalized) => {
	const data = parseResumeText(`أحمد\na@example.test\nالخبرة العملية\nشركة ألف | مهندس\n${period}`, {
		locale: "ar-SA",
	});
	expect(data.sections.experience.items[0]?.dates?.raw).toBe(normalized);
	expect(resumeDataSchema.parse(data).basics.name).toBe("أحمد");
});

it("D33 normalizes extracted PDF/plain text digits and marks before recognizing fields", () => {
	const source = "أَحْمَدُ\na@example.test\n+٩٦٦ ۵۰ ١٢٣ ۴۵۶۷\n\nالمُلَخَّص\nحَقَّقْتُ ١٢ و۳۴ ـٰ\n\nالخبرة\nشَرِكَةٌ | مُهَنْدِسٌ\n٢٠١٥ - ۲۰۱۷";
	const data = parseResumeText(source, { locale: "ar-SA" });
	expect(data.basics.name).toBe("أحمد");
	expect(data.basics.phone).toBe("+966 50 123 4567");
	expect(data.summary.content).toContain("حققت 12 و34 ـ");
	expect(data.sections.experience.items[0]).toMatchObject({
		company: "شركة",
		position: "مهندس",
		period: "2015 – 2017",
	});
	expect(JSON.stringify(data)).not.toMatch(/[٠-٩۰-۹\u064B-\u0652\u0670]/u);
});

it("maps the Arabic links heading into profiles", () => {
	const data = parseResumeText("أحمد\na@example.test\nالروابط\nGitHub | https://github.com/example\nالمهارات\nPython", {
		locale: "ar-SA",
	});
	expect(data.sections.profiles.items).toMatchObject([
		{ network: "GitHub", website: { url: "https://github.com/example" } },
	]);
});
it("keeps uppercase employers in experience when entry lookahead has Arabic month dates", () => {
	const data = parseResumeText(
		"أحمد\na@example.test\nالخبرة\nACME\nمهندس برمجيات\nيناير ٢٠٢٠ - مارس ٢٠٢٢\n• تطوير الأنظمة",
		{ locale: "ar-SA" },
	);
	expect(data.sections.experience.items).toMatchObject([
		{ company: "ACME", position: "مهندس برمجيات", dates: { start: "2020-01", end: "2022-03" } },
	]);
	expect(data.customSections).toHaveLength(0);
});

it.each(["\n", " ", "  ", "\t"])("stops phone extraction before a digit-leading email after %j", (separator) => {
	const data = parseResumeText(`Sara Example\n+20 106 449 4638${separator}2sayed.5ashraf@example.test`);
	expect(data.basics.phone).toBe("+20 106 449 4638");
	expect(data.basics.email).toBe("2sayed.5ashraf@example.test");
});
it("does not consume a digit-leading URL token as part of a phone", () => {
	const data = parseResumeText("Sara Example\n+20 106 449 4638 2example.test/profile");
	expect(data.basics.phone).toBe("+20 106 449 4638");
});

it.each(["Acme, Software Engineer, London", "Software Engineer, Acme, London", "شركة ألف، مهندس برمجيات، الرياض"])(
	"recognizes the role segment in comma-separated experience headers: %s",
	(header) => {
		const arabic = header.startsWith("شركة");
		const data = parseResumeText(`Sara Example\nEXPERIENCE\n${header}\n2020 - 2024`, {
			locale: arabic ? "ar-SA" : "en-US",
		});
		expect(data.sections.experience.items[0]).toMatchObject({
			company: arabic ? "شركة ألف" : "Acme",
			position: arabic ? "مهندس برمجيات" : "Software Engineer",
			location: arabic ? "الرياض" : "London",
		});
	},
);

describe("shared employer boundaries", () => {
	it.each([
		["Other Co | Backend Developer | Berlin", "Other Co", "Backend Developer"],
		["Backend Developer | Northwind | Berlin", "Northwind", "Backend Developer"],
		["Backend Developer at Northwind | Berlin", "Northwind", "Backend Developer"],
	])("keeps a complete following job independent: %s", (header, company, position) => {
		const data = parseResumeText(
			`Ada Lovelace\nada@example.com\n\nEXPERIENCE\nAcme Labs | London | 2020 - 2024\nSenior Engineer | 2022 - 2024\n• Built parsers\n${header} | 2018 - 2020\n• Built APIs`,
		);
		expect(
			data.sections.experience.items.map(({ company, position, location }) => ({ company, position, location })),
		).toEqual([
			{ company: "Acme Labs", position: "Senior Engineer", location: "London" },
			{ company, position, location: "Berlin" },
		]);
	});
	it("keeps a standalone employer before a complete job", () => {
		const data = parseResumeText(
			"Ada Lovelace\nada@example.com\n\nEXPERIENCE\nAcme Labs | London | 2020 - 2024\n• Won an award\nOther Co | Backend Developer | Berlin | 2018 - 2020\n• Built APIs",
		);
		expect(data.sections.experience.items).toHaveLength(2);
		expect(data.sections.experience.items[0]).toMatchObject({ company: "Acme Labs", location: "London" });
		expect(data.sections.experience.items[0]?.description).toContain("Won an award");
		expect(data.sections.experience.items[1]).toMatchObject({
			company: "Other Co",
			position: "Backend Developer",
			location: "Berlin",
		});
	});
	it.each(["", "• Won an employer award."])("preserves employer context and body: %s", (body) => {
		const data = parseResumeText(
			`Ada Lovelace\nada@example.com\n\nEXPERIENCE\nAcme Labs | London | 2020 - 2024\n${body}\nSenior Engineer | 2022 - 2024\n• Built parsers\nDeveloper | 2020 - 2022\n• Built APIs`,
		);
		const entries = data.sections.experience.items;
		expect(entries).toHaveLength(2);
		expect(entries.map(({ company, location }) => ({ company, location }))).toEqual([
			{ company: "Acme Labs", location: "London" },
			{ company: "Acme Labs", location: "London" },
		]);
		if (body) expect(entries[0]?.description).toContain("Won an employer award.");
		expect(entries[0]?.description).toContain("Built parsers");
		expect(entries[1]?.description).toContain("Built APIs");
	});
});
it("preserves an unlabelled location after a labelled name", () => {
	const data = parseResumeText("Name: Jane Doe\nBerlin, Germany\nSenior Engineer\njane@example.test");
	expect(data.basics).toMatchObject({ name: "Jane Doe", location: "Berlin, Germany", headline: "Senior Engineer" });
});
it("retains a custom section with short non-location columns after contacts", () => {
	const data = parseResumeText(
		"Ada Lovelace\nada@example.com\n\nCONFERENCES\nReactConf  Speaker\n2021\nSpoke about parsers",
	);
	expect(data.basics).toMatchObject({ name: "Ada Lovelace", email: "ada@example.com" });
	expect(JSON.stringify(data.customSections)).toContain("ReactConf");
	expect(JSON.stringify(data.customSections)).toContain("Spoke about parsers");
});

it("preserves English and Arabic summary line breaks without PDF layout evidence", () => {
	const english = parseResumeText(
		[
			"Sayed Ashraf",
			"Software Engineer",
			"Summary",
			"Software Engineer building web applications with Node.js, TypeScript, PostgreSQL, and React, using Codex daily for AI-",
			"assisted development. At BandAI, as a Senior Software Engineer, built an AI gateway that reduced costs, along with a",
			"Salla app and Chrome extension to help merchants review and improve store policies.",
		].join("\n"),
	);
	expect(english.summary.content).toBe(
		"<p>Software Engineer building web applications with Node.js, TypeScript, PostgreSQL, and React, using Codex daily for AI-</p><p>assisted development. At BandAI, as a Senior Software Engineer, built an AI gateway that reduced costs, along with a</p><p>Salla app and Chrome extension to help merchants review and improve store policies.</p>",
	);

	const arabic = parseResumeText(
		[
			"نواف السهلي",
			"مدير عمليات المنتجات وتحسين الخدمات",
			"الملخص المهني",
			"مدير عمليات المنتجات وتحسين الخدمات بخبرة 20 عاما في تنسيق العمليات وقيادة برامج التحسين، ومهارات في التدريب وإدارة",
			"التغيير وتحليل المتطلبات. طور تقارير الجودة الأسبوعية وخفض وقت إعدادها بنسبة 16%. خفض زمن إعداد التقارير بنسبة 22%",
			"عبر توحيد متطلبات البيانات ومعايير المراجعة.",
		].join("\n"),
		{ locale: "ar-SA" },
	);
	expect(arabic.summary.content).toBe(
		"<p>مدير عمليات المنتجات وتحسين الخدمات بخبرة 20 عاما في تنسيق العمليات وقيادة برامج التحسين، ومهارات في التدريب وإدارة</p><p>التغيير وتحليل المتطلبات. طور تقارير الجودة الأسبوعية وخفض وقت إعدادها بنسبة 16%. خفض زمن إعداد التقارير بنسبة 22%</p><p>عبر توحيد متطلبات البيانات ومعايير المراجعة.</p>",
	);
});
it("preserves consecutive summary bullets and neighboring prose as different blocks", () => {
	const result = parseResumeText(
		"Ada Example\nSummary\nBuilt secure services\nfor release reviews.\n• Measured latency\n• Kept C++ support\n\nMaintained the release notes.",
	);
	expect(result.summary.content).toBe(
		"<p>Built secure services</p><p>for release reviews.</p><ul><li>Measured latency</li><li>Kept C++ support</li></ul><p>Maintained the release notes.</p>",
	);
});

it("keeps separated and indented Arabic fluency with its language", () => {
	const data = parseResumeText("اللغات\nالعربية  اللغة الأم\nالإنجليزية\n  إجادة مهنية", { locale: "ar-SA" });
	expect(data.sections.languages.items.map(({ language, fluency }) => ({ language, fluency }))).toEqual([
		{ language: "العربية", fluency: "اللغة الأم" },
		{ language: "الإنجليزية", fluency: "إجادة مهنية" },
	]);
});

it("keeps labeled and nested Arabic skill groups with their keywords", () => {
	const data = parseResumeText("المهارات\nهندسة البرمجيات: TypeScript، React\nالبيانات\n  • SQL\n  • PostgreSQL\nGit", {
		locale: "ar-SA",
	});
	expect(data.sections.skills.items.map(({ name, keywords }) => ({ name, keywords }))).toEqual([
		{ name: "هندسة البرمجيات", keywords: ["TypeScript", "React"] },
		{ name: "البيانات", keywords: ["SQL", "PostgreSQL"] },
		{ name: "Git", keywords: [] },
	]);
});
