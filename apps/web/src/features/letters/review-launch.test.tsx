// @vitest-environment happy-dom
import type { CoverLetter } from "@reactive-resume/schema/cover-letter/data";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import { i18n } from "@lingui/core";
import { I18nProvider } from "@lingui/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { copyCoverLetterStyle } from "@reactive-resume/resume/cover-letter";
import { operationRequestSchema } from "@reactive-resume/schema/ai-operation";
import { letterGenerationInputSchema } from "@reactive-resume/schema/cover-letter/review";
import { defaultResumeData } from "@reactive-resume/schema/resume/default";

const state = vi.hoisted(() => ({
	selection: null as null | { jobId: string; jobRevision: string; revision: string },
	prepare: vi.fn(),
	start: vi.fn(),
	save: vi.fn(),
	description: "Operations consulting experience required.",
}));
const revision = "2026-11-21T12:00:00.000Z";
vi.mock("@tanstack/react-router", () => ({
	useNavigate: () => vi.fn(),
	Link: ({ children, to }: { children: React.ReactNode; to: string }) => <a href={to}>{children}</a>,
}));
vi.mock("@/libs/orpc/client", () => ({
	client: {
		resume: {
			getById: async () => ({
				id: "language-copy",
				name: "Sayed Ashraf translation",
				variantKind: "language",
				updatedAt: new Date("2026-11-21T12:00:00.000Z"),
			}),
		},
		applications: {
			getById: async () => ({
				id: "saved-job",
				role: "استشاري العمليات",
				company: "مؤسسة رواد المسار",
				jobDescription: state.description,
			}),
		},
		career: {
			jobTargets: {
				evidence: async () => ({
					selection: state.selection,
					job: state.selection
						? { role: "Operations consultant", employer: "Employer", text: state.description }
						: null,
				}),
				saveAndSelect: async (input: unknown) => {
					state.save(input);
					state.selection = { jobId: "job-target", jobRevision: "1", revision: "2026-11-21T12:00:00.000Z" };
					return state.selection;
				},
			},
		},
		coverLetters: {
			latestReview: async () => null,
			prepareReview: async (input: unknown) => {
				const parameters = letterGenerationInputSchema.parse(input);
				state.prepare(parameters);
				return {
					parameters,
					sources: [
						{ kind: "resume", id: parameters.resumeId, revision: parameters.expectedUpdatedAt },
						{ kind: "job", id: parameters.jobId, revision: parameters.jobRevision },
						{ kind: "cover-letter", id: parameters.letterId, revision: String(parameters.expectedLetterRevision) },
					],
				};
			},
		},
		ai: {
			processing: {
				notices: async ({ locale }: { locale: string }) => [
					{
						purpose: "review.cover-letter",
						locale,
						content: "Synthetic processing notice",
						alreadyGranted: false,
						noticeSha256: "a".repeat(64),
						route: { routeId: "synthetic", routeRevision: "1", configRevision: "1" },
						noticeVersion: "1",
					},
				],
				grant: async () => {},
			},
			operations: {
				preflight: async () => ({ available: true }),
				start: async (input: unknown) => {
					state.start(operationRequestSchema.parse(input));
					return { id: "started" };
				},
			},
		},
	},
	orpc: {
		ai: {
			availability: { queryOptions: () => ({ queryKey: ["availability"], queryFn: async () => ({ state: "ready" }) }) },
			usage: {
				get: {
					queryOptions: () => ({
						queryKey: ["usage"],
						queryFn: async () => ({ operations: { remaining: 5, reserved: 0 } }),
					}),
				},
			},
			operations: {
				get: {
					queryOptions: () => ({ queryKey: ["operation"], queryFn: async () => ({ state: "queued", resultId: null }) }),
				},
			},
		},
	},
}));
import { LetterReviewComposer } from "./review";
import { useLetterEditorStore } from "./store";

let cache: QueryClient;
let letter: CoverLetter;
beforeEach(() => {
	vi.clearAllMocks();
	state.selection = null;
	state.description = "Operations consulting experience required.";
	i18n.loadAndActivate({ locale: "en-US", messages: {} });
	letter = {
		id: "letter",
		name: "Letter",
		sourceResumeId: "language-copy",
		sourceApplicationId: "saved-job",
		recipient: "",
		content: "Manual text",
		greeting: null,
		signOff: null,
		layout: "structured",
		recipientName: "",
		recipientCompany: "",
		letterDate: null,
		senderLinked: true,
		designLinked: true,
		isLocked: false,
		revision: 1,
		style: copyCoverLetterStyle(defaultResumeData),
		createdAt: new Date(revision),
		updatedAt: new Date(revision),
	};
	letter.style.metadata.page.locale = "en-US";
	useLetterEditorStore.getState().load(letter, true);
	cache = new QueryClient({ defaultOptions: { queries: { retry: false } } });
});
afterEach(() => {
	cleanup();
	cache.clear();
	useLetterEditorStore.getState().reset();
});
function show() {
	return render(
		<I18nProvider i18n={i18n}>
			<QueryClientProvider client={cache}>
				<LetterReviewComposer letter={letter} disabled={false} />
			</QueryClientProvider>
		</I18nProvider>,
	);
}
it("starts a letter review with a language-copy CV and the letter's linked saved job", async () => {
	show();
	const launch = await screen.findByRole("button", { name: "Review a job-specific letter" });
	await waitFor(() => expect(launch.hasAttribute("disabled")).toBe(false));
	fireEvent.click(launch);
	await screen.findByText("Synthetic processing notice");
	fireEvent.click(screen.getByRole("button", { name: "Start review" }));
	await waitFor(() => expect(state.start).toHaveBeenCalledOnce());
	expect(state.prepare).toHaveBeenCalledWith(
		expect.objectContaining({
			resumeId: "language-copy",
			jobId: "job-target",
			documentLocale: "en-US",
			length: "normal",
		}),
	);
	expect(state.save).toHaveBeenCalledWith(
		expect.objectContaining({
			resumeId: "language-copy",
			role: "استشاري العمليات",
			employer: "مؤسسة رواد المسار",
			text: state.description,
		}),
	);
	expect(useLetterEditorStore.getState().letter?.content).toBe("Manual text");
});
it("disables review until a job is chosen and offers the job selector", async () => {
	letter.sourceApplicationId = null;
	useLetterEditorStore.getState().load(letter, true);
	show();
	const button = await screen.findByRole("button", { name: "Review a job-specific letter" });
	await screen.findByText(/Choose a saved job with a job description/);
	expect(button.hasAttribute("disabled")).toBe(true);
	expect(screen.getByRole("link", { name: "Choose or save a job" }).getAttribute("href")).toBe(
		"/dashboard/resumes/$resumeId/job",
	);
	expect(state.start).not.toHaveBeenCalled();
});
it("requires the linked job description and links to that saved job", async () => {
	state.description = "";
	show();
	await screen.findByText(/The linked job has no job description/);
	expect(screen.getByRole("button", { name: "Review a job-specific letter" }).hasAttribute("disabled")).toBe(true);
	expect(screen.getByRole("link", { name: "Add the job description" })).toBeTruthy();
});
it("uses the CV's selected job when the letter has no linked application", async () => {
	letter.sourceApplicationId = null;
	state.selection = { jobId: "job-target", jobRevision: "1", revision };
	useLetterEditorStore.getState().load(letter, true);
	show();
	const button = await screen.findByRole("button", { name: "Review a job-specific letter" });
	await waitFor(() => expect(button.hasAttribute("disabled")).toBe(false));
	fireEvent.click(button);
	await screen.findByText("Synthetic processing notice");
	fireEvent.click(screen.getByRole("button", { name: "Start review" }));
	await waitFor(() => expect(state.start).toHaveBeenCalledOnce());
	expect(state.save).not.toHaveBeenCalled();
});
