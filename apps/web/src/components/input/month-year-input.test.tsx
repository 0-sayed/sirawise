// @vitest-environment happy-dom
import type { YearMonth } from "@reactive-resume/schema/resume/dates";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, expect, it, vi } from "vite-plus/test";
import { i18n } from "@lingui/core";
import { I18nProvider } from "@lingui/react";
import { useState } from "react";
import { MonthYearInput } from "./month-year-input";

beforeEach(() => i18n.loadAndActivate({ locale: "en-US", messages: {} }));

function mount() {
	const commit = vi.fn();
	function Field() {
		const [value, setValue] = useState<YearMonth | null>("2024-03");
		return (
			<MonthYearInput
				label="Start date"
				locale="en-US"
				value={value}
				onCommit={(next) => {
					setValue(next);
					commit(next);
				}}
				onInvalid={vi.fn()}
			/>
		);
	}
	render(
		<I18nProvider i18n={i18n}>
			<button type="button">Before</button>
			<Field />
			<button type="button">Review changes</button>
		</I18nProvider>,
	);
	return { user: userEvent.setup(), input: screen.getByRole("textbox", { name: "Start date" }), commit };
}

async function expectClosed() {
	await waitFor(() => expect(screen.queryByRole("button", { name: "April" })).not.toBeInTheDocument());
}

it("does not open on focus or typed date input", async () => {
	const { user, input, commit } = mount();
	await user.tab();
	await user.tab();
	expect(input).toHaveFocus();
	expect(screen.queryByRole("button", { name: "April" })).not.toBeInTheDocument();
	fireEvent.change(input, { target: { value: "2025-04" } });
	expect(commit).toHaveBeenLastCalledWith("2025-04");
	await expectClosed();
});

it("opens on a field click and closes when typing starts", async () => {
	const { user, input } = mount();
	await user.click(input);
	expect(await screen.findByRole("button", { name: "April" })).toBeVisible();
	await user.keyboard("2025");
	await expectClosed();
	expect(input).toHaveFocus();
});

it("closes when the field loses focus outside the picker", async () => {
	const { user, input } = mount();
	await user.click(input);
	await screen.findByRole("button", { name: "April" });
	screen.getByRole("button", { name: "Review changes" }).focus();
	await expectClosed();
});

it("keeps the picker open through its controls and closes on Tab out", async () => {
	const { user, input } = mount();
	await user.click(input);
	const april = await screen.findByRole("button", { name: "April" });
	await user.tab();
	expect(screen.getByRole("button", { name: "Choose a date." })).toHaveFocus();
	await user.tab();
	expect(screen.getByRole("combobox")).toHaveFocus();
	expect(april).toBeVisible();
	await user.tab();
	expect(screen.getByRole("button", { name: "January" })).toHaveFocus();
	screen.getByRole("button", { name: "December" }).focus();
	await user.tab();
	await expectClosed();
	expect(screen.getByRole("button", { name: "Review changes" })).toHaveFocus();
});

it("closes on Shift+Tab out of the field", async () => {
	const { user, input } = mount();
	await user.click(input);
	await screen.findByRole("button", { name: "April" });
	await user.tab({ shift: true });
	await expectClosed();
	expect(screen.getByRole("button", { name: "Before" })).toHaveFocus();
});

it.each(["field", "picker"])("closes on Escape from the %s", async (target) => {
	const { user, input } = mount();
	await user.click(input);
	await screen.findByRole("button", { name: "April" });
	if (target === "picker") screen.getByRole("combobox").focus();
	await user.keyboard("{Escape}");
	await expectClosed();
});

it("closes on outside pointer down before a click", async () => {
	const { user } = mount();
	await user.click(screen.getByRole("button", { name: "Choose a date." }));
	await screen.findByRole("button", { name: "April" });
	await user.pointer({ target: screen.getByRole("button", { name: "Review changes" }), keys: "[MouseLeft>]" });
	await expectClosed();
});

it("opens from the calendar button with the keyboard and closes after choosing a month", async () => {
	const { user, commit } = mount();
	screen.getByRole("button", { name: "Choose a date." }).focus();
	await user.keyboard("{Enter}");
	const april = await screen.findByRole("button", { name: "April" });
	await user.tab();
	expect(screen.getByRole("combobox")).toHaveFocus();
	april.focus();
	await user.keyboard("{Enter}");
	expect(commit).toHaveBeenLastCalledWith("2024-04");
	await expectClosed();
});
