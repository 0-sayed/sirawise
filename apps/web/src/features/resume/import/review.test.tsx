import type { ReviewState } from "./review-draft";
// @vitest-environment happy-dom
import { fireEvent, render, screen, waitFor, act, within } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vite-plus/test";
import { i18n } from "@lingui/core";
import { I18nProvider } from "@lingui/react";
import { ORPCError } from "@orpc/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { buildCareerFactCandidates } from "@reactive-resume/import/career-facts";
import { parseResumeText, type ImportReviewIssue } from "@reactive-resume/import/plain-text";
import { defaultResumeData } from "@reactive-resume/schema/resume/default";
import { Dialog, DialogContent } from "@reactive-resume/ui/components/dialog";
import { ImportReview } from "./review";
import { createReviewState } from "./review-draft";
import { ConfirmDialogProvider } from "@/hooks/use-confirm";
import { loadUiLocale } from "@/libs/locale";
vi.mock("./ai-assistance-panel", () => ({
	ImportAssistance: () => <button type="button">Synthetic assistance action</button>,
}));
const mocks = vi.hoisted(() => ({ read: vi.fn(), confirm: vi.fn(), list: vi.fn(), get: vi.fn() }));
vi.mock("@/features/settings/integrations/hooks/use-has-usable-ai-provider", () => ({
	useHasUsableAiProvider: () => ({ hasUsableProvider: false }),
}));
vi.mock("@/libs/orpc/client", () => ({
	client: {
		career: { master: { read: mocks.read } },
		resume: { confirmImport: mocks.confirm, list: mocks.list, getById: mocks.get },
	},
}));
beforeEach(() => {
	vi.resetAllMocks();
	mocks.list.mockResolvedValue([{ id: "existing", name: "My CV", variantKind: "base" }]);
	i18n.loadAndActivate({ locale: "en-US", messages: {} });
});

it("recovers from the base CV limit with confirmed facts only and keeps the review", async () => {
	mocks.read.mockResolvedValue({ profileRevision: 0, facts: [] });
	mocks.confirm
		.mockRejectedValueOnce(new ORPCError("PRECONDITION_FAILED", { data: { reason: "BASE_CV_LIMIT" } }))
		.mockResolvedValueOnce({ resumeId: null, profileRevision: 1 });
	const checkpoint = vi.fn().mockResolvedValue(undefined);
	importedReview(vi.fn(), { onCheckpoint: checkpoint });
	fireEvent.click(screen.getByRole("button", { name: "Confirm all remaining" }));
	fireEvent.click(saveButton());
	await screen.findByText(
		"Your plan includes 1 base CV. Replace your existing base CV, save only confirmed facts to Career information, or open your existing CV. Your review is kept.",
	);
	fireEvent.click(screen.getByRole("button", { name: "Save confirmed facts only" }));
	await screen.findByText("Confirmed facts saved to Career information. Your existing CV and import review are kept.");
	expect(mocks.confirm.mock.calls[1]?.[0]).toMatchObject({
		destination: { kind: "career" },
		acceptedFacts: expect.any(Array),
	});
	expect(mocks.confirm.mock.calls[1]?.[0].acceptedFacts.length).toBeGreaterThan(0);
	expect(screen.getByRole("navigation", { name: "Review sections" })).toBeVisible();
	expect(checkpoint).toHaveBeenCalled();
});

it("requires explicit approval before replacing the selected base CV", async () => {
	mocks.read.mockResolvedValue({ profileRevision: 0, facts: [] });
	mocks.confirm
		.mockRejectedValueOnce(new ORPCError("PRECONDITION_FAILED", { data: { reason: "BASE_CV_LIMIT" } }))
		.mockResolvedValueOnce({ resumeId: "existing", profileRevision: 0 });
	const updatedAt = new Date("2026-11-21T00:00:00Z");
	mocks.get.mockResolvedValue({ id: "existing", name: "My CV", updatedAt });
	importedReview();
	fireEvent.click(saveButton());
	await waitFor(() => expect(screen.getByRole("button", { name: "Replace existing base CV" })).toBeEnabled());
	fireEvent.click(screen.getByRole("button", { name: "Replace existing base CV" }));
	const dialog = await screen.findByRole("alertdialog");
	expect(mocks.confirm).toHaveBeenCalledOnce();
	fireEvent.click(within(dialog).getByRole("button", { name: "Replace existing base CV" }));
	await waitFor(() => expect(mocks.confirm).toHaveBeenCalledTimes(2));
	expect(mocks.confirm.mock.calls[1]?.[0]).toMatchObject({
		destination: { kind: "replace", resumeId: "existing", expectedUpdatedAt: updatedAt.toISOString() },
	});
});

it("requires review after an edit and preserves the CV-only choice when replacing a base CV", async () => {
	mocks.read.mockResolvedValue({ profileRevision: 0, facts: [] });
	mocks.confirm
		.mockRejectedValueOnce(new ORPCError("PRECONDITION_FAILED", { data: { reason: "BASE_CV_LIMIT" } }))
		.mockResolvedValueOnce({ resumeId: "existing", profileRevision: 0 });
	mocks.get.mockResolvedValue({ id: "existing", name: "My CV", updatedAt: new Date("2026-11-21T00:00:00Z") });
	importedReview(vi.fn(), { pages: [{ page: 1, text: "Sara Example" }], issues: () => [] });
	fireEvent.click(screen.getByRole("button", { name: "Confirm all remaining" }));
	fireEvent.click(screen.getByRole("button", { name: "Create CV only" }));
	const replace = await screen.findByRole("button", { name: "Replace existing base CV" });
	await waitFor(() => expect(replace).toBeEnabled());
	fireEvent.change(screen.getByLabelText("Full name"), { target: { value: "Sara Edited" } });
	expect(replace).toBeDisabled();
	fireEvent.click(screen.getByRole("button", { name: "Confirm section" }));
	fireEvent.click(replace);
	const dialog = await screen.findByRole("alertdialog");
	fireEvent.click(within(dialog).getByRole("button", { name: "Replace existing base CV" }));
	await waitFor(() => expect(mocks.confirm).toHaveBeenCalledTimes(2));
	expect(mocks.confirm.mock.calls[1]?.[0]).toMatchObject({
		name: "Sara Edited",
		destination: { kind: "replace", resumeId: "existing" },
		acceptedFacts: [],
	});
});
vi.mock("./source-preview", () => ({ SourcePreview: () => <div>PDF fixture</div> }));
const flowId = "550e8400-e29b-41d4-a716-446655440000";
const saveButton = () => screen.getByRole("button", { name: /^Create CV (?:only|and save career information)$/ });

function importedReview(
	onBack = vi.fn(),
	options: {
		state?: ReviewState;
		initial?: ReturnType<typeof parseResumeText>;
		partial?: boolean;
		onCheckpoint?: (state: ReviewState) => Promise<void>;
		file?: File;
		pages?: { page: number; text: string }[];
		issues?: (initial: ReturnType<typeof parseResumeText>) => ImportReviewIssue[];
	} = {},
) {
	const initial =
		options.initial ??
		parseResumeText("Sara Example\nEXPERIENCE\nExample Labs | Engineer | 2024-07 – Present\nSKILLS\nTypeScript");
	return render(
		<I18nProvider i18n={i18n}>
			<div dir={i18n.locale === "ar-SA" ? "rtl" : "ltr"}>
				<QueryClientProvider client={new QueryClient()}>
					<ConfirmDialogProvider>
						<ImportReview
							{...options}
							initial={initial}
							flowId={flowId}
							issues={
								options.issues?.(initial) ?? [
									{ field: "position", source: "Engineer", section: "experience", entryIndex: 0 },
								]
							}
							onBack={onBack}
							onSaved={() => {}}
						/>
					</ConfirmDialogProvider>
				</QueryClientProvider>
			</div>
		</I18nProvider>,
	);
}
it("confirms uncertain fields directly and keeps section review available", () => {
	importedReview();
	expect(screen.getByRole("status", { name: "Review progress" })).toHaveTextContent("0 of 3 sections reviewed");
	fireEvent.click(
		within(screen.getByRole("navigation", { name: "Review sections" })).getByRole("button", { name: /^Experience/ }),
	);
	const entry = screen.getByRole("article", { name: /Engineer/ });
	expect(within(entry).getByText("Position").closest("div")).toHaveAttribute("data-uncertain", "true");
	expect(within(entry).getByRole("button", { name: "Confirm" })).toBeVisible();
	fireEvent.click(within(entry).getByRole("button", { name: "Confirm" }));
	expect(within(entry).queryByText("Please confirm this information")).not.toBeInTheDocument();
	fireEvent.click(screen.getByRole("button", { name: "Confirm all remaining" }));
	expect(screen.getByRole("status", { name: "Review progress" })).toHaveTextContent("3 of 3 sections reviewed");
	expect(screen.getByRole("article", { name: /Engineer/ })).toBeVisible();
});

it.each(["ar-SA", "en-US"] as const)(
	"keeps entry confirmation primary until each entry is reviewed in %s",
	async (locale) => {
		await loadUiLocale(locale);
		const arabic = locale === "ar-SA";
		importedReview(vi.fn(), {
			initial: parseResumeText(
				"Sara Example\nEXPERIENCE\nExample Labs | Engineer | 2024-07 – Present\nOther Labs | Designer | 2022-01 – 2024-06",
			),
			issues: () => [],
		});
		fireEvent.click(
			within(screen.getByRole("navigation", { name: arabic ? "أقسام المراجعة" : "Review sections" })).getByRole(
				"button",
				{ name: arabic ? "الخبرة" : /^Experience/ },
			),
		);
		const sectionConfirm = screen.getByRole("button", { name: arabic ? "تأكيد القسم" : "Confirm section" });
		const entries = screen.getAllByRole("article");
		expect(entries).toHaveLength(2);
		expect(sectionConfirm).toHaveAttribute("data-variant", "secondary");
		for (const [index, entry] of entries.entries()) {
			const confirm = within(entry).getByRole("button", { name: arabic ? "تأكيد العنصر" : "Confirm entry" });
			expect(confirm).toHaveAttribute("data-variant", "primary");
			expect(entry.querySelectorAll('button[data-variant="primary"]')).toHaveLength(1);
			fireEvent.click(confirm);
			expect(within(entry).getByRole("button", { name: arabic ? "مؤكد" : "Confirmed" })).toHaveAttribute(
				"data-variant",
				"ghost",
			);
			expect(entry.querySelectorAll('button[data-variant="primary"]')).toHaveLength(0);
			if (index === 0) expect(sectionConfirm).toHaveAttribute("data-variant", "secondary");
		}
		expect(sectionConfirm).toHaveAttribute("data-variant", "ghost");
		expect(sectionConfirm).toHaveTextContent(arabic ? "مؤكد" : "Confirmed");
	},
);

it.each(["basics", "summary"] as const)("makes %s section confirmation primary until reviewed", (section) => {
	const initial = structuredClone(defaultResumeData);
	initial.basics.name = "Sara Example";
	initial.summary.content = "<p>Synthetic summary</p>";
	importedReview(vi.fn(), { initial, issues: () => [] });
	if (section === "summary") {
		fireEvent.click(
			within(screen.getByRole("navigation", { name: "Review sections" })).getByRole("button", { name: /^Summary/ }),
		);
	}
	const confirm = screen.getByRole("button", { name: "Confirm section" });
	expect(confirm).toHaveAttribute("data-variant", "primary");
	fireEvent.click(confirm);
	expect(confirm).toHaveAttribute("data-variant", "ghost");
	expect(confirm).toHaveTextContent("Confirmed");
});

it.each(["section", "entry"] as const)(
	"saves the exact candidate facts after confirming every %s in the real review",
	async (mode) => {
		mocks.read.mockResolvedValue({ profileRevision: 0, facts: [] });
		mocks.confirm.mockResolvedValue({ resumeId: "created" });
		const initial = parseResumeText(
			"Sara Example\nEXPERIENCE\nExample Labs | Engineer | 2024-07 – Present\nSKILLS\nTypeScript",
		);
		const expected = buildCareerFactCandidates(initial, { kind: "manual", id: flowId, quote: "" });
		expect(expected.length).toBeGreaterThan(0);
		importedReview(vi.fn(), { initial });
		const navigation = screen.getByRole("navigation", { name: "Review sections" });
		fireEvent.click(screen.getByRole("button", { name: "Confirm section" }));
		for (const section of [/^Experience/, /^Skills/]) {
			fireEvent.click(within(navigation).getByRole("button", { name: section }));
			if (mode === "section") fireEvent.click(screen.getByRole("button", { name: "Confirm section" }));
			else if (mode === "entry") fireEvent.click(screen.getByRole("button", { name: "Confirm entry" }));
		}
		fireEvent.click(saveButton());
		await waitFor(() => expect(mocks.confirm).toHaveBeenCalledOnce());
		const accepted = mocks.confirm.mock.calls[0]?.[0].acceptedFacts;
		expect(accepted).toHaveLength(expected.length);
		expect(
			accepted.map(({ fact, decision }: { fact: { source: unknown }; decision: unknown }) => ({
				...fact,
				source: { kind: "manual", id: flowId, quote: "" },
				decision,
			})),
		).toEqual(expected.map((fact) => ({ ...fact, decision: { kind: "new" } })));
	},
);

it("saves a fact when the user confirms its import warning without confirming the whole entry", async () => {
	mocks.read.mockResolvedValue({ profileRevision: 0, facts: [] });
	mocks.confirm.mockResolvedValue({ resumeId: "created" });
	importedReview();
	fireEvent.click(
		within(screen.getByRole("navigation", { name: "Review sections" })).getByRole("button", { name: /^Experience/ }),
	);
	fireEvent.click(within(screen.getByRole("article", { name: /Engineer/ })).getByRole("button", { name: "Confirm" }));
	fireEvent.click(saveButton());
	await waitFor(() => expect(mocks.confirm).toHaveBeenCalledOnce());
	expect(mocks.confirm.mock.calls[0]?.[0].acceptedFacts).toEqual([
		{
			fact: expect.objectContaining({ section: "experience", field: "position", value: "Engineer" }),
			decision: { kind: "new" },
		},
	]);
});

it("names whether creating the CV also saves career information", () => {
	importedReview();
	expect(screen.getByRole("button", { name: "Create CV only" })).toBeVisible();
	fireEvent.click(
		within(screen.getByRole("navigation", { name: "Review sections" })).getByRole("button", { name: /^Experience/ }),
	);
	fireEvent.click(screen.getByRole("button", { name: "Confirm entry" }));
	expect(screen.getByRole("button", { name: "Create CV and save career information" })).toBeVisible();
	fireEvent.click(screen.getByRole("button", { name: "Edit" }));
	fireEvent.change(screen.getByLabelText("Position"), { target: { value: "Senior Engineer" } });
	expect(screen.getByRole("button", { name: "Create CV only" })).toBeVisible();
});

it("clears an uncertainty after the user corrects or confirms the field", async () => {
	importedReview();
	fireEvent.click(screen.getByRole("button", { name: "Review now" }));
	const target = await screen.findByRole("textbox", { name: "Position" });
	await waitFor(() => expect(target).toBe(document.activeElement));
	fireEvent.change(target, { target: { value: "Senior Engineer" } });
	expect(screen.queryByText("Please confirm this information")).not.toBeInTheDocument();
});

it("confirms an uncertain basic field", () => {
	importedReview(vi.fn(), {
		issues: () => [{ field: "location", source: "Cairo, Egypt", section: "basics" }],
	});
	expect(screen.getByRole("button", { name: "Confirm" })).toBeVisible();
	fireEvent.click(screen.getByRole("button", { name: "Confirm" }));
	expect(screen.queryByText("Please confirm this information")).not.toBeInTheDocument();
});

it("includes confirmed uncertainty resolutions in its saved review state", async () => {
	let saved: ReviewState | undefined;
	importedReview(vi.fn(), {
		issues: () => [{ field: "location", source: "Cairo, Egypt", section: "basics" }],
		onCheckpoint: async (state) => {
			saved = state;
		},
	});
	fireEvent.click(screen.getByRole("button", { name: "Confirm" }));
	await waitFor(() => expect(saved?.resolvedIssues).toEqual({ 0: true }));
});

it("shows and opens the first unresolved import issue", async () => {
	importedReview(vi.fn(), {
		issues: () => [
			{ field: "name", source: "Sara Example", section: "basics" },
			{ field: "position", source: "Engineer", section: "experience", entryIndex: 0 },
		],
	});
	fireEvent.click(screen.getByRole("button", { name: "Review now" }));
	const firstConfirmation = screen.getAllByRole("button", { name: "Confirm" })[0];
	if (!firstConfirmation) throw new Error("Expected a confirmation button");
	fireEvent.click(firstConfirmation);
	expect(screen.getByText("Engineer")).toBeInTheDocument();
	expect(screen.queryByText("Sara Example", { selector: "li span" })).not.toBeInTheDocument();
	fireEvent.click(screen.getByRole("button", { name: "Review now" }));
	expect(
		within(screen.getByRole("navigation", { name: "Review sections" })).getByRole("button", { name: /^Experience/ }),
	).toHaveAttribute("aria-current", "step");
});
it("routes and resolves a legacy experience issue without saved section or entry indexes", async () => {
	let saved: ReviewState | undefined;
	importedReview(vi.fn(), {
		issues: () => [{ field: "position", source: "Engineer" }],
		onCheckpoint: async (state) => {
			saved = state;
		},
	});
	fireEvent.click(screen.getByRole("button", { name: "Review now" }));
	const experience = within(screen.getByRole("navigation", { name: "Review sections" })).getByRole("button", {
		name: /^Experience/,
	});
	expect(experience).toHaveAttribute("aria-current", "step");
	const entry = screen.getByRole("article", { name: /Engineer/ });
	expect(within(entry).getByText("Please confirm this information")).toBeVisible();
	fireEvent.click(within(entry).getByRole("button", { name: "Confirm" }));
	expect(within(entry).queryByText("Please confirm this information")).not.toBeInTheDocument();
	await waitFor(() => expect(saved?.resolvedIssues).toEqual({ 0: true }));
});
it("invalidates review after editing and removes entries from the submitted CV", async () => {
	mocks.read.mockResolvedValue({ profileRevision: 0, facts: [] });
	mocks.confirm.mockResolvedValue({ resumeId: "created" });
	importedReview();
	fireEvent.click(
		within(screen.getByRole("navigation", { name: "Review sections" })).getByRole("button", { name: /^Experience/ }),
	);
	fireEvent.click(screen.getByRole("button", { name: "Confirm section" }));
	fireEvent.click(screen.getByRole("button", { name: "Edit" }));
	fireEvent.change(screen.getByLabelText("Position"), { target: { value: "Senior Engineer" } });
	expect(screen.getByRole("status", { name: "Review progress" })).toHaveTextContent("0 of 3 sections reviewed");
	fireEvent.click(screen.getByRole("button", { name: "Remove" }));
	expect(screen.getByRole("status", { name: "Review progress" })).toHaveTextContent("0 of 2 sections reviewed");
	fireEvent.click(saveButton());
	await waitFor(() => expect(mocks.confirm).toHaveBeenCalledTimes(1));
	expect(mocks.confirm.mock.calls[0]?.[0].data.sections.experience.items).toEqual([]);
	expect(mocks.confirm.mock.calls[0]?.[0].acceptedFacts).toEqual([]);
});
it("cancel performs no server write", () => {
	const cancel = vi.fn();
	importedReview(cancel);
	fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
	expect(cancel).toHaveBeenCalledOnce();
	expect(mocks.confirm).not.toHaveBeenCalled();
});
it("disables assistance while the final import confirmation is pending", async () => {
	mocks.read.mockResolvedValue({ profileRevision: 0, facts: [] });
	mocks.confirm.mockImplementation(() => new Promise(() => {}));
	importedReview(vi.fn(), { pages: [{ page: 1, text: "Synthetic source" }] });
	expect(saveButton()).toBeDisabled();
	fireEvent.click(screen.getByRole("button", { name: "Confirm all remaining" }));
	fireEvent.click(
		within(screen.getByRole("navigation", { name: "Review sections" })).getByRole("button", { name: "Experience" }),
	);
	fireEvent.click(screen.getByRole("button", { name: "Confirm section" }));
	fireEvent.click(screen.getByRole("button", { name: "Create CV and save career information" }));
	await waitFor(() => expect(mocks.confirm).toHaveBeenCalledOnce());
	expect(screen.getByRole("button", { name: "Synthetic assistance action" })).toBeDisabled();
});
it("requires individual section review for a partially read file instead of offering a no-op bulk action", () => {
	importedReview(vi.fn(), { partial: true });
	expect(screen.getByRole("button", { name: "Confirm all remaining" })).toBeDisabled();
	expect(
		screen.getByText(
			"Only part of this file could be read. Review every section and add missing information before saving.",
		),
	).toBeVisible();
	fireEvent.click(screen.getByRole("button", { name: "Confirm section" }));
	expect(screen.getByRole("status", { name: "Review progress" })).toHaveTextContent("1 of 3 sections reviewed");
});
it("opens the first flagged field when the user chooses Review now", async () => {
	importedReview();
	const scrollIntoView = vi.fn();
	HTMLElement.prototype.scrollIntoView = scrollIntoView;
	fireEvent.click(screen.getByRole("button", { name: "Review now" }));
	const experience = within(screen.getByRole("navigation", { name: "Review sections" })).getByRole("button", {
		name: /^Experience/,
	});
	await waitFor(() => expect(experience).toHaveAttribute("aria-current", "step"));
	const flagged = screen.getByRole("textbox", { name: "Position" });
	await waitFor(() => expect(flagged).toBe(document.activeElement));
	expect(screen.getByText("Please confirm this information")).toBeVisible();
	expect(scrollIntoView).toHaveBeenCalled();
});
it("opens the matching experience entry for an uncertain experience location", async () => {
	const scrollIntoView = vi.fn();
	HTMLElement.prototype.scrollIntoView = scrollIntoView;
	importedReview(vi.fn(), {
		issues: (_initial) => [
			{
				field: "location",
				source: "Unclear location",
				section: "experience",
				entryIndex: 0,
			},
		],
	});
	fireEvent.click(screen.getByRole("button", { name: "Review now" }));
	const experience = within(screen.getByRole("navigation", { name: "Review sections" })).getByRole("button", {
		name: /^Experience/,
	});
	await waitFor(() => expect(experience).toHaveAttribute("aria-current", "step"));
	const flagged = document.querySelector('[data-import-entry] [data-entry-field="location"]');
	await waitFor(() => expect(flagged).toBe(document.activeElement));
});
it("uses the Arabic please-confirm copy for flagged values", async () => {
	await loadUiLocale("ar-SA");
	importedReview();
	fireEvent.click(
		within(screen.getByRole("navigation", { name: "أقسام المراجعة" })).getByRole("button", { name: "الخبرة" }),
	);
	expect(screen.getByText("يرجى تأكيد هذه المعلومة")).toBeVisible();
});
it("keeps earlier AI fields highlighted until the entry is reviewed", () => {
	const initial = parseResumeText(
		"Sara Example\nEXPERIENCE\nExample Labs | Engineer | 2024-07 – Present\nImproved testing.",
	);
	const entry = initial.sections.experience.items[0];
	if (!entry) throw new Error("Missing import entry");
	importedReview(vi.fn(), {
		initial,
		issues: () => [],
		pages: [{ page: 1, text: "Synthetic source" }],
		state: {
			...createReviewState(initial, flowId),
			aiReview: {
				version: 1,
				operationId: "second-review",
				source: { kind: "import", id: "source", revision: "revision" },
				result: null,
				draftGeneration: "generation",
				appliedCandidateIds: [],
				earlierFieldKeys: [`experience:${entry.id}:description`],
			},
		},
	});
	fireEvent.click(screen.getByRole("button", { name: "Confirm all remaining" }));
	expect(saveButton()).toBeDisabled();
	fireEvent.click(
		within(screen.getByRole("navigation", { name: "Review sections" })).getByRole("button", { name: "Experience" }),
	);
	expect(screen.getByText("Review this suggested field")).toBeVisible();
	fireEvent.click(screen.getByRole("button", { name: "Confirm section" }));
	expect(screen.queryByText("Review this suggested field")).toBeNull();
	expect(screen.getByRole("button", { name: "Create CV only" })).toBeEnabled();
});
it("keeps an identical confirmation payload after an unknown outcome", async () => {
	mocks.read.mockResolvedValue({ profileRevision: 0, facts: [] });
	mocks.confirm.mockRejectedValueOnce(new Error("Connection lost")).mockResolvedValueOnce({ resumeId: "created" });
	importedReview();
	fireEvent.click(screen.getByRole("button", { name: "Confirm all remaining" }));
	fireEvent.click(saveButton());
	await screen.findByRole("alert");
	fireEvent.click(saveButton());
	await waitFor(() => expect(mocks.confirm).toHaveBeenCalledTimes(2));
	expect(mocks.confirm.mock.calls[1]?.[0]).toEqual(mocks.confirm.mock.calls[0]?.[0]);
});
it("restores edits, section progress and the exact retry payload after a page refresh", async () => {
	mocks.read.mockResolvedValue({ profileRevision: 0, facts: [] });
	mocks.confirm.mockRejectedValueOnce(new Error("Connection lost")).mockResolvedValueOnce({ resumeId: "created" });
	let checkpoint: ReviewState | undefined;
	const onCheckpoint = async (state: ReviewState) => {
		checkpoint = structuredClone(state);
	};
	const first = importedReview(vi.fn(), { onCheckpoint });
	fireEvent.change(screen.getByLabelText("Full name"), { target: { value: "Reviewed English name" } });
	fireEvent.click(screen.getByRole("button", { name: "Confirm all remaining" }));
	fireEvent.click(saveButton());
	await screen.findByRole("alert");
	expect(checkpoint?.submission).toEqual(mocks.confirm.mock.calls[0]?.[0]);
	if (!checkpoint) throw new Error("Missing persisted review checkpoint");
	first.unmount();
	importedReview(vi.fn(), { state: checkpoint, onCheckpoint });
	expect(screen.getByLabelText("Full name")).toHaveValue("Reviewed English name");
	expect(screen.getByRole("status", { name: "Review progress" })).toHaveTextContent("2 of 3 sections reviewed");
	expect(screen.getByLabelText("Full name")).toBeDisabled();
	fireEvent.click(saveButton());
	await waitFor(() => expect(mocks.confirm).toHaveBeenCalledTimes(2));
	expect(mocks.read).toHaveBeenCalledTimes(1);
	expect(mocks.confirm.mock.calls[1]?.[0]).toEqual(mocks.confirm.mock.calls[0]?.[0]);
});
it("does not send confirmation until its exact retry payload is durably checkpointed", async () => {
	mocks.read.mockResolvedValue({ profileRevision: 0, facts: [] });
	const onCheckpoint = vi.fn(async (state: ReviewState) => {
		if (state.submission) throw new Error("Storage unavailable");
	});
	importedReview(vi.fn(), { onCheckpoint });
	fireEvent.click(saveButton());
	await screen.findByRole("alert");
	expect(mocks.confirm).not.toHaveBeenCalled();
	expect(onCheckpoint.mock.calls.some(([state]) => !!state.submission)).toBe(true);
});
it.each(["ar-SA", "en-US"])("isolates imported English values in %s", (locale) => {
	i18n.loadAndActivate({ locale, messages: {} });
	importedReview();
	expect(screen.getByLabelText("Full name")).toHaveAttribute("dir", "auto");
	fireEvent.click(
		within(screen.getByRole("navigation", { name: "Review sections" })).getByRole("button", { name: /^Experience/ }),
	);
	expect(screen.getByText("Engineer", { selector: "dd" })).toHaveAttribute("dir", "auto");
});

it.each(["en-US", "ar-SA"])("keeps phone grouping and LTR display in %s review", (locale) => {
	i18n.loadAndActivate({ locale, messages: {} });
	const initial = structuredClone(defaultResumeData);
	initial.basics.phone = "+20 101 234 5678";
	render(
		<I18nProvider i18n={i18n}>
			<div dir={locale === "ar-SA" ? "rtl" : "ltr"}>
				<ConfirmDialogProvider>
					<Dialog open>
						<DialogContent>
							<ImportReview initial={initial} flowId={flowId} onBack={() => {}} onSaved={() => {}} />
						</DialogContent>
					</Dialog>
				</ConfirmDialogProvider>
			</div>
		</I18nProvider>,
	);
	const phone = screen.getByLabelText("Phone");
	expect(phone).toHaveValue("+20 101 234 5678");
	expect(phone).toHaveAttribute("type", "tel");
	expect(phone).toHaveAttribute("dir", "ltr");
});

it("shows uncertain source fields and ongoing dates in the review", () => {
	const initial = parseResumeText("EXPERIENCE\nExample Labs | Engineer | 2024-07 – Present");
	render(
		<I18nProvider i18n={i18n}>
			<ConfirmDialogProvider>
				<Dialog open>
					<DialogContent>
						<ImportReview
							initial={initial}
							flowId={flowId}
							issues={[{ field: "position", source: "Ambiguous source field" }]}
							onBack={() => {}}
							onSaved={() => {}}
						/>
					</DialogContent>
				</Dialog>
			</ConfirmDialogProvider>
		</I18nProvider>,
	);
	expect(screen.getByText("Ambiguous source field")).toBeVisible();
	fireEvent.click(
		within(screen.getByRole("navigation", { name: "Review sections" })).getByRole("button", { name: /^Experience/ }),
	);
	expect(screen.getAllByText("Jul 2024 – Present")[0]).toBeInTheDocument();
});
function review(onSaved = vi.fn()) {
	return render(
		<I18nProvider i18n={i18n}>
			<ConfirmDialogProvider>
				<Dialog open>
					<DialogContent>
						<ImportReview
							initial={structuredClone(defaultResumeData)}
							flowId={flowId}
							onBack={() => {}}
							onSaved={onSaved}
						/>
					</DialogContent>
				</Dialog>
			</ConfirmDialogProvider>
		</I18nProvider>,
	);
}
it("does not navigate when a dismissed confirmation completes", async () => {
	mocks.read.mockResolvedValue({ profileRevision: 0, facts: [] });
	let complete!: (result: { resumeId: string }) => void;
	mocks.confirm.mockReturnValue(
		new Promise((resolve) => {
			complete = resolve;
		}),
	);
	const saved = vi.fn();
	const first = review(saved);
	fireEvent.click(saveButton());
	await waitFor(() => expect(mocks.confirm).toHaveBeenCalledTimes(1));
	first.unmount();
	review();
	fireEvent.change(screen.getByLabelText("Full name"), { target: { value: "New flow" } });
	await act(async () => {
		complete({ resumeId: "obsolete" });
	});
	expect(saved).not.toHaveBeenCalled();
	expect(screen.getByLabelText("Full name")).toHaveValue("New flow");
});
it("reconciles a rejected master revision without replacing local corrections or accepting changed facts", async () => {
	const structured = {
		section: "skills",
		entityId: "skill-1",
		field: "name",
		value: "Original skill",
		source: { kind: "manual", id: "source", quote: "" },
	};
	const fact = {
		id: "fact-1",
		text: "",
		source: structured.source,
		status: "",
		structured,
		confirmation: "confirmed",
		revision: 1,
		draftRevision: 0,
	};
	mocks.read.mockResolvedValueOnce({ profileRevision: 1, facts: [fact] }).mockResolvedValueOnce({
		profileRevision: 2,
		facts: [{ ...fact, structured: { ...structured, value: "Changed elsewhere" }, revision: 2 }],
	});
	mocks.confirm
		.mockRejectedValueOnce(new ORPCError("IMPORT_REVIEW_CONFLICT", { status: 409 }))
		.mockResolvedValueOnce({ resumeId: "saved" });
	review();
	fireEvent.click(screen.getByRole("button", { name: "Use confirmed career information" }));
	fireEvent.click(
		await within(screen.getByRole("navigation", { name: "Review sections" })).findByRole("button", { name: /^Skills/ }),
	);
	expect(screen.getByText("Original skill", { selector: "dd" })).toBeVisible();
	fireEvent.click(screen.getByRole("button", { name: /^Basic information/ }));
	fireEvent.change(screen.getByLabelText("Full name"), { target: { value: "Local correction" } });
	fireEvent.click(saveButton());
	await screen.findByRole("alert");
	fireEvent.click(screen.getByRole("button", { name: "Refresh career information for review" }));
	await waitFor(() => expect(saveButton()).toBeEnabled());
	expect(screen.getByLabelText("Full name")).toHaveValue("Local correction");
	fireEvent.click(
		within(screen.getByRole("navigation", { name: "Review sections" })).getByRole("button", { name: /^Skills/ }),
	);
	expect(screen.getByText("Original skill", { selector: "dd" })).toBeVisible();
	fireEvent.click(saveButton());
	await waitFor(() => expect(mocks.confirm).toHaveBeenCalledTimes(2));
	expect(mocks.confirm.mock.calls[1]?.[0]).toMatchObject({
		expectedProfileRevision: 2,
		acceptedFacts: [],
		data: { basics: { name: "Local correction" } },
	});
	expect(mocks.confirm.mock.calls[1]?.[0].flowId).not.toBe(flowId);
});

it("gives partial extraction a titled warning and a visible review recovery action", () => {
	importedReview(vi.fn(), { partial: true });
	const notice = screen.getByText(/Only part of this file/).closest('[data-slot="alert"]') as HTMLElement;
	expect(notice.querySelector('[data-slot="alert-title"]')).toHaveTextContent("Review imported information");
	expect(within(notice).getByRole("button", { name: "Review now" })).toBeEnabled();
});

it.each(["en-US", "ar-SA"])("places information before the source in DOM and tabs for %s", (locale) => {
	i18n.loadAndActivate({ locale, messages: {} });
	importedReview(vi.fn(), { file: new File(["pdf"], "fixture.pdf") });
	const panels = screen.getAllByRole("tabpanel");
	expect(panels.map((panel) => panel.id.endsWith("-information"))).toEqual([true, false]);
	expect(screen.getAllByRole("tab")[0]).toHaveTextContent("Extracted information");
});
it("keeps source navigation quiet and opens the original page", () => {
	importedReview(vi.fn(), { file: new File(["pdf"], "fixture.pdf"), pages: [{ page: 1, text: "Sara Example" }] });
	const source = screen.getByRole("button", { name: "PDF page 1" });
	expect(source).toHaveAttribute("data-variant", "metadata-link");
	fireEvent.click(source);
	expect(screen.getByRole("tab", { name: "Original PDF" })).toHaveAttribute("aria-selected", "true");
});

it("renders the structured date once instead of the legacy period label", () => {
	importedReview();
	fireEvent.click(
		within(screen.getByRole("navigation", { name: "Review sections" })).getByRole("button", { name: /^Experience/ }),
	);
	const entry = screen.getByRole("article", { name: /Engineer/ });
	expect(within(entry).queryByText("period")).not.toBeInTheDocument();
	expect(within(entry).getAllByText("Jul 2024 – Present")).toHaveLength(1);
});

it("does not attribute repeated source text to an arbitrary PDF page", async () => {
	mocks.read.mockResolvedValue({ profileRevision: 0, facts: [] });
	mocks.confirm.mockResolvedValue({ resumeId: "created" });
	importedReview(vi.fn(), {
		file: new File(["pdf"], "fixture.pdf"),
		pages: [
			{ page: 1, text: "Sara Example TypeScript" },
			{ page: 2, text: "Sara Example TypeScript" },
		],
	});
	expect(screen.queryByRole("button", { name: "PDF page 1" })).not.toBeInTheDocument();
	fireEvent.click(screen.getByRole("button", { name: "Confirm all remaining" }));
	fireEvent.click(
		within(screen.getByRole("navigation", { name: "Review sections" })).getByRole("button", { name: "Experience" }),
	);
	fireEvent.click(screen.getByRole("button", { name: "Confirm section" }));
	fireEvent.click(screen.getByRole("button", { name: "Create CV and save career information" }));
	await waitFor(() => expect(mocks.confirm).toHaveBeenCalledOnce());
	const skill = mocks.confirm.mock.calls[0]?.[0].acceptedFacts.find(
		({ fact }: { fact: { value: unknown } }) => fact.value === "TypeScript",
	);
	expect(skill.fact.source.quote).toBe("TypeScript");
});

it("allows partial imports to save only after every current section is reviewed", () => {
	importedReview(vi.fn(), { partial: true });
	expect(saveButton()).toBeDisabled();
	fireEvent.click(screen.getByRole("button", { name: "Confirm section" }));
	expect(saveButton()).toBeDisabled();
	const navigation = screen.getByRole("navigation", { name: "Review sections" });
	for (const section of [/^Experience/, /^Skills/]) {
		fireEvent.click(within(navigation).getByRole("button", { name: section }));
		fireEvent.click(screen.getByRole("button", { name: "Confirm section" }));
	}
	expect(screen.getByRole("button", { name: "Create CV and save career information" })).toBeEnabled();
	expect(screen.getByRole("button", { name: "Create CV only" })).toBeEnabled();
});

it("does not bypass partial review requirements through an error retry", async () => {
	const onCheckpoint = vi.fn(async () => {
		throw new Error("Storage unavailable");
	});
	importedReview(vi.fn(), { partial: true, onCheckpoint });
	fireEvent.click(await screen.findByRole("button", { name: "Try again" }));
	await act(async () => {});
	expect(mocks.read).not.toHaveBeenCalled();
	expect(mocks.confirm).not.toHaveBeenCalled();
});

it("preserves decoded description text in the accepted source quote", async () => {
	mocks.read.mockResolvedValue({ profileRevision: 0, facts: [] });
	mocks.confirm.mockResolvedValue({ resumeId: "created" });
	const data = parseResumeText("Sara Example\nEXPERIENCE\nExample Labs | Engineer | 2020 - 2024\nSaved <5 hours>.");
	importedReview(vi.fn(), { state: createReviewState(data, flowId) });
	fireEvent.click(
		within(screen.getByRole("navigation", { name: "Review sections" })).getByRole("button", { name: /^Experience/ }),
	);
	fireEvent.click(screen.getByRole("button", { name: "Confirm section" }));
	fireEvent.click(saveButton());
	await waitFor(() => expect(mocks.confirm).toHaveBeenCalledOnce());
	const description = mocks.confirm.mock.calls[0]?.[0].acceptedFacts.find(
		({ fact }: { fact: { field: string } }) => fact.field === "description",
	);
	expect(description.fact.value).toBe("Saved <5 hours>.");
	expect(description.fact.source.quote).toBe("Saved <5 hours>.");
});
