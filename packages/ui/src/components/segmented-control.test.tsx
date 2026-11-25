import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vite-plus/test";
import { Icon } from "./icon";
import { SegmentedControl, SegmentedControlItem } from "./segmented-control";

it.each(["ltr", "rtl"] as const)("uses equal columns without shrinking icon-label content in %s", (dir) => {
	const { container } = render(
		<SegmentedControl dir={dir} defaultValue="preview">
			<SegmentedControlItem value="preview">
				<Icon name="file-text" size={18} />
				<span>المعاينة</span>
			</SegmentedControlItem>
			<SegmentedControlItem value="parsed">
				<Icon name="brackets-curly" size={18} />
				<span>النص المستخرج</span>
			</SegmentedControlItem>
		</SegmentedControl>,
	);
	expect(container.querySelector('[data-slot="segmented-control"]')).toHaveClass(
		"inline-grid",
		"grid-flow-col",
		"auto-cols-fr",
		"p-1",
	);
	for (const item of screen.getAllByRole("radio")) {
		expect(item).toHaveClass("px-3");
		// Keep icon, gap and text measurable even when the track is constrained.
		expect(item.querySelector('[data-slot="segmented-control-label"]')).toHaveClass("shrink-0");
	}
});

it("keeps wrapped labels inside equally padded LTR and RTL segments", () => {
	const { container } = render(
		<>
			{(["ltr", "rtl"] as const).map((dir) => (
				<SegmentedControl key={dir} dir={dir} data-wrap={true} defaultValue="parsed">
					<SegmentedControlItem value="preview">معاينة السيرة الذاتية</SegmentedControlItem>
					<SegmentedControlItem value="parsed">النص المستخرج من السيرة الذاتية</SegmentedControlItem>
				</SegmentedControl>
			))}
		</>,
	);

	for (const group of container.querySelectorAll('[data-slot="segmented-control"]')) {
		expect(group.className).toContain("inline-grid");
		expect(group.className).toContain("data-[wrap=true]:grid-flow-row");
		const items = [...group.querySelectorAll('[data-slot="segmented-control-item"]')];
		expect(items).toHaveLength(2);
		for (const item of items) {
			expect(item.className).toContain("px-3");
			expect(item.querySelector('[data-slot="segmented-control-label"]')?.className).toContain("min-w-0");
		}
	}
});

it("preserves complete labels without ellipsis", () => {
	render(
		<SegmentedControl defaultValue="letter">
			<SegmentedControlItem value="letter">A very long translated paper name</SegmentedControlItem>
			<SegmentedControlItem value="a4">A4</SegmentedControlItem>
		</SegmentedControl>,
	);
	for (const item of screen.getAllByRole("radio")) {
		expect(item.className).toContain("min-w-0");
		expect(item.className).not.toContain("basis-auto");
		expect(item.querySelector('[data-slot="segmented-control-label"]')?.className).not.toContain("truncate");
	}
});

it.each(["ltr", "rtl"] as const)("reserves the widest complete label for every peer before collapsing in %s", (dir) => {
	let measure = () => {};
	vi.stubGlobal(
		"ResizeObserver",
		class {
			constructor(callback: () => void) {
				measure = callback;
			}
			observe() {}
			disconnect() {}
		},
	);
	const { container } = render(
		<SegmentedControl dir={dir} defaultValue="preview">
			<SegmentedControlItem value="preview">
				<Icon name="file-text" />
				المعاينة
			</SegmentedControlItem>
			<SegmentedControlItem value="parsed">
				<Icon name="brackets-curly" />
				النص المستخرج
			</SegmentedControlItem>
		</SegmentedControl>,
	);
	const group = container.querySelector<HTMLElement>('[data-slot="segmented-control"]');
	if (!group) throw new Error("Missing segments");
	const items = [...container.querySelectorAll<HTMLElement>('[data-slot="segmented-control-item"]')];
	const computed = getComputedStyle;
	vi.spyOn(globalThis, "getComputedStyle").mockImplementation(
		(element) =>
			new Proxy(computed(element), {
				get(target, property) {
					if (property === "paddingInlineStart" || property === "paddingInlineEnd")
						return element === group ? "4px" : "12px";
					if (property === "columnGap") return "2px";
					const value = Reflect.get(target, property, target);
					return typeof value === "function" ? value.bind(target) : value;
				},
			}),
	);
	for (const [index, item] of items.entries()) {
		Object.defineProperty(item.querySelector('[data-slot="segmented-control-label"]'), "scrollWidth", {
			value: index === 0 ? 70 : 130,
		});
	}
	// The old sum fits 290px, but two equal peers need 318px including track padding and the gap.
	Object.defineProperty(group, "clientWidth", { value: 290, configurable: true });
	act(measure);
	expect(group).toHaveAttribute("data-icon-only", "true");
	for (const width of [318, 390, 1440]) {
		Object.defineProperty(group, "clientWidth", { value: width, configurable: true });
		act(measure);
		expect(group).not.toHaveAttribute("data-icon-only");
		const equalWidth = (width - 8 - 2) / 2;
		for (const item of items) {
			const label = item.querySelector<HTMLElement>('[data-slot="segmented-control-label"]');
			if (!label) throw new Error("Missing segment label");
			expect(label.scrollWidth + 24).toBeLessThanOrEqual(equalWidth);
		}
	}
});

afterEach(() => {
	cleanup();
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
});
it("falls back to named icons when the complete labels cannot fit and restores them on resize", () => {
	let measure = () => {};
	vi.stubGlobal(
		"ResizeObserver",
		class {
			constructor(callback: () => void) {
				measure = callback;
			}
			observe() {}
			disconnect() {}
		},
	);
	const { container } = render(
		<SegmentedControl defaultValue="light">
			{["light", "dark", "system"].map((value) => (
				<SegmentedControlItem key={value} value={value}>
					<Icon name="sun" />
					<span>{value}</span>
				</SegmentedControlItem>
			))}
		</SegmentedControl>,
	);
	const group = container.querySelector('[data-slot="segmented-control"]');
	if (!group) throw new Error("Missing segments");
	Object.defineProperty(group, "clientWidth", { value: 120, configurable: true });
	for (const label of container.querySelectorAll('[data-slot="segmented-control-label"]'))
		Object.defineProperty(label, "scrollWidth", { value: 80 });
	act(measure);
	expect(group).toHaveAttribute("data-icon-only", "true");
	for (const value of ["light", "dark", "system"]) {
		expect(screen.getByRole("radio", { name: value })).toHaveAttribute("title", value);
	}
	Object.defineProperty(group, "clientWidth", { value: 400 });
	act(measure);
	expect(group).not.toHaveAttribute("data-icon-only");
});
