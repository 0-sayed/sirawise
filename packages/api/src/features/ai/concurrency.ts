import type { OperationRequest } from "@reactive-resume/schema/ai-operation";
import { denyAllowance } from "./usage";

/** Owner-approved account limit, independent of credits and platform call capacity. */
const MAX_CONCURRENT_AI_OPERATIONS = 3;
type ActiveOperation = Pick<OperationRequest, "kind" | "parameters" | "sources"> & { id: string };

function targetOf(
	request: Pick<OperationRequest, "kind" | "parameters" | "sources">,
	importFlows?: ReadonlyMap<string, string>,
) {
	const { kind, parameters, sources } = request;
	// Prefer the operation's bound target over additional sources supplied as context.
	const target =
		kind === "review.cover-letter"
			? { kind: "cover-letter", id: parameters.letterId }
			: kind === "review.extraction"
				? { kind: "import", id: parameters.sourceId }
				: { kind: "resume", id: parameters.resumeId };
	const source =
		sources.find((source) => source.kind === target.kind && source.id === target.id) ??
		sources.find((source) => source.kind === "cover-letter") ??
		sources.find((source) => source.kind === "import") ??
		sources.find((source) => source.kind === "resume");
	if (!source) return null;
	const id = source.kind === "import" ? (importFlows?.get(source.id) ?? source.id) : source.id;
	return `${source.kind}:${id}`;
}
function logicalId(operation: ActiveOperation) {
	const batch = operation.parameters.translationBatch as { rootId: string } | undefined;
	return operation.kind === "review.translation" && batch ? batch.rootId : operation.id;
}

/** Call only while holding the database account lock, before insertion or reservation. */
export function assertOperationConcurrency(
	request: OperationRequest,
	active: readonly ActiveOperation[],
	{ internalRootId, importFlows }: { internalRootId?: string; importFlows?: ReadonlyMap<string, string> } = {},
): void {
	const target = targetOf(request, importFlows);
	if (
		target &&
		active.some((operation) => logicalId(operation) !== internalRootId && targetOf(operation, importFlows) === target)
	)
		denyAllowance("AI_TARGET_BUSY");
	const groups = new Set(active.map(logicalId));
	if (internalRootId && groups.has(internalRootId)) return;
	if (groups.size >= MAX_CONCURRENT_AI_OPERATIONS)
		denyAllowance("AI_CONCURRENCY_LIMIT", {
			limit: MAX_CONCURRENT_AI_OPERATIONS,
			used: 0,
			reserved: groups.size,
			remaining: 0,
		});
}
