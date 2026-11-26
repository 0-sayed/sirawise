// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vite-plus/test";
import { i18n } from "@lingui/core";
import { I18nProvider } from "@lingui/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Profiler } from "react";
import { defaultResumeData } from "@reactive-resume/schema/resume/default";
import { SummaryReview } from "./summary-review";

const state = vi.hoisted(() => ({ resume: {} as { id: string; data: unknown } }));
const history = vi.hoisted(() => vi.fn().mockResolvedValue([]));
vi.mock("../builder/draft", () => ({
	useResumeStore: (select: (value: typeof state) => unknown) => select(state),
	savePendingChanges: vi.fn(),
}));
vi.mock("../editor/proposals/review-operation", () => ({
	ReviewLaunch: ({ disabled, children }: { disabled: boolean; children: React.ReactNode }) => (
		<button disabled={disabled}>{children}</button>
	),
	ReviewOperationPanel: ({ operationId }: { operationId: string }) => <output>{operationId}</output>,
}));
vi.mock("./translation-review", () => ({ TranslationReview: () => null }));
vi.mock("@/libs/orpc/client", () => ({
	client: {},
	orpc: { ai: { review: { list: { queryOptions: () => ({ queryKey: ["history"], queryFn: history }) } } } },
}));
vi.mock("@reactive-resume/ui/components/checkbox", () => ({
	// The selection limit belongs to SummaryReview. A button avoids flushing a
	// controlled native input on each event while filling the 49 slots.
	Checkbox: ({
		checked,
		disabled,
		onCheckedChange,
		"aria-label": name,
	}: {
		checked: boolean;
		"aria-label"?: string;
		disabled: boolean;
		onCheckedChange: (checked: boolean) => void;
	}) => (
		<button
			type="button"
			role="checkbox"
			aria-checked={checked}
			aria-label={name}
			aria-disabled={disabled}
			disabled={disabled}
			onClick={() => onCheckedChange(!checked)}
		/>
	),
}));
afterEach(cleanup);

function mount(children: React.ReactNode) {
	return render(
		<I18nProvider i18n={i18n}>
			<QueryClientProvider client={new QueryClient()}>{children}</QueryClientProvider>
		</I18nProvider>,
	);
}

it("restores an older pending summary even when a newer review completed", async () => {
	i18n.loadAndActivate({ locale: "en-US", messages: {} });
	state.resume = { id: "cv", data: structuredClone(defaultResumeData) };
	history.mockResolvedValue([
		{ kind: "review.summary", operationId: "completed-summary", pendingCount: 0 },
		{ kind: "review.summary", operationId: "pending-summary", pendingCount: 1 },
	]);
	const view = mount(<SummaryReview locked={false} />);
	expect(await screen.findByText("pending-summary")).toBeVisible();
	view.unmount();
	mount(<SummaryReview locked={false} />);
	expect(await screen.findByText("pending-summary")).toBeVisible();
});

it("limits summary facts to the payload capacity and lets users replace a selection", () => {
	i18n.loadAndActivate({ locale: "en-US", messages: {} });
	const data = structuredClone(defaultResumeData);
	data.sections.skills.items = Array.from({ length: 50 }, (_, index) => ({
		id: `skill-${index}`,
		hidden: false,
		name: `Skill ${index}`,
		icon: "",
		iconColor: "",
		proficiency: "",
		level: 0,
		keywords: [],
	}));
	state.resume = { id: "cv", data };
	const onRender = vi.fn();
	mount(
		<Profiler id="summary" onRender={onRender}>
			<SummaryReview locked={false} launchOnly />
		</Profiler>,
	);
	const summary = screen.getByText("Facts for summary").closest("details");
	expect(summary).not.toHaveAttribute("open");
	expect(screen.getByRole("button", { name: "Review summary" })).toBeEnabled();
	expect(screen.getByText("49/49")).toBeVisible();
	fireEvent.click(screen.getByText("Facts for summary"));
	expect(screen.getByRole("button", { name: "Skills" })).toBeDefined();
	const filter = screen.getByRole("searchbox", { name: "Filter facts…" });
	fireEvent.change(filter, { target: { value: "Skill 49" } });
	expect(screen.getByText("Skill 49", { selector: "label span" })).toBeDefined();
	expect(screen.queryByText("Skill 0", { selector: "label span" })).toBeNull();
	fireEvent.change(filter, { target: { value: "" } });
	fireEvent.click(screen.getByRole("button", { name: "Clear" }));
	const boxes = screen.getAllByRole("checkbox").filter((box) => !box.hasAttribute("aria-label"));
	expect(boxes).toHaveLength(50);
	const first = boxes[0];
	const last = boxes[49];
	if (!first || !last) throw new Error("Missing summary facts");
	const launch = screen.getByRole("button", { name: "Review summary" });
	expect(launch.hasAttribute("disabled")).toBe(true);
	expect(screen.getByText("Select at least one fact to review your summary.")).toBeDefined();
	fireEvent.click(first);
	expect(launch.hasAttribute("disabled")).toBe(false);
	fireEvent.click(first);
	expect(launch.hasAttribute("disabled")).toBe(true);
	onRender.mockClear();
	// Each input is distinct. Flush the accumulated selection once before checking the limit.
	act(() => {
		for (const box of boxes.slice(0, 49)) fireEvent.click(box);
	});
	expect(onRender).toHaveBeenCalledTimes(1);
	expect(boxes.filter((box) => box.getAttribute("aria-checked") === "true")).toHaveLength(49);
	expect(last.getAttribute("aria-disabled")).toBe("true");
	expect(first.getAttribute("aria-disabled")).not.toBe("true");
	fireEvent.click(first);
	expect(last.getAttribute("aria-disabled")).not.toBe("true");
	fireEvent.click(last);
	expect(boxes.filter((box) => box.getAttribute("aria-checked") === "true")).toHaveLength(49);
});
