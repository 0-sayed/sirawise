import {
	captureReviewDirection,
	captureReviewFooter,
	expectReviewTextDirection,
	openWriting,
	seedReview,
	startReview,
} from "../fixtures/reviewable-ai";
import { expect, test } from "../fixtures/test";
import {
	launchTailoringReview,
	seedTailoringReview,
	seedVariantReview,
	startVariantReview,
	variantClient,
} from "../fixtures/variants";

test("job-evidence and tailoring complete flows persist accepted results in Arabic interface", async ({
	authPage: page,
}, info) => {
	test.setTimeout(90_000);
	const { sourceId, copyId, original } = await seedTailoringReview(page, info);
	const api = variantClient(page);
	await expect(
		await page.request.post("/api/auth/update-user", {
			data: { uiLocale: "ar-SA" },
			headers: { origin: String(info.project.use.baseURL) },
		}),
	).toBeOK();

	// Job-evidence review on job copy -> accept -> persists across reload without mutating CV
	await page.goto(`/dashboard/resumes/${copyId}/job`);
	await page.getByRole("button", { name: /Detailed requirement check|فحص متطلبات الوظيفة بالتفصيل/u }).click();
	await page.getByRole("button", { name: "فحص متطلبات الوظيفة", exact: true }).click();
	await page.getByRole("dialog").getByRole("button", { name: "بدء المراجعة", exact: true }).click();
	await expect
		.poll(async () => (await api.career.jobTargets.evidence({ resumeId: copyId })).semantic.state, {
			timeout: 30_000,
		})
		.toBe("waiting-review");
	const semantic = (await api.career.jobTargets.evidence({ resumeId: copyId })).semantic;
	if (!("operationId" in semantic)) throw new Error("Expected job-evidence operation");
	const review = await api.ai.variantReview.get({ operationId: semantic.operationId });
	await api.ai.variantReview.decide({
		operationId: semantic.operationId,
		requestKey: crypto.randomUUID(),
		expectedUpdatedAt: review.updatedAt,
		expectedDecisionId: review.latestDecisionId,
		subjectIds: ["report"],
		decision: "accept",
	});
	await page.reload();
	expect((await api.career.jobTargets.evidence({ resumeId: copyId })).semantic.state).toBe("complete");
	expect((await api.resume.getById({ id: sourceId })).data).toEqual(original.data);

	// Tailoring review on job copy -> accept -> persists across reload on copy only
	await launchTailoringReview(page, copyId, true);
	const proposals = page.locator("[data-proposal-index]");
	await expect(proposals).toHaveCount(3, { timeout: 30_000 });
	const summaryProposal = proposals.filter({ hasText: "Did not manage a budget." });
	await summaryProposal.getByRole("button", { name: "قبول", exact: true }).click();
	await expect(summaryProposal.getByText("تم التطبيق", { exact: true })).toBeVisible();
	await page.reload();
	await expect(summaryProposal.getByText("تم التطبيق", { exact: true })).toBeVisible();
	expect((await api.resume.getById({ id: copyId })).data.summary.content).toContain("Did not manage a budget.");
	expect((await api.resume.getById({ id: sourceId })).data).toEqual(original.data);
});

test("wording review complete flow accepts and persists across reload", async ({ authPage: page }, info) => {
	test.setTimeout(90_000);
	const resumeId = await seedReview(page, info);
	await openWriting(page);
	await startReview(page);
	const review = page.getByTestId("durable-review");
	await review.getByRole("button", { name: "Accept", exact: true }).click();
	const saved = async () => await (await page.request.get(`/api/openapi/resumes/${resumeId}`)).json();
	await expect.poll(async () => (await saved()).data.summary.content).toBe("<p>Developed services.</p>");
	await page.reload();
	expect((await saved()).data.summary.content).toBe("<p>Developed services.</p>");
});

for (const locale of ["ar-SA", "en-US"] as const)
	for (const width of [1440, 390])
		test(`cover-letter review keeps content direction and persists the proposal at ${locale} ${width}`, async ({
			authPage: page,
		}, info) => {
			test.setTimeout(90_000);
			const ar = locale === "ar-SA";
			const documentLocale = ar ? "en-US" : "ar-SA";
			const direction = ar ? "ltr" : "rtl";
			const originalText = ar ? "Original letter." : "خطاب التقديم الأصلي.";
			await page.setViewportSize({ width, height: 900 });
			const resumeId = await seedVariantReview(page, info, false, documentLocale);
			const api = variantClient(page);
			const source = await api.resume.getById({ id: resumeId });
			await api.career.jobTargets.saveAndSelect({
				resumeId,
				expectedUpdatedAt: source.updatedAt.toISOString(),
				role: "Engineer",
				employer: "Synthetic employer",
				text: "TypeScript required.",
			});
			const letter = await api.coverLetters.create({
				name: "Synthetic cover letter",
				resumeId,
				documentLocale,
				content: `<p>${originalText}</p>`,
			});
			await expect(
				await page.request.post("/api/auth/update-user", {
					data: { uiLocale: locale },
					headers: { origin: String(info.project.use.baseURL) },
				}),
			).toBeOK();
			await page.goto(`/builder/letter/${letter.id}`);
			await page.getByRole("button", { name: /^(Review a job-specific letter|مراجعة خطاب مخصص للوظيفة)$/u }).click();
			await page
				.getByRole("dialog")
				.getByRole("button", { name: /^(Start review|بدء المراجعة)$/u })
				.click();
			const accept = page.getByRole("button", { name: /^(Accept proposal|قبول المقترح)$/u });
			await expect(accept).toBeVisible({ timeout: 30_000 });
			const proposed = page
				.locator('[data-slot="section-card"]')
				.filter({
					has: page.getByRole("heading", { name: /^(Proposed letter|الخطاب المقترح)$/u }),
				})
				.locator('p[dir="auto"]');
			const original = page.locator('p[dir="auto"]').and(page.getByText(originalText, { exact: true }));
			await expectReviewTextDirection(original, direction);
			await expectReviewTextDirection(proposed, direction);
			const newText = await proposed.innerText();
			await proposed.scrollIntoViewIfNeeded();
			await captureReviewDirection(page, info, "cover-letter");
			await captureReviewFooter(page, info, "cover-letter-footer", accept);
			await accept.click();
			await expect
				.poll(async () => (await api.coverLetters.getById({ id: letter.id })).revision)
				.toBe(letter.revision + 1);
			await page.reload();
			expect((await api.coverLetters.getById({ id: letter.id })).content).toContain(newText);
		});

test("one-click translation auto-applies and persists across reload while leaving source CV unchanged", async ({
	authPage: page,
}, info) => {
	test.setTimeout(90_000);
	const sourceId = await seedVariantReview(page, info);
	const api = variantClient(page);
	const source = await api.resume.getById({ id: sourceId });
	const copy = await api.resume.variants.create({
		sourceResumeId: sourceId,
		expectedUpdatedAt: source.updatedAt.toISOString(),
		variantKind: "language",
		targetLocale: "ar-SA",
		requestKey: crypto.randomUUID(),
	});
	const prepared = await api.ai.variantReview.prepare({
		kind: "review.translation",
		resumeId: copy.resumeId,
		expectedUpdatedAt: copy.updatedAt,
		expectedSourceRevision: source.updatedAt.toISOString(),
	});
	await startVariantReview(page, prepared);
	await page.goto(`/dashboard/resumes/${sourceId}/languages`);
	await page.reload();
	expect((await api.resume.getById({ id: copy.resumeId })).data.metadata.page.locale).toBe("ar-SA");
	expect((await api.resume.getById({ id: sourceId })).data).toEqual(source.data);
});

for (const locale of ["ar-SA", "en-US"] as const)
	for (const width of [1440, 390])
		test(`summary review accepts and persists across reload at ${locale} ${width}`, async ({
			authPage: page,
		}, info) => {
			test.setTimeout(90_000);
			const ar = locale === "ar-SA";
			await page.setViewportSize({ width, height: 900 });
			const resumeId = await seedVariantReview(page, info, true);
			const api = variantClient(page);
			const before = (await api.resume.getById({ id: resumeId })).data.summary.content;
			await expect(
				await page.request.post("/api/auth/update-user", {
					data: { uiLocale: locale },
					headers: { origin: String(info.project.use.baseURL) },
				}),
			).toBeOK();
			await page.goto(`/builder/${resumeId}`);
			await page
				.getByRole("button", { name: ar ? "الملخّص" : "Summary", exact: true })
				.first()
				.click();
			await page
				.locator("summary")
				.filter({ hasText: ar ? "اختر حقائق للنبذة" : "Select facts for the summary" })
				.click();
			await page.getByRole("checkbox").first().check();
			await page.getByRole("button", { name: ar ? "مراجعة النبذة" : "Review summary", exact: true }).click();
			await page
				.getByRole("dialog")
				.getByRole("button", { name: ar ? "بدء المراجعة" : "Start review", exact: true })
				.click();
			await expect(page.getByRole("dialog")).toHaveCount(0);
			const accept = page.getByRole("button", { name: ar ? "قبول" : "Accept", exact: true }).first();
			await expect(accept).toBeVisible({ timeout: 30_000 });
			await captureReviewFooter(page, info, "summary-footer", accept);
			await accept.click();
			await expect.poll(async () => (await api.resume.getById({ id: resumeId })).data.summary.content).not.toBe(before);
			const persisted = (await api.resume.getById({ id: resumeId })).data.summary.content;
			await page.reload();
			expect((await api.resume.getById({ id: resumeId })).data.summary.content).toBe(persisted);
		});
