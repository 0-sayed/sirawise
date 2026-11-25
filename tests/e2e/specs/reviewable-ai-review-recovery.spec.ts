import type { Page } from "@playwright/test";
import { copyMessage } from "../fixtures/copy";
import { captureReviewDirection, openWriting, seedReview } from "../fixtures/reviewable-ai";
import { settleScreen } from "../fixtures/screen";
import { expect, test } from "../fixtures/test";
import {
	launchTailoringReview,
	readProcessingNotice,
	seedTailoringReview,
	seedVariantReview,
	startVariantReview,
	variantClient,
} from "../fixtures/variants";

async function noticeFor(page: Page, text: string | RegExp) {
	const notice = page.locator('[data-slot="alert"]').filter({ hasText: text }).first();
	await expect(notice).toBeVisible();
	await expect(notice).toHaveAttribute("data-variant", /warn|error/);
	await expect(notice.locator('[data-slot="icon"]')).toBeVisible();
	await expect(notice.locator('[data-slot="alert-title"]')).not.toBeEmpty();
	await expect(notice.locator('[data-slot="alert-description"]')).toContainText(text);
	await expect(notice.getByRole("button", { name: /^(Retry|إعادة المحاولة)$/u })).toBeEnabled();
	return notice;
}

for (const locale of ["en-US", "ar-SA"] as const)
	for (const width of [1440, 390])
		test(`dismissal and a stale displayed notice cannot start a review ${locale} ${width}`, async ({
			authPage: page,
		}, info) => {
			const ar = locale === "ar-SA";
			await page.setViewportSize({ width, height: 900 });
			const id = await seedReview(page, info, locale);
			const api = variantClient(page);
			const before = await api.resume.getById({ id });
			const usage = await api.ai.usage.get();
			const notice = await readProcessingNotice(page, "review.wording", locale);
			await openWriting(page, width);
			const launcher = page.getByRole("button", { name: ar ? "مراجعة الصياغة" : "Review wording", exact: true });
			const dialog = page.getByRole("dialog");
			const start = dialog.getByRole("button", { name: ar ? "بدء المراجعة" : "Start review", exact: true });
			await launcher.click();
			await expect(dialog.getByText(notice.content, { exact: true })).toBeVisible();
			await dialog.getByRole("button", { name: ar ? "إلغاء" : "Cancel", exact: true }).click();
			expect((await readProcessingNotice(page, "review.wording", locale)).alreadyGranted).toBe(false);

			let stale = true;
			await page.route(/\/ai\/processing\/notices(?:\/__batch__)?(?:\?|$)/u, async (route) => {
				if (!stale) return route.continue();
				const response = await route.fetch();
				const body = await response.text();
				expect(body).toContain(notice.acceptance.noticeSha256);
				await route.fulfill({ response, body: body.replace(notice.acceptance.noticeSha256, "f".repeat(64)) });
			});
			await launcher.click();
			await expect(dialog.getByText(notice.content, { exact: true })).toBeVisible();
			await start.click();
			const recovery = dialog.locator('[data-slot="alert"]').filter({
				hasText: copyMessage("review.launch.consentRequired", locale),
			});
			await expect(recovery).toHaveAttribute("data-variant", "warn");
			await expect(recovery).toContainText(copyMessage("review.launch.consentRequired", locale));
			expect(await api.ai.usage.get()).toEqual(usage);
			expect((await api.resume.getById({ id })).data).toEqual(before.data);
			expect((await readProcessingNotice(page, "review.wording", locale)).alreadyGranted).toBe(false);
			expect(await dialog.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
			await captureReviewDirection(page, info, "consent-stale");

			stale = false;
			await recovery.getByRole("button", { name: copyMessage("review.launch.reviewConsent", locale) }).click();
			await expect(dialog.getByText(notice.content, { exact: true })).toBeVisible();
			await start.click();
			await expect(page.getByTestId("durable-review")).toBeVisible({ timeout: 25000 });
			expect((await readProcessingNotice(page, "review.wording", locale)).alreadyGranted).toBe(true);
			expect((await api.resume.getById({ id })).data).toEqual(before.data);
		});

for (const locale of ["en-US", "ar-SA"] as const)
	for (const width of [1440, 390])
		test(`queue expiry shows localized recovery ${locale} ${width}`, async ({ authPage: page }, info) => {
			const ar = locale === "ar-SA";
			await page.setViewportSize({ width, height: 900 });
			await seedReview(page, info, locale);
			await openWriting(page, width);
			// The API integration test exercises the real queue clock and settlement.
			await page.route(/\/api\/rpc\/ai\/operations\/get(?:\?|$)/u, async (route) => {
				const response = await route.fetch();
				const { json } = await response.json();
				expect(json.id).toBeTruthy();
				await route.fulfill({
					response,
					json: { json: { id: json.id, state: "failed", resultId: null, failureCode: "AI_QUEUE_EXPIRED" } },
				});
			});
			await page.getByRole("button", { name: ar ? "مراجعة الصياغة" : "Review wording", exact: true }).click();
			await page
				.getByRole("dialog")
				.getByRole("button", { name: ar ? "بدء المراجعة" : "Start review", exact: true })
				.click();
			const notice = await noticeFor(page, copyMessage("review.failure.queueExpired", locale));
			await notice.scrollIntoViewIfNeeded();
			await expect(notice).toBeInViewport();
			expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
			await captureReviewDirection(page, info, "queue-expiry");
		});

for (const locale of ["en-US", "ar-SA"] as const)
	for (const width of [1440, 390])
		test(`concurrency notices keep the draft and offer retry in ${locale} at ${width}`, async ({
			authPage: page,
		}, info) => {
			const { copyId, original } = await seedTailoringReview(page, info);
			const api = variantClient(page);
			const usage = await api.ai.usage.get();
			await page.setViewportSize({ width, height: 900 });
			await expect(
				await page.request.post("/api/auth/update-user", {
					data: { uiLocale: locale },
					headers: { origin: String(info.project.use.baseURL) },
				}),
			).toBeOK();
			let accountFull = false;
			await page.route(/\/api\/rpc\/ai\/operations\/preflight(?:\/__batch__)?(?:\?|$)/u, async (route) => {
				const response = await route.fetch();
				const body = await response.text();
				const available = '"available":true,"reason":null';
				expect(body.split(available)).toHaveLength(2);
				await route.fulfill({
					response,
					body: body.replace(
						available,
						accountFull
							? '"available":false,"reason":"AI_CONCURRENCY_LIMIT","allowance":{"limit":3,"used":0,"reserved":3,"remaining":0}'
							: '"available":false,"reason":"AI_TARGET_BUSY"',
					),
				});
			});
			await page.goto(`/dashboard/resumes/${copyId}/job`);
			await settleScreen(page);
			const arabic = locale === "ar-SA";
			await expect(page.locator("html")).toHaveAttribute("dir", arabic ? "rtl" : "ltr");
			await page.getByRole("button", { name: /^(Review tailored wording|مراجعة الصياغة المخصصة)$/u }).click();
			const dialog = page.getByRole("dialog");
			await dialog.getByRole("button", { name: /^(Start review|بدء المراجعة)$/u }).click();
			const notice = dialog.getByRole("alert");
			await expect(notice).toContainText(copyMessage("allowance.target.description", locale));
			await expect(notice).toContainText(copyMessage("allowance.target.next", locale));
			const retry = notice.getByRole("button", { name: /^(Retry|إعادة المحاولة)$/u });
			await expect(retry).toBeEnabled();
			await dialog.screenshot({ path: info.outputPath("target-busy.png") });
			accountFull = true;
			await retry.click();
			await expect(notice).toContainText(arabic ? "3 من 3" : "3 of 3");
			await expect(notice).toContainText(copyMessage("allowance.concurrent.next", locale));
			await expect(retry).toBeEnabled();
			expect(await dialog.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
			await dialog.screenshot({ path: info.outputPath("account-limit.png") });
			expect(await api.ai.usage.get()).toEqual(usage);
			expect((await api.resume.getById({ id: copyId })).data).toEqual(original.data);
		});

test("copy allowance denial keeps the CV, family and operation balance unchanged", async ({ authPage: page }, info) => {
	const { sourceId, original } = await seedTailoringReview(page, info);
	const api = variantClient(page);
	const before = await api.ai.usage.get();
	const family = await api.resume.variants.list({ resumeId: sourceId });
	await page.goto(`/dashboard/resumes/${sourceId}/job`);
	// Select the exact same ad on the original without creating another copy.
	const job = await api.career.jobTargets.save({ role: "Engineer", employer: "", text: "TypeScript required." });
	await api.career.jobTargets.select({
		resumeId: sourceId,
		expectedUpdatedAt: original.updatedAt.toISOString(),
		jobId: job.jobId,
		jobRevision: job.revision,
		expectedSelectionRevision: null,
	});
	await page.reload();
	await page.getByRole("button", { name: "Create tailored copy", exact: true }).click();
	const notice = await noticeFor(page, "1 of 1 job copies used for this base CV. 0 being created.");
	await expect(notice.locator('[data-slot="alert-title"]')).toHaveText("Job copy limit reached");
	await expect(notice.getByRole("button", { name: "Open saved CV", exact: true })).toBeVisible();
	await notice.getByRole("button", { name: "Retry", exact: true }).click();
	await expect(notice).toBeVisible();
	expect(await api.ai.usage.get()).toEqual(before);
	expect(await api.resume.variants.list({ resumeId: sourceId })).toEqual(family);
	expect((await api.resume.getById({ id: sourceId })).data).toEqual(original.data);
});

test("exhausted operation allowance denies a new review without reserving or deducting another operation", async ({
	authPage: page,
}, info) => {
	test.setTimeout(90000);
	const { copyId, original } = await seedTailoringReview(page, info);
	const api = variantClient(page);
	const cv = await api.resume.getById({ id: copyId });
	const selection = (await api.career.jobTargets.evidence({ resumeId: copyId })).selection;
	if (!selection) throw new Error("Expected selected job");
	const prepared = await api.ai.variantReview.prepare({
		kind: "review.tailoring",
		resumeId: copyId,
		expectedUpdatedAt: cv.updatedAt.toISOString(),
		jobId: selection.jobId,
		jobRevision: selection.jobRevision,
		expectedSelectionRevision: selection.revision,
	});
	for (let i = 0; i < 5; i++) await startVariantReview(page, prepared);
	const before = await api.ai.usage.get();
	expect(before.operations).toMatchObject({ used: 5, reserved: 0, remaining: 0 });
	const { acceptance: notice } = await readProcessingNotice(page, prepared.kind);
	const denied = await page.request.post("/api/openapi/ai/operations", {
		data: {
			kind: prepared.kind,
			sources: prepared.sources,
			parameters: prepared.parameters,
			requestKey: crypto.randomUUID(),
			route: notice.route,
			consentVersion: notice.noticeVersion,
		},
	});
	expect(denied.status()).toBe(412);
	await page.goto(`/dashboard/resumes/${copyId}/job`);
	const recovery = page
		.locator('[data-slot="alert"]')
		.filter({ hasText: "5 of 5 AI uses used. 0 reserved for operations in progress." })
		.first();
	await expect(recovery).toBeVisible({ timeout: 25000 });
	await expect(recovery.locator('[data-slot="icon"]')).toBeVisible();
	await expect(recovery.locator('[data-slot="alert-title"]')).toHaveText("AI use limit reached");
	await expect(recovery.locator('[data-slot="alert-description"]')).toContainText(
		"This allowance does not reset automatically. Continue editing manually or contact support. Your draft is kept.",
	);
	await expect(page.getByRole("button", { name: "Review job evidence", exact: true })).toBeDisabled();
	await expect(page.getByRole("button", { name: "Review tailored wording", exact: true })).toBeDisabled();
	expect(await api.ai.usage.get()).toEqual(before);
	expect((await api.resume.getById({ id: copyId })).data).toEqual(original.data);
});

test("editing the CV after preparing tailoring makes proposals stale and preserves the manual edit", async ({
	authPage: page,
}, info) => {
	const { copyId, sourceId, original } = await seedTailoringReview(page, info);
	const api = variantClient(page);
	await launchTailoringReview(page, copyId);
	await expect(page.locator("[data-proposal-index]")).toHaveCount(3, { timeout: 30000 });
	// A second browser tab performs a genuine editor autosave after preparation.
	const editor = await page.context().newPage();
	await editor.goto(`/builder/${copyId}`);
	await editor.getByLabel("Full name", { exact: true }).fill("Synthetic manual correction");
	await expect
		.poll(async () => (await api.resume.getById({ id: copyId })).data.basics.name)
		.toBe("Synthetic manual correction");
	await editor.close();
	await page.reload();
	const stale = await noticeFor(page, "The source or this copy changed. Keep your work and request a new review.");
	await expect(
		page.locator("[data-proposal-index]").filter({ hasText: "Out of date: the text has changed since." }),
	).toHaveCount(3);
	await expect(page.getByRole("button", { name: "Suggest again", exact: true })).toHaveCount(0);
	await expect(page.getByRole("button", { name: "Accept", exact: true })).toHaveCount(0);
	await stale.getByRole("button", { name: "Retry", exact: true }).click();
	await expect(stale).toBeVisible();
	await launchTailoringReview(page, copyId);
	await expect(page.locator("[data-proposal-index]").getByRole("button", { name: "Accept", exact: true })).toHaveCount(
		3,
		{ timeout: 30000 },
	);
	expect((await api.resume.getById({ id: copyId })).data.basics.name).toBe("Synthetic manual correction");
	expect((await api.resume.getById({ id: sourceId })).data).toEqual(original.data);
});

test("partial job evidence has a complete recovery notice and retains the literal result and CV", async ({
	authPage: page,
}, info) => {
	const id = await seedVariantReview(page, info);
	const api = variantClient(page);
	const original = await api.resume.getById({ id });
	await page.goto(`/dashboard/resumes/${id}/job`);
	await page.getByLabel("Job title", { exact: true }).fill("Engineer");
	await page.getByLabel("Job ad", { exact: true }).fill("TypeScript and SAP required");
	await page.getByRole("button", { name: "Compare", exact: true }).click();
	await expect.poll(async () => (await api.career.jobTargets.evidence({ resumeId: id })).literal).not.toBeNull();
	const literal = await api.career.jobTargets.evidence({ resumeId: id });
	await page.getByRole("button", { name: "Review job evidence", exact: true }).click();
	await page.getByRole("dialog").getByRole("button", { name: "Start review", exact: true }).click();
	const recovery = await noticeFor(
		page,
		"Only part of the job requirement is supported by this CV. Add confirmed information or request a new review.",
	);
	await recovery.getByRole("button", { name: "Retry", exact: true }).click();
	await expect(page.getByRole("button", { name: "Add information", exact: true })).toBeEnabled();
	expect((await api.career.jobTargets.evidence({ resumeId: id })).literal).toEqual(literal.literal);
	expect((await api.resume.getById({ id })).data).toEqual(original.data);
});

test("failed tailoring releases its reservation and offers recovery without changing the CV", async ({
	authPage: page,
}, info) => {
	const { copyId, original } = await seedTailoringReview(page, info, "Synthetic provider failure");
	const api = variantClient(page);
	await launchTailoringReview(page, copyId);
	const recovery = await noticeFor(
		page,
		"The AI service did not finish this review. Your draft is kept. Retry can help after a temporary service failure.",
	);
	await recovery.getByRole("button", { name: "Retry", exact: true }).click();
	await expect(page.getByRole("dialog").getByRole("button", { name: "Start review", exact: true })).toBeEnabled();
	expect((await api.ai.usage.get()).operations).toMatchObject({ used: 0, reserved: 0 });
	expect((await api.resume.getById({ id: copyId })).data).toEqual(original.data);
});

test("unavailable processing can recover in the browser without a deduction or document mutation", async ({
	authPage: page,
}, info) => {
	const { copyId, original } = await seedTailoringReview(page, info);
	const api = variantClient(page);
	const endpoint = /\/api\/rpc\/ai\/availability(?:\/__batch__)?(?:\?|$)/u;
	await page.route(endpoint, async (route) => {
		const response = await route.fetch();
		const body = await response.text();
		const ready = '"json":{"state":"ready","reason":null}';
		expect(body.split(ready)).toHaveLength(2);
		await route.fulfill({
			response,
			body: body.replace(ready, '"json":{"state":"unavailable","reason":"SYNTHETIC_UNAVAILABLE"}'),
		});
	});
	await page.goto(`/dashboard/resumes/${copyId}/job`);
	const recovery = await noticeFor(
		page,
		"Nothing in your CV changed. No operation was deducted from your allowance. Keep writing yourself and try again later.",
	);
	await page.unroute(endpoint);
	await recovery.getByRole("button", { name: "Retry", exact: true }).click();
	await expect(page.getByRole("button", { name: "Review tailored wording", exact: true })).toBeEnabled();
	expect((await api.ai.usage.get()).operations).toMatchObject({ used: 0, reserved: 0 });
	expect((await api.resume.getById({ id: copyId })).data).toEqual(original.data);
});
