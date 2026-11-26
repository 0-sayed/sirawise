import { confirmPdfSections, openPdfReview } from "../fixtures/import-review";
import { openWriting, seedReview, seedReviewBudget, startReview } from "../fixtures/reviewable-ai";
import { expect, test } from "../fixtures/test";

test("extraction withholds the invented field and saves the supported field after approval", async ({
	authPage: page,
}) => {
	await page.setViewportSize({ width: 1440, height: 900 });
	await seedReviewBudget();
	await openPdfReview(page, "en-US");
	const list = async () => (await page.request.get("/api/openapi/resumes")).json();
	const initial = await list();
	await page.getByRole("button", { name: "Open text assistance", exact: true }).click();
	await page.getByRole("combobox", { name: "Section to review", exact: true }).selectOption("experience");
	const field = page.getByRole("textbox", { name: /Native extracted text/ });
	await field.evaluate((element: HTMLTextAreaElement) => {
		const match = /Built\s+secure\s+services/u.exec(element.value);
		if (!match) throw new Error("Missing synthetic experience passage");
		element.focus();
		element.setSelectionRange(match.index, match.index + match[0].length - 1);
	});
	await page.keyboard.press("Shift+ArrowRight");
	await page.getByRole("button", { name: "Review selected text", exact: true }).click();
	await page.getByRole("dialog").getByRole("button", { name: "Start review", exact: true }).click();
	const approve = page.getByRole("button", { name: "Use in draft", exact: true });
	await expect(approve).toHaveCount(1, { timeout: 25_000 });
	await expect(page.getByText("Which employer can you confirm?", { exact: true })).toBeVisible();
	await expect(page.getByText("Invented Employer", { exact: true })).toHaveCount(0);
	expect(await list()).toEqual(initial);
	await page.getByRole("combobox", { name: "Add to which entry?", exact: true }).selectOption("new");
	await approve.click();
	expect(await list()).toEqual(initial);
	const create = page.getByRole("button", { name: "Create CV only", exact: true });
	await expect(create).toBeDisabled();
	await confirmPdfSections(page);
	await create.click();
	await expect(page).toHaveURL(/\/builder\//u);
	const id = new URL(page.url()).pathname.split("/").at(-1);
	const saved = await (await page.request.get(`/api/openapi/resumes/${id}`)).json();
	expect(saved.data.sections.experience.items.at(-1)).toMatchObject({
		description: "<p>Built secure services</p>",
		company: "",
	});
});

for (const locale of ["en-US", "ar-SA"] as const)
	for (const width of [1440, 390])
		test(`${locale} ${width} pending wording stays with its field and repeated blocks remain independent`, async ({
			authPage: page,
		}, info) => {
			test.setTimeout(90000);
			await page.setViewportSize({ width, height: 900 });
			const id = await seedReview(page, info, locale);
			const saved = async () => (await page.request.get(`/api/openapi/resumes/${id}`)).json();
			const original = await saved();
			const entry = original.data.sections.experience.items[0];
			if (!entry) throw new Error("Expected synthetic experience");
			original.data.summary.content = "<p>Built services.</p><p>Built services.</p>";
			entry.description = "<p>Built services.</p>";
			const response = await page.request.put(`/api/openapi/resumes/${id}`, {
				data: { data: original.data, expectedUpdatedAt: original.updatedAt },
			});
			expect(response.ok()).toBe(true);
			await page.reload();
			await openWriting(page, width);
			const target = { sectionId: "experience", itemId: entry.id, field: "description" };
			const summaryTarget = { sectionId: "summary", field: "content" };
			const field = page.getByRole("combobox", {
				name: locale === "ar-SA" ? "النص المطلوب مراجعته" : "Text to review",
			});
			await field.selectOption(JSON.stringify(summaryTarget));
			const review = await startReview(page);
			const accept = review.getByRole("button", { name: /^(Accept|قبول)$/u });
			await expect(accept).toBeEnabled();
			await field.selectOption(JSON.stringify(target));
			await expect(review).toBeVisible();
			const experience = await startReview(page, true);
			const acceptExperience = experience.getByRole("button", { name: /^(Accept|قبول)$/u });
			await expect(acceptExperience).toBeEnabled();
			await expect(page.getByTestId("durable-review")).toHaveCount(2);
			await page.screenshot({ path: info.outputPath("pending-fields.png") });
			await page.reload();
			await openWriting(page, width);
			await expect(acceptExperience).toBeEnabled();
			await expect(accept).toBeEnabled();
			await accept.click();
			await expect
				.poll(async () => (await saved()).data.summary.content)
				.toBe("<p>Developed services.</p><p>Built services.</p>");
			await expect(review.locator(".review-wording del")).toBeHidden();
			await expect(acceptExperience).toBeEnabled();
			await experience.getByRole("button", { name: /^(Keep original|الإبقاء على الأصل)$/u }).click();
			await expect(acceptExperience).toHaveCount(0);
			expect((await saved()).data.sections.experience.items[0].description).toBe("<p>Built services.</p>");
			expect((await (await page.request.get("/api/openapi/ai/usage")).json()).operations.used).toBe(2);
		});
