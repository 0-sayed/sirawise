import type { JobTermReport, JobTermAnalysisInput } from "@reactive-resume/schema/job-evidence";
import { Trans } from "@lingui/react/macro";
import { Link } from "@tanstack/react-router";
import { SectionCard } from "@reactive-resume/ui/components/section-card";
import { useVariantsCopy } from "../resume/variants/copy.generated";

type LiteralJobEvidenceProps = { report: JobTermReport; resumeId: string; passages: JobTermAnalysisInput["passages"] };
/** Exact selected terms and their local evidence; missing words never imply missing ability. */
export function LiteralJobEvidence({ report, resumeId, passages }: LiteralJobEvidenceProps) {
	const copy = useVariantsCopy();
	const renderTerm = (term: JobTermReport["terms"][number]) => {
		const spans = [
			...new Map(term.cvSpans.map((span) => [`${span.passageId}:${span.start}:${span.end}`, span])).values(),
		];
		const distinctPassages = [...new Map(spans.map((span) => [span.passageId, span])).values()];
		const examples = [...distinctPassages, ...spans.filter((span) => !distinctPassages.includes(span))].slice(0, 2);
		return (
			<details key={term.term}>
				<summary dir="auto">
					{term.term} ·{" "}
					{term.matched ? (
						<>
							<Trans>Found in CV</Trans> · {copy("jobs.coverage.occurrences", { total: String(spans.length) })}
						</>
					) : (
						<Trans>Not found in CV</Trans>
					)}
				</summary>
				<div className="grid gap-2">
					{examples.map((span) => {
						const text = passages.find((passage) => passage.id === span.passageId)?.text;
						const start = Math.max(0, span.start - 48);
						const end = Math.min(text?.length ?? 0, span.end + 48);
						const snippet = text
							? `${start ? "…" : ""}${text.slice(start, end)}${end < text.length ? "…" : ""}`
							: span.quote;
						return (
							<Link
								key={span.id}
								to="/builder/$resumeId"
								params={{ resumeId }}
								search={{ source: span.target }}
								aria-label={`${copy("jobs.evidence.showInCv")}: ${snippet}`}
								dir="auto"
							>
								{snippet}
							</Link>
						);
					})}
				</div>
			</details>
		);
	};
	return (
		<SectionCard>
			<h3 className="type-label">
				<Trans>Literal text coverage</Trans>
			</h3>
			{report ? (
				<>
					<p>
						<Trans>
							{report.matchedCount} of {report.denominator} selected terms appear in this CV.
						</Trans>
					</p>
					<p className="type-metadata text-ink-2">
						<Trans>
							Up to 35 distinct ranked terms. Arabic marks and digit forms, case and known aliases are normalized. This
							checks text occurrence, not ability or all advertised requirements.
						</Trans>
					</p>
					{report.state === "not-checkable" && (
						<p>
							<Trans>No terms stood out in this ad.</Trans>
						</p>
					)}
					{[true, false].map((matched) => {
						const group = report.terms.filter((term) => term.matched === matched);
						const count = group.length;
						const remaining = Math.max(0, count - 5);
						return (
							<section key={String(matched)} className="grid gap-2">
								<h4 className="type-label">
									{matched ? (
										<Trans context="jobs.coverage.foundGroup">Found in CV: {count}</Trans>
									) : (
										<Trans context="jobs.coverage.missingGroup">Not found in CV: {count}</Trans>
									)}
								</h4>
								{group.slice(0, 5).map(renderTerm)}
								{remaining > 0 && (
									<details>
										<summary>
											<Trans context="jobs.coverage.more">Show {remaining} more terms</Trans>
										</summary>
										{group.slice(5).map(renderTerm)}
									</details>
								)}
							</section>
						);
					})}
					{report.selection.truncated && (
						<details>
							<summary>{copy("jobs.coverage.excluded", { total: String(new Set(report.excludedTerms).size) })}</summary>
							<ul>
								{[...new Set(report.excludedTerms)].map((term) => (
									<li key={term} dir="auto">
										{term}
									</li>
								))}
							</ul>
						</details>
					)}
				</>
			) : null}
		</SectionCard>
	);
}
