import type { Page } from "@playwright/test";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { chromium } from "@playwright/test";
import { buildTranslationInventory } from "@reactive-resume/resume/translation";
import { captureReviewDirection, captureReviewFooter, selectCompactTranslation } from "../fixtures/reviewable-ai";
import { settleScreen } from "../fixtures/screen";
import { expect, test } from "../fixtures/test";
import { translationAlignmentSentences } from "../fixtures/variant-transport";
import { decideVariantFixture, seedVariantReview, startVariantReview, variantClient } from "../fixtures/variants";

// Long-lived fixture operations share the synthetic route's concurrency budget.
test.describe.configure({ mode: "default" });

const shots = "/tmp/sirawise-fixes/translation-ux-shots";

async function captureTranslationDetector(page: Page, executable: string) {
	const profile = await mkdtemp(join(tmpdir(), "translation-detector-"));
	const browser = await chromium.launchPersistentContext(profile, {
		viewport: page.viewportSize(),
		args: ["--remote-debugging-port=0"],
	});
	try {
		const [port] = (await readFile(join(profile, "DevToolsActivePort"), "utf8")).split("\n");
		await browser.addCookies(await page.context().cookies(page.url()));
		const copy = browser.pages()[0] ?? (await browser.newPage());
		await copy.goto(page.url());
		await expect(copy.getByRole("heading", { name: "Review Arabic copy" })).toBeVisible();
		await settleScreen(copy);
		const { IMPECCABLE_BIN: _launcher, ...env } = process.env;
		const result = await promisify(execFile)(
			executable,
			["detect", "--json", "--cdp", port ?? "", "--target", "/languages"],
			{
				env,
				timeout: 60_000,
				maxBuffer: 4 * 1024 * 1024,
			},
		).catch((error: { code?: number; stdout?: string }) => {
			if (error.code === 2 && error.stdout) return { stdout: error.stdout };
			throw error;
		});
		await writeFile(join(shots, "impeccable-review.json"), result.stdout);
	} finally {
		await browser.close();
	}
}

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
		if (action === "undo and reject") {
			const undo = before.undoable.find(({ subjectIds }) => subjectIds.includes("translation"));
			if (!undo) throw new Error("Expected undoable legacy auto-apply");
			await decideVariantFixture(api, operationId, {
				subjectIds: ["translation"],
				decision: "undo",
				undoDecisionId: undo.decisionId,
			});
			await expect.poll(async () => (await api.resume.getById({ id: copy.resumeId })).data).toEqual(source.data);
		}
		await page.goto(`/dashboard/resumes/${resumeId}/languages`);
		await expect(page.getByRole("heading", { name: "Review Arabic copy" })).toBeVisible();
		const segment = page.locator('[data-slot="translation-segment"]').filter({
			has: page.getByText(firstTranslation, { exact: true }),
		});
		await expect(segment.getByText(firstTranslation, { exact: true })).toBeVisible();
		const expectedStatus = action === "accept" ? "accepted" : "rejected";
		await expect(segment.getByRole("button", { name: /^(Accept|Reject)$/u })).toHaveCount(0);
		await decideVariantFixture(api, operationId, {
			subjectIds: [first.id],
			decision: action === "accept" ? "accept" : "reject",
		});
		const reviewed = await api.ai.variantReview.get({ operationId });
		expect(reviewed.statuses[first.id]).toBe(expectedStatus);
		const saved = await api.resume.getById({ id: copy.resumeId });
		expect(saved.data.summary.content).toContain(`<p>${firstSource}</p>`);
		const retryNotice = page
			.locator('[data-slot="alert"]')
			.filter({ hasText: `Part ${(failedPart.partIndex ?? 0) + 1}` });
		await retryNotice.locator("summary").click();
		await retryNotice.getByRole("button", { name: "Retry this part", exact: true }).click();
		await expect
			.poll(async () => (await api.ai.operations.get({ id: operationId })).retryable, { timeout: 30000 })
			.toBe(false);
		await expect
			.poll(async () => (await api.ai.operations.get({ id: operationId })).resultId, { timeout: 30000 })
			.toBe(operationId);
		const after = await api.ai.variantReview.get({ operationId });
		expect(after.statuses[first.id]).toBe(expectedStatus);
		expect(after.segments[first.id]).toEqual(reviewed.segments[first.id]);
		expect(after.statuses[failedPart.id]).toBe("accepted");
		expect(after.statuses.translation).toBe("pending");
		expect((await api.resume.getById({ id: copy.resumeId })).data.summary.content).toBe(
			saved.data.summary.content.replace("Documented the QA flow.", "وثقت خطوات الاختبار."),
		);
		expect((await api.resume.getById({ id: resumeId })).data).toEqual(source.data);
		await page.reload();
		if (expectedStatus === "rejected") {
			const keptSource = page.locator('[data-slot="translation-segment"] p[lang="en-US"]').filter({
				has: page.getByText(firstSource, { exact: true }),
			});
			await expect(keptSource).toBeVisible();
			await expect(keptSource).toHaveAttribute("dir", "auto");
			await expect(segment).toHaveCount(0);
		} else {
			await expect(segment.getByText(firstTranslation, { exact: true })).toBeVisible();
		}
		const approve = page.getByRole("button", { name: "Approve & save Arabic copy" });
		if (action === "undo and reject") {
			await expect(approve).toBeEnabled();
		} else {
			await expect(approve).toBeDisabled();
			await expect(approve).toHaveAccessibleDescription("Needs edit");
		}
		expect((await api.ai.variantReview.get({ operationId })).statuses[first.id]).toBe(expectedStatus);
	});
}

for (const [locale, width] of [
	["en-US", 1440],
	["en-US", 390],
	["ar-SA", 1440],
	["ar-SA", 390],
] as const) {
	test(`translation checks facts and saves only after approval ${locale} ${width}`, async ({
		authPage: page,
	}, info) => {
		test.setTimeout(90_000);
		await selectCompactTranslation(page);
		await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
		const resumeId = await seedVariantReview(page, info);
		const api = variantClient(page);
		const original = await api.resume.getById({ id: resumeId });
		original.data.summary.title = "";
		original.data.basics.headline = "";
		const marker = crypto
			.randomUUID()
			.replaceAll("-", "")
			.replace(/[0-9]/gu, (digit) => "ghijklmnop"[Number(digit)] ?? "");
		const retryMarker = `Compact retry ${marker}`;
		original.data.summary.content = `<p>Documented the QA flow.</p><p>Supported the release lead on 22% of releases. ${retryMarker}</p>`;
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
		const shot = (state: string) =>
			page.screenshot({
				path: join(shots, `${locale}-${width}-${state}.png`),
			});
		const translate = page.getByRole("button", { name: ar ? "ترجمة إلى العربية" : "Translate to Arabic", exact: true });
		await expect(translate).toBeVisible();
		await shot("overview");
		await translate.click();
		const dialog = page.getByRole("dialog");
		const admission = page.waitForResponse(
			(response) => new URL(response.url()).pathname === "/api/rpc/ai/operations/start",
		);
		await dialog.getByRole("button", { name: ar ? "بدء المراجعة" : "Start review", exact: true }).click();
		expect(await (await admission).text()).toMatch(/"state":"queued"/u);
		await expect(page.getByRole("progressbar")).toBeVisible();
		await expect(page.getByText(ar ? "جارٍ ترجمة السيرة…" : "Translating your CV…")).toBeVisible();
		await settleScreen(page);
		await shot("progress");
		const notice = ar ? "أُبقي مقطع واحد بلغته الأصلية" : "1 part stayed in its original language";
		await expect(page.getByText(notice)).toBeVisible({ timeout: 25000 });
		const variants = await api.resume.variants.list({ resumeId });
		const copy = variants.find((variant) => variant.targetLocale === "ar-SA");
		if (!copy?.operationId) throw new Error("Missing translation target operation");
		const operationId = copy.operationId;
		expect((await api.ai.operations.get({ id: operationId })).progress?.total).toBe(1);
		const saved = await api.resume.getById({ id: copy.resumeId });
		expect(saved.data.summary.content).toBe(source.data.summary.content);
		await page.getByRole("button", { name: ar ? "النسخ واللغات" : "Copies and languages", exact: true }).click();
		await expect(page.getByRole("button", { name: /^(Open Arabic copy|فتح النسخة العربية)$/u })).toHaveCount(0);
		await page.getByRole("button", { name: ar ? "مراجعة المسودة" : "Review draft", exact: true }).click();
		const reason = ar ? "تغيّر الرقم 22%." : "The number 22% changed.";
		const approve = page.getByRole("button", {
			name: ar ? "اعتماد وحفظ النسخة العربية" : "Approve & save Arabic copy",
		});
		const gapAlert = page.locator('[data-slot="alert"]').filter({ hasText: notice });
		const details = gapAlert.locator("details");
		await expect(details).not.toHaveAttribute("open", "");
		await shot("review-with-gaps");
		await captureReviewFooter(page, info, "translation-footer", approve);
		if (process.env.IMPECCABLE_BIN && locale === "en-US" && width === 1440)
			await captureTranslationDetector(page, process.env.IMPECCABLE_BIN);
		await details.locator("summary").click();
		await expect(gapAlert.getByText(reason)).toBeVisible();
		await expect(gapAlert.locator("bdi")).toContainText(retryMarker);
		await expect(gapAlert.locator("bdi")).toHaveCSS("direction", "ltr");
		const retryLabel = ar ? "إعادة محاولة هذا المقطع" : "Retry this segment";
		const retry = gapAlert.getByRole("button", { name: retryLabel, exact: true });
		await expect(retry).toHaveAttribute("data-variant", "secondary");
		const retryBounds = await retry.boundingBox();
		const gapRow = await gapAlert.getByRole("listitem").boundingBox();
		if (!retryBounds || !gapRow) throw new Error("Missing retry row or action");
		expect(ar ? retryBounds.x - gapRow.x : gapRow.x + gapRow.width - retryBounds.x - retryBounds.width).toBeCloseTo(0);
		const retryAll = gapAlert.getByRole("button", {
			name: ar ? "إعادة محاولة الأجزاء غير المترجمة" : "Retry untranslated parts",
		});
		await expect(retryAll).toHaveAttribute("data-variant", "secondary");
		if (width === 390) {
			expect(retryBounds.height).toBeGreaterThanOrEqual(44);
			expect((await retryAll.boundingBox())?.height).toBeGreaterThanOrEqual(44);
			const footer = page.locator('[data-slot="sticky-actions"]');
			await expect(footer).toBeInViewport();
			const bar = await footer.boundingBox();
			const nav = await page.locator('[data-slot="app-bottom-nav"]').boundingBox();
			if (!bar || !nav) throw new Error("Missing mobile sticky bar or navigation");
			expect(bar.y + bar.height).toBeLessThanOrEqual(nav.y + 1);
			expect((await approve.boundingBox())?.height).toBeGreaterThanOrEqual(44);
			await shot("mobile-sticky");
		}
		expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
		expect(await page.locator("#main-content").evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);
		await captureReviewDirection(page, info, "translation-withheld-segment");
		await page.goto(`/builder/${copy.resumeId}`);
		const builderGap = page
			.getByRole("region", { name: ar ? "تفاصيل النسخة" : "Copy context" })
			.locator('[data-slot="alert"]')
			.filter({ hasText: notice });
		await builderGap.locator("summary").click();
		await expect(builderGap.getByText(reason)).toBeVisible();
		await expect(builderGap.getByRole("button", { name: retryLabel, exact: true })).toHaveAttribute(
			"data-variant",
			"secondary",
		);
		await page.goto(`/dashboard/resumes/${resumeId}/languages`);
		await details.locator("summary").click();
		await retry.click();
		await expect
			.poll(() => api.ai.operations.get({ id: operationId }), { timeout: 30000 })
			.toMatchObject({ state: "waiting_review", retryable: false });
		await expect(page.getByText("ساندت مسؤول الإصدار في 22% من الإصدارات.", { exact: true })).toBeVisible();
		await expect(page.getByText(notice)).toHaveCount(0);
		expect((await api.resume.getById({ id: copy.resumeId })).data.summary.content).toBe(saved.data.summary.content);
		await expect(approve).toBeEnabled();
		await shot("review-without-gaps");
		await approve.click();
		await expect(page.getByText(ar ? "تم حفظ النسخة العربية" : "Arabic copy saved", { exact: true })).toBeVisible({
			timeout: 30000,
		});
		const repaired = await api.resume.getById({ id: copy.resumeId });
		expect(repaired.data.summary.content).toContain("ساندت مسؤول الإصدار في 22% من الإصدارات.");
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

for (const decision of ["discard", "approve"] as const) {
	test(`whole draft ${decision} survives reload when a segment is untranslated`, async ({ authPage: page }, info) => {
		await selectCompactTranslation(page);
		const resumeId = await seedVariantReview(page, info);
		const api = variantClient(page);
		const original = await api.resume.getById({ id: resumeId });
		original.data.basics.headline = "";
		original.data.summary.title = "";
		const marker = crypto
			.randomUUID()
			.replaceAll("-", "")
			.replace(/[0-9]/gu, (digit) => "ghijklmnop".charAt(Number(digit)));
		const retained = `Supported the release lead on 22% of releases. Compact retry ${marker}`;
		original.data.summary.content = `<p>Documented the QA flow.</p><p>${retained}</p>`;
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
		await page.goto(`/dashboard/resumes/${resumeId}/languages`);
		await expect(page.getByText("1 part stayed in its original language")).toBeVisible();
		if (decision === "approve") {
			const review = await api.ai.variantReview.get({ operationId });
			const passage = review.sourceSegments.find(({ text }) => text === "Documented the QA flow.");
			if (!passage) throw new Error("Missing verified passage");
			await page.getByRole("button", { name: "Show original text", exact: true, pressed: false }).click();
			const segment = page.locator('[data-slot="translation-segment"]').filter({
				has: page.getByText(passage.text, { exact: true }),
			});
			await segment.getByRole("button", { name: "Keep original" }).click();
			await expect(segment.getByText("Edited", { exact: true })).toBeVisible();
			expect((await api.ai.variantReview.get({ operationId })).segments[passage.id]).toMatchObject({
				author: "user",
				text: passage.text,
			});
			expect((await api.resume.getById({ id: copy.resumeId })).data).toEqual(source.data);
			await segment.getByRole("button", { name: "Undo" }).click();
			await expect(segment.getByText("Edited", { exact: true })).toHaveCount(0);
		}
		const button = page.getByRole("button", {
			name: decision === "discard" ? "Discard draft" : "Approve & save Arabic copy",
		});
		await expect(button).toBeEnabled();
		await button.click();
		await expect(page.getByRole("heading", { name: "Copies and languages" })).toBeVisible();
		await page.reload();
		await expect(page.getByRole("heading", { name: "Copies and languages" })).toBeVisible();
		await expect(page.getByRole("button", { name: "Review draft" })).toHaveCount(0);
		const copyAfter = await api.resume.getById({ id: copy.resumeId });
		if (decision === "discard") {
			await expect(page.getByRole("button", { name: "Open Arabic copy" })).toHaveCount(0);
			expect(copyAfter.data).toEqual(source.data);
			expect((await api.ai.variantReview.get({ operationId })).statuses.translation).toBe("rejected");
		} else {
			await expect(page.getByRole("button", { name: "Open Arabic copy" })).toBeVisible();
			expect(copyAfter.data.summary.content).toContain(retained);
			expect(copyAfter.data.summary.content).toContain("وثقت خطوات الاختبار.");
			expect((await api.ai.variantReview.get({ operationId })).statuses.translation).toBe("accepted");
		}
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
			await expect(dialog.getByText(/OpenRouter/u)).toBeVisible();
			expect((await api.ai.usage.get()).operations).toMatchObject({ used: 0, reserved: 0, remaining: 5 });
			expect((await api.resume.variants.list({ resumeId })).some((item) => item.variantKind === "language")).toBe(
				false,
			);
			await page.screenshot({ path: info.outputPath("translation-consent.png") });
			await dialog.getByRole("button", { name: ar ? "بدء المراجعة" : "Start review", exact: true }).click();
			let language: Awaited<ReturnType<typeof api.resume.variants.list>>[number] | undefined;
			await expect
				.poll(async () => {
					language = (await api.resume.variants.list({ resumeId })).find(
						(document) => document.variantKind === "language",
					);
					return language?.resumeId;
				})
				.toBeTruthy();
			if (!language) throw new Error("Expected language copy");
			const languageId = language.resumeId;
			const progress = page.getByRole("progressbar", {
				name: ar ? /اكتمل [0-3] من 4 أجزاء/u : /[0-3] of 4 parts complete/u,
			});
			await expect(progress).toBeVisible();
			await expect(progress).toHaveAttribute("max", "4");
			await expect(progress).toHaveAttribute("value", /^[0-3]$/u);
			await expect(page.getByText(ar ? "جارٍ ترجمة السيرة…" : "Translating your CV…")).toBeVisible();
			await expect(page.getByRole("button", { name: ar ? "فتح" : "Open", exact: true })).toHaveCount(0);
			await expect(page.getByText(ar ? "مسودة جاهزة للمراجعة" : "Draft ready to review", { exact: true })).toHaveCount(
				0,
			);
			if (process.env.E2E_PUBLIC_EVIDENCE_DIR)
				await page.locator('[data-slot="review-progress"]').screenshot({
					path: join(process.env.E2E_PUBLIC_EVIDENCE_DIR, `translation-${locale}-${width}.png`),
				});
			const latest = async () =>
				(await api.resume.variants.list({ resumeId })).find((document) => document.resumeId === languageId)
					?.operationId;
			await expect.poll(latest).toBeTruthy();
			const operationId = await latest();
			if (!operationId) throw new Error("Expected root translation operation");
			const compare = page.getByRole("button", {
				name: ar ? "مقارنة بالأصل" : "Compare with original",
				exact: true,
			});
			const withheldNotice = ar ? "أُبقي مقطع واحد بلغته الأصلية" : "1 part stayed in its original language";
			await expect(page.getByText(withheldNotice)).toBeVisible({ timeout: 30000 });
			const partialReview = await api.ai.variantReview.get({ operationId });
			if (partialReview.result.kind !== "review.translation") throw new Error("Expected partial translation");
			const stoppedIndex = partialReview.result.withheld?.items?.[0]?.partIndex;
			if (stoppedIndex === undefined) throw new Error("Expected the withheld part index");
			const gapNotice = page.locator('[data-slot="alert"]').filter({ hasText: withheldNotice });
			await gapNotice.locator("summary").click();
			await expect(
				page.getByText(ar ? `الجزء ${stoppedIndex + 1}` : `Part ${stoppedIndex + 1}`, { exact: true }),
			).toBeVisible();
			await expect(page.getByText(ar ? "لم يُترجم بعد" : "Not translated yet", { exact: true }).first()).toBeVisible();
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
			await compare.click();
			const stopped = page.getByText(withheldNotice);
			await expect(stopped).toBeVisible();
			await stopped.scrollIntoViewIfNeeded();
			await settleScreen(page);
			expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
			await page.screenshot({ path: info.outputPath("translation-part-stopped.png") });
			await gapNotice.locator("summary").click();
			await gapNotice
				.getByRole("button", { name: ar ? "إعادة محاولة هذا الجزء" : "Retry this part", exact: true })
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
			await page.getByRole("button", { name: ar ? "النسخ واللغات" : "Copies and languages", exact: true }).click();
			await expect(page.getByText(ar ? "العربية · جاهزة" : "Arabic · Ready", { exact: true })).toBeVisible();
			await expect(
				page.getByRole("button", { name: ar ? "فتح النسخة العربية" : "Open Arabic copy", exact: true }),
			).toBeVisible();
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
			await expect(page.getByText(ar ? "العربية · جاهزة" : "Arabic · Ready", { exact: true })).toBeVisible();
			await page.getByRole("button", { name: ar ? "مقارنة بالأصل" : "Compare with original", exact: true }).click();
			const confirmedToggle = page.locator("summary").filter({ hasText: /34/u });
			await expect(confirmedToggle).toBeVisible();
			await confirmedToggle.click();
			await expect(confirmedToggle.locator("..").getByText("Synthetic Institute 0", { exact: true })).toBeVisible();
			await page.screenshot({ path: info.outputPath("translation-bulk-names.png") });
			await page.reload();
			const review = await api.ai.variantReview.get({ operationId });
			expect(review.terms.terms.filter((term) => term.value === term.source)).toHaveLength(34);
			expect(review.statuses.translation).toBe("accepted");
			expect((await api.resume.getById({ id: language.resumeId })).data.metadata.page.locale).toBe("ar-SA");
			expect((await api.resume.getById({ id: resumeId })).data).toEqual(source.data);
			expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
		});
