// @vitest-environment happy-dom
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vite-plus/test";
import { i18n } from "@lingui/core";
import { I18nProvider } from "@lingui/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { CareerEntryDialog } from "./entry-dialog";
import { loadUiLocale } from "@/libs/locale";

const savePending = vi.hoisted(() => vi.fn());
vi.mock("@/libs/orpc/client", () => ({
	client: { career: { master: { savePending } } },
	orpc: { career: { master: { read: { key: () => ["master"] } } } },
}));
vi.mock("../hooks", async () => {
	const { useState } = await import("react");
	return {
		useSessionDraft: (_key: string, initial: unknown) => {
			const [value, setValue] = useState(initial);
			return { value, setValue, clear: vi.fn() };
		},
	};
});
beforeEach(() => {
	i18n.loadAndActivate({ locale: "en-US", messages: {} });
	savePending.mockReset().mockResolvedValue({ id: "fact", revision: 1, draftRevision: 1 });
});
function mount(section: "experience" | "education" | "certifications" = "experience") {
	return render(
		<I18nProvider i18n={i18n}>
			<QueryClientProvider client={new QueryClient()}>
				<CareerEntryDialog
					section={section}
					entityId="entry"
					facts={[]}
					profileRevision={1}
					onClose={vi.fn()}
					onSaved={vi.fn()}
				/>
			</QueryClientProvider>
		</I18nProvider>,
	);
}
it.each(["experience", "education", "certifications"] as const)(
	"selects a month and saves ISO dates for %s",
	async (section) => {
		mount(section);
		fireEvent.change(
			screen.getByRole("textbox", {
				name: section === "experience" ? "Company" : section === "education" ? "School" : "Certificate",
			}),
			{ target: { value: "Example" } },
		);
		fireEvent.change(screen.getByRole("textbox", { name: "Start date" }), { target: { value: "2024-03" } });
		fireEvent.click(screen.getByRole("textbox", { name: "Start date" }));
		fireEvent.click(await screen.findByRole("button", { name: "April" }));
		fireEvent.click(screen.getByRole("button", { name: "Review changes" }));
		await waitFor(() =>
			expect(savePending).toHaveBeenCalledWith(
				expect.objectContaining({
					fact: expect.objectContaining({ field: "dates", value: { start: "2024-04", end: null, present: false } }),
				}),
			),
		);
	},
);
it("blocks invalid typing and preserves Present and clearing", () => {
	mount();
	const start = screen.getByRole("textbox", { name: "Start date" });
	fireEvent.change(start, { target: { value: "soon" } });
	expect(screen.getByRole("button", { name: "Review changes" })).toBeDisabled();
	fireEvent.change(start, { target: { value: "2024" } });
	expect(screen.getByRole("button", { name: "Review changes" })).toBeEnabled();
	const end = screen.getByRole("textbox", { name: "End date" });
	fireEvent.change(end, { target: { value: "invalid" } });
	fireEvent.click(screen.getByRole("checkbox", { name: "Present" }));
	expect(screen.getByRole("textbox", { name: "End date" })).toBeDisabled();
	expect(screen.getByRole("button", { name: "Review changes" })).toBeEnabled();
	fireEvent.click(screen.getByRole("checkbox", { name: "Present" }));
	expect(screen.getByRole("textbox", { name: "End date" })).toHaveValue("");
	fireEvent.change(start, { target: { value: "" } });
	fireEvent.blur(start);
	expect(start).toHaveValue("");
});
it("uses Arabic month names with Latin stored digits", async () => {
	await loadUiLocale("ar-SA");
	mount();
	fireEvent.click(screen.getByRole("textbox", { name: "تاريخ البدء" }));
	expect(await screen.findByRole("button", { name: "مارس" })).toBeEnabled();
});

it("normalizes Arabic and Persian digits while saving ISO dates", async () => {
	mount();
	fireEvent.change(screen.getByRole("textbox", { name: "Company" }), { target: { value: "Example" } });
	const start = screen.getByRole("textbox", { name: "Start date" });
	const end = screen.getByRole("textbox", { name: "End date" });
	fireEvent.change(start, { target: { value: "٢٠٢٤-٠٣" } });
	expect(start).toHaveValue("2024-03");
	fireEvent.blur(start);
	expect(start).toHaveValue("Mar 2024");
	fireEvent.change(end, { target: { value: "۲۰۲۵-۰۴" } });
	expect(end).toHaveValue("2025-04");
	fireEvent.blur(end);
	expect(end).toHaveValue("Apr 2025");
	fireEvent.click(screen.getByRole("button", { name: "Review changes" }));
	await waitFor(() =>
		expect(savePending).toHaveBeenCalledWith(
			expect.objectContaining({
				fact: expect.objectContaining({ field: "dates", value: { start: "2024-03", end: "2025-04", present: false } }),
			}),
		),
	);
});
it("keeps focus on the end date after following the date-order error link", async () => {
	mount();
	fireEvent.change(screen.getByRole("textbox", { name: "Company" }), { target: { value: "Example" } });
	fireEvent.change(screen.getByRole("textbox", { name: "Start date" }), { target: { value: "2025-01" } });
	const end = screen.getByRole("textbox", { name: "End date" });
	fireEvent.change(end, { target: { value: "2024-01" } });
	fireEvent.click(screen.getByRole("button", { name: "Review changes" }));
	const link = await screen.findByRole("link", { name: "End date must follow start date." });
	expect(link).toHaveAttribute("href", "#career-end");
	fireEvent.click(link);
	await waitFor(() => expect(end).toHaveFocus());
	expect(screen.queryByRole("button", { name: "January" })).not.toBeInTheDocument();
	expect(savePending).not.toHaveBeenCalled();
});
