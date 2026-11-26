import type { SafetyExpected, SafetyInput } from "./types";
import { opaqueFixture } from "./fixture-identifiers";

/** Join the offline labels to the same opaque IDs that the runtime records in receipts. */
export function bindExpectedIdentifiers(
	fixtures: readonly SafetyInput[],
	labels: readonly SafetyExpected[],
	seed: string,
) {
	const byId = new Map(fixtures.map((input) => [input.id, input]));
	return labels.map((label) => {
		const input = byId.get(label.id);
		if (!input) throw new Error("QUALIFICATION_EXPECTATIONS_CHANGED");
		const { aliases } = opaqueFixture(input, seed);
		const itemAlias = (id: string) => {
			// The job guard assigns note IDs by original position before filtering.
			if (input.feature === "job-evidence" && /^note:\d+$/u.test(id)) return id;
			const prefix = id.startsWith("question:") ? "question:" : "";
			const alias = aliases.get(id.slice(prefix.length));
			if (!alias) throw new Error("QUALIFICATION_EXPECTATIONS_CHANGED");
			return `${prefix}${alias}`;
		};
		return {
			...label,
			caught: label.caught.map((issue) => ({ ...issue, itemId: itemAlias(issue.itemId) })),
			retainedIds: label.retainedIds.map(itemAlias),
		};
	});
}
