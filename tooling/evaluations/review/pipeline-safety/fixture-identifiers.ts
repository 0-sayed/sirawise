import type { SafetyInput } from "./types";
import { createHmac } from "node:crypto";

export const qualificationSelectionId = "e1";

const identifierKeys = new Set([
	"id",
	"sourceId",
	"flowId",
	"resumeId",
	"entityId",
	"passageId",
	"evidenceIds",
	"spanIds",
	"excerptedPassageIds",
]);

/** Preserve references and duplicates while removing fixture labels before building verifier requests. */
export function opaqueFixture(input: SafetyInput, seed: string) {
	const aliases = new Map([["selected", qualificationSelectionId]]);
	const rewrite = (value: unknown, identifier = false): unknown => {
		if (typeof value === "string" && identifier) {
			const alias =
				aliases.get(value) ??
				`x${createHmac("sha256", Buffer.from(seed, "hex"))
					.update(JSON.stringify([input.id, value]))
					.digest("hex")
					.slice(0, 12)}`;
			aliases.set(value, alias);
			return alias;
		}
		if (Array.isArray(value)) return value.map((entry) => rewrite(entry, identifier));
		if (value && typeof value === "object")
			return Object.fromEntries(
				Object.entries(value).map(([key, entry]) => [key, rewrite(entry, identifierKeys.has(key))]),
			);
		return value;
	};
	return {
		input: {
			...input,
			source: rewrite(input.source) as SafetyInput["source"],
			candidate: rewrite(input.candidate) as SafetyInput["candidate"],
		},
		aliases,
	};
}
