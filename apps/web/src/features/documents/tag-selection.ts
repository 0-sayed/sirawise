import type { DocumentSummary } from "./filter";
import type { UiLocale } from "@reactive-resume/utils/locale";
import {
	countDocumentTags,
	documentTagKey,
	documentTagMaxCount,
	documentTagMaxLength,
	normalizeDocumentTag,
	normalizeDocumentTags,
	normalizeSearchText,
} from "@reactive-resume/utils/ui-format";

export type TagCount = { tag: string; count: number };
export type TagChange = { tag: string; selected: boolean };
export type TagLimitError = "length" | "count";
type Target = Pick<DocumentSummary, "type" | "id" | "tags" | "isLocked">;
type TagUpdate = Omit<Target, "isLocked">;

export function getTagOptions(library: readonly TagCount[], draft: string, locale: UiLocale) {
	const label = normalizeDocumentTag(draft);
	const searchKey = (value: string) => normalizeSearchText(normalizeDocumentTag(value)).toLocaleLowerCase(locale);
	const query = searchKey(label);
	const byName = new Intl.Collator(locale);
	const matches = library
		.filter(({ tag }) => searchKey(tag).includes(query))
		.sort((a, b) => b.count - a.count || byName.compare(a.tag, b.tag));
	const exact =
		matches.find(({ tag }) => documentTagKey(tag) === documentTagKey(label))?.tag ??
		matches.find(({ tag }) => searchKey(tag) === query)?.tag ??
		null;
	return { matches, exact, create: !exact && label && label.length <= documentTagMaxLength ? label : null };
}

export function readTagDraft(value: string) {
	const parts = value.split(/[,،]/u);
	return { draft: parts.pop() ?? "", completed: parts.map(normalizeDocumentTag).filter(Boolean) };
}

function applyChanges(tags: readonly string[], changes: readonly TagChange[]) {
	const next = new Map(normalizeDocumentTags(tags).map((tag) => [documentTagKey(tag), tag]));
	for (const { tag, selected } of changes) {
		const key = documentTagKey(tag);
		if (!selected) next.delete(key);
		else if (!next.has(key)) next.set(key, normalizeDocumentTag(tag));
	}
	return [...next.values()];
}

export function createTagSelection(documents: readonly Target[], changes: readonly TagChange[] = []) {
	return countDocumentTags(
		documents.filter(({ isLocked }) => !isLocked).map(({ tags }) => ({ tags: applyChanges(tags, changes) })),
	);
}

export function changeTagSelection(changes: readonly TagChange[], tag: string, selected: boolean): TagChange[] {
	const key = documentTagKey(tag);
	const index = changes.findIndex((change) => documentTagKey(change.tag) === key);
	if (index === -1) return [...changes, { tag, selected }];
	return changes.map((change, position) => (position === index ? { ...change, selected } : change));
}

export function getTagUpdates(documents: readonly Target[], changes: readonly TagChange[]) {
	const updates: TagUpdate[] = [];
	for (const { id, type, tags, isLocked } of documents) {
		if (isLocked) continue;
		const baseline = normalizeDocumentTags(tags);
		const next = applyChanges(baseline, changes);
		if (baseline.length === next.length && baseline.every((tag) => next.includes(tag))) continue;
		if (next.some((tag) => tag.length > documentTagMaxLength)) {
			return { error: "length", updates: [] } as const;
		}
		if (next.length > documentTagMaxCount) return { error: "count", updates: [] } as const;
		updates.push({ id, type, tags: next });
	}
	return { error: null, updates };
}

export function getLargestTagCount(documents: readonly Target[], changes: readonly TagChange[]) {
	return documents.reduce(
		(largest, { tags, isLocked }) => (isLocked ? largest : Math.max(largest, applyChanges(tags, changes).length)),
		0,
	);
}
