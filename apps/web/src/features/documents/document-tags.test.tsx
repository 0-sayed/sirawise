import type { DocumentSummary } from "./filter";
// @vitest-environment happy-dom
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vite-plus/test";
import { i18n } from "@lingui/core";
import { I18nProvider } from "@lingui/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { TagsDialog } from "./document-actions";

const setTags = vi.hoisted(() => vi.fn());
vi.mock("@/libs/orpc/client", () => ({
	orpc: {
		documents: {
			key: () => ["documents"],
			setTags: { mutationOptions: () => ({ mutationFn: (input: unknown) => setTags(input) }) },
		},
		resume: { list: { key: () => ["resumes"] } },
	},
}));

const document: DocumentSummary = {
	id: "cv",
	name: "Synthetic CV",
	type: "resume",
	tags: ["Existing"],
	isLocked: false,
	isPublic: false,
	slug: null,
	trashedAt: null,
	createdAt: new Date(),
	updatedAt: new Date(),
	metadata: null,
	letterStatus: null,
	application: null,
};

const libraryTags = [
	{ tag: "Work", count: 3 },
	{ tag: "Existing", count: 1 },
];

beforeEach(() => {
	i18n.loadAndActivate({ locale: "en-US", messages: {} });
	setTags.mockReset().mockResolvedValue(undefined);
});

function show(documents = [document]) {
	const onClose = vi.fn();
	render(
		<I18nProvider i18n={i18n}>
			<QueryClientProvider client={new QueryClient()}>
				<TagsDialog documents={documents} libraryTags={libraryTags} locale="en-US" onClose={onClose} />
			</QueryClientProvider>
		</I18nProvider>,
	);
	return { dialog: within(screen.getByRole("dialog")), onClose };
}

it("saves the last pending tag after comma-separated entry", async () => {
	const { dialog, onClose } = show();
	fireEvent.change(dialog.getByRole("combobox"), { target: { value: "First, FIRST،  Final tag  " } });
	fireEvent.click(dialog.getByRole("button", { name: "Save" }));
	await waitFor(() => expect(onClose).toHaveBeenCalledOnce());
	expect(setTags).toHaveBeenCalledExactlyOnceWith({
		type: "resume",
		id: "cv",
		tags: ["Existing", "First", "Final tag"],
	});
});

it("saves a replacement tag when Save is clicked directly after removing a chip", async () => {
	const { dialog, onClose } = show();
	fireEvent.click(dialog.getByRole("button", { name: "Remove tag Existing" }));
	fireEvent.change(dialog.getByRole("combobox"), { target: { value: "Renamed" } });
	fireEvent.click(dialog.getByRole("button", { name: "Save" }));
	await waitFor(() => expect(onClose).toHaveBeenCalledOnce());
	expect(setTags).toHaveBeenCalledExactlyOnceWith({ type: "resume", id: "cv", tags: ["Renamed"] });
});

it("shows an inline error and retries the same tags", async () => {
	setTags.mockRejectedValueOnce(new Error("offline"));
	const { dialog, onClose } = show();
	const input = dialog.getByRole("combobox");
	fireEvent.change(input, { target: { value: "New tag" } });
	fireEvent.keyDown(input, { key: "Enter" });
	fireEvent.click(dialog.getByRole("button", { name: "Save" }));
	expect(await dialog.findByRole("alert")).toHaveAttribute("data-slot", "alert");
	expect(onClose).not.toHaveBeenCalled();
	expect(dialog.getByRole("button", { name: "Remove tag New tag" })).toBeVisible();
	fireEvent.click(dialog.getByRole("button", { name: "Save" }));
	await waitFor(() => expect(onClose).toHaveBeenCalledOnce());
	expect(setTags).toHaveBeenCalledTimes(2);
	expect(setTags).toHaveBeenLastCalledWith({ type: "resume", id: "cv", tags: ["Existing", "New tag"] });
});

it("shows existing tags by usage, reuses their spelling, and reports limits before saving", async () => {
	const { dialog } = show();
	const [first, second] = dialog.getAllByRole("option");
	expect(first).toHaveAccessibleName("Work 3");
	expect(second).toHaveAccessibleName("Existing 1");
	const input = dialog.getByRole("combobox");
	const save = dialog.getByRole("button", { name: "Save" });
	fireEvent.change(input, { target: { value: "x".repeat(41) } });
	expect(dialog.getByRole("alert")).toHaveTextContent("Tag must be 40 characters or fewer.");
	expect(dialog.getByText("41/40")).toBeVisible();
	expect(save).toBeDisabled();
	fireEvent.change(input, { target: { value: " work " } });
	expect(dialog.queryByRole("option", { name: /Create/ })).toBeNull();
	fireEvent.keyDown(input, { key: "،" });
	fireEvent.click(save);
	await waitFor(() =>
		expect(setTags).toHaveBeenCalledExactlyOnceWith({
			type: "resume",
			id: "cv",
			tags: ["Existing", "Work"],
		}),
	);
});

it("shows mixed tags and saves only explicit changes on editable documents", async () => {
	const { dialog } = show([
		document,
		{ ...document, id: "other", tags: ["Personal"] },
		{ ...document, id: "locked", tags: ["Locked"], isLocked: true },
	]);
	expect(dialog.getByRole("option", { name: /Existing/ })).toHaveAttribute("aria-checked", "mixed");
	expect(dialog.getByText("Locked documents keep their current tags.")).toBeVisible();
	fireEvent.click(dialog.getByRole("option", { name: /Existing/ }));
	expect(dialog.getByRole("option", { name: /Existing/ })).toHaveAttribute("aria-checked", "true");
	fireEvent.click(dialog.getByRole("button", { name: "Save" }));
	await waitFor(() =>
		expect(setTags).toHaveBeenCalledExactlyOnceWith({
			type: "resume",
			id: "other",
			tags: ["Personal", "Existing"],
		}),
	);
});
