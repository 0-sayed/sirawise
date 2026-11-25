import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import { GuidedTour } from "./guided-tour";

const labels = {
	start: "Show me how",
	back: "Back",
	next: "Next",
	skip: "Skip",
	done: "Done",
	step: (current: number, total: number) => `Step ${current} of ${total}`,
};
function fixture(userId = "alice", dir: "rtl" | "ltr" = "ltr") {
	return render(
		<div dir={dir}>
			<select id="tour-section" aria-label="Section">
				<option>Experience</option>
			</select>
			<textarea id="tour-text" aria-label="Text" />
			<button id="tour-review" type="button" disabled>
				Review
			</button>
			<GuidedTour
				tourId="import"
				userId={userId}
				labels={labels}
				steps={[
					{ targetId: "tour-section", title: "Choose a section", description: "Choose the right section." },
					{ targetId: "tour-text", title: "Highlight text", description: "Select the uncertain passage." },
					{ targetId: "tour-review", title: "Review text", description: "Review only your selection." },
				]}
			/>
		</div>,
	);
}
beforeEach(() => localStorage.clear());
afterEach(() => {
	cleanup();
	vi.restoreAllMocks();
});

it("starts only on request, spotlights each real target, and permits back, completion, and replay", async () => {
	fixture();
	expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
	await userEvent.click(screen.getByRole("button", { name: labels.start }));
	await waitFor(() => expect(screen.getByRole("dialog")).toBeVisible());
	expect(screen.getByRole("status")).toHaveTextContent("Step 1 of 3");
	expect(document.querySelector('[data-slot="guided-tour-spotlight"]')).toHaveAttribute("data-target", "tour-section");
	expect(screen.getByRole("button", { name: labels.back })).toBeDisabled();
	await userEvent.click(screen.getByRole("button", { name: labels.next }));
	expect(screen.getByRole("status")).toHaveTextContent("Step 2 of 3");
	expect(screen.getByText("Highlight text")).toHaveFocus();
	expect(document.querySelector('[data-slot="guided-tour-spotlight"]')).toHaveAttribute("data-target", "tour-text");
	await userEvent.click(screen.getByRole("button", { name: labels.back }));
	expect(screen.getByRole("status")).toHaveTextContent("Step 1 of 3");
	await userEvent.click(screen.getByRole("button", { name: labels.next }));
	await userEvent.click(screen.getByRole("button", { name: labels.next }));
	expect(document.querySelector('[data-slot="guided-tour-spotlight"]')).toHaveAttribute("data-target", "tour-review");
	await userEvent.click(screen.getByRole("button", { name: labels.done }));
	await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
	expect(screen.getByRole("button", { name: labels.start })).toHaveFocus();
	expect(screen.getByRole("button", { name: labels.start })).toHaveAttribute("data-seen", "true");
	await userEvent.click(screen.getByRole("button", { name: labels.start }));
	expect(screen.getByRole("status")).toHaveTextContent("Step 1 of 3");
});

it("supports Escape, RTL, keyboard navigation, and account-scoped seen state without autostart", async () => {
	const first = fixture("alice", "rtl");
	await userEvent.tab();
	await userEvent.tab();
	await userEvent.tab();
	expect(screen.getByRole("button", { name: labels.start })).toHaveFocus();
	await userEvent.keyboard("{Enter}");
	await waitFor(() => expect(screen.getByRole("dialog")).toBeVisible());
	expect(screen.getByRole("dialog")).toHaveAttribute("dir", "rtl");
	await userEvent.keyboard("{Escape}");
	await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
	first.unmount();
	const returning = fixture("alice");
	expect(screen.getByRole("button", { name: labels.start })).toHaveAttribute("data-seen", "true");
	expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
	returning.unmount();
	fixture("bob");
	expect(screen.getByRole("button", { name: labels.start })).toHaveAttribute("data-seen", "false");
});

it("keeps replay and Skip working when browser storage is unavailable", async () => {
	vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
		throw new Error("blocked");
	});
	vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
		throw new Error("blocked");
	});
	fixture();
	await userEvent.click(screen.getByRole("button", { name: labels.start }));
	await userEvent.click(screen.getByRole("button", { name: labels.skip }));
	await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
	await userEvent.click(screen.getByRole("button", { name: labels.start }));
	expect(screen.getByRole("status")).toHaveTextContent("Step 1 of 3");
});
