import { confirmPdfSections, openPdfReview } from "../fixtures/import-review";
import { syntheticNativePdfLocales } from "../fixtures/owner-import-pdf";
import { openWriting, seedReviewBudget, startReview } from "../fixtures/reviewable-ai";
import { expect, test } from "../fixtures/test";
import { variantClient } from "../fixtures/variants";

test("wording acceptance and Undo preserve the scope of a multi-paragraph imported summary", async ({
	authPage: page,
}) => {
	await seedReviewBudget();
	await openPdfReview(page, "en-US", "en-US", "tooling/document-qualification/import-layout/app-english.pdf");
	await expect(page.getByRole("button", { name: "Create CV only", exact: true })).toBeDisabled();
	await confirmPdfSections(page);
	await page.getByRole("button", { name: "Create CV only", exact: true }).click();
	await expect(page).toHaveURL(/\/builder\//u);
	const id = new URL(page.url()).pathname.split("/").at(-1);
	if (!id) throw new Error("Missing imported CV");
	const api = variantClient(page);
	const saved = async () => (await api.resume.getById({ id })).data.summary.content;
	const imported = await saved();
	expect(imported).toContain("Built AI-assisted tools for release reviews.");
	expect(imported).toContain("Kept results at -5 when the input was unchanged.");
	expect(imported.match(/<p[ >]/gu)?.length).toBeGreaterThan(1);
	await openWriting(page);
	await startReview(page);
	const review = page.getByTestId("durable-review");
	await review.getByRole("button", { name: "Accept", exact: true }).click();
	await expect.poll(saved).toBe(imported.replace("Built AI-assisted tools", "Developed AI-assisted tools"));
	await page.reload();
	await openWriting(page);
	await review.getByRole("button", { name: "Undo", exact: true }).click();
	await expect.poll(saved).toBe(imported);
	expect((await api.ai.usage.get()).operations).toMatchObject({ used: 1, reserved: 0 });
});

for (const locale of syntheticNativePdfLocales)
	for (const width of [1440, 390])
		test(`import assistance tour is optional, anchored and replayable ${locale} ${width}`, async ({
			authPage: page,
			baseURL,
		}, testInfo) => {
			if (!baseURL) throw new Error("Missing browser base URL");
			const ar = locale === "ar-SA";
			await page.setViewportSize({ width, height: 900 });
			await page.emulateMedia({ reducedMotion: "reduce" });
			await page.context().addCookies([{ name: "locale", value: locale, url: baseURL }]);
			await page.request.post("/api/auth/update-user", {
				data: { uiLocale: locale },
				headers: { origin: baseURL },
			});
			await seedReviewBudget();
			await openPdfReview(page, locale, locale);
			await page
				.getByRole("button", { name: ar ? "فتح المساعدة في النص" : "Open text assistance", exact: true })
				.click();
			const start = page.getByRole("button", { name: ar ? "أرني الطريقة" : "Show me how", exact: true });
			await expect(start).toBeVisible();
			if (width === 390) {
				const helpTitle = page.getByRole("heading", {
					name: ar
						? "احصل على مساعدة الذكاء الاصطناعي في النص الذي لم يتأكد منه الاستيراد"
						: "Get AI help with text the import was unsure about",
					exact: true,
				});
				const helpBounds = await helpTitle.boundingBox();
				if (!helpBounds) throw new Error("Missing help heading bounds");
				expect(helpBounds.width).toBeGreaterThan(width / 2);
			}
			await page.screenshot({ path: testInfo.outputPath("import-assistance-help.png") });
			await expect(page.locator('[data-slot="popover-content"]')).toHaveCount(0);
			await start.focus();
			await page.keyboard.press("Enter");
			const popup = page.locator('[data-slot="popover-content"]');
			await expect(popup).toBeVisible();
			await expect(popup).toHaveAttribute("dir", ar ? "rtl" : "ltr");
			await expect(popup.getByRole("status")).toHaveText(ar ? "الخطوة 1 من 3" : "Step 1 of 3");
			const sectionId = await page
				.getByRole("combobox", { name: ar ? "القسم المطلوب مراجعته" : "Section to review", exact: true })
				.getAttribute("id");
			if (!sectionId) throw new Error("Missing section control id");
			await expect(page.locator('[data-slot="guided-tour-spotlight"]')).toHaveAttribute("data-target", sectionId);
			expect(
				await popup.evaluate((element) =>
					getComputedStyle(element)
						.transitionDuration.split(",")
						.every((duration) => Number.parseFloat(duration) <= 0.001),
				),
			).toBe(true);
			await popup.getByRole("button", { name: ar ? "التالي" : "Next", exact: true }).click();
			await expect(popup.getByRole("status")).toHaveText(ar ? "الخطوة 2 من 3" : "Step 2 of 3");
			await expect(popup.getByRole("heading")).toBeFocused();
			await popup.getByRole("button", { name: ar ? "رجوع" : "Back", exact: true }).click();
			await expect(popup.getByRole("status")).toHaveText(ar ? "الخطوة 1 من 3" : "Step 1 of 3");
			await popup.getByRole("button", { name: ar ? "التالي" : "Next", exact: true }).click();
			await popup.getByRole("button", { name: ar ? "التالي" : "Next", exact: true }).click();
			await expect(popup.getByRole("status")).toHaveText(ar ? "الخطوة 3 من 3" : "Step 3 of 3");
			expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
			const rect = await popup.boundingBox();
			if (!rect) throw new Error("Missing tour popup bounds");
			expect(rect.x).toBeGreaterThanOrEqual(0);
			expect(rect.x + rect.width).toBeLessThanOrEqual(width);
			await page.screenshot({ path: testInfo.outputPath("import-guided-tour.png") });
			await popup.getByRole("button", { name: ar ? "إتمام" : "Done", exact: true }).click();
			await expect(popup).toHaveCount(0);
			await expect(start).toBeFocused();
			await expect(start).toHaveAttribute("data-seen", "true");
			await start.press("Enter");
			await expect(popup.getByRole("status")).toHaveText(ar ? "الخطوة 1 من 3" : "Step 1 of 3");
			await page.keyboard.press("Escape");
			await expect(popup).toHaveCount(0);
			await expect(start).toBeFocused();
			await page.reload();
			await page
				.getByRole("button", { name: ar ? "فتح المساعدة في النص" : "Open text assistance", exact: true })
				.click();
			await expect(start).toHaveAttribute("data-seen", "true");
			await expect(popup).toHaveCount(0);
		});
