import { render, screen } from "@testing-library/react";
import { expect, it } from "vite-plus/test";
import { CountBadge, SidebarCountBadge } from "./badge";

it.each([
	0,
	1,
	9,
	"3",
	<bdi key="single" dir="ltr">
		7
	</bdi>,
])("gives a single digit equal dimensions without horizontal padding: %s", (count) => {
	const { container } = render(<CountBadge>{count}</CountBadge>);
	const badge = container.querySelector("[data-slot=badge]");
	expect(badge).toHaveAttribute("data-count-digits", "single");
	expect(badge).toHaveClass("h-6", "min-w-6", "w-6", "px-0");
});

it.each([
	10,
	99,
	100,
	"99+",
	<bdi key="multiple" dir="ltr">
		12
	</bdi>,
])("keeps multiple digits readable in a pill: %s", (count) => {
	const { container } = render(<CountBadge>{count}</CountBadge>);
	expect(container.querySelector("[data-slot=badge]")).toHaveAttribute("data-count-digits", "multiple");
	expect(container.querySelector("[data-slot=badge]")).toHaveClass("h-6", "min-w-6", "px-2");
});

it("applies the same digit rule to sidebar counts without changing the rail dot", () => {
	const { rerender } = render(<SidebarCountBadge count={3} />);
	expect(screen.getByText("3").closest("[data-slot]")).toHaveAttribute("data-count-digits", "single");
	rerender(<SidebarCountBadge count={12} />);
	expect(screen.getByText("12").closest("[data-slot]")).toHaveAttribute("data-count-digits", "multiple");
	rerender(<SidebarCountBadge count={3} rail />);
	expect(document.querySelector("[data-slot=sidebar-count-badge]")).not.toHaveAttribute("data-count-digits");
});
