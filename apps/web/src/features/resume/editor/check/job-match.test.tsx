// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vite-plus/test";
import { i18n } from "@lingui/core";
import { I18nProvider } from "@lingui/react";
import {
	analyzeJobTerms,
	buildJobPassages,
	JOB_NORMALIZATION_VERSION,
	JOB_RUBRIC_VERSION,
} from "@reactive-resume/resume/ats";
import { defaultResumeData } from "@reactive-resume/schema/resume/default";
import { useEditorStore } from "../store";
import { JobMatchTab } from "./job-match";

const state = vi.hoisted(() => ({ current: true, report: null as unknown, data: null as unknown }));
vi.mock("@tanstack/react-router", () => ({
	Link: ({ children, "aria-label": label }: { children: React.ReactNode; "aria-label"?: string }) => (
		<a href="/job" aria-label={label}>
			{children}
		</a>
	),
}));
vi.mock("../../builder/draft", () => ({ useResumeData: () => state.data }));
vi.mock("./use-readiness", () => ({
	useReadiness: () => ({ jobReport: state.report, results: { job: { state: state.current ? "complete" : "stale" } } }),
}));
afterEach(() => {
	cleanup();
	useEditorStore.getState().reset();
});
it("keeps matched and unmatched selected-job evidence readable in the editor", async () => {
	i18n.load("en", {});
	i18n.activate("en");
	useEditorStore.getState().setIdentity({ ownerId: "owner", resumeId: "cv", baseRevision: "v1", editGeneration: 0 });
	state.current = true;
	const data = structuredClone(defaultResumeData);
	data.summary.content = "<p>Built React services</p>";
	data.summary.hidden = false;
	data.metadata.layout.pages = [{ fullWidth: false, main: ["summary"], sidebar: [] }];
	state.data = data;
	state.report = analyzeJobTerms({
		identity: {
			resumeId: "cv",
			resumeRevision: "v1",
			contentHash: "hash",
			jobId: "job",
			jobRevision: "1",
			normalizationVersion: JOB_NORMALIZATION_VERSION,
			rubricVersion: JOB_RUBRIC_VERSION,
		},
		jobText: "React and PostgreSQL",
		passages: buildJobPassages(data),
	});
	const view = render(
		<I18nProvider i18n={i18n}>
			<JobMatchTab />
		</I18nProvider>,
	);
	const found = screen.getByRole("region", { name: "Already in your CV (1)" });
	const missing = screen.getByRole("region", { name: "Not in your CV yet (1)" });
	expect(within(missing).getByText("postgresql")).toBeVisible();
	const react = within(found).getByRole("button", { name: "react Occurrences: 1" });
	expect(react).toBeVisible();
	expect(screen.queryByRole("link", { name: /Show in CV:/ })).not.toBeInTheDocument();
	fireEvent.click(react);
	expect(await screen.findByRole("link", { name: /Show in CV:/ })).toHaveTextContent("Built React services");
	expect(screen.getByRole("link", { name: "Tailor CV for this job" })).toBeVisible();
	state.current = false;
	view.rerender(
		<I18nProvider i18n={i18n}>
			<JobMatchTab />
		</I18nProvider>,
	);
	expect(screen.queryByRole("region", { name: "Key terms from the job ad" })).not.toBeInTheDocument();
});
