import type { ResumeData } from "@reactive-resume/schema/resume/data";
import { defaultResumeData } from "@reactive-resume/schema/resume/default";
import { demoShowcaseResumes } from "../../../tooling/local/demo-showcase";

const arabic = demoShowcaseResumes[1].data;
const intervals = [
	["2026-07", null],
	["2026-04", "2026-07"],
	["2024-03", "2026-04"],
	["2021-11", "2023-03"],
] as const;
const companies = ["BandAI", "Inframodern", "Inframodern", "Example Systems"];
const projectTitles = ["Dark Factory", "Auto PR", "Hena Wadeena", "Lyrebird"];
const projects = {
	en: [...projectTitles, "Traffic Sign Detection and Recognition"],
	ar: [...projectTitles, "اكتشاف إشارات المرور والتعرف عليها"],
};
export const wrappedWork =
	"قدم أعمال تطوير ميزات متكاملة عبر الواجهة الخلفية ولوحات الإدارة وتطبيق نقاط البيع لصالح Inframodern المنتجات باستخدام Node.js وNestJS وFastify وDrizzle وPrisma وPostgreSQL وReact وTypeScript.";

export const work = {
	en: [
		"Reduced AI costs by building a gateway that routes requests through a Codex subscription and also supports direct AI API calls.",
		"Built Dark Factory, an internal autonomous system that orchestrates multiple Codex sessions through Agent Orchestrator and Archon workflows to implement tasks in parallel, from planning through review and merge.",
		"Delivered full-stack feature work across backend, admin panels, and the POS application for Inframodern products using Node.js, NestJS, Fastify, Drizzle, Prisma, PostgreSQL, React, and TypeScript.",
		"Migrated and refactored a .NET MVC data-viewing web application to .NET Core 3.1.",
	],
	ar: [
		"خفضت تكاليف الذكاء الاصطناعي من خلال بناء بوابة توجه الطلبات عبر اشتراك Codex، وتدعم أيضا استدعاء واجهات برمجة تطبيقات الذكاء الاصطناعي مباشرة.",
		"أنشأت Dark Factory، وهو نظام داخلي مستقل ينسق جلسات Codex متعددة عبر سير عمل Agent Orchestrator وArchon لتنفيذ المهام بالتوازي، بدءا من التخطيط وصولا إلى المراجعة والدمج.",
		"عززت جاهزية الواجهة الخلفية لبيئة الإنتاج من حيث الموثوقية وقابلية الرصد.",
		"نقلت تطبيق ويب لعرض البيانات، مبنيا باستخدام .NET MVC، وأعدت هيكلته إلى .NET Core 3.1.",
	],
} as const;

function engineeringResume(language: "en" | "ar"): ResumeData {
	const rtl = language === "ar";
	const data = structuredClone(defaultResumeData);
	data.basics.name = "Example Engineer";
	data.basics.headline = rtl ? "مهندس برمجيات" : "Software Engineer";
	data.basics.location = "Cairo, Egypt";
	data.basics.email = "engineer@example.test";
	data.picture.hidden = true;
	data.metadata.template = "onyx";
	data.metadata.page.locale = rtl ? "ar-SA" : "en-US";
	data.metadata.page.dateFormat = rtl ? "numeric" : "short";
	data.metadata.page.marginX = 14;
	data.metadata.page.marginY = 14;
	data.metadata.typography.body.fontSize = 10;
	data.metadata.typography.body.lineHeight = 1.5;
	data.metadata.layout.pages = [
		{ fullWidth: true, main: ["summary", "experience"], sidebar: [] },
		{ fullWidth: true, main: ["projects"], sidebar: [] },
		{ fullWidth: true, main: rtl ? ["education", "skills", "languages"] : ["education"], sidebar: [] },
	];
	data.summary.content = rtl
		? "<p>مهندس برمجيات يطور تطبيقات ويب باستخدام Node.js وTypeScript وPostgreSQL وReact، ويستخدم Codex يوميا في التطوير المدعوم بالذكاء الاصطناعي. في BandAI، وبصفته مهندس برمجيات أول، بنى بوابة للذكاء الاصطناعي خفضت التكاليف، إلى جانب تطبيق لـ Salla وإضافة لمتصفح Chrome لمساعدة التجار على مراجعة سياسات متاجرهم وتحسينها.</p>"
		: "<p>Software Engineer building web applications with Node.js, TypeScript, PostgreSQL, and React, using Codex daily for AI-assisted development.</p>";
	data.sections.experience.items = intervals.map(([start, end], index) => ({
		id: "experience-" + index,
		hidden: false,
		company: companies[index] ?? "",
		position: rtl
			? index < 2
				? "مهندس برمجيات أول"
				: "مطور Full Stack"
			: index < 2
				? "Senior Software Engineer"
				: "Full Stack Developer",
		location: index === 0 ? "Saudi Arabia · Remote" : "Cairo, Egypt",
		period: "",
		dates: { start, end, present: end === null },
		website: { url: "", label: "", inlineLink: false },
		description: "<p>" + (rtl && index === 2 ? wrappedWork + "</p><p>" : "") + work[language][index] + "</p>",
		roles: [],
	}));
	data.sections.projects.items = projects[language].map((name, index) => ({
		id: "project-" + index,
		hidden: false,
		name,
		period: "",
		...(index === 2 ? { dates: { start: "2026-03", end: "2026-04", present: false } } : {}),
		website: { url: "https://example.test/projects/" + index, label: "Repository", inlineLink: false },
		description: rtl
			? "<p>بنى فريق العمل منصة باستخدام أدوات مفتوحة المصدر وجهز بيئة تطوير معزولة للمراجعة والدمج.</p>"
			: "<p>Built a platform using open source tools and prepared an isolated development environment for testing.</p>",
	}));
	if (rtl) {
		data.sections.skills.items = structuredClone(arabic.sections.skills.items);
		data.sections.languages.items = structuredClone(arabic.sections.languages.items);
	}
	data.sections.education.items = [
		{
			id: "education-0",
			hidden: false,
			school: rtl ? "جامعة المثال" : "Example University",
			degree: rtl ? "بكالوريوس" : "Bachelor of Science",
			area: rtl ? "علوم الحاسب" : "Computer Science",
			grade: "",
			location: "",
			period: "",
			dates: { start: "2016", end: "2020", present: false },
			website: { url: "", label: "", inlineLink: false },
			description: "",
		},
	];
	if (rtl) {
		data.sections.education.items.push({
			id: "education-graduation-year",
			hidden: false,
			school: "Ain Shams University",
			degree: "2020",
			area: "درجة البكالوريوس في علوم الحاسب",
			grade: "",
			location: "",
			period: "",
			website: { url: "", label: "", inlineLink: false },
			description: "",
		});
	}
	return data;
}

export const scenarios = [
	{ name: "Arabic", data: arabic, pages: 2, experience: 8, projects: [] },
	{ name: "English", data: engineeringResume("en"), pages: 3, experience: 4, projects: projects.en },
	{ name: "Arabic Long", data: engineeringResume("ar"), pages: 3, experience: 4, projects: projects.ar },
] as const;
