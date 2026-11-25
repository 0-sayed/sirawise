// @vitest-environment happy-dom
import type { ReactNode } from "react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vite-plus/test";
import { i18n } from "@lingui/core";
import { I18nProvider } from "@lingui/react";
import { useState } from "react";
import { parseResumeText } from "@reactive-resume/import/plain-text";
import { importDraftGeneration } from "./ai-assistance";
import { ImportAssistance, ExtractionCandidates } from "./ai-assistance-panel";
import { createReviewState } from "./review-draft";

const mocks = vi.hoisted(() => ({ importSource: vi.fn(), result: null as unknown }));
vi.mock("@/libs/orpc/client", () => ({
	client: { ai: { review: { importSource: mocks.importSource } } },
	orpc: { ai: { review: { get: { queryOptions: () => ({}) } } } },
}));
vi.mock("@tanstack/react-query", () => ({ useQuery: () => ({ data: mocks.result }) }));
vi.mock("./assistance-guide", () => ({ ImportAssistanceGuide: () => <p>Selection guide</p> }));
vi.mock("../editor/proposals/review-operation", () => ({
	ReviewNotice: ({ children }: { children: ReactNode }) => <p>{children}</p>,
	ReviewOperationPanel: () => null,
	ReviewLaunch: ({
		id,
		children,
		disabled,
		prepare,
		onStarted,
	}: {
		id?: string;
		children: ReactNode;
		disabled: boolean;
		prepare: () => Promise<unknown>;
		onStarted: (id: string) => void;
	}) => (
		<button
			id={id}
			type="button"
			disabled={disabled}
			onClick={async () => {
				await prepare();
				onStarted("operation");
			}}
		>
			{children}
		</button>
	),
}));

beforeEach(() => {
	vi.clearAllMocks();
	i18n.loadAndActivate({ locale: "en-US", messages: {} });
	mocks.importSource.mockResolvedValue({ source: { kind: "import", id: "selected", revision: "digest" } });
});

const pages = [
	{ page: 1, text: "Sara Example\nEXPERIENCE\nEngineer\nSKILLS\nTypeScript" },
	{ page: 2, text: "SKILLS\nTypeScript\nEDUCATION\nCollege" },
];
function fixture() {
	const state = createReviewState(
		parseResumeText(pages.map((page) => page.text).join("\n\n")),
		"550e8400-e29b-41d4-a716-446655440000",
	);
	const onChange = vi.fn();
	const onSourcePage = vi.fn();
	render(
		<I18nProvider i18n={i18n}>
			<ImportAssistance
				state={state}
				flowId="flow"
				pages={pages}
				partial={false}
				onChange={onChange}
				onSourcePage={onSourcePage}
			/>
		</I18nProvider>,
	);
	fireEvent.click(screen.getByRole("button", { name: "Open text assistance" }));
	return { onChange, onSourcePage };
}
function highlight(text: string, last = false) {
	const field = screen.getByLabelText("Native extracted text — select the uncertain passage") as HTMLTextAreaElement;
	const start = last ? field.value.lastIndexOf(text) : field.value.indexOf(text);
	field.focus();
	field.setSelectionRange(start, start + text.length);
	fireEvent.select(field);
}

it("filters native text when changing section and requires an explicit highlight", () => {
	fixture();
	expect(screen.getByRole("textbox")).toHaveValue("EXPERIENCE\nEngineer\n");
	expect(screen.getByText("Highlight the text you want help with")).toBeVisible();
	expect(screen.getByText("0 characters selected")).toBeVisible();
	expect(screen.getByRole("button", { name: "Review selected text" })).toBeDisabled();
	fireEvent.change(screen.getByLabelText("Section to review"), { target: { value: "skills" } });
	expect(screen.getByRole("textbox")).toHaveValue("SKILLS\nTypeScript\n\nSKILLS\nTypeScript\n");
	highlight("TypeScript", true);
	expect(screen.getByRole("status")).toHaveTextContent("10 characters selected");
	expect(screen.getByRole("button", { name: "Review selected text" })).toBeEnabled();
	fireEvent.change(screen.getByLabelText("Section to review"), { target: { value: "experience" } });
	expect(screen.getByText("0 characters selected")).toBeVisible();
	expect(screen.getByRole("button", { name: "Review selected text" })).toBeDisabled();
});

it("sends only the highlighted passage under the chosen section and maps repeated text to the right PDF page", async () => {
	const { onSourcePage, onChange } = fixture();
	fireEvent.change(screen.getByLabelText("Section to review"), { target: { value: "skills" } });
	highlight("TypeScript", true);
	expect(screen.getByRole("status")).toHaveTextContent("PDF page 2");
	expect(onSourcePage).toHaveBeenLastCalledWith(2);
	fireEvent.click(screen.getByRole("button", { name: "Review selected text" }));
	await waitFor(() => expect(mocks.importSource).toHaveBeenCalledOnce());
	expect(mocks.importSource).toHaveBeenCalledWith(
		expect.objectContaining({ section: "skills", text: "TypeScript", partial: false }),
	);
	await waitFor(() =>
		expect(onChange).toHaveBeenCalledWith(
			expect.objectContaining({ aiReview: expect.objectContaining({ operationId: "operation" }) }),
		),
	);
});

it("explains an absent heading and leaves the full extraction available for manual highlighting", () => {
	fixture();
	fireEvent.change(screen.getByLabelText("Section to review"), { target: { value: "certifications" } });
	expect(screen.getByRole("textbox")).toHaveValue(pages.map((page) => page.text).join("\n\n"));
	expect(
		screen.getByText("No heading was found for this section. Highlight the relevant text in the full extraction."),
	).toBeVisible();
	expect(screen.getByRole("button", { name: "Review selected text" })).toBeDisabled();
});

it("groups skills, preselects their entry, applies all only on approval and undoes one", async () => {
	const state = createReviewState(
		parseResumeText("Sara Example\nSKILLS\nAI-Assisted Development"),
		"550e8400-e29b-41d4-a716-446655440000",
	);
	const entry = state.data.sections.skills.items[0];
	if (!entry) throw new Error("Missing skills fixture");
	const source = { kind: "import" as const, id: "source", revision: "digest" };
	const result = {
		schemaVersion: 2 as const,
		kind: "extraction" as const,
		sourceRevision: source,
		evidence: [],
		questions: [],
		candidates: ["Codex", "Claude Code"].map((value, n) => ({
			id: `skill-${n}`,
			section: "skills" as const,
			entityId: `skill-${n}`,
			field: "name" as const,
			value,
			rawDateText: null,
			evidenceIds: ["e1"],
			confirmation: "needs_review" as const,
		})),
	};
	state.aiReview = {
		version: 1,
		source,
		operationId: "op",
		result,
		draftGeneration: importDraftGeneration(state.data),
		appliedCandidateIds: [],
	};
	mocks.result = { result };
	const changed = vi.fn();
	function Review() {
		const [draft, setDraft] = useState(state);
		return (
			<ExtractionCandidates
				state={draft}
				onChange={(next) => {
					setDraft(next);
					changed(next);
				}}
			/>
		);
	}
	render(
		<I18nProvider i18n={i18n}>
			<Review />
		</I18nProvider>,
	);
	expect(screen.getAllByLabelText("Add to which entry?")).toHaveLength(1);
	expect(screen.getByLabelText("Add to which entry?")).toHaveValue(entry.id);
	expect(changed).not.toHaveBeenCalled();
	fireEvent.click(screen.getByRole("button", { name: "Use all in draft" }));
	expect(changed.mock.calls.at(-1)?.[0].data.sections.skills.items[0].keywords).toEqual(["Codex", "Claude Code"]);
	fireEvent.click(screen.getAllByRole("button", { name: "Undo this item" })[0] as HTMLElement);
	expect(changed.mock.calls.at(-1)?.[0].data.sections.skills.items[0].keywords).toEqual(["Claude Code"]);
});
