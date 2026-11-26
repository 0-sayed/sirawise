import { Pool } from "pg";
import { openWriting, seedReview } from "../fixtures/reviewable-ai";
import { expect, test } from "../fixtures/test";
import { variantClient } from "../fixtures/variants";

for (const locale of ["en-US", "ar-SA"] as const) {
	for (const width of [1440, 390]) {
		test(`AI queue waits and cancels without a charge in ${locale} at ${width}px`, async ({ authPage: page }, info) => {
			const ar = locale === "ar-SA";
			await page.setViewportSize({ width, height: 900 });
			const resumeId = await seedReview(page, info, locale);
			const api = variantClient(page);
			const pool = new Pool({ connectionString: process.env.DATABASE_MIGRATION_URL });
			const blocker = `synthetic-queue-blocker-${resumeId}`;
			try {
				await pool.query("UPDATE ai_platform_capacity SET max_running=1 WHERE singleton");
				await pool.query(
					`
					INSERT INTO ai_operation(id,user_id,request_key,fingerprint,kind,sources,route,consent_version,
						prompt_version,schema_version,state,lease_until)
					SELECT $1,user_id,$1,$1,'review','[]','{}','1','1','1','running',now()+interval '10 minutes'
					FROM resume WHERE id=$2
				`,
					[blocker, resumeId],
				);
				await openWriting(page, width);
				await page.getByRole("button", { name: ar ? "مراجعة الصياغة" : "Review wording", exact: true }).click();
				await page
					.getByRole("dialog")
					.getByRole("button", { name: ar ? "بدء المراجعة" : "Start review" })
					.click();
				const waiting = page.getByRole("status").filter({
					hasText: ar ? "طلبك في قائمة الانتظار. سيبدأ قريبًا." : "Your request is waiting. It will start shortly.",
				});
				await expect(waiting).toBeVisible();
				await expect(waiting).toHaveText(new RegExp(ar ? "الترتيب في قائمة الانتظار: 1" : "Position in queue: 1"));
				await expect(page.locator("html")).toHaveAttribute("dir", ar ? "rtl" : "ltr");
				expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
				const id = await api.ai.review.latest({ resumeId });
				if (!id) throw new Error("Missing queued operation");
				expect(await api.ai.operations.get({ id })).toMatchObject({ state: "queued", queuePosition: 1 });
				await page.screenshot({ path: info.outputPath("waiting.png") });
				await page
					.locator('[data-slot="review-progress"]')
					.filter({ has: waiting })
					.getByRole("button", { name: ar ? "إلغاء" : "Cancel", exact: true })
					.click();
				await expect.poll(async () => (await api.ai.operations.get({ id })).state).toBe("cancelled");
				expect((await api.ai.usage.get()).operations).toMatchObject({ used: 0, reserved: 0 });
			} finally {
				await pool.query("UPDATE ai_operation SET state='failed' WHERE id=$1", [blocker]);
				await pool.query("UPDATE ai_platform_capacity SET max_running=30 WHERE singleton");
				await pool.end();
			}
		});
	}
}
