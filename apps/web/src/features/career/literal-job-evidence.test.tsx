// @vitest-environment happy-dom
import type { JobTermReport } from "@reactive-resume/schema/job-evidence";
import { cleanup, render, screen, within } from "@testing-library/react";
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
	"groups repeated phrases with counts, linked context and collapsed exclusions in %s",
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
			denominator: 1,
			matchedCount: 1,
			unmatchedCount: 0,
			selection: { limit: 35, truncated: true },
			exclusions: [],
			excludedTerms: ["client", "planning", "client"],
			terms: [
				{
					term: "AI",
					matched: true,
					surfaceForms: ["AI"],
					jobSpans: [{ id: "job-ai", start: 0, end: 2, quote: "AI" }],
					cvSpans,
				},
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
		expect(screen.getByText(locale === "ar-SA" ? "موجود في السيرة: 1" : "Found in CV: 1")).toBeTruthy();
		expect(screen.getByText(locale === "ar-SA" ? "غير موجود في السيرة: 0" : "Not found in CV: 0")).toBeTruthy();
		const summary = await screen.findByText(/AI ·/u);
		expect(summary.textContent).toContain("12");
		const details = summary.closest("details");
		if (!details) throw new Error("Missing phrase details");
		const examples = within(details).getAllByRole("link", { hidden: true });
		expect(examples).toHaveLength(2);
		for (const example of examples) {
			expect(example.textContent).toContain("Built AI tools");
			expect(example.textContent?.length).toBeLessThan(180);
			expect(example.getAttribute("href")).toContain("/builder/cv");
			expect(example.getAttribute("href")).toContain("source=");
		}
		const excluded = screen.getByText("client").closest("details");
		expect(excluded).not.toHaveAttribute("open");
		expect(screen.getAllByText("client")).toHaveLength(1);
		expect(excluded?.querySelector("summary")?.textContent).toMatch(locale === "ar-SA" ? /عرض/u : /Show/u);
	},
);
