// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vite-plus/test";
import { i18n } from "@lingui/core";
import { I18nProvider } from "@lingui/react";
import { ORPCError } from "@orpc/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { messages as arabicMessages } from "../../../../locales/ar-SA.po";
import { Clarification } from "./clarification";
vi.mock("@tanstack/react-router", () => ({
	Link: ({ children }: { children: React.ReactNode }) => <a href="/career">{children}</a>,
}));
const api = vi.hoisted(() => ({ answer: vi.fn(), dismiss: vi.fn() }));
vi.mock("@/libs/orpc/client", () => ({
	client: { ai: { review: { answer: api.answer, dismissQuestion: api.dismiss } } },
}));
vi.mock("../editor/proposals/review-operation", () => ({
	ReviewNotice: ({ children, retry }: { children: React.ReactNode; retry?: () => void }) => (
		<div role="alert">
			{children}
			{retry && <button onClick={retry}>Retry</button>}
		</div>
	),
}));
afterEach(() => {
	cleanup();
	document.documentElement.removeAttribute("dir");
});

function showQuestion(dismissed: string[] = []) {
	i18n.loadAndActivate({ locale: "en-US", messages: {} });
	const cache = new QueryClient({ defaultOptions: { mutations: { retry: false } } });
	const view = render(
		<I18nProvider i18n={i18n}>
			<QueryClientProvider client={cache}>
				<Clarification
					operationId="review"
					source={{ kind: "resume", id: "cv", revision: "1" }}
					questions={[{ id: "q", prompt: "What project can you confirm?" }]}
					resolved={[]}
					dismissed={dismissed}
					stale={false}
					onSaved={() => {}}
				/>
			</QueryClientProvider>
		</I18nProvider>,
	);
	return { ...view, cache };
}

it("shows a failed Skip beside the question and clears it when opening an answer", async () => {
	api.dismiss.mockRejectedValueOnce(new Error("offline"));
	const { cache } = showQuestion();
	fireEvent.click(screen.getByRole("button", { name: "Skip" }));
	expect(await screen.findByRole("alert")).toBeDefined();
	expect(screen.queryByRole("dialog")).toBeNull();
	fireEvent.click(screen.getByRole("button", { name: "Add information" }));
	await screen.findByRole("dialog");
	await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
	cache.clear();
});

it("retries a conflict inside the overlay, preserves the draft, and shows the saved answer", async () => {
	api.answer.mockRejectedValueOnce(new ORPCError("CONFLICT")).mockResolvedValueOnce({
		id: "answer",
		quote: "Built a reporting project.",
	});
	const { cache } = showQuestion();
	fireEvent.click(screen.getByRole("button", { name: "Add information" }));
	const dialog = await screen.findByRole("dialog");
	expect(dialog).toHaveTextContent("What project can you confirm?");
	fireEvent.change(screen.getByRole("textbox", { name: "Your answer" }), {
		target: { value: "Built a reporting project." },
	});
	fireEvent.click(screen.getByRole("button", { name: "Save answer" }));
	expect(await screen.findByRole("alert")).toBeDefined();
	expect(dialog).toContainElement(screen.getByRole("alert"));
	expect(screen.getByRole("textbox")).toHaveValue("Built a reporting project.");
	fireEvent.click(screen.getByRole("button", { name: "Retry" }));
	await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
	expect(screen.getByText("Built a reporting project.")).toHaveAttribute("dir", "auto");
	expect(screen.getByText("Your answer was saved. Your CV is unchanged.")).toBeDefined();
	expect(api.answer.mock.calls.at(-1)?.[0].requestKey).toBe(api.answer.mock.calls.at(-2)?.[0].requestKey);
	cache.clear();
});

it("shows skipped status without implying supplied information", () => {
	const { cache } = showQuestion(["q"]);
	expect(screen.getByText("Skipped. You can request another review when you have more information.")).toBeDefined();
	expect(screen.queryByText(/Supplied information/)).toBeNull();
	expect(screen.queryByRole("button", { name: "Add information" })).toBeNull();
	cache.clear();
});
it("localizes a stored English wording question in the Arabic card and overlay", async () => {
	document.documentElement.dir = "rtl";
	i18n.loadAndActivate({ locale: "ar-SA", messages: arabicMessages });
	const cache = new QueryClient();
	render(
		<I18nProvider i18n={i18n}>
			<QueryClientProvider client={cache}>
				<Clarification
					operationId="review"
					source={{ kind: "resume", id: "cv", revision: "1" }}
					kind="review.wording"
					questions={[{ id: "q", prompt: "What project can you confirm?" }]}
					resolved={[]}
					stale={false}
					onSaved={() => {}}
				/>
			</QueryClientProvider>
		</I18nProvider>,
	);
	const localized = "ما النتيجة أو التفصيل الذي يمكنك تأكيده في هذا المقطع؟";
	expect(screen.getByText(localized)).toBeVisible();
	expect(screen.queryByText("What project can you confirm?")).toBeNull();
	fireEvent.click(screen.getByRole("button", { name: "إضافة معلومة" }));
	const dialog = await screen.findByRole("dialog");
	expect(dialog).toHaveAccessibleDescription(localized);
	expect(Array.from(dialog.querySelectorAll("p")).find((node) => node.textContent === localized)).toHaveAttribute(
		"dir",
		"auto",
	);
	cache.clear();
});
