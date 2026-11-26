import type { UiLocale } from "./locale";
import { normalizeNumericDigits } from "./string";
export function formatUiNumber(value: number, locale: UiLocale, options: Intl.NumberFormatOptions): string {
	return new Intl.NumberFormat(locale, { ...options, numberingSystem: "latn" }).format(value);
}
/** Application instants only. CV dates can be partial, Hijri or free text and must never enter this API. */
export function formatUiTimestamp(value: Date, locale: UiLocale, options: Intl.DateTimeFormatOptions): string {
	return new Intl.DateTimeFormat(locale, {
		timeZone: "Asia/Riyadh",
		...options,
		calendar: "gregory",
		numberingSystem: "latn",
	}).format(value);
}
export function normalizeSearchText(value: string): string {
	return normalizeNumericDigits(value.normalize("NFC")).replace(
		/[\u0610-\u061A\u0640\u064B-\u065F\u0670\u06D6-\u06ED]/gu,
		"",
	);
}

export const documentTagMaxLength = 40;
export const documentTagMaxCount = 20;

export const normalizeDocumentTag = (tag: string) => tag.trim().replace(/\s+/gu, " ");
export const documentTagKey = (tag: string) => normalizeDocumentTag(tag).normalize("NFC").toLowerCase();

/** Keep the first spelling of each tag and preserve their order. */
export function normalizeDocumentTags(tags: readonly string[]) {
	const unique = new Map<string, string>();
	for (const tag of tags) {
		const key = documentTagKey(tag);
		if (key && !unique.has(key)) unique.set(key, normalizeDocumentTag(tag));
	}
	return [...unique.values()];
}

/** Each document contributes at most one use, even when it has legacy duplicate spellings. */
export function countDocumentTags(documents: readonly { tags: readonly string[] }[]) {
	const counts = new Map<string, { tag: string; count: number }>();
	for (const { tags } of documents) {
		for (const tag of normalizeDocumentTags(tags)) {
			const key = documentTagKey(tag);
			const entry = counts.get(key);
			if (entry) entry.count += 1;
			else counts.set(key, { tag, count: 1 });
		}
	}
	return [...counts.values()];
}
