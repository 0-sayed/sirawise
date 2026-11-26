import { captureReviewDirection } from "../fixtures/reviewable-ai";
import { settleScreen } from "../fixtures/screen";
import { expect, test } from "../fixtures/test";
import { seedVariantReview, variantClient } from "../fixtures/variants";

for (const locale of ["ar-SA", "en-US"] as const) {
	for (const width of [1440, 390]) {
		test(`literal coverage groups repeated phrases in ${locale} at ${width}`, async ({ authPage: page }, info) => {
			await page.setViewportSize({ width, height: 900 });
			const id = await seedVariantReview(page, info);
			const api = variantClient(page);
			const cv = await api.resume.getById({ id });
			const data = structuredClone(cv.data);
			data.summary.content = `<p>${Array.from({ length: 12 }, (_, index) => `Built TypeScript tools for team ${index}.`).join(" ")} Built data pipelines with Python and PostgreSQL. درّبت نماذج التعلم الآلي.</p>`;
			await expect(
				await page.request.put(`/api/openapi/resumes/${id}`, {
					data: { data, expectedUpdatedAt: cv.updatedAt.toISOString() },
				}),
			).toBeOK();
			await expect(
				await page.request.post("/api/auth/update-user", {
					data: { uiLocale: locale },
					headers: { origin: String(info.project.use.baseURL) },
				}),
			).toBeOK();
			await page.goto(`/dashboard/resumes/${id}/job`);
			await page.getByLabel(/^(Job title|المسمى الوظيفي)$/u).fill("Engineer");
			await page
				.getByLabel(/^(Job ad|إعلان الوظيفة)$/u)
				.fill(
					"You’ll use TypeScript. TypeScript TypeScript required. Data pipelines, Python, PostgreSQL, artificial intelligence, التعلم الآلي, design, research. Kotlin, Swift, Docker, Kubernetes, Terraform, Ansible, Jenkins, Git, Linux, MySQL, MongoDB, Redis, Kafka, Spark, Hadoop, Elasticsearch, GraphQL, REST, SOAP, React, Angular, Vue, Svelte, Node, Express, Hono, Ruby, Rails, PHP, Laravel, Scala, Clojure, Haskell, Erlang, Elixir, Rust, Golang, Perl, Bash, PowerShell, Azure, AWS, GCP, Snowflake, Databricks, Tableau, PowerBI, Excel.",
				);
			await page.getByRole("button", { name: /^(Compare with job|مقارنة بالوظيفة)$/u }).click();
			const ar = locale === "ar-SA";
			const panel = page.getByRole("region", { name: ar ? "الكلمات المهمة في الإعلان" : "Key terms from the job ad" });
			const found = panel.getByRole("region", {
				name: ar ? /^مذكورة في سيرتك \(\d+\)$/u : /^Already in your CV \(\d+\)$/u,
			});
			const missing = panel.getByRole("region", {
				name: ar ? /^غير مكتوبة في سيرتك \(\d+\)$/u : /^Not in your CV yet \(\d+\)$/u,
			});
			const term = found.getByRole("button", { name: /typescript.*12/iu });
			await expect(term).toBeVisible();
			await expect(found.getByText("data pipelines", { exact: true })).toHaveAttribute("dir", "auto");
			await expect(found.getByText("data pipelines", { exact: true })).toHaveCSS("direction", "ltr");
			await expect(panel).toHaveCSS("direction", ar ? "rtl" : "ltr");
			await expect(panel).not.toContainText(/you'll|you’ll/u);
			expect(await panel.evaluate((element) => element.scrollWidth)).toBeLessThanOrEqual(
				await panel.evaluate((element) => element.clientWidth),
			);
			await panel.evaluate((element) => element.scrollIntoView({ block: "center" }));
			await settleScreen(page);
			await captureReviewDirection(page, info, "phrase-coverage");
			await expect(missing.getByRole("listitem")).toHaveCount(6);
			await missing.getByRole("button", { name: ar ? "عرض الكل" : "Show all" }).click();
			await expect(missing.getByText("artificial intelligence", { exact: true })).toBeVisible();
			await missing.getByRole("button", { name: ar ? "عرض أقل" : "Show fewer" }).click();
			await expect(missing.getByRole("listitem")).toHaveCount(6);
			await term.click();
			const links = page.getByRole("dialog").getByRole("link");
			await expect(links).toHaveCount(2);
			for (const link of await links.all()) await expect(link).toContainText("Built TypeScript tools");
			await settleScreen(page);
			await page.screenshot({ path: info.outputPath("phrase-context.png") });
			await page.keyboard.press("Escape");
			const excluded = panel.getByRole("button", { name: /Show additional phrases|عرض العبارات الإضافية/u });
			await expect(excluded).toHaveCount(0);
			await expect(panel).toContainText(
				ar ? "نعرض أهم الكلمات المتكررة في الإعلان." : "Showing the highest-signal terms from the job ad.",
			);
			await expect(panel.getByRole("list")).toHaveCount(2);
			await settleScreen(page);
			await page.screenshot({ path: info.outputPath("literal-coverage.png"), fullPage: true });
			await term.click();
			await links.first().click();
			await expect(page).toHaveURL(/builder\/.*source=/u);
			await expect(page.locator("#sidebar-summary")).toBeVisible();
		});
	}
}
