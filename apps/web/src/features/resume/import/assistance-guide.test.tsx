// @vitest-environment happy-dom
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import { i18n } from "@lingui/core";
import { I18nProvider } from "@lingui/react";
import { ImportAssistanceGuide } from "./assistance-guide";

vi.mock("@/hooks/use-current-session", () => ({ useCurrentSession: () => ({ user: { id: "tour-user" } }) }));
beforeEach(() => {
	localStorage.clear();
	i18n.loadAndActivate({ locale: "en-US", messages: {} });
});
afterEach(cleanup);

it("offers an optional replayable tour of the real section, text and review controls", async () => {
	render(
		<I18nProvider i18n={i18n}>
			<select id="section">
				<option>Experience</option>
			</select>
			<textarea id="text" />
			<button type="button" id="review">
				Review
			</button>
			<ImportAssistanceGuide sectionId="section" textId="text" reviewId="review" />
		</I18nProvider>,
	);
	expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
	await userEvent.click(screen.getByRole("button", { name: "Show me how" }));
	await waitFor(() => expect(screen.getByRole("dialog")).toBeVisible());
	expect(document.querySelector('[data-slot="guided-tour-spotlight"]')).toHaveAttribute("data-target", "section");
	await userEvent.click(screen.getByRole("button", { name: "Next" }));
	expect(document.querySelector('[data-slot="guided-tour-spotlight"]')).toHaveAttribute("data-target", "text");
	await userEvent.click(screen.getByRole("button", { name: "Next" }));
	expect(document.querySelector('[data-slot="guided-tour-spotlight"]')).toHaveAttribute("data-target", "review");
	expect(screen.getByText("Press Review selected text.")).toBeVisible();
	await userEvent.click(screen.getByRole("button", { name: "Done" }));
	await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
	expect(screen.getByRole("button", { name: "Show me how" })).toBeVisible();
});
