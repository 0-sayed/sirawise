import type { ProtectedTranslation } from "./translation-invariants";
import { protectTranslationPlaceholders } from "@reactive-resume/resume/translation";
import { redactModelText } from "./payload";

const UNRESOLVED_PLACEHOLDER_PATTERN = /\[(?:redacted|LOCAL[\s_-]*[\d٠-٩۰-۹]+|NAME[\s_-]*[\d٠-٩۰-۹]+)\]/iu;

function toAsciiDigits(value: string): string {
	return value.replace(/[٠-٩۰-۹]/gu, (digit) => {
		const code = digit.codePointAt(0) ?? 0;
		if (code >= 0x0660 && code <= 0x0669) return String(code - 0x0660);
		if (code >= 0x06f0 && code <= 0x06f9) return String(code - 0x06f0);
		return digit;
	});
}

export function translationPlaceholderOccurrences(text: string) {
	return [...text.matchAll(/\[(redacted|LOCAL[\s_-]*([\d٠-٩۰-۹]+)|NAME[\s_-]*([\d٠-٩۰-۹]+))\]/giu)].map(
		([raw, , local, name]) => ({
			raw,
			token: local ? `[LOCAL_${toAsciiDigits(local)}]` : name ? `[NAME_${toAsciiDigits(name)}]` : "[redacted]",
		}),
	);
}

export function hasUnresolvedTranslationPlaceholder(text: string): boolean {
	return UNRESOLVED_PLACEHOLDER_PATTERN.test(text);
}

/**
 * Restores protected [LOCAL_n] tokens (including model casing/spacing/Arabic-digit variants)
 * and inline [redacted] values using only the owner's local source text, never sending real values to AI.
 */
export function resolveTranslationText({
	text,
	sourceText,
	placeholders,
	terms,
	contactValues,
	basicsName,
	termValue,
	scope,
}: {
	text: string;
	sourceText?: string | undefined;
	placeholders: ReadonlyArray<{ token: string; value: string }>;
	terms: ReadonlyArray<{ source: string; value: string }>;
	contactValues: string[];
	basicsName?: string | undefined;
	termValue?: string | undefined;
	scope?: { sourceId: string; localMap: ProtectedTranslation["localMap"] } | undefined;
}): string {
	if (termValue !== undefined) return termValue;
	if (scope) {
		const termsBySource = new Map(terms.map(({ source, value }) => [source, value]));
		let resolved = text;
		for (const { token, raw } of translationPlaceholderOccurrences(text)) {
			const fact = scope.localMap.get(token);
			if (fact?.sourceId === scope.sourceId)
				resolved = resolved.replace(raw, () =>
					fact.kind === "official" ? (termsBySource.get(fact.value) ?? fact.value) : fact.value,
				);
		}
		return resolved;
	}

	const placeholderByToken = new Map(placeholders.map((entry) => [entry.token, entry.value]));
	const termBySource = new Map(terms.map((term) => [term.source, term.value]));

	let resolved = text.replace(/\[LOCAL[\s_-]*([\d٠-٩۰-۹]+)\]/giu, (match, rawDigits: string) => {
		const normalized = `[LOCAL_${toAsciiDigits(rawDigits)}]`;
		const value = placeholderByToken.get(normalized);
		if (value === undefined) return match;
		return termBySource.get(value) ?? value;
	});

	if (basicsName) {
		resolved = resolved.replace(/\[NAME[\s_-]*[1١۱]\]/giu, () => basicsName);
	}

	if (sourceText && /\[redacted\]/iu.test(resolved)) {
		const protectedSource = protectTranslationPlaceholders(sourceText, placeholders);
		const namedSource = basicsName ? protectedSource.replaceAll(basicsName, "[NAME_1]") : protectedSource;
		let redactedValues: string[] = [];
		try {
			redactedValues = redactModelText(namedSource, contactValues).redactedValues;
		} catch {
			redactedValues = [];
		}
		const redactedMatches = resolved.match(/\[redacted\]/giu) ?? [];
		if (redactedValues.length > 0 && redactedMatches.length === redactedValues.length) {
			let index = 0;
			resolved = resolved.replace(/\[redacted\]/giu, () => redactedValues[index++] ?? "[redacted]");
		}
	}

	return resolved;
}
