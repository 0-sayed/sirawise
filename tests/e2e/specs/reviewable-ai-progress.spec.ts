import type { Page } from "@playwright/test";
import { openWriting, seedReview } from "../fixtures/reviewable-ai";
import { settleScreen } from "../fixtures/screen";
import { expect, test } from "../fixtures/test";
import { variantClient } from "../fixtures/variants";

// Delayed operations share the fixture route's two-operation budget; keep this file sequential locally too.
test.describe.configure({ mode: "default" });

async function launchReview(page: Page) {
	await page.getByRole("button", { name: /^(Review wording|مراجعة الصياغة)$/u }).click();
	await page
		.getByRole("dialog")
		.getByRole("button", { name: /^(Start review|بدء المراجعة)$/u })
		.click();
}

for (const locale of ["en-US", "ar-SA"] as const)
	for (const width of [1440, 390])
		test(`actual review progress and cancellation ${locale} ${width}`, async ({ authPage: page }, info) => {
			test.setTimeout(90000);
			const ar = locale === "ar-SA";
			await page.setViewportSize({ width, height: 900 });
			await page.emulateMedia({ reducedMotion: "no-preference" });
			const resumeId = await seedReview(page, info, locale);
			const api = variantClient(page);
			const original = await api.resume.getById({ id: resumeId });
			original.data.summary.content = "<p>Built services for Synthetic delayed review.</p>";
			await api.resume.update({
				id: resumeId,
				data: original.data,
				expectedUpdatedAt: original.updatedAt.toISOString(),
			});
			await page.reload();
			await settleScreen(page);
			await expect(page.locator("html")).toHaveAttribute("dir", ar ? "rtl" : "ltr");
			expect(
				await page.evaluate(
					(family) => document.fonts.check(`14px "${family}"`),
					ar ? "Noto Sans Arabic" : "Noto Sans",
				),
			).toBe(true);
			await openWriting(page, width);
			await launchReview(page);
			await expect.poll(() => api.ai.review.latest({ resumeId })).not.toBeNull();
			const operationId = await api.ai.review.latest({ resumeId });
			if (!operationId) throw new Error("Expected a real review operation");
			await expect.poll(async () => (await api.ai.operations.get({ id: operationId })).progress?.step).toBe("drafting");
			const progress = page
				.locator('[data-slot="alert"][data-variant="info"]')
				.filter({ has: page.getByRole("status") });
			await expect(progress.getByRole("status")).toContainText(ar ? "جارٍ إعداد الاقتراحات…" : "Drafting suggestions…");
			await expect(progress.getByRole("status")).not.toContainText(/Part \d|الجزء \d/u);
			await expect(progress.locator(':scope > [data-slot="icon"]')).toHaveCSS("animation-name", "spin");
			await expect(progress.getByText(ar ? /^الوقت المنقضي: [5-9] ث$/u : /^Elapsed: [5-9]s$/u)).toBeVisible({
				timeout: 10000,
			});
			await progress.scrollIntoViewIfNeeded();
			await settleScreen(page);
			expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
			await page.screenshot({ path: info.outputPath("drafting-progress.png") });
			await expect.poll(async () => (await api.ai.operations.get({ id: operationId })).progress?.step).toBe("checking");
			await expect(progress.getByRole("status")).toContainText(
				ar ? "جارٍ التحقق من المعلومات بمقارنتها بسيرتك الذاتية…" : "Checking facts against your CV…",
			);
			await page.emulateMedia({ reducedMotion: "reduce" });
			await expect(progress.locator(':scope > [data-slot="icon"]')).toHaveCSS("animation-name", "none");
			await page.screenshot({ path: info.outputPath("checking-progress.png") });
			await expect(page.getByTestId("durable-review")).toBeVisible({ timeout: 15000 });
			await expect(progress).toHaveCount(0);
			expect((await api.resume.getById({ id: resumeId })).data).toEqual(original.data);

			await launchReview(page);
			await expect.poll(() => api.ai.review.latest({ resumeId })).not.toBe(operationId);
			const cancelledId = await api.ai.review.latest({ resumeId });
			if (!cancelledId) throw new Error("Expected another real review operation");
			await expect.poll(async () => (await api.ai.operations.get({ id: cancelledId })).progress?.step).toBe("drafting");
			await progress.getByRole("button", { name: ar ? "إلغاء" : "Cancel", exact: true }).click();
			await expect(progress.getByRole("status")).toContainText(ar ? "جارٍ الإلغاء…" : "Cancelling…");
			await expect(progress.getByRole("button", { name: ar ? "إلغاء" : "Cancel", exact: true })).toBeDisabled();
			await page.screenshot({ path: info.outputPath("cancelling-progress.png") });
			await expect
				.poll(async () => (await api.ai.operations.get({ id: cancelledId })).state, { timeout: 15000 })
				.toBe("cancelled");
			await expect(progress).toHaveCount(0);
			expect((await api.ai.usage.get()).operations).toMatchObject({ used: 1, reserved: 0, remaining: 4 });
			expect((await api.resume.getById({ id: resumeId })).data).toEqual(original.data);
		});
