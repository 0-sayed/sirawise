import { render, screen, cleanup } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vite-plus/test";
// @vitest-environment happy-dom
import { i18n } from "@lingui/core";
import { I18nProvider } from "@lingui/react";

const queryState = vi.hoisted(() => ({ loading: false, reserved: 0 }));
vi.mock("@tanstack/react-query", () => ({
	useMutation: () => ({ isPending: false }),
	useQuery: ({ queryKey }: { queryKey: string[] }) => ({
		data: queryState.loading
			? undefined
			: queryKey[0] === "availability"
				? { state: "ready", reason: null }
				: { operations: { remaining: 0, reserved: queryState.reserved } },
	}),
}));
vi.mock("@/libs/orpc/client", () => ({
	orpc: {
		ai: {
			availability: { queryOptions: () => ({ queryKey: ["availability"] }) },
			usage: { get: { queryOptions: () => ({ queryKey: ["usage"] }) } },
		},
	},
}));
import { ReviewLaunch } from "../proposals/review-operation";
const WritingTab = () => (
	<ReviewLaunch kind="review.wording" prepare={() => Promise.reject(new Error("not requested"))} onStarted={() => {}}>
		Review wording
	</ReviewLaunch>
);
afterEach(() => {
	cleanup();
	queryState.loading = false;
	queryState.reserved = 0;
});
it("announces availability loading", () => {
	queryState.loading = true;
	i18n.loadAndActivate({ locale: "en-US", messages: {} });
	render(
		<I18nProvider i18n={i18n}>
			<WritingTab />
		</I18nProvider>,
	);
	const status = screen.getByRole("status");
	expect(status.textContent).toBe("Loading assistant availability…");
});
it("renders the current allowance guidance without a plans action", () => {
	i18n.loadAndActivate({ locale: "en-US", messages: {} });
	render(
		<I18nProvider i18n={i18n}>
			<WritingTab />
		</I18nProvider>,
	);
	expect(screen.getByRole("alert").textContent).toContain("No AI uses are available in your current allowance.");
	expect(screen.getByRole("alert").textContent).toContain(
		"This allowance does not reset automatically. Continue editing manually or contact support. Your draft is kept.",
	);
	expect(screen.getByRole("link", { name: "Help and contact" }).getAttribute("href")).toBe("/help");
	expect(screen.queryByRole("button", { name: /plans/i })).toBeNull();
});

it("announces a running operation instead of unavailable writing suggestions", () => {
	queryState.reserved = 1;
	i18n.loadAndActivate({ locale: "en-US", messages: {} });
	render(
		<I18nProvider i18n={i18n}>
			<WritingTab />
		</I18nProvider>,
	);
	expect(screen.queryByText("Writing suggestions are not available yet")).toBeNull();
	expect(
		screen.getByText("Simultaneous AI operation limit reached").closest('[data-slot="alert-title"]'),
	).not.toBeNull();
	expect(screen.getByRole("alert").textContent).toContain(
		"Wait for an operation to finish, then try again. Your draft is kept.",
	);
});
