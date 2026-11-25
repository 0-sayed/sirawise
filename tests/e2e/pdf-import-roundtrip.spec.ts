import type { ImportReviewIssue } from "@reactive-resume/import/plain-text";
import type { ResumeData } from "@reactive-resume/schema/resume/data";
import { openPdfReview } from "./fixtures/import-review";
import { scenarios, work, wrappedWork } from "./fixtures/pdf-import-roundtrip";
import { renderPdf } from "./fixtures/render-import-pdf";
import { seedReviewBudget } from "./fixtures/reviewable-ai";
import { expect, test } from "./fixtures/test";

const languages = (data: ResumeData) =>
	data.sections.languages.items.map(({ language, fluency }) => ({ language, fluency }));
const skills = (data: ResumeData) => data.sections.skills.items.map(({ name, keywords }) => ({ name, keywords }));
const education = (data: ResumeData) =>
	data.sections.education.items.map(({ school, degree, area, location, dates }) => ({
		school,
		degree,
		area,
		location,
		dates,
	}));

for (const scenario of scenarios)
	for (const ui of ["ar-SA", "en-US"] as const)
		for (const width of scenario.name === "English" ? [ui === "ar-SA" ? 390 : 1440] : [390, 1440]) {
			test(`${scenario.name} PDF round-trips in ${ui} at ${width}`, async ({ authPage: page, baseURL }) => {
				test.setTimeout(90_000);
				await page.setViewportSize({ width, height: 900 });
				if (!baseURL) throw new Error("Missing browser base URL");
				await page.context().addCookies([{ name: "locale", value: ui, url: baseURL }]);
				const filename = scenario.name + ".pdf";
				const buffer = await renderPdf(scenario.name);
				expect(buffer.subarray(0, 5).toString("ascii")).toBe("%PDF-");
				const documentLocale = scenario.name === "English" ? "en-US" : "ar-SA";
				await openPdfReview(page, ui, documentLocale, { name: filename, mimeType: "application/pdf", buffer });
				await expect(page.locator("html")).toHaveAttribute("lang", ui);
				const { initial, issues, pages } = await page.evaluate(async () => {
					const flow = location.pathname.split("/").at(-1);
					const db = await new Promise<IDBDatabase>((resolve, reject) => {
						const request = indexedDB.open("master-cv-import-review", 1);
						request.onsuccess = () => resolve(request.result);
						request.onerror = () => reject(request.error);
					});
					try {
						return await new Promise<{ initial: ResumeData; issues: ImportReviewIssue[]; pages: { text: string }[] }>(
							(resolve, reject) => {
								const request = db.transaction("drafts").objectStore("drafts").getAll();
								request.onsuccess = () => {
									const draft = request.result.find((record) => record.flowId === flow);
									if (!draft) return reject(new Error("Missing import draft"));
									resolve({ initial: draft.initial, issues: draft.issues, pages: draft.pages });
								};
								request.onerror = () => reject(request.error);
							},
						);
					} finally {
						db.close();
					}
				});
				expect(pages).toHaveLength(scenario.pages);
				const source = pages.map(({ text }) => text).join("\n");
				expect(initial.metadata.page.locale).toBe(documentLocale);
				const expectedEducation = education(scenario.data).map((entry) =>
					entry.school === "Ain Shams University"
						? {
								...entry,
								degree: "درجة البكالوريوس",
								area: "علوم الحاسب",
								dates: { start: "2020", end: null, present: false },
							}
						: entry,
				);
				expect(education(initial)).toEqual(expectedEducation);
				expect(initial.sections.experience.items).toHaveLength(scenario.experience);
				const positions = scenario.data.sections.experience.items.map(({ position }) => position);
				const employers = (data: ResumeData) =>
					data.sections.experience.items.map(({ company, location }) => ({ company, location }));
				expect(employers(initial)).toEqual(employers(scenario.data));
				if (documentLocale === "ar-SA") {
					expect(languages(initial)).toEqual(languages(scenario.data));
					expect(skills(initial)).toEqual(skills(scenario.data));
				}
				if (scenario.name === "Arabic Long")
					expect(initial.sections.experience.items[2]?.description).toContain(wrappedWork + "</p>");
				expect(initial.sections.experience.items.map(({ position }) => position)).toEqual(positions);
				expect(initial.sections.projects.items.map(({ name }) => name)).toEqual(scenario.projects);
				expect(initial.sections.experience.items.map(({ dates }) => [dates?.start, dates?.end])).toEqual(
					scenario.data.sections.experience.items.map(({ dates }) => [dates?.start, dates?.end]),
				);
				const monthIntervals = [...source.matchAll(/(\d{2}\/\d{4})\s*[-–]\s*(\d{2}\/\d{4})/gu)];
				if (documentLocale === "ar-SA") expect(monthIntervals.length).toBeGreaterThan(0);
				for (const [, start, end] of monthIntervals) {
					const monthKey = (date: string) => date.slice(3) + date.slice(0, 2);
					expect(monthKey(start ?? "") <= monthKey(end ?? "")).toBe(true);
				}
				if (scenario.name === "Arabic") {
					expect(issues).toEqual([]);
					for (const percentage of [22, 21, 20, 19, 18, 17]) expect(source).toContain(percentage + "%");
					expect(source).not.toMatch(/(?:^|\s)%\d/u);
					expect(initial.sections.experience.items[0]?.description).toContain(
						"خفض زمن إعداد التقارير بنسبة 22% عبر توحيد متطلبات البيانات ومعايير المراجعة.",
					);
				} else {
					const language = documentLocale === "ar-SA" ? "ar" : "en";
					expect(initial.sections.experience.items[1]?.description).toContain(work[language][1]);
					if (language === "ar") {
						expect(source).toContain("بيئة");
						expect(initial.sections.experience.items[2]?.description).toContain("لبيئة الإنتاج");
						expect(initial.summary.content).toContain("Salla وإضافة");
					}
				}
				const ar = ui === "ar-SA";
				const reviewedArabic = scenario.name === "Arabic";
				const reviewedLong = scenario.name === "Arabic Long";
				if (reviewedArabic || reviewedLong) {
					await seedReviewBudget();
					await page
						.getByRole("button", { name: ar ? "فتح المساعدة في النص" : "Open text assistance", exact: true })
						.click();
					await page
						.getByRole("combobox", { name: ar ? "القسم المطلوب مراجعته" : "Section to review", exact: true })
						.selectOption("experience");
					const field = page.getByRole("textbox", {
						name: ar
							? "النص المستخرج مباشرة — حدد المقطع غير المؤكد"
							: "Native extracted text — select the uncertain passage",
					});
					await field.evaluate(
						(element: HTMLTextAreaElement, { longCv, omitEmployer }) => {
							if (longCv) {
								const employer = element.value.indexOf("BandAI Saudi Arabia · Remote");
								const role = element.value.indexOf("مهندس برمجيات أول", employer);
								const end = element.value.indexOf("حتى الآن", role);
								if (employer < 0 || role <= employer || end <= role)
									throw new Error("Missing the current role and date");
								element.focus();
								element.setSelectionRange(omitEmployer ? role : employer, end + "حتى الآن".length);
								return;
							}
							const start = element.value.indexOf("استوديو جسر الغد الرياض");
							const second = element.value.indexOf("شركة مرسى الأفكار", start);
							const clipped = element.value.indexOf("المتابعة والتسل", second);
							if (start < 0 || second <= start || clipped <= second)
								throw new Error("Missing the selection across two roles");
							element.focus();
							element.setSelectionRange(start, clipped + "المتابعة والتسل".length);
						},
						{ longCv: reviewedLong, omitEmployer: !ar },
					);
					await field.dispatchEvent("keyup");
					await page
						.getByRole("button", { name: ar ? "مراجعة النص المحدد" : "Review selected text", exact: true })
						.click();
					await page
						.getByRole("dialog")
						.getByRole("button", { name: ar ? "بدء المراجعة" : "Start review", exact: true })
						.click();
					if (reviewedArabic)
						await expect(page.getByText(/^قاد تنسيق العمليات.*المتابعة والتسل$/u)).toBeVisible({ timeout: 25_000 });
					else {
						await expect(page.getByText("مهندس برمجيات أول", { exact: true }).last()).toBeVisible({ timeout: 25_000 });
						if (!ar)
							await expect(page.getByText("1 item was withheld because it could not be verified.")).toBeVisible();
					}
					await expect(page.getByText(ar ? "تجريبي" : "Beta", { exact: true })).toHaveCount(2);
					const useAll = page.getByRole("button", {
						name: ar ? "استخدام الكل في المسودة" : "Use all in draft",
						exact: true,
					});
					await useAll.click({ timeout: 25_000 });
					await expect(useAll).toBeDisabled();
					if (reviewedLong && ar) {
						await expect(
							page.getByText("تم الإبقاء على الحقل الأصلي. راجع الاقتراح قبل التأكيد.", { exact: true }),
						).toHaveCount(2);
					}
					await expect(
						page.getByRole("button", { name: ar ? "إنشاء السيرة فقط" : "Create CV only", exact: true }),
					).toBeDisabled();
				}
				const confirmRemaining = page.getByRole("button", {
					name: ar ? "تأكيد بقية المعلومات" : "Confirm all remaining",
					exact: true,
				});
				await confirmRemaining.click();
				if (reviewedArabic || reviewedLong) {
					await page
						.getByRole("navigation", { name: ar ? "أقسام المراجعة" : "Review sections", exact: true })
						.getByRole("button", { name: ar ? "الخبرة" : "Experience", exact: true })
						.click();
					await expect(page.locator('[data-uncertain="true"]').first()).toBeVisible();
					expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
					await page.getByRole("button", { name: ar ? "تأكيد القسم" : "Confirm section", exact: true }).click();
				}
				await expect(confirmRemaining).toBeDisabled();
				await page
					.getByRole("button", {
						name: ar ? "إنشاء السيرة وحفظ المعلومات المهنية" : "Create CV and save career information",
						exact: true,
					})
					.click();
				await expect(page).toHaveURL(/\/builder\/[\w-]+/u);
				const id = new URL(page.url()).pathname.split("/").at(-1);
				await page.reload();
				const stored = await page.request.get("/api/openapi/resumes/" + id);
				expect(stored.ok()).toBe(true);
				const saved: ResumeData = (await stored.json()).data;
				expect(saved.metadata.page.locale).toBe(documentLocale);
				expect(education(saved)).toEqual(expectedEducation);
				expect(employers(saved)).toEqual(employers(scenario.data));
				if (documentLocale === "ar-SA") {
					expect(languages(saved)).toEqual(languages(scenario.data));
					expect(skills(saved)).toEqual(skills(scenario.data));
				}
				if (reviewedLong) expect(saved.sections.experience.items[2]?.description).toContain(wrappedWork + "</p>");
				expect(saved.summary.content).toBe(initial.summary.content);
				const experience = (data: ResumeData) =>
					data.sections.experience.items.map(({ company, position, dates, description }) => ({
						company,
						position,
						dates,
						description,
					}));
				const expectedExperience = experience(initial);
				if (reviewedArabic) {
					for (const { position, description } of saved.sections.experience.items)
						expect(description).not.toContain(position);
					expect(saved.sections.experience.items[0]?.location).toBe("الرياض");
					const first = expectedExperience[0];
					const second = expectedExperience[1];
					if (!first || !second) throw new Error("Missing imported roles");
					first.company = "استوديو جسر الغد";
					second.company = "شركة مرسى الأفكار";
					expect(saved.sections.experience.items[1]?.location).toBe("الرياض");
					expect(saved.sections.experience.items[1]?.description).toContain("المتابعة والتسليم.");
					expect(saved.sections.experience.items[1]?.description).toContain("خفض زمن إعداد تقارير الجودة بنسبة 21%");
				}
				if (reviewedLong && ar) {
					const first = expectedExperience[0];
					if (!first) throw new Error("Missing imported current role");
					first.company = "BandAI";
					expect(saved.sections.experience.items[0]?.location).toBe("Saudi Arabia · Remote");
				}
				expect(experience(saved)).toEqual(expectedExperience);
				expect(saved.sections.experience.items.map(({ position }) => position)).toEqual(positions);
				expect(
					new Set(
						saved.sections.experience.items.map(({ company, position, dates }) =>
							JSON.stringify([company, position, dates?.start, dates?.end, dates?.present]),
						),
					).size,
				).toBe(scenario.experience);
				expect(saved.sections.projects.items.map(({ name }) => name)).toEqual(scenario.projects);
			});
		}
