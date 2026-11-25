import { Trans } from "@lingui/react/macro";
import { useState } from "react";
import { buildJobPassages } from "@reactive-resume/resume/ats";
import { Checkbox } from "@reactive-resume/ui/components/checkbox";
import { Label } from "@reactive-resume/ui/components/label";
import { savePendingChanges, useResumeStore } from "../builder/draft";
import { ReviewLaunch, ReviewOperationPanel } from "../editor/proposals/review-operation";
import { useVariantsCopy } from "./copy.generated";
import { TranslationReview } from "./translation-review";
import { client } from "@/libs/orpc/client";
const MAX_SELECTED_FACTS = 49;
export function SummaryReview({ locked }: { locked: boolean }) {
	const copy = useVariantsCopy();
	const document = useResumeStore((state) => state.resume);
	const [selected, setSelected] = useState<string[]>([]);
	const [retryRequest, setRetryRequest] = useState(0);
	const [operationId, setOperationId] = useState<string | null>(null);
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
				onStarted={setOperationId}
			>
				<Trans>Review summary</Trans>
			</ReviewLaunch>
			{operationId && (
				<ReviewOperationPanel
					kind="review.summary"
					onRetry={() => setRetryRequest((n) => n + 1)}
					operationId={operationId}
				>
					<TranslationReview operationId={operationId} onClose={() => setOperationId(null)} />
				</ReviewOperationPanel>
			)}
		</div>
	);
}
