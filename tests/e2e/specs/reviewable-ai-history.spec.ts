import { join } from "node:path";
import { buildJobPassages } from "@reactive-resume/resume/ats";
import { openWriting, seedReview } from "../fixtures/reviewable-ai";
import { expect, test } from "../fixtures/test";
import { startVariantReview, variantClient } from "../fixtures/variants";

for (const locale of ["en-US", "ar-SA"] as const) {
	for (const width of [1440, 390]) {
		test(`reopens review history and keeps clarification usable in ${locale} at ${width}px`, async ({
			authPage: page,
		}, info) => {
			test.setTimeout(90_000);
			await page.setViewportSize({ width, height: 900 });
			const resumeId = await seedReview(page, info, locale);
			const api = variantClient(page);
			const sample = await api.resume.getById({ id: resumeId });
			const experience = sample.data.sections.experience.items[0];
			if (!experience) throw new Error("Missing synthetic work experience");
			experience.description = "<ul><li>Built internal tools.</li><li>Built reporting tools.</li></ul>";
			await expect(
				await page.request.put(`/api/openapi/resumes/${resumeId}`, {
					data: { data: sample.data, expectedUpdatedAt: sample.updatedAt.toISOString() },
				}),
			).toBeOK();
			await page.reload();
			await openWriting(page, width);
			const arabic = locale === "ar-SA";
			const tab = page.locator('[data-review-tab="ai"]');
			const capture = async (state: string) => {
				await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
				await page.evaluate(() => document.fonts.ready.then(() => undefined));
				const filename = `${locale}-${width}-${state}.png`;
				const evidence = process.env.E2E_PUBLIC_EVIDENCE_DIR;
				await page.screenshot({
					path: evidence ? join(evidence, filename) : info.outputPath(filename),
					animations: "disabled",
				});
			};
			await expect(page.getByText(arabic ? "لا توجد مراجعات بعد" : "No reviews yet", { exact: true })).toBeVisible();
			await expect(tab.locator('[data-slot="tabs-count"]')).toHaveCount(0);
			await capture("empty");
			const cv = await api.resume.getById({ id: resumeId });
			const targets = [{ sectionId: "summary", field: "content" }];
			const prepared = await api.ai.review.prepare({
				resumeId,
				targets,
				expectedUpdatedAt: cv.updatedAt.toISOString(),
			});
			const parentId = await startVariantReview(page, {
				kind: "review.wording",
				sources: prepared.sources,
				parameters: { resumeId, targets, action: "result", interfaceLocale: locale },
			});
			await page.reload();
			await openWriting(page, width);
			await expect(
				page.getByRole("heading", { name: arabic ? /بانتظار مراجعتك/u : /Needs your review/u }),
			).toBeVisible();
			await expect(tab.locator('[data-slot="tabs-count"]')).toHaveText("1");
			await capture("needs-review");
			const review = page.locator(`[data-review-operation="${parentId}"]`);
			await expect(review.getByRole("button", { name: /^(Accept|قبول)$/u })).toHaveCount(0);
			const add = review.getByRole("button", { name: /^(Add information|إضافة معلومة)$/u });
			const question = review.locator("[data-review-question]");
			const prompt = await question.textContent();
			expect(prompt?.trim()).toBeTruthy();
			expect(prompt).toBe(
				arabic ? "ما النتيجة أو التفصيل الذي يمكنك تأكيده في هذا المقطع؟" : "What result can you confirm?",
			);
			await add.click();
			const dialog = page.getByRole("dialog");
			await expect(dialog.getByText(prompt ?? "", { exact: true })).toBeVisible();
			await capture("question-modal");
			const answer = "Built a reporting project.";
			const input = dialog.getByRole("textbox", { name: arabic ? "إجابتك" : "Your answer" });
			await input.fill(answer);
			await page.route(
				/\/api\/rpc\/ai\/review\/answer(?:\?|$)/u,
				(route) =>
					route.fulfill({
						status: 409,
						json: {
							json: { code: "CONFLICT", status: 409, message: "Conflict", data: { reason: "AI_SOURCE_CHANGED" } },
						},
					}),
				{ times: 1 },
			);
			await dialog.getByRole("button", { name: arabic ? "حفظ الإجابة" : "Save answer", exact: true }).click();
			const retry = dialog.getByRole("button", { name: arabic ? "إعادة المحاولة" : "Retry", exact: true });
			await expect(retry).toBeVisible();
			await expect(input).toHaveValue(answer);
			await retry.click();
			await expect(dialog).toHaveCount(0);
			await expect(review.getByText(answer, { exact: true })).toBeVisible();
			await expect(review.getByText(answer, { exact: true })).toHaveAttribute("dir", "auto");
			await expect(tab.locator('[data-slot="tabs-count"]')).toHaveCount(0);
			const follow = review.getByRole("button", {
				name: arabic ? "إعادة المراجعة بهذه الإجابة" : "Review with this answer",
			});
			await expect(follow).toBeEnabled();
			await capture("saved-answer");
			await follow.click();
			const child = page.locator(`[data-review-operation]:not([data-review-operation="${parentId}"])`);
			const keep = child.getByRole("button", { name: /^(Keep original|الإبقاء على الأصل)$/u });
			await expect(keep).toBeVisible({ timeout: 25_000 });
			const shortcut = arabic ? /اضغط A لقبول التعديل/u : /A accepts and R rejects the focused edit/u;
			await expect(child.locator("[data-proposal-index]")).toHaveAccessibleDescription(shortcut);
			await expect(child.getByText(shortcut)).toBeHidden();
			const id = await child.getAttribute("data-review-operation");
			const view = await api.ai.review.get({ operationId: id ?? "" });
			expect(view.result).toMatchObject({
				proposals: [{ after: expect.stringContaining(answer) }],
				evidence: expect.arrayContaining([expect.objectContaining({ quote: answer, confirmation: "user_supplied" })]),
			});
			expect((await api.ai.usage.get()).operations.used).toBe(1);
			await keep.click();
			const past = page.locator("summary").filter({ hasText: arabic ? /المراجعات السابقة/u : /Past reviews/u });
			await expect(past).toBeVisible();
			await expect(
				child.locator('[data-slot="badge"]').getByText(arabic ? "مرفوض" : "Rejected", { exact: true }),
			).toBeVisible();
			const undoButton = page.getByRole("button", { name: arabic ? "تراجع" : "Undo", exact: true });
			const actions = child.locator('[data-slot="action-group"]').filter({ has: undoButton });
			await expect(actions.getByRole("button", { name: arabic ? "المصدر" : "Evidence", exact: true })).toBeVisible();
			await expect
				.poll(() =>
					actions.evaluateAll(([row], rtl) => {
						const [evidence, undo] = row?.querySelectorAll("button") ?? [];
						const evidenceBox = evidence?.getBoundingClientRect();
						const undoBox = undo?.getBoundingClientRect();
						if (!evidenceBox?.width || !undoBox?.width) return null;
						return {
							sameRow: evidenceBox.y === undoBox.y,
							order: rtl ? evidenceBox.x > undoBox.x : evidenceBox.x < undoBox.x,
						};
					}, arabic),
				)
				.toEqual({ sameRow: true, order: true });
			await expect(question).toHaveText(prompt ?? "");
			await child.evaluate((card) => card.scrollIntoView({ block: "center" }));
			await capture("past-reviews");

			const experienceTargets = [{ sectionId: "experience", itemId: experience.id, field: "description" }];
			const experienceSources = await api.ai.review.prepare({
				resumeId,
				targets: experienceTargets,
				expectedUpdatedAt: cv.updatedAt.toISOString(),
			});
			const experienceId = await startVariantReview(page, {
				kind: "review.wording",
				sources: experienceSources.sources,
				parameters: {
					resumeId,
					targets: experienceTargets,
					action: "custom",
					request: "Review the second reporting bullet",
					interfaceLocale: locale,
				},
			});
			const fact = buildJobPassages(cv.data).find(
				({ target }) =>
					target.sectionId === "experience" && target.itemId === experience.id && target.field === "description",
			);
			if (!fact) throw new Error("Missing experience description");
			expect(fact.text).toContain("Built reporting tools.");
			const summaryId = await startVariantReview(
				page,
				await api.ai.variantReview.prepare({
					kind: "review.summary",
					resumeId,
					expectedUpdatedAt: cv.updatedAt.toISOString(),
					selectedEvidenceIds: [fact.id],
					interfaceLocale: locale,
				}),
			);
			await page.reload();
			await openWriting(page, width);
			const active = page.getByRole("region", { name: arabic ? /بانتظار مراجعتك/u : /Needs your review/u });
			const experienceReview = active.locator(`[data-review-operation="${experienceId}"]`);
			const accept = experienceReview.getByRole("button", { name: /^(Accept|قبول)$/u });
			await expect(accept).toBeVisible();
			const summaryReview = active
				.getByRole("heading", { name: arabic ? "مراجعة الملخص المهني" : "Summary review" })
				.locator("..");
			await expect(active.getByText(fact.text, { exact: true })).toBeVisible();
			const history = async (id: string) =>
				(await api.ai.review.list({ resumeId })).find((row) => row.operationId === id);
			await summaryReview.getByRole("button", { name: /^(Reject|رفض|Keep original|الإبقاء على الأصل)$/u }).click();
			await expect.poll(() => history(summaryId)).toMatchObject({ rejectedCount: 1, pendingCount: 0 });
			await accept.click();
			await expect.poll(() => history(experienceId)).toMatchObject({ acceptedCount: 1, pendingCount: 0 });
			const description = async () =>
				(await api.resume.getById({ id: resumeId })).data.sections.experience.items.find(
					({ id }) => id === experience.id,
				)?.description;
			await expect.poll(description).toContain("Developed reporting tools.");
			await page.reload();
			await openWriting(page, width);
			await expect(past).toBeVisible();
			await expect(
				page.locator("summary").filter({ hasText: arabic ? "مراجعة الملخص المهني" : "Summary review" }),
			).toContainText(arabic ? "أُبقي النص الأصلي" : "Kept original");
			await page
				.locator("summary")
				.filter({ hasText: arabic ? "طُبّقت التعديلات" : "Applied" })
				.click();
			const reopened = page.locator(`[data-review-operation="${experienceId}"]`);
			await expect(reopened.getByText("Developed reporting tools.", { exact: true })).toBeVisible();
			await reopened.getByRole("button", { name: /^(Undo|تراجع)$/u }).click();
			await expect.poll(description).toContain("Built reporting tools.");

			const edited = await api.resume.getById({ id: resumeId });
			const editedExperience = edited.data.sections.experience.items.find(({ id }) => id === experience.id);
			if (!editedExperience) throw new Error("Missing reopened work experience");
			editedExperience.description = "<ul><li>Built internal tools.</li><li>Maintained reporting tools.</li></ul>";
			await expect(
				await page.request.put(`/api/openapi/resumes/${resumeId}`, {
					data: { data: edited.data, expectedUpdatedAt: edited.updatedAt.toISOString() },
				}),
			).toBeOK();
			await page.reload();
			await openWriting(page, width);
			await page
				.getByRole("button", {
					name: arabic ? "تغيير الواجهة إلى الإنجليزية" : "Switch interface to Arabic",
				})
				.click();
			await expect(page.locator("html")).toHaveAttribute("dir", arabic ? "ltr" : "rtl");
			await openWriting(page, width);
			const stale = page.locator("summary").filter({ hasText: arabic ? /Out of date/u : /تغيّر النص منذ المراجعة/u });
			await stale.filter({ hasText: arabic ? /Experience/u : /الخبرة/u }).click();
			await expect(reopened.getByRole("button", { name: /^(Accept|قبول)$/u })).toHaveCount(0);
			await expect.poll(description).toBe(editedExperience.description);
			await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
		});
	}
}
