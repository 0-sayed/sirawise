import type { AiRuntime, ApprovedRoute } from "./route-policy";
import { createHash } from "node:crypto";
import { processingCopy } from "./processing-copy.generated";
import { resolveReviewVerifierRoutes } from "./verifier-policy";

type Locale = "ar-SA" | "en-US";

const scopePrefix = "privacy.ai.scope.";
export const processingPurposes = Object.keys(processingCopy)
	.filter((key) => key.startsWith(scopePrefix))
	.map((key) => `review.${key.slice(scopePrefix.length)}`)
	.sort();

export function accountProcessingNotice(route: ApprovedRoute, runtime: AiRuntime) {
	const { handlers } = runtime;
	const purposes = processingPurposes.filter((purpose) => Object.hasOwn(handlers, purpose));
	const backupPurposes = purposes.filter(
		(purpose) =>
			handlers[purpose]?.verifier &&
			route.verifier?.backup &&
			[route.model, ...(route.writers?.map((writer) => writer.model) ?? [])].some(
				(model) => resolveReviewVerifierRoutes({ ...route, model }, purpose).backup,
			),
	);
	const content = (locale: Locale) =>
		[
			processingCopy["privacy.ai.overseasNotice"][locale],
			...backupPurposes.map((purpose) =>
				purpose === "review.translation"
					? processingCopy["privacy.ai.backupTranslationNotice"][locale]
					: processingCopy["privacy.ai.backupNotice"][locale],
			),
		].join(" ");
	// Bind the account grant to both translations and the exact supported scope.
	const revision = createHash("sha256")
		.update(JSON.stringify([purposes, content("ar-SA"), content("en-US")]))
		.digest("hex");
	const accountPurpose = `account:${revision}`;
	const grantPurposes = (purpose: string) => {
		const supported = purposes.includes(purpose);
		// Only the local composition that issued these grants opts in to the original purpose binding.
		const legacy = supported && route.noticeVersion === runtime.legacyFeatureConsentVersion;
		return [...(supported ? [accountPurpose] : []), ...(runtime.fetch || legacy ? [purpose] : [])];
	};
	return { purpose: accountPurpose, purposes, content, grantPurposes };
}
