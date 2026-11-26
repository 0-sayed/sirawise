import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
// @vitest-environment happy-dom
import { i18n } from "@lingui/core";
import { I18nProvider } from "@lingui/react";
import { BaseCvLimitNotice } from "./base-cv-limit";

const api = vi.hoisted(() => ({ list: vi.fn() }));
vi.mock("@/libs/orpc/client", () => ({ client: { resume: { list: api.list } } }));
beforeEach(() => {
	i18n.loadAndActivate({ locale: "en-US", messages: {} });
	api.list.mockReset().mockResolvedValue([
		{ id: "base-1", name: "My existing CV", variantKind: "base" },
		{ id: "language-1", name: "My translation", variantKind: "language" },
	]);
});
afterEach(cleanup);

it("uses the shared allowance recovery while retaining real open and replace targets", async () => {
	const opened = vi.fn();
	const replaced = vi.fn();
	render(
		<I18nProvider i18n={i18n}>
			<BaseCvLimitNotice onOpen={opened} onReplace={replaced} />
		</I18nProvider>,
	);
	expect(screen.getByText("Your base CV allowance is full.")).toBeDefined();
	const open = await screen.findByRole("button", { name: "Open existing CV" });
	await vi.waitFor(() => expect(open.hasAttribute("disabled")).toBe(false));
	fireEvent.click(open);
	fireEvent.click(screen.getByRole("button", { name: "Replace existing base CV" }));
	expect(opened).toHaveBeenCalledWith("base-1");
	expect(replaced).toHaveBeenCalledWith("base-1");
	expect(screen.getByRole("link", { name: "Help and contact" }).getAttribute("href")).toBe("/help");
});

it("recovers a failed CV lookup through the existing retry action", async () => {
	api.list.mockRejectedValueOnce(new Error("UNAVAILABLE"));
	render(
		<I18nProvider i18n={i18n}>
			<BaseCvLimitNotice onOpen={() => {}} />
		</I18nProvider>,
	);
	await screen.findByText("Could not load your existing CV. Try again.");
	expect(screen.getByRole("button", { name: "Open existing CV" }).hasAttribute("disabled")).toBe(true);
	fireEvent.click(screen.getByRole("button", { name: "Try again" }));
	await vi.waitFor(() =>
		expect(screen.getByRole("button", { name: "Open existing CV" }).hasAttribute("disabled")).toBe(false),
	);
	expect(screen.queryByText("Could not load your existing CV. Try again.")).toBeNull();
});
