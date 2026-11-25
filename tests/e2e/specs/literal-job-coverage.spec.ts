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
			data.summary.content = `<p>${Array.from({ length: 12 }, (_, index) => `Built TypeScript tools for team ${index}.`).join(" ")}</p>`;
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
					"TypeScript TypeScript TypeScript required. Python Java Kotlin Swift Docker Kubernetes Terraform Ansible Jenkins Git Linux Unix PostgreSQL MySQL MongoDB Redis Kafka Spark Hadoop Elasticsearch GraphQL REST SOAP React Angular Vue Svelte Node Express Hono Ruby Rails PHP Laravel Scala Clojure Haskell Erlang Elixir Rust Golang Perl Bash Powershell Azure AWS GCP Snowflake Databricks Tableau PowerBI Excel Scrum Kanban Agile DevOps Security Networking Storage Testing Automation Documentation Architecture Analytics Statistics Mathematics Physics Chemistry Biology.",
				);
			await page.getByRole("button", { name: /^(Compare|قارن|مقارنة)$/u }).click();
			const term = page
				.locator("details")
				.filter({ has: page.locator("summary", { hasText: /typescript.*12/iu }) })
				.first();
			await expect(term).toBeVisible();
			await term.locator("summary").click();
			const links = term.getByRole("link");
			await expect(links).toHaveCount(2);
			for (const link of await links.all()) await expect(link).toContainText("Built TypeScript tools");
			await term.scrollIntoViewIfNeeded();
			await settleScreen(page);
			await page.screenshot({ path: info.outputPath("phrase-context.png"), fullPage: true });
			const excluded = page
				.locator("details")
				.filter({ has: page.locator("summary", { hasText: /Show additional phrases|عرض العبارات الإضافية/u }) });
			await expect(excluded).toBeVisible();
			await expect(excluded).not.toHaveAttribute("open", "");
			await excluded.locator("summary").click();
			expect(await excluded.locator("li").count()).toBeGreaterThan(0);
			await settleScreen(page);
			await page.screenshot({ path: info.outputPath("literal-coverage.png"), fullPage: true });
			await links.first().click();
			await expect(page).toHaveURL(/builder\/.*source=/u);
			await expect(page.locator("#sidebar-summary")).toBeVisible();
		});
	}
}
