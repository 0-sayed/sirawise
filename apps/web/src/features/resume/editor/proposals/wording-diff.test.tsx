// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it } from "vite-plus/test";
import { i18n } from "@lingui/core";
import { I18nProvider } from "@lingui/react";
import { WordingDiff } from "./wording-diff";

afterEach(cleanup);

function mount(before: string, after: string, mode: "changes" | "final" = "changes", locale = "en-US") {
	i18n.loadAndActivate({ locale, messages: {} });
	return render(
		<I18nProvider i18n={i18n}>
			<WordingDiff before={before} after={after} mode={mode} locale={locale} />
		</I18nProvider>,
	);
}

it.each([
	["en-US", "Scheduled clinic visits", "Coordinated clinic visits", "Scheduled", "Coordinated", "clinic visits"],
	["ar-SA", "تابعت طلبات الصيانة", "نسقت طلبات الصيانة", "تابعت", "نسقت", "طلبات الصيانة"],
])("isolates only the changed phrases without a legend in %s", (locale, before, after, removed, added, shared) => {
	const { container } = mount(before, after, "changes", locale);
	const text = container.querySelector('p[dir="auto"]');
	expect(text?.querySelector("bdi > del.diff-del")?.textContent).toBe(removed);
	expect(text?.querySelector("bdi > ins.diff-ins")?.textContent).toBe(added);
	expect(text?.querySelectorAll("ins, del")).toHaveLength(2);
	expect(text?.textContent).toContain(shared);
	expect(text).not.toHaveAttribute("aria-describedby");
});

it("shows only proposed text in final mode", () => {
	const { container } = mount("<p>Built services.</p>", "<p>Developed services.</p>", "final");
	expect(container.querySelector('p[dir="auto"]')).toHaveTextContent("Developed services.");
	expect(container.querySelectorAll("del, ins")).toHaveLength(0);
	expect(screen.queryByText(/New wording/)).toBeNull();
});

it("keeps the paragraph RTL when both isolated edits come before unchanged Latin text", () => {
	const { container } = mount("بنيت TypeScript 5.", "طورت TypeScript 5.");
	const paragraph = container.querySelector<HTMLParagraphElement>('p[dir="auto"]');
	expect(paragraph?.style.direction).toBe("rtl");
	expect(paragraph?.querySelector("bdi > ins")).toHaveTextContent("طورت");
});

it("shows a formatting-only passage once and lets the reader reveal spacing", () => {
	const { container } = mount("<p>A  B</p>", "<p>A\nB</p>");
	expect(screen.getByText("Formatting only")).toBeVisible();
	expect(screen.getAllByText("A B")).toHaveLength(1);
	expect(container.querySelectorAll("del, ins")).toHaveLength(0);
	fireEvent.click(screen.getByText("Show spacing"));
	expect(screen.getByText("A··B")).toBeVisible();
	expect(screen.getByText(/A↵.*B/su)).toBeVisible();
});

it("shows spacing inside the paragraph boundaries", () => {
	mount("<p> A</p>", "<p>A </p>");
	fireEvent.click(screen.getByText("Show spacing"));
	expect(screen.getByText("·A")).toBeVisible();
	expect(screen.getByText("A·")).toBeVisible();
});

it("labels and pads punctuation without marking unchanged words", () => {
	const { container } = mount("Reviewed logs and logs.", "Reviewed logs; and logs.");
	expect(screen.getByText("Punctuation only")).toBeVisible();
	expect(container.querySelector("ins.diff-punct")).toHaveTextContent(";");
	expect(screen.queryByText(/New wording/)).toBeNull();
});

it("shows a full rewrite in two labeled blocks", () => {
	const { container } = mount("Led a team and built", "Guided the squad and shipped");
	expect(screen.getByText("Full rewrite")).toBeVisible();
	expect(screen.getByText("Original")).toBeVisible();
	expect(screen.getByText("Proposed")).toBeVisible();
	expect(screen.getByText("Led a team and built")).toHaveAttribute("dir", "auto");
	expect(screen.getByText("Guided the squad and shipped")).toHaveAttribute("dir", "auto");
	expect(container.querySelectorAll("del, ins")).toHaveLength(0);
});
