import { captureReviewDirection, expectReviewTextDirection } from "../fixtures/reviewable-ai";
import { settleScreen } from "../fixtures/screen";
import { expect, test } from "../fixtures/test";
import { seedVariantReview, variantClient, startVariantReview } from "../fixtures/variants";
test("translation auto-applies when verified with no pending terms, survives reload and undo locally", async ({
	authPage: page,
}, info) => {
	const id = await seedVariantReview(page, info);
	const api = variantClient(page);
	const source = await api.resume.getById({ id });
	const copy = await api.resume.variants.create({
		sourceResumeId: id,
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
	const operationId = await startVariantReview(page, prepared);
	const decide = async (
		subjectIds: string[],
		decision: "accept" | "accept_edited" | "undo",
		extras: { editedText?: string; undoDecisionId?: string } = {},
	) => {
		const view = await api.ai.variantReview.get({ operationId });
		return api.ai.variantReview.decide({
			operationId,
			requestKey: crypto.randomUUID(),
			expectedUpdatedAt: view.updatedAt,
			expectedDecisionId: view.latestDecisionId,
			subjectIds,
			decision,
			...extras,
		});
	};
	await page.goto(`/dashboard/resumes/${id}/languages`);
	await page.reload();
	expect((await api.resume.getById({ id: copy.resumeId })).data.metadata.page.locale).toBe("ar-SA");
	expect((await api.resume.getById({ id })).data).toEqual(source.data);
	const review = await api.ai.variantReview.get({ operationId });
	const applied = review.undoable.at(-1);
	expect(applied).toBeDefined();
	if (!applied) throw new Error("Expected undoable auto-apply decision");
	await decide(applied.subjectIds, "undo", { undoDecisionId: applied.decisionId });
	expect((await api.resume.getById({ id: copy.resumeId })).data).toEqual(source.data);
});

for (const locale of ["en-US", "ar-SA"] as const)
	for (const width of [1440, 390])
		test(`summary and job review launch with localized clarification at ${locale} ${width}`, async ({
			authPage: page,
		}, info) => {
			await page.setViewportSize({ width, height: 900 });
			const ar = locale === "ar-SA";
			const direction = ar ? "ltr" : "rtl";
			const id = await seedVariantReview(page, info, false, ar ? "en-US" : "ar-SA");
			const api = variantClient(page);
			await expect(
				await page.request.post("/api/auth/update-user", {
					data: { uiLocale: locale },
					headers: { origin: String(info.project.use.baseURL) },
				}),
			).toBeOK();
			await page.goto(`/builder/${id}`);
			await page
				.getByRole("button", { name: /^(Summary|الملخّص)$/ })
				.first()
				.click();
			const summaryLaunch = page.getByRole("button", { name: /^(Review summary|مراجعة النبذة)$/ });
			await expect(summaryLaunch).toBeDisabled();
			const selectionHint = page.getByText(
				locale === "ar-SA"
					? "اختر معلومة واحدة على الأقل لمراجعة ملخصك."
					: "Select at least one fact to review your summary.",
			);
			await expect(selectionHint).toBeVisible();
			await page
				.locator("summary")
				.filter({ hasText: /Select facts for the summary|اختر حقائق/ })
				.click();
			await page.getByRole("checkbox").first().check();
			await expect(summaryLaunch).toBeEnabled();
			await expect(selectionHint).toHaveCount(0);
			await summaryLaunch.click();
			await page
				.getByRole("dialog")
				.getByRole("button", { name: /^(Start review|بدء المراجعة)$/ })
				.click();
			await expect(page.getByRole("dialog")).toHaveCount(0);
			await expect(page.getByRole("button", { name: /^(Accept|قبول)$/ }).first()).toBeVisible({ timeout: 30000 });
			const summary = page.locator(".review-wording");
			await expectReviewTextDirection(summary.locator("del"), direction);
			await expectReviewTextDirection(summary.locator("ins"), direction);
			await summary.scrollIntoViewIfNeeded();
			await settleScreen(page);
			await page.screenshot({ path: info.outputPath("summary-review.png"), fullPage: true });
			await captureReviewDirection(page, info, "summary");
			await page.goto(`/dashboard/resumes/${id}/job`);
			await page.getByLabel(/^(Job title|المسمى الوظيفي)$/).fill("Engineer");
			await page.getByLabel(/^(Job ad|إعلان الوظيفة)$/).fill("TypeScript and SAP required");
			await page.getByRole("button", { name: /^(Compare|قارن|مقارنة)$/ }).click();
			await page.getByRole("button", { name: /^(Review job evidence|مراجعة أدلة الوظيفة)$/ }).click();
			await page
				.getByRole("dialog")
				.getByRole("button", { name: /^(Start review|بدء المراجعة)$/ })
				.click();
			await expect(page.getByRole("dialog")).toHaveCount(0);
			await expect
				.poll(async () => (await api.career.jobTargets.evidence({ resumeId: id })).semantic.state, { timeout: 30000 })
				.toBe("waiting-review");
			const report = page.getByRole("region", { name: "report", exact: true });
			await expectReviewTextDirection(report.locator('p[dir="auto"]').first(), "ltr");
			await expectReviewTextDirection(report.locator('p[dir="auto"]').last(), direction);
			await expect(report.locator("p").nth(1)).toHaveCSS("direction", ar ? "rtl" : "ltr");
			await report.scrollIntoViewIfNeeded();
			await captureReviewDirection(page, info, "job-evidence");
			await page.getByRole("button", { name: /^(Add information|إضافة معلومة)$/ }).click();
			const dialog = page.getByRole("dialog");
			await expect(dialog.getByText("TypeScript and SAP required", { exact: true })).toBeVisible();
			await expect(dialog.getByText("TypeScript and SAP required", { exact: true })).toHaveAttribute("dir", "auto");
			await expect(
				dialog.getByText(
					locale === "ar-SA"
						? "ما الخبرة أو الدراسة أو المشروع الذي يمكنك تأكيده لهذا المتطلب؟"
						: "What experience, study or project can you confirm for this requirement?",
					{ exact: true },
				),
			).toBeVisible();
			await expect(page.getByText(/no_evidence/)).toHaveCount(0);
			await settleScreen(page);
			await page.screenshot({ path: info.outputPath("job-clarification.png"), fullPage: true });
		});

test("auto-applied translation, undo and re-approval preserve readable local names without placeholders", async ({
	authPage: page,
}, info) => {
	const id = await seedVariantReview(page, info, true);
	const api = variantClient(page);
	const source = await api.resume.getById({ id });
	const copy = await api.resume.variants.create({
		sourceResumeId: id,
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
	const operationId = await startVariantReview(page, prepared);
	await page.goto(`/dashboard/resumes/${id}/languages`);
	await expect(page.getByText("Translation ready", { exact: true })).toBeVisible();
	await expect(page.getByText(/\[LOCAL_\d+\]/)).toHaveCount(0);
	await page.getByRole("button", { name: "Compare with original", exact: true }).click();
	await page.getByText("Show 1 confirmed name", { exact: true }).click();
	await expect(page.getByText("Synthetic Institute", { exact: true }).first()).toBeVisible();
	await settleScreen(page);
	await page.screenshot({ path: info.outputPath("translation-local-names.png"), fullPage: true });
	await page.getByRole("button", { name: "Undo last action", exact: true }).click();
	await expect.poll(async () => (await api.resume.getById({ id: copy.resumeId })).data).toEqual(source.data);
	const pending = await api.ai.variantReview.get({ operationId });
	expect(Object.values(pending.segments).map(({ status }) => status)).toEqual(Array(4).fill("accepted"));
	expect(pending.terms.terms.filter(({ status }) => status === "confirmed")).toHaveLength(1);
	await page.getByRole("button", { name: /^Summary\b/u }).click();
	const summary = page.getByRole("region").filter({ hasText: "Built TypeScript services" });
	const reject = summary.getByRole("button", { name: "Reject", exact: true });
	await reject.click();
	await expect(summary.getByText("Rejected", { exact: true })).toBeVisible();
	await expect(page.getByRole("button", { name: "Approve language copy", exact: true })).toBeDisabled();
	const rejected = await api.ai.variantReview.get({ operationId });
	expect(Object.values(rejected.segments).filter(({ status }) => status === "rejected")).toHaveLength(1);
	expect(rejected.latestDecisionId).not.toBe(pending.latestDecisionId);
	expect((await api.resume.getById({ id: copy.resumeId })).data).toEqual(source.data);
	await summary.getByRole("button", { name: "Undo", exact: true }).click();
	await expect(page.getByText("Rejected", { exact: true })).toHaveCount(0);
	await expect(reject).toBeEnabled();
	const undone = await api.ai.variantReview.get({ operationId });
	expect(undone.segments).toEqual(pending.segments);
	expect(undone.terms).toEqual(pending.terms);
	expect(undone.latestDecisionId).not.toBeNull();
	expect(undone.latestDecisionId).not.toBe(rejected.latestDecisionId);
	expect((await api.resume.getById({ id: copy.resumeId })).data).toEqual(source.data);
	await page.getByRole("button", { name: "Approve language copy", exact: true }).click();
	await expect
		.poll(async () => (await api.resume.getById({ id: copy.resumeId })).data.metadata.page.locale)
		.toBe("ar-SA");
	await expect(page.getByText(/\[LOCAL_\d+\]/)).toHaveCount(0);
	const saved = await api.resume.getById({ id: copy.resumeId });
	expect(saved.data.sections.education.items[0]?.school).toBe("Synthetic Institute");
	expect(saved.data.sections.education.items[0]?.degree).toBe("Training certificate");
	expect(JSON.stringify(saved.data)).not.toMatch(/\[LOCAL_\d+\]/);
});

for (const width of [1440, 390])
	test(`terminology recovery keeps the draft and returns focus at ${width}`, async ({ authPage: page }, info) => {
		await page.setViewportSize({ width, height: 900 });
		const id = await seedVariantReview(page, info, true);
		const api = variantClient(page);
		const source = await api.resume.getById({ id });
		const copy = await api.resume.variants.create({
			sourceResumeId: id,
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
		const operationId = await startVariantReview(page, prepared);
		await page.goto(`/dashboard/resumes/${id}/languages`);
		await page.getByRole("button", { name: "Compare with original", exact: true }).click();
		await page.getByRole("button", { name: "Undo last action", exact: true }).click();
		await expect.poll(async () => (await api.resume.getById({ id: copy.resumeId })).data).toEqual(source.data);
		await page.getByText("Show 1 confirmed name", { exact: true }).click();
		const trigger = page.getByRole("button", { name: "Confirm term" }).first();
		await expect(trigger).toBeVisible();
		await expect(trigger).toBeEnabled();
		const termsBefore = (await api.ai.variantReview.get({ operationId })).terms.terms;
		expect(termsBefore).toHaveLength(1);
		expect(termsBefore[0]?.value).toBe("Synthetic Institute");
		await trigger.click();
		const overlay = page.getByRole("dialog");
		await expect(overlay.getByText("Synthetic Institute", { exact: true })).toBeVisible();
		const input = overlay.getByRole("textbox", { name: "Reviewed term" });
		await input.fill("");
		await expect(overlay.getByRole("button", { name: "Confirm term" })).toBeDisabled();
		await input.fill("Official Synthetic Institute");
		await page.screenshot({ path: info.outputPath("term-correction.png"), fullPage: true });
		await overlay.getByRole("button", { name: "Cancel", exact: true }).click();
		await expect(overlay).toHaveCount(0);
		await expect(trigger).toBeFocused();
		await expect(page.getByText("Synthetic Institute", { exact: true })).toBeVisible();
		expect((await api.ai.variantReview.get({ operationId })).terms.terms).toEqual(termsBefore);
		expect((await api.resume.getById({ id: copy.resumeId })).data).toEqual(source.data);
	});

test("history restores an earlier language-copy revision after reload without changing its source", async ({
	authPage: page,
}, info) => {
	const id = await seedVariantReview(page, info);
	const api = variantClient(page);
	const source = await api.resume.getById({ id });
	const copy = await api.resume.variants.create({
		sourceResumeId: id,
		expectedUpdatedAt: source.updatedAt.toISOString(),
		variantKind: "language",
		targetLocale: "ar-SA",
		requestKey: crypto.randomUUID(),
	});
	await page.goto(`/builder/${copy.resumeId}`);
	await page.getByLabel("Full name", { exact: true }).fill("Earlier synthetic language name");
	await expect
		.poll(async () => (await api.resume.getById({ id: copy.resumeId })).data.basics.name)
		.toBe("Earlier synthetic language name");
	await page.getByRole("button", { name: "History", exact: true }).click();
	await page.getByRole("textbox", { name: "Name this version", exact: true }).fill("Reviewed language revision");
	await page.getByRole("button", { name: "Save", exact: true }).click();
	await expect(page.getByRole("button", { name: /^Reviewed language revision/u })).toBeVisible();
	await page
		.getByRole("complementary", { name: "Export and history" })
		.getByRole("button", { name: "Close", exact: true })
		.click();
	await page.getByLabel("Full name", { exact: true }).fill("Latest synthetic language name");
	await expect
		.poll(async () => (await api.resume.getById({ id: copy.resumeId })).data.basics.name)
		.toBe("Latest synthetic language name");
	await page.reload();
	await expect(page.getByLabel("Full name", { exact: true })).toHaveValue("Latest synthetic language name");
	await page.getByRole("button", { name: "History", exact: true }).click();
	await page.getByRole("button", { name: /^Reviewed language revision/u }).click();
	await page.getByRole("button", { name: "Restore this version", exact: true }).click();
	const confirmation = page.getByRole("alertdialog");
	await expect(confirmation).toContainText("Before restore");
	await confirmation.getByRole("button", { name: "Restore", exact: true }).click();
	await expect
		.poll(async () => (await api.resume.getById({ id: copy.resumeId })).data.basics.name)
		.toBe("Earlier synthetic language name");
	await page
		.getByRole("complementary", { name: "Export and history" })
		.getByRole("button", { name: "Close", exact: true })
		.click();
	await page.reload();
	await expect(page.getByLabel("Full name", { exact: true })).toHaveValue("Earlier synthetic language name");
	expect((await api.resume.getById({ id })).data).toEqual(source.data);
});
