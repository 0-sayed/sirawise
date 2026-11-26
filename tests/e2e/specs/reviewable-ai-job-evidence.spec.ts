import type { Page } from "@playwright/test";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { chromium } from "@playwright/test";
import { projectItemSchema } from "@reactive-resume/schema/resume/data";
import { readVerifierDispatches, simulateVerifierBackup } from "../fixtures/reviewable-ai";
import { settleScreen } from "../fixtures/screen";
import { expect, test } from "../fixtures/test";
import {
	seedVariantReview,
	variantClient,
	startVariantReview,
	seedTailoringReview,
	launchTailoringReview,
} from "../fixtures/variants";

async function captureJobPageDetector(page: Page, executable: string, output: string) {
	const profile = await mkdtemp(join(tmpdir(), "job-page-detector-"));
	const browser = await chromium.launchPersistentContext(profile, {
		viewport: page.viewportSize(),
		args: ["--remote-debugging-port=0"],
	});
	try {
		const [port] = (await readFile(join(profile, "DevToolsActivePort"), "utf8")).split("\n");
		await browser.addCookies(await page.context().cookies(page.url()));
		const copy = browser.pages()[0] ?? (await browser.newPage());
		await copy.goto(page.url());
		await expect(copy.getByRole("heading", { name: "Key terms from the job ad" })).toBeVisible();
		await settleScreen(copy);
		const result = await promisify(execFile)(
			executable,
			["detect", "--json", "--cdp", port ?? "", "--target", "/job"],
			{
				env: { HOME: process.env.HOME, PATH: process.env.PATH },
				timeout: 45_000,
				maxBuffer: 4 * 1024 * 1024,
			},
		).catch((error: { code?: number; stdout?: string }) => {
			if (error.code === 2 && error.stdout) return { stdout: error.stdout };
			throw error;
		});
		await writeFile(output, result.stdout);
	} finally {
		await browser.close();
	}
}

for (const locale of ["ar-SA", "en-US"] as const) {
	for (const width of [390, 1440]) {
		test(`job evidence has one beta badge and keeps unchecked text private in ${locale} at ${width}`, async ({
			authPage: page,
			baseURL,
		}, info) => {
			if (!baseURL) throw new Error("Missing browser base URL");
			await page.setViewportSize({ width, height: 900 });
			await page.context().addCookies([{ name: "locale", value: locale, url: baseURL }]);
			await simulateVerifierBackup(page);
			const id = await seedVariantReview(page, info);
			await expect(
				await page.request.post("/api/auth/update-user", {
					data: { uiLocale: locale },
					headers: { origin: baseURL },
				}),
			).toBeOK();
			const ar = locale === "ar-SA";
			const beta = page.getByText(ar ? "تجريبي" : "Beta", { exact: true });
			await page.goto(`/dashboard/resumes/${id}/job`);
			await expect(page.locator("html")).toHaveAttribute("lang", locale);
			await expect(page).toHaveTitle(ar ? "المقارنة بوظيفة — سيراوايز" : "Job comparison — Sirawise");
			await page.getByLabel(ar ? "المسمى الوظيفي" : "Job title", { exact: true }).fill("Engineer");
			await page
				.getByLabel(ar ? "إعلان الوظيفة" : "Job ad", { exact: true })
				.fill("Synthetic backup recovery: SAP.\nSynthetic ability claim: Rust.");
			await page.getByRole("button", { name: ar ? "مقارنة بالوظيفة" : "Compare with job", exact: true }).click();
			await expect(beta).toHaveCount(1);
			const details = page.getByRole("button", {
				name: ar ? /فحص متطلبات الوظيفة بالتفصيل/u : /Detailed requirement check/u,
			});
			await expect(details).toHaveAttribute("aria-expanded", "false");
			await details.focus();
			await details.press("Enter");
			await expect(details).toBeFocused();
			await expect(details).toHaveAttribute("aria-expanded", "true");
			await page
				.getByRole("button", { name: ar ? "فحص متطلبات الوظيفة" : "Check job requirements", exact: true })
				.click();
			await page
				.getByRole("dialog")
				.getByRole("button", { name: ar ? "بدء المراجعة" : "Start review", exact: true })
				.click();
			const unchecked = page.getByRole("button", {
				name: ar ? "عرض المتطلبات التي لم تُفحص" : "Show unchecked requirements",
			});
			await expect(unchecked).toBeVisible({ timeout: 30000 });
			await expect(beta).toHaveCount(1);
			await expect(unchecked).toHaveAttribute("aria-expanded", "false");
			await expect(page.getByRole("listitem").filter({ hasText: "Synthetic ability claim: Rust." })).toHaveCount(0);
			await unchecked.click();
			const withheld = page.getByRole("listitem").filter({ hasText: "Synthetic ability claim: Rust." });
			await expect(withheld.locator("bdi")).toHaveAttribute("dir", "auto");
			await expect(withheld.locator("bdi")).toHaveCSS("text-overflow", "ellipsis");
			await expect(page.getByText("The candidate cannot use Rust.", { exact: true })).toHaveCount(0);
			await expect(page.getByRole("button", { name: ar ? "إعادة المحاولة" : "Retry", exact: true })).toHaveAttribute(
				"data-variant",
				"secondary",
			);
		});
	}
}

test("backup verification retains scoped absence and never delivers an ability claim", async ({
	authPage: page,
}, info) => {
	await simulateVerifierBackup(page);
	const id = await seedVariantReview(page, info);
	const api = variantClient(page);
	const cv = await api.resume.getById({ id });
	await page.goto(`/dashboard/resumes/${id}/job`);
	await page.getByLabel("Job title", { exact: true }).fill("Engineer");
	await page
		.getByLabel("Job ad", { exact: true })
		.fill("Synthetic backup recovery: SAP.\nSynthetic ability claim: Rust.");
	await page.getByRole("button", { name: "Compare with job", exact: true }).click();
	await page.getByRole("button", { name: /Detailed requirement check/u }).click();
	await page.getByRole("button", { name: "Check job requirements", exact: true }).click();
	const dialog = page.getByRole("dialog");
	await expect(dialog.getByText("The DeepSeek checker can use Parasail", { exact: false })).toBeVisible();
	await dialog.getByRole("button", { name: "Start review", exact: true }).click();
	await expect
		.poll(async () => (await api.career.jobTargets.evidence({ resumeId: id })).semantic.state, {
			timeout: 30000,
		})
		.toBe("waiting-review");
	const semantic = (await api.career.jobTargets.evidence({ resumeId: id })).semantic;
	if (!("operationId" in semantic)) throw new Error("Missing recovered operation");
	expect(await readVerifierDispatches(semantic.operationId)).toEqual([
		{ endpoint: "primary", outcome: "transient" },
		{ endpoint: "backup", outcome: "valid" },
	]);
	const review = await api.ai.variantReview.get({ operationId: semantic.operationId });
	expect(review.result).toMatchObject({
		kind: "review.job-evidence",
		output: { requirements: [{ explanation: "The selected passages do not show SAP." }] },
		withheld: {
			items: [
				expect.objectContaining({
					id: "requirement-1",
					reason: "JOB_INVALID_ASSESSMENT",
					text: "The candidate cannot use Rust.",
				}),
			],
		},
	});
	await expect(page.getByText("The selected passages do not show SAP.", { exact: true })).toBeVisible();
	const withheld = page.getByRole("listitem").filter({ hasText: "Synthetic ability claim: Rust." });
	await page.getByRole("button", { name: "Show unchecked requirements" }).click();
	await expect(withheld.locator("bdi")).toBeVisible();
	await expect(page.getByText("The candidate cannot use Rust.", { exact: true })).toHaveCount(0);
	expect((await api.resume.getById({ id })).data).toEqual(cv.data);
	expect((await api.ai.usage.get()).operations).toMatchObject({ used: 1, reserved: 0 });
});

test("exact pasted job survives refresh, verified findings do not change the CV, and copies are intentional", async ({
	authPage: page,
}, info) => {
	const resumeId = await seedVariantReview(page, info);
	const api = variantClient(page);
	const original = await api.resume.getById({ id: resumeId });
	const text = "  TypeScript required.\nلا يشترط SAP.  ";
	await page.goto(`/dashboard/resumes/${resumeId}/job`);
	await page.getByLabel("Job title", { exact: true }).fill("Product engineer");
	await page.getByLabel("Job ad", { exact: true }).fill(text);
	await page.getByRole("button", { name: "Compare with job", exact: true }).click();
	await expect(page.getByText("Key terms from the job ad", { exact: true })).toBeVisible();
	await page.reload();
	const report = await api.career.jobTargets.evidence({ resumeId });
	if (!report.selection) throw new Error("Expected saved selection");
	expect(report.job?.text).toBe(text);
	expect(report.semantic.state).not.toBe("complete");
	expect((await api.resume.getById({ id: resumeId })).updatedAt).toEqual(original.updatedAt);
	await page.getByRole("button", { name: /Detailed requirement check/u }).click();
	await page.getByRole("button", { name: "Check job requirements", exact: true }).click();
	await page.getByRole("dialog").getByRole("button", { name: "Start review", exact: true }).click();
	await expect(page.getByRole("dialog")).toHaveCount(0);
	await expect
		.poll(async () => (await api.career.jobTargets.evidence({ resumeId })).semantic.state, { timeout: 30000 })
		.toBe("waiting-review");
	const semantic = (await api.career.jobTargets.evidence({ resumeId })).semantic;
	if (!("operationId" in semantic)) throw new Error("Review was not started");
	const operationId = semantic.operationId;
	const review = await api.ai.variantReview.get({ operationId });
	expect(review.result).toMatchObject({
		kind: "review.job-evidence",
		output: { notes: ["Read the selected evidence before acting."] },
		withheld: { items: [expect.objectContaining({ id: "note:1", reason: "AI_UNSUPPORTED_CLAIM" })] },
	});
	await api.ai.variantReview.decide({
		operationId,
		requestKey: crypto.randomUUID(),
		expectedUpdatedAt: review.updatedAt,
		expectedDecisionId: review.latestDecisionId,
		subjectIds: ["report"],
		decision: "accept",
	});
	expect((await api.career.jobTargets.evidence({ resumeId })).semantic.state).toBe("complete");
	const copy = await api.resume.variants.create({
		sourceResumeId: resumeId,
		expectedUpdatedAt: original.updatedAt.toISOString(),
		variantKind: "job",
		requestKey: crypto.randomUUID(),
		jobId: report.selection.jobId,
		jobRevision: report.selection.jobRevision,
	});
	expect((await api.resume.getById({ id: copy.resumeId })).data).toEqual(original.data);
	expect((await api.resume.getById({ id: resumeId })).data).toEqual(original.data);
	await page.reload();
	const found = page.getByRole("region", { name: /Already in your CV/ });
	await found.getByRole("button", { name: /^typescript Occurrences: 1$/iu }).click();
	await page
		.getByRole("dialog")
		.getByRole("link", { name: /^Show in CV:/u })
		.first()
		.click();
	await expect(page).toHaveURL(/builder\/.*source=/);
	await expect(page.locator("#sidebar-summary")).toBeVisible();
});
test("a changed selection fences a delayed semantic review", async ({ authPage: page }, info) => {
	const id = await seedVariantReview(page, info);
	const api = variantClient(page);
	const cv = await api.resume.getById({ id });
	const job = await api.career.jobTargets.save({ role: "Engineer", employer: "", text: "TypeScript required." });
	const selection = await api.career.jobTargets.select({
		resumeId: id,
		expectedUpdatedAt: cv.updatedAt.toISOString(),
		jobId: job.jobId,
		jobRevision: job.revision,
		expectedSelectionRevision: null,
	});
	const prepared = await api.ai.variantReview.prepare({
		kind: "review.job-evidence",
		resumeId: id,
		expectedUpdatedAt: cv.updatedAt.toISOString(),
		jobId: job.jobId,
		jobRevision: job.revision,
		expectedSelectionRevision: selection.revision,
	});
	const operationId = await startVariantReview(page, prepared);
	const next = await api.career.jobTargets.save({
		jobId: job.jobId,
		expectedRevision: job.revision,
		role: "Changed",
		employer: "",
		text: "SAP required.",
	});
	await api.career.jobTargets.select({
		resumeId: id,
		expectedUpdatedAt: cv.updatedAt.toISOString(),
		jobId: next.jobId,
		jobRevision: next.revision,
		expectedSelectionRevision: selection.revision,
	});
	expect((await api.ai.variantReview.get({ operationId })).stale).toBe(true);
});

test("tailoring proposals accept, edit, reject and undo persist only the selected copy across reload", async ({
	authPage: page,
}, info) => {
	const { sourceId, copyId, original } = await seedTailoringReview(page, info);
	const api = variantClient(page);
	await launchTailoringReview(page, copyId);
	const proposals = page.locator("[data-proposal-index]");
	await expect(proposals).toHaveCount(3, { timeout: 30000 });
	await expect(page.getByRole("button", { name: "Accept all", exact: true })).toHaveCount(0);
	const summary = proposals.filter({ hasText: "Did not manage a budget." });
	const dashboard = proposals.filter({ hasText: "TypeScript dashboards." });
	const pipeline = proposals.filter({ hasText: "TypeScript pipelines." });
	await expect(dashboard.locator("del")).toHaveText("Built");
	await expect(pipeline.locator("del")).toHaveText("Built");
	expect((await api.resume.getById({ id: copyId })).data).toEqual(original.data);
	await summary.getByRole("button", { name: "Accept", exact: true }).click();
	await expect(summary.getByText("Applied", { exact: true })).toBeVisible();
	await page.reload();
	await expect(summary.getByText("Applied", { exact: true })).toBeVisible();
	expect((await api.resume.getById({ id: copyId })).data.summary.content).toBe(
		"<p>Developed TypeScript services. Did not manage a budget.</p>",
	);
	await page.getByRole("button", { name: "Undo last action", exact: true }).click();
	await expect(summary.getByRole("button", { name: "Accept", exact: true })).toBeVisible();
	expect((await api.resume.getById({ id: copyId })).data).toEqual(original.data);
	await summary.getByRole("button", { name: "Accept", exact: true }).click();
	await expect(summary.getByText("Applied", { exact: true })).toBeVisible();
	await dashboard.getByRole("button", { name: "Edit", exact: true }).click();
	await page.getByRole("textbox", { name: "Edited text", exact: true }).fill("Developed dashboards using TypeScript.");
	await page.getByRole("button", { name: "Save wording", exact: true }).click();
	const editedDashboard = proposals.filter({ hasText: "Developed dashboards using TypeScript." });
	await expect(editedDashboard.getByText("Applied", { exact: true })).toBeVisible();
	await pipeline.getByRole("button", { name: "Keep original", exact: true }).click();
	await expect(pipeline.getByText("Rejected", { exact: true })).toBeVisible();
	await page.reload();
	await expect(editedDashboard.getByText("Applied", { exact: true })).toBeVisible();
	await expect(pipeline.getByText("Rejected", { exact: true })).toBeVisible();
	const saved = await api.resume.getById({ id: copyId });
	expect(saved.data.summary.content).toBe("<p>Developed TypeScript services. Did not manage a budget.</p>");
	expect(saved.data.sections.projects.items.map((item) => item.description)).toEqual([
		"<p>Developed dashboards using TypeScript.</p>",
		"<p>Built TypeScript pipelines.</p>",
	]);
	expect((await api.resume.getById({ id: sourceId })).data).toEqual(original.data);
	const evidence = await api.career.jobTargets.evidence({ resumeId: copyId });
	expect(evidence.selection).not.toBeNull();
});

for (const locale of ["ar-SA", "en-US"] as const) {
	for (const width of [1440, 390]) {
		test(`accepted wording creates and opens a separate copy in ${locale} at ${width}`, async ({
			authPage: page,
			baseURL,
		}, info) => {
			test.setTimeout(90000);
			if (!baseURL) throw new Error("Missing browser base URL");
			const ar = locale === "ar-SA";
			const sourceId = await seedVariantReview(page, info);
			const api = variantClient(page);
			const cv = await api.resume.getById({ id: sourceId });
			const projectNames = ["Analytics dashboard", "منصة البيانات"];
			cv.data.sections.projects.hidden = false;
			cv.data.sections.projects.items = projectNames.map((name) =>
				projectItemSchema.parse({ id: crypto.randomUUID(), name, hidden: false, period: "", description: "" }),
			);
			cv.data.metadata.layout.pages[0]?.main.push("projects");
			const original = await api.resume.update({
				id: sourceId,
				name: "Software Engineer CV",
				data: cv.data,
				expectedUpdatedAt: cv.updatedAt.toISOString(),
			});
			await page.setViewportSize({ width, height: 900 });
			await page.context().addCookies([{ name: "locale", value: locale, url: baseURL }]);
			await expect(
				await page.request.post("/api/auth/update-user", {
					data: { uiLocale: locale },
					headers: { origin: baseURL },
				}),
			).toBeOK();
			const shot = async (state: string) => {
				await page.evaluate(() => document.fonts.ready.then(() => undefined));
				expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
				await page.screenshot({
					path: process.env.E2E_PUBLIC_EVIDENCE_DIR
						? `${process.env.E2E_PUBLIC_EVIDENCE_DIR}/${locale}-${width}-${state}.png`
						: info.outputPath(`${locale}-${width}-${state}.png`),
					fullPage: true,
					animations: "disabled",
				});
			};
			const main = page.getByRole("main");
			const primary = main.locator('[data-variant="primary"]:is(button, a)');
			await page.goto(`/dashboard/resumes/${sourceId}/job`);
			const compare = page.getByRole("button", { name: ar ? "مقارنة بالوظيفة" : "Compare with job", exact: true });
			await expect(compare).toBeDisabled();
			await expect(primary).toHaveCount(1);
			await shot("empty");
			await page.getByLabel(ar ? "المسمى الوظيفي" : "Job title", { exact: true }).fill("Senior Software Engineer");
			await page.getByLabel(ar ? "جهة العمل (اختياري)" : "Employer (optional)", { exact: true }).fill("Example Co");
			await page
				.getByLabel(ar ? "إعلان الوظيفة" : "Job ad", { exact: true })
				.fill(
					"TypeScript services required. AWS, Kubernetes, Docker, Redis, PostgreSQL, SAP, Figma, and system design. Synthetic delayed review. Synthetic project reorder.",
				);
			await compare.click();
			const launch = page.getByRole("button", {
				name: ar ? "اقتراح تعديلات لهذه الوظيفة" : "Suggest edits for this job",
				exact: true,
			});
			await expect(launch).toBeEnabled();
			await expect(primary).toHaveCount(1);
			await expect(
				page.getByRole("button", { name: ar ? "حفظ النسخة المخصصة" : "Save tailored copy", exact: true }),
			).toHaveCount(0);
			const role = main.getByText("Senior Software Engineer", { exact: true });
			await expect(role).toHaveAttribute("dir", "auto");
			await expect(role).toHaveCSS("direction", "ltr");
			const source = main.getByRole("combobox");
			await expect(source).toHaveCSS("direction", "ltr");
			expect(
				await source.evaluate((element: HTMLSelectElement) => {
					const select = element.getBoundingClientRect();
					const icon = element.nextElementSibling?.getBoundingClientRect();
					const style = getComputedStyle(element);
					const text = document.createElement("canvas").getContext("2d");
					if (!icon || !text) return false;
					text.font = style.font;
					const start = select.left + Number.parseFloat(style.paddingLeft);
					const end = start + text.measureText(element.selectedOptions[0]?.text ?? "").width;
					return end < icon.left && icon.right < select.right;
				}),
			).toBe(true);
			const panel = main.getByRole("region", { name: ar ? "الكلمات المهمة في الإعلان" : "Key terms from the job ad" });
			await expect(panel).not.toContainText(/%|ATS/u);
			await expect(panel.getByRole("button", { name: /typescript services/iu })).toHaveCount(0);
			expect((await api.ai.usage.get()).operations.used).toBe(0);
			const term = panel.getByRole("button").filter({ has: page.getByText("typescript", { exact: true }) });
			await term.focus();
			await term.press("Enter");
			await expect(page.getByRole("dialog").getByRole("link").first()).toContainText("TypeScript");
			await page.keyboard.press("Escape");
			await expect(term).toBeFocused();
			const beta = main.getByRole("button", { name: /Detailed requirement check|فحص متطلبات الوظيفة بالتفصيل/u });
			await expect(beta).toHaveAttribute("aria-expanded", "false");
			for (const target of [
				source,
				launch,
				term,
				beta,
				main.getByRole("button", { name: ar ? "تغيير الوظيفة" : "Change job" }),
			]) {
				const box = await target.boundingBox();
				expect(box?.height).toBeGreaterThanOrEqual(44);
				expect(box?.width).toBeGreaterThanOrEqual(44);
			}
			await main.getByRole("heading", { level: 1 }).evaluate((title) => title.scrollIntoView({ block: "center" }));
			await shot("job-saved");
			await launch.click();
			await page
				.getByRole("dialog")
				.getByRole("button", { name: ar ? "بدء المراجعة" : "Start review", exact: true })
				.click();
			const cancel = main.getByRole("button", { name: ar ? "إلغاء" : "Cancel", exact: true });
			await expect(cancel).toBeVisible();
			await expect(primary).toHaveCount(0);
			await cancel.evaluate((button) => button.scrollIntoView({ block: "center" }));
			await shot("running");
			const proposal = page.locator("[data-proposal-index]").filter({ hasText: "Did not manage a budget." });
			await expect(proposal).toBeVisible({ timeout: 30_000 });
			await expect(proposal).toContainText(ar ? "الملخّص" : "Summary");
			const create = page.getByRole("button", { name: ar ? "حفظ النسخة المخصصة" : "Save tailored copy", exact: true });
			await expect(create).toBeDisabled();
			await expect(primary).toHaveCount(1);
			await proposal.evaluate((edit) => edit.scrollIntoView({ block: "center" }));
			await shot("reviewing");
			await proposal.getByRole("button", { name: ar ? "قبول" : "Accept", exact: true }).click();
			await expect(
				proposal.getByText(ar ? "مقبول للنسخة المخصصة" : "Accepted for the tailored copy", { exact: true }),
			).toBeVisible();
			await expect(create).toBeEnabled();
			await expect(create).toHaveAttribute("data-variant", "primary");
			await expect(page.locator('main button[data-variant="primary"]')).toHaveCount(1);
			const order = main.getByRole("region", { name: ar ? "اقتراح تغيير الترتيب" : "Reorder proposal" });
			const currentOrder = order.getByRole("list", { name: ar ? "الترتيب الحالي" : "Current order" });
			const proposedOrder = order.getByRole("list", { name: ar ? "الترتيب المقترح" : "Proposed order" });
			await expect(currentOrder.getByRole("listitem")).toHaveText(projectNames);
			await expect(proposedOrder.getByRole("listitem")).toHaveText([...projectNames].reverse());
			await expect(proposedOrder.locator("bdi[dir=auto]")).toHaveCount(2);
			await expect(order).not.toContainText(/[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}/iu);
			const undo = main.getByRole("button", { name: ar ? "التراجع عن آخر إجراء" : "Undo last action" });
			const footer = main.locator('[data-slot="action-group"]').filter({ has: create });
			await expect(footer.getByRole("button").first()).toHaveText(await create.innerText());
			await expect(footer.getByRole("button").last()).toHaveText(await undo.innerText());
			const primaryBox = await create.boundingBox();
			const secondaryBox = await undo.boundingBox();
			if (!primaryBox || !secondaryBox) throw new Error("Expected both review actions");
			expect(primaryBox.height).toBe(secondaryBox.height);
			if (width === 1440) {
				expect(primaryBox.y).toBe(secondaryBox.y);
				expect(ar ? primaryBox.x > secondaryBox.x : primaryBox.x < secondaryBox.x).toBe(true);
			} else {
				expect(primaryBox.y).toBeLessThan(secondaryBox.y);
				expect(primaryBox.x).toBe(secondaryBox.x);
				expect(primaryBox.width).toBe(secondaryBox.width);
			}
			await order.scrollIntoViewIfNeeded();
			await undo.scrollIntoViewIfNeeded();
			await shot("reorder-and-footer");
			await order.getByRole("button", { name: ar ? "قبول" : "Accept", exact: true }).click();
			await expect(order.getByRole("button", { name: ar ? "قبول" : "Accept", exact: true })).toHaveCount(0);
			await expect(
				page.getByRole("button", {
					name: ar ? "اقتراح تعديلات لهذه الوظيفة" : "Suggest edits for this job",
					exact: true,
				}),
			).toHaveCount(0);
			await expect(page.locator("html")).toHaveAttribute("dir", ar ? "rtl" : "ltr");
			expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
			await create.scrollIntoViewIfNeeded();
			await page.evaluate(() => document.fonts.ready.then(() => undefined));
			expect(
				await page.evaluate(
					(family) => document.fonts.check(`14px "${family}"`),
					ar ? "Noto Sans Arabic" : "Noto Sans",
				),
			).toBe(true);
			expect((await api.resume.getById({ id: sourceId })).data).toEqual(original.data);
			expect(await api.resume.variants.list({ resumeId: sourceId })).toHaveLength(1);
			await create.click();
			const open = page.getByRole("link", { name: ar ? "فتح النسخة المخصصة" : "Open tailored CV", exact: true });
			await expect(open).toHaveAttribute("data-variant", "primary");
			await expect(
				page.getByText(ar ? "أنشأنا النسخة المخصصة" : "Tailored copy created", { exact: true }),
			).toBeVisible();
			await expect(
				page
					.getByRole("region", { name: ar ? "النسخ المخصصة لهذه الوظيفة" : "Tailored copies for this job" })
					.getByRole("link"),
			).toHaveCount(1);
			await expect(primary).toHaveCount(1);
			await open.evaluate((link) => link.scrollIntoView({ block: "center" }));
			await shot("saved");
			if (process.env.IMPECCABLE_BIN && locale === "en-US" && width === 1440) {
				await captureJobPageDetector(
					page,
					process.env.IMPECCABLE_BIN,
					process.env.E2E_PUBLIC_EVIDENCE_DIR
						? join(process.env.E2E_PUBLIC_EVIDENCE_DIR, "impeccable.json")
						: info.outputPath("impeccable.json"),
				);
			}
			await page.reload();
			await expect(open).toHaveAttribute("data-variant", "primary");
			await open.click();
			await expect(page).toHaveURL(/\/builder\/[^/]+$/u);
			const copyId = new URL(page.url()).pathname.split("/").at(-1);
			if (!copyId) throw new Error("Missing tailored copy ID");
			const wording = "Developed TypeScript services. Did not manage a budget.";
			const preview = page.locator('[data-slot="preview-scroll-area"]');
			await expect(preview).toContainText(wording);
			await page.reload();
			await expect(preview).toContainText(wording);
			expect((await api.resume.getById({ id: copyId })).data.summary.content).toBe(`<p>${wording}</p>`);
			expect((await api.resume.getById({ id: copyId })).data.sections.projects.items.map(({ name }) => name)).toEqual(
				[...projectNames].reverse(),
			);
			expect((await api.resume.getById({ id: sourceId })).data).toEqual(original.data);
		});
	}
}
