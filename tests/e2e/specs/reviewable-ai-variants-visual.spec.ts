import { captureReviewDirection, expectReviewTextDirection, seedReview } from "../fixtures/reviewable-ai";
import { settleScreen } from "../fixtures/screen";
import { expect, test } from "../fixtures/test";
import { translationAlignmentSentences } from "../fixtures/variant-transport";
import {
	launchTailoringReview,
	seedTailoringReview,
	seedVariantReview,
	startVariantReview,
	variantClient,
} from "../fixtures/variants";
for (const locale of ["ar-SA", "en-US"] as const)
	for (const width of [1440, 390])
		test(`job and language surfaces ${locale} ${width}`, async ({ authPage: page }, info) => {
			const id = await seedReview(page, info, locale, locale === "ar-SA" ? "en-US" : "ar-SA");
			await page.setViewportSize({ width, height: 900 });
			for (const screen of ["job", "languages"]) {
				await page.goto(`/dashboard/resumes/${id}/${screen}`);
				await settleScreen(page);
				await expect(page.locator("h1")).toBeVisible();
				expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
				expect(
					await page.evaluate(
						(family) => document.fonts.check(`14px "${family}"`),
						locale === "ar-SA" ? "Noto Sans Arabic" : "Noto Sans",
					),
				).toBe(true);
				await page.screenshot({ path: info.outputPath(`${screen}.png`), fullPage: true });
			}
		});

for (const locale of ["ar-SA", "en-US"] as const)
	for (const width of [1440, 390])
		test(`translation comparison keeps both text directions in ${locale} at ${width}`, async ({
			authPage: page,
		}, info) => {
			test.setTimeout(60_000);
			const ar = locale === "ar-SA";
			const documentLocale = ar ? "en-US" : "ar-SA";
			const original = translationAlignmentSentences[documentLocale];
			const translated = translationAlignmentSentences[locale];
			await page.setViewportSize({ width, height: 900 });
			const id = await seedVariantReview(page, info, false, documentLocale);
			const api = variantClient(page);
			const current = await api.resume.getById({ id });
			current.data.basics.headline = "";
			current.data.summary.content = `<p>${original}</p>`;
			const source = await api.resume.update({
				id,
				data: current.data,
				expectedUpdatedAt: current.updatedAt.toISOString(),
			});
			const copy = await api.resume.variants.create({
				sourceResumeId: id,
				expectedUpdatedAt: source.updatedAt.toISOString(),
				variantKind: "language",
				targetLocale: locale,
				requestKey: crypto.randomUUID(),
			});
			const prepared = await api.ai.variantReview.prepare({
				kind: "review.translation",
				resumeId: copy.resumeId,
				expectedUpdatedAt: copy.updatedAt,
				expectedSourceRevision: source.updatedAt.toISOString(),
			});
			await startVariantReview(page, prepared);
			await expect(
				await page.request.post("/api/auth/update-user", {
					data: { uiLocale: locale },
					headers: { origin: String(info.project.use.baseURL) },
				}),
			).toBeOK();
			await page.goto(`/dashboard/resumes/${id}/languages`);
			await page.getByRole("button", { name: /^(Compare with original|مقارنة بالأصل)$/u }).click();
			const previewSummary = page.locator("details").filter({
				has: page.locator("summary").filter({ hasText: /^(Summary|الملخّص)/u }),
			});
			await expect(previewSummary).toHaveAttribute("open", "");
			const before = previewSummary.locator("blockquote").filter({ has: page.getByText(original, { exact: true }) });
			const after = previewSummary
				.locator(ar ? 'p[dir="rtl"]' : 'p[dir="ltr"]')
				.filter({ has: page.getByText(translated, { exact: true }) });
			await expect(before).toHaveAttribute("dir", "auto");
			await expect(before).toHaveCSS("text-align", "start");
			await expect(before.locator("bdi")).toHaveCSS("direction", ar ? "ltr" : "rtl");
			await expect(after).toHaveCSS("direction", ar ? "rtl" : "ltr");
			await expect(after).toHaveCSS("text-align", "start");
			await before.scrollIntoViewIfNeeded();
			await captureReviewDirection(page, info, "translation");
		});

for (const locale of ["en-US", "ar-SA"] as const)
	for (const width of [1440, 390])
		test(`tailoring decisions and failed-review notice ${locale} ${width}`, async ({ authPage: page }, info) => {
			test.setTimeout(60000);
			const ar = locale === "ar-SA";
			const { copyId, sourceId, original } = await seedTailoringReview(page, info, undefined, ar ? "en-US" : "ar-SA");
			const api = variantClient(page);
			await page.setViewportSize({ width, height: 900 });
			await expect(
				await page.request.post("/api/auth/update-user", {
					data: { uiLocale: locale },
					headers: { origin: String(info.project.use.baseURL) },
				}),
			).toBeOK();
			await launchTailoringReview(page, copyId);
			const proposals = page.locator("[data-proposal-index]");
			await expect(proposals).toHaveCount(3, { timeout: 30000 });
			const passages = proposals.first().locator('.review-wording p[dir="auto"]');
			await expect(passages).toHaveCount(1);
			await expectReviewTextDirection(passages, ar ? "ltr" : "rtl");
			const changes = page.getByRole("radio", { name: ar ? "عرض التغييرات" : "Show changes", exact: true });
			const final = page.getByRole("radio", { name: ar ? "عرض النص النهائي" : "Show final", exact: true });
			await expect(changes).toBeChecked();
			await final.click();
			await expect(proposals.locator(".review-wording ins, .review-wording del")).toHaveCount(0);
			await changes.click();
			await expect(proposals.first().locator(".review-wording ins")).toBeVisible();
			await proposals.first().focus();
			await page.keyboard.press("ArrowDown");
			await expect(proposals.nth(1)).toBeFocused();
			await page.keyboard.press("ArrowUp");
			await expect(proposals.first()).toBeFocused();
			await proposals.first().scrollIntoViewIfNeeded();
			await settleScreen(page);
			await expect(page.locator("html")).toHaveAttribute("dir", locale === "ar-SA" ? "rtl" : "ltr");
			expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
			expect(
				await page.evaluate(
					(family) => document.fonts.check(`14px "${family}"`),
					locale === "ar-SA" ? "Noto Sans Arabic" : "Noto Sans",
				),
			).toBe(true);
			await page.screenshot({ path: info.outputPath("tailoring-proposals.png"), fullPage: true });
			await captureReviewDirection(page, info, "tailoring");
			await proposals
				.first()
				.getByRole("button", { name: /^(Accept|قبول)$/u })
				.click();
			await expect
				.poll(async () => (await api.resume.getById({ id: copyId })).data.summary.content)
				.toBe(
					ar
						? "<p>Developed TypeScript services. Did not manage a budget.</p>"
						: "<p>طورت خدمات باستخدام تايب سكريبت. لم أدر ميزانية.</p>",
				);
			await page.reload();
			await expect(proposals).toHaveCount(3);
			await expect(proposals.first().getByRole("button", { name: /^(Accept|قبول)$/u })).toHaveCount(0);
			const cv = await api.resume.getById({ id: copyId });
			const selected = (await api.career.jobTargets.evidence({ resumeId: copyId })).selection;
			if (!selected) throw new Error("Expected selected job");
			const job = await api.career.jobTargets.save({
				role: "Synthetic recovery",
				employer: "",
				text: "Synthetic provider failure",
			});
			await api.career.jobTargets.select({
				resumeId: copyId,
				expectedUpdatedAt: cv.updatedAt.toISOString(),
				jobId: job.jobId,
				jobRevision: job.revision,
				expectedSelectionRevision: selected.revision,
			});
			await launchTailoringReview(page, copyId, true);
			const failureDescription = ar
				? "لم تُكمل خدمة الذكاء الاصطناعي هذه المراجعة. مسودتك محفوظة. قد تنجح إعادة المحاولة بعد عطل مؤقت في الخدمة."
				: "The AI service did not finish this review. Your draft is kept. Retry can help after a temporary service failure.";
			const notice = page.locator('[data-slot="alert"]').filter({
				has: page.getByText(failureDescription, { exact: true }),
			});
			await expect(notice).toBeVisible({ timeout: 30000 });
			await expect(notice.locator('[data-slot="icon"]')).toBeVisible();
			await expect(notice.locator('[data-slot="alert-title"]')).not.toBeEmpty();
			await expect(notice.locator('[data-slot="alert-description"]')).toHaveText(failureDescription);
			await expect(notice.getByRole("button", { name: /^(Retry|إعادة المحاولة)$/u })).toBeEnabled();
			await settleScreen(page);
			expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
			await page.screenshot({ path: info.outputPath("failed-review.png"), fullPage: true });
			const retry = page.waitForResponse((response) =>
				/^\/api\/rpc\/ai\/operations\/start(?:\/__batch__)?$/u.test(new URL(response.url()).pathname),
			);
			await notice.getByRole("button", { name: /^(Retry|إعادة المحاولة)$/u }).click();
			expect((await retry).ok()).toBe(true);
			await expect.poll(async () => (await api.ai.usage.get()).operations).toMatchObject({ used: 1, reserved: 0 });
			expect((await api.resume.getById({ id: sourceId })).data).toEqual(original.data);
		});
