import { resolve } from "node:path";
import { confirmPdfSections, openPdfReview } from "../fixtures/import-review";
import {
	captureReviewDirection,
	captureReviewFooter,
	expectReviewTextDirection,
	openWriting,
	seedReview,
	seedReviewBudget,
	startReview,
} from "../fixtures/reviewable-ai";
import { settleScreen } from "../fixtures/screen";
import { expect, test } from "../fixtures/test";

for (const locale of ["en-US", "ar-SA"] as const)
	for (const width of [1440, 390]) {
		test.describe(`${locale} at ${width}`, () => {
			test.use({ hasTouch: width === 390 });
			test(`review states ${locale} ${width}`, async ({ authPage: page }, testInfo) => {
				test.setTimeout(120_000);
				const ar = locale === "ar-SA";
				await page.setViewportSize({ width, height: 900 });
				const resumeId = await seedReview(page, testInfo, locale, ar ? "en-US" : "ar-SA");
				await openWriting(page, width);
				await startReview(page);
				const review = page.getByTestId("durable-review");
				const passage = review.locator('.review-wording p[dir="auto"]');
				const original = ar ? "Built services." : "بنيت خدمات.";
				const proposed = ar ? "Developed services." : "طورت خدمات.";
				const removed = passage.locator("bdi > del.diff-del");
				const added = passage.locator("bdi > ins.diff-ins");
				const changes = review.getByRole("radio", { name: ar ? "عرض التغييرات" : "Show changes", exact: true });
				const final = review.getByRole("radio", { name: ar ? "عرض النص النهائي" : "Show final", exact: true });
				const keep = review.getByRole("button", { name: ar ? "الإبقاء على الأصل" : "Keep original", exact: true });
				await expect(changes).toBeChecked();
				await expect(removed).toHaveText(ar ? "Built" : "بنيت");
				await expect(added).toHaveText(ar ? "Developed" : "طورت");
				await expectReviewTextDirection(passage, ar ? "ltr" : "rtl");
				await expect(review.getByText(ar ? "صياغة أوضح للنص الأصلي" : "Synthetic wording fixture")).toHaveCount(0);
				for (const colorScheme of ["light", "dark"] as const) {
					await page.emulateMedia({ colorScheme });
					await expect(page.locator("html")).toHaveClass(colorScheme === "dark" ? /\bdark\b/u : /^(?!.*\bdark\b)/u);
					await expect(removed).toHaveCSS("text-decoration-line", "line-through");
					await expect(added).toHaveCSS("text-decoration-line", "underline");
					await expect(added).toHaveCSS("text-decoration-style", "dotted");
					for (const [mark, token] of [
						[removed, "danger"],
						[added, "accent"],
					] as const) {
						expect(
							await mark.evaluate((el, role) => {
								const styles = getComputedStyle(el);
								return [styles.color, styles.backgroundColor].map((value, index) => {
									const probe = document.createElement("span");
									probe.style.color = `var(--${role}-${index === 0 ? "text" : "soft"})`;
									el.append(probe);
									const matches = getComputedStyle(probe).color === value;
									probe.remove();
									return matches;
								});
							}, token),
						).toEqual([true, true]);
					}
				}
				await page.emulateMedia({ colorScheme: "light" });
				if (width === 390) {
					for (const button of [
						review.getByRole("button", { name: ar ? "قبول" : "Accept", exact: true }),
						review.getByRole("button", { name: ar ? "تعديل" : "Edit", exact: true }),
						keep,
					]) {
						const box = await button.boundingBox();
						expect(box?.height).toBeGreaterThanOrEqual(44);
						expect(box?.width).toBeGreaterThanOrEqual(44);
					}
				}
				await expect(review.locator("kbd")).toHaveCount(0);
				const shortcuts = ar
					? "اضغط A لقبول التعديل المحدد أو R لرفضه. استخدم ↑ و ↓ للتنقل بين التعديلات."
					: "A accepts and R rejects the focused edit. ↑ and ↓ move between edits.";
				await expect(review.locator("[data-proposal-index]").first()).toHaveAccessibleDescription(shortcuts);
				await expect(review.getByText(shortcuts, { exact: true })).toBeHidden();
				await final.click();
				await expect(final).toBeChecked();
				await expect(passage).toHaveText(proposed);
				await expect(passage.locator("ins, del")).toHaveCount(0);
				await changes.click();
				await expect(added).toBeVisible();
				await expect(review.getByRole("button", { name: ar ? "قبول" : "Accept", exact: true })).toHaveCSS(
					"direction",
					ar ? "rtl" : "ltr",
				);
				await expect(
					review.getByText(ar ? "صياغة جديدة — تحقق من صحتها" : "New wording — check it is true"),
				).toHaveCount(0);
				await review.getByText(ar ? "المصدر" : "Evidence", { exact: true }).click();
				await review.scrollIntoViewIfNeeded();
				await settleScreen(page);
				expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
				expect(
					await page.evaluate(
						(family) => document.fonts.check(`14px "${family}"`),
						ar ? "Noto Sans Arabic" : "Noto Sans",
					),
				).toBe(true);
				await page.screenshot({ path: testInfo.outputPath("review.png") });
				await captureReviewDirection(page, testInfo, "wording");
				await captureReviewFooter(
					page,
					testInfo,
					"wording-footer",
					review.getByRole("button", { name: ar ? "قبول" : "Accept", exact: true }),
				);
				await review.locator(".review-wording").scrollIntoViewIfNeeded();
				await page.screenshot({ path: resolve("/tmp/sirawise-fixes/diff-shots", `wording-${locale}-${width}.png`) });
				await review.getByRole("button", { name: ar ? "تعديل" : "Edit", exact: true }).click();
				const dialog = page.getByRole("dialog");
				await dialog.getByRole("textbox").fill(ar ? "My supplied wording." : "صياغتي التي أضفتها بنفسي.");
				await settleScreen(page);
				await page.screenshot({ path: testInfo.outputPath("editing.png") });
				await dialog.getByRole("button", { name: ar ? "إلغاء" : "Cancel", exact: true }).click();
				await review.getByRole("button", { name: ar ? "إضافة معلومة" : "Add information", exact: true }).click();
				await settleScreen(page);
				await page.screenshot({ path: testInfo.outputPath("add-information.png") });
				await dialog.getByRole("button", { name: ar ? "إلغاء" : "Cancel", exact: true }).click();
				await review.locator("[data-proposal-index]").focus();
				await page.keyboard.press("A");
				const undo = review.getByRole("button", { name: ar ? "تراجع" : "Undo", exact: true });
				await expect(undo).toBeVisible();
				await page.screenshot({ path: testInfo.outputPath("accept-card-frame.png") });
				if (width === 390)
					await page
						.getByRole("navigation", { name: /Editor views|طرق عرض المحرر/u })
						.getByRole("button", { name: /^(Page|صفحة)$/u })
						.click();
				const pulse = page.locator('[data-slot="preview-edit-highlight"][data-review-action="accept"]');
				await expect(pulse).toBeVisible();
				await page.screenshot({ path: testInfo.outputPath("accept-preview-frame.png") });
				if (width === 390) await openWriting(page, width);
				await review.scrollIntoViewIfNeeded();
				await undo.scrollIntoViewIfNeeded();
				await settleScreen(page);
				await expect(passage).toHaveText(proposed);
				await expect(passage.locator("ins, del")).toHaveCount(0);
				await page.screenshot({ path: testInfo.outputPath("accepted.png") });
				await undo.click();
				await expect(page.locator('.review-wording[data-review-action="undo"]')).toBeVisible();
				await page.screenshot({ path: testInfo.outputPath("undo-card-frame.png") });
				if (width === 390)
					await page
						.getByRole("navigation", { name: /Editor views|طرق عرض المحرر/u })
						.getByRole("button", { name: /^(Page|صفحة)$/u })
						.click();
				await expect(page.locator('[data-slot="preview-edit-highlight"][data-review-action="undo"]')).toBeVisible();
				await page.screenshot({ path: testInfo.outputPath("undo-preview-frame.png") });
				if (width === 390) await openWriting(page, width);
				await review.getByRole("button", { name: ar ? "تعديل" : "Edit", exact: true }).click();
				// Switching mobile views remounts the review panel; supply this decision's wording explicitly.
				await dialog.getByRole("textbox").fill(ar ? "My supplied wording." : "صياغتي التي أضفتها بنفسي.");
				await dialog.getByRole("button", { name: ar ? "حفظ صياغتي" : "Save my wording", exact: true }).click();
				await expect(undo).toBeVisible();
				await review.scrollIntoViewIfNeeded();
				await undo.scrollIntoViewIfNeeded();
				await settleScreen(page);
				const ownWording = passage;
				await expect(ownWording.locator("ins, del")).toHaveCount(0);
				await expect(ownWording).toHaveText(ar ? "My supplied wording." : "صياغتي التي أضفتها بنفسي.");
				await expect(ownWording).toHaveCSS("opacity", "1");
				await ownWording.scrollIntoViewIfNeeded();
				await expect(ownWording).toBeInViewport();
				await page.screenshot({ path: testInfo.outputPath("own-wording.png") });
				await undo.click();
				const reopened = page
					.getByRole("region", { name: ar ? /بانتظار مراجعتك/u : /Needs your review/u })
					.getByTestId("durable-review");
				await expect(reopened.getByRole("button", { name: ar ? "قبول" : "Accept", exact: true })).toBeEnabled();
				await reopened.locator("[data-proposal-index]").press("R");
				await expect(passage).toHaveText(original);
				await expect(passage.locator("ins, del")).toHaveCount(0);
				await expect(keep).toHaveCount(0);
				await undo.click();
				await expect(keep).toBeVisible();
				const current = await (await page.request.get(`/api/openapi/resumes/${resumeId}`)).json();
				current.data.summary.content = ar ? "<p>Manual correction.</p>" : "<p>تعديل يدوي.</p>";
				await expect(
					await page.request.put(`/api/openapi/resumes/${resumeId}`, {
						data: { data: current.data, expectedUpdatedAt: current.updatedAt },
					}),
				).toBeOK();
				await page.reload();
				await openWriting(page, width);
				await expect(
					review.getByText(ar ? "قديم: لقد تغير النص منذ ذلك الحين." : "Out of date: the text has changed since."),
				).toBeVisible();
				await review.scrollIntoViewIfNeeded();
				await settleScreen(page);
				await page.screenshot({ path: testInfo.outputPath("stale.png") });
				await page.setViewportSize({ width: 320, height: 900 });
				await review.scrollIntoViewIfNeeded();
				await settleScreen(page);
				expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
				await page.screenshot({ path: testInfo.outputPath("reflow-320.png") });
			});
		});
	}

for (const locale of ["en-US", "ar-SA"] as const)
	for (const width of [1440, 390])
		test(`native selected-text assistance ${locale} ${width} stays local until confirmation`, async ({
			authPage: page,
		}, testInfo) => {
			test.setTimeout(90_000);
			const ar = locale === "ar-SA";
			await page.setViewportSize({ width, height: 900 });
			await page.request.post("/api/auth/update-user", {
				data: { uiLocale: locale },
				headers: { origin: String(testInfo.project.use.baseURL) },
			});
			await seedReviewBudget();
			await openPdfReview(page, locale);
			await captureReviewFooter(
				page,
				testInfo,
				"import-footer",
				page.locator('[data-slot="sticky-actions"] button[data-variant="primary"]'),
			);
			if (ar) {
				const name = page.locator('[data-import-field="name"] input');
				await expect(name).toHaveValue("Ada Lovelace");
				await expectReviewTextDirection(name, "ltr");
				await page
					.getByRole("navigation", { name: "أقسام المراجعة", exact: true })
					.getByRole("button", { name: /^(الخبرة|الخبرات العملية|الخبرة المهنية)$/u })
					.click();
				const company = page.locator('[data-import-field="company"] dd');
				await expect(company).toHaveText("Horizon Systems");
				await expectReviewTextDirection(company, "ltr");
				await company.scrollIntoViewIfNeeded();
				await captureReviewDirection(page, testInfo, "import-review");
			}
			const master = await (await page.request.get("/api/openapi/career/master")).json();
			const cvs = await (await page.request.get("/api/openapi/resumes")).json();
			await page
				.getByRole("button", { name: ar ? "فتح المساعدة في النص" : "Open text assistance", exact: true })
				.click();
			const field = page.getByRole("textbox", {
				name: ar
					? "النص المستخرج مباشرة — حدد المقطع غير المؤكد"
					: "Native extracted text — select the uncertain passage",
				exact: true,
			});
			const guide = page.getByRole("button", {
				name: ar ? "أرني الطريقة" : "Show me how",
				exact: true,
			});
			await expect(guide).toBeVisible();
			await expect(page.locator('[data-slot="guided-tour-spotlight"]')).toHaveCount(0);
			await expect(
				page.getByText(ar ? "حدد النص الذي تريد المساعدة فيه" : "Highlight the text you want help with", {
					exact: true,
				}),
			).toBeVisible();
			await expect(
				page.getByRole("button", { name: ar ? "مراجعة النص المحدد" : "Review selected text", exact: true }),
			).toBeDisabled();
			const section = page.getByRole("combobox", {
				name: ar ? "القسم المطلوب مراجعته" : "Section to review",
				exact: true,
			});
			await section.selectOption("education");
			await expect(field).toHaveValue(/Example\s+University/);
			await expect(field).not.toHaveValue(/Built\s+secure\s+services/);
			await section.selectOption("experience");
			await expect(field).toHaveValue(/Built\s+secure\s+services/);
			await expect(field).not.toHaveValue(/Example\s+University/);
			expect((await field.inputValue()).split("\n").length).toBeGreaterThan(1);
			await field.evaluate((element: HTMLTextAreaElement) => {
				element.focus();
				const match = /Built\s+secure\s+services/u.exec(element.value);
				if (!match) throw new Error("Missing synthetic experience passage");
				element.setSelectionRange(match.index, match.index + match[0].length - 1);
			});
			await page.keyboard.press("Shift+ArrowRight");
			await expect(
				page.getByRole("status").filter({ hasText: ar ? "تم تحديد 21 حرفًا" : "21 characters selected" }),
			).toBeVisible();
			await page.getByRole("button", { name: ar ? "مراجعة النص المحدد" : "Review selected text", exact: true }).click();
			await settleScreen(page);
			await page.screenshot({ path: testInfo.outputPath("import-consent.png") });
			await page
				.getByRole("dialog")
				.getByRole("button", { name: ar ? "بدء المراجعة" : "Start review", exact: true })
				.click();
			await expect(
				page.getByRole("button", { name: ar ? "استخدام في المسودة" : "Use in draft", exact: true }),
			).toBeVisible({ timeout: 25_000 });
			const withheld = page.getByText(
				ar
					? "تعذر على المساعد التحقق من هذا الحقل بالاستناد إلى النص المحدد. لم يُضف الحقل."
					: "The assistant did not verify this field against the selected text. The field was not added.",
				{ exact: false },
			);
			await expect(withheld).toBeVisible();
			const retry = page.getByRole("button", { name: ar ? "إعادة المحاولة" : "Retry", exact: true });
			await retry.scrollIntoViewIfNeeded();
			await expect(retry).toBeInViewport();
			await expect(withheld).toBeInViewport();
			await expect(page.getByText("Invented Employer", { exact: false })).toHaveCount(0);
			await expect(
				page.getByRole("button", { name: ar ? "استخدام في المسودة" : "Use in draft", exact: true }),
			).toHaveCount(1);
			await captureReviewDirection(page, testInfo, "extraction-partial");
			if (ar) {
				const candidate = page.locator("p").and(page.getByText("Built secure services", { exact: true }));
				await expectReviewTextDirection(candidate, "ltr");
				await candidate.scrollIntoViewIfNeeded();
				await captureReviewDirection(page, testInfo, "selected-text");
			}
			await page
				.getByRole("combobox", { name: ar ? "إلى أي عنصر تريد الإضافة؟" : "Add to which entry?", exact: true })
				.selectOption("new");
			await page.getByRole("button", { name: ar ? "استخدام في المسودة" : "Use in draft", exact: true }).click();
			const stagedLabel = ar
				? "أُضيف إلى المسودة المحلية — راجعه قبل التأكيد"
				: "Added to local draft — review before confirming";
			const staged = page.getByRole("status").and(page.getByText(stagedLabel, { exact: true }));
			await expect(
				page.getByRole("button", { name: ar ? "استخدام في المسودة" : "Use in draft", exact: true }),
			).toHaveCount(0);
			await expect(staged).toBeVisible();
			expect(await (await page.request.get("/api/openapi/career/master")).json()).toEqual(master);
			expect(await (await page.request.get("/api/openapi/resumes")).json()).toEqual(cvs);
			await settleScreen(page);
			expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
			await page.screenshot({ path: testInfo.outputPath("import-assistance.png") });
			await page.setViewportSize({ width: 320, height: 900 });
			await settleScreen(page);
			expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
			await page.screenshot({ path: testInfo.outputPath("import-reflow-320.png") });
			await page.setViewportSize({ width, height: 900 });
			await page.reload();
			await page
				.getByRole("button", { name: ar ? "فتح المساعدة في النص" : "Open text assistance", exact: true })
				.click();
			await expect(
				page.getByRole("button", { name: ar ? "استخدام في المسودة" : "Use in draft", exact: true }),
			).toHaveCount(0);
			await expect(staged).toBeVisible();
			if (!ar && width === 1440) {
				const createOnly = page.getByRole("button", { name: "Create CV only", exact: true });
				const createAndSave = page.getByRole("button", { name: "Create CV and save career information", exact: true });
				await expect(createOnly).toBeVisible();
				await expect(createAndSave).toHaveCount(0);
				await expect(createOnly).toBeDisabled();
				await confirmPdfSections(page);
				await expect(createOnly).toBeEnabled();
				await createOnly.click();
				await expect(page).toHaveURL(/\/builder\//u);
				const id = new URL(page.url()).pathname.split("/").at(-1);
				const saved = await (await page.request.get(`/api/openapi/resumes/${id}`)).json();
				expect(saved.data.sections.experience.items.at(-1).description).toBe("<p>Built secure services</p>");
				expect(await (await page.request.get("/api/openapi/career/master")).json()).toEqual(master);
				expect((await (await page.request.get("/api/openapi/ai/usage")).json()).operations.used).toBe(1);
			}
		});

test("confirming an imported entry names the career information save in the creation action", async ({
	authPage: page,
}) => {
	await openPdfReview(page);
	await expect(page.getByRole("button", { name: "Create CV only", exact: true })).toBeVisible();
	await page
		.getByRole("navigation", { name: "Review sections", exact: true })
		.getByRole("button", { name: /^Experience/u })
		.click();
	await page
		.getByRole("article", { name: "Software Engineer", exact: true })
		.getByRole("button", { name: "Confirm entry", exact: true })
		.click();
	await expect(page.getByRole("button", { name: "Create CV and save career information", exact: true })).toBeVisible();
	await expect(page.getByRole("button", { name: "Create CV only", exact: true })).toHaveCount(0);
});

for (const width of [1440, 390])
	test(`Arabic import review and selected-text assistance in English at ${width}`, async ({ authPage: page }, info) => {
		test.setTimeout(90_000);
		await page.setViewportSize({ width, height: 900 });
		await seedReviewBudget();
		await openPdfReview(page, "en-US", "ar-SA");
		const name = page.locator('[data-import-field="name"] input');
		await expect(name).toHaveValue(/أحمد/u);
		await expectReviewTextDirection(name, "rtl");
		await page
			.getByRole("navigation", { name: "Review sections", exact: true })
			.getByRole("button", { name: "Experience", exact: true })
			.click();
		const company = page.locator('[data-import-field="company"] dd');
		await expect(company).toHaveText(/شركة/u);
		await expectReviewTextDirection(company, "rtl");
		await company.scrollIntoViewIfNeeded();
		await captureReviewDirection(page, info, "import-review");
		await page.getByRole("button", { name: "Open text assistance", exact: true }).click();
		await page.getByRole("combobox", { name: "Section to review", exact: true }).selectOption("experience");
		const field = page.getByRole("textbox", {
			name: "Native extracted text — select the uncertain passage",
			exact: true,
		});
		await expectReviewTextDirection(field, "rtl");
		const selected = "مهندس برمجيات";
		await field.evaluate((element: HTMLTextAreaElement, text) => {
			element.focus();
			const match = [...element.value.matchAll(/[\p{Script=Arabic}]+[^\S\r\n]+[\p{Script=Arabic}]+/gu)].find(
				(passage) => passage[0].normalize("NFKC") === text,
			);
			if (!match) throw new Error("Missing synthetic Arabic experience passage");
			element.setSelectionRange(match.index, match.index + match[0].length);
		}, selected);
		await field.dispatchEvent("keyup");
		await page.getByRole("button", { name: "Review selected text", exact: true }).click();
		await page.getByRole("dialog").getByRole("button", { name: "Start review", exact: true }).click();
		await expect(page.getByRole("button", { name: "Use in draft", exact: true })).toBeVisible({ timeout: 25_000 });
		const candidate = page.locator("p").and(page.getByText(selected, { exact: true }));
		await expectReviewTextDirection(candidate, "rtl");
		await candidate.scrollIntoViewIfNeeded();
		await captureReviewDirection(page, info, "selected-text");
	});
