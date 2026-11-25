import type { ResumeData } from "@reactive-resume/schema/resume/data";
import { z } from "zod";

export const PAYLOAD_VERSION = "t006-payload-v3";

// Unprefixed local numbers/identities are ambiguous with achievement quantities.
// Explicit contact labels take priority; currency and measurement context stays factual.
function redactAmbiguousNumber(value: string, offset: number, text: string, mark: (raw: string) => string): string {
	const before = text.slice(0, offset);
	const after = text.slice(offset + value.length);
	if (
		/(?:phone|tel(?:ephone)?|mobile|national\s*id|iqama|هوية|الهوية|إقامة|الإقامة|جوال|هاتف)(?:\s*(?:number|رقم))?\s*[:：#-]?\s*$/iu.test(
			before,
		)
	)
		return mark(value);
	if (
		/(?:[$€£﷼]|SAR|USD|AED|ريال|ر\.س)\s*$/iu.test(before) ||
		/^\s*(?:[%٪]|(?:SAR|USD|AED|ريال|ر\.س|users?|records?|requests?|transactions?|customers?|items?|reports?|units?|events?|طلبات?|طلبا|معاملات|مستخدم(?:ا|ين)?)(?!\p{L}))/iu.test(
			after,
		) ||
		/(?:\b\p{L}+ed(?:\s+\p{L}+){0,3}|served|reduced costs by|requests:|عالجت|وفرت)\s*$/iu.test(before) ||
		/^[.,]\p{Nd}/u.test(after) ||
		/\p{Nd}[.,]$/u.test(before)
	)
		return value;
	return mark(value);
}

function redactUrl(value: string, mark: (raw: string) => string): string {
	// Keep prose punctuation outside the URL, including closing parentheses.
	const trailing = value.match(/[),.;!?]+$/u)?.[0] ?? "";
	const raw = value.slice(0, value.length - trailing.length);
	return `${mark(raw)}${trailing}`;
}

function redactContactNumbers(text: string, mark: (raw: string) => string): string {
	// Split around explicit chronology/percentages before matching phones, so a phone
	// cannot consume a neighboring fact and a date beginning with 05 is never a mobile.
	return text
		.split(
			/((?<!\p{Nd})(?:\p{Nd}{4}[-/.]\p{Nd}{1,2}(?:[-/.]\p{Nd}{1,2})?|\p{Nd}{1,2}[-/.](?:\p{Nd}{1,2}[-/.])?\p{Nd}{4}|\p{Nd}{4}\s*[-–—]\s*\p{Nd}{4})(?!\p{Nd})|[+−-]?\p{Nd}+(?:[.,]\p{Nd}+)?[ \t]*[%٪])/gu,
		)
		.map((part, index) => {
			if (index % 2) return part;
			return (
				part
					// Explicit labels also cover local renderings of international phones.
					.replace(
						/((?:phone|tel(?:ephone)?|mobile|هاتف|جوال)\s*[:：]\s*)(\(?\+?\p{Nd}(?:[ \t()./-]*\p{Nd}){6,14})(?!\p{N})/giu,
						(_full, label: string, num: string) => `${label}${mark(num)}`,
					)
					.replace(/(?<![\p{L}\p{N}_])(?:\+|[0٠۰]{2})\p{Nd}(?:[ \t()./-]*\p{Nd}){6,14}(?!\p{N})/gu, (match) =>
						mark(match),
					)
					// Formatted local/international numbers without an explicit contact label.
					.replace(
						/(?<![\p{L}\p{N}_])(?:\(\p{Nd}{2,4}\)[ \t.-]*\p{Nd}(?:[ \t.-]*\p{Nd}){6,9}|\p{Nd}{1,4}(?:[ \t().-]+\p{Nd}{2,4}){1,4})(?![\p{L}\p{N}_])/gu,
						(value, offset: number, whole: string) => {
							const digits = value.match(/\p{Nd}/gu)?.length ?? 0;
							return digits >= 7 && digits <= 15 ? redactAmbiguousNumber(value, offset, whole, mark) : value;
						},
					)
					// Saudi mobiles and Riyadh landlines, with common separators.
					.replace(
						/(?<![\p{L}\p{N}_])(?:[0٠۰][1١۱][1١۱](?:[ \t()./-]*\p{Nd}){7}|[0٠۰][5٥۵](?:[ \t()./-]*\p{Nd}){8}|[9٩۹][6٦۶][6٦۶][ \t()./-]*[5٥۵](?:[ \t()./-]*\p{Nd}){8})(?!\p{N})/gu,
						(value, offset: number, whole: string) => redactAmbiguousNumber(value, offset, whole, mark),
					)
					// Local seven-digit phones and Saudi national ID/iqama (ten digits, 1/2).
					.replace(
						/(?<![\p{L}\p{N}_])(?:\p{Nd}{7}|[12١٢۱۲]\p{Nd}{9})(?![\p{L}\p{N}_])/gu,
						(value, offset: number, whole: string) => redactAmbiguousNumber(value, offset, whole, mark),
					)
			);
		})
		.join("");
}

const sectionSchema = z.enum([
	"summary",
	"experience",
	"education",
	"skills",
	"projects",
	"languages",
	"certifications",
	"volunteer",
	"awards",
	"publications",
	"references",
]);
const modernSelection = z.strictObject({
	id: z.string().min(1).max(200),
	kind: z.enum(["confirmed_content", "unconfirmed_source", "user_supplied", "model_proposed"]),
	section: sectionSchema,
	text: z.string().max(128000),
});
const selection = z.strictObject({
	section: sectionSchema,
	confirmed: z.literal(true),
	text: z.string().max(128000),
});
const payloadSchema = z.strictObject({
	selections: z
		.array(z.union([modernSelection, z.strictObject({ section: sectionSchema, text: z.string() })]))
		.min(1)
		.max(50),
});
// Leave room for the prompt, JSON schema and framing in the Terra medium writer price bound.
export const MAX_TERRA_WRITER_PAYLOAD_BYTES = 26_000;

export type ModelPayload = z.infer<typeof payloadSchema>;
export type ModelPayloadInput = {
	selections: (
		| { section: string; confirmed: boolean; text: string }
		| {
				id: string;
				kind: "confirmed_content" | "unconfirmed_source" | "user_supplied" | "model_proposed";
				section: string;
				text: string;
		  }
	)[];
	contactValues: string[];
};

export function redactModelText(
	text: string,
	contactValues: string[],
	{ preserveLineBreaks = false, plainText = false } = {},
): { text: string; redactedValues: string[] } {
	// Markup, evidence locators, transcripts and attachments never enter the model contract.
	let clean = text.normalize("NFKC").replace(/\p{Cf}/gu, "");
	// Already decoded prose can contain literal angle brackets around contact details.
	if (!plainText) clean = clean.replace(/<[^>]*>/g, " ");
	// Reject entity-encoded input rather than bypass redaction with an alternate spelling.
	if (/&(?:#\w+|[a-z]+);/i.test(clean)) throw new Error("AI_PAYLOAD_ENCODING");
	const captured: string[] = [];
	const mark = (raw: string) => {
		const index = captured.push(raw) - 1;
		return `\uE000REDACTED_${index}\uE001`;
	};
	for (const contact of contactValues.filter((v) => v.trim().length > 0).sort((a, b) => b.length - a.length)) {
		// Match rendered contact characters even when formatting inserts or removes whitespace.
		const characters = [...contact.normalize("NFKC").replace(/\p{Cf}/gu, "")].filter(
			(character) => !/\s/u.test(character),
		);
		if (!characters.length) continue;
		const pattern = characters.map((character) => character.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("\\s*");
		clean = clean.replaceAll(new RegExp(pattern, "giu"), (match) => mark(match));
	}
	clean = clean
		.replace(/[\p{L}\p{M}\p{N}_.+%-]+@[\p{L}\p{M}\p{N}.-]+\.(?:xn--[a-z0-9-]+|[\p{L}\p{M}]{2,})/giu, (match) =>
			mark(match),
		)
		.replace(/(?:https?:\/\/|www\.)[^\s<>]+/giu, (value) => redactUrl(value, mark))
		.replace(
			/((?:website|profile|portfolio|url|link|الموقع|الرابط)\s*[:：]\s*)([^\s<>]+\.[^\s<>]+)/giu,
			(_value, label: string, url: string) => `${label}${mark(url)}`,
		)
		.replace(
			// Bare links need URL structure, not merely a dotted technology name.
			/(?<![\p{L}\p{M}\p{N}_])[\p{L}\p{M}\p{N}](?:[\p{L}\p{M}\p{N}-]*[\p{L}\p{M}\p{N}])?(?:\.[\p{L}\p{M}\p{N}](?:[\p{L}\p{M}\p{N}-]*[\p{L}\p{M}\p{N}])?)*\.(?:xn--[a-z0-9-]+|[\p{L}\p{M}]{2,})[/?#][^\s<>]*/giu,
			(value) =>
				/^(?:(?:node|vue)\.js\/(?:typescript|javascript)|asp\.net\/c#)[),.;!?]*$/iu.test(value)
					? value
					: redactUrl(value, mark),
		)
		.replace(/@[\p{L}\p{M}\p{N}_][\p{L}\p{M}\p{N}_.-]*/gu, (match) => mark(match));
	clean = redactContactNumbers(clean, mark);
	const redactedValues: string[] = [];
	const restored = clean.replace(/\uE000REDACTED_(\d+)\uE001/gu, (_match, index: string) => {
		const raw = captured[Number(index)];
		if (raw !== undefined) redactedValues.push(raw);
		return "[redacted]";
	});
	const minimized = (
		preserveLineBreaks
			? restored
					.replace(/\r\n?/gu, "\n")
					.replace(/[^\S\n]+/gu, " ")
					.replace(/ *\n */gu, "\n")
			: restored.replace(/\s+/gu, " ")
	).trim();
	if (!minimized) throw new Error("AI_EMPTY_SELECTION");
	return { text: minimized, redactedValues };
}

export function minimizeModelText(text: string, contactValues: string[]): string {
	return redactModelText(text, contactValues).text;
}

export function buildModelPayload(input: ModelPayloadInput, preserveLineBreaks = false): ModelPayload {
	const parsed = z
		.object({
			selections: z
				.array(z.union([modernSelection, selection]))
				.min(1)
				.max(50),
			contactValues: z.array(z.string()).max(100),
		})
		.parse(input);
	const selections = parsed.selections.map((selected) => {
		const { section, text } = selected;
		const minimized = redactModelText(text, parsed.contactValues, { preserveLineBreaks }).text;
		return { section, text: minimized, ...("id" in selected ? { id: selected.id, kind: selected.kind } : {}) };
	});
	const payload = payloadSchema.parse({ selections });
	if ([...JSON.stringify(payload)].length > 32000) throw new Error("AI_INPUT_LIMIT");
	return payload;
}

export function prepareImportSelection(input: { section: string; text: string; contactValues: string[] }) {
	const [selected] = buildModelPayload(
		{
			selections: [{ id: "selected", kind: "unconfirmed_source", section: input.section, text: input.text }],
			contactValues: input.contactValues,
		},
		true,
	).selections;
	return modernSelection.parse(selected);
}

export const resumeContactValues = (data: ResumeData) => [
	data.basics.name,
	data.basics.email,
	data.basics.phone,
	data.basics.website.url,
	data.basics.location,
];
