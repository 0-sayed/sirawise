import type { ResumeData } from "@reactive-resume/schema/resume/data";
import type {
	TranslationTarget,
	VariantDecisionInput,
	VariantReviewView,
	VariantTerminology,
} from "@reactive-resume/schema/resume/variants";
import { buildTranslationInventory } from "@reactive-resume/resume/translation";

export const MAX_DECISION_SUBJECTS = 100;

const UNRESOLVED_PLACEHOLDER_PATTERN = /\[(?:redacted|LOCAL[\s_-]*[\d٠-٩۰-۹]+|NAME[\s_-]*[\d٠-٩۰-۹]+)\]/iu;

function hasUnresolvedTranslationPlaceholder(text: string): boolean {
	return UNRESOLVED_PLACEHOLDER_PATTERN.test(text);
}

export function extractVariantDecisionError(error: unknown): { reason: string | null; segmentId: string | null } {
	if (!error || typeof error !== "object") return { reason: null, segmentId: null };
	const data = "data" in error && error.data && typeof error.data === "object" ? error.data : null;
	const reason = data && "reason" in data && typeof data.reason === "string" ? data.reason : null;
	const segmentId = data && "segmentId" in data && typeof data.segmentId === "string" ? data.segmentId : null;
	return { reason, segmentId };
}

export type TranslationTerm = VariantTerminology["terms"][number];

export type TermGroup = {
	source: string;
	value: string;
	ids: string[];
	pendingIds: string[];
	count: number;
	status: "pending" | "confirmed";
	representative: TranslationTerm;
};

export type GroupedTerms = {
	pending: TermGroup[];
	confirmed: TermGroup[];
	pendingTermIds: string[];
};

export type SegmentStatus = "pending" | "accepted" | "rejected";

export type SegmentItem = {
	id: string;
	before: string;
	after: string;
	status: SegmentStatus;
	hasUnresolvedPlaceholder?: boolean;
	edited?: boolean;
};

type SegmentGroup = {
	key: string;
	sectionId: TranslationTarget["sectionId"] | "other";
	customSectionId?: string;
	customTitle?: string;
	items: SegmentItem[];
	pendingIds: string[];
	unresolvedIds: string[];
	acceptedCount: number;
	totalCount: number;
	gapCount: number;
};

export type GroupedSegments = {
	actionableCount: number;
	groups: SegmentGroup[];
	pendingSegmentIds: string[];
	unresolvedSegmentIds: string[];
	acceptedCount: number;
	totalCount: number;
};

export type UndoableEntry = {
	decisionId: string;
	subjectIds: string[];
};

export type TranslationUndoAction =
	| { kind: "segment"; segmentId: string; sectionKey: string | null; entries: UndoableEntry[]; count: number }
	| { kind: "section"; sectionKey: string; entries: UndoableEntry[]; count: number }
	| { kind: "all"; entries: UndoableEntry[]; count: number };

export function chunkSubjectIds(ids: readonly string[], chunkSize = MAX_DECISION_SUBJECTS): string[][] {
	if (chunkSize < 1) throw new Error("chunkSize must be positive");
	const chunks: string[][] = [];
	for (let index = 0; index < ids.length; index += chunkSize) {
		chunks.push(ids.slice(index, index + chunkSize));
	}
	return chunks;
}

export async function submitChunkedVariantDecision<Response extends { decisionId: string; updatedAt: string }>({
	operationId,
	expectedUpdatedAt,
	expectedDecisionId,
	input,
	submit,
	createRequestKey = () => crypto.randomUUID(),
}: {
	operationId: string;
	expectedUpdatedAt: string;
	expectedDecisionId: string | null;
	input: Pick<VariantDecisionInput, "subjectIds" | "decision"> &
		Partial<Pick<VariantDecisionInput, "editedText" | "undoDecisionId">>;
	submit: (payload: VariantDecisionInput) => Promise<Response>;
	createRequestKey?: () => string;
}): Promise<Response> {
	const chunkSize = input.decision === "accept_edited" ? 1 : MAX_DECISION_SUBJECTS;
	const chunks = chunkSubjectIds(input.subjectIds, chunkSize);
	let nextUpdatedAt = expectedUpdatedAt;
	let nextDecisionId = expectedDecisionId;
	let lastResponse: Response | undefined;

	for (const subjectIds of chunks) {
		lastResponse = await submit({
			operationId,
			requestKey: createRequestKey(),
			expectedUpdatedAt: nextUpdatedAt,
			expectedDecisionId: nextDecisionId,
			...input,
			subjectIds,
		});
		nextUpdatedAt = lastResponse.updatedAt;
		nextDecisionId = lastResponse.decisionId;
	}

	if (!lastResponse) throw new Error("EMPTY_DECISION_SUBJECTS");
	return lastResponse;
}

export async function submitApproveTranslation<Response extends { decisionId: string; updatedAt: string }>({
	pendingSegmentIds,
	...request
}: {
	operationId: string;
	expectedUpdatedAt: string;
	expectedDecisionId: string | null;
	pendingSegmentIds: readonly string[];
	submit: (payload: VariantDecisionInput) => Promise<Response>;
}) {
	const previous = pendingSegmentIds.length
		? await submitChunkedVariantDecision({
				...request,
				input: { subjectIds: [...pendingSegmentIds], decision: "accept" },
			})
		: null;
	return submitChunkedVariantDecision({
		...request,
		expectedUpdatedAt: previous?.updatedAt ?? request.expectedUpdatedAt,
		expectedDecisionId: previous?.decisionId ?? request.expectedDecisionId,
		input: { subjectIds: ["translation"], decision: "accept" },
	});
}

export async function submitSequentialUndo<Response extends { decisionId: string; updatedAt: string }>({
	operationId,
	expectedUpdatedAt,
	expectedDecisionId,
	entries,
	submit,
	createRequestKey = () => crypto.randomUUID(),
}: {
	operationId: string;
	expectedUpdatedAt: string;
	expectedDecisionId: string | null;
	entries: readonly UndoableEntry[];
	submit: (payload: VariantDecisionInput) => Promise<Response>;
	createRequestKey?: () => string;
}): Promise<Response> {
	let nextUpdatedAt = expectedUpdatedAt;
	let nextDecisionId = expectedDecisionId;
	let lastResponse: Response | undefined;

	for (const entry of [...entries].reverse()) {
		lastResponse = await submit({
			operationId,
			requestKey: createRequestKey(),
			expectedUpdatedAt: nextUpdatedAt,
			expectedDecisionId: nextDecisionId,
			subjectIds: entry.subjectIds,
			decision: "undo",
			undoDecisionId: entry.decisionId,
		});
		nextUpdatedAt = lastResponse.updatedAt;
		nextDecisionId = lastResponse.decisionId;
	}

	if (!lastResponse) throw new Error("EMPTY_UNDO_ENTRIES");
	return lastResponse;
}

export function groupTranslationUndoActions(
	undoable: readonly UndoableEntry[],
	groupedSegments: GroupedSegments,
): TranslationUndoAction[] {
	const sectionKeyBySegmentId = new Map<string, string>();
	for (const group of groupedSegments.groups) {
		for (const item of group.items) {
			sectionKeyBySegmentId.set(item.id, group.key);
		}
	}

	const entrySections = (entry: UndoableEntry) => {
		const sections = new Set<string>();
		for (const id of entry.subjectIds) {
			const key = sectionKeyBySegmentId.get(id);
			if (key) sections.add(key);
		}
		return sections;
	};

	const buckets: Array<{ entries: UndoableEntry[]; subjectIds: Set<string>; sections: Set<string> }> = [];

	for (const entry of undoable) {
		const sections = entrySections(entry);
		const prev = buckets.at(-1);
		const prevLastEntry = prev?.entries.at(-1);
		const canMergeChunk =
			prev !== undefined &&
			prevLastEntry !== undefined &&
			prevLastEntry.subjectIds.length === MAX_DECISION_SUBJECTS &&
			entry.subjectIds.every((id) => !prev.subjectIds.has(id));

		if (canMergeChunk) {
			prev.entries.push(entry);
			for (const id of entry.subjectIds) prev.subjectIds.add(id);
			for (const key of sections) prev.sections.add(key);
		} else {
			buckets.push({
				entries: [entry],
				subjectIds: new Set(entry.subjectIds),
				sections,
			});
		}
	}

	return buckets.map((bucket) => {
		const count = bucket.subjectIds.size;
		const sectionKeys = [...bucket.sections];
		if (sectionKeys.length > 1) {
			return { kind: "all", entries: bucket.entries, count };
		}
		if (count === 1 && bucket.entries.length === 1) {
			const segmentId = bucket.entries[0]?.subjectIds[0] ?? "";
			return { kind: "segment", segmentId, sectionKey: sectionKeys[0] ?? null, entries: bucket.entries, count: 1 };
		}
		if (sectionKeys.length === 1 && sectionKeys[0]) {
			return { kind: "section", sectionKey: sectionKeys[0], entries: bucket.entries, count };
		}
		return { kind: "all", entries: bucket.entries, count };
	});
}

export function groupTranslationTerms(terms: readonly TranslationTerm[]): GroupedTerms {
	const bySource = new Map<string, TermGroup>();
	const pendingTermIds: string[] = [];

	for (const term of terms) {
		if (term.status !== "confirmed") pendingTermIds.push(term.id);
		const existing = bySource.get(term.source);
		if (existing) {
			existing.ids.push(term.id);
			if (term.status !== "confirmed") {
				existing.pendingIds.push(term.id);
				existing.status = "pending";
			}
			existing.count = existing.ids.length;
		} else {
			const isPending = term.status !== "confirmed";
			bySource.set(term.source, {
				source: term.source,
				value: term.value,
				ids: [term.id],
				pendingIds: isPending ? [term.id] : [],
				count: 1,
				status: isPending ? "pending" : "confirmed",
				representative: term,
			});
		}
	}

	const pending: TermGroup[] = [];
	const confirmed: TermGroup[] = [];
	for (const group of bySource.values()) {
		if (group.status === "pending") pending.push(group);
		else confirmed.push(group);
	}

	return { pending, confirmed, pendingTermIds };
}

export function groupTranslationSegments({
	resultSegments,
	sourceSegments,
	segments,
	statuses,
	sourceData,
	terms,
	gapIds = new Set<string>(),
}: {
	resultSegments: ReadonlyArray<{ sourceId: string; text: string }>;
	sourceSegments: readonly VariantReviewView["sourceSegments"][number][];
	segments: Record<string, { text: string; status: SegmentStatus; author?: "model" | "user" } | undefined>;
	statuses: Record<string, SegmentStatus | undefined>;
	sourceData?: ResumeData | undefined;
	terms: readonly TranslationTerm[];
	gapIds?: ReadonlySet<string>;
}): GroupedSegments {
	const sourceTextById = new Map(sourceSegments.map((segment) => [segment.id, segment.text]));
	const resultIds = new Set(resultSegments.map(({ sourceId }) => sourceId));
	const untranslatedSegments = sourceSegments.flatMap(({ id, text, untranslated }) =>
		untranslated && !resultIds.has(id) ? [{ sourceId: id, text }] : [],
	);
	const targetById = new Map<string, TranslationTarget>();
	const customTitleById = new Map<string, string>();

	if (sourceData) {
		for (const custom of sourceData.customSections) {
			if (custom.title.trim()) customTitleById.set(custom.id, custom.title.trim());
		}
		for (const segment of buildTranslationInventory(sourceData).segments) {
			targetById.set(segment.id, segment.target);
		}
	}
	for (const term of terms) {
		const segmentId = term.id.startsWith("term:") ? term.id.slice("term:".length) : term.id;
		if (!targetById.has(segmentId)) targetById.set(segmentId, term.target);
	}

	const groupsByKey = new Map<string, SegmentGroup>();
	const pendingSegmentIds: string[] = [];
	const unresolvedSegmentIds: string[] = [];
	let acceptedCount = 0;

	for (const segment of [...resultSegments, ...untranslatedSegments]) {
		const id = segment.sourceId;
		const reviewed = segments[id];
		const status: SegmentStatus = statuses[id] ?? reviewed?.status ?? "pending";
		const after = reviewed?.text ?? segment.text;
		const unresolved = hasUnresolvedTranslationPlaceholder(after);
		const item: SegmentItem = {
			id,
			before: sourceTextById.get(id) ?? "",
			after,
			status,
			hasUnresolvedPlaceholder: unresolved,
			...(reviewed?.author === "user" ? { edited: true } : {}),
		};

		if (status === "accepted") acceptedCount += 1;
		if (status === "pending" && reviewed) pendingSegmentIds.push(id);
		if (unresolved) unresolvedSegmentIds.push(id);

		const target = targetById.get(id);
		const customSectionId = target && "customSectionId" in target ? target.customSectionId : undefined;
		const sectionId: SegmentGroup["sectionId"] = target ? target.sectionId : "other";
		const key = customSectionId ? `custom:${customSectionId}` : sectionId;

		let group = groupsByKey.get(key);
		if (!group) {
			const customTitle = customSectionId ? customTitleById.get(customSectionId) : undefined;
			group = {
				key,
				sectionId,
				...(customSectionId ? { customSectionId } : {}),
				...(customTitle ? { customTitle } : {}),
				items: [],
				pendingIds: [],
				unresolvedIds: [],
				acceptedCount: 0,
				totalCount: 0,
				gapCount: 0,
			};
			groupsByKey.set(key, group);
		}

		group.items.push(item);
		group.totalCount += 1;
		if (gapIds.has(id)) group.gapCount += 1;
		if (status === "accepted") group.acceptedCount += 1;
		if (status !== "accepted" && reviewed) group.pendingIds.push(id);
		if (unresolved) group.unresolvedIds.push(id);
	}

	return {
		groups: [...groupsByKey.values()],
		actionableCount: Object.values(segments).filter(Boolean).length,
		pendingSegmentIds,
		unresolvedSegmentIds,
		acceptedCount,
		totalCount: resultSegments.length,
	};
}
