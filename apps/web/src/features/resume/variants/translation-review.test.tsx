import type { ResumeData } from "@reactive-resume/schema/resume/data";
import { render, screen, cleanup, fireEvent, within, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vite-plus/test";
// @vitest-environment happy-dom
import { i18n } from "@lingui/core";
import { I18nProvider } from "@lingui/react";
import { buildTranslationInventory } from "@reactive-resume/resume/translation";
import { educationItemSchema, experienceItemSchema, projectItemSchema } from "@reactive-resume/schema/resume/data";
import { defaultResumeData } from "@reactive-resume/schema/resume/default";
import { messages as arabicMessages } from "../../../../locales/ar-SA.po";
import { TranslationGapReason } from "./translation-gaps";
import { TranslationReview } from "./translation-review";
const state = vi.hoisted(() => ({
	data: {} as Record<string, unknown>,
	mutate: vi.fn(),
	complete: null as ((result: unknown, variables: unknown) => Promise<void>) | null,
	error: null as unknown,
	notices: vi.fn(),
	grant: vi.fn(),
	retryTranslation: vi.fn(),
}));
vi.mock("@tanstack/react-query", () => ({
	useQuery: () => ({ data: state.data, refetch: vi.fn() }),
	useQueryClient: () => ({ getQueryData: vi.fn(), invalidateQueries: vi.fn() }),
	useMutation: (options: { onSuccess?: typeof state.complete; onError?: unknown }) => {
		if (options.onError && options.onSuccess) state.complete = options.onSuccess;
		return { mutate: state.mutate, reset: vi.fn(), isPending: false, error: state.error };
	},
}));
vi.mock("@tanstack/react-router", async (importOriginal) => ({
	...(await importOriginal<typeof import("@tanstack/react-router")>()),
	Link: ({ children }: { children: React.ReactNode }) => <a href="/dashboard/career/information">{children}</a>,
}));
vi.mock("@/libs/orpc/client", () => ({
	orpc: {
		ai: {
			variantReview: { get: { queryOptions: () => ({}) } },
			operations: { get: { queryOptions: () => ({}) } },
		},
		resume: { key: () => [] },
		career: { jobTargets: { key: () => [] } },
	},
	client: {
		ai: {
			processing: { notices: state.notices, grant: state.grant },
			operations: { retryTranslation: state.retryTranslation },
		},
	},
}));
vi.mock("../editor/proposals/review-operation", () => ({
	ReviewNotice: ({
		title,
		children,
		actions,
	}: {
		title?: React.ReactNode;
		children: React.ReactNode;
		actions?: React.ReactNode;
	}) => (
		<div>
			<div>{title}</div>
			<div>{children}</div>
			{actions}
		</div>
	),
}));
vi.mock("../editor/proposals/review-client", () => ({ submitVariantDecision: vi.fn() }));
afterEach(() => {
	cleanup();
	state.mutate.mockReset();
	state.notices.mockReset();
	state.grant.mockReset();
	state.retryTranslation.mockReset();
	state.complete = null;
	state.error = null;
});

it("shows the full changed number when the value includes a colon", () => {
	i18n.loadAndActivate({ locale: "en-US", messages: {} });
	render(
		<I18nProvider i18n={i18n}>
			<TranslationGapReason reason="TRANSLATION_FACT_NUMBER:12:30" />
		</I18nProvider>,
	);
	expect(screen.getByText("The number 12:30 changed.")).toBeDefined();
});

function show(
	terms: Array<string | { id: string; source: string; value?: string; status?: "pending" | "confirmed" }>,
	segment: "pending" | "accepted",
	stale = false,
	sourceData?: ResumeData,
) {
	i18n.loadAndActivate({ locale: "en-US", messages: {} });
	state.data = {
		result: {
			kind: "review.translation",
			sourceRevision: { id: "copy" },
			output: { direction: "ar-en", segments: [{ sourceId: "source", text: "Generated target", claims: [] }] },
		},
		sourceSegments: [{ id: "source", text: "النص الأصلي" }],
		terms: {
			terms: terms.map((entry, index) => {
				const item = typeof entry === "string" ? { id: entry, source: `المعهد ${index}` } : entry;
				return {
					id: item.id,
					sourceRevision: "rev-1",
					target: { sectionId: "experience", itemId: "exp-1", field: "company" },
					source: item.source,
					value: item.value ?? item.source,
					status: item.status ?? "pending",
					author: item.status === "confirmed" ? "user" : "source",
				};
			}),
		},
		segments: { source: { text: "Generated target", status: segment } },
		statuses: { translation: "pending", source: segment },
		stale,
		undoable: [],
		answeredQuestionIds: [],
		dismissedQuestionIds: [],
	};
	return render(
		<I18nProvider i18n={i18n}>
			<TranslationReview operationId="operation" sourceData={sourceData} />
		</I18nProvider>,
	);
}

const uuidPattern = /[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}/iu;
const firstItemId = "01a213fd-3d4a-7401-b946-75736fe7286a";
const secondItemId = "01a213fd-3d4a-7401-b946-75736fe7286b";
const unknownItemId = "01a213fd-3d4a-7401-b946-75736fe7286c";

it.each([
	["en-US", "Projects", "Current order", "Proposed order", "Move مشروع B above Project A."],
	["ar-SA", "المشاريع", "الترتيب الحالي", "الترتيب المقترح", "انقل مشروع B فوق Project A."],
] as const)("shows and accepts a readable reorder in %s", (locale, section, before, after, explanation) => {
	i18n.loadAndActivate({ locale, messages: locale === "ar-SA" ? arabicMessages : {} });
	const data = structuredClone(defaultResumeData);
	const project = { hidden: false, period: "", description: "" };
	data.sections.projects.items = [
		projectItemSchema.parse({ ...project, id: firstItemId, name: "Project A" }),
		projectItemSchema.parse({ ...project, id: secondItemId, name: "مشروع B" }),
	];
	state.data = {
		result: {
			kind: "review.tailoring",
			output: {
				patches: [],
				order: [{ sectionId: "projects", itemIds: [secondItemId, firstItemId] }],
			},
		},
		statuses: {},
		segments: {},
		undoable: [],
	};
	const view = () => (
		<I18nProvider i18n={i18n}>
			<TranslationReview operationId="operation" sourceData={data} />
		</I18nProvider>
	);
	const { container, rerender } = render(view());
	expect(container.textContent).not.toMatch(uuidPattern);
	expect(screen.getByRole("heading", { name: section })).toBeVisible();
	for (const [label, titles] of [
		[before, ["Project A", "مشروع B"]],
		[after, ["مشروع B", "Project A"]],
	] as const) {
		const items = within(screen.getByRole("list", { name: label })).getAllByRole("listitem");
		expect(items.map((item) => item.textContent)).toEqual(titles);
		for (const item of items) expect(item.querySelector("bdi")).toHaveAttribute("dir", "auto");
	}
	expect(screen.getByText(explanation, { normalizer: (text) => text.replace(/[\u2068\u2069]/gu, "") })).toBeVisible();
	fireEvent.click(screen.getByRole("button", { name: locale === "ar-SA" ? "قبول" : "Accept" }));
	expect(state.mutate).toHaveBeenCalledWith({ subjectIds: ["order"], decision: "accept" });

	state.data.result = {
		kind: "review.tailoring",
		output: { patches: [], order: [{ sectionId: "projects", itemIds: [unknownItemId, firstItemId] }] },
	};
	rerender(view());
	expect(container.textContent).not.toMatch(uuidPattern);
	expect(screen.queryByRole("list", { name: after })).toBeNull();
	expect(screen.queryByRole("button", { name: locale === "ar-SA" ? "قبول" : "Accept" })).toBeNull();
});

it("keeps translation segment IDs out of visible text and accessible labels", () => {
	const { container, rerender } = show([], "pending");
	state.data = {
		...state.data,
		result: {
			kind: "review.translation",
			sourceRevision: { id: secondItemId },
			output: { direction: "ar-en", segments: [{ sourceId: firstItemId, text: "Generated target", claims: [] }] },
		},
		sourceSegments: [{ id: firstItemId, text: "النص الأصلي" }],
		segments: { [firstItemId]: { text: "Generated target", status: "pending" } },
	};
	rerender(
		<I18nProvider i18n={i18n}>
			<TranslationReview operationId="operation" />
		</I18nProvider>,
	);
	expect(screen.getByText("Generated target")).toBeInTheDocument();
	expect(container.textContent).not.toMatch(uuidPattern);
	expect(
		Array.from(container.querySelectorAll("[aria-label]"), (element) => element.getAttribute("aria-label")).join(" "),
	).not.toMatch(uuidPattern);
});
it.each([
	[["school"], false, "Confirm the official names before saving."],
	[[], true, "The source or this copy changed. Start a new translation to save a current copy."],
] as const)("blocks approval with an inline explanation (%j)", (terms, stale, reason) => {
	show([...terms], "pending", stale);
	expect(screen.getByRole("button", { name: "Approve & save English copy" })).toBeDisabled();
	expect(screen.getByText(reason)).toBeVisible();
});

it("blocks approval when there is nothing to save", () => {
	const view = show([], "pending");
	state.data.segments = {};
	view.rerender(
		<I18nProvider i18n={i18n}>
			<TranslationReview operationId="operation" />
		</I18nProvider>,
	);
	expect(screen.getByRole("button", { name: "Approve & save English copy" })).toBeDisabled();
	expect(screen.getByText("Retry untranslated parts to get a draft you can save.")).toBeVisible();
});
it("confirms 68 pending official names with one action while retaining per-name controls", () => {
	const names = Array.from({ length: 68 }, (_, index) => `term:official-${index}`);
	const view = show(names, "accepted");
	expect(screen.getByRole("button", { name: "Approve & save English copy" })).toBeDisabled();
	fireEvent.click(screen.getByRole("button", { name: "Keep all as written" }));
	expect(state.mutate).toHaveBeenCalledWith({ subjectIds: names, decision: "accept" });
	const namesCard = screen.getByText("68 terms need your confirmation").closest("section");
	if (!namesCard) throw new Error("Missing official names card");
	expect(within(namesCard).getAllByRole("button", { name: "Edit" })).toHaveLength(68);
	for (const term of (state.data.terms as { terms: { status: string }[] }).terms) term.status = "confirmed";
	view.rerender(
		<I18nProvider i18n={i18n}>
			<TranslationReview operationId="operation" />
		</I18nProvider>,
	);
	expect(screen.getByRole("button", { name: "Approve & save English copy" })).toBeEnabled();
});

it("deduplicates repeated source terms, shows occurrence count, confirms all occurrences at once, and collapses confirmed names", () => {
	show(
		[
			{ id: "term:1", source: "مجلس الواحة", value: "مجلس الواحة", status: "confirmed" },
			{ id: "term:2", source: "مجلس الواحة", value: "مجلس الواحة", status: "confirmed" },
			{ id: "term:3", source: "مجلس الواحة", value: "مجلس الواحة", status: "confirmed" },
			{ id: "term:4", source: "مجلس الواحة", value: "مجلس الواحة", status: "confirmed" },
			{ id: "term:5", source: "جامعة الرياض", value: "جامعة الرياض", status: "pending" },
			{ id: "term:6", source: "جامعة الرياض", value: "جامعة الرياض", status: "pending" },
		],
		"pending",
	);

	// Only 1 pending unique row is visible by default; confirmed group is behind Compare with original disclosure.
	expect(screen.getAllByText("جامعة الرياض")).toHaveLength(1);
	expect(screen.getByText("2 occurrences")).toBeDefined();
	expect(screen.getByText("Show 1 confirmed name")).toBeDefined();

	// Confirming the pending unique row sends all its occurrence IDs.
	const [firstPendingButton] = screen.getAllByRole("button", { name: "Edit" });
	expect(firstPendingButton).toBeDefined();
	if (firstPendingButton) fireEvent.click(firstPendingButton);
	const dialog = screen.getByRole("dialog");
	fireEvent.change(within(dialog).getByLabelText("Reviewed term"), { target: { value: "Riyadh University" } });
	fireEvent.click(within(dialog).getByRole("button", { name: "Confirm term" }));
	expect(state.mutate.mock.lastCall?.[0]).toEqual({
		subjectIds: ["term:5", "term:6"],
		decision: "accept_edited",
		editedText: "Riyadh University",
	});
});

it("offers optional comparison of a saved copy without approval controls", () => {
	const view = show([], "accepted");
	(state.data.statuses as Record<string, string>).translation = "accepted";
	view.rerender(
		<I18nProvider i18n={i18n}>
			<TranslationReview operationId="operation" />
		</I18nProvider>,
	);
	expect(screen.queryByRole("button", { name: /Approve & save/u })).toBeNull();
	fireEvent.click(screen.getByRole("button", { name: "Show original text" }));
	fireEvent.click(screen.getByText("Other sections"));
	expect(screen.getByText("النص الأصلي")).toBeVisible();
});

it("offers one approval immediately for a 91-part draft and calls onSaved after the final decision", async () => {
	const view = show([{ id: "term:1", source: "مجلس الواحة", status: "confirmed" }], "pending");
	const onSaved = vi.fn();
	const ids = ["source", ...Array.from({ length: 90 }, (_, index) => `source-${index}`)];
	const result = state.data.result as { output: { segments: unknown[] } };
	result.output.segments = ids.map((sourceId) => ({ sourceId, text: "Generated target" }));
	state.data.segments = Object.fromEntries(ids.map((id) => [id, { text: "Generated target", status: "pending" }]));
	view.rerender(
		<I18nProvider i18n={i18n}>
			<TranslationReview operationId="operation" onSaved={onSaved} />
		</I18nProvider>,
	);
	expect(screen.queryByText("All names are confirmed.")).toBeNull();
	expect(screen.getByText("Show 1 confirmed name").closest("details")).not.toHaveAttribute("open");
	expect(screen.queryByText("0 of 91 accepted")).toBeNull();
	expect(screen.queryByRole("button", { name: /Accept all|Accept section/u })).toBeNull();
	const approve = screen.getByRole("button", { name: "Approve & save English copy" });
	expect(approve).toBeEnabled();
	fireEvent.click(approve);
	expect(state.mutate).toHaveBeenCalledWith({
		subjectIds: ["translation"],
		decision: "accept",
		approveSegmentIds: ids,
	});
	expect(onSaved).not.toHaveBeenCalled();
	await state.complete?.({}, state.mutate.mock.lastCall?.[0]);
	expect(onSaved).toHaveBeenCalledOnce();
});
it("opens summary by default and stages wording or original text through the edit decision", () => {
	const data = structuredClone(defaultResumeData);
	data.summary.hidden = false;
	data.summary.title = "نبذة";
	data.summary.content = "<p>ملخص مهني</p>";
	data.sections.experience.hidden = false;
	data.sections.experience.items = [
		experienceItemSchema.parse({
			id: "exp-1",
			hidden: false,
			company: "مجلس الواحة",
			position: "مدير",
			location: "",
			period: "2020-2025",
			website: { url: "", label: "" },
			description: "<p>قيادة الفريق</p>",
		}),
	];
	data.sections.education.hidden = false;
	data.sections.education.items = [
		educationItemSchema.parse({
			id: "edu-1",
			hidden: false,
			school: "جامعة الرياض",
			degree: "بكالوريوس",
			area: "إدارة",
			grade: "",
			location: "",
			period: "2010",
			website: { url: "", label: "" },
			description: "",
		}),
	];
	data.metadata.layout.pages = [{ fullWidth: false, main: ["summary", "experience", "education"], sidebar: [] }];

	const inventory = buildTranslationInventory(data);
	const summarySegments = inventory.segments.filter((seg) => seg.target.sectionId === "summary");
	const experienceSegments = inventory.segments.filter((seg) => seg.target.sectionId === "experience");
	const acceptedId = summarySegments[0]?.id ?? "";
	const rejectedId = experienceSegments[0]?.id ?? "";

	i18n.loadAndActivate({ locale: "en-US", messages: {} });
	state.data = {
		result: {
			kind: "review.translation",
			sourceRevision: { id: "copy" },
			output: {
				segments: inventory.segments.map((seg) => ({
					sourceId: seg.id,
					text: `EN: ${seg.text}`,
					claims: [],
				})),
			},
		},
		sourceSegments: inventory.segments.map((seg) => ({ id: seg.id, text: seg.text })),
		terms: { terms: [] },
		segments: Object.fromEntries(
			inventory.segments.map((seg) => [
				seg.id,
				{
					text: `EN: ${seg.text}`,
					status: seg.id === acceptedId ? "accepted" : seg.id === rejectedId ? "rejected" : "pending",
				},
			]),
		),
		statuses: {
			translation: "pending",
			...Object.fromEntries(
				inventory.segments.map((seg) => [
					seg.id,
					seg.id === acceptedId ? "accepted" : seg.id === rejectedId ? "rejected" : "pending",
				]),
			),
		},
		stale: false,
		undoable: [],
		answeredQuestionIds: [],
		dismissedQuestionIds: [],
	};

	render(
		<I18nProvider i18n={i18n}>
			<TranslationReview operationId="operation" sourceData={data} />
		</I18nProvider>,
	);

	const pendingSummary = summarySegments.find(({ id }) => id !== acceptedId);
	if (!pendingSummary) throw new Error("Expected a pending summary segment");
	const pendingCardElement = screen
		.getByText(`EN: ${pendingSummary.text}`)
		.closest<HTMLElement>('[data-slot="translation-segment"]');
	if (!pendingCardElement) throw new Error("Expected the pending translation card");
	const pendingCard = within(pendingCardElement);
	expect(screen.getByText("Summary", { exact: true }).closest("details")).toHaveAttribute("open");
	expect(screen.getByText("Experience", { exact: true }).closest("details")).not.toHaveAttribute("open");
	expect(screen.getByText("Education", { exact: true }).closest("details")).not.toHaveAttribute("open");
	expect(pendingCard.queryByRole("button", { name: /^(Accept|Reject)$/u })).toBeNull();
	expect(pendingCard.queryByText(pendingSummary.text)).toBeNull();
	fireEvent.click(screen.getByRole("button", { name: "Show original text" }));
	expect(pendingCard.getByText(pendingSummary.text).closest("bdi")).toBeDefined();
	fireEvent.click(pendingCard.getByRole("button", { name: "Keep original" }));
	expect(state.mutate.mock.lastCall?.[0]).toEqual({
		subjectIds: [pendingSummary.id],
		decision: "accept_edited",
		editedText: pendingSummary.text,
	});
	fireEvent.click(pendingCard.getByRole("button", { name: "Edit" }));
	fireEvent.change(pendingCard.getByRole("textbox"), { target: { value: "Custom wording" } });
	fireEvent.click(pendingCard.getByRole("button", { name: "Save wording" }));
	expect(state.mutate.mock.lastCall?.[0]).toEqual({
		subjectIds: [pendingSummary.id],
		decision: "accept_edited",
		editedText: "Custom wording",
	});
	expect(screen.getByRole("button", { name: /Approve & save/u })).toBeEnabled();
});

it("flags segments with unresolved placeholders, blocks Approve, and allows editing even if accepted", () => {
	i18n.loadAndActivate({ locale: "en-US", messages: {} });
	state.data = {
		result: {
			kind: "review.translation",
			sourceRevision: { id: "copy" },
			output: { segments: [{ sourceId: "seg-1", text: "Reference [redacted]", claims: [] }] },
		},
		sourceSegments: [{ id: "seg-1", text: "مرجع مهني" }],
		terms: { terms: [] },
		segments: { "seg-1": { text: "Reference [redacted]", status: "accepted" } },
		statuses: { translation: "pending", "seg-1": "accepted" },
		stale: false,
		undoable: [],
		answeredQuestionIds: [],
		dismissedQuestionIds: [],
	};
	render(
		<I18nProvider i18n={i18n}>
			<TranslationReview operationId="operation" />
		</I18nProvider>,
	);

	expect(
		screen.getByText(
			"Some translated segments still contain an unresolved placeholder. Edit the marked segments before approving.",
		),
	).toBeDefined();
	expect(screen.getByText("Needs edit")).toBeDefined();
	expect(screen.getByRole("button", { name: "Edit" })).toBeDefined();

	expect(screen.getByRole("button", { name: /Approve & save/u })).toBeDisabled();
});

it.each([
	[
		{ data: { reason: "TRANSLATION_LOCAL_VALUE_UNRESOLVED", segmentId: "source" } },
		"Could not approve because a protected placeholder could not be restored. Edit the marked segment in Other sections, then try again.",
	],
	[
		{ data: { reason: "TRANSLATION_REVIEW_INCOMPLETE" } },
		"Could not save the draft. Reload the review and resolve any remaining items.",
	],
	[new Error("BOOM"), "The decision was not saved. Reload the review before trying again."],
])("shows a clear error notice for approve/decision failures (%j)", (error, expectedMessage) => {
	state.error = error;
	show([], "accepted");
	expect(screen.getByText(expectedMessage)).toBeDefined();
});

function showSummary(stale = false, outputKind: "summary" | "questions" | "notes" = "summary") {
	i18n.loadAndActivate({ locale: "en-US", messages: {} });
	state.data = {
		result: {
			kind: "review.summary",
			sourceRevision: { id: "cv" },
			output: {
				summary: { text: outputKind === "summary" ? "Proposed summary" : "", claims: [] },
				questions:
					outputKind === "questions"
						? [{ id: "clarify", prompt: "What work would you like to highlight?", evidenceIds: [] }]
						: [],
				notes: outputKind === "notes" ? ["No summary change is needed."] : [],
			},
		},
		beforeSummary: "<p>Research &amp; development</p>",
		terms: { terms: [] },
		segments: {},
		statuses: { summary: "pending" },
		stale,
		undoable: [],
		answeredQuestionIds: [],
		dismissedQuestionIds: [],
	};
	render(
		<I18nProvider i18n={i18n}>
			<TranslationReview operationId="operation" />
		</I18nProvider>,
	);
}

it("delivers summary clarification questions without offering an empty summary replacement", () => {
	showSummary(false, "questions");
	expect(screen.getByText("What work would you like to highlight?")).toBeDefined();
	expect(screen.queryByRole("button", { name: "Accept" })).toBeNull();
	expect(screen.queryByRole("button", { name: "Edit" })).toBeNull();
});

it("shows a verified no-change note without offering an empty replacement", () => {
	showSummary(false, "notes");
	expect(screen.getByText("No summary change is needed.")).toBeDefined();
	expect(screen.queryByRole("button", { name: "Accept" })).toBeNull();
});

it("renders the original summary as decoded text while editing", () => {
	showSummary();
	fireEvent.click(screen.getByRole("button", { name: "Edit" }));
	const original = Array.from(document.querySelectorAll("blockquote")).find(
		(node) => node.textContent === "Research & development",
	);
	expect(original).toBeDefined();
	expect(screen.queryByText("<p>Research &amp; development</p>")).toBeNull();
});

it("does not offer a Suggest again action that cannot create a new review", () => {
	showSummary(true);
	expect(screen.getByText("Out of date: the text has changed since.")).toBeDefined();
	expect(screen.queryByRole("button", { name: "Suggest again" })).toBeNull();
});

it.each(["accepted", "rejected"])("locks official terms after final translation is %s", (status) => {
	show([{ id: "school", source: "المعهد", status: "confirmed" }], "accepted").unmount();
	(state.data.statuses as Record<string, string>).translation = status;
	render(
		<I18nProvider i18n={i18n}>
			<TranslationReview operationId="operation" />
		</I18nProvider>,
	);
	const names = screen.getByText("Show 1 confirmed name").closest("details");
	if (!names) throw new Error("Missing confirmed names disclosure");
	names.open = true;
	expect(within(names).queryByRole("button", { name: "Edit" })).toBeNull();
	expect(screen.queryByRole("button", { name: "Confirm term" })).toBeNull();
});

it("shows the cited job requirement, localized verdict and an actionable clarification instead of an enum and repeated explanation", () => {
	i18n.loadAndActivate({ locale: "en-US", messages: {} });
	state.data = {
		result: {
			kind: "review.job-evidence",
			sourceRevision: { id: "cv" },
			output: {
				requirements: [
					{
						id: "requirement",
						spanIds: ["job-span"],
						verdict: "no_evidence",
						evidenceIds: [],
						explanation: "No supporting evidence was found in this CV.",
					},
				],
				notes: [],
			},
		},
		sourceSegments: [{ id: "job-span", text: "TypeScript and SAP required" }],
		terms: { terms: [] },
		segments: {},
		statuses: { report: "pending" },
		stale: false,
		undoable: [],
		answeredQuestionIds: [],
		dismissedQuestionIds: [],
	};
	render(
		<I18nProvider i18n={i18n}>
			<TranslationReview operationId="operation" onContinued={vi.fn()} />
		</I18nProvider>,
	);
	const report = within(screen.getByRole("region", { name: "Detailed requirement check" }));
	expect(report.getByText("TypeScript and SAP required").getAttribute("dir")).toBe("auto");
	expect(report.getByText("No evidence found").getAttribute("dir")).toBeNull();
	expect(report.getByText("No supporting evidence was found in this CV.").getAttribute("dir")).toBe("auto");
	expect(screen.getAllByText(/TypeScript and SAP required/)).toHaveLength(1);
	expect(screen.queryByText(/no_evidence/)).toBeNull();
	expect(screen.getByText(/No evidence found/)).toBeDefined();
	expect(screen.getByText("What experience, study or project can you confirm for this requirement?")).toBeDefined();
	expect(screen.getAllByText(/No supporting evidence was found in this CV/)).toHaveLength(1);
	expect(report.getByRole("button", { name: "Add a fact" })).toBeDefined();
});

it("shows five collapsed passages for 18 distinct job clarification prompts", async () => {
	i18n.loadAndActivate({ locale: "en-US", messages: {} });
	const sourceSegments = Array.from({ length: 5 }, (_, index) => ({
		id: `passage-${index}`,
		text: `${index === 0 ? "What you will do1. " : ""}Build service ${index}. ${"The full source gives more details. ".repeat(35)}End of passage ${index}.`,
	}));
	const requirements = [0, 1, 0, 2, 0, 3, 1, 0, 2, 3, 1, 4, 0, 2, 1, 4, 0, 0].map((passage, index) => ({
		id: `requirement-${index}`,
		spanIds: [`passage-${passage}`],
		verdict: "partial",
		evidenceIds: [],
		explanation: `The CV partially supports requirement ${index}.`,
	}));
	state.data = {
		result: {
			kind: "review.job-evidence",
			sourceRevision: { kind: "resume", id: "cv", revision: "1" },
			output: { requirements, notes: [] },
		},
		sourceSegments,
		terms: { terms: [] },
		segments: {},
		statuses: { report: "pending" },
		stale: false,
		undoable: [],
		answeredQuestionIds: [],
		dismissedQuestionIds: [],
	};
	render(
		<I18nProvider i18n={i18n}>
			<TranslationReview operationId="operation" onContinued={vi.fn()} />
		</I18nProvider>,
	);
	const report = screen.getByRole("region", { name: "Detailed requirement check" });
	const passages = Array.from(report.querySelectorAll("details"));
	expect(passages).toHaveLength(5);
	expect(passages.every((passage) => !passage.open)).toBe(true);
	expect(passages.map((passage) => passage.querySelector("summary")?.textContent)).toEqual(
		sourceSegments.map((_, index) => expect.stringContaining(`Build service ${index}.`)),
	);
	for (const passage of sourceSegments) expect(within(report).getAllByText(passage.text)).toHaveLength(1);
	expect(
		within(report).getAllByText("What experience, study or project can you confirm for this requirement?"),
	).toHaveLength(18);
	expect(within(report).getAllByRole("button", { name: "Add a fact" })).toHaveLength(18);
	expect(within(report).getAllByRole("button", { name: "Skip" })).toHaveLength(18);
	for (const requirement of requirements) expect(within(report).getByText(requirement.explanation)).toBeDefined();

	const lastFinding = "The CV partially supports requirement 17.";
	const lastRequirement = within(report).getByText(lastFinding).closest("li");
	if (!lastRequirement) throw new Error("Expected a row for the last requirement");
	fireEvent.click(within(lastRequirement).getByRole("button", { name: "Add a fact" }));
	const dialog = await screen.findByRole("dialog");
	expect(within(dialog).getByText(lastFinding)).toBeDefined();
	fireEvent.change(within(dialog).getByRole("textbox"), { target: { value: "Built a reporting service." } });
	fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
	fireEvent.click(within(lastRequirement).getByRole("button", { name: "Add a fact" }));
	expect(((await screen.findByRole("textbox")) as HTMLTextAreaElement).value).toBe("Built a reporting service.");
});

it("explains partial job evidence with a visible recovery action", () => {
	i18n.loadAndActivate({ locale: "en-US", messages: {} });
	state.data = {
		result: {
			kind: "review.job-evidence",
			sourceRevision: { id: "cv" },
			output: {
				requirements: [
					{ id: "requirement", spanIds: ["job"], verdict: "partial", evidenceIds: [], explanation: "Built services." },
				],
				notes: [],
			},
		},
		sourceSegments: [{ id: "job", text: "TypeScript and SAP required" }],
		terms: { terms: [] },
		segments: {},
		statuses: { report: "pending" },
		stale: false,
		undoable: [],
		answeredQuestionIds: [],
		dismissedQuestionIds: [],
	};
	render(
		<I18nProvider i18n={i18n}>
			<TranslationReview operationId="operation" onContinued={vi.fn()} />
		</I18nProvider>,
	);
	const report = within(screen.getByRole("region", { name: "Detailed requirement check" }));
	expect(report.getByText("Partial evidence")).toBeVisible();
	expect(report.getByText("Built services.")).toBeVisible();
	expect(report.getByRole("button", { name: "Add a fact" })).toBeEnabled();
});

it("shows a visible withheld-items notice when individual unverified items were withheld", () => {
	i18n.loadAndActivate({ locale: "en-US", messages: {} });
	state.data = {
		result: {
			kind: "review.job-evidence",
			sourceRevision: { id: "cv" },
			withheld: { count: 2, rules: ["AI_UNSUPPORTED_CLAIM"] },
			output: {
				requirements: [
					{
						id: "requirement",
						spanIds: ["job-span"],
						verdict: "supported",
						evidenceIds: ["cv-1"],
						explanation: "Supported backend experience.",
					},
				],
				notes: [],
			},
		},
		sourceSegments: [{ id: "job-span", text: "Backend APIs" }],
		terms: { terms: [] },
		segments: {},
		statuses: { report: "pending" },
		stale: false,
		undoable: [],
		answeredQuestionIds: [],
		dismissedQuestionIds: [],
	};
	render(
		<I18nProvider i18n={i18n}>
			<TranslationReview operationId="operation" />
		</I18nProvider>,
	);
	expect(screen.getByText("2 requirements could not be checked. Retry or check them yourself.")).toBeDefined();
	expect(screen.getByText(/Supported backend experience\./)).toBeDefined();
});

it("does not repeat a single full job ad under every job-evidence item and uses a short title for a withheld item without raw IDs", () => {
	i18n.loadAndActivate({ locale: "en-US", messages: {} });
	const fullAd = "Line 1: Measure service quality.\nLine 2: Prepare weekly reports.\nLine 3: Manage cloud infra.";
	state.data = {
		result: {
			kind: "review.job-evidence",
			sourceRevision: { id: "cv" },
			withheld: {
				count: 1,
				rules: ["AI_UNSUPPORTED_CLAIM"],
				items: [{ id: "req-03", spanIds: ["job:j1:r1"], reason: "AI_UNSUPPORTED_CLAIM" }],
			},
			output: {
				requirements: [
					{
						id: "req-01",
						spanIds: ["job:j1:r1"],
						verdict: "no_evidence",
						evidenceIds: [],
						explanation: "No CV evidence of measuring service quality.",
					},
					{
						id: "req-02",
						spanIds: ["job:j1:r1"],
						verdict: "no_evidence",
						evidenceIds: [],
						explanation: "No CV evidence of preparing weekly reports.",
					},
				],
				notes: [],
			},
		},
		sourceSegments: [{ id: "job:j1:r1", text: fullAd }],
		terms: { terms: [] },
		segments: {},
		statuses: { report: "pending" },
		stale: false,
		undoable: [],
		answeredQuestionIds: [],
		dismissedQuestionIds: [],
	};
	render(
		<I18nProvider i18n={i18n}>
			<TranslationReview operationId="operation" />
		</I18nProvider>,
	);
	expect(screen.queryAllByText(/Line 1: Measure service quality\./)).toHaveLength(0);
	expect(screen.getAllByText(/No CV evidence of measuring service quality\./).length).toBeGreaterThan(0);
	expect(screen.getAllByText(/No CV evidence of preparing weekly reports\./).length).toBeGreaterThan(0);
	expect(screen.queryByText(/req-03/)).toBeNull();
	const toggle = screen.getByRole("button", { name: "Show unchecked requirements" });
	expect(toggle).toHaveAttribute("aria-expanded", "false");
	fireEvent.click(toggle);
	expect(screen.getByText("Job requirement 3")).toBeVisible();
	expect(screen.queryAllByText(/Line 1: Measure service quality\./)).toHaveLength(0);
	expect(screen.queryByText("The checked evidence did not support this finding.")).toBeNull();
});

it("lists distinct withheld requirement titles only after expansion", () => {
	i18n.loadAndActivate({ locale: "en-US", messages: {} });
	state.data = {
		result: {
			kind: "review.job-evidence",
			sourceRevision: { id: "cv" },
			withheld: {
				count: 1,
				rules: ["JOB_UNSUPPORTED_IMPORTANCE"],
				items: [{ id: "req-07", spanIds: ["job:j1:r1:1"], reason: "JOB_UNSUPPORTED_IMPORTANCE" }],
			},
			output: {
				requirements: [
					{
						id: "req-01",
						spanIds: ["job:j1:r1:0"],
						verdict: "supported",
						evidenceIds: ["cv-1"],
						explanation: "Supported operations leadership.",
					},
				],
				notes: [],
			},
		},
		sourceSegments: [
			{ id: "job:j1:r1:0", text: "Lead process improvement." },
			{ id: "job:j1:r1:1", text: "Ten years of experience required." },
		],
		terms: { terms: [] },
		segments: {},
		statuses: { report: "pending" },
		stale: false,
		undoable: [],
		answeredQuestionIds: [],
		dismissedQuestionIds: [],
	};
	render(
		<I18nProvider i18n={i18n}>
			<TranslationReview operationId="operation" />
		</I18nProvider>,
	);
	const toggle = screen.getByRole("button", { name: "Show unchecked requirements" });
	expect(toggle).toHaveAttribute("aria-expanded", "false");
	fireEvent.click(toggle);
	const title = screen.getByText("Ten years of experience required.");
	expect(title.tagName).toBe("BDI");
	expect(title).toHaveAttribute("dir", "auto");
	expect(title).toHaveClass("truncate");
	expect(screen.queryByText(/Importance level was not stated explicitly in the job ad/)).toBeNull();
	expect(screen.queryByText(/req-07/)).toBeNull();
});

it.each(["en-US", "ar-SA"] as const)("keeps withheld findings and reasons out of the page in %s", (locale) => {
	i18n.loadAndActivate({ locale, messages: locale === "ar-SA" ? arabicMessages : {} });
	state.data = {
		result: {
			kind: "review.job-evidence",
			sourceRevision: { id: "cv" },
			withheld: {
				count: 1,
				rules: ["JOB_UNSUPPORTED_IMPORTANCE"],
				items: [
					{
						id: "req-07",
						spanIds: ["job:j1:r1:1"],
						reason: "JOB_UNSUPPORTED_IMPORTANCE",
						text: "The candidate meets the experience requirement.",
					},
				],
			},
			output: {
				requirements: [
					{
						id: "req-01",
						spanIds: ["job:j1:r1:0"],
						verdict: "supported",
						evidenceIds: ["cv-1"],
						explanation: "Supported operations leadership.",
					},
				],
				notes: [],
			},
		},
		sourceSegments: [
			{ id: "job:j1:r1:0", text: "Lead process improvement." },
			{ id: "job:j1:r1:1", text: "Ten years of experience required." },
		],
		terms: { terms: [] },
		segments: {},
		statuses: { report: "pending" },
		stale: false,
		undoable: [],
		answeredQuestionIds: [],
		dismissedQuestionIds: [],
	};
	render(
		<I18nProvider i18n={i18n}>
			<TranslationReview operationId="operation" />
		</I18nProvider>,
	);
	const ar = locale === "ar-SA";
	const toggle = screen.getByRole("button", {
		name: ar ? "عرض المتطلبات التي لم تُفحص" : "Show unchecked requirements",
	});
	expect(toggle).toHaveAttribute("aria-expanded", "false");
	expect(screen.queryByText("Ten years of experience required.")).toBeNull();
	fireEvent.click(toggle);
	expect(screen.getByText("Ten years of experience required.")).toBeVisible();
	expect(screen.queryByText(ar ? "نتيجة غير متحقق منها" : "Unverified finding")).toBeNull();
	expect(screen.queryByText("The candidate meets the experience requirement.")).toBeNull();
	expect(screen.queryByText(ar ? /الأهمية/ : /Importance level was not stated explicitly/)).toBeNull();
	expect(screen.queryByText(/req-07/)).toBeNull();
});

it.each(["en-US", "ar-SA"] as const)(
	"requires the displayed %s notice when retrying a withheld translation part",
	async (locale) => {
		i18n.loadAndActivate({ locale, messages: locale === "ar-SA" ? arabicMessages : {} });
		const notice = {
			purpose: "review.translation",
			locale,
			content: locale === "ar-SA" ? "معالجة الترجمة" : "Translation processing",
			noticeVersion: "1",
			noticeSha256: "a".repeat(64),
			alreadyGranted: false,
			route: { routeId: "synthetic", routeRevision: "1", configRevision: "1" },
		};
		state.notices.mockResolvedValue([notice]);
		state.data = {
			result: {
				kind: "review.translation",
				sourceRevision: { id: "cv" },
				withheld: {
					count: 2,
					rules: ["AI_VERIFICATION_CLAIM_SUPPORT"],
					items: [
						{ id: "summary:0", reason: "AI_VERIFICATION_CLAIM_SUPPORT", partIndex: 0 },
						{ id: "summary:1", reason: "AI_VERIFICATION_CLAIM_SUPPORT", partIndex: 2 },
					],
				},
				output: {
					direction: "en-ar",
					sourceRevision: "2026-01-01T00:00:00.000Z",
					segments: [
						{
							sourceId: "summary:0",
							text: "Original untranslated summary.",
							claims: [
								{ id: "c1", kind: "translation", text: "Original untranslated summary.", evidenceIds: ["summary:0"] },
							],
						},
						{
							sourceId: "summary:1",
							text: "فقرة مترجمة بنجاح.",
							claims: [{ id: "c2", kind: "translation", text: "فقرة مترجمة بنجاح.", evidenceIds: ["summary:1"] }],
						},
					],
					notes: [],
				},
			},
			sourceSegments: [
				{ id: "summary:0", text: "Original untranslated summary." },
				{ id: "summary:1", text: "Successfully translated paragraph." },
			],
			terms: { terms: [] },
			segments: {
				"summary:0": { text: "Original untranslated summary.", status: "accepted", author: "model" },
				"summary:1": { text: "فقرة مترجمة بنجاح.", status: "accepted", author: "model" },
			},
			statuses: { translation: "accepted", "summary:0": "accepted", "summary:1": "accepted" },
			stale: false,
			undoable: [],
			answeredQuestionIds: [],
			dismissedQuestionIds: [],
		};
		render(
			<I18nProvider i18n={i18n}>
				<TranslationReview operationId="operation" />
			</I18nProvider>,
		);
		const localized = locale === "ar-SA";
		if (!localized) {
			expect(screen.getByText("2 parts stayed in their original language")).toBeVisible();
			expect(screen.getByRole("button", { name: "Retry untranslated parts" })).toHaveAttribute(
				"data-variant",
				"secondary",
			);
		}
		const details = screen.getByText(localized ? "عرض التفاصيل (2)" : "Show details (2)").closest("details");
		if (!details) throw new Error("Missing untranslated parts disclosure");
		details.open = true;
		const retry = screen
			.getAllByRole("button", { name: localized ? "إعادة محاولة هذا الجزء" : "Retry this part" })
			.at(-1);
		if (!retry) throw new Error("Missing part retry");
		fireEvent.click(retry);
		expect(await screen.findByText(notice.content)).toBeVisible();
		expect(state.retryTranslation).not.toHaveBeenCalled();
		expect(state.grant).not.toHaveBeenCalled();
		fireEvent.click(
			within(screen.getByRole("dialog")).getByRole("button", {
				name: localized ? "إعادة محاولة هذا الجزء" : "Retry this part",
			}),
		);
		await waitFor(() =>
			expect(state.retryTranslation).toHaveBeenCalledExactlyOnceWith(
				expect.objectContaining({
					id: "operation",
					partIndex: 2,
					execution: { route: notice.route, consentVersion: "1" },
				}),
			),
		);
		expect(state.grant).toHaveBeenCalledWith(expect.objectContaining({ noticeSha256: notice.noticeSha256 }));
		expect(state.notices).toHaveBeenCalledWith({ purpose: notice.purpose, locale });
		if (!localized) {
			fireEvent.click(screen.getByRole("button", { name: "Show original text" }));
			const section = screen.getByText("Other sections", { selector: "summary *" }).closest("details");
			if (!section) throw new Error("Missing translation preview section");
			section.open = true;
			expect(screen.getAllByText("Not translated yet")).toHaveLength(2);
		}
	},
);

it("shows a clear no-change-needed status and close action when summary review needs no edits", () => {
	i18n.loadAndActivate({ locale: "en-US", messages: {} });
	const onClose = vi.fn();
	state.data = {
		result: {
			kind: "review.summary",
			sourceRevision: { id: "cv" },
			output: {
				summary: { text: "", claims: [] },
				questions: [],
				notes: ["لا حاجة إلى تعديل الملخص الحالي."],
			},
		},
		beforeSummary: "<p>Existing summary.</p>",
		sourceSegments: [],
		terms: { terms: [] },
		segments: {},
		statuses: {},
		stale: false,
		undoable: [],
		answeredQuestionIds: [],
		dismissedQuestionIds: [],
	};
	render(
		<I18nProvider i18n={i18n}>
			<TranslationReview operationId="operation" onClose={onClose} />
		</I18nProvider>,
	);
	expect(screen.getByText("No summary changes are needed. Your summary is unchanged.")).toBeDefined();
	expect(screen.getByText("Check this finding against the source information.")).toBeDefined();
	expect(screen.queryByText("لا حاجة إلى تعديل الملخص الحالي.")).toBeNull();
	const closeButton = screen.getByRole("button", { name: "Close" });
	fireEvent.click(closeButton);
	expect(onClose).toHaveBeenCalledTimes(1);
});

it("collapses 18 untranslated parts and uses secondary buttons in the notice and preview", () => {
	const view = show([], "pending");
	const gaps = Array.from({ length: 18 }, (_, index) => ({
		id: `gap-${index}`,
		text: `Supports direct AI API calls (${index}).`,
		untranslated: { partIndex: index, reason: "TRANSLATION_FACT_TERM:SQL" },
	}));
	state.data.sourceSegments = [...(state.data.sourceSegments as unknown[]), ...gaps];
	view.rerender(
		<I18nProvider i18n={i18n}>
			<TranslationReview operationId="operation" />
		</I18nProvider>,
	);
	const details = screen.getByText("Show details (18)").closest("details");
	expect(details).not.toHaveAttribute("open");
	expect(screen.getByRole("button", { name: "Retry untranslated parts" })).toHaveAttribute("data-variant", "secondary");
	expect(details).not.toBeNull();
	if (!details) throw new Error("Missing details");
	details.open = true;
	expect(within(details).getAllByRole("button", { name: "Retry this segment" })).toHaveLength(18);
	expect(within(details).getByText("Supports direct AI API calls (0).").closest("bdi")).toBeDefined();
	expect(within(details).getAllByText("The term SQL was changed.")).toHaveLength(18);
	const section = screen.getByText("Other sections", { selector: "summary *" }).closest("details");
	if (!section) throw new Error("Missing section");
	section.open = true;
	expect(within(section).getAllByText("Not translated yet")).toHaveLength(18);
	const rowElement = within(section)
		.getByText("Supports direct AI API calls (0).")
		.closest<HTMLElement>('[data-slot="translation-segment"]');
	if (!rowElement) throw new Error("Expected the first untranslated card");
	const row = within(rowElement);
	expect(row.getByRole("button", { name: "Retry this segment" })).toHaveAttribute("data-variant", "secondary");
});
