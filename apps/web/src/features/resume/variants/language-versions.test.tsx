// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vite-plus/test";
import { i18n } from "@lingui/core";
import { I18nProvider } from "@lingui/react";
import { messages as arabicMessages } from "../../../../locales/ar-SA.po";
import { LanguageVersions } from "./language-versions";
const state = vi.hoisted(() => ({
	accepted: false,
	stale: false,
	failed: false,
	hasLanguage: true,
	operation: "",
	launch: vi.fn(),
}));
vi.mock("@/libs/orpc/client", () => {
	const options = (kind: string) => ({ queryOptions: ({ input }: { input: unknown }) => ({ kind, input }) });
	return {
		client: {},
		orpc: {
			ai: { variantReview: { get: options("review") } },
			resume: { variants: { list: options("list"), freshness: options("freshness") }, getById: options("cv") },
		},
	};
});
vi.mock("@tanstack/react-query", () => ({
	useMutation: () => ({ isPending: false }),
	useQuery: ({ kind, enabled = true }: { kind: string; enabled?: boolean }) => {
		if (!enabled || kind === "review") return { refetch: vi.fn() };
		if (kind === "list")
			return {
				data: [
					{
						resumeId: "base",
						name: "Original document",
						variantKind: "base",
						documentLocale: "ar-SA",
						updatedAt: "2026-11-21T00:00:00.000Z",
					},
					...(state.hasLanguage
						? [
								{
									resumeId: "copy",
									name: "Language document",
									variantKind: "language",
									sourceResumeId: "base",
									documentLocale: state.accepted ? "en-US" : "ar-SA",
									targetLocale: "en-US",
									updatedAt: "2026-11-21T00:00:00.000Z",
									operationId: state.operation ? "operation" : null,
								},
							]
						: []),
				],
				error: state.failed ? new Error("offline") : null,
				refetch: vi.fn(),
			};
		if (kind === "freshness")
			return {
				data: { reviewState: state.accepted ? "accepted" : "pending", state: state.stale ? "stale" : "current" },
				refetch: vi.fn(),
			};
		return {
			data: {
				updatedAt: new Date("2026-11-21T00:00:00.000Z"),
				data: { basics: { headline: "Saved source headline" }, summary: { content: "<p>Saved source text</p>" } },
			},
			refetch: vi.fn(),
		};
	},
}));
vi.mock("@tanstack/react-router", () => ({
	Link: ({ children, ...props }: React.ComponentProps<"a">) => (
		<a {...props} href="/source">
			{children}
		</a>
	),
}));
vi.mock("../editor/proposals/review-operation", () => ({
	ReviewLaunch: ({
		children,
		disabled,
		running,
		variant = "primary",
	}: {
		children: React.ReactNode;
		disabled?: boolean;
		running?: boolean;
		variant?: string;
	}) => (
		<button type="button" disabled={disabled} aria-busy={running} data-variant={variant} onClick={state.launch}>
			{children}
		</button>
	),
	ReviewOperationPanel: () => <div role="status">Operation panel</div>,
	ReviewNotice: ({ children }: { children: React.ReactNode }) => <div role="alert">{children}</div>,
	isReviewRunning: (operation: { state: string }) => operation.state === "running",
	useReviewOperationStatus: (id: string | null) => ({ data: id ? { state: state.operation } : undefined }),
}));
vi.mock("./translation-review", () => ({ TranslationReview: () => null }));
vi.mock("@/components/layout/page-header", () => ({
	PageHeader: ({ title, description, back }: { title: string; description: string; back?: React.ReactNode }) => (
		<header>
			{back}
			{title}
			<p>{description}</p>
		</header>
	),
}));
afterEach(() => {
	cleanup();
	state.accepted = false;
	state.stale = false;
	state.failed = false;
	state.hasLanguage = true;
	state.operation = "";
	state.launch.mockClear();
});
function show(locale = "en-US") {
	i18n.loadAndActivate({ locale, messages: locale === "ar-SA" ? arabicMessages : {} });
	return render(
		<I18nProvider i18n={i18n}>
			<LanguageVersions resumeId="base" />
		</I18nProvider>,
	);
}
it.each(["en-US", "ar-SA"])("isolates review, then offers one draft action in %s", (locale) => {
	state.operation = "waiting_review";
	show(locale);
	const ar = locale === "ar-SA";
	expect(screen.queryByText("Original document")).toBeNull();
	fireEvent.click(screen.getByRole("button", { name: ar ? "النسخ واللغات" : "Copies and languages" }));
	expect(screen.getByText("Original document")).toBeDefined();
	expect(screen.getByRole("button", { name: ar ? "مراجعة المسودة" : "Review draft" })).toHaveAttribute(
		"data-variant",
		"primary",
	);
	expect(screen.getAllByText("Saved source text")).toHaveLength(1);
	expect(screen.getAllByRole("button").filter((button) => button.getAttribute("href") === "/source")).toHaveLength(1);
});

it("uses the translation launch as the only primary action and hides raw locale codes", () => {
	state.hasLanguage = false;
	show();
	const translate = screen.getByRole("button", { name: "Translate to English" });
	expect(screen.getAllByRole("button").filter((button) => button.getAttribute("data-variant") === "primary")).toEqual([
		translate,
	]);
	expect(screen.getByRole("button", { name: /^Open$/u })).toHaveAttribute("data-variant", "secondary");
	expect(screen.queryByText(/en-US|ar-SA/u)).toBeNull();
	expect(screen.getByText("Arabic · Original")).toBeDefined();
});

it("keeps an approved copy openable and offers an update after a source change", () => {
	state.accepted = true;
	state.stale = true;
	show();
	expect(screen.getByText("English · Ready")).toBeDefined();
	expect(screen.getByRole("button", { name: "Open English copy" })).toHaveAttribute("data-variant", "primary");
	expect(screen.getByRole("button", { name: "Update copy" })).toHaveAttribute("data-variant", "secondary");
	expect(screen.getAllByText("Saved source text")).toHaveLength(2);
});

it("isolates progress with no editor or second launch", () => {
	state.operation = "running";
	show();
	expect(screen.getByText("Operation panel")).toBeDefined();
	expect(screen.queryByText("Original document")).toBeNull();
	expect(screen.queryByRole("button", { name: "Open" })).toBeNull();
	expect(screen.queryByRole("button", { name: "Translate to English" })).toBeNull();
});
it("keeps a failed family request distinct from a successful empty result", () => {
	state.failed = true;
	show();
	expect(screen.getByRole("alert").textContent).toContain("Could not load language versions");
	expect(screen.queryByRole("button", { name: "Translate to English" })).toBeNull();
});
