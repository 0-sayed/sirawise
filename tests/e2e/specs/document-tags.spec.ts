import type { Locator, Page } from "@playwright/test";
import { join } from "node:path";
import { settleScreen } from "../fixtures/screen";
import { expect, test } from "../fixtures/test";
import { variantClient } from "../fixtures/variants";

test.use({ headless: true });

async function openCardTags(page: Page, card: Locator, ar: boolean) {
	await card.getByRole("button", { name: ar ? "المزيد من الإجراءات" : "More actions", exact: true }).click();
	await page.getByRole("menuitem", { name: ar ? "الوسوم…" : "Tags…", exact: true }).click();
	return page.getByRole("dialog", { name: ar ? "الوسوم" : "Tags", exact: true });
}

async function openTags(page: Page, locale: "ar-SA" | "en-US", width: number, tags: string[] = []) {
	const ar = locale === "ar-SA";
	const name = ar ? "سيرة ذاتية تجريبية" : "Synthetic CV";
	const api = variantClient(page);
	const id = await api.resume.create({ name, tags, withSampleData: false });
	await page.setViewportSize({ width, height: width === 390 ? 844 : 1024 });
	await page.goto(`/dashboard?locale=${locale}&view=grid`);
	const card = page.getByRole("article", { name, exact: true });
	const dialog = await openCardTags(page, card, ar);
	return {
		card,
		dialog,
		id,
		input: dialog.getByRole("combobox"),
		save: dialog.getByRole("button", { name: ar ? "حفظ" : "Save", exact: true }),
		readTags: async () => (await api.documents.list({ trashed: false })).find((item) => item.id === id)?.tags,
	};
}

async function capture(page: Page, name: string) {
	const folder = process.env.E2E_PUBLIC_EVIDENCE_DIR;
	if (!folder) return;
	await settleScreen(page);
	expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
	await page.screenshot({ path: join(folder, `${name}.png`), fullPage: true });
}

for (const locale of ["ar-SA", "en-US"] as const) {
	const ar = locale === "ar-SA";
	for (const [entry, width] of [
		["Enter", 1440],
		["Save", 390],
		["two Enters", 1440],
		["composition", 390],
	] as const) {
		test(`${locale} saves a tag after ${entry}`, async ({ authPage: page }) => {
			const { card, dialog, input, save, readTags } = await openTags(page, locale, width);
			const tag = ar || entry === "composition" ? "وسم تجريبي" : "Synthetic tag";
			const chip = dialog.locator('[data-slot="chip"]').getByText(tag, { exact: true });
			await input.fill(tag);
			if (entry === "composition") {
				await input.dispatchEvent("compositionstart");
				await input.dispatchEvent("keydown", { key: "Enter", isComposing: true });
				await expect(input).toHaveValue(tag);
				await expect(chip).toHaveCount(0);
				await input.dispatchEvent("compositionend", { data: tag });
			}
			if (entry !== "Save") {
				await input.press("Enter");
				if (entry === "two Enters") await input.press("Enter");
				await expect(chip).toHaveCount(1);
				await expect(input).toHaveValue("");
			}
			await expect(dialog).toBeVisible();
			expect(await readTags()).toEqual([]);
			if (entry === "Enter" || entry === "composition") await capture(page, `tags-dialog-${locale}-${width}`);
			const navigations: string[] = [];
			page.on("framenavigated", (frame) => {
				if (frame === page.mainFrame()) navigations.push(frame.url());
			});
			await save.click();
			await expect(dialog).toBeHidden();
			expect(await readTags()).toEqual([tag]);
			const filter = page.getByRole("group", { name: ar ? "تصفية حسب الوسم" : "Filter by tag" });
			const filterTag = filter.getByRole("button", { name: `#${tag}`, exact: true });
			await expect(filterTag).toBeVisible();
			await expect(card.getByText(tag, { exact: true })).toBeVisible();
			expect(navigations).toEqual([]);
			if (entry === "Enter" || entry === "composition") await capture(page, `tags-library-${locale}-${width}`);
			await filterTag.click();
			await expect(filterTag).toHaveAttribute("aria-pressed", "true");
			await expect(card).toBeVisible();
		});
	}

	for (const width of [1440, 390]) {
		test.describe(`${locale} at ${width}px`, () => {
			test.use({ hasTouch: width === 390 });

			test("keeps the dialog in place while filtering and saves beside a stored long tag", async ({
				authPage: page,
			}) => {
				const longTag = "Career portfolio · November 2026 · Calendar";
				const tags = [longTag, "Work"];
				const { dialog, input, save, readTags } = await openTags(page, locale, width, tags);
				const list = dialog.getByRole("listbox");
				await expect(list.getByRole("option")).toHaveCount(2);
				await settleScreen(page);
				const bounds = await dialog.boundingBox();
				const listBounds = await list.boundingBox();
				expect(bounds).not.toBeNull();
				expect(listBounds).not.toBeNull();
				await capture(page, `stored-long-tag-${locale}-${width}`);

				await input.fill("x".repeat(41));
				await expect(list.getByRole("option")).toHaveCount(0);
				await expect(dialog.getByRole("alert")).toContainText(ar ? "40 حرفًا" : "40 characters or fewer");
				await expect(save).toBeDisabled();
				expect(await dialog.boundingBox()).toEqual(bounds);
				expect(await list.boundingBox()).toEqual(listBounds);
				await capture(page, `stored-long-tag-error-${locale}-${width}`);

				await input.fill("d");
				await expect(list.getByRole("option", { name: /Career portfolio/ })).toHaveAttribute("aria-checked", "true");
				await expect(dialog.getByRole("alert")).toHaveCount(0);
				await expect(save).toBeEnabled();
				expect(await dialog.boundingBox()).toEqual(bounds);
				expect(await list.boundingBox()).toEqual(listBounds);
				await capture(page, `stored-long-tag-filtered-${locale}-${width}`);
				await save.click();
				await expect(dialog).toBeHidden();
				expect(await readTags()).toEqual([...tags, "d"]);
			});

			test("shows library tags, validates drafts, and preserves untouched mixed tags", async ({ authPage: page }) => {
				const { card, dialog, id, input, save, readTags } = await openTags(page, locale, width);
				const cancel = dialog.getByRole("button", { name: ar ? "إلغاء" : "Cancel", exact: true });
				await expect(dialog.getByText(ar ? "لا توجد وسوم بعد." : "No tags yet.", { exact: false })).toBeVisible();
				await capture(page, `empty-library-${locale}-${width}`);

				const longTag = "Career portfolio · November 2026 · Calendar";
				await input.fill(longTag);
				await input.press("Enter");
				await expect(save).toBeDisabled();
				const notice = dialog.getByRole("alert");
				await expect(notice).toHaveAttribute("data-slot", "field-error");
				await expect(notice).toContainText(ar ? "40 حرفًا" : "40 characters or fewer");
				await expect(input).toHaveValue(longTag);
				expect(await readTags()).toEqual([]);
				await capture(page, `limit-error-${locale}-${width}`);
				await input.fill("Career portfolio");
				await save.click();
				await expect(dialog).toBeHidden();
				expect(await readTags()).toEqual(["Career portfolio"]);

				const api = variantClient(page);
				const otherName = ar ? "خطاب تجريبي" : "Synthetic letter";
				const { id: other } = await api.coverLetters.create({ name: otherName, documentLocale: locale });
				await api.documents.setTags({ id, type: "resume", tags: ["Work", "Career portfolio"] });
				await api.documents.setTags({ id: other, type: "letter", tags: ["Work", "أعمال"] });
				expect(await api.documents.tags()).toEqual([
					{ tag: "Work", count: 2 },
					{ tag: "Career portfolio", count: 1 },
					{ tag: "أعمال", count: 1 },
				]);
				await page.reload();
				await openCardTags(page, card, ar);
				const work = dialog.getByRole("option", { name: /Work/ });
				await expect(dialog.getByRole("option").first()).toHaveAccessibleName("Work 2");
				await expect(work).toHaveAttribute("aria-checked", "true");
				const checkmark = work.locator('[data-slot="checkbox-indicator"] [data-slot="icon"]');
				await expect(checkmark).toBeVisible();
				expect(await checkmark.evaluate((icon) => getComputedStyle(icon).color)).toBe(
					await work.locator('[data-slot="checkbox"]').evaluate((checkbox) => getComputedStyle(checkbox).color),
				);
				await capture(page, `existing-tags-${locale}-${width}`);
				await input.focus();
				await page.keyboard.press("Shift+Tab");
				await expect(
					dialog.getByRole("button", { name: ar ? "إزالة الوسم Career portfolio" : "Remove tag Career portfolio" }),
				).toBeFocused();

				await input.fill(ar ? "ملف جديد" : "New project");
				await expect(dialog.getByRole("option", { name: ar ? /إنشاء/ : /Create/ })).toBeVisible();
				await capture(page, `create-option-${locale}-${width}`);
				await cancel.click();
				await expect(dialog).toBeHidden();
				expect(await readTags()).toEqual(["Work", "Career portfolio"]);

				for (const item of [card, page.getByRole("article", { name: otherName, exact: true })]) {
					await item.getByRole("button", { name: ar ? "المزيد من الإجراءات" : "More actions", exact: true }).click();
					await page.getByRole("menuitem", { name: ar ? "تحديد" : "Select", exact: true }).click();
				}
				await page.getByRole("button", { name: ar ? "الوسوم" : "Tags", exact: true }).click();
				const batch = page.getByRole("dialog", { name: ar ? "وسوم مستندين" : "Tags for 2 documents" });
				await expect(batch.getByRole("option", { name: /Career portfolio/ })).toHaveAttribute("aria-checked", "mixed");
				await expect(batch.getByRole("option", { name: /أعمال/ })).toHaveAttribute("aria-checked", "mixed");
				await capture(page, `multiple-documents-${locale}-${width}`);
				await batch.getByRole("option", { name: /Career portfolio/ }).click();
				await batch.getByRole("button", { name: ar ? "حفظ" : "Save", exact: true }).click();
				await expect(batch).toBeHidden();
				expect(await readTags()).toEqual(["Work", "Career portfolio"]);
				const documents = await api.documents.list({ trashed: false });
				expect(documents.find((item) => item.id === other)?.tags).toEqual(["Work", "أعمال", "Career portfolio"]);
			});
		});
	}
}
