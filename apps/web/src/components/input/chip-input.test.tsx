// @vitest-environment happy-dom
import type { ChipInputHandle } from "./chip-input";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { beforeAll, expect, it, vi } from "vite-plus/test";
import { i18n } from "@lingui/core";
import { I18nProvider } from "@lingui/react";
import { createRef } from "react";
import { ChipInput } from "./chip-input";

beforeAll(() => {
	i18n.loadAndActivate({ locale: "en-US", messages: {} });
});

it("keeps commas in new and edited keywords and saves on Enter", () => {
	const onChange = vi.fn();
	render(
		<I18nProvider i18n={i18n}>
			<ChipInput allowCommas defaultValue={["Existing"]} onChange={onChange} />
		</I18nProvider>,
	);
	for (const name of ["Edit Existing", "Remove Existing"]) {
		const action = screen.getByRole("button", { name });
		expect(action).toHaveAttribute("data-size", "icon-chip");
		expect(action.closest('[data-slot="chip"]')).not.toBeNull();
	}
	const input = screen.getByRole("textbox", { name: "Add keyword" });
	fireEvent.change(input, { target: { value: "Systems, distributed" } });
	expect(onChange).not.toHaveBeenCalled();
	fireEvent.keyDown(input, { key: "," });
	expect(onChange).not.toHaveBeenCalled();
	fireEvent.keyDown(input, { key: "Enter" });
	expect(onChange).toHaveBeenLastCalledWith(["Existing", "Systems, distributed"]);
	fireEvent.click(screen.getByRole("button", { name: "Edit Existing" }));
	const editor = screen.getByRole("textbox", { name: "Edit keyword" });
	onChange.mockClear();
	fireEvent.change(editor, { target: { value: "Existing, revised" } });
	expect(onChange).not.toHaveBeenCalled();
	fireEvent.keyDown(editor, { key: "Enter" });
	expect(onChange).toHaveBeenLastCalledWith(["Existing, revised", "Systems, distributed"]);
});

it("retains comma-separated bulk entry for tags", () => {
	const onChange = vi.fn();
	render(
		<I18nProvider i18n={i18n}>
			<ChipInput onChange={onChange} />
		</I18nProvider>,
	);
	const input = screen.getByRole("textbox", { name: "Add keyword" });
	fireEvent.change(input, { target: { value: "first,second," } });
	expect(onChange).toHaveBeenLastCalledWith(["first", "second"]);
});

it("commits the pending keyword unchanged when it contains a comma", () => {
	const ref = createRef<ChipInputHandle>();
	const onChange = vi.fn();
	render(
		<I18nProvider i18n={i18n}>
			<ChipInput ref={ref} allowCommas defaultValue={["Existing"]} onChange={onChange} />
		</I18nProvider>,
	);
	const input = screen.getByRole("textbox", { name: "Add keyword" });
	fireEvent.change(input, { target: { value: "Systems, distributed" } });
	expect(onChange).not.toHaveBeenCalled();
	act(() => expect(ref.current?.commit()).toEqual(["Existing", "Systems, distributed"]));
	expect(onChange).toHaveBeenCalledExactlyOnceWith(["Existing", "Systems, distributed"]);
	expect(input).toHaveValue("");
});
