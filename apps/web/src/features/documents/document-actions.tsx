import type { DocumentSummary } from "./filter";
import type { TagSelectionAction } from "./tag-picker";
import type { TagChange, TagCount, TagLimitError } from "./tag-selection";
import type { IconName } from "@reactive-resume/ui/components/icon";
import type { UiLocale } from "@reactive-resume/utils/locale";
import { plural, t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import { ORPCError } from "@orpc/client";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import { useCopyToClipboard } from "usehooks-ts";
import { isFeatureAvailable } from "@reactive-resume/schema/personal-tools";
import { Alert, AlertDescription, AlertTitle } from "@reactive-resume/ui/components/alert";
import { Button } from "@reactive-resume/ui/components/button";
import { ContextMenuContent, ContextMenuItem, ContextMenuSeparator } from "@reactive-resume/ui/components/context-menu";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "@reactive-resume/ui/components/dialog";
import {
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuSeparator,
} from "@reactive-resume/ui/components/dropdown-menu";
import { Icon } from "@reactive-resume/ui/components/icon";
import { toast } from "@reactive-resume/ui/components/toast";
import { documentTagKey, documentTagMaxLength, normalizeDocumentTag } from "@reactive-resume/utils/ui-format";
import { publicResumeUrl } from "./filter";
import { useNewDocumentsStore } from "./new-documents";
import { TagPicker } from "./tag-picker";
import {
	changeTagSelection,
	createTagSelection,
	getLargestTagCount,
	getTagOptions,
	getTagUpdates,
	readTagDraft,
} from "./tag-selection";
import { QueryListState } from "@/components/query-list-state";
import { useDialogStore } from "@/dialogs/store";
import { ApplicationPicker } from "@/features/applications/components/application-picker";
import { applicationsListQueryOptions } from "@/features/applications/queries";
import { usePersonalToolAvailable } from "@/features/personal-tools/availability";
import { getAllowanceReason } from "@/features/usage/allowance-limit";
import { useClosingValue } from "@/hooks/use-closing-value";
import { useConfirm } from "@/hooks/use-confirm";
import { useCurrentSession } from "@/hooks/use-current-session";
import { getOrpcErrorMessage } from "@/libs/error-message";
import { orpc } from "@/libs/orpc/client";

type Ref = { type: DocumentSummary["type"]; id: string };
const ref = (document: DocumentSummary): Ref => ({ type: document.type, id: document.id });
// The shared confirmation accepts plain strings. FSI/PDI give each user-supplied name its own direction.
const isolateName = (name: string) => `\u2068${name}\u2069`;

const failed = (error: unknown) =>
	toast.add({
		type: "error",
		description: getOrpcErrorMessage(error, { fallback: t`Something went wrong. Try again.` }),
	});

/** Everything the card menu does, shared by grid cards, list rows and Trash. */
function useRefreshDocuments() {
	const queryClient = useQueryClient();
	return () =>
		Promise.all([
			queryClient.invalidateQueries({ queryKey: orpc.documents.key() }),
			queryClient.invalidateQueries({ queryKey: orpc.resume.list.key() }),
		]);
}

export function useDocumentActions() {
	const confirm = useConfirm();
	const navigate = useNavigate();
	const openDialog = useDialogStore((state) => state.openDialog);
	const markNew = useNewDocumentsStore((state) => state.markNew);
	const refresh = useRefreshDocuments();

	const rename = useMutation(orpc.documents.rename.mutationOptions({ onSettled: refresh, onError: failed }));
	const setLocked = useMutation(orpc.documents.setLocked.mutationOptions({ onSettled: refresh, onError: failed }));
	const trash = useMutation(orpc.documents.trash.mutationOptions({ onSettled: refresh }));
	const restore = useMutation(orpc.documents.restore.mutationOptions({ onSettled: refresh }));
	const purge = useMutation(orpc.documents.purge.mutationOptions({ onSettled: refresh }));
	const duplicateResume = useMutation(orpc.resume.duplicate.mutationOptions({ onSettled: refresh }));
	const duplicateLetter = useMutation(orpc.coverLetters.duplicate.mutationOptions({ onSettled: refresh }));

	return {
		rename: (document: DocumentSummary, name: string) => {
			const trimmed = name.trim();
			if (!trimmed || trimmed === document.name) return;
			rename.mutate({ ...ref(document), name: trimmed });
		},

		duplicate: async (document: DocumentSummary) => {
			const copied =
				document.type === "resume"
					? duplicateResume.mutateAsync({ id: document.id, name: t`${document.name} (copy)`, tags: document.tags })
					: duplicateLetter
							.mutateAsync({ id: document.id, name: t`${document.name} (copy)` })
							.then((letter) => letter.id);
			try {
				markNew(await copied);
				toast.add({ description: t`Duplicated` });
			} catch (error) {
				if (getAllowanceReason(error)) {
					toast.add({
						type: "error",
						description: getOrpcErrorMessage(error, { fallback: t`Something went wrong. Try again.` }),
						actionProps: {
							children: t`Open`,
							onClick: () => {
								if (document.type === "resume")
									void navigate({ to: "/builder/$resumeId", params: { resumeId: document.id } });
								else void navigate({ to: "/builder/letter/$coverLetterId", params: { coverLetterId: document.id } });
							},
						},
					});
				} else failed(error);
			}
		},

		copyForJob: (document: DocumentSummary) =>
			openDialog("document.new", { step: "copy", sourceResumeId: document.id }),

		setLocked: (document: DocumentSummary, isLocked: boolean) => setLocked.mutate({ ...ref(document), isLocked }),

		/** Undoable, so it doesn't ask first. */
		trash: async (document: DocumentSummary) => {
			try {
				await trash.mutateAsync(ref(document));
				toast.add({
					description: t`“${document.name}” moved to Trash`,
					actionProps: {
						children: t`Undo`,
						onClick: () => restore.mutate(ref(document), { onError: failed }),
					},
				});
			} catch (error) {
				failed(error);
			}
		},

		restore: async (document: DocumentSummary) => {
			try {
				await restore.mutateAsync(ref(document));
				toast.add({
					description: t`Restored “${document.name}”`,
					actionProps: {
						children: t`Open`,
						onClick: () => {
							if (document.type === "resume")
								void navigate({ to: "/builder/$resumeId", params: { resumeId: document.id } });
							else void navigate({ to: "/builder/letter/$coverLetterId", params: { coverLetterId: document.id } });
						},
					},
				});
			} catch (error) {
				failed(error);
			}
		},

		/** The only permanent action here; it asks once. */
		purge: async (document: DocumentSummary) => {
			const name = isolateName(document.name);
			const confirmed = await confirm(t({ message: `Delete “${name}” forever?`, context: "trash.confirm.item" }), {
				description: t`It will be deleted for good and can't be restored.`,
				confirmText: t({ message: "Delete forever", context: "trash.actions.purge" }),
				variant: "danger",
				cancelText: t`Keep in Trash`,
			});
			if (!confirmed) return;
			try {
				await purge.mutateAsync(ref(document));
				toast.add({ description: t`Deleted “${document.name}”` });
			} catch (error) {
				failed(error);
			}
		},
	};
}

/**
 * The selection bar's actions: each runs on every selected document it applies to, refreshes the library once and
 * says how many changed. Locked documents keep their visibility, tags and place; letters have no public link.
 */
export function useBatchActions() {
	const confirm = useConfirm();
	const purge = useMutation(orpc.documents.purge.mutationOptions());
	const refresh = useRefreshDocuments();
	const setLocked = useMutation(orpc.documents.setLocked.mutationOptions());
	const trash = useMutation(orpc.documents.trash.mutationOptions());
	const restore = useMutation(orpc.documents.restore.mutationOptions());
	const updateResume = useMutation(orpc.resume.update.mutationOptions());

	const run = async (
		documents: readonly DocumentSummary[],
		applies: (document: DocumentSummary) => boolean,
		task: (document: DocumentSummary) => Promise<unknown>,
	) => {
		const targets = documents.filter(applies);
		const results = await Promise.allSettled(targets.map(task));
		await refresh();
		return targets.filter((_, index) => results[index]?.status === "fulfilled");
	};

	const report = (done: number, total: number) =>
		toast.add({
			type: done === 0 ? "error" : undefined,
			description:
				done === total
					? plural(done, { one: "# document updated", other: "# documents updated" })
					: t`Updated ${done} of ${total}. Locked documents, and letters for public links, were skipped.`,
		});

	return {
		restore: async (documents: readonly DocumentSummary[]) => {
			const done = await run(
				documents,
				() => true,
				(document) => restore.mutateAsync(ref(document)),
			);
			const count = done.length;
			const total = documents.length;
			toast.add({
				type: count < total ? "error" : undefined,
				description: plural(total, {
					one: `Restored ${count} of # document.`,
					other: `Restored ${count} of # documents.`,
				}),
			});
		},
		purge: async (documents: readonly DocumentSummary[], empty = false) => {
			const count = documents.length;
			const names = documents.map((document) => isolateName(document.name)).join(", ");
			const confirmed = await confirm(
				empty
					? t({ message: "Empty trash?", context: "trash.confirm.empty" })
					: plural(count, {
							one: "Delete # selected document forever?",
							other: "Delete # selected documents forever?",
						}),
				{
					description: t({ message: `These documents cannot be restored: ${names}`, context: "trash.confirm.scope" }),
					confirmText: t({ message: "Delete forever", context: "trash.actions.purge" }),
					variant: "danger",
					cancelText: t`Keep in Trash`,
				},
			);
			if (!confirmed) return;
			const done = await run(
				documents,
				() => true,
				(document) => purge.mutateAsync(ref(document)),
			);
			const deleted = done.length;
			toast.add({
				type: deleted < count ? "error" : undefined,
				description: plural(count, {
					one: `Deleted ${deleted} of # document. Failed items remain in Trash.`,
					other: `Deleted ${deleted} of # documents. Failed items remain in Trash.`,
				}),
			});
		},
		setPublic: async (documents: readonly DocumentSummary[], isPublic: boolean) => {
			const done = await run(
				documents,
				(document) => document.type === "resume" && !document.isLocked && document.isPublic !== isPublic,
				(document) => updateResume.mutateAsync({ id: document.id, isPublic }),
			);
			// Already in that state counts as done.
			report(done.length + documents.filter((document) => document.isPublic === isPublic).length, documents.length);
		},

		setLocked: async (documents: readonly DocumentSummary[], isLocked: boolean) => {
			const done = await run(
				documents,
				(document) => document.isLocked !== isLocked,
				(document) => setLocked.mutateAsync({ type: document.type, id: document.id, isLocked }),
			);
			report(done.length + documents.filter((document) => document.isLocked === isLocked).length, documents.length);
		},

		/** Undoable, so it doesn't ask first. */
		trash: async (documents: readonly DocumentSummary[]) => {
			const done = await run(
				documents,
				(document) => !document.isLocked,
				(document) => trash.mutateAsync({ type: document.type, id: document.id }),
			);
			if (done.length === 0) return report(0, documents.length);
			toast.add({
				description:
					done.length === documents.length
						? plural(done.length, { one: "# document moved to Trash", other: "# documents moved to Trash" })
						: t`Moved ${done.length} of ${documents.length} to Trash. Locked documents were skipped.`,
				actionProps: {
					children: t`Undo`,
					onClick: () =>
						void run(
							done,
							() => true,
							(document) => restore.mutateAsync({ type: document.type, id: document.id }),
						),
				},
			});
		},
	};
}

type MenuEntry = { icon: IconName; label: string; onSelect: () => void; disabled?: boolean; danger?: boolean };

type DocumentMenuProps = {
	document: DocumentSummary;
	onOpen: () => void;
	onRename: () => void;
	onTags: () => void;
	onLink: () => void;
	/** Starts a selection with this document; absent in the list, which always shows its checkboxes, and in Trash. */
	onSelect?: (() => void) | undefined;
	/** The same items as a context menu (right-click and long-press) instead of the ⋯ menu. */
	variant?: "dropdown" | "context";
};

/** Open, Copy public link, Rename, Duplicate, Copy for a job (or Link to application), Tags, Lock, then Move to Trash. */
export function DocumentMenuContent({
	document,
	onOpen,
	onRename,
	onTags,
	onLink,
	onSelect,
	variant = "dropdown",
}: DocumentMenuProps) {
	const actions = useDocumentActions();
	const navigate = useNavigate();
	const session = useCurrentSession();
	const applicationsEnabled = usePersonalToolAvailable("applications");
	const [, copy] = useCopyToClipboard();
	const url = publicResumeUrl(document, session?.user.username);

	const trashEntries: MenuEntry[] = [
		{ icon: "arrow-counter-clockwise", label: t`Restore`, onSelect: () => void actions.restore(document) },
		{
			icon: "trash",
			label: t({ message: "Delete forever", context: "trash.actions.purge" }),
			onSelect: () => void actions.purge(document),
			danger: true,
		},
	];
	const liveEntries: MenuEntry[] = [
		{ icon: "arrow-square-out", label: t`Open`, onSelect: onOpen },
		...(isFeatureAvailable("publicSharing") && url
			? [
					{
						icon: "link-simple-horizontal",
						label: t`Copy public link`,
						onSelect: () => void copy(url).then((copied) => copied && toast.add({ description: t`Link copied` })),
					} satisfies MenuEntry,
				]
			: []),
		...(onSelect ? [{ icon: "check-square", label: t`Select`, onSelect } satisfies MenuEntry] : []),
		{ icon: "pencil-simple", label: t`Rename`, onSelect: onRename, disabled: document.isLocked },
		{ icon: "copy", label: t`Duplicate`, onSelect: () => void actions.duplicate(document) },
		...(document.type === "resume"
			? [
					{
						icon: "briefcase",
						label: t`Copy for a job…`,
						onSelect: () =>
							void navigate({ to: "/dashboard/resumes/$resumeId/job", params: { resumeId: document.id } }),
					} satisfies MenuEntry,
				]
			: applicationsEnabled
				? [
						{
							icon: "briefcase",
							label: t`Link to application…`,
							onSelect: onLink,
							disabled: document.isLocked,
						} satisfies MenuEntry,
					]
				: []),
		...(document.type === "resume"
			? [
					{
						icon: "translate",
						label: t`Copies and languages`,
						onSelect: () =>
							void navigate({ to: "/dashboard/resumes/$resumeId/languages", params: { resumeId: document.id } }),
					} satisfies MenuEntry,
				]
			: []),
		{ icon: "tag", label: t`Tags…`, onSelect: onTags, disabled: document.isLocked },
		document.isLocked
			? { icon: "lock-open", label: t`Unlock`, onSelect: () => actions.setLocked(document, false) }
			: { icon: "lock", label: t`Lock editing`, onSelect: () => actions.setLocked(document, true) },
		{
			icon: "trash",
			label: t`Move to Trash`,
			onSelect: () => void actions.trash(document),
			danger: true,
			disabled: document.isLocked,
		},
	];
	const entries = document.trashedAt ? trashEntries : liveEntries;

	const Content = variant === "context" ? ContextMenuContent : DropdownMenuContent;
	const Item = variant === "context" ? ContextMenuItem : DropdownMenuItem;
	const Separator = variant === "context" ? ContextMenuSeparator : DropdownMenuSeparator;

	return (
		<Content align="end" className="w-60">
			{entries.map((entry) => (
				<div key={entry.label} className="contents">
					{entry.danger && <Separator />}
					<Item
						variant={entry.danger ? "destructive" : "default"}
						disabled={entry.disabled}
						onClick={entry.onSelect}
						title={entry.disabled ? t`Unlock it first` : undefined}
					>
						<Icon name={entry.icon} />
						{entry.label}
					</Item>
				</div>
			))}
		</Content>
	);
}

type TagsDialogProps = {
	documents: DocumentSummary[] | null;
	libraryTags: readonly TagCount[];
	locale: UiLocale;
	onClose: () => void;
};

function tagSaveError(error: unknown) {
	if (error instanceof ORPCError && error.code === "BAD_REQUEST") {
		const data: unknown = error.data;
		if (typeof data === "object" && data !== null && "issues" in data && Array.isArray(data.issues)) {
			for (const issue of data.issues) {
				if (issue?.code !== "too_big" || issue.path?.[0] !== "tags" || typeof issue.maximum !== "number") continue;
				const limit = issue.maximum;
				if (issue.origin === "string") return t`Shorten each tag to ${limit} characters or fewer.`;
				if (issue.origin === "array") return t`Use ${limit} tags or fewer per document.`;
			}
		}
	}
	return getOrpcErrorMessage(error, { fallback: t`Something went wrong. Try again.` });
}

export function TagsDialog({ documents: requested, libraryTags, locale, onClose }: TagsDialogProps) {
	const refresh = useRefreshDocuments();
	const [documents, onDocumentsOpenChangeComplete] = useClosingValue(requested);
	const [changes, setChanges] = useState<TagChange[]>([]);
	const [draft, setDraft] = useState("");
	const [inputError, setInputError] = useState<TagLimitError | null>(null);
	const [saveError, setSaveError] = useState<string | null>(null);
	const [saving, setSaving] = useState(false);
	const [savedTags, setSavedTags] = useState<Record<string, string[]>>({});
	const setDocumentTags = useMutation(orpc.documents.setTags.mutationOptions());

	const targets = (documents ?? []).map((document) => ({
		...document,
		tags: savedTags[`${document.type}:${document.id}`] ?? document.tags,
	}));
	const targetCount = targets.filter((document) => !document.isLocked).length;
	const selected = createTagSelection(targets, changes);
	const selectedCounts = new Map(selected.map(({ tag, count }) => [documentTagKey(tag), count]));
	const libraryKeys = new Set(libraryTags.map(({ tag }) => documentTagKey(tag)));
	const candidates = [
		...libraryTags,
		...selected.filter(({ tag }) => !libraryKeys.has(documentTagKey(tag))).map(({ tag }) => ({ tag, count: 0 })),
	];
	const options = getTagOptions(draft.trim() ? candidates : libraryTags, draft, locale);
	const { completed, draft: pending } = readTagDraft(draft);
	const pendingTags = [...completed, normalizeDocumentTag(pending)].filter(Boolean);
	const draftLength = Math.max(0, ...pendingTags.map((tag) => tag.length));
	const resolveTag = (tag: string) => getTagOptions(candidates, tag, locale).exact ?? tag;
	const preview =
		draftLength > documentTagMaxLength
			? { error: "length" as const, updates: [] }
			: getTagUpdates(
					targets,
					pendingTags.reduce((next, tag) => changeTagSelection(next, resolveTag(tag), true), changes),
				);

	function select(tag: string, action: TagSelectionAction) {
		const selected =
			action === "add" || (action === "toggle" && selectedCounts.get(documentTagKey(tag)) !== targetCount);
		const next = changeTagSelection(changes, tag, selected);
		const { error } = getTagUpdates(targets, next);
		setInputError(error);
		if (error) return;
		setChanges(next);
		if (action !== "remove") setDraft("");
	}

	function changeDraft(value: string, composing: boolean) {
		setInputError(null);
		if (composing) {
			setDraft(value);
			return;
		}
		const { completed, draft } = readTagDraft(value);
		let next = changes;
		for (const [index, label] of completed.entries()) {
			const updated = changeTagSelection(next, resolveTag(label), true);
			const error = label.length > documentTagMaxLength ? "length" : getTagUpdates(targets, updated).error;
			if (error) {
				setChanges(next);
				setDraft([...completed.slice(index), draft].join(", "));
				setInputError(error);
				return;
			}
			next = updated;
		}
		setChanges(next);
		setDraft(draft);
	}

	async function save() {
		if (saving || preview.error || preview.updates.length === 0) return;
		setSaving(true);
		setSaveError(null);
		try {
			const results = await Promise.allSettled(preview.updates.map((update) => setDocumentTags.mutateAsync(update)));
			const succeeded = Object.fromEntries(
				preview.updates.flatMap(({ type, id, tags }, index) =>
					results[index]?.status === "fulfilled" ? [[`${type}:${id}`, tags]] : [],
				),
			);
			const failure = results.find((result) => result.status === "rejected");
			if (failure) {
				setSavedTags((previous) => ({ ...previous, ...succeeded }));
				setSaveError(tagSaveError(failure.reason));
			}
			await refresh();
			if (!failure) onClose();
		} finally {
			setSaving(false);
		}
	}

	const count = documents?.length ?? 0;
	return (
		<Dialog
			open={requested !== null}
			onOpenChange={(open) => !open && !saving && onClose()}
			onOpenChangeComplete={(open) => {
				onDocumentsOpenChangeComplete(open);
				if (!open) {
					setChanges([]);
					setDraft("");
					setInputError(null);
					setSaveError(null);
					setSavedTags({});
				}
			}}
		>
			<DialogContent>
				<DialogHeader>
					<DialogTitle>
						{count > 1 ? (
							plural(count, { one: "Tags for # document", other: "Tags for # documents" })
						) : (
							<Trans>Tags</Trans>
						)}
					</DialogTitle>
					<DialogDescription>
						{count > 1 ? (
							<Trans>Tags marked with a dash apply to some selected documents.</Trans>
						) : (
							<Trans>Organize documents with tags so you can filter them in the library.</Trans>
						)}
					</DialogDescription>
				</DialogHeader>
				{documents?.some((document) => document.isLocked) && (
					<Alert variant="info">
						<Icon name="info" />
						<AlertDescription>
							<Trans>Locked documents keep their current tags.</Trans>
						</AlertDescription>
					</Alert>
				)}
				<TagPicker
					options={options}
					selected={selected}
					targetCount={targetCount}
					largestTagCount={getLargestTagCount(targets, changes)}
					draft={draft}
					draftLength={draftLength}
					error={preview.error ?? inputError}
					disabled={saving || targetCount === 0}
					onDraftChange={changeDraft}
					onSelect={select}
				/>
				{saveError && (
					<Alert variant="error">
						<Icon name="warning-circle" />
						<AlertTitle>
							<Trans>Could not save tags</Trans>
						</AlertTitle>
						<AlertDescription>{saveError}</AlertDescription>
					</Alert>
				)}
				<DialogFooter>
					<Button variant="secondary" disabled={saving} onClick={onClose}>
						<Trans>Cancel</Trans>
					</Button>
					<Button
						variant="primary"
						onClick={() => void save()}
						loading={saving}
						disabled={Boolean(preview.error) || preview.updates.length === 0}
					>
						{saving ? <Trans>Saving…</Trans> : <Trans>Save</Trans>}
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}

type LinkApplicationDialogProps = { document: DocumentSummary | null; onClose: () => void };

/** Link to application… for letters: the job the letter is for. */
export function LinkApplicationDialog({ document: requested, onClose }: LinkApplicationDialogProps) {
	const queryClient = useQueryClient();
	// Closing keeps the list, its highlight and Unlink on screen until the dialog has faded out.
	const [document, onOpenChangeComplete] = useClosingValue(requested);
	const applicationsEnabled = usePersonalToolAvailable("applications");
	const query = useQuery({ ...applicationsListQueryOptions(), enabled: requested !== null && applicationsEnabled });
	const link = useMutation(orpc.documents.linkApplication.mutationOptions());

	const choose = async (applicationId: string | null) => {
		if (!document) return;
		try {
			await link.mutateAsync({ type: document.type, id: document.id, applicationId });
			await queryClient.invalidateQueries({ queryKey: orpc.documents.key() });
			onClose();
		} catch (error) {
			failed(error);
		}
	};

	const jobs = query.data ?? [];

	return (
		<Dialog
			open={requested !== null}
			onOpenChange={(open) => !open && onClose()}
			onOpenChangeComplete={onOpenChangeComplete}
		>
			<DialogContent>
				<DialogHeader>
					<DialogTitle>
						<Trans>Link to application</Trans>
					</DialogTitle>
					<DialogDescription>
						<Trans>The application this letter is for.</Trans>
					</DialogDescription>
				</DialogHeader>
				<div className="grid gap-1">
					<QueryListState
						query={query}
						empty={jobs.length === 0}
						loadingMessage={<Trans>Loading applications…</Trans>}
						errorMessage={<Trans>Couldn't load this. Your saved data hasn't changed.</Trans>}
						emptyMessage={<Trans>No applications yet. Add one in Applications first.</Trans>}
					>
						<ApplicationPicker
							aria-label={t`Link to application`}
							applications={jobs}
							value={document?.application?.id ?? null}
							disabled={link.isPending}
							onValueChange={(id) => void choose(id)}
						/>
					</QueryListState>
				</div>
				{document?.application && (
					<DialogFooter>
						<Button variant="ghost" disabled={link.isPending} onClick={() => void choose(null)}>
							<Trans>Unlink</Trans>
						</Button>
					</DialogFooter>
				)}
			</DialogContent>
		</Dialog>
	);
}
