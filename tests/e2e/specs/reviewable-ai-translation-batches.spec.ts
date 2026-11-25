import { buildTranslationInventory } from "@reactive-resume/resume/translation";
import { captureReviewDirection, selectCompactTranslation } from "../fixtures/reviewable-ai";
import { settleScreen } from "../fixtures/screen";
import { expect, test } from "../fixtures/test";
import { translationAlignmentSentences } from "../fixtures/variant-transport";
import { seedVariantReview, startVariantReview, variantClient } from "../fixtures/variants";

// Long-lived fixture operations share the synthetic route's concurrency budget.
test.describe.configure({ mode: "default" });

for (const action of ["reject", "undo and reject", "accept"] as const) {
	test(`retry preserves an unrelated translation decision after ${action}`, async ({ authPage: page }, info) => {
		const resumeId = await seedVariantReview(page, info);
		const api = variantClient(page);
		const original = await api.resume.getById({ id: resumeId });
		const marker = `Synthetic batched translation retry ${crypto.randomUUID()}`;
		const { "en-US": firstSource, "ar-SA": firstTranslation } = translationAlignmentSentences;
		const paragraphs = [
			firstSource,
			...Array.from({ length: 18 }, (_, index) => {
				const sentence = index === 9 ? `Documented the QA flow. ${marker}.` : `Synthetic translation ${index}.`;
				const unresolved = index === 17 && action !== "undo and reject" ? " [LOCAL_999]" : "";
				return `${`${sentence} `.repeat(4).trim()}${unresolved}`;
			}),
		];
		original.data.summary.title = "";
		original.data.summary.content = paragraphs.map((text) => `<p>${text}</p>`).join("");
		const source = await api.resume.update({
			id: resumeId,
			data: original.data,
			expectedUpdatedAt: original.updatedAt.toISOString(),
		});
		const copy = await api.resume.variants.create({
			sourceResumeId: resumeId,
			expectedUpdatedAt: source.updatedAt.toISOString(),
			variantKind: "language",
			targetLocale: "ar-SA",
			requestKey: crypto.randomUUID(),
		});
		const operationId = await startVariantReview(
			page,
			await api.ai.variantReview.prepare({
				kind: "review.translation",
				resumeId: copy.resumeId,
				expectedUpdatedAt: copy.updatedAt,
				expectedSourceRevision: source.updatedAt.toISOString(),
			}),
		);
		const before = await api.ai.variantReview.get({ operationId });
		const first = before.sourceSegments.find(({ text }) => text === firstSource);
		const failedPart = before.result.withheld?.items?.[0];
		if (!first || !failedPart) throw new Error("Expected a verified first segment and a withheld part");
		expect(failedPart.partIndex).toBeGreaterThan(0);
		expect(failedPart.id).not.toBe(first.id);
		await page.goto(`/dashboard/resumes/${resumeId}/languages`);
		await page.getByRole("button", { name: "Compare with original", exact: true }).click();
		if (action === "undo and reject") {
			await page.getByRole("button", { name: "Undo last action", exact: true }).click();
			await expect.poll(async () => (await api.resume.getById({ id: copy.resumeId })).data).toEqual(source.data);
		}
		await page.getByRole("button", { name: /^Summary\b/u }).click();
		const segment = page.getByRole("region", { name: first.id, exact: true });
		await expect(segment.getByText(firstTranslation, { exact: true })).toBeVisible();
		const expectedStatus = action === "accept" ? "Accepted" : "Rejected";
		await segment.getByRole("button", { name: action === "accept" ? "Accept" : "Reject", exact: true }).click();
		await expect(segment.getByText(expectedStatus, { exact: true })).toBeVisible();
		const reviewed = await api.ai.variantReview.get({ operationId });
		const saved = await api.resume.getById({ id: copy.resumeId });
		expect(saved.data.summary.content).toContain(`<p>${firstSource}</p>`);
		const retryNotice = page
			.locator('[data-slot="alert"]')
			.filter({ hasText: `Part ${(failedPart.partIndex ?? 0) + 1}:` });
		await retryNotice.getByRole("button", { name: "Retry this part", exact: true }).click();
		await expect
			.poll(async () => (await api.ai.operations.get({ id: operationId })).retryable, { timeout: 30000 })
			.toBe(false);
		await expect
			.poll(async () => (await api.ai.operations.get({ id: operationId })).resultId, { timeout: 30000 })
			.toBe(operationId);
		const after = await api.ai.variantReview.get({ operationId });
		expect(after.statuses[first.id]).toBe(expectedStatus.toLowerCase());
		expect(after.segments[first.id]).toEqual(reviewed.segments[first.id]);
		expect(after.statuses[failedPart.id]).toBe("accepted");
		expect(after.statuses.translation).toBe("pending");
		expect((await api.resume.getById({ id: copy.resumeId })).data.summary.content).toBe(
			saved.data.summary.content.replace("Documented the QA flow.", "وثقت خطوات الاختبار."),
		);
		expect((await api.resume.getById({ id: resumeId })).data).toEqual(source.data);
		await page.reload();
		if (action !== "undo and reject")
			await page.getByRole("button", { name: "Compare with original", exact: true }).click();
		await page.getByRole("button", { name: /^Summary\b/u }).click();
		await expect(segment.getByText(expectedStatus, { exact: true })).toBeVisible();
	});
}

for (const [locale, width] of [
	["en-US", 1440],
	["en-US", 390],
	["ar-SA", 1440],
	["ar-SA", 390],
] as const) {
	test(`compact translation shows verified text and keeps the previous target ${locale} ${width}`, async ({
		authPage: page,
	}, info) => {
		await selectCompactTranslation(page);
		await page.setViewportSize({ width, height: 900 });
		const resumeId = await seedVariantReview(page, info);
		const api = variantClient(page);
		const original = await api.resume.getById({ id: resumeId });
		original.data.summary.title = "";
		const retryMarker = `Compact retry ${crypto.randomUUID()}`;
		original.data.summary.content = `<p>Documented the QA flow.</p><p>Supported the release lead. ${retryMarker}</p>`;
		const source = await api.resume.update({
			id: resumeId,
			data: original.data,
			expectedUpdatedAt: original.updatedAt.toISOString(),
		});
		if (locale === "ar-SA")
			await expect(
				await page.request.post("/api/auth/update-user", {
					data: { uiLocale: locale },
					headers: { origin: String(info.project.use.baseURL) },
				}),
			).toBeOK();
		await page.goto(`/dashboard/resumes/${resumeId}/languages`);
		await settleScreen(page);
		const ar = locale === "ar-SA";
		await page.getByRole("button", { name: ar ? "ترجمة إلى العربية" : "Translate to Arabic", exact: true }).click();
		const dialog = page.getByRole("dialog");
		await dialog
			.getByRole("button", { name: ar ? "مراجعة أجزاء الترجمة" : "Review translation parts", exact: true })
			.click();
		const admission = page.waitForResponse(
			(response) => new URL(response.url()).pathname === "/api/rpc/ai/operations/start",
		);
		await dialog.getByRole("button", { name: ar ? "بدء المراجعة" : "Start review", exact: true }).click();
		expect(await (await admission).text()).toMatch(/"state":"queued"/u);
		const notice = ar
			? "تم حجب عنصر واحد لأنه لم يجتز التحقق."
			: "1 item was withheld because it could not be verified.";
		await expect(page.getByText(notice)).toBeVisible({ timeout: 25000 });
		const variants = await api.resume.variants.list({ resumeId });
		const copy = variants.find((variant) => variant.targetLocale === "ar-SA");
		if (!copy) throw new Error("Missing compact translation target");
		const saved = await api.resume.getById({ id: copy.resumeId });
		expect(saved.data.summary.content).toContain("وثقت خطوات الاختبار.");
		expect(saved.data.summary.content).toContain("Supported the release lead.");
		expect(saved.data.summary.content).not.toContain("قدت الإصدار.");
		await expect(page.getByText("قدت الإصدار.", { exact: false })).toHaveCount(0);
		expect((await api.resume.getById({ id: resumeId })).data.summary.content).toBe(source.data.summary.content);
		expect((await api.ai.usage.get()).operations).toMatchObject({ used: 1, reserved: 0, remaining: 4 });
		const retry = page.getByRole("button", { name: ar ? "إعادة محاولة هذا الجزء" : "Retry this part", exact: true });
		await retry.scrollIntoViewIfNeeded();
		await expect(retry).toBeInViewport();
		expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
		await captureReviewDirection(page, info, "compact-translation-partial");
		await retry.click();
		await expect
			.poll(async () => (await api.resume.getById({ id: copy.resumeId })).data.summary.content, { timeout: 30000 })
			.toContain("ساندت مسؤول الإصدار.");
		await expect(page.getByText(ar ? "الترجمة جاهزة" : "Translation ready", { exact: true })).toBeVisible({
			timeout: 30000,
		});
		const repaired = await api.resume.getById({ id: copy.resumeId });
		expect(repaired.data.summary.content).toContain("ساندت مسؤول الإصدار.");
		expect(repaired.data.summary.content).not.toContain("قدت الإصدار.");
		expect((await api.ai.usage.get()).operations).toMatchObject({ used: 1, reserved: 0, remaining: 4 });
		expect((await api.resume.getById({ id: resumeId })).data).toEqual(source.data);
		const switched = ar ? "en-US" : "ar-SA";
		await expect(
			await page.request.post("/api/auth/update-user", {
				data: { uiLocale: switched },
				headers: { origin: String(info.project.use.baseURL) },
			}),
		).toBeOK();
		await page.reload();
		await expect(page.locator("html")).toHaveAttribute("dir", ar ? "ltr" : "rtl");
		expect((await api.resume.getById({ id: copy.resumeId })).data).toEqual(repaired.data);
		expect((await api.resume.getById({ id: resumeId })).data).toEqual(source.data);
	});
}

for (const locale of ["en-US", "ar-SA"] as const)
	for (const width of [1440, 390])
		test(`translation parts retain verified work and resume after reload ${locale} ${width}`, async ({
			authPage: page,
		}, info) => {
			test.setTimeout(90000);
			const ar = locale === "ar-SA";
			await page.setViewportSize({ width, height: 900 });
			const resumeId = await seedVariantReview(page, info);
			const api = variantClient(page);
			const original = await api.resume.getById({ id: resumeId });
			original.data.summary.title = "";
			const marker = crypto.randomUUID();
			original.data.summary.content = Array.from(
				{ length: 18 },
				(_, index) =>
					`<p>${`${index === 9 ? `Synthetic batched translation retry ${marker}` : `Synthetic batched translation ${index}`}. `
						.repeat(4)
						.trim()}</p>`,
			).join("");
			const source = await api.resume.update({
				id: resumeId,
				data: original.data,
				expectedUpdatedAt: original.updatedAt.toISOString(),
			});
			const inventory = buildTranslationInventory(source.data);
			expect(inventory.segments).toHaveLength(19);
			await expect(
				await page.request.post("/api/auth/update-user", {
					data: { uiLocale: locale },
					headers: { origin: String(info.project.use.baseURL) },
				}),
			).toBeOK();
			await page.goto(`/dashboard/resumes/${resumeId}/languages`);
			await settleScreen(page);
			await expect(page.locator("html")).toHaveAttribute("dir", ar ? "rtl" : "ltr");
			expect(
				await page.evaluate(
					(family) => document.fonts.check(`14px "${family}"`),
					ar ? "Noto Sans Arabic" : "Noto Sans",
				),
			).toBe(true);
			await page.getByRole("button", { name: ar ? "ترجمة إلى العربية" : "Translate to Arabic", exact: true }).click();
			const dialog = page.getByRole("dialog");
			await dialog
				.getByRole("button", { name: ar ? "مراجعة أجزاء الترجمة" : "Review translation parts", exact: true })
				.click();
			await expect(dialog.getByRole("status")).toHaveText(
				ar
					? "تتكون هذه الترجمة من 4 أجزاء. يستهلك بدء الترجمة استخدامًا واحدًا للمساعد إجمالًا. إعادة محاولة الأجزاء لا تستهلك استخدامات إضافية. تُطبَّق الأجزاء التي تجتاز التحقق تلقائيًا في النسخة المترجمة. وتبقى الأجزاء التي لم تجتز التحقق بالنص الأصلي."
					: "This translation has 4 parts. Starting it uses one AI use in total. Retrying parts uses no extra AI uses. Verified parts are applied automatically to the translated copy. Parts that fail verification keep their original text.",
			);
			const language = (await api.resume.variants.list({ resumeId })).find(
				(document) => document.variantKind === "language",
			);
			if (!language) throw new Error("Expected language copy");
			expect((await api.ai.usage.get()).operations).toMatchObject({ used: 0, reserved: 0, remaining: 5 });
			expect(
				(await api.resume.variants.list({ resumeId })).find((document) => document.resumeId === language.resumeId)
					?.operationId,
			).toBeNull();
			await page.screenshot({ path: info.outputPath("translation-cost.png") });
			await dialog.getByRole("button", { name: ar ? "بدء المراجعة" : "Start review", exact: true }).click();
			await expect(
				page.getByRole("status").filter({ hasText: ar ? /اكتمل [0-3] من 4 أجزاء/u : /[0-3] of 4 parts complete/u }),
			).toBeVisible();
			const latest = async () =>
				(await api.resume.variants.list({ resumeId })).find((document) => document.resumeId === language.resumeId)
					?.operationId;
			await expect.poll(latest).toBeTruthy();
			const operationId = await latest();
			if (!operationId) throw new Error("Expected root translation operation");
			const withheldNotice = ar
				? "تم حجب عنصر واحد لأنه لم يجتز التحقق."
				: "1 item was withheld because it could not be verified.";
			await expect(page.getByText(withheldNotice)).toBeVisible({ timeout: 30000 });
			const partialReview = await api.ai.variantReview.get({ operationId });
			if (partialReview.result.kind !== "review.translation") throw new Error("Expected partial translation");
			const stoppedIndex = partialReview.result.withheld?.items?.[0]?.partIndex;
			if (stoppedIndex === undefined) throw new Error("Expected the withheld part index");
			await expect(
				page.getByText(ar ? `الجزء ${stoppedIndex + 1}:` : `Part ${stoppedIndex + 1}:`, { exact: false }),
			).toBeVisible();
			await expect(
				page.getByText(
					ar
						? "تعذر التحقق من دقة ترجمة هذا الجزء. بقي النص الأصلي محفوظًا."
						: "Could not be verified as an accurate translation. The original text is kept.",
					{ exact: false },
				),
			).toBeVisible();
			const partialState = await api.ai.operations.get({ id: operationId });
			expect(partialState).toMatchObject({
				state: "succeeded",
				resultId: operationId,
				retryable: true,
				progress: { completedParts: 3, total: 4 },
			});
			expect((await api.ai.usage.get()).operations).toMatchObject({ used: 1, reserved: 0, remaining: 4 });
			const partialCopy = (await api.resume.getById({ id: language.resumeId })).data;
			expect(partialCopy.metadata.page.locale).toBe("ar-SA");
			expect(partialCopy.summary.content).toContain(`Synthetic batched translation retry ${marker}`);
			expect((await api.resume.getById({ id: resumeId })).data).toEqual(source.data);
			await page.reload();
			const stopped = page.getByText(withheldNotice);
			await expect(stopped).toBeVisible();
			await stopped.scrollIntoViewIfNeeded();
			await settleScreen(page);
			expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
			await page.screenshot({ path: info.outputPath("translation-part-stopped.png") });
			await page
				.getByRole("button", { name: ar ? "إعادة محاولة هذا الجزء" : "Retry this part", exact: true })
				.first()
				.click();
			await expect
				.poll(
					async () => {
						const op = await api.ai.operations.get({ id: operationId });
						return op.state === "succeeded" && !op.retryable;
					},
					{ timeout: 30000 },
				)
				.toBe(true);
			expect(await latest()).toBe(operationId);
			expect((await api.ai.usage.get()).operations).toMatchObject({ used: 1, reserved: 0, remaining: 4 });
			const review = await api.ai.variantReview.get({ operationId });
			if (review.result.kind !== "review.translation") throw new Error("Expected one assembled translation review");
			expect(review.result.withheld).toBeUndefined();
			expect(review.result.output.segments.map((segment) => segment.sourceId).sort()).toEqual(
				inventory.segments.map((segment) => segment.id).sort(),
			);
			expect(review.statuses.translation).toBe("accepted");
			expect((await api.resume.getById({ id: language.resumeId })).data.metadata.page.locale).toBe("ar-SA");
			expect((await api.resume.getById({ id: resumeId })).data).toEqual(source.data);
			await expect(page.getByText(ar ? "الترجمة جاهزة" : "Translation ready", { exact: true })).toBeVisible();
			await expect(page.getByRole("button", { name: ar ? "فتح" : "Open", exact: true })).toBeVisible();
			await page.screenshot({ path: info.outputPath("translation-combined-review.png") });
			expect((await api.ai.usage.get()).operations).toMatchObject({ used: 1, reserved: 0, remaining: 4 });
		});

for (const locale of ["en-US", "ar-SA"] as const)
	for (const width of [1440, 390])
		test(`bulk official names preserve individual corrections ${locale} ${width}`, async ({ authPage: page }, info) => {
			test.setTimeout(90000);
			const ar = locale === "ar-SA";
			await page.setViewportSize({ width, height: 900 });
			const resumeId = await seedVariantReview(page, info, true);
			const api = variantClient(page);
			const original = await api.resume.getById({ id: resumeId });
			const school = original.data.sections.education.items[0];
			if (!school) throw new Error("Expected synthetic education fixture");
			original.data.sections.education.items = Array.from({ length: 34 }, (_, index) => ({
				...school,
				id: `school-${index}`,
				school: `Synthetic Institute ${index}`,
				degree: `Training certificate ${index}`,
			}));
			const source = await api.resume.update({
				id: resumeId,
				data: original.data,
				expectedUpdatedAt: original.updatedAt.toISOString(),
			});
			const language = await api.resume.variants.create({
				sourceResumeId: resumeId,
				expectedUpdatedAt: source.updatedAt.toISOString(),
				variantKind: "language",
				targetLocale: "ar-SA",
				requestKey: crypto.randomUUID(),
			});
			const prepared = await api.ai.variantReview.prepare({
				kind: "review.translation",
				resumeId: language.resumeId,
				expectedUpdatedAt: language.updatedAt,
				expectedSourceRevision: source.updatedAt.toISOString(),
			});
			const operationId = await startVariantReview(page, prepared);
			await expect(
				await page.request.post("/api/auth/update-user", {
					data: { uiLocale: locale },
					headers: { origin: String(info.project.use.baseURL) },
				}),
			).toBeOK();
			await page.goto(`/dashboard/resumes/${resumeId}/languages`);
			await settleScreen(page);
			await expect(page.locator("html")).toHaveAttribute("dir", ar ? "rtl" : "ltr");
			const initialReview = await api.ai.variantReview.get({ operationId });
			expect(initialReview.terms.terms).toHaveLength(34);
			expect(initialReview.terms.terms.every((term) => term.status === "confirmed" && term.value === term.source)).toBe(
				true,
			);
			expect(initialReview.statuses.translation).toBe("accepted");
			await expect(page.getByText(ar ? "الترجمة جاهزة" : "Translation ready", { exact: true })).toBeVisible();
			await page.getByRole("button", { name: ar ? "مقارنة بالأصل" : "Compare with original", exact: true }).click();
			const confirmedToggle = page.locator("summary").filter({ hasText: /34/u });
			await expect(confirmedToggle).toBeVisible();
			await confirmedToggle.click();
			await expect(page.getByText("Synthetic Institute 0", { exact: true }).first()).toBeVisible();
			await page.screenshot({ path: info.outputPath("translation-bulk-names.png") });
			await page.reload();
			const review = await api.ai.variantReview.get({ operationId });
			expect(review.terms.terms.filter((term) => term.value === term.source)).toHaveLength(34);
			expect(review.statuses.translation).toBe("accepted");
			expect((await api.resume.getById({ id: language.resumeId })).data.metadata.page.locale).toBe("ar-SA");
			expect((await api.resume.getById({ id: resumeId })).data).toEqual(source.data);
			expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
		});
