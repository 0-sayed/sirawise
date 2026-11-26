import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { savePendingChanges, useResumeStore } from "../builder/draft";
import { ReviewLaunch, ReviewOperationPanel } from "../editor/proposals/review-operation";
import { useVariantsCopy } from "./copy.generated";
import { SummaryFactPicker } from "./summary-fact-picker";
import { getSummaryFacts, recommendSummaryFacts } from "./summary-facts";
import { TranslationReview } from "./translation-review";
import { client, orpc } from "@/libs/orpc/client";
export function SummaryReview({
	locked,
	launchOnly = false,
	onStarted,
}: {
	locked: boolean;
	launchOnly?: boolean;
	onStarted?: (id: string) => void;
}) {
	const copy = useVariantsCopy();
	const document = useResumeStore((state) => state.resume);
	const data = document?.data;
	const facts = useMemo(() => (data ? getSummaryFacts(data) : []), [data]);
	const recommended = useMemo(() => recommendSummaryFacts(facts), [facts]);
	const [selection, setSelection] = useState<{ resumeId: string; ids: string[] }>();
	const [retryRequest, setRetryRequest] = useState(0);
	const [launched, setLaunched] = useState<string | null>(null);
	const [closed, setClosed] = useState<string | null>(null);
	const cache = useQueryClient();
	const history = useQuery({
		...orpc.ai.review.list.queryOptions({ input: { resumeId: document?.id ?? "" } }),
		enabled: Boolean(document) && !launchOnly,
	});
	const summaries = history.data?.filter(({ kind }) => kind === "review.summary") ?? [];
	const latest =
		summaries.find((entry) => entry.pendingCount || entry.unansweredQuestionCount || entry.continuationAvailable) ??
		summaries[0];
	const operationId = launchOnly ? null : (launched ?? latest?.operationId);
	const [continuationParent, setContinuationParent] = useState<string | null>(null);
	const retry = () => {
		const parent = continuationParent ?? summaries.find((entry) => entry.operationId === operationId)?.continuationOf;
		if (parent) {
			setLaunched(parent);
			setContinuationParent(null);
			return;
		}
		setRetryRequest((n) => n + 1);
	};
	const start = (id: string) => {
		setClosed(null);
		setLaunched(id);
		onStarted?.(id);
		void cache.invalidateQueries({ queryKey: orpc.ai.review.list.key() });
	};
	if (!document) return null;
	const factIds = new Set(facts.map(({ id }) => id));
	const currentSelection = (value: typeof selection) =>
		value?.resumeId === document.id ? value.ids.filter((id) => factIds.has(id)) : recommended;
	const selectedEvidenceIds = currentSelection(selection);
	return (
		<div className="grid gap-3">
			<SummaryFactPicker
				key={document.id}
				data={document.data}
				facts={facts}
				selected={selectedEvidenceIds}
				recommended={recommended}
				locked={locked}
				onSelect={(update) =>
					setSelection((previous) => ({ resumeId: document.id, ids: update(currentSelection(previous)) }))
				}
			/>
			<ReviewLaunch
				retryRequest={retryRequest}
				kind="review.summary"
				disabled={locked || selectedEvidenceIds.length === 0}
				prepare={async () => {
					if (!(await savePendingChanges(document.id))) throw new Error("SAVE_REQUIRED");
					const saved = useResumeStore.getState();
					if (saved.resume?.id !== document.id || !saved.acknowledgedUpdatedAt) throw new Error("SOURCE_CHANGED");
					return client.ai.variantReview.prepare({
						kind: "review.summary",
						resumeId: document.id,
						expectedUpdatedAt: saved.acknowledgedUpdatedAt.toISOString(),
						selectedEvidenceIds,
					});
				}}
				onStarted={(id) => {
					setContinuationParent(null);
					start(id);
				}}
			>
				{copy("review.summary.launch")}
			</ReviewLaunch>
			{operationId && operationId !== closed && (
				<ReviewOperationPanel kind="review.summary" onRetry={retry} operationId={operationId}>
					<TranslationReview
						key={operationId}
						operationId={operationId}
						onClose={() => {
							setLaunched(null);
							setClosed(operationId);
						}}
						onContinued={(id) => {
							setContinuationParent(operationId);
							start(id);
						}}
						continued={summaries.find((entry) => entry.operationId === operationId)?.continued}
					/>
				</ReviewOperationPanel>
			)}
		</div>
	);
}
