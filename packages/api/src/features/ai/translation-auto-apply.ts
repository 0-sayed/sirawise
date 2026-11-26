import type { ProtectedTranslation } from "./translation-invariants";
import type { buildTranslationInventory } from "@reactive-resume/resume/translation";
import { hasUnresolvedTranslationPlaceholder, resolveTranslationText } from "./translation-placeholders";

export type TranslationAutoApplyEvaluation =
	| { ready: true }
	| { ready: false; reason: "pending_terms" | "rejected_segments" | "incomplete_segments" | "blocking_sections" }
	| { ready: false; reason: "unresolved_placeholders"; segmentIds: string[] };

export function evaluateTranslationAutoApply({
	inventory,
	placeholders,
	contactValues,
	basicsName,
	terms,
	segments,
	withheldSegmentIds = new Set<string>(),
	protection,
}: {
	inventory: ReturnType<typeof buildTranslationInventory>;
	placeholders: ReadonlyArray<{ token: string; value: string }>;
	contactValues: string[];
	basicsName?: string | undefined;
	terms: ReadonlyArray<{ id: string; source: string; value: string; status: "pending" | "confirmed" }>;
	segments: Record<string, { text: string; status: "pending" | "accepted" | "rejected" } | undefined>;
	withheldSegmentIds?: ReadonlySet<string>;
	protection?: ProtectedTranslation | undefined;
}): TranslationAutoApplyEvaluation {
	if (terms.some((term) => term.status === "pending" && term.value !== term.source))
		return { ready: false, reason: "pending_terms" };
	if (inventory.blocking.length) return { ready: false, reason: "blocking_sections" };
	const segmentEntries = Object.values(segments);
	if (segmentEntries.some((segment) => segment?.status === "rejected"))
		return { ready: false, reason: "rejected_segments" };
	const actionable = inventory.segments.filter(({ id }) => !withheldSegmentIds.has(id));
	if (!actionable.length || actionable.length !== Object.keys(segments).length)
		return { ready: false, reason: "incomplete_segments" };

	const unresolvedSegmentIds: string[] = [];
	for (const segment of actionable) {
		const candidate = segments[segment.id];
		if (!candidate) return { ready: false, reason: "incomplete_segments" };
		const term = terms.find((entry) => entry.id === `term:${segment.id}`);
		const resolved = resolveTranslationText({
			text: candidate.text,
			sourceText: segment.text,
			placeholders,
			terms,
			contactValues,
			basicsName,
			termValue: term?.value,
			scope: protection ? { sourceId: segment.id, localMap: protection.localMap } : undefined,
		});
		if (hasUnresolvedTranslationPlaceholder(resolved)) unresolvedSegmentIds.push(segment.id);
	}
	if (unresolvedSegmentIds.length)
		return { ready: false, reason: "unresolved_placeholders", segmentIds: unresolvedSegmentIds };
	return { ready: true };
}
