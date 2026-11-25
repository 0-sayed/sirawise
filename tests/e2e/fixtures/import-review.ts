import type { Page } from "@playwright/test";
import { expect } from "./test";

export async function openPdfReview(
	page: Page,
	locale: "en-US" | "ar-SA" = "en-US",
	documentLocale: "en-US" | "ar-SA" = "en-US",
	pdf:
		| string
		| {
				name: string;
				mimeType: string;
				buffer: Buffer;
		  } = `tooling/document-qualification/native/${documentLocale === "ar-SA" ? "ar" : "en"}.pdf`,
) {
	const ar = locale === "ar-SA";
	await page.goto("/dashboard");
	await page
		.locator("main")
		.getByRole("button", { name: ar ? /^(جديد|سيرة ذاتية جديدة)$/u : /^(New CV|New)$/, exact: true })
		.click();
	await page.getByRole("button", { name: ar ? /^رفع سيرة ذاتية موجودة/ : /^Upload an existing CV/ }).click();
	await page.locator('[data-slot="dialog-content"] input[type="file"]').setInputFiles(pdf);
	await expect(page).toHaveURL(/\/dashboard\/import\/[\w-]+/, { timeout: 30000 });
	await expect(
		page.getByRole("heading", { name: ar ? "راجع المعلومات المستوردة" : "Review imported information", exact: true }),
	).toBeVisible();
}

export async function confirmPdfSections(page: Page) {
	const review = page.getByRole("navigation", { name: "Review sections", exact: true });
	for (const section of await review.getByRole("button").all()) {
		await section.click();
		await page.getByRole("button", { name: "Confirm section", exact: true }).click();
	}
}
