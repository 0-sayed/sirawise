import type { ApprovedRoute, OperationHandler } from "@reactive-resume/api/features/ai/route-policy";
import {
	resolveReviewVerifierRoute,
	canonicalVerifierRouteSha256,
} from "@reactive-resume/api/features/ai/verifier-policy";
import { resolveWriterRoute } from "@reactive-resume/api/features/ai/writer-policy";

export type QualificationSelection = {
	feature: "translation" | "job-evidence" | "extraction";
	endpointSlot: "primary" | "backup";
	writerModel: string;
	verifierModel: string;
	promptVersion: string;
	schemaVersion: string;
	routeSha256: string;
	manifestSha256: string;
	scoredReceiptsSha256: string;
};
type ContractTuple = Omit<QualificationSelection, "manifestSha256" | "scoredReceiptsSha256">;
const sha256 = /^[a-f0-9]{64}$/u;

export function selectQualifiedContract(
	expected: ContractTuple,
	selections: readonly QualificationSelection[],
): boolean {
	return selections.some(
		(selection) =>
			selection.feature === expected.feature &&
			selection.endpointSlot === expected.endpointSlot &&
			selection.writerModel === expected.writerModel &&
			selection.verifierModel === expected.verifierModel &&
			selection.promptVersion === expected.promptVersion &&
			selection.schemaVersion === expected.schemaVersion &&
			selection.routeSha256 === expected.routeSha256 &&
			sha256.test(selection.routeSha256) &&
			sha256.test(selection.manifestSha256) &&
			sha256.test(selection.scoredReceiptsSha256),
	);
}

export function resolvePrimaryContract(
	route: ApprovedRoute,
	feature: QualificationSelection["feature"],
	versions: Pick<OperationHandler, "promptVersion" | "schemaVersion">,
	writerConfig?: unknown,
) {
	const writer = resolveWriterRoute(route, { kind: `review.${feature}`, parameters: {} }, writerConfig);
	const verifier = resolveReviewVerifierRoute(writer);
	const tuple: ContractTuple = {
		feature,
		endpointSlot: "primary",
		writerModel: writer.model,
		verifierModel: verifier.model,
		promptVersion: versions.promptVersion,
		schemaVersion: versions.schemaVersion,
		routeSha256: canonicalVerifierRouteSha256(verifier),
	};
	return { tuple, verifier };
}
