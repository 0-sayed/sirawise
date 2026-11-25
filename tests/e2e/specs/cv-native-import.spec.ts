import { confirmPdfSections, openPdfReview } from "../fixtures/import-review";
import { expect, test } from "../fixtures/test";
test("native PDF opens editable review before any CV or master is written", async ({ authPage: page }) => {
	await page.goto("/dashboard");
	const before = await (await page.request.get("/api/openapi/resumes")).json();
	const master = await (await page.request.get("/api/openapi/career/master")).json();
	await openPdfReview(page);
	await expect(page.locator('[data-slot="dialog-content"]')).not.toBeVisible();
	await expect(page.getByRole("region", { name: "Original PDF", exact: true })).toBeVisible();
	expect(await (await page.request.get("/api/openapi/resumes")).json()).toEqual(before);
	await page.getByLabel("Full name", { exact: true }).fill("Corrected native author");
	await expect(page.getByRole("button", { name: "Create CV only", exact: true })).toBeDisabled();
	await confirmPdfSections(page);
	await page.getByRole("button", { name: "Create CV only", exact: true }).click();
	await expect(page).toHaveURL(/\/builder\//);
	const id = new URL(page.url()).pathname.split("/").at(-1);
	expect((await (await page.request.get(`/api/openapi/resumes/${id}`)).json()).data.basics.name).toBe(
		"Corrected native author",
	);
	expect(await (await page.request.get("/api/openapi/career/master")).json()).toEqual(master);
});
