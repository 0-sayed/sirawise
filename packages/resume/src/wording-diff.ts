import bidiFactory from "bidi-js";
import { diffArrays } from "diff";
import { blockText } from "./proposals";

type Segment = { type: "equal" | "delete" | "insert"; text: string };
type PassageEdit = { before: string; after: string };
type Part = string | PassageEdit;
const connectors = new Set(
	"a an the and or with of to in on for by at from as also via و أو او في من على إلى الى عن مع ثم حتى لكن".split(" "),
);
const normalizeWord = (word: string) => word.normalize("NFC").toLowerCase();
const isConnector = (word: string) => connectors.has(normalizeWord(word).replace(/\p{M}/gu, ""));
const bidi = bidiFactory();

function words(text: string, segmenter: Intl.Segmenter) {
	return Array.from(segmenter.segment(text)).filter((token) => token.isWordLike);
}

function isBridge(text: string) {
	const word = text.trim();
	return !word || (/^[\p{L}\p{M}]+$/u.test(word) && (Array.from(word).length <= 3 || isConnector(word)));
}

function coalesce(parts: Part[]) {
	const phrases: Part[] = [];
	for (const part of parts) {
		const previous = phrases.at(-1);
		const bridge = phrases.at(-2);
		if (typeof part !== "string" && typeof previous === "string" && typeof bridge === "object" && isBridge(previous)) {
			bridge.before += previous + part.before;
			bridge.after += previous + part.after;
			phrases.pop();
		} else {
			phrases.push(part);
		}
	}
	return phrases;
}

/** Keep a changed connector attached to the word it qualifies. */
function expandConnectorEdits(parts: Part[], segmenter: Intl.Segmenter) {
	for (const [index, part] of parts.entries()) {
		if (typeof part === "string") continue;
		const changed = words(part.before + " " + part.after, segmenter);
		if (!changed.length || changed.some(({ segment }) => !isConnector(segment))) continue;

		const next = parts[index + 1];
		const previous = parts[index - 1];
		const following = typeof next === "string" ? words(next, segmenter)[0] : undefined;
		if (typeof next === "string" && following && !next.slice(0, following.index).trim()) {
			const end = following.index + following.segment.length;
			const shared = next.slice(0, end);
			part.before += shared;
			part.after += shared;
			parts[index + 1] = next.slice(end);
		} else if (typeof previous === "string") {
			const preceding = words(previous, segmenter).at(-1);
			if (!preceding) continue;
			const shared = previous.slice(preceding.index);
			part.before = shared + part.before;
			part.after = shared + part.after;
			parts[index - 1] = previous.slice(0, preceding.index);
		}
	}
}

function toSegments(parts: Part[]): Segment[] {
	const segments: Segment[] = [];
	const append = (type: Segment["type"], text: string) => {
		if (!text) return;
		const last = segments.at(-1);
		if (type === "equal" && last?.type === "equal") {
			last.text += last.text.endsWith(" ") && text.startsWith(" ") ? text.slice(1) : text;
		} else {
			segments.push({ type, text });
		}
	};
	for (const part of parts) {
		if (typeof part === "string") {
			append("equal", part);
			continue;
		}
		if (part.before.startsWith(" ") || part.after.startsWith(" ")) append("equal", " ");
		append("delete", part.before.trim());
		append("insert", part.after.trim());
		if (part.before.endsWith(" ") || part.after.endsWith(" ")) append("equal", " ");
	}
	return segments;
}

export function computeWordingDiff(beforeHtml: string, afterHtml: string, locale?: string) {
	const beforeText = blockText(beforeHtml);
	const afterText = blockText(afterHtml);
	const direction: "rtl" | "ltr" =
		bidi.getEmbeddingLevels(afterText || beforeText).paragraphs[0]?.level === 1 ? "rtl" : "ltr";
	if (beforeText === afterText)
		return { kind: "formatting" as const, segments: [], beforeText, afterText, direction, hasNewWording: false };

	const segmenter = new Intl.Segmenter(locale, { granularity: "word" });
	const beforeWords = words(beforeText, segmenter).map(({ segment }) => segment);
	const afterWords = words(afterText, segmenter).map(({ segment }) => segment);
	const withoutPunctuation = (text: string) => text.replace(/\p{P}/gu, "").replace(/\s+/gu, " ").trim();
	const lettersAndSymbols = (text: string) => text.replace(/[\p{P}\s]/gu, "");
	const sameWords = beforeWords.length === afterWords.length && beforeWords.every((word, i) => word === afterWords[i]);
	const punctuation =
		withoutPunctuation(beforeText) === withoutPunctuation(afterText) ||
		(sameWords && lettersAndSymbols(beforeText) === lettersAndSymbols(afterText));
	const originalWords = new Set(beforeWords.map(normalizeWord));
	const hasNewWording =
		!punctuation && afterWords.some((word) => !isConnector(word) && !originalWords.has(normalizeWord(word)));
	// A word token can contain punctuation, such as the apostrophe in a contraction.
	const tokenizer = punctuation ? new Intl.Segmenter(locale, { granularity: "grapheme" }) : segmenter;
	const tokenize = (text: string) => Array.from(tokenizer.segment(text), ({ segment }) => segment);
	// jsdiff's diffWordsWithSpace uses its own tokenizer. Pass Intl.Segmenter tokens directly to its array diff.
	const changes = diffArrays(tokenize(beforeText), tokenize(afterText));
	const parts: Part[] = [];
	let removed = 0;
	let inserted = 0;
	for (const change of changes) {
		const text = change.value.join("");
		if (change.added || change.removed) {
			const last = parts.at(-1);
			const edit = typeof last === "object" ? last : { before: "", after: "" };
			if (edit !== last) parts.push(edit);
			if (change.removed) {
				edit.before += text;
				removed += words(text, segmenter).length;
			} else {
				edit.after += text;
				inserted += words(text, segmenter).length;
			}
		} else {
			parts.push(text);
		}
	}
	const rewrite = Math.max(removed, inserted) > 0.65 * Math.max(beforeWords.length, afterWords.length);
	const phrases = punctuation ? parts : coalesce(parts);
	if (!punctuation) expandConnectorEdits(phrases, segmenter);
	return {
		kind: punctuation ? ("punctuation" as const) : rewrite ? ("rewrite" as const) : ("inline" as const),
		segments: toSegments(phrases),
		beforeText,
		afterText,
		direction,
		hasNewWording,
	};
}
