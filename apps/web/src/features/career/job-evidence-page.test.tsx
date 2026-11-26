// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vite-plus/test";
import { i18n } from "@lingui/core";
import { I18nProvider } from "@lingui/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { analyzeJobTerms, JOB_NORMALIZATION_VERSION, JOB_RUBRIC_VERSION } from "@reactive-resume/resume/ats";
import { jobEvidenceViewSchema } from "@reactive-resume/schema/job-evidence";
import { defaultResumeData } from "@reactive-resume/schema/resume/default";
import { JobEvidencePage } from "./job-evidence-page";
const mocks = vi.hoisted(() => ({
	family: [] as { resumeId: string; variantKind: string; operationId: string | null }[],
	cv: undefined as { data: unknown; updatedAt: Date; isLocked: boolean } | undefined,
	review: undefined as unknown,
	create: vi.fn(),
}));
vi.mock("@tanstack/react-query", async (importOriginal) => {
	const actual = await importOriginal<typeof import("@tanstack/react-query")>();
	return {
		...actual,
		useQuery: ({ queryKey }: { queryKey: string[] }) => ({
			data: queryKey[0] === "family" ? mocks.family : queryKey[0] === "cv" ? mocks.cv : mocks.review,
			refetch: vi.fn(),
		}),
	};
});
vi.mock("@tanstack/react-router", () => ({
	useNavigate: () => vi.fn(),
	Link: ({
		params,
		children,
		to,
		...props
	}: {
		params?: { resumeId?: string };
		children: React.ReactNode;
		to: string;
	}) => (
		<a href={to.replace("$resumeId", params?.resumeId ?? "")} {...props}>
			{children}
		</a>
	),
}));
vi.mock("@/libs/orpc/client", () => ({
	client: { resume: { variants: { create: mocks.create } } },
	orpc: {
		resume: {
			variants: { list: { queryOptions: () => ({ queryKey: ["family"] }) } },
			getById: { queryOptions: () => ({ queryKey: ["cv"] }) },
		},
		ai: { variantReview: { get: { queryOptions: () => ({ queryKey: ["review"] }) } } },
	},
}));
vi.mock("@/features/resume/editor/proposals/review-operation", () => ({
	ReviewLaunch: ({
		children,
		variant = "primary",
		hideTrigger,
	}: {
		children: React.ReactNode;
		variant?: string;
		hideTrigger?: boolean;
	}) =>
		hideTrigger ? null : (
			<button type="button" data-variant={variant}>
				{children}
			</button>
		),
	ReviewNotice: () => null,
	ReviewOperationPanel: ({ children }: { children: React.ReactNode }) => children,
}));

afterEach(() => {
	cleanup();
	mocks.family = [];
	mocks.cv = undefined;
	mocks.review = undefined;
});
const identity = {
	resumeId: "cv",
	resumeRevision: "v1",
	contentHash: "hash",
	jobId: "job",
	jobRevision: "1",
	rubricVersion: JOB_RUBRIC_VERSION,
	normalizationVersion: JOB_NORMALIZATION_VERSION,
};
const literal = analyzeJobTerms({
	identity,
	jobText: "React SAP",
	passages: [{ id: "summary", target: { sectionId: "summary", field: "content" }, text: "React" }],
});
const revision = "2026-11-25T00:00:00.000Z";
function show(complete: boolean, selected = false) {
	i18n.loadAndActivate({ locale: "en-US", messages: {} });
	const data = jobEvidenceViewSchema.parse({
		selection: selected ? { resumeId: "cv", jobId: "job", jobRevision: "1", revision } : null,
		job: selected
			? {
					userId: "owner",
					digest: "hash",
					jobId: "job",
					revision: "1",
					role: "Engineer",
					employer: "",
					text: "React SAP",
					createdAt: revision,
				}
			: null,
		literal,
		semantic: complete
			? {
					state: "complete",
					operationId: "review",
					identity,
					findings: {
						requirements: ["supported", "partial", "no_evidence", "unclear"].map((verdict, index) => ({
							id: String(index),
							spanIds: [],
							importance: "unstated",
							verdict,
							evidenceIds: [],
							explanation: "Verified requirement " + index,
						})),
						notes: [],
					},
				}
			: { state: "not-checked" },
	});
	if (complete && data.semantic.state === "complete") {
		mocks.review = {
			result: { kind: "review.job-evidence", output: data.semantic.findings, sourceRevision: { id: "cv" } },
			statuses: { report: "accepted" },
			segments: {},
			sourceSegments: [],
			answeredQuestionIds: [],
			dismissedQuestionIds: [],
			undoable: [],
		};
	}
	const cache = new QueryClient();
	const view = () => (
		<QueryClientProvider client={cache}>
			<I18nProvider i18n={i18n}>
				<JobEvidencePage resumeId="cv" data={data} onRefresh={vi.fn()} />
			</I18nProvider>
		</QueryClientProvider>
	);
	const rendered = render(view());
	return () => rendered.rerender(view());
}
it("keeps literal occurrence available while semantic processing is unavailable", () => {
	show(false);
	expect(screen.getByText("Beta")).toBeDefined();
	const literalPanel = screen.getByRole("region", { name: "Key terms from the job ad" });
	expect(within(literalPanel).getByRole("region", { name: "Already in your CV (1)" })).toHaveTextContent("react");
	expect(within(literalPanel).getByRole("region", { name: "Not in your CV yet (1)" })).toHaveTextContent("sap");
	expect(
		within(literalPanel).getByText(
			"Terms from the job ad — missing words aren't written in your CV yet, not proof you lack the skill.",
		),
	).toBeVisible();
	expect(screen.getByRole("button", { name: /Detailed requirement check/ })).toHaveAttribute("aria-expanded", "false");
	expect(screen.queryByText("Evidence found")).toBeNull();
});
it("shows all verified verdicts separately without altering the literal denominator", () => {
	show(true);
	for (const text of ["Evidence found", "Partial evidence", "No evidence found", "Unclear"])
		expect(screen.getByText(text)).toBeDefined();
	const literalPanel = screen.getByRole("region", { name: "Key terms from the job ad" });
	expect(within(literalPanel).getByRole("region", { name: "Already in your CV (1)" })).toBeVisible();
	expect(within(literalPanel).getByRole("region", { name: "Not in your CV yet (1)" })).toBeVisible();
	expect(screen.getAllByRole("button", { name: "Add a fact" })).toHaveLength(3);
});

it("promotes creation only after an acknowledged acceptance and opens the saved copy after creation", async () => {
	mocks.family = [{ resumeId: "cv", variantKind: "base", operationId: "tailoring" }];
	mocks.cv = { data: defaultResumeData, updatedAt: new Date(revision), isLocked: false };
	mocks.review = {
		result: { kind: "review.tailoring", output: { patches: [], order: [] } },
		segments: {},
		sourceSegments: [],
		undoable: [],
		statuses: { summary: "pending" },
		latestDecisionId: null,
		stale: false,
	};
	mocks.create.mockResolvedValue({ resumeId: "tailored" });
	const rerender = show(false, true);
	const create = screen.getByRole("button", { name: "Save tailored copy" });
	expect(screen.queryByRole("button", { name: "Suggest edits for this job" })).toBeNull();
	expect(create).toBeDisabled();
	mocks.review = { ...(mocks.review as object), statuses: { summary: "accepted" }, latestDecisionId: "accepted" };
	rerender();
	expect(create).toBeEnabled();
	expect(create).toHaveAttribute("data-variant", "primary");
	mocks.review = {
		...(mocks.review as object),
		undoable: [{ subjectIds: ["summary"], decisionId: "accepted" }],
	};
	rerender();
	const undo = screen.getByRole("button", { name: "Undo last action" });
	const actions = create.closest('[data-slot="action-group"]');
	expect(actions).not.toBeNull();
	expect(undo.closest('[data-slot="action-group"]')).toBe(actions);
	expect(within(actions as HTMLElement).getAllByRole("button")).toEqual([create, undo]);
	fireEvent.click(create);
	await waitFor(() =>
		expect(mocks.create).toHaveBeenCalledWith(
			expect.objectContaining({
				sourceResumeId: "cv",
				review: { operationId: "tailoring", decisionId: "accepted" },
			}),
		),
	);
	const open = await screen.findByRole("link", { name: "Open tailored CV" });
	expect(open).toHaveAttribute("href", "/builder/tailored");
	expect(open).toHaveAttribute("data-variant", "primary");
	expect(screen.queryByRole("button", { name: "Save tailored copy" })).toBeNull();
});
