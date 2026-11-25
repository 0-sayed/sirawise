import { buildCareerFactCandidates } from "@reactive-resume/import/career-facts";
import { importReviewInputSchema } from "@reactive-resume/schema/resume/import-review";
import { openPdfReview } from "../fixtures/import-review";
import { rpcRequestPaths } from "../fixtures/rpc-failure";
import { expect, test } from "../fixtures/test";

for (const locale of ["en-US", "ar-SA"] as const)
	for (const width of [1440, 390])
		test(`base CV limit keeps the review and offers real recovery ${locale} ${width}`, async ({
			authPage: page,
			baseURL,
		}, testInfo) => {
			if (!baseURL) throw new Error("Missing browser base URL");
			const ar = locale === "ar-SA";
			await page.setViewportSize({ width, height: 900 });
			await page.context().addCookies([{ name: "locale", value: locale, url: baseURL }]);
			const created = await page.request.post("/api/openapi/resumes", {
				data: { name: "Existing synthetic CV", tags: [], locale: "en-US", empty: true, withSampleData: false },
			});
			expect(created.ok()).toBe(true);
			const id = await created.json();
			const read = async () => (await page.request.get(`/api/openapi/resumes/${id}`)).json();
			const before = await read();
			await openPdfReview(page, locale);
			const reviewUrl = page.url();
			await page
				.getByRole("button", { name: ar ? "تأكيد بقية المعلومات" : "Confirm all remaining", exact: true })
				.click();
			await page
				.getByRole("button", {
					name: ar ? "إنشاء السيرة وحفظ المعلومات المهنية" : "Create CV and save career information",
					exact: true,
				})
				.click();
			const limit = page
				.locator('[data-slot="alert"]')
				.filter({ hasText: ar ? "وصلت إلى حد السير الأساسية" : "Base CV limit reached" });
			await expect(limit).toBeVisible();
			await expect(limit).toContainText(ar ? "سيرة ذاتية أساسية واحدة" : "1 base CV");
			await expect(
				page.getByRole("button", { name: ar ? "حفظ المعلومات المؤكدة فقط" : "Save confirmed facts only", exact: true }),
			).toBeEnabled();
			expect(await read()).toEqual(before);
			await limit.scrollIntoViewIfNeeded();
			expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
			await page.screenshot({ path: testInfo.outputPath("base-cv-limit.png") });
			await page
				.getByRole("button", { name: ar ? "حفظ المعلومات المؤكدة فقط" : "Save confirmed facts only", exact: true })
				.click();
			await expect(
				page
					.getByRole("status")
					.filter({ hasText: ar ? "حُفظت المعلومات المؤكدة" : "Confirmed facts saved to Career information" }),
			).toBeVisible();
			expect(await read()).toEqual(before);
			const career = await (await page.request.get("/api/openapi/career/master")).json();
			expect(career.facts.length).toBeGreaterThan(0);
			expect(career.facts.every((fact: { confirmation: string }) => fact.confirmation === "confirmed")).toBe(true);
			await page.getByRole("button", { name: ar ? "فتح السيرة الحالية" : "Open existing CV", exact: true }).click();
			await expect(page).toHaveURL(new RegExp(`/builder/${id}`));
			await page.goto(reviewUrl);
			await expect(
				page.getByRole("heading", {
					name: ar ? "راجع المعلومات المستوردة" : "Review imported information",
					exact: true,
				}),
			).toBeVisible();
			await page
				.getByRole("button", {
					name: ar ? "إنشاء السيرة وحفظ المعلومات المهنية" : "Create CV and save career information",
					exact: true,
				})
				.click();
			const replace = limit.getByRole("button", {
				name: ar ? "استبدال السيرة الأساسية الحالية" : "Replace existing base CV",
				exact: true,
			});
			await replace.click();
			let approval = page.getByRole("alertdialog");
			await expect(approval).toContainText("Existing synthetic CV");
			await approval.getByRole("button", { name: ar ? "إلغاء" : "Cancel", exact: true }).click();
			await expect(approval).toBeHidden();
			expect(await read()).toEqual(before);
			await replace.click();
			approval = page.getByRole("alertdialog");
			await approval
				.getByRole("button", { name: ar ? "استبدال السيرة الأساسية الحالية" : "Replace existing base CV", exact: true })
				.click();
			await expect(page).toHaveURL(new RegExp(`/builder/${id}`));
			const after = await read();
			expect(after.id).toBe(id);
			expect(after.data.basics.name).not.toBe(before.data.basics.name);
			const cvs = await (await page.request.get("/api/openapi/resumes")).json();
			expect(cvs).toHaveLength(1);
			const history = await (await page.request.get(`/api/openapi/resumes/${id}/versions`)).json();
			expect(history).toEqual(
				expect.arrayContaining([
					expect.objectContaining({ kind: "created" }),
					expect.objectContaining({ kind: "named", name: "Existing synthetic CV" }),
					expect.objectContaining({ kind: "import" }),
				]),
			);
		});

test("manual creates an empty CV in the chosen document language directly in Write", async ({ authPage: page }) => {
	await page.goto("/dashboard");
	const master = await (await page.request.get("/api/openapi/career/master")).json();
	await page.getByRole("button", { name: "New CV", exact: true }).click();
	await page.getByRole("radio", { name: "Arabic", exact: true }).click();
	await page.getByRole("button", { name: /^Write from scratch/ }).click();
	await expect(page).toHaveURL(/\/builder\/[^/?]+/);
	expect(new URL(page.url()).searchParams.get("mode")).toBe("write");
	await expect(page.locator('[data-slot="dialog-content"]')).not.toBeVisible();
	await expect(page.getByRole("heading", { name: "Review imported information", exact: true })).toHaveCount(0);
	const id = new URL(page.url()).pathname.split("/").at(-1);
	const cv = await (await page.request.get(`/api/openapi/resumes/${id}`)).json();
	expect(cv.data.metadata.page.locale).toBe("ar-SA");
	expect(cv.data.basics.name).toBe("");
	expect(cv.data.sections.experience.items).toEqual([]);
	expect(await (await page.request.get("/api/openapi/career/master")).json()).toEqual(master);
	await expect(page.getByRole("button", { name: "Use confirmed career information", exact: true })).toBeVisible();
});

test("section review survives refresh; Cancel removes the local draft without creating a CV", async ({
	authPage: page,
}) => {
	await page.goto("/dashboard");
	const before = await (await page.request.get("/api/openapi/resumes")).json();
	const master = await (await page.request.get("/api/openapi/career/master")).json();
	await openPdfReview(page);
	const url = page.url();
	await page.getByLabel("Full name", { exact: true }).fill("Local unsaved review");
	await page.getByRole("button", { name: "Confirm section", exact: true }).click();
	await expect
		.poll(() =>
			page.evaluate(async () => {
				const db = await new Promise<IDBDatabase>((resolve, reject) => {
					const req = indexedDB.open("master-cv-import-review", 1);
					req.onsuccess = () => resolve(req.result);
					req.onerror = () => reject(req.error);
				});
				try {
					return await new Promise<boolean>((resolve, reject) => {
						const req = db.transaction("drafts").objectStore("drafts").getAll();
						req.onsuccess = () =>
							resolve(
								req.result.some(
									(row) => row.state.data.basics.name === "Local unsaved review" && row.state.reviewed.basics,
								),
							);
						req.onerror = () => reject(req.error);
					});
				} finally {
					db.close();
				}
			}),
		)
		.toBe(true);
	await page.reload();
	await expect(page.getByLabel("Full name", { exact: true })).toHaveValue("Local unsaved review");
	await expect(page.getByRole("status", { name: "Review progress" })).toContainText(/^1 of /);
	await page.getByRole("button", { name: "Cancel", exact: true }).click();
	await expect(page).toHaveURL(/\/dashboard(?:\?|$)/);
	expect(await (await page.request.get("/api/openapi/resumes")).json()).toEqual(before);
	expect(await (await page.request.get("/api/openapi/career/master")).json()).toEqual(master);
	await page.goto(url);
	await expect(
		page
			.locator('[data-slot="alert"]')
			.filter({ hasText: "This import review has expired or is unavailable on this device. Choose your file again." }),
	).toBeVisible();
});

test("mobile review switches between one section and its original PDF", async ({ authPage: page }) => {
	await page.setViewportSize({ width: 390, height: 900 });
	await openPdfReview(page);
	await expect(page.getByLabel("Full name", { exact: true })).toBeVisible();
	await page.getByRole("tab", { name: "Original PDF", exact: true }).click();
	await expect(page.getByRole("region", { name: "Original PDF", exact: true })).toBeVisible();
	await expect(page.locator("canvas")).toBeVisible();
	await expect(page.getByLabel("Full name", { exact: true })).not.toBeVisible();
	await page.getByRole("tab", { name: "Extracted information", exact: true }).click();
	await expect(page.getByLabel("Full name", { exact: true })).toBeVisible();
	expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});

for (const locale of ["en-US", "ar-SA"] as const)
	for (const width of [1440, 390])
		test(`reviewed PDF saves career information for a new account ${locale} ${width}`, async ({
			authPage: page,
			baseURL,
		}, testInfo) => {
			if (!baseURL) throw new Error("Missing browser base URL");
			const ar = locale === "ar-SA";
			await page.setViewportSize({ width, height: 900 });
			await page.context().addCookies([{ name: "locale", value: locale, url: baseURL }]);
			const before = await (await page.request.get("/api/openapi/career/master")).json();
			expect(before.facts).toEqual([]);
			await openPdfReview(page, locale);
			await expect(
				page.getByRole("button", { name: ar ? "إنشاء السيرة فقط" : "Create CV only", exact: true }),
			).toBeVisible();
			const navigation = page.getByRole("navigation", { name: ar ? "أقسام المراجعة" : "Review sections" });
			const buttons = await navigation.getByRole("button").all();
			for (const [index, button] of buttons.entries()) {
				await button.click();
				const entries = page.getByRole("button", { name: ar ? "تأكيد العنصر" : "Confirm entry", exact: true });
				for (const entry of await entries.all()) await expect(entry).toHaveAttribute("data-variant", "primary");
				if (index % 2 && (await entries.count())) for (const entry of await entries.all()) await entry.click();
				else await page.getByRole("button", { name: ar ? "تأكيد القسم" : "Confirm section", exact: true }).click();
			}
			const create = page.getByRole("button", {
				name: ar ? "إنشاء السيرة وحفظ المعلومات المهنية" : "Create CV and save career information",
				exact: true,
			});
			await expect(create).toBeEnabled();
			await create.scrollIntoViewIfNeeded();
			expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
			await page.screenshot({ path: testInfo.outputPath("save-career-information.png") });
			const sending = page.waitForRequest(
				(request) => request.method() === "POST" && rpcRequestPaths(request).includes("/api/rpc/resume/confirmImport"),
			);
			await create.click();
			const request = await sending;
			const raw = request.postDataJSON();
			const item = Array.isArray(raw)
				? raw.find((entry: { url: string }) => new URL(entry.url).pathname === "/api/rpc/resume/confirmImport")
				: { body: raw };
			const body = typeof item.body === "string" ? JSON.parse(item.body) : item.body;
			const input = importReviewInputSchema.parse(body.json);
			const expected = buildCareerFactCandidates(input.data, { kind: "manual", id: input.flowId, quote: "" });
			expect(expected.length).toBeGreaterThan(0);
			expect(
				input.acceptedFacts.map(({ fact }) => ({ ...fact, source: { kind: "manual", id: input.flowId, quote: "" } })),
			).toEqual(expected);
			await expect(page).toHaveURL(/\/builder\/[^/?]+/);
			const after = await (await page.request.get("/api/openapi/career/master")).json();
			expect(after.facts).toHaveLength(expected.length);
			for (const fact of expected)
				expect(after.facts).toContainEqual(
					expect.objectContaining({
						confirmation: "confirmed",
						structured: expect.objectContaining({
							section: fact.section,
							entityId: fact.entityId,
							field: fact.field,
							value: fact.value,
						}),
					}),
				);
			expect(after.contact).toEqual({
				name: input.data.basics.name,
				email: input.data.basics.email,
				phone: input.data.basics.phone,
				location: input.data.basics.location,
			});
			expect(after.contact.name).not.toBe("");
		});
