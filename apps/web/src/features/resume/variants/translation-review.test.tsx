import type { ResumeData } from "@reactive-resume/schema/resume/data";
import { render, screen, cleanup, fireEvent, within, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vite-plus/test";
// @vitest-environment happy-dom
import { i18n } from "@lingui/core";
import { I18nProvider } from "@lingui/react";
import { buildTranslationInventory } from "@reactive-resume/resume/translation";
import { educationItemSchema, experienceItemSchema } from "@reactive-resume/schema/resume/data";
import { defaultResumeData } from "@reactive-resume/schema/resume/default";
import { messages as arabicMessages } from "../../../../locales/ar-SA.po";
import { TranslationReview } from "./translation-review";
const state = vi.hoisted(() => ({
	data: {} as Record<string, unknown>,
	mutate: vi.fn(),
	error: null as unknown,
	notices: vi.fn(),
	grant: vi.fn(),
	retryTranslation: vi.fn(),
}));
vi.mock("@tanstack/react-query", () => ({
	useQuery: () => ({ data: state.data, refetch: vi.fn() }),
	useQueryClient: () => ({ invalidateQueries: vi.fn() }),
	useMutation: () => ({ mutate: state.mutate, isPending: false, error: state.error }),
}));
vi.mock("@/libs/orpc/client", () => ({
	orpc: {
		ai: {
			variantReview: { get: { queryOptions: () => ({}) } },
			operations: { get: { queryOptions: () => ({}) } },
		},
		resume: { key: () => [] },
	},
	client: {
		ai: {
			processing: { notices: state.notices, grant: state.grant },
			operations: { retryTranslation: state.retryTranslation },
		},
	},
}));
vi.mock("../editor/proposals/review-operation", () => ({
	ReviewNotice: ({ children, actions }: { children: React.ReactNode; actions?: React.ReactNode }) => (
		<div>
			<p>{children}</p>
			{actions}
		</div>
	),
}));
vi.mock("../editor/proposals/review-client", () => ({ submitVariantDecision: vi.fn() }));
vi.mock("./clarification", () => ({
	Clarification: ({ questions }: { questions: Array<{ id: string; prompt: string; context?: string }> }) => (
		<>
			{questions.map((question) => (
				<div key={question.id}>
					<span>{question.id}</span>
					<p>{question.context}</p>
					<p>{question.prompt}</p>
				</div>
			))}
		</>
	),
}));
afterEach(() => {
	cleanup();
	state.mutate.mockReset();
	state.notices.mockReset();
	state.grant.mockReset();
	state.retryTranslation.mockReset();
	state.error = null;
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
			output: { segments: [{ sourceId: "source", text: "Generated target", claims: [] }] },
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
it.each([
	[["school"], "accepted", false],
	[[], "pending", false],
	[[], "accepted", true],
] as const)(
	"blocks final approval for unresolved terminology, unreviewed segments or stale source (%j)",
	(terms, segment, stale) => {
		show([...terms], segment, stale);
		const compare = screen.queryByRole("button", { name: "Compare with original" });
		if (compare) fireEvent.click(compare);
		expect(screen.getByRole("button", { name: "Approve language copy" }).hasAttribute("disabled")).toBe(true);
		// Expand the collapsed section to verify segment source and translation are rendered inside.
		fireEvent.click(screen.getByRole("button", { name: /Other sections/ }));
		expect(screen.getByText("النص الأصلي")).toBeDefined();
		expect(screen.getByText("Generated target")).toBeDefined();
	},
);
it("confirms 68 pending official names with one action while retaining per-name controls", () => {
	const names = Array.from({ length: 68 }, (_, index) => `term:official-${index}`);
	show(names, "accepted");
	fireEvent.click(screen.getByRole("button", { name: "Keep all names as they are" }));
	expect(state.mutate).toHaveBeenCalledWith({ subjectIds: names, decision: "accept" });
	expect(screen.getAllByRole("button", { name: "Confirm term" })).toHaveLength(68);
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
	expect(
		screen.getByText("Resolve the items below to finish and save your language copy automatically."),
	).toBeDefined();

	// Confirming the pending unique row sends all its occurrence IDs.
	const [firstPendingButton] = screen.getAllByRole("button", { name: "Confirm term" });
	expect(firstPendingButton).toBeDefined();
	if (firstPendingButton) fireEvent.click(firstPendingButton);
	const dialog = screen.getByRole("dialog");
	fireEvent.change(within(dialog).getByLabelText("Reviewed term"), { target: { value: "Riyadh University" } });
	fireEvent.click(within(dialog).getByRole("button", { name: "Confirm term" }));
	expect(state.mutate).toHaveBeenCalledWith({
		subjectIds: ["term:5", "term:6"],
		decision: "accept_edited",
		editedText: "Riyadh University",
	});
});

it("shows Translation ready when auto-applied and keeps per-part comparison optional", () => {
	show([], "accepted").unmount();
	(state.data.statuses as Record<string, string>).translation = "accepted";
	render(
		<I18nProvider i18n={i18n}>
			<TranslationReview operationId="operation" />
		</I18nProvider>,
	);
	expect(screen.getByText("Translation ready")).toBeDefined();
	expect(screen.queryByRole("button", { name: "Approve language copy" })).toBeNull();
	const compare = screen.getByRole("button", { name: "Compare with original" });
	fireEvent.click(compare);
	expect(screen.getByRole("button", { name: "Hide comparison" })).toBeDefined();
	expect(screen.getByRole("button", { name: /Other sections/ })).toBeDefined();
});

it("shows one-line all-confirmed message when 0 names need confirmation and enables Accept all", () => {
	show(
		[
			{ id: "term:1", source: "مجلس الواحة", value: "مجلس الواحة", status: "confirmed" },
			{ id: "term:2", source: "مجلس الواحة", value: "مجلس الواحة", status: "confirmed" },
		],
		"pending",
	);

	expect(screen.getByText("All names are confirmed.")).toBeDefined();
	expect(screen.getByText("Show 1 confirmed name")).toBeDefined();
	expect(screen.getByRole("status").textContent).toBe("0 of 1 accepted");
	const acceptAll = screen.getByRole("button", { name: "Accept all" });
	expect(acceptAll.hasAttribute("disabled")).toBe(false);
	fireEvent.click(acceptAll);
	expect(state.mutate).toHaveBeenCalledWith({ subjectIds: ["source"], decision: "accept" });
});

it("disables Accept all with a short reason while names still need confirmation", () => {
	show([{ id: "term:1", source: "جامعة الرياض", value: "جامعة الرياض", status: "pending" }], "pending");
	fireEvent.click(screen.getByRole("button", { name: "Compare with original" }));

	const acceptAll = screen.getByRole("button", { name: "Accept all" });
	expect(acceptAll.hasAttribute("disabled")).toBe(true);
	expect(screen.getByText("Confirm all names before accepting all segments.")).toBeDefined();
});

it("groups segments by CV section collapsed by default with per-section Accept section and scoped Accept all", () => {
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

	// Progress shows accepted out of total.
	expect(screen.getByText(`1 of ${inventory.segments.length} accepted`)).toBeDefined();

	// Sections are collapsed by default: per-segment Accept buttons are hidden until expanded.
	expect(screen.queryByRole("button", { name: "Accept" })).toBeNull();
	expect(screen.getByRole("button", { name: /Summary/ }).getAttribute("aria-expanded")).toBe("false");
	expect(screen.getByRole("button", { name: /Experience/ }).getAttribute("aria-expanded")).toBe("false");
	expect(screen.getByRole("button", { name: /Education/ }).getAttribute("aria-expanded")).toBe("false");

	// Accept all accepts only pending verified segments (excludes acceptedId and rejectedId).
	fireEvent.click(screen.getByRole("button", { name: "Accept all" }));
	const expectedPending = inventory.segments
		.map((seg) => seg.id)
		.filter((id) => id !== acceptedId && id !== rejectedId);
	expect(state.mutate).toHaveBeenCalledWith({ subjectIds: expectedPending, decision: "accept" });

	// Secondary Accept section for Experience accepts only Experience's pending segments.
	state.mutate.mockReset();
	const acceptSectionButtons = screen.getAllByRole("button", { name: "Accept section" });
	// Summary (index 0), Experience (index 1), Education (index 2).
	const experienceAcceptButton = acceptSectionButtons[1];
	expect(experienceAcceptButton).toBeDefined();
	if (experienceAcceptButton) fireEvent.click(experienceAcceptButton);
	expect(state.mutate).toHaveBeenCalledWith({
		subjectIds: experienceSegments.map((seg) => seg.id).filter((id) => id !== rejectedId),
		decision: "accept",
	});

	// Expanding Summary reveals per-segment Accept/Edit/Reject controls.
	fireEvent.click(screen.getByRole("button", { name: /Summary/ }));
	const pendingSummary = summarySegments.find(({ id }) => id !== acceptedId);
	if (!pendingSummary) throw new Error("Expected a pending summary segment");
	const pendingCard = within(screen.getByRole("region", { name: pendingSummary.id }));
	expect(pendingCard.getByRole("button", { name: "Accept" })).toBeDefined();
	expect(pendingCard.getByRole("button", { name: "Edit" })).toBeDefined();
	const pendingReject = pendingCard.getByRole("button", { name: "Reject" });
	const acceptedReject = within(screen.getByRole("region", { name: acceptedId })).getByRole("button", {
		name: "Reject",
	});
	expect(screen.getAllByRole("button", { name: "Reject" })).toHaveLength(2);
	expect(acceptedReject).not.toBe(pendingReject);
	state.mutate.mockReset();
	fireEvent.click(pendingReject);
	expect(state.mutate).toHaveBeenCalledExactlyOnceWith({ subjectIds: [pendingSummary.id], decision: "reject" });
});

it("enables final approval only after all segments and terminology are reviewed", () => {
	show([], "accepted");
	expect(screen.getByRole("button", { name: "Approve language copy" }).hasAttribute("disabled")).toBe(false);
});

it("shows contextual section/segment undo and a single labelled Undo last action before the Approve/Back footer", () => {
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
	data.metadata.layout.pages = [{ fullWidth: false, main: ["summary", "experience"], sidebar: [] }];

	const inventory = buildTranslationInventory(data);
	const summarySegments = inventory.segments.filter((seg) => seg.target.sectionId === "summary");
	const experienceSegments = inventory.segments.filter((seg) => seg.target.sectionId === "experience");
	const singleSummaryId = summarySegments[0]?.id ?? "";
	const experienceIds = experienceSegments.map((seg) => seg.id);

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
					status: seg.id === singleSummaryId || experienceIds.includes(seg.id) ? "accepted" : "pending",
				},
			]),
		),
		statuses: {
			translation: "pending",
			...Object.fromEntries(
				inventory.segments.map((seg) => [
					seg.id,
					seg.id === singleSummaryId || experienceIds.includes(seg.id) ? "accepted" : "pending",
				]),
			),
		},
		stale: false,
		undoable: [
			{ decisionId: "dec-sum-1", subjectIds: [singleSummaryId] },
			{ decisionId: "dec-exp-all", subjectIds: experienceIds },
		],
		answeredQuestionIds: [],
		dismissedQuestionIds: [],
	};

	render(
		<I18nProvider i18n={i18n}>
			<TranslationReview operationId="operation" sourceData={data} />
		</I18nProvider>,
	);

	// Exactly one "Undo last action" button with descriptive helper text, placed BEFORE the Approve/Back footer.
	const undoLastButton = screen.getByRole("button", { name: "Undo last action" });
	const approveButton = screen.getByRole("button", { name: "Approve language copy" });
	expect(screen.getAllByRole("button", { name: "Undo last action" })).toHaveLength(1);
	expect(screen.getByText(`Accepted section Experience · ${experienceIds.length} parts`)).toBeDefined();
	expect(Boolean(undoLastButton.compareDocumentPosition(approveButton) & Node.DOCUMENT_POSITION_FOLLOWING)).toBe(true);

	// Section-level small Undo appears ONLY on Experience (accepted via Accept section), NOT on partially-accepted Summary.
	const sectionUndoButtons = screen.getAllByRole("button", { name: "Undo" });
	expect(sectionUndoButtons).toHaveLength(1);
	if (sectionUndoButtons[0]) fireEvent.click(sectionUndoButtons[0]);
	expect(state.mutate).toHaveBeenCalledWith({
		subjectIds: experienceIds,
		decision: "undo",
		undoDecisionId: "dec-exp-all",
	});

	// Clicking "Undo last action" undoes the last action (Experience section).
	state.mutate.mockReset();
	fireEvent.click(undoLastButton);
	expect(state.mutate).toHaveBeenCalledWith({
		subjectIds: experienceIds,
		decision: "undo",
		undoDecisionId: "dec-exp-all",
	});

	// Expanding Summary shows Undo inside the accepted single segment card.
	state.mutate.mockReset();
	fireEvent.click(screen.getByRole("button", { name: /Summary/ }));
	const undoButtonsAfterExpand = screen.getAllByRole("button", { name: "Undo" });
	expect(undoButtonsAfterExpand).toHaveLength(2);
	const segmentUndo = undoButtonsAfterExpand[0];
	if (segmentUndo) fireEvent.click(segmentUndo);
	expect(state.mutate).toHaveBeenCalledWith({
		subjectIds: [singleSummaryId],
		decision: "undo",
		undoDecisionId: "dec-sum-1",
	});
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

	fireEvent.click(screen.getByRole("button", { name: "Compare with original" }));
	expect(screen.getByRole("button", { name: "Approve language copy" }).hasAttribute("disabled")).toBe(true);
});

it.each([
	[
		{ data: { reason: "TRANSLATION_LOCAL_VALUE_UNRESOLVED", segmentId: "source" } },
		"Could not approve because a protected placeholder could not be restored. Edit the marked segment in Other sections, then try again.",
	],
	[
		{ data: { reason: "TRANSLATION_REVIEW_INCOMPLETE" } },
		"Could not approve yet. Confirm all names and accept all segments before approving.",
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
	show(["school"], "accepted").unmount();
	(state.data.statuses as Record<string, string>).translation = status;
	render(
		<I18nProvider i18n={i18n}>
			<TranslationReview operationId="operation" />
		</I18nProvider>,
	);
	const compare = screen.queryByRole("button", { name: "Compare with original" });
	if (compare) fireEvent.click(compare);
	expect(screen.getByRole("button", { name: "Confirm term" }).hasAttribute("disabled")).toBe(true);
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
			<TranslationReview operationId="operation" />
		</I18nProvider>,
	);
	const report = within(screen.getByRole("region", { name: "report" }));
	expect(report.getByText("TypeScript and SAP required").getAttribute("dir")).toBe("auto");
	expect(report.getByText("No evidence found").getAttribute("dir")).toBeNull();
	expect(report.getByText("No supporting evidence was found in this CV.").getAttribute("dir")).toBe("auto");
	expect(screen.getAllByText(/TypeScript and SAP required/)).toHaveLength(2);
	expect(screen.queryByText(/no_evidence/)).toBeNull();
	expect(screen.getByText(/No evidence found/)).toBeDefined();
	expect(screen.getByText("What experience, study or project can you confirm for this requirement?")).toBeDefined();
	expect(screen.getAllByText(/No supporting evidence was found in this CV/)).toHaveLength(1);
	expect(screen.getByText("requirement")).toBeDefined();
});

it("explains partial job evidence with a visible recovery action", () => {
	i18n.loadAndActivate({ locale: "en-US", messages: {} });
	state.data = {
		result: {
			kind: "review.job-evidence",
			sourceRevision: { id: "cv" },
			output: {
				requirements: [{ id: "requirement", spanIds: ["job"], verdict: "partial", explanation: "Built services." }],
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
			<TranslationReview operationId="operation" />
		</I18nProvider>,
	);
	expect(
		screen.getByText(
			"Only part of the job requirement is supported by this CV. Add confirmed information or request a new review.",
		),
	).toBeDefined();
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
	expect(screen.getByText("2 items were withheld because they could not be verified.")).toBeDefined();
	expect(screen.getByText(/Supported backend experience\./)).toBeDefined();
});

it("does not repeat a single full job ad under every job-evidence item and shows plain withheld reasons without raw IDs", () => {
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
	expect(screen.getByText("Job requirement 3")).toBeVisible();
	expect(screen.getByText("The checked evidence did not support this finding.")).toBeVisible();
});

it("lists withheld job requirement spans with plain reasons when distinct spans exist and never raw IDs", () => {
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
	expect(screen.getByText(/Ten years of experience required\./)).toBeDefined();
	expect(screen.getByText(/Importance level was not stated explicitly in the job ad/)).toBeDefined();
	expect(screen.queryByText(/req-07/)).toBeNull();
});

it.each(["en-US", "ar-SA"] as const)("shows the withheld finding and reason in %s", (locale) => {
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
	expect(screen.getByText(/Ten years of experience required\./)).toBeDefined();
	expect(screen.getByText(locale === "ar-SA" ? "نتيجة غير متحقق منها" : "Unverified finding")).toBeVisible();
	expect(screen.getByText("The candidate meets the experience requirement.")).toBeVisible();
	expect(screen.getByText(locale === "ar-SA" ? /الأهمية/ : /Importance level was not stated explicitly/)).toBeVisible();
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
			expect(screen.getByText("2 items were withheld because they could not be verified.")).toBeDefined();
			expect(screen.getAllByText(/Could not be verified as an accurate translation/)).toHaveLength(2);
		}
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
			fireEvent.click(screen.getByRole("button", { name: "Compare with original" }));
			fireEvent.click(screen.getByRole("button", { name: /Other sections|Summary/ }));
			expect(screen.getAllByText("Not translated")).toHaveLength(2);
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
	expect(screen.getByText("لا حاجة إلى تعديل الملخص الحالي.")).toBeDefined();
	const closeButton = screen.getByRole("button", { name: "Close" });
	fireEvent.click(closeButton);
	expect(onClose).toHaveBeenCalledTimes(1);
});

it("lists each incomplete translation part with its own plain reason instead of a generic failure message", () => {
	i18n.loadAndActivate({ locale: "en-US", messages: {} });
	state.data = {
		result: {
			kind: "review.translation",
			sourceRevision: { id: "cv" },
			withheld: {
				count: 2,
				rules: ["AI_TIMEOUT", "AI_VERIFICATION_CLAIM_SUPPORT"],
				items: [
					{ id: "summary:0", reason: "AI_TIMEOUT", partIndex: 0 },
					{ id: "summary:1", reason: "AI_VERIFICATION_CLAIM_SUPPORT", partIndex: 2 },
				],
			},
			output: {
				direction: "en-ar",
				sourceRevision: "2026-01-01T00:00:00.000Z",
				segments: [
					{
						sourceId: "summary:0",
						text: "Original part 1.",
						claims: [{ id: "c1", kind: "translation", text: "Original part 1.", evidenceIds: ["summary:0"] }],
					},
					{
						sourceId: "summary:1",
						text: "Original part 3.",
						claims: [{ id: "c2", kind: "translation", text: "Original part 3.", evidenceIds: ["summary:1"] }],
					},
				],
				notes: [],
			},
		},
		sourceSegments: [
			{ id: "summary:0", text: "Original part 1." },
			{ id: "summary:1", text: "Original part 3." },
		],
		terms: { terms: [] },
		segments: {
			"summary:0": { text: "Original part 1.", status: "accepted", author: "model" },
			"summary:1": { text: "Original part 3.", status: "accepted", author: "model" },
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
	expect(screen.getByText(/Part 1:/)).toBeDefined();
	expect(screen.getByText(/ran out of time/i)).toBeDefined();
	expect(screen.getByText(/Part 3:/)).toBeDefined();
	expect(screen.getByText(/Could not be verified as an accurate translation/)).toBeDefined();
});
