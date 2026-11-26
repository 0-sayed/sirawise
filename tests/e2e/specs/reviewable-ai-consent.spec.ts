import { captureReviewDirection, openWriting, seedReview } from "../fixtures/reviewable-ai";
import { settleScreen } from "../fixtures/screen";
import { expect, test } from "../fixtures/test";

for (const width of [1440, 390]) {
	test.describe(`AI details at ${width}px`, () => {
		test.use({ hasTouch: width === 390 });
		for (const locale of ["en-US", "ar-SA"] as const)
			test(`AI consent persists across features and can be withdrawn in ${locale} at ${width}px`, async ({
				authPage: page,
			}, info) => {
				test.setTimeout(90000);
				await page.setViewportSize({ width, height: 900 });
				const id = await seedReview(page, info, locale);
				const ar = locale === "ar-SA";
				await openWriting(page, width);
				const wording = page.getByRole("button", { name: /^(Review wording|مراجعة الصياغة)$/u });
				const detailsLabel = ar ? "تفاصيل الذكاء الاصطناعي" : "AI details";
				const details = page.getByRole("button", { name: detailsLabel, exact: true });
				await expect(details).toHaveText(/^$/u);
				await expect(details.locator("svg")).toBeVisible();
				await details.scrollIntoViewIfNeeded();
				await settleScreen(page);
				await captureReviewDirection(page, info, "ai-details-icon");
				if (width === 390) {
					const target = await details.boundingBox();
					expect(target?.width).toBeGreaterThanOrEqual(44);
					expect(target?.height).toBeGreaterThanOrEqual(44);
				} else {
					await details.hover();
					await expect(page.getByRole("tooltip", { name: detailsLabel })).toBeVisible();
					await page.mouse.move(0, 0);
					await expect(page.getByRole("tooltip", { name: detailsLabel })).toBeHidden();
				}
				await wording.focus();
				await page.keyboard.press("Tab");
				await expect(details).toBeFocused();
				await expect(details).toHaveCSS("outline-style", "solid");
				await expect(page.getByRole("tooltip", { name: detailsLabel })).toBeVisible();
				await captureReviewDirection(page, info, "ai-details-focus");
				if (width === 390) await details.tap();
				else await page.keyboard.press("Enter");
				const dialog = page.getByRole("dialog");
				await expect(dialog.getByText(/OpenRouter.*Microsoft Azure.*Together AI/u)).toBeVisible();
				await expect(dialog.getByRole("button", { name: /^(Start review|بدء المراجعة)$/u })).toHaveCount(0);
				await captureReviewDirection(page, info, "ai-details-notice");
				await page.keyboard.press("Escape");
				await expect(dialog).toHaveCount(0);
				await wording.click();
				await expect(dialog.getByText(/OpenRouter.*Microsoft Azure.*Together AI/u)).toBeVisible();
				await expect(dialog).not.toContainText(/Luna|Terra/u);
				await settleScreen(page);
				await expect(page.locator("html")).toHaveAttribute("dir", ar ? "rtl" : "ltr");
				expect(
					await page.evaluate(
						(family) => document.fonts.check(`14px "${family}"`),
						ar ? "Noto Sans Arabic" : "Noto Sans",
					),
				).toBe(true);
				await captureReviewDirection(page, info, "first-consent");
				await dialog.getByRole("button", { name: /^(Start review|بدء المراجعة)$/u, exact: true }).click();
				await expect(page.getByTestId("durable-review")).toBeVisible({ timeout: 25000 });
				await expect(page.getByRole("button", { name: /^(Accept|قبول)$/u }).first()).toBeVisible({ timeout: 25000 });

				await page.goto(`/dashboard/resumes/${id}/job`);
				await page.getByLabel(/^(Job title|المسمى الوظيفي)$/u).fill("Engineer");
				await page.getByLabel(/^(Job ad|إعلان الوظيفة)$/u).fill("TypeScript and SAP required");
				await page.getByRole("button", { name: /^(Compare with job|مقارنة بالوظيفة)$/u }).click();
				await page.getByRole("button", { name: /Detailed requirement check|فحص متطلبات الوظيفة بالتفصيل/u }).click();
				const evidence = page.getByRole("button", { name: /^(Check job requirements|فحص متطلبات الوظيفة)$/u });
				const started = page.waitForResponse(
					(response) => new URL(response.url()).pathname === "/api/rpc/ai/operations/start",
				);
				await evidence.click();
				expect((await started).ok()).toBe(true);
				await expect(dialog).toHaveCount(0);

				await page.goto("/dashboard/settings/privacy");
				const settings = page.getByRole("region", { name: ar ? "الذكاء الاصطناعي والخصوصية" : "AI and privacy" });
				await expect(settings.getByText(/OpenRouter.*Microsoft Azure.*Together AI/u)).toBeVisible();
				await expect(settings.locator("time")).toHaveAttribute("datetime", /^\d{4}-\d{2}-\d{2}T/u);
				await settings.scrollIntoViewIfNeeded();
				await settleScreen(page);
				await captureReviewDirection(page, info, "privacy-settings");
				await settings.getByRole("button", { name: ar ? "سحب الموافقة" : "Withdraw consent" }).click();
				await expect(settings.locator("time")).toHaveCount(0);
				await expect(settings.getByText(ar ? "لا توجد موافقة سارية." : "No active consent.")).toBeVisible();

				await page.goto(`/builder/${id}`);
				await openWriting(page, width);
				await wording.click();
				await expect(dialog.getByRole("button", { name: /^(Start review|بدء المراجعة)$/u })).toBeEnabled();
				expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
				await captureReviewDirection(page, info, "consent-after-withdrawal");
			});
	});
}
