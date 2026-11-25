import type { ReviewState } from "./review-draft";
import type { ReviewCandidate } from "@reactive-resume/schema/resume/ai-review";
import type { ResumeData } from "@reactive-resume/schema/resume/data";
import { produce } from "immer";
import { normalizeImportedText } from "@reactive-resume/import/normalize";
import {
	findPeriod,
	isRecognizedLocation,
	locateResumeTextSections,
	looksLikeRole,
	readEducationHeader,
} from "@reactive-resume/import/plain-text";
import { blockText } from "@reactive-resume/resume/proposals";
import { hashReviewTarget } from "@reactive-resume/resume/review-evidence";
import { reviewCandidateSchema } from "@reactive-resume/schema/resume/ai-review";
import { readLegacyDates } from "@reactive-resume/schema/resume/dates";
import { parseResumeDataForWrite } from "@reactive-resume/schema/resume/write";
import { escapeHtml } from "@reactive-resume/utils/string";
import { addBuiltinSection, getEntries, resolveSection } from "../editor/write/model";

type ImportSectionText = {
	text: string;
	matched: boolean;
	pages: { page: number; start: number; end: number }[];
};

/** Keep original text and positional page provenance; duplicate quotes cannot identify a page. */
export function getImportSectionText(
	pages: { page: number; text: string }[],
	section: string,
	locale: string,
): ImportSectionText {
	let sourceText = "";
	const sourcePages = pages.map((page, index) => {
		if (index > 0) sourceText += "\n\n";
		const start = sourceText.length;
		sourceText += page.text;
		return { page: page.page, start, end: sourceText.length };
	});
	const ranges = locateResumeTextSections(sourceText, locale).filter((range) => range.key === section);
	if (ranges.length === 0) return { text: sourceText, pages: sourcePages, matched: false };
	const result: ImportSectionText = { text: "", pages: [], matched: true };
	for (const [index, range] of ranges.entries()) {
		if (index > 0 && ranges[index - 1]?.end !== range.start) result.text += "\n\n";
		const displayStart = result.text.length;
		result.text += sourceText.slice(range.start, range.end);
		for (const page of sourcePages) {
			const start = Math.max(page.start, range.start);
			const end = Math.min(page.end, range.end);
			if (start < end)
				result.pages.push({
					page: page.page,
					start: displayStart + start - range.start,
					end: displayStart + end - range.start,
				});
		}
	}
	return result;
}

/** Textareas normalize CRLF to LF; translate their offsets before slicing original source text. */
export function getImportPassageSelection(source: ImportSectionText, start: number, end: number) {
	const displayedLength = source.text.replace(/\r\n/g, "\n").length;
	if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end <= start || end > displayedLength)
		return { text: "", pages: [] as number[] };
	let rawStart = 0;
	let rawEnd = 0;
	for (let displayed = 0; displayed < end; displayed++) {
		if (displayed === start) rawStart = rawEnd;
		rawEnd += source.text[rawEnd] === "\r" && source.text[rawEnd + 1] === "\n" ? 2 : 1;
	}
	return {
		text: source.text.slice(rawStart, rawEnd),
		pages: [
			...new Set(source.pages.filter((page) => rawStart < page.end && rawEnd > page.start).map((page) => page.page)),
		],
	};
}

export const importDraftGeneration = (data: ResumeData) =>
	hashReviewTarget(
		JSON.stringify(data, (_key, value: unknown) =>
			value && typeof value === "object" && !Array.isArray(value)
				? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)))
				: value,
		),
	);

const descriptionLines = (value: string) =>
	value
		.split(/\r?\n/u)
		.map((line) => line.trim().replace(/^[-–—•*◦‣·]\s+/u, ""))
		.filter(Boolean);
const descriptionText = (value: string) => normalizeImportedText(value).replace(/\s+/gu, " ").trim();

function containsDescriptionExcerpt(html: string, value: string) {
	const current = descriptionText(blockText(html));
	const excerpt = descriptionText(descriptionLines(value).join(" "));
	if (!excerpt) return false;
	for (let start = current.indexOf(excerpt); start >= 0; start = current.indexOf(excerpt, start + 1)) {
		// A selection can stop inside a word. Match its start without trimming the stored word.
		if (start === 0 || !/[\p{L}\p{M}\p{N}]/u.test(current[start - 1] ?? "")) return true;
	}
	return false;
}

/** Explicit local selection only. T004 still owns final confirmation and master/CV creation. */
export function applyImportReviewCandidate(state: ReviewState, candidateId: string, entryId: string): ReviewState {
	const review = state.aiReview;
	if (
		!review ||
		review.result?.kind !== "extraction" ||
		review.draftGeneration !== importDraftGeneration(state.data) ||
		review.source.kind !== "import" ||
		review.source.id !== review.result.sourceRevision.id ||
		review.source.revision !== review.result.sourceRevision.revision
	)
		throw new Error("AI_IMPORT_STALE");
	const candidate = reviewCandidateSchema.parse(
		review.result.candidates.find((candidate) => candidate.id === candidateId),
	);
	if (candidate.value === null) throw new Error("AI_IMPORT_UNKNOWN");
	if (review.appliedCandidateIds.includes(candidateId)) throw new Error("AI_IMPORT_ALREADY_APPLIED");
	let targetId = entryId;
	let changedField = "";
	let before: unknown;
	let after: unknown;
	let appendedKeyword: string | undefined;
	let retained = false;
	const data = produce(state.data, (draft) => {
		if (entryId === "new") {
			const created = addBuiltinSection(draft, candidate.section);
			if (!created) throw new Error("AI_IMPORT_TARGET_UNAVAILABLE");
			targetId = created;
		}
		const section = resolveSection(draft, candidate.section);
		const entry = section && getEntries(draft, section).find((entry) => entry.id === targetId);
		if (!entry) throw new Error("AI_IMPORT_TARGET_UNAVAILABLE");
		const value =
			candidate.field === "dates" && candidate.rawDateText && typeof candidate.value === "object"
				? { ...candidate.value, raw: candidate.rawDateText }
				: candidate.value;
		const record = entry as unknown as Record<string, unknown>;
		changedField =
			candidate.section === "skills" && candidate.field === "name" && entryId !== "new" && value !== record.name
				? "keywords"
				: candidate.field;
		if (
			state.reused.some(
				(fact) =>
					fact.confirmation === "confirmed" &&
					fact.structured?.section === candidate.section &&
					fact.structured.entityId === targetId &&
					fact.structured.field === changedField,
			)
		)
			throw new Error("AI_IMPORT_CONFIRMED_MASTER");
		before = JSON.parse(JSON.stringify(record[changedField] ?? null));
		if (changedField === "keywords") {
			const keywords = Array.isArray(record.keywords) ? (record.keywords as string[]) : [];
			if (typeof value !== "string") throw new Error("AI_IMPORT_UNKNOWN");
			if (!keywords.some((word) => word.toLocaleLowerCase() === value.toLocaleLowerCase())) {
				appendedKeyword = value;
				record.keywords = [...keywords, value];
			}
		} else if (changedField === "description" && typeof value === "string") {
			const current = typeof record.description === "string" ? record.description : "";
			// Extraction confirms a literal excerpt. It cannot replace surrounding prose or list markup.
			if (!containsDescriptionExcerpt(current, value))
				record.description =
					current +
					descriptionLines(value)
						.map((line) => `<p>${escapeHtml(line)}</p>`)
						.join("");
		} else if (
			candidate.section === "education" &&
			((typeof before === "string" && before.trim()) ||
				(changedField === "dates" &&
					entry.dates &&
					(entry.dates.start || entry.dates.end || entry.dates.present || entry.dates.raw)))
		) {
			// The source can flatten several education fields into one candidate. Preserve the draft split.
			retained =
				typeof before === "string" && typeof value === "string"
					? candidateKey(before) !== candidateKey(value)
					: !sameEducationDates(before, value);
		} else if (
			entryId !== "new" &&
			candidate.section === "experience" &&
			typeof value === "string" &&
			typeof before === "string" &&
			before.trim() &&
			(changedField === "company" ||
				changedField === "location" ||
				(changedField === "position" && matchesRole(before, value)))
		) {
			const current = candidateKey(before);
			const proposed = candidateKey(value);
			const peers =
				review.result?.kind === "extraction"
					? review.result.candidates.filter(
							(peer) => peer.section === candidate.section && peer.entityId === candidate.entityId,
						)
					: [];
			const peerLocation = peers.find((peer) => peer.field === "location")?.value;
			const peerCompany = peers.find((peer) => peer.field === "company")?.value;
			const suffix = current.startsWith(`${proposed} `) ? current.slice(proposed.length + 1) : "";
			const supportedSplit =
				changedField === "company" &&
				!record.location &&
				suffix &&
				isRecognizedLocation(suffix) &&
				typeof peerLocation === "string" &&
				` ${candidateKey(peerLocation)} `.includes(` ${suffix} `);
			const extendedLocation =
				changedField === "location" &&
				proposed !== current &&
				` ${proposed} `.includes(` ${current} `) &&
				(typeof peerCompany !== "string" ||
					typeof record.company !== "string" ||
					candidateKey(peerCompany) === candidateKey(record.company));
			if (supportedSplit || extendedLocation) record[changedField] = value;
			else retained = current !== proposed;
		} else record[changedField] = value;
		after = JSON.parse(JSON.stringify(record[changedField] ?? null));
	});
	const next = parseResumeDataForWrite(data);
	const entityKey = `${candidate.section}:${targetId}`;
	const { submission: _submission, ...rest } = state;
	return {
		...rest,
		data: next,
		confirmationFlow: crypto.randomUUID(),
		confirmed: Object.fromEntries(Object.entries(state.confirmed).filter(([key]) => !key.startsWith(`${entityKey}:`))),
		reviewed: Object.fromEntries(
			Object.entries(state.reviewed).filter(([key]) => key !== entityKey && key !== `${entityKey}:${changedField}`),
		),
		aiReview: {
			...review,
			draftGeneration: importDraftGeneration(next),
			appliedCandidateIds: [...review.appliedCandidateIds, candidateId],
			appliedChanges: [
				...(review.appliedChanges ?? []),
				{
					candidateId,
					section: candidate.section,
					entryId: targetId,
					field: changedField,
					before,
					after,
					...(appendedKeyword ? { appendedKeyword } : {}),
					...(retained ? { retained: true } : {}),
					createdEntry:
						entryId === "new" || !!review.appliedChanges?.some((c) => c.entryId === targetId && c.createdEntry),
				},
			],
		},
	};
}

const candidateKey = (value: string) =>
	normalizeImportedText(value)
		.normalize("NFKC")
		.toLocaleLowerCase()
		.replace(/[^\p{L}\p{N}]+/gu, " ")
		.trim();

function sameEducationDates(left: unknown, right: unknown) {
	if (!left || !right || typeof left !== "object" || typeof right !== "object") return false;
	const a = left as { start?: string | null; end?: string | null; present?: boolean };
	const b = right as typeof a;
	return a.start === b.start && a.end === b.end && a.present === b.present;
}
const roleRuns = (value: string) =>
	value
		.match(/[\p{Script=Arabic}\p{M}]+(?:\s+[\p{Script=Arabic}\p{M}]+)*|[^\p{Script=Arabic}\p{M}]+/gu)
		?.map(candidateKey)
		.filter(Boolean);

function matchesRole(current: string, proposed: string) {
	const native = roleRuns(current);
	const candidate = roleRuns(proposed);
	return native?.length === 2 && candidate?.length === 2 && native[0] === candidate[1] && native[1] === candidate[0];
}
const PRIMARY_IDENTITY_FIELDS = new Set([
	"company",
	"school",
	"organization",
	"name",
	"title",
	"issuer",
	"awarder",
	"publisher",
]);

function matchesSplitCompany(current: string, nativeLocation: unknown, company: string, location: unknown) {
	const employer = candidateKey(company);
	if (!employer) return false;
	const nativeCompany = candidateKey(current);
	const nativePlace = typeof nativeLocation === "string" ? candidateKey(nativeLocation) : "";
	const combined = `${nativeCompany} ${nativePlace}`.trim();
	const proposed = typeof location === "string" ? candidateKey(location) : "";
	if (proposed && combined === `${employer} ${proposed}`) return true;
	if (!nativeCompany.startsWith(`${employer} `)) return false;
	const suffix = nativeCompany.slice(employer.length + 1);
	const locationTail = combined.slice(employer.length + 1);
	return isRecognizedLocation(suffix) && (!proposed || ` ${locationTail} `.includes(` ${proposed} `));
}

const normalizeDateEvidence = (value: string) =>
	normalizeImportedText(value)
		.replace(/\s*[-‐‑‒–—−]\s*/gu, "-")
		.replace(/\s+/gu, " ")
		.trim();

function quotesDatedRole(quote: string, role: string, date: string, locale: string) {
	const lines = quote.split(/\r?\n/u).map(normalizeDateEvidence);
	const expectedRole = candidateKey(normalizeImportedText(role));
	const periods = lines.map((line) => findPeriod(line, locale));
	return lines.some((line, index) => {
		if (periods[index] !== date) return false;
		const header = line.replace(date, "").trim();
		if (` ${candidateKey(header)} `.includes(` ${expectedRole} `)) return true;
		if (looksLikeRole(header)) return false;
		return [index - 1, index + 1].some(
			(neighbor) => !periods[neighbor] && candidateKey(lines[neighbor] ?? "") === expectedRole,
		);
	});
}

export function getImportCandidateTarget(
	state: ReviewState,
	candidate: ReviewCandidate,
	excludeEntryIds?: ReadonlySet<string>,
): string {
	const section = resolveSection(state.data, candidate.section);
	const entries = (section ? getEntries(state.data, section) : []).filter((entry) => !excludeEntryIds?.has(entry.id));
	const exact = entries.find((entry) => entry.id === candidate.entityId);
	if (exact) return exact.id;
	if (candidate.section === "skills" && typeof candidate.value === "string") {
		const value = candidateKey(candidate.value);
		const matches = entries.filter(
			(entry) =>
				"keywords" in entry &&
				"name" in entry &&
				[candidateKey(entry.name), ...entry.keywords.map(candidateKey)].includes(value),
		);
		if (matches.length === 1) return matches[0]?.id ?? "new";
		return entries.length === 1 ? (entries[0]?.id ?? "new") : "new";
	}
	const result = state.aiReview?.result;
	const peers =
		result?.kind === "extraction"
			? result.candidates.filter((peer) => peer.section === candidate.section && peer.entityId === candidate.entityId)
			: [candidate];
	const location = peers.find((peer) => peer.field === "location")?.value;
	const role = peers.find((peer) => peer.field === "position")?.value;
	const dateCandidate = peers.find((peer) => peer.field === "dates");
	const rawDate = normalizeDateEvidence(dateCandidate?.rawDateText ?? "");
	const locale = state.data.metadata.page.locale;
	const school = candidate.section === "education" ? peers.find((peer) => peer.field === "school")?.value : undefined;
	const nativeSchool = typeof school === "string" ? readEducationHeader(school, locale).school : "";
	const quotedDate =
		candidate.section === "experience" &&
		result?.kind === "extraction" &&
		typeof role === "string" &&
		rawDate &&
		dateCandidate?.value === null &&
		result.evidence.some(
			({ id, quote }) => dateCandidate.evidenceIds.includes(id) && quotesDatedRole(quote, role, rawDate, locale),
		)
			? readLegacyDates(rawDate, { locale, single: false })
			: undefined;
	const matches = entries.flatMap((entry) => {
		const record = entry as unknown as Record<string, unknown>;
		let score = 0;
		for (const peer of peers) {
			const current = record[peer.field];
			const identity = PRIMARY_IDENTITY_FIELDS.has(peer.field);
			if (typeof peer.value === "string" && typeof current === "string" && current) {
				if (
					peer.field === "description"
						? containsDescriptionExcerpt(current, peer.value)
						: candidateKey(peer.value) === candidateKey(current)
				)
					score += identity ? 2 : 1;
				else if (
					candidate.section === "education" &&
					peer.field === "school" &&
					nativeSchool &&
					candidateKey(nativeSchool) === candidateKey(current)
				)
					score += 2;
				else if (
					candidate.section === "experience" &&
					peer.field === "company" &&
					matchesSplitCompany(current, record.location, peer.value, location)
				) {
					// PDF extraction can flatten the adjacent employer and location into one line.
					score += 2;
				} else if (candidate.section === "experience" && peer.field === "position" && matchesRole(current, peer.value))
					score++;
				else if (identity) return [];
			} else if (peer.field === "dates" && current && typeof current === "object") {
				const target =
					peer.value && typeof peer.value === "object"
						? peer.value
						: quotedDate?.start &&
							  !quotedDate.raw &&
							  typeof role === "string" &&
							  typeof record.position === "string" &&
							  candidateKey(role) === candidateKey(record.position)
							? quotedDate
							: undefined;
				if (target) {
					const dates = current as typeof target;
					if (dates.start === target.start && dates.end === target.end && dates.present === target.present) score++;
				}
			}
		}
		return score ? [{ id: entry.id, score }] : [];
	});
	matches.sort((a, b) => b.score - a.score);
	const best = matches[0];
	if (best && best.score !== matches[1]?.score) return best.id;
	return "new";
}

/** A bulk click approves this local draft only. Resolve one new record per source entity. */
export function applyImportReviewCandidates(state: ReviewState, targets: Record<string, string>): ReviewState {
	const candidates = state.aiReview?.result?.kind === "extraction" ? state.aiReview.result.candidates : [];
	let next = state;
	const created = new Map<string, string>();
	const createdEntryIds = new Set<string>();
	for (const candidate of candidates) {
		if (candidate.value === null || next.aiReview?.appliedCandidateIds.includes(candidate.id)) continue;
		const group = `${candidate.section}:${candidate.entityId}`;
		const existingGroupTarget = created.get(group);
		const explicitTarget = targets[candidate.id];
		const target =
			existingGroupTarget ??
			(explicitTarget && !createdEntryIds.has(explicitTarget) ? explicitTarget : undefined) ??
			getImportCandidateTarget(next, candidate, createdEntryIds);
		next = applyImportReviewCandidate(next, candidate.id, target);
		if (target === "new") {
			const change = next.aiReview?.appliedChanges?.at(-1);
			if (change) {
				created.set(group, change.entryId);
				createdEntryIds.add(change.entryId);
			}
		}
	}
	return next;
}

export function undoImportReviewCandidate(state: ReviewState, candidateId: string): ReviewState {
	const review = state.aiReview;
	const change = review?.appliedChanges?.find((c) => c.candidateId === candidateId);
	if (!review || !change || review.draftGeneration !== importDraftGeneration(state.data))
		throw new Error("AI_IMPORT_STALE");
	const changes = review.appliedChanges?.filter((c) => c.candidateId !== candidateId) ?? [];
	const data = produce(state.data, (draft) => {
		const section = resolveSection(draft, change.section);
		const entry = section ? getEntries(draft, section).find((e) => e.id === change.entryId) : undefined;
		if (!entry || !section) throw new Error("AI_IMPORT_TARGET_UNAVAILABLE");
		const record = entry as unknown as Record<string, unknown>;
		if (change.appendedKeyword && Array.isArray(record[change.field]))
			record[change.field] = (record[change.field] as string[]).filter((word) => word !== change.appendedKeyword);
		else {
			if (JSON.stringify(record[change.field]) !== JSON.stringify(change.after)) throw new Error("AI_IMPORT_STALE");
			record[change.field] = structuredClone(change.before);
		}
		if (change.createdEntry && !changes.some((c) => c.entryId === change.entryId)) {
			const items = getEntries(draft, section);
			items.splice(
				items.findIndex((e) => e.id === change.entryId),
				1,
			);
		}
	});
	const next = parseResumeDataForWrite(data);
	const entityKey = `${change.section}:${change.entryId}`;
	const { submission: _submission, ...rest } = state;
	return {
		...rest,
		data: next,
		confirmationFlow: crypto.randomUUID(),
		confirmed: Object.fromEntries(Object.entries(state.confirmed).filter(([key]) => !key.startsWith(`${entityKey}:`))),
		reviewed: Object.fromEntries(
			Object.entries(state.reviewed).filter(([key]) => key !== entityKey && !key.startsWith(`${entityKey}:`)),
		),
		aiReview: {
			...review,
			draftGeneration: importDraftGeneration(next),
			appliedCandidateIds: review.appliedCandidateIds.filter((id) => id !== candidateId),
			appliedChanges: changes,
		},
	};
}
