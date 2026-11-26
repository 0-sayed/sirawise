// @vitest-environment happy-dom
import type { JobTermReport } from "@reactive-resume/schema/job-evidence";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, expect, it } from "vite-plus/test";
import { i18n } from "@lingui/core";
import { I18nProvider } from "@lingui/react";
import {
	createMemoryHistory,
	createRootRoute,
	createRoute,
	createRouter,
	RouterProvider,
} from "@tanstack/react-router";
import { LiteralJobEvidence } from "./literal-job-evidence";
import { getUiLocaleMessages } from "@/libs/locale";

afterEach(cleanup);

it.each(["ar-SA", "en-US"] as const)(
	"groups repeated phrases with counts, linked context and a short truncation caption in %s",
	async (locale) => {
		const text = Array.from({ length: 12 }, (_, index) => `Built AI tools for team ${index}.`).join(" ");
		const target = { sectionId: "summary", field: "content" } as const;
		const cvSpans = [...text.matchAll(/AI/gu)].map((match, index) => ({
			id: `match-${index}`,
			passageId: "summary",
			target,
			start: match.index,
			end: match.index + 2,
			quote: "AI",
		}));
		const report: JobTermReport = {
			identity: {
				resumeId: "cv",
				resumeRevision: "r1",
				contentHash: "h1",
				jobId: "job",
				jobRevision: "j1",
				rubricVersion: "literal-v1",
				normalizationVersion: "matching-v2",
			},
			state: "complete",
			denominator: 8,
			matchedCount: 1,
			unmatchedCount: 7,
			selection: { limit: 35, truncated: true },
			exclusions: [],
			excludedTerms: ["client", "planning", "client"],
			terms: [
				{
					term: "artificial-intelligence",
					matched: true,
					surfaceForms: ["AI"],
					jobSpans: [{ id: "job-ai", start: 0, end: 2, quote: "AI" }],
					cvSpans: [...cvSpans, ...cvSpans.slice(0, 1).map((span) => ({ ...span, id: "duplicate" }))],
				},
				...["data-pipelines", "kubernetes", "postgresql", "ci/cd", "node.js", "c++", "cloud-security"].map((term) => ({
					term,
					matched: false,
					surfaceForms: [],
					jobSpans: [],
					cvSpans: [],
				})),
			],
		};
		i18n.loadAndActivate(await getUiLocaleMessages(locale));
		const root = createRootRoute();
		const route = createRoute({
			getParentRoute: () => root,
			path: "/",
			component: () => (
				<LiteralJobEvidence report={report} resumeId="cv" passages={[{ id: "summary", target, text }]} />
			),
		});
		const router = createRouter({
			routeTree: root.addChildren([route]),
			history: createMemoryHistory({ initialEntries: ["/"] }),
		});
		await router.load();
		render(
			<I18nProvider i18n={i18n}>
				<RouterProvider router={router} />
			</I18nProvider>,
		);
		const ar = locale === "ar-SA";
		const found = screen.getByRole("region", { name: ar ? "مذكورة في سيرتك (1)" : "Already in your CV (1)" });
		const missing = screen.getByRole("region", {
			name: ar ? "غير مكتوبة في سيرتك (7)" : "Not in your CV yet (7)",
		});
		const chip = within(found).getByRole("button", { name: /artificial intelligence.*12/u });
		expect(within(chip).getByText("artificial intelligence")).toHaveAttribute("dir", "auto");
		expect(within(chip).getByText("12")).toBeTruthy();
		expect(within(missing).getByText("data pipelines")).toHaveAttribute("dir", "auto");
		expect(within(missing).queryByRole("button", { name: /data pipelines/u })).toBeNull();
		expect(within(missing).getByRole("list").children).toHaveLength(6);
		fireEvent.click(within(missing).getByRole("button", { name: ar ? "عرض الكل" : "Show all" }));
		expect(within(missing).getByRole("list").children).toHaveLength(7);
		expect(within(missing).getByText("cloud security")).toBeTruthy();
		expect(within(missing).getByText("node.js")).toBeTruthy();
		expect(screen.queryByRole("link", { name: /Built AI tools/u })).toBeNull();
		fireEvent.click(chip);
		const examples = await within(screen.getByRole("dialog")).findAllByRole("link");
		expect(examples).toHaveLength(2);
		for (const example of examples) {
			expect(example.textContent).toContain("Built AI tools");
			expect(example.textContent?.length).toBeLessThan(180);
			expect(example.getAttribute("href")).toContain("/builder/cv");
			expect(example.getAttribute("href")).toContain("source=");
		}
		expect(missing.compareDocumentPosition(found) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
		expect(screen.queryByText("client")).toBeNull();
		expect(
			screen.getByText(
				ar ? "نعرض أهم الكلمات المتكررة في الإعلان." : "Showing the highest-signal terms from the job ad.",
			),
		).toBeVisible();
	},
);
