// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vite-plus/test";
import { i18n } from "@lingui/core";
import { I18nProvider } from "@lingui/react";
import { ORPCError } from "@orpc/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { LanguageVersions } from "./language-versions";

const state = vi.hoisted(() => ({
	create: vi.fn(),
	refetch: vi.fn(),
	revision: "2026-11-14T00:00:00.000Z",
	language: false,
	stale: false,
	alreadyGranted: false,
	start: vi.fn(),
}));
vi.mock("@/libs/orpc/client", () => ({
	client: {
		resume: { variants: { create: state.create } },
		ai: {
			processing: {
				notices: async ({ purpose, locale }: { purpose: string; locale: string }) => [
					{
						route: {},
						purpose,
						locale,
						noticeVersion: "test",
						content: "Synthetic processing notice",
						alreadyGranted: state.alreadyGranted,
						noticeSha256: "a".repeat(64),
					},
				],
				grant: async () => undefined,
			},
			variantReview: { prepare: async () => ({ sources: [], parameters: {} }) },
			operations: {
				preflight: async () => {
					if (state.alreadyGranted) return { available: true };
					throw new ORPCError("SERVICE_UNAVAILABLE");
				},
				start: state.start,
			},
		},
	},
	orpc: {
		ai: {
			availability: { queryOptions: () => ({ kind: "availability" }) },
			usage: { get: { queryOptions: () => ({ kind: "usage" }) } },
			operations: { get: { queryOptions: () => ({ kind: "operation" }) } },
			variantReview: { get: { queryOptions: () => ({ kind: "review" }) } },
		},
		resume: {
			variants: {
				list: { queryOptions: () => ({ kind: "list" }) },
				freshness: { queryOptions: () => ({ kind: "freshness" }) },
			},
			getById: { queryOptions: () => ({ kind: "document" }) },
		},
	},
}));
vi.mock("@tanstack/react-query", async (importOriginal) => ({
	...(await importOriginal<typeof import("@tanstack/react-query")>()),
	useQuery: ({ kind, enabled = true }: { kind?: string; enabled?: boolean }) => ({
		data:
			kind === "list"
				? [
						{
							resumeId: "base",
							name: "Original",
							variantKind: "base",
							documentLocale: "ar-SA",
							updatedAt: state.revision,
						},
						...(state.language
							? [
									{
										resumeId: "copy",
										name: "English original translated",
										variantKind: "language",
										documentLocale: "en-US",
										targetLocale: "ar-SA",
										updatedAt: state.revision,
										operationId: state.stale ? "stale" : null,
									},
								]
							: []),
					]
				: kind === "availability"
					? { state: "ready", reason: null }
					: kind === "usage"
						? { operations: { remaining: 3, reserved: 0 } }
						: kind === "operation" && enabled && state.stale
							? { state: "failed", failureCode: "AI_SOURCE_CHANGED", resultId: null, retryable: false }
							: kind === "document" && state.stale
								? {
										updatedAt: new Date(state.revision),
										data: { basics: { headline: "Saved Arabic headline" }, summary: { content: "" } },
									}
								: kind === "freshness" && state.stale
									? { reviewState: "accepted", state: "stale" }
									: undefined,
		refetch: state.refetch,
	}),
}));
vi.mock("@tanstack/react-router", () => ({
	Link: ({ children }: { children: React.ReactNode }) => <a href="/source">{children}</a>,
}));
vi.mock("./translation-review", () => ({ TranslationReview: () => null }));
vi.mock("@/components/layout/page-header", () => ({ PageHeader: () => null }));
afterEach(() => {
	cleanup();
	state.language = false;
	state.stale = false;
	state.alreadyGranted = false;
	vi.clearAllMocks();
});

it("keeps the saved copy and offers a new translation when the old review is stale", async () => {
	i18n.loadAndActivate({ locale: "en-US", messages: {} });
	state.language = true;
	state.stale = true;
	state.alreadyGranted = true;
	state.start.mockResolvedValue({ id: "fresh" });
	const cache = new QueryClient();
	render(
		<I18nProvider i18n={i18n}>
			<QueryClientProvider client={cache}>
				<LanguageVersions resumeId="base" />
			</QueryClientProvider>
		</I18nProvider>,
	);
	expect(
		screen.getByText("The CV changed after this translation, so this review is out of date. Start a new translation."),
	).toBeVisible();
	expect(screen.getByRole("heading", { name: "Arabic copy" }).closest("section")).toHaveTextContent(
		"Saved Arabic headline",
	);
	expect(screen.queryByRole("button", { name: "Retry" })).toBeNull();
	fireEvent.click(screen.getByRole("button", { name: "Update copy" }));
	await waitFor(() => expect(state.start).toHaveBeenCalledOnce());
	expect(screen.queryByRole("dialog")).toBeNull();
	cache.clear();
});

it("reuses a creation request after a lost response and starts a fresh request after acknowledgment", async () => {
	i18n.loadAndActivate({ locale: "en-US", messages: {} });
	const keys: string[] = [];
	state.create.mockImplementation(async (input: { requestKey: string }) => {
		keys.push(input.requestKey);
		if (keys.length === 1) throw new TypeError("Network request failed");
		return { resumeId: "copy", updatedAt: state.revision };
	});
	const cache = new QueryClient({ defaultOptions: { mutations: { retry: false } } });
	render(
		<I18nProvider i18n={i18n}>
			<QueryClientProvider client={cache}>
				<LanguageVersions resumeId="base" />
			</QueryClientProvider>
		</I18nProvider>,
	);
	fireEvent.click(screen.getByRole("button", { name: "Translate to English" }));
	await screen.findByText("Synthetic processing notice");
	fireEvent.click(screen.getByRole("button", { name: "Start review" }));
	fireEvent.click(await screen.findByRole("button", { name: "Retry" }));
	await waitFor(() => expect(keys).toHaveLength(2));
	expect(keys[1]).toBe(keys[0]);
	await screen.findByText("The AI provider is temporarily unavailable. Your draft is kept. Retry later.");
	fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
	fireEvent.click(screen.getByRole("button", { name: "Translate to English" }));
	await screen.findByText("Synthetic processing notice");
	fireEvent.click(screen.getByRole("button", { name: "Start review" }));
	await waitFor(() => expect(keys).toHaveLength(3));
	expect(keys[2]).not.toBe(keys[0]);
	cache.clear();
});

it("refreshes the saved family after a language-copy limit without repeating creation", async () => {
	i18n.loadAndActivate({ locale: "en-US", messages: {} });
	state.create.mockRejectedValue(
		new ORPCError("PRECONDITION_FAILED", {
			data: { reason: "LANGUAGE_COPY_LIMIT", allowance: { limit: 1, used: 1, reserved: 0, remaining: 0 } },
		}),
	);
	const cache = new QueryClient({ defaultOptions: { mutations: { retry: false } } });
	render(
		<I18nProvider i18n={i18n}>
			<QueryClientProvider client={cache}>
				<LanguageVersions resumeId="base" />
			</QueryClientProvider>
		</I18nProvider>,
	);
	fireEvent.click(screen.getByRole("button", { name: "Translate to English" }));
	await screen.findByText("Synthetic processing notice");
	fireEvent.click(screen.getByRole("button", { name: "Start review" }));
	await screen.findByText("Language copy limit reached");
	expect(screen.getByText("1 of 1 language copies used for this base CV. 0 being created.")).toBeTruthy();
	expect(state.refetch).toHaveBeenCalledOnce();
	expect(state.create).toHaveBeenCalledOnce();
	expect(screen.getByRole("link", { name: "Help and contact" }).getAttribute("href")).toBe("/help");
	cache.clear();
});

it("shows the target language of a copy before approval", () => {
	i18n.loadAndActivate({ locale: "en-US", messages: {} });
	state.language = true;
	const cache = new QueryClient();
	render(
		<I18nProvider i18n={i18n}>
			<QueryClientProvider client={cache}>
				<LanguageVersions resumeId="base" />
			</QueryClientProvider>
		</I18nProvider>,
	);
	expect(screen.getByRole("heading", { name: "Arabic copy" })).toBeVisible();
	expect(screen.queryByText(/ar-SA · Language copy/)).toBeNull();
	cache.clear();
});
