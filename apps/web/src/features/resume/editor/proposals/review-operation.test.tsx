// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vite-plus/test";
import { i18n } from "@lingui/core";
import { I18nProvider } from "@lingui/react";
import { ORPCError } from "@orpc/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useState } from "react";
import { operationRequestSchema } from "@reactive-resume/schema/ai-operation";
import { messages as arabicMessages } from "../../../../../locales/ar-SA.po";
const state = vi.hoisted(() => ({
	reserved: 1,
	remaining: 0 as number | null,
	usageReads: 0,
	started: vi.fn(),
	notices: vi.fn(),
	preflight: vi.fn(),
	grant: vi.fn(),
	retryTranslation: vi.fn(),
	availability: "ready",
	operation: null as Record<string, unknown> | null,
}));
vi.mock("@/libs/orpc/client", () => ({
	client: {
		ai: {
			processing: {
				notices: async ({ purpose, locale }: { purpose: string; locale: "ar-SA" | "en-US" }) =>
					state.notices({ purpose, locale }) ?? [syntheticNotice(purpose, locale)],
				grant: async (input: unknown) => state.grant(input),
			},
			operations: {
				cancel: async () => {},
				preflight: async (input: unknown) => {
					operationRequestSchema.parse(input);
					return state.preflight(input) ?? { available: true, operationCost: 1 };
				},
				start: async (input: unknown) => {
					operationRequestSchema.parse(input);
					state.started(input);
					return { id: "started" };
				},
				retryTranslation: async (input: unknown) => state.retryTranslation(input),
			},
		},
	},
	orpc: {
		ai: {
			availability: {
				queryOptions: () => ({ queryKey: ["availability"], queryFn: async () => ({ state: state.availability }) }),
			},
			usage: {
				get: {
					queryOptions: () => ({
						queryKey: ["usage"],
						queryFn: async () => {
							state.usageReads++;
							return { operations: { remaining: state.remaining, reserved: state.reserved } };
						},
					}),
				},
			},
			operations: {
				get: {
					queryOptions: () => ({
						queryKey: ["operation", "op"],
						queryFn: async () => state.operation ?? { state: "running", resultId: null },
					}),
				},
			},
		},
	},
}));
import { launchIssue, ReviewLaunch, ReviewOperationPanel } from "./review-operation";

function syntheticNotice(
	purpose: string,
	locale: "ar-SA" | "en-US",
	alreadyGranted = purpose === "review.translation" && Boolean(state.operation),
) {
	const scopes: Record<string, string> = {
		"review.wording": "selected CV passages",
		"review.extraction": "imported CV text",
		"review.job-evidence": "CV text and the saved job description",
		"review.tailoring": "CV text and the saved job description",
		"review.translation": "source CV text and the target language",
		"review.summary": "CV text and any selected job description",
		"review.cover-letter": "CV text, the saved job description",
	};
	return {
		purpose,
		locale,
		content: `${scopes[purpose]}. Suggestions are optional. Review the results before you apply or use them. OpenRouter processes this request outside Saudi Arabia.`,
		route: { routeId: "synthetic", routeRevision: "1", configRevision: "1" },
		noticeVersion: "1",
		noticeSha256: "a".repeat(64),
		alreadyGranted,
	};
}
async function clickStart(name: string) {
	const button = await screen.findByRole("button", { name });
	await waitFor(() => expect(button).toBeEnabled());
	fireEvent.click(button);
}

it("requires one acceptance, then starts another AI feature without opening the consent dialog", async () => {
	state.remaining = 5;
	state.reserved = 0;
	i18n.loadAndActivate({ locale: "en-US", messages: {} });
	let granted = false;
	state.grant.mockImplementation(() => {
		granted = true;
	});
	state.notices.mockImplementation(({ purpose, locale }) => [syntheticNotice(purpose, locale, granted)]);
	const cache = new QueryClient({ defaultOptions: { queries: { retry: false } } });
	const prepare = async () => ({ sources: [{ kind: "resume" as const, id: "cv", revision: "1" }], parameters: {} });
	const onStarted = vi.fn();
	render(
		<I18nProvider i18n={i18n}>
			<QueryClientProvider client={cache}>
				<ReviewLaunch kind="review.wording" prepare={prepare} onStarted={onStarted}>
					Wording
				</ReviewLaunch>
				<ReviewLaunch kind="review.summary" prepare={prepare} onStarted={onStarted}>
					Summary
				</ReviewLaunch>
			</QueryClientProvider>
		</I18nProvider>,
	);
	fireEvent.click(await screen.findByRole("button", { name: "Wording" }));
	await screen.findByRole("dialog");
	expect(state.started).not.toHaveBeenCalled();
	await clickStart("Start review");
	await waitFor(() => expect(onStarted).toHaveBeenCalledOnce());
	fireEvent.click(screen.getByRole("button", { name: "Summary" }));
	await waitFor(() => expect(onStarted).toHaveBeenCalledTimes(2));
	expect(screen.queryByRole("dialog")).toBeNull();
	expect(state.grant).toHaveBeenCalledOnce();
	cache.clear();
});

it.each([
	["SAVE_REQUIRED", "saveRequired"],
	["AI_REVIEW_SAVE_REQUIRED", "saveRequired"],
	["LETTER_EVIDENCE_REQUIRED", "jobRequired"],
	["LETTER_JOB_TEXT_REQUIRED", "jobTextRequired"],
	["LETTER_SOURCE_REQUIRED", "cvRequired"],
	["LETTER_LANGUAGE_REQUIRED", "languageRequired"],
	["AI_SOURCE_CHANGED", "sourceChanged"],
	["JOB_SELECTION_CHANGED", "sourceChanged"],
	["LETTER_REVIEW_STALE", "sourceChanged"],
	["RESUME_VERSION_CHANGED", "sourceChanged"],
	["JOB_REVISION_CHANGED", "sourceChanged"],
	["JOB_DIGEST_CHANGED", "sourceChanged"],
	["AI_SOURCE_UNAVAILABLE", "sourceUnavailable"],
	["AI_SOURCE_EXPIRED", "sourceExpired"],
	["AI_SOURCE_LOCKED", "sourceLocked"],
	["LETTER_LOCKED", "sourceLocked"],
	["AI_INVALID_REQUEST", "invalidSelection"],
	["AI_AMBIGUOUS_PASSAGE", "ambiguousPassage"],
	["AI_REQUEST_KEY_REUSED", "requestReused"],
	["TRANSLATION_BATCH_INCOMPLETE", "batchIncomplete"],
] as const)("gives %s a specific launch recovery message", (reason, key) => {
	expect(launchIssue(new ORPCError("PRECONDITION_FAILED", { data: { reason } }))?.key).toBe(`review.launch.${key}`);
	expect(launchIssue(new Error(reason))?.key).toBe(`review.launch.${key}`);
});

it("keeps an unknown client failure distinct from a request that changed", () => {
	expect(launchIssue(new RangeError("Invalid time value"))?.key).toBe("review.launch.unexpectedError");
});
it.each(["en-US", "ar-SA"] as const)("names unsupported translation sections and recovery in %s", async (locale) => {
	state.remaining = 5;
	state.reserved = 0;
	i18n.loadAndActivate({ locale, messages: locale === "ar-SA" ? arabicMessages : {} });
	const cache = new QueryClient({ defaultOptions: { queries: { retry: false } } });
	const onStarted = vi.fn();
	const view = render(
		<I18nProvider i18n={i18n}>
			<QueryClientProvider client={cache}>
				<ReviewLaunch
					kind="review.translation"
					prepare={async () => {
						throw new ORPCError("PRECONDITION_FAILED", {
							data: { reason: "TRANSLATION_PARTIAL_COVERAGE", sections: ["محتوى قديم", "Legacy content"] },
						});
					}}
					onStarted={onStarted}
				>
					Launch
				</ReviewLaunch>
			</QueryClientProvider>
		</I18nProvider>,
	);
	fireEvent.click(await screen.findByRole("button", { name: "Launch" }));
	await clickStart(locale === "ar-SA" ? "بدء المراجعة" : "Start review");
	await screen.findByText(
		locale === "ar-SA"
			? "لا يمكن ترجمة هذه الأقسام بعد: محتوى قديم, Legacy content. أخفِ هذه الأقسام من السيرة الأصلية والنسخة اللغوية، أو انقل نصها إلى قسم مدعوم في كلتيهما، ثم أعد المحاولة. مسودتك محفوظة."
			: "Translation does not support these sections yet: محتوى قديم, Legacy content. Hide them in the source CV and language copy. Alternatively, move their text into supported sections in both CVs. Then try again. Your draft is kept.",
	);
	expect(onStarted).not.toHaveBeenCalled();
	expect(state.preflight).not.toHaveBeenCalled();
	view.unmount();
	cache.clear();
});
it.each([
	["review.wording", "selected CV passages"],
	["review.extraction", "imported CV text"],
	["review.job-evidence", "CV text and the saved job description"],
	["review.tailoring", "CV text and the saved job description"],
	["review.translation", "source CV text and the target language"],
	["review.summary", "CV text and any selected job description"],
	["review.cover-letter", "CV text, the saved job description"],
] as const)("discloses the input and optional review scope before %s consent", async (kind, input) => {
	state.remaining = 5;
	state.reserved = 0;
	i18n.loadAndActivate({ locale: "en-US", messages: {} });
	const cache = new QueryClient({ defaultOptions: { queries: { retry: false } } });
	render(
		<I18nProvider i18n={i18n}>
			<QueryClientProvider client={cache}>
				<ReviewLaunch kind={kind} prepare={async () => ({ sources: [], parameters: {} })} onStarted={() => {}}>
					Request review
				</ReviewLaunch>
			</QueryClientProvider>
		</I18nProvider>,
	);
	fireEvent.click(await screen.findByRole("button", { name: "Request review" }));
	await screen.findByText(/OpenRouter/);
	const description = screen.getByRole("dialog");
	expect(description).toHaveTextContent(input);
	expect(description).toHaveTextContent("Suggestions are optional. Review the results before you apply or use them.");
	expect(description).toHaveTextContent("OpenRouter");
	expect(state.grant).not.toHaveBeenCalled();
	cache.clear();
});
it.each(["failed", "cancelled", "waiting_review", "succeeded"])(
	"refreshes last-quota usage at the %s transition",
	async (terminal) => {
		state.remaining = 0;
		state.reserved = 1;
		state.usageReads = 0;
		i18n.loadAndActivate({ locale: "en-US", messages: {} });
		const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
		render(
			<I18nProvider i18n={i18n}>
				<QueryClientProvider client={queryClient}>
					<ReviewLaunch
						kind="review.wording"
						prepare={async () => ({ sources: [], parameters: {} })}
						onStarted={() => {}}
					>
						Request review
					</ReviewLaunch>
					<ReviewOperationPanel operationId="op">
						<p>Delivered</p>
					</ReviewOperationPanel>
				</QueryClientProvider>
			</I18nProvider>,
		);
		await screen.findByText("Simultaneous AI operation limit reached");
		await screen.findByText("Review in progress");
		const before = state.usageReads;
		state.reserved = 0;
		await act(async () => {
			queryClient.setQueryData(["operation", "op"], {
				state: terminal,
				resultId: terminal === "waiting_review" || terminal === "succeeded" ? "result" : null,
			});
		});
		await waitFor(() => expect(state.usageReads).toBeGreaterThan(before));
		await waitFor(() => expect(screen.queryByText("Simultaneous AI operation limit reached")).toBeNull());
		await screen.findByText(/does not reset automatically/);
		queryClient.clear();
	},
);

it.each([
	["review.wording", "ar-SA"],
	["review.summary", "en-US"],
	["review.job-evidence", "ar-SA"],
	["review.tailoring", "en-US"],
	["review.cover-letter", "ar-SA"],
	["review.extraction", "en-US"],
] as const)("starts %s through the consent UI with the %s interface locale", async (kind, locale) => {
	state.remaining = 5;
	state.reserved = 0;
	i18n.loadAndActivate({ locale, messages: locale === "ar-SA" ? arabicMessages : {} });
	const cache = new QueryClient({ defaultOptions: { queries: { retry: false } } });
	const onStarted = vi.fn();
	const view = render(
		<I18nProvider i18n={i18n}>
			<QueryClientProvider client={cache}>
				<ReviewLaunch
					kind={kind}
					prepare={async () => ({
						kind,
						sources: [{ kind: "resume", id: "cv", revision: "revision" }],
						parameters: {},
						evidenceIds: ["fact"],
						contractVersion: "v2",
					})}
					onStarted={onStarted}
				>
					Launch
				</ReviewLaunch>
			</QueryClientProvider>
		</I18nProvider>,
	);
	fireEvent.click(await screen.findByRole("button", { name: "Launch" }));
	await screen.findByText(locale === "ar-SA" ? /OpenRouter/ : /outside Saudi Arabia/);
	await clickStart(locale === "ar-SA" ? "بدء المراجعة" : "Start review");
	await waitFor(() => expect(onStarted).toHaveBeenCalledWith("started"));
	expect(state.started).toHaveBeenCalledWith(expect.objectContaining({ parameters: { interfaceLocale: locale } }));
	view.unmount();
	cache.clear();
});

it.each(["failed", "cancelled"])("provides a complete recoverable notice when a review is %s", async (terminal) => {
	i18n.loadAndActivate({ locale: "en-US", messages: {} });
	const cache = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
	cache.setQueryData(["operation", "op"], { state: terminal, resultId: null });
	const view = render(
		<I18nProvider i18n={i18n}>
			<QueryClientProvider client={cache}>
				<ReviewOperationPanel operationId="op" onRetry={vi.fn()}>
					<p>Delivered</p>
				</ReviewOperationPanel>
			</QueryClientProvider>
		</I18nProvider>,
	);
	const notice = view.container.querySelector('[data-slot="alert"]');
	expect(notice?.querySelector('[data-slot="icon"]')).not.toBeNull();
	expect(notice?.querySelector('[data-slot="alert-title"]')?.textContent).toBeTruthy();
	expect(notice?.querySelector('[data-slot="alert-description"]')?.textContent).toContain("Your draft is kept");
	expect(screen.getByRole("button", { name: "Retry" })).toBeDefined();
	view.unmount();
	cache.clear();
});

it("explains how to recover when independent copy structure prevents translation", async () => {
	state.remaining = 5;
	state.reserved = 0;
	i18n.loadAndActivate({ locale: "en-US", messages: {} });
	const cache = new QueryClient({ defaultOptions: { queries: { retry: false } } });
	const onStarted = vi.fn();
	const view = render(
		<I18nProvider i18n={i18n}>
			<QueryClientProvider client={cache}>
				<ReviewLaunch
					kind="review.translation"
					prepare={async () => {
						throw new ORPCError("CONFLICT", { data: { reason: "TRANSLATION_STRUCTURE_CHANGED" } });
					}}
					onStarted={onStarted}
				>
					Translate copy
				</ReviewLaunch>
			</QueryClientProvider>
		</I18nProvider>,
	);
	fireEvent.click(await screen.findByRole("button", { name: "Translate copy" }));
	await clickStart("Start review");
	expect(
		await screen.findByText(
			"The source and language copy have different sections or text blocks. Open the saved CV and align its structure with the source before requesting a translation.",
		),
	).toBeDefined();
	expect(onStarted).not.toHaveBeenCalled();
	view.unmount();
	cache.clear();
});

afterEach(() => {
	cleanup();
	vi.useRealTimers();
	state.notices.mockReset();
	state.preflight.mockReset();
	state.grant.mockReset();
	state.started.mockReset();
	state.retryTranslation.mockReset();
	state.availability = "ready";
	state.operation = null;
});

it.each([
	"review.wording",
	"review.extraction",
	"review.job-evidence",
	"review.tailoring",
	"review.translation",
	"review.summary",
	"review.cover-letter",
] as const)("disables new %s starts at zero without staging or consent", async (kind) => {
	state.remaining = 0;
	state.reserved = 0;
	const prepare = vi.fn();
	const cache = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
	cache.setQueryData(["usage"], {
		plan: "start",
		operations: { limit: 5, used: 5, reserved: 0, remaining: 0 },
		baseCvs: { limit: 1, used: 1 },
	});
	i18n.loadAndActivate({ locale: "en-US", messages: {} });
	render(
		<I18nProvider i18n={i18n}>
			<QueryClientProvider client={cache}>
				<ReviewLaunch kind={kind} prepare={prepare} onStarted={vi.fn()}>
					Launch
				</ReviewLaunch>
			</QueryClientProvider>
		</I18nProvider>,
	);
	const launch = await screen.findByRole("button", { name: "Launch" });
	expect(launch).toBeDisabled();
	fireEvent.click(launch);
	expect(screen.queryByRole("dialog")).toBeNull();
	expect(screen.getByText(/does not reset automatically/)).toBeTruthy();
	expect(screen.getByText("5 of 5 AI uses used. 0 reserved for operations in progress.")).toBeTruthy();
	expect(prepare).not.toHaveBeenCalled();
	expect(state.grant).not.toHaveBeenCalled();
	expect(state.preflight).not.toHaveBeenCalled();
	expect(state.started).not.toHaveBeenCalled();
	cache.clear();
});

it("keeps disabled guidance distinct from recoverable processing unavailability", async () => {
	state.remaining = 5;
	state.reserved = 0;
	state.availability = "not_enabled";
	const prepare = vi.fn();
	const cache = new QueryClient({ defaultOptions: { queries: { retry: false } } });
	i18n.loadAndActivate({ locale: "en-US", messages: {} });
	render(
		<I18nProvider i18n={i18n}>
			<QueryClientProvider client={cache}>
				<ReviewLaunch kind="review.job-evidence" prepare={prepare} onStarted={vi.fn()}>
					Launch
				</ReviewLaunch>
			</QueryClientProvider>
		</I18nProvider>,
	);
	await screen.findByText("The assistant is not enabled yet", { exact: true });
	expect(screen.queryByRole("button", { name: "Retry" })).toBeNull();
	state.availability = "unavailable";
	await act(async () => {
		await cache.invalidateQueries({ queryKey: ["availability"] });
	});
	await screen.findByText("AI is not available in this environment.", { exact: true });
	expect(
		screen.getByText(
			"Nothing in your CV changed. No operation was deducted from your allowance. Keep writing yourself and try again later.",
			{ exact: true },
		),
	).toBeTruthy();
	state.availability = "ready";
	fireEvent.click(screen.getByRole("button", { name: /^Retry$/ }));
	await screen.findByRole("button", { name: "Launch" });
	expect(prepare).not.toHaveBeenCalled();
	cache.clear();
});

it.each([
	["Failed to fetch", true],
	["Cannot read properties of undefined", false],
] as const)("offers retry only for a transient transport failure: %s", async (message, retryable) => {
	const diagnostic = vi.spyOn(console, "error").mockImplementation(() => {});
	state.remaining = 5;
	state.reserved = 0;
	i18n.loadAndActivate({ locale: "en-US", messages: {} });
	const cache = new QueryClient({ defaultOptions: { queries: { retry: false } } });
	const view = render(
		<I18nProvider i18n={i18n}>
			<QueryClientProvider client={cache}>
				<ReviewLaunch
					kind="review.summary"
					prepare={async () => {
						throw new TypeError(message);
					}}
					onStarted={vi.fn()}
				>
					Launch
				</ReviewLaunch>
			</QueryClientProvider>
		</I18nProvider>,
	);
	fireEvent.click(await screen.findByRole("button", { name: "Launch" }));
	await clickStart("Start review");
	await screen.findByText(
		retryable
			? "The AI provider is temporarily unavailable. Your draft is kept. Retry later."
			: "An unexpected application error prevented this review from starting. Your draft is kept. Reload the page and try again. If it continues, contact support.",
	);
	if (!retryable)
		expect(diagnostic).toHaveBeenCalledWith("AI review launch failed", {
			kind: "review.summary",
			error: expect.objectContaining({ message }),
		});
	diagnostic.mockRestore();
	expect(Boolean(screen.queryByRole("button", { name: "Retry" }))).toBe(retryable);
	view.unmount();
	cache.clear();
});

it("blocks confirmation and offers recovery when no processing notice loads", async () => {
	state.remaining = 5;
	state.reserved = 0;
	state.notices.mockReturnValue([]);
	const prepare = vi.fn();
	const cache = new QueryClient({ defaultOptions: { queries: { retry: false } } });
	i18n.loadAndActivate({ locale: "en-US", messages: {} });
	render(
		<I18nProvider i18n={i18n}>
			<QueryClientProvider client={cache}>
				<ReviewLaunch kind="review.summary" prepare={prepare} onStarted={vi.fn()}>
					Launch
				</ReviewLaunch>
			</QueryClientProvider>
		</I18nProvider>,
	);
	fireEvent.click(await screen.findByRole("button", { name: "Launch" }));
	expect(await screen.findByText("AI is not available in this environment.")).toBeTruthy();
	expect(screen.getByRole("button", { name: "Retry" })).toBeEnabled();
	expect(screen.queryByRole("button", { name: "Start review" })).not.toBeInTheDocument();
	expect(prepare).not.toHaveBeenCalled();
	cache.clear();
});
it.each([null, 2, 49])("shows the real allowance for remaining %s", async (remaining) => {
	state.remaining = remaining;
	state.reserved = 0;
	const cache = new QueryClient({ defaultOptions: { queries: { retry: false } } });
	i18n.loadAndActivate({ locale: "en-US", messages: {} });
	render(
		<I18nProvider i18n={i18n}>
			<QueryClientProvider client={cache}>
				<ReviewLaunch kind="review.summary" prepare={vi.fn()} onStarted={vi.fn()}>
					Launch
				</ReviewLaunch>
			</QueryClientProvider>
		</I18nProvider>,
	);
	fireEvent.click(await screen.findByRole("button", { name: "Launch" }));
	await screen.findByRole("dialog");
	expect(screen.queryByText(/5 free operations/)).toBeNull();
	if (remaining !== null) expect(screen.getByText(`Remaining assistant operations: ${remaining}`)).toBeTruthy();
	else expect(screen.queryByText(/Remaining assistant operations:/)).toBeNull();
	cache.clear();
});

it.each([
	["AI_NOT_ENABLED", "AI is not available in this environment.", false],
	["BASE_CV_LIMIT", "Base CV limit reached", false],
	["LANGUAGE_COPY_LIMIT", "Language copy limit reached", false],
	["JOB_COPY_LIMIT", "Job copy limit reached", false],
	["AI_PROVIDER_CHANGED", "AI settings changed", false],
	["AI_BUDGET_LIMIT", "The platform cannot reserve the AI budget for this request.", false],
	["AI_PLATFORM_BUSY", "AI is at capacity.", true],
	[
		"AI_OPERATIONS_LIMIT",
		"This allowance does not reset automatically. Continue editing manually or contact support. Your draft is kept.",
		false,
	],
	["AI_CONSENT_REQUIRED", "Review the processing notice and give consent before starting. Your draft is kept.", false],
	["AI_PROVIDER_ERROR", "The AI provider is temporarily unavailable. Your draft is kept. Retry later.", true],
	["AI_CONCURRENCY_LIMIT", "Wait for an operation to finish, then try again. Your draft is kept.", true],
	["AI_TARGET_BUSY", "Wait for it to finish, then try again. Your draft is kept.", true],
	[
		"AI_INVALID_REQUEST",
		"The review selection is incomplete or invalid. Cancel and select the text or facts again, then start a new review.",
		false,
	],
] as const)("explains %s from both preflight and server errors", async (reason, message, retryable) => {
	for (const preflight of [true, false]) {
		state.remaining = 5;
		state.reserved = 0;
		state.preflight.mockReset();
		if (preflight) state.preflight.mockReturnValue({ available: false, reason });
		i18n.loadAndActivate({ locale: "en-US", messages: {} });
		const cache = new QueryClient({ defaultOptions: { queries: { retry: false } } });
		const view = render(
			<I18nProvider i18n={i18n}>
				<QueryClientProvider client={cache}>
					<ReviewLaunch
						kind="review.summary"
						prepare={async () => {
							if (!preflight) throw new ORPCError("PRECONDITION_FAILED", { data: { reason } });
							return { sources: [{ kind: "resume", id: "cv", revision: "revision" }], parameters: {} };
						}}
						onStarted={vi.fn()}
					>
						Launch
					</ReviewLaunch>
				</QueryClientProvider>
			</I18nProvider>,
		);
		fireEvent.click(await screen.findByRole("button", { name: "Launch" }));
		await clickStart("Start review");
		expect(await screen.findByText(message)).toBeTruthy();
		expect(Boolean(screen.queryByRole("button", { name: "Retry" }))).toBe(retryable);
		expect(screen.queryByRole("button", { name: "Start review" })).toBeNull();
		if (reason === "AI_CONSENT_REQUIRED") {
			fireEvent.click(screen.getByRole("button", { name: "Review consent" }));
			state.preflight.mockReturnValue({ available: true });
			if (preflight) {
				await clickStart("Start review");
				await waitFor(() => expect(state.grant).toHaveBeenCalledTimes(2));
			}
		}
		view.unmount();
		cache.clear();
		state.grant.mockReset();
	}
});

it.each(["en-US", "ar-SA"] as const)(
	"explains which text to shorten when the input is too large in %s",
	async (locale) => {
		state.remaining = 5;
		state.reserved = 0;
		i18n.loadAndActivate({ locale, messages: locale === "ar-SA" ? arabicMessages : {} });
		const cache = new QueryClient({ defaultOptions: { queries: { retry: false } } });
		const onStarted = vi.fn();
		const view = render(
			<I18nProvider i18n={i18n}>
				<QueryClientProvider client={cache}>
					<ReviewLaunch
						kind="review.translation"
						prepare={async () => {
							throw new ORPCError("PRECONDITION_FAILED", {
								data: { reason: "AI_INPUT_LIMIT" },
							});
						}}
						onStarted={onStarted}
					>
						Launch
					</ReviewLaunch>
				</QueryClientProvider>
			</I18nProvider>,
		);
		fireEvent.click(await screen.findByRole("button", { name: "Launch" }));
		await clickStart(locale === "ar-SA" ? "بدء المراجعة" : "Start review");
		await screen.findByText(
			locale === "ar-SA"
				? "اختصر إعلان الوظيفة أو أطول وصف في سيرتك الذاتية، ثم حاول مرة أخرى. لم تتغير سيرتك الذاتية."
				: "Shorten the job ad or the longest CV description, then try again. Your CV is unchanged.",
		);
		expect(onStarted).not.toHaveBeenCalled();
		expect(state.preflight).not.toHaveBeenCalled();
		view.unmount();
		cache.clear();
	},
);

it.each(["en-US", "ar-SA"] as const)("shows actionable size guidance after a worker failure in %s", async (locale) => {
	i18n.loadAndActivate({ locale, messages: locale === "ar-SA" ? arabicMessages : {} });
	const cache = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
	cache.setQueryData(["operation", "op"], { state: "failed", resultId: null, failureCode: "AI_INPUT_LIMIT" });
	const view = render(
		<I18nProvider i18n={i18n}>
			<QueryClientProvider client={cache}>
				<ReviewOperationPanel operationId="op">
					<p>Delivered</p>
				</ReviewOperationPanel>
			</QueryClientProvider>
		</I18nProvider>,
	);
	expect(view.container.textContent).toContain(locale === "ar-SA" ? "اختصر إعلان الوظيفة" : "Shorten the job ad");
	expect(view.container.textContent).toContain(
		locale === "ar-SA" ? "أطول وصف في سيرتك الذاتية" : "longest CV description",
	);
	expect(screen.queryByText("Delivered")).toBeNull();
	view.unmount();
	cache.clear();
});

it.each(["en-US", "ar-SA"] as const)("announces the server's actual review step and batch in %s", async (locale) => {
	i18n.loadAndActivate({ locale, messages: locale === "ar-SA" ? arabicMessages : {} });
	const cache = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
	const startedAt = new Date().toISOString();
	cache.setQueryData(["operation", "op"], {
		state: "queued",
		resultId: null,
		progress: { step: "queued", startedAt },
		queuePosition: 2,
	});
	const view = render(
		<I18nProvider i18n={i18n}>
			<QueryClientProvider client={cache}>
				<ReviewOperationPanel operationId="op">
					<p>Delivered</p>
				</ReviewOperationPanel>
			</QueryClientProvider>
		</I18nProvider>,
	);
	expect(screen.getByRole("status")).toHaveTextContent(
		locale === "ar-SA" ? "طلبك في قائمة الانتظار. سيبدأ قريبًا." : "Your request is waiting. It will start shortly.",
	);
	expect(screen.getByRole("status")).toHaveTextContent(
		locale === "ar-SA" ? "الترتيب في قائمة الانتظار: 2" : "Position in queue: 2",
	);
	expect(view.container.querySelector('[data-slot="review-progress"] > [data-slot="icon"]')).toBeNull();
	for (const [step, english, arabic] of [
		["drafting", "Drafting suggestions…", "جارٍ إعداد الاقتراحات…"],
		["checking", "Checking facts against your CV…", "جارٍ التحقق من المعلومات بمقارنتها بسيرتك الذاتية…"],
		["cancelling", "Cancelling…", "جارٍ الإلغاء…"],
	] as const) {
		await act(async () => {
			cache.setQueryData(["operation", "op"], {
				state: step === "cancelling" ? "cancel_requested" : "running",
				resultId: null,
				progress: { step, startedAt, part: 2, total: 3, completedParts: 1 },
			});
		});
		await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent(locale === "ar-SA" ? arabic : english));
		expect(screen.getByRole("progressbar")).toHaveAttribute("value", "1");
		expect(screen.getByRole("progressbar")).toHaveAttribute("max", "3");
		expect(screen.getByRole("status").textContent).not.toMatch(/Part 2 of 3|الجزء 2 من 3/u);
	}
	expect(screen.getByRole("button", { name: locale === "ar-SA" ? "إلغاء" : "Cancel" })).toBeDisabled();
	expect(screen.queryByText("Delivered")).toBeNull();
	view.unmount();
	cache.clear();
});

it.each(["en-US", "ar-SA"] as const)(
	"shows elapsed time after five seconds without advancing actual progress in %s",
	async (locale) => {
		vi.useFakeTimers({ toFake: ["Date", "setInterval", "clearInterval"] });
		vi.setSystemTime(new Date("2026-11-21T12:00:00Z"));
		i18n.loadAndActivate({ locale, messages: locale === "ar-SA" ? arabicMessages : {} });
		const cache = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
		const operation = {
			state: "running",
			resultId: null,
			progress: { step: "drafting", startedAt: "2026-11-21T12:00:00Z", part: 1, total: 3, completedParts: 0 },
		};
		state.operation = operation;
		cache.setQueryData(["operation", "op"], operation);
		const view = render(
			<I18nProvider i18n={i18n}>
				<QueryClientProvider client={cache}>
					<ReviewOperationPanel operationId="op">
						<p>Delivered</p>
					</ReviewOperationPanel>
				</QueryClientProvider>
			</I18nProvider>,
		);
		const elapsed = locale === "ar-SA" ? /الوقت المنقضي:/ : /Elapsed:/;
		expect(screen.queryByText(elapsed)).toBeNull();
		act(() => vi.advanceTimersByTime(4000));
		expect(screen.queryByText(elapsed)).toBeNull();
		act(() => vi.advanceTimersByTime(1000));
		expect(screen.getByText(locale === "ar-SA" ? "الوقت المنقضي: 5 ث" : "Elapsed: 5s")).toBeTruthy();
		act(() => vi.advanceTimersByTime(2000));
		expect(screen.getByText(locale === "ar-SA" ? "الوقت المنقضي: 7 ث" : "Elapsed: 7s")).toBeTruthy();
		expect(screen.getByRole("progressbar")).toHaveAccessibleName(
			locale === "ar-SA" ? "اكتمل 0 من 3 أجزاء" : "0 of 3 parts complete",
		);
		expect(screen.getByText(elapsed)).toHaveAttribute("aria-live", "off");
		expect(screen.getByRole("status")).toHaveTextContent(
			locale === "ar-SA" ? "جارٍ إعداد الاقتراحات…" : "Drafting suggestions…",
		);
		await act(async () => {
			await cache.cancelQueries({ queryKey: ["operation", "op"] });
			state.operation = { ...operation, resultId: "result", state: "waiting_review" };
			cache.setQueryData(["operation", "op"], state.operation);
		});
		expect(await screen.findByText("Delivered")).toBeTruthy();
		expect(screen.queryByText(elapsed)).toBeNull();
		expect(screen.queryByRole("status")).toBeNull();
		view.unmount();
		cache.clear();
		vi.useRealTimers();
	},
);

it("uses the operation start time on reload and never invents a batch or step", async () => {
	i18n.loadAndActivate({ locale: "en-US", messages: {} });
	const cache = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
	cache.setQueryData(["operation", "op"], {
		state: "running",
		resultId: null,
		progress: { step: "checking", startedAt: new Date(Date.now() - 18000).toISOString() },
	});
	const view = render(
		<I18nProvider i18n={i18n}>
			<QueryClientProvider client={cache}>
				<ReviewOperationPanel operationId="op">
					<p>Delivered</p>
				</ReviewOperationPanel>
			</QueryClientProvider>
		</I18nProvider>,
	);
	expect(screen.getByText("Elapsed: 18s")).toBeTruthy();
	expect(screen.getByRole("status")).toHaveTextContent("Checking facts against your CV…");
	expect(screen.queryByText(/Part \d/)).toBeNull();
	act(() => cache.setQueryData(["operation", "op"], { state: "running", resultId: null }));
	await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("Review in progress"));
	expect(screen.queryByText(/Elapsed:/)).toBeNull();
	expect(screen.queryByText("Drafting suggestions…")).toBeNull();
	view.unmount();
	cache.clear();
});

it.each(["en-US", "ar-SA"] as const)(
	"admits a nineteen-part translation once after consent with one use left in %s",
	async (locale) => {
		state.remaining = 1;
		state.reserved = 0;
		i18n.loadAndActivate({ locale, messages: locale === "ar-SA" ? arabicMessages : {} });
		const cache = new QueryClient({ defaultOptions: { queries: { retry: false } } });
		const prepare = vi.fn(async () => {
			expect(state.grant).toHaveBeenCalledOnce();
			return {
				sources: [{ kind: "resume" as const, id: "copy", revision: "revision" }],
				parameters: { resumeId: "copy" },
			};
		});
		state.preflight.mockImplementation(() => {
			expect(prepare).toHaveBeenCalledOnce();
			return { available: true, operationCost: 1, translationParts: 19 };
		});
		const onStarted = vi.fn();
		const view = render(
			<I18nProvider i18n={i18n}>
				<QueryClientProvider client={cache}>
					<ReviewLaunch kind="review.translation" prepare={prepare} onStarted={onStarted}>
						Translate copy
					</ReviewLaunch>
				</QueryClientProvider>
			</I18nProvider>,
		);
		fireEvent.click(await screen.findByRole("button", { name: "Translate copy" }));
		expect(state.grant).not.toHaveBeenCalled();
		expect(prepare).not.toHaveBeenCalled();
		const startLabel = locale === "ar-SA" ? "بدء المراجعة" : "Start review";
		const start = await screen.findByRole("button", { name: startLabel });
		fireEvent.click(start);
		fireEvent.click(start);
		await waitFor(() => expect(onStarted).toHaveBeenCalledExactlyOnceWith("started"));
		expect(state.started).toHaveBeenCalledExactlyOnceWith(state.preflight.mock.calls[0]?.[0]);
		expect(state.preflight).toHaveBeenCalledOnce();
		expect(state.grant).toHaveBeenCalledOnce();
		expect(prepare).toHaveBeenCalledOnce();
		view.unmount();
		cache.clear();
	},
);

it.each(["en-US", "ar-SA"] as const)(
	"shows every failed translation part and retries them at zero in one action with a stable key in %s",
	async (locale) => {
		state.remaining = 0;
		i18n.loadAndActivate({ locale, messages: locale === "ar-SA" ? arabicMessages : {} });
		const cache = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
		const failed = {
			id: "op",
			state: "failed",
			resultId: null,
			failureCode: "AI_PROVIDER_ERROR",
			retryable: true,
			progress: { step: "drafting", startedAt: new Date().toISOString(), part: 2, total: 4, failedParts: 2 },
		};
		state.operation = failed;
		cache.setQueryData(["operation", "op"], failed);
		let rejectAttempt: (reason: Error) => void;
		state.retryTranslation.mockImplementationOnce(
			() =>
				new Promise((_resolve, reject) => {
					rejectAttempt = reject;
				}),
		);
		state.retryTranslation.mockImplementationOnce(() => {
			state.operation = { ...failed, state: "running", failureCode: null, retryable: false };
			return state.operation;
		});
		const view = render(
			<I18nProvider i18n={i18n}>
				<QueryClientProvider client={cache}>
					<ReviewOperationPanel operationId="op">
						<p>Delivered</p>
					</ReviewOperationPanel>
				</QueryClientProvider>
			</I18nProvider>,
		);
		const notice =
			locale === "ar-SA" ? "تعذرت ترجمة جزأين. الأجزاء المكتملة محفوظة." : "2 parts failed. Completed parts are kept.";
		expect(screen.getByText(notice)).toBeTruthy();
		expect(screen.queryByText(/No review was delivered|No operation was deducted|لم تُخصم/u)).toBeNull();
		expect(screen.queryByRole("button", { name: locale === "ar-SA" ? "إعادة المحاولة" : "Retry" })).toBeNull();
		const retryLabel = locale === "ar-SA" ? "إعادة محاولة الأجزاء المتعثرة" : "Retry failed parts";
		const retry = screen.getByRole("button", { name: retryLabel });
		fireEvent.click(retry);
		await waitFor(() => expect(state.retryTranslation).toHaveBeenCalledOnce());
		expect(retry).toBeDisabled();
		expect(screen.getByText(notice)).toBeTruthy();
		await act(async () => {
			rejectAttempt(new TypeError("Failed to fetch"));
		});
		await screen.findByText(
			locale === "ar-SA"
				? "مزود الذكاء الاصطناعي غير متاح مؤقتًا. مسودتك محفوظة. حاول مجددًا لاحقًا."
				: "The AI provider is temporarily unavailable. Your draft is kept. Retry later.",
		);
		await waitFor(() => expect(screen.getByRole("button", { name: retryLabel })).toBeEnabled());
		fireEvent.click(screen.getByRole("button", { name: retryLabel }));
		await waitFor(() => expect(state.retryTranslation).toHaveBeenCalledTimes(2));
		const first = state.retryTranslation.mock.calls[0]?.[0];
		expect(first).toEqual({
			id: "op",
			requestKey: expect.any(String),
			scope: "failed_parts",
			execution: {
				route: { routeId: "synthetic", routeRevision: "1", configRevision: "1" },
				consentVersion: "1",
			},
		});
		expect(state.retryTranslation.mock.calls[1]?.[0]).toEqual(first);
		expect(state.started).not.toHaveBeenCalled();
		expect(state.preflight).not.toHaveBeenCalled();
		expect(state.grant).not.toHaveBeenCalled();
		await waitFor(() =>
			expect(screen.getByRole("progressbar")).toHaveAccessibleName(
				locale === "ar-SA" ? "اكتمل 0 من 4 أجزاء" : "0 of 4 parts complete",
			),
		);
		expect(screen.queryByText("Delivered")).toBeNull();
		view.unmount();
		cache.clear();
	},
);

it("continues refreshing failed translation state while other parts are still processing", async () => {
	i18n.loadAndActivate({ locale: "en-US", messages: {} });
	const cache = new QueryClient({ defaultOptions: { queries: { retry: false } } });
	state.operation = {
		id: "op",
		state: "failed",
		resultId: null,
		failureCode: "AI_PROVIDER_ERROR",
		retryable: true,
		progress: {
			step: "drafting",
			startedAt: new Date().toISOString(),
			part: 2,
			total: 8,
			failedParts: 1,
			activeParts: 1,
			pendingRetryParts: 1,
		},
	};
	const view = render(
		<I18nProvider i18n={i18n}>
			<QueryClientProvider client={cache}>
				<ReviewOperationPanel operationId="op">
					<p>Delivered after remaining parts</p>
				</ReviewOperationPanel>
			</QueryClientProvider>
		</I18nProvider>,
	);
	await screen.findByRole("button", { name: "Retry failed parts" });
	state.operation = { id: "op", state: "waiting_review", resultId: "op", failureCode: null };
	await screen.findByText("Delivered after remaining parts", {}, { timeout: 2500 });
	view.unmount();
	cache.clear();
});

it("uses a new request key after each acknowledged retry while other translation parts remain failed", async () => {
	i18n.loadAndActivate({ locale: "en-US", messages: {} });
	const cache = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
	const failed = {
		id: "op",
		state: "failed",
		resultId: null,
		failureCode: "AI_PROVIDER_ERROR",
		retryable: true,
		progress: { step: "drafting", startedAt: new Date().toISOString(), part: 2, total: 4 },
	};
	state.operation = failed;
	cache.setQueryData(["operation", "op"], failed);
	state.retryTranslation.mockResolvedValue(failed);
	const view = render(
		<I18nProvider i18n={i18n}>
			<QueryClientProvider client={cache}>
				<ReviewOperationPanel operationId="op">
					<p>Delivered</p>
				</ReviewOperationPanel>
			</QueryClientProvider>
		</I18nProvider>,
	);
	for (let attempt = 1; attempt <= 3; attempt++) {
		const retry = screen.getByRole("button", { name: "Retry failed parts" });
		await waitFor(() => expect(retry).toBeEnabled());
		fireEvent.click(retry);
		await waitFor(() => expect(state.retryTranslation).toHaveBeenCalledTimes(attempt));
		await waitFor(() => expect(retry).toBeEnabled());
	}
	const requests = state.retryTranslation.mock.calls.map(([request]) => request);
	expect(requests).toEqual(
		Array.from({ length: 3 }, () => ({
			id: "op",
			requestKey: expect.any(String),
			scope: "failed_parts",
			execution: {
				route: { routeId: "synthetic", routeRevision: "1", configRevision: "1" },
				consentVersion: "1",
			},
		})),
	);
	expect(new Set(requests.map((request) => request.requestKey)).size).toBe(3);
	expect(screen.queryByText("Delivered")).toBeNull();
	view.unmount();
	cache.clear();
});

it("states that a stopped translation already used its single credit", async () => {
	i18n.loadAndActivate({ locale: "en-US", messages: {} });
	const cache = new QueryClient({ defaultOptions: { queries: { retry: false } } });
	state.operation = {
		state: "failed",
		resultId: null,
		failureCode: "AI_PROVIDER_ERROR",
		retryable: false,
		charged: true,
	};
	const view = render(
		<I18nProvider i18n={i18n}>
			<QueryClientProvider client={cache}>
				<ReviewOperationPanel operationId="op" kind="review.translation">
					<p>Delivered</p>
				</ReviewOperationPanel>
			</QueryClientProvider>
		</I18nProvider>,
	);
	await screen.findByText(
		"This translation stopped. Its single AI use was charged when it started. Your CV is unchanged.",
	);
	expect(screen.queryByText(/No operation was deducted/)).toBeNull();
	view.unmount();
	cache.clear();
});

it.each(["en-US", "ar-SA"] as const)("shows the uncharged queue expiry in %s", async (locale) => {
	i18n.loadAndActivate({ locale, messages: locale === "ar-SA" ? arabicMessages : {} });
	const cache = new QueryClient({ defaultOptions: { queries: { retry: false } } });
	state.operation = { state: "failed", resultId: null, failureCode: "AI_QUEUE_EXPIRED", charged: false };
	const retry = vi.fn();
	const view = render(
		<I18nProvider i18n={i18n}>
			<QueryClientProvider client={cache}>
				<ReviewOperationPanel operationId="op" kind="review.translation" onRetry={retry}>
					<p>Delivered</p>
				</ReviewOperationPanel>
			</QueryClientProvider>
		</I18nProvider>,
	);
	await screen.findByText(locale === "ar-SA" ? "لم يُحتسب أي استخدام للمساعد." : "No AI use was charged.");
	expect(view.container).toHaveTextContent(
		locale === "ar-SA" ? "انتهت مهلة الطلب قبل بدء المعالجة." : "This request expired while waiting to start.",
	);
	fireEvent.click(screen.getByRole("button", { name: locale === "ar-SA" ? "إعادة المحاولة" : "Retry" }));
	expect(retry).toHaveBeenCalledOnce();
	view.unmount();
	cache.clear();
});

it.each([0, 1])(
	"keeps a server-rejected allowance visible and blocks another start after cancel when refreshed usage is %s",
	async (refreshedRemaining) => {
		state.remaining = 1;
		state.reserved = 0;
		state.usageReads = 0;
		i18n.loadAndActivate({ locale: "en-US", messages: {} });
		const prepare = vi.fn(async () => ({
			sources: [{ kind: "resume" as const, id: "cv", revision: "revision" }],
			parameters: {},
		}));
		const allowance = { limit: 5, used: 5, reserved: 0, remaining: 0 };
		state.preflight.mockImplementation(() => {
			state.remaining = refreshedRemaining;
			return { available: false, reason: "AI_OPERATIONS_LIMIT", allowance };
		});
		const cache = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
		render(
			<I18nProvider i18n={i18n}>
				<QueryClientProvider client={cache}>
					<ReviewLaunch kind="review.summary" prepare={prepare} onStarted={vi.fn()}>
						Launch
					</ReviewLaunch>
				</QueryClientProvider>
			</I18nProvider>,
		);
		fireEvent.click(await screen.findByRole("button", { name: "Launch" }));
		const reads = state.usageReads;
		await clickStart("Start review");
		await screen.findByText("5 of 5 AI uses used. 0 reserved for operations in progress.");
		await waitFor(() => expect(state.usageReads).toBeGreaterThan(reads));
		expect(screen.getByRole("dialog")).toHaveTextContent("5 of 5 AI uses used.");
		fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
		const launch = await screen.findByRole("button", { name: "Launch" });
		expect(launch).toBeDisabled();
		fireEvent.click(launch);
		expect(screen.queryByRole("dialog")).toBeNull();
		expect(state.preflight).toHaveBeenCalledOnce();
		expect(prepare).toHaveBeenCalledOnce();
		expect(state.started).not.toHaveBeenCalled();
		cache.clear();
	},
);

it("disables the dialog start when another tab consumes the last use before consent", async () => {
	state.remaining = 1;
	state.reserved = 0;
	i18n.loadAndActivate({ locale: "en-US", messages: {} });
	const prepare = vi.fn();
	const cache = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
	render(
		<I18nProvider i18n={i18n}>
			<QueryClientProvider client={cache}>
				<ReviewLaunch kind="review.summary" prepare={prepare} onStarted={vi.fn()}>
					Launch
				</ReviewLaunch>
			</QueryClientProvider>
		</I18nProvider>,
	);
	fireEvent.click(await screen.findByRole("button", { name: "Launch" }));
	act(() =>
		cache.setQueryData(["usage"], {
			plan: "start",
			operations: { limit: 5, used: 5, reserved: 0, remaining: 0 },
			baseCvs: { limit: 1, used: 1 },
		}),
	);
	const start = await screen.findByRole("button", { name: "Start review" });
	await waitFor(() => expect(start).toBeDisabled());
	expect(screen.getByRole("button", { name: "Cancel" })).toBeEnabled();
	expect(screen.getByRole("dialog")).toHaveTextContent("5 of 5 AI uses used.");
	fireEvent.click(start);
	expect(prepare).not.toHaveBeenCalled();
	expect(state.grant).not.toHaveBeenCalled();
	expect(state.preflight).not.toHaveBeenCalled();
	cache.clear();
});

it.each([
	"review.wording",
	"review.summary",
	"review.job-evidence",
	"review.tailoring",
	"review.cover-letter",
	"review.extraction",
] as const)("opens a fresh consent/start flow when retrying %s", async (kind) => {
	state.remaining = 5;
	state.reserved = 0;
	state.operation = { state: "failed", failureCode: "AI_REVIEW_INVALID", resultId: null };
	state.notices.mockReturnValue([syntheticNotice(kind, "en-US")]);
	i18n.loadAndActivate({ locale: "en-US", messages: {} });
	const cache = new QueryClient({ defaultOptions: { queries: { retry: false } } });
	function RetryFlow() {
		const [retryRequest, retry] = useState(0);
		return (
			<>
				<ReviewLaunch
					retryRequest={retryRequest}
					kind={kind}
					prepare={async () => ({ sources: [{ kind: "resume", id: "cv", revision: "1" }], parameters: {} })}
					onStarted={vi.fn()}
				>
					Launch
				</ReviewLaunch>
				<ReviewOperationPanel operationId="old" kind={kind} onRetry={() => retry((n) => n + 1)}>
					Review
				</ReviewOperationPanel>
			</>
		);
	}
	render(
		<I18nProvider i18n={i18n}>
			<QueryClientProvider client={cache}>
				<RetryFlow />
			</QueryClientProvider>
		</I18nProvider>,
	);
	fireEvent.click(await screen.findByRole("button", { name: "Retry" }));
	await screen.findByRole("dialog");
	await clickStart("Start review");
	await waitFor(() => expect(state.started).toHaveBeenCalled());
	expect(state.started.mock.calls.at(-1)?.[0]).toMatchObject({ kind });
	cache.clear();
});

it("shows AI_PROVIDER_UNAVAILABLE notice without a retry button", async () => {
	state.operation = { state: "failed", failureCode: "AI_PROVIDER_UNAVAILABLE", resultId: null, retryable: false };
	i18n.loadAndActivate({ locale: "en-US", messages: {} });
	const cache = new QueryClient({ defaultOptions: { queries: { retry: false } } });
	render(
		<I18nProvider i18n={i18n}>
			<QueryClientProvider client={cache}>
				<ReviewOperationPanel operationId="op-unavail" kind="review.tailoring" onRetry={vi.fn()}>
					Review
				</ReviewOperationPanel>
			</QueryClientProvider>
		</I18nProvider>,
	);
	expect(await screen.findByText("The AI service is unavailable right now. Your draft is kept.")).toBeTruthy();
	expect(screen.queryByRole("button", { name: "Retry" })).toBeNull();
	cache.clear();
});

it.each(["en-US", "ar-SA"] as const)(
	"shows a plain per-part reason for failed translation parts including AI_CALL_LIMIT in %s",
	async (locale) => {
		state.operation = {
			state: "failed",
			failureCode: "AI_CALL_LIMIT",
			resultId: null,
			retryable: true,
			progress: {
				step: "checking",
				startedAt: "2026-11-24T00:00:00.000Z",
				part: 3,
				total: 3,
				failedParts: 2,
				failedPartDetails: [
					{ part: 1, failureCode: "AI_CALL_LIMIT" },
					{ part: 3, failureCode: "AI_TIMEOUT" },
				],
			},
		};
		i18n.loadAndActivate({ locale, messages: locale === "ar-SA" ? arabicMessages : {} });
		const cache = new QueryClient({ defaultOptions: { queries: { retry: false } } });
		const view = render(
			<I18nProvider i18n={i18n}>
				<QueryClientProvider client={cache}>
					<ReviewOperationPanel operationId="op-parts" kind="review.translation" onRetry={vi.fn()}>
						Review
					</ReviewOperationPanel>
				</QueryClientProvider>
			</I18nProvider>,
		);
		if (locale === "en-US") {
			expect(await screen.findByText(/Part 1:/)).toBeTruthy();
			expect(screen.getByText(/Part 3:/)).toBeTruthy();
			expect(screen.getByText(/more retry steps than allowed/i)).toBeTruthy();
			expect(screen.getByText(/ran out of time/i)).toBeTruthy();
		} else {
			expect(await screen.findByText(/الجزء 1:/)).toBeTruthy();
			expect(screen.getByText(/الجزء 3:/)).toBeTruthy();
			expect(screen.getByText(/محاولات أكثر من المسموح/)).toBeTruthy();
			expect(screen.getByText(/نفد الوقت/)).toBeTruthy();
		}
		view.unmount();
		cache.clear();
	},
);

it.each(["ar-SA", "en-US"] as const)("requires acceptance of the displayed %s launch notice", async (locale) => {
	state.remaining = 5;
	i18n.loadAndActivate({ locale, messages: locale === "ar-SA" ? arabicMessages : {} });
	const route = { routeId: "synthetic", routeRevision: "1", configRevision: "1" };
	const notice = {
		route,
		purpose: "review.summary",
		locale,
		content: locale === "ar-SA" ? "إشعار الاختبار" : "Exact displayed notice",
		noticeVersion: "1",
		noticeSha256: "a".repeat(64),
		alreadyGranted: false,
	};
	state.notices.mockResolvedValue([notice]);
	const cache = new QueryClient({ defaultOptions: { queries: { retry: false } } });
	render(
		<I18nProvider i18n={i18n}>
			<QueryClientProvider client={cache}>
				<ReviewLaunch
					kind="review.summary"
					prepare={async () => ({ sources: [{ kind: "resume", id: "cv", revision: "1" }], parameters: {} })}
					onStarted={vi.fn()}
				>
					Launch
				</ReviewLaunch>
			</QueryClientProvider>
		</I18nProvider>,
	);
	fireEvent.click(await screen.findByRole("button", { name: "Launch" }));
	await screen.findByText(notice.content);
	expect(state.notices).toHaveBeenCalledWith({ purpose: notice.purpose, locale });
	expect(state.grant).not.toHaveBeenCalled();
	fireEvent.click(screen.getByRole("button", { name: locale === "ar-SA" ? "إلغاء" : "Cancel" }));
	expect(state.started).not.toHaveBeenCalled();
	fireEvent.click(screen.getByRole("button", { name: "Launch" }));
	await screen.findByText(notice.content);
	state.grant.mockRejectedValueOnce(
		new ORPCError("PRECONDITION_FAILED", { data: { reason: "AI_CONSENT_NOTICE_CHANGED" } }),
	);
	fireEvent.click(screen.getByRole("button", { name: locale === "ar-SA" ? "بدء المراجعة" : "Start review" }));
	await waitFor(() => expect(state.grant).toHaveBeenCalledOnce());
	expect(state.grant).toHaveBeenCalledWith({
		route,
		purpose: notice.purpose,
		noticeVersion: notice.noticeVersion,
		locale,
		noticeSha256: notice.noticeSha256,
	});
	expect(state.started).not.toHaveBeenCalled();
	cache.clear();
});
