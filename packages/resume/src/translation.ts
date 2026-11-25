import type { ResumeData } from "@reactive-resume/schema/resume/data";
import type { TranslationTarget } from "@reactive-resume/schema/resume/variants";
import { translationTargetSchema } from "@reactive-resume/schema/resume/variants";
import { escapeHtml } from "@reactive-resume/utils/string";
import { isRenderedSection, walkSections } from "./ats/walk";
import { blockText, replaceBlockText, splitBlock, splitBlocks } from "./proposals";
import { hashReviewTarget } from "./review-evidence";

const fields: Record<string, readonly string[]> = {
	summary: ["content"],
	experience: ["company", "position", "description"],
	education: ["school", "degree", "area", "description"],
	skills: ["name", "proficiency", "keywords"],
	interests: ["name", "keywords"],
	languages: ["language", "fluency"],
	awards: ["title", "awarder", "description"],
	certifications: ["title", "issuer", "description"],
	projects: ["name", "description"],
	publications: ["title", "publisher", "description"],
	volunteer: ["organization", "description"],
	profiles: ["network"],
	references: ["position", "description"],
	"cover-letter": ["content"],
};
const officialFields = new Set(["company", "school", "issuer", "awarder", "publisher", "organization", "network"]);
export type TranslationSegment = {
	id: string;
	target: TranslationTarget;
	source: string;
	text: string;
	official: boolean;
};
const translationId = (target: TranslationTarget) => `translation-${hashReviewTarget(JSON.stringify(target))}`;

/** Only rendered prose is sent; identity, contact, link and date fields stay local. */
export function buildTranslationInventory(data: ResumeData) {
	const segments: TranslationSegment[] = [];
	const blocking: string[] = [];
	const blockingSections: string[] = [];
	const add = (raw: unknown, source: unknown) => {
		if (typeof source !== "string" || !blockText(source)) return;
		const target = translationTargetSchema.parse(raw);
		if ((target.field === "content" || target.field === "description") && !("blockIndex" in target)) {
			const blocks = splitBlocks(source);
			if (blocks.length) {
				blocks.forEach((block, blockIndex) => add({ ...target, blockIndex }, block.html));
				return;
			}
		}
		segments.push({
			id: translationId(target),
			target,
			source,
			text: blockText(source),
			official:
				officialFields.has(target.field) ||
				(target.sectionId === "certifications" && target.field === "title" && "itemId" in target),
		});
	};
	add({ sectionId: "basics", field: "headline" }, data.basics.headline);
	for (const section of walkSections(data).filter(isRenderedSection)) {
		const custom = section.pointer.startsWith("/customSections/")
			? data.customSections.find((candidate) => candidate.id === section.id)
			: undefined;
		if (!custom && ["profiles", "references"].includes(section.id)) continue;
		if (!Object.hasOwn(fields, section.type)) {
			if (section.items.length) {
				blocking.push(section.id);
				blockingSections.push(section.title || section.id);
			}
			continue;
		}
		const scope = { sectionId: section.type, ...(custom ? { customSectionId: custom.id } : {}) };
		const definition =
			custom ?? (section.id === "summary" ? data.summary : data.sections[section.id as keyof ResumeData["sections"]]);
		if (definition.showHeading !== false && section.items.length) add({ ...scope, field: "title" }, section.title);
		if (!custom && section.id === "summary") {
			add({ sectionId: "summary", field: "content" }, data.summary.content);
			continue;
		}
		for (const { value } of section.items) {
			for (const field of fields[section.type] ?? []) {
				if (field === "keywords" && Array.isArray(value.keywords))
					value.keywords.forEach((keyword, index) => add({ ...scope, itemId: value.id, field, index }, keyword));
				else add({ ...scope, itemId: value.id, field }, value[field]);
			}
			if (section.type === "experience" && Array.isArray(value.roles))
				for (const role of value.roles) {
					if (!role || typeof role !== "object" || !("id" in role)) continue;
					for (const field of ["position", "description"] as const)
						if (field in role) add({ ...scope, itemId: value.id, roleId: role.id, field }, role[field]);
				}
		}
	}
	return {
		segments,
		blocking,
		blockingSections,
		exclusions: [
			"personal-name-contact-location-photo-links-dates",
			"profile-and-reference-contact-content",
			"custom-recipient-contact-content",
			"hidden-and-unplaced-content",
			...(blocking.length ? ["unsupported-visible-sections"] : []),
		],
	};
}

/** A refresh may replace wording, but never silently add/remove independent copy content. */
export function translationStructureMatches(source: ResumeData, copy: ResumeData): boolean {
	const structure = (data: ResumeData) => {
		const inventory = buildTranslationInventory(data);
		return JSON.stringify({
			targets: inventory.segments.map((segment) => segment.id).sort(),
			blocking: inventory.blocking.toSorted(),
		});
	};
	return structure(source) === structure(copy);
}

/** True when sections/items/roles/keywords match and only rich-text paragraph/list block counts differ. */
export function translationBlockOnlyDivergence(source: ResumeData, copy: ResumeData): boolean {
	const fieldStructure = (data: ResumeData) => {
		const inventory = buildTranslationInventory(data);
		const parents = new Set(
			inventory.segments.map((segment) => {
				const target = segment.target as Record<string, unknown>;
				if (!("blockIndex" in target)) return segment.id;
				const { blockIndex: _ignored, ...parent } = target;
				return `field:${JSON.stringify(parent)}`;
			}),
		);
		return JSON.stringify({
			parents: [...parents].sort(),
			blocking: inventory.blocking.toSorted(),
		});
	};
	return fieldStructure(source) === fieldStructure(copy);
}

/** Align rich-text HTML block skeletons, consuming approved writes in the fields that change shape. */
export function alignRichTextStructure(
	source: ResumeData,
	copy: ResumeData,
	partial?: { pending: Map<string, string>; preserveEmptySlots: boolean },
): ResumeData {
	const aligned = structuredClone(copy);
	const align = (sourceHtml: string, savedHtml: string, field: Record<string, unknown>) => {
		const sourceBlocks = splitBlocks(sourceHtml, { includeEmpty: Boolean(partial) });
		const savedBlocks = splitBlocks(savedHtml);
		if (sourceBlocks.filter(({ text }) => text).length === savedBlocks.length) return savedHtml;
		if (!partial) return sourceHtml;

		const slots = partial.preserveEmptySlots ? splitBlocks(savedHtml, { includeEmpty: true }) : [];
		let offset = 0;
		let index = 0;
		let html = "";
		let changed = false;
		for (const [slot, block] of sourceBlocks.entries()) {
			const start = sourceHtml.indexOf(block.html, offset);
			html += sourceHtml.slice(offset, start);
			offset = start + block.html.length;
			if (!block.text) {
				html += block.html;
				continue;
			}
			const target = translationTargetSchema.safeParse({ ...field, blockIndex: index });
			const id = target.success ? translationId(target.data) : "";
			const text = partial.pending.get(id);
			const saved = slots.length === sourceBlocks.length ? slots[slot] : savedBlocks[index];
			index++;
			if (text !== undefined) {
				html += replaceBlockText(block.html, text);
				partial.pending.delete(id);
				changed = true;
			} else {
				const shape = splitBlock(block.html);
				const inner = splitBlock(saved?.html ?? "")?.inner ?? "";
				html += shape ? shape.open + inner + shape.close : inner;
			}
		}
		return changed ? html + sourceHtml.slice(offset) : savedHtml;
	};
	aligned.summary.content = align(source.summary.content, aligned.summary.content, {
		sectionId: "summary",
		field: "content",
	});
	const alignItems = (
		sourceItems: Array<Record<string, unknown>>,
		copyItems: Array<Record<string, unknown>>,
		scope: { sectionId: string; customSectionId?: string },
	) => {
		const byId = new Map(sourceItems.map((item) => [String(item.id), item]));
		for (const copyItem of copyItems) {
			const srcItem = byId.get(String(copyItem.id));
			if (!srcItem) continue;
			for (const field of ["description", "content"] as const) {
				if (typeof srcItem[field] === "string" && typeof copyItem[field] === "string") {
					copyItem[field] = align(srcItem[field], copyItem[field], { ...scope, itemId: copyItem.id, field });
				}
			}
			if (scope.sectionId === "experience" && Array.isArray(srcItem.roles) && Array.isArray(copyItem.roles)) {
				const rolesById = new Map(
					(srcItem.roles as Array<Record<string, unknown>>).map((role) => [String(role.id), role]),
				);
				for (const copyRole of copyItem.roles as Array<Record<string, unknown>>) {
					const srcRole = rolesById.get(String(copyRole.id));
					if (typeof srcRole?.description === "string" && typeof copyRole.description === "string") {
						copyRole.description = align(srcRole.description, copyRole.description, {
							...scope,
							itemId: copyItem.id,
							roleId: copyRole.id,
							field: "description",
						});
					}
				}
			}
		}
	};
	for (const key of Object.keys(source.sections) as Array<keyof ResumeData["sections"]>) {
		alignItems(
			source.sections[key].items as Array<Record<string, unknown>>,
			aligned.sections[key].items as Array<Record<string, unknown>>,
			{ sectionId: key },
		);
	}
	const customById = new Map(source.customSections.map((section) => [section.id, section]));
	for (const copyCustom of aligned.customSections) {
		const srcCustom = customById.get(copyCustom.id);
		if (srcCustom) {
			alignItems(
				srcCustom.items as Array<Record<string, unknown>>,
				copyCustom.items as Array<Record<string, unknown>>,
				{ sectionId: srcCustom.type, customSectionId: srcCustom.id },
			);
		}
	}
	return aligned;
}

function writeRichText(current: string, target: TranslationTarget, value: string): string {
	if (!("blockIndex" in target) || target.blockIndex === undefined) return `<p>${escapeHtml(value)}</p>`;
	const blocks = splitBlocks(current);
	const selected = blocks[target.blockIndex];
	if (!selected) throw new Error("TRANSLATION_TARGET_CHANGED");
	let offset = 0;
	for (const block of blocks.slice(0, target.blockIndex))
		offset = current.indexOf(block.html, offset) + block.html.length;
	const start = current.indexOf(selected.html, offset);
	return current.slice(0, start) + replaceBlockText(selected.html, value) + current.slice(start + selected.html.length);
}

/** No arbitrary path setter: even callers inside a transaction must pass the closed schema. */
export function writeTranslationTarget(data: ResumeData, raw: TranslationTarget, value: string) {
	const target = translationTargetSchema.parse(raw);
	if (target.sectionId === "basics") {
		data.basics.headline = value;
		return;
	}
	if (target.sectionId === "summary" && !target.customSectionId) {
		if (target.field === "title") data.summary.title = value;
		else data.summary.content = writeRichText(data.summary.content, target, value);
		return;
	}
	const section = target.customSectionId
		? data.customSections.find((section) => section.id === target.customSectionId && section.type === target.sectionId)
		: data.sections[target.sectionId as keyof ResumeData["sections"]];
	if (!section) throw new Error("TRANSLATION_TARGET_CHANGED");
	if (!("itemId" in target)) {
		section.title = value;
		return;
	}
	const item = section.items.find((item) => item.id === target.itemId) as Record<string, unknown> | undefined;
	if (!item) throw new Error("TRANSLATION_TARGET_CHANGED");
	let record = item;
	if ("roleId" in target && target.roleId) {
		const role = Array.isArray(item.roles)
			? item.roles.find((role: Record<string, unknown>) => role.id === target.roleId)
			: undefined;
		if (!role) throw new Error("TRANSLATION_TARGET_CHANGED");
		record = role;
	}
	if (target.field === "keywords") {
		if (!Array.isArray(record.keywords) || typeof record.keywords[target.index] !== "string")
			throw new Error("TRANSLATION_TARGET_CHANGED");
		record.keywords[target.index] = value;
	} else if (target.field === "description" || target.field === "content") {
		const current = record[target.field];
		if (typeof current !== "string") throw new Error("TRANSLATION_TARGET_CHANGED");
		record[target.field] = writeRichText(current, target, value);
	} else {
		if (typeof record[target.field] !== "string") throw new Error("TRANSLATION_TARGET_CHANGED");
		record[target.field] = value;
	}
}

/** The registry stays in the owner's transaction; only tokens are sent to inference. */
export function translationPlaceholders(data: ResumeData) {
	const contacts = [
		data.basics.name,
		data.basics.email,
		data.basics.phone,
		data.basics.location,
		data.basics.website.url,
		...data.customSections.flatMap((section) =>
			section.type === "references" ? section.items.flatMap((item) => [item.name, item.phone]) : [],
		),
	];
	const official = buildTranslationInventory(data)
		.segments.filter((segment) => segment.official)
		.map((segment) => segment.text);
	return [...new Set([...contacts, ...official].filter(Boolean))]
		.sort((a, b) => b.length - a.length)
		.map((value, index) => ({ token: `[LOCAL_${index + 1}]`, value }));
}

/** Replace only whole-token occurrences so kept proper names never split words or splice partial matches. */
export function protectTranslationPlaceholders(
	text: string,
	placeholders: ReadonlyArray<{ token: string; value: string }>,
): string {
	return placeholders.reduce((current, entry) => {
		if (!entry.value) return current;
		const escaped = entry.value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
		const pattern = new RegExp(`(?<![\\p{L}\\p{N}_])${escaped}(?![\\p{L}\\p{N}_])`, "gu");
		return current.replace(pattern, () => entry.token);
	}, text);
}
