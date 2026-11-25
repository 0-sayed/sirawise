import type { Locator, Page, TestInfo } from "@playwright/test";
import { resolve } from "node:path";
import { expect } from "@playwright/test";
import { Pool } from "pg";
import { createSampleResumeFromDashboard } from "./resume";

export async function selectCompactTranslation(page: Page) {
	await page.context().setExtraHTTPHeaders({ "x-synthetic-translation-contract": "compact" });
}

export async function simulateVerifierBackup(page: Page) {
	await page.context().setExtraHTTPHeaders({ "x-synthetic-verifier": "backup-recovery" });
	await seedReviewBudget("synthetic-backup");
}

export async function readVerifierDispatches(operationId: string) {
	const pool = new Pool({ connectionString: process.env.DATABASE_MIGRATION_URL ?? process.env.DATABASE_URL });
	try {
		const { rows } = await pool.query<{ endpoint: string; outcome: string }>(
			`SELECT call->>'endpointSlot' AS endpoint, call->>'outcome' AS outcome
			 FROM ai_operation_attempt, jsonb_array_elements(output->'_verifyCalls') WITH ORDINALITY AS entry(call, position)
			 WHERE operation_id=$1 AND step_id='verify' ORDER BY ordinal, position`,
			[operationId],
		);
		return rows;
	} finally {
		await pool.end();
	}
}

export async function expectReviewTextDirection(passage: Locator, direction: "ltr" | "rtl") {
	await expect(passage).toHaveAttribute("dir", "auto");
	await expect(passage).toHaveCSS("direction", direction);
	await expect(passage).toHaveCSS("text-align", "start");
}

export async function captureReviewDirection(page: Page, info: TestInfo, name: string) {
	const evidence = process.env.E2E_PUBLIC_EVIDENCE_DIR;
	const filename = `${name}-${await page.locator("html").getAttribute("lang")}-${page.viewportSize()?.width}.png`;
	await page.screenshot({ path: evidence ? resolve(evidence, filename) : info.outputPath(filename) });
}

export async function seedReview(
	page: Page,
	testInfo: TestInfo,
	locale: "en-US" | "ar-SA" = "en-US",
	documentLocale: "en-US" | "ar-SA" = "en-US",
) {
	await page.request.post("/api/auth/update-user", {
		data: { uiLocale: locale },
		headers: { origin: String(testInfo.project.use.baseURL) },
	});
	await createSampleResumeFromDashboard(page, testInfo);
	const resumeId = new URL(page.url()).pathname.split("/").at(-1);
	if (!resumeId) throw new Error("Expected resume URL");
	const current = await (await page.request.get(`/api/openapi/resumes/${resumeId}`)).json();
	current.data.summary.content = documentLocale === "ar-SA" ? "<p>بنيت خدمات.</p>" : "<p>Built services.</p>";
	current.data.metadata.page.locale = documentLocale;
	const saved = await page.request.put(`/api/openapi/resumes/${resumeId}`, {
		data: { data: current.data, expectedUpdatedAt: current.updatedAt },
	});
	expect(saved.ok()).toBe(true);
	await seedReviewBudget();
	await page.reload();
	return resumeId;
}
export async function seedReviewBudget(route = "synthetic") {
	const pool = new Pool({ connectionString: process.env.DATABASE_MIGRATION_URL ?? process.env.DATABASE_URL });
	try {
		// Allow a six-part translation alongside the other browser workers.
		await pool.query(
			"INSERT INTO ai_platform_budget(id,route_id,route_revision,window_date,cap_micros,request_cap_micros,concurrency) VALUES ($1,$2,'1',(now() AT TIME ZONE 'UTC')::date,100000,10000,10) ON CONFLICT DO NOTHING",
			[route === "synthetic" ? "t006-browser" : `reviewable-browser-${route}`, route],
		);
	} finally {
		await pool.end();
	}
}
export type ReviewTab = "ats" | "writing" | "ai";
export async function openReview(page: Page, width = 1440, tab: ReviewTab = "ats") {
	if (width >= 640) await page.getByRole("tab", { name: /^(Review|مراجعة)$/u }).click();
	else
		await page
			.getByRole("navigation", { name: /Editor views|طرق عرض المحرر/u })
			.getByRole("button", { name: /^(Review|مراجعة)$/u })
			.click();
	const expand = page.getByRole("button", { name: /^(Open full review|فتح المراجعة الكاملة)$/u });
	if (await expand.isVisible()) await expand.click();
	const reviewTab = page.locator(`[role="tab"][data-review-tab="${tab}"]`);
	if ((await reviewTab.getAttribute("aria-selected")) !== "true") await reviewTab.click();
	await expect(page.getByRole("region", { name: /^(Review findings|ملاحظات المراجعة)$/u })).toBeVisible();
}
export async function openWriting(page: Page, width = 1440) {
	await openReview(page, width, "ai");
}
export async function startReview(page: Page) {
	await page.getByRole("button", { name: /^(Review wording|مراجعة الصياغة)$/u }).click();
	await page
		.getByRole("dialog")
		.getByRole("button", { name: /^(Start review|بدء المراجعة)$/u })
		.click();
	await expect(page.getByTestId("durable-review")).toBeVisible({ timeout: 25_000 });
}
