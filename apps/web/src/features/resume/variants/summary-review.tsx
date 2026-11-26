import { Trans } from "@lingui/react/macro";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { buildJobPassages } from "@reactive-resume/resume/ats";
import { Checkbox } from "@reactive-resume/ui/components/checkbox";
import { Label } from "@reactive-resume/ui/components/label";
import { savePendingChanges, useResumeStore } from "../builder/draft";
import { ReviewLaunch, ReviewOperationPanel } from "../editor/proposals/review-operation";
import { useVariantsCopy } from "./copy.generated";
import { TranslationReview } from "./translation-review";
import { client, orpc } from "@/libs/orpc/client";
const MAX_SELECTED_FACTS = 49;
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
	const [selected, setSelected] = useState<string[]>([]);
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
	const facts = buildJobPassages(document.data);
	const selectedEvidenceIds = selected.filter((id) => facts.some((fact) => fact.id === id));
	return (
		<div className="grid gap-3">
			<details>
				<summary>
					<Trans>Select facts for the summary</Trans>
				</summary>
				<p>
					<Trans>Select up to 49 facts for one summary review.</Trans>
				</p>
				<div className="grid gap-2">
					{facts.map((fact) => (
						<Label key={fact.id}>
							<Checkbox
								checked={selected.includes(fact.id)}
								disabled={locked || (!selected.includes(fact.id) && selected.length >= MAX_SELECTED_FACTS)}
								onCheckedChange={(checked) =>
									setSelected((previous) =>
										checked
											? previous.includes(fact.id) || previous.length >= MAX_SELECTED_FACTS
												? previous
												: [...previous, fact.id]
											: previous.filter((id) => id !== fact.id),
									)
								}
							/>
							<span dir="auto">{fact.text}</span>
						</Label>
					))}
				</div>
			</details>
			{selectedEvidenceIds.length === 0 && (
				<p className="type-body text-ink-2">{copy("review.summary.factsRequired")}</p>
			)}
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
				<Trans>Review summary</Trans>
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
