import { readVerifierDispatches, simulateVerifierBackup } from "../fixtures/reviewable-ai";
import { expect, test } from "../fixtures/test";
import {
	seedVariantReview,
	variantClient,
	startVariantReview,
	seedTailoringReview,
	launchTailoringReview,
} from "../fixtures/variants";

for (const locale of ["ar-SA", "en-US"] as const) {
	for (const width of [390, 1440]) {
		test(`job evidence shows beta and explains withheld findings in ${locale} at ${width}`, async ({
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
			await page.getByLabel(ar ? "المسمى الوظيفي" : "Job title", { exact: true }).fill("Engineer");
			await page
				.getByLabel(ar ? "إعلان الوظيفة" : "Job ad", { exact: true })
				.fill("Synthetic backup recovery: SAP.\nSynthetic ability claim: Rust.");
			await page.getByRole("button", { name: ar ? "مقارنة" : "Compare", exact: true }).click();
			await expect(beta).toHaveCount(1);
			await page.getByRole("button", { name: ar ? "مراجعة أدلة الوظيفة" : "Review job evidence", exact: true }).click();
			await page
				.getByRole("dialog")
				.getByRole("button", { name: ar ? "بدء المراجعة" : "Start review", exact: true })
				.click();
			await expect(beta).toHaveCount(2, { timeout: 30000 });
			const withheld = page.getByRole("listitem").filter({ hasText: "Synthetic ability claim: Rust." });
			await expect(withheld).toContainText(
				ar ? "لم تدعم الأدلة التي تمت مراجعتها هذه النتيجة." : "The checked evidence did not support this finding.",
			);
			await expect(withheld.getByText("The candidate cannot use Rust.", { exact: true })).toBeVisible();
			await expect(page.getByText("The candidate cannot use Rust.", { exact: true })).toHaveCount(1);
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
	await page.getByRole("button", { name: "Compare", exact: true }).click();
	await page.getByRole("button", { name: "Review job evidence", exact: true }).click();
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
	await expect(withheld.getByText("The candidate cannot use Rust.", { exact: true })).toBeVisible();
	await expect(page.getByText("The candidate cannot use Rust.", { exact: true })).toHaveCount(1);
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
	await page.getByRole("button", { name: "Compare", exact: true }).click();
	await expect(page.getByText("Literal text coverage", { exact: true })).toBeVisible();
	await page.reload();
	const report = await api.career.jobTargets.evidence({ resumeId });
	if (!report.selection) throw new Error("Expected saved selection");
	expect(report.job?.text).toBe(text);
	expect(report.semantic.state).not.toBe("complete");
	expect((await api.resume.getById({ id: resumeId })).updatedAt).toEqual(original.updatedAt);
	await page.getByRole("button", { name: "Review job evidence", exact: true }).click();
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
	const term = page
		.locator("details")
		.filter({ has: page.locator("summary", { hasText: /typescript.*Found in CV/i }) })
		.first();
	await term.locator("summary").click();
	await term.getByRole("link", { name: "Show in CV" }).first().click();
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
	const summary = proposals.filter({ hasText: "Did not manage a budget." });
	const dashboard = proposals.filter({ hasText: "Built TypeScript dashboards." });
	const pipeline = proposals.filter({ hasText: "Built TypeScript pipelines." });
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
	await expect(dashboard.getByText("Applied", { exact: true })).toBeVisible();
	await pipeline.getByRole("button", { name: "Reject", exact: true }).click();
	await expect(pipeline.getByText("Rejected", { exact: true })).toBeVisible();
	await page.reload();
	await expect(dashboard.getByText("Applied", { exact: true })).toBeVisible();
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

test("a tailored copy created from the job page opens with the accepted wording after reload", async ({
	authPage: page,
}, info) => {
	const sourceId = await seedVariantReview(page, info);
	const api = variantClient(page);
	await page.goto(`/dashboard/resumes/${sourceId}/job`);
	await page.getByLabel("Job title", { exact: true }).fill("Engineer");
	await page.getByLabel("Job ad", { exact: true }).fill("TypeScript services required.");
	await page.getByRole("button", { name: "Compare", exact: true }).click();
	const original = await api.resume.getById({ id: sourceId });
	await page.getByRole("button", { name: "Create tailored copy", exact: true }).click();
	await expect(page).not.toHaveURL(new RegExp(`/resumes/${sourceId}/job$`, "u"));
	const copyId = new URL(page.url()).pathname.split("/").at(-2);
	if (!copyId) throw new Error("Missing tailored copy ID");
	await launchTailoringReview(page, copyId);
	const proposal = page.locator("[data-proposal-index]").filter({ hasText: "Did not manage a budget." });
	await proposal.getByRole("button", { name: "Accept", exact: true }).click();
	await expect(proposal.getByText("Applied", { exact: true })).toBeVisible();
	await page.reload();
	await expect(proposal.getByText("Applied", { exact: true })).toBeVisible();
	await page.goto(`/builder/${copyId}`);
	await expect(page.locator('[data-slot="preview-scroll-area"]')).toContainText(
		"Developed TypeScript services. Did not manage a budget.",
	);
	expect((await api.resume.getById({ id: copyId })).data.summary.content).toBe(
		"<p>Developed TypeScript services. Did not manage a budget.</p>",
	);
	expect((await api.resume.getById({ id: sourceId })).data).toEqual(original.data);
});
