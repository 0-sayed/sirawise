import type { JobTermReport, JobTermAnalysisInput } from "@reactive-resume/schema/job-evidence";
import { Link } from "@tanstack/react-router";
import { useId, useState } from "react";
import { Badge } from "@reactive-resume/ui/components/badge";
import { Button } from "@reactive-resume/ui/components/button";
import { Icon } from "@reactive-resume/ui/components/icon";
import { Popover, PopoverContent, PopoverTitle, PopoverTrigger } from "@reactive-resume/ui/components/popover";
import { SectionCard, SectionCardTitle } from "@reactive-resume/ui/components/section-card";
import { useVariantsCopy } from "../resume/variants/copy.generated";

type LiteralJobEvidenceProps = { report: JobTermReport; resumeId: string; passages: JobTermAnalysisInput["passages"] };
type Phrase = JobTermReport["terms"][number];
type PhraseSources = Pick<LiteralJobEvidenceProps, "resumeId" | "passages">;

const VISIBLE_PHRASES = 6;

function phraseLabel(term: string) {
	return term.replaceAll("-", " ");
}

function FoundPhrase({ phrase, resumeId, passages }: PhraseSources & { phrase: Phrase }) {
	const copy = useVariantsCopy();
	const label = phraseLabel(phrase.term);
	const spans = [
		...new Map(phrase.cvSpans.map((span) => [`${span.passageId}:${span.start}:${span.end}`, span])).values(),
	];
	if (!spans.length) {
		return (
			<Badge variant="accent" shape="tag">
				<bdi dir="auto">{label}</bdi>
			</Badge>
		);
	}

	const distinctPassages = [...new Map(spans.map((span) => [span.passageId, span])).values()];
	const examples = [...distinctPassages, ...spans.filter((span) => !distinctPassages.includes(span))].slice(0, 2);

	return (
		<Popover>
			<PopoverTrigger render={<Button variant="secondary" />}>
				<bdi dir="auto">{label}</bdi>
				<Badge variant="accent" aria-hidden="true" className="tabular-nums">
					{spans.length}
				</Badge>
				<span className="sr-only">{copy("jobs.coverage.occurrences", { total: String(spans.length) })}</span>
				<Icon name="caret-down" aria-hidden />
			</PopoverTrigger>
			<PopoverContent align="start" className="text-start">
				<PopoverTitle dir="auto">{label}</PopoverTitle>
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
							className="wrap-anywhere text-accent-text underline"
							dir="auto"
						>
							{snippet}
						</Link>
					);
				})}
			</PopoverContent>
		</Popover>
	);
}

function PhraseGroup({
	phrases,
	matched,
	resumeId,
	passages,
}: PhraseSources & { phrases: Phrase[]; matched: boolean }) {
	const copy = useVariantsCopy();
	const id = useId();
	const [expanded, setExpanded] = useState(false);
	const visible = expanded ? phrases : phrases.slice(0, VISIBLE_PHRASES);
	return (
		<section aria-labelledby={`${id}-heading`} className="grid min-w-0 gap-2">
			<h3 id={`${id}-heading`} className="type-label">
				{copy(matched ? "jobs.coverage.foundGroup" : "jobs.coverage.missingGroup", { count: String(phrases.length) })}
			</h3>
			{phrases.length > 0 && (
				<ul id={id} className="flex flex-wrap items-center gap-2">
					{visible.map((phrase) => (
						<li key={phrase.term} className="max-w-full min-w-0">
							{matched ? (
								<FoundPhrase phrase={phrase} resumeId={resumeId} passages={passages} />
							) : (
								<Badge shape="tag">
									<bdi dir="auto">{phraseLabel(phrase.term)}</bdi>
								</Badge>
							)}
						</li>
					))}
				</ul>
			)}
			{phrases.length > VISIBLE_PHRASES && (
				<Button
					variant="quiet"
					className="justify-self-start"
					aria-controls={id}
					aria-expanded={expanded}
					onClick={() => setExpanded(!expanded)}
				>
					{copy(expanded ? "jobs.coverage.less" : "jobs.coverage.more")}
					<Icon name="caret-down" className="group-aria-expanded/button:rotate-180" aria-hidden />
				</Button>
			)}
		</section>
	);
}

export function LiteralJobEvidence({ report, resumeId, passages }: LiteralJobEvidenceProps) {
	const copy = useVariantsCopy();
	const titleId = useId();
	return (
		<SectionCard aria-labelledby={titleId} className="min-w-0 text-start">
			<header className="grid gap-1">
				<SectionCardTitle as="h2" id={titleId}>
					{copy("jobs.coverage.title")}
				</SectionCardTitle>
				<p className="type-body text-ink-2">{copy("jobs.coverage.description")}</p>
			</header>
			{report.state === "complete" ? (
				<>
					{[false, true].map((matched) => (
						<PhraseGroup
							key={String(matched)}
							matched={matched}
							phrases={report.terms.filter((phrase) => phrase.matched === matched)}
							resumeId={resumeId}
							passages={passages}
						/>
					))}
					{report.selection.truncated && <p className="type-metadata text-ink-2">{copy("jobs.coverage.truncated")}</p>}
				</>
			) : (
				<p className="type-body">{copy("jobs.coverage.empty")}</p>
			)}
		</SectionCard>
	);
}
