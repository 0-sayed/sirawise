import { blockText, passageSpacing } from "@reactive-resume/resume/proposals";
import { computeWordingDiff } from "@reactive-resume/resume/wording-diff";
import { Badge } from "@reactive-resume/ui/components/badge";
import { Disclosure, DisclosureContent, DisclosureSummary } from "@reactive-resume/ui/components/disclosure";
import { cn } from "@reactive-resume/utils/style";
import { useAssistantCopy } from "@/features/assistant/copy.generated";

type WordingDiffProps = {
	before: string;
	after: string;
	mode: "changes" | "final";
	locale?: string;
};

const visibleSpacing = (html: string) =>
	passageSpacing(html)
		.replace(/^\n|\n$/gu, "")
		.replace(/\r\n?|\n/gu, "↵\n")
		.replace(/[^\S\n]/gu, "·");

export function WordingDiff({ before, after, mode, locale }: WordingDiffProps) {
	const copy = useAssistantCopy();
	if (mode === "final")
		return (
			<p dir="auto" className="wrap-anywhere">
				{blockText(after)}
			</p>
		);

	const { kind, segments, beforeText, afterText, direction } = computeWordingDiff(before, after, locale);
	if (kind === "formatting") {
		const originalSpacing = visibleSpacing(before);
		const proposedSpacing = visibleSpacing(after);
		return (
			<>
				<Badge variant="info">{copy("review.diff.formatting")}</Badge>
				<p dir="auto" className="wrap-anywhere">
					{afterText}
				</p>
				{originalSpacing !== proposedSpacing && (
					<Disclosure>
						<DisclosureSummary>{copy("review.diff.showSpacing")}</DisclosureSummary>
						<DisclosureContent>
							<dl className="grid gap-2">
								<dt className="type-label">{copy("review.diff.original")}</dt>
								<dd dir="auto" className="wrap-anywhere whitespace-pre-wrap">
									{originalSpacing}
								</dd>
								<dt className="type-label">{copy("review.diff.proposed")}</dt>
								<dd dir="auto" className="wrap-anywhere whitespace-pre-wrap">
									{proposedSpacing}
								</dd>
							</dl>
						</DisclosureContent>
					</Disclosure>
				)}
			</>
		);
	}

	if (kind === "rewrite")
		return (
			<>
				<Badge>{copy("review.diff.rewrite")}</Badge>
				<dl className="grid gap-2 wrap-anywhere">
					{beforeText && (
						<div className="text-ink-2">
							<dt className="type-label">{copy("review.diff.original")}</dt>
							<dd>
								<p dir="auto">{beforeText}</p>
							</dd>
						</div>
					)}
					<div className="text-ink">
						<dt className="type-label">{copy("review.diff.proposed")}</dt>
						<dd>
							<p dir="auto">{afterText}</p>
						</dd>
					</div>
				</dl>
			</>
		);

	return (
		<>
			{kind === "punctuation" && <Badge>{copy("review.diff.punctuation")}</Badge>}
			{/* Native direction detection skips isolated runs. Use the clean passage to set the direction. */}
			<p dir="auto" className="wrap-anywhere" style={{ direction }}>
				{segments.map(({ type, text }, index) => {
					if (type === "equal") return text;
					const Tag = type === "delete" ? "del" : "ins";
					return (
						<bdi key={index}>
							<Tag className={cn(type === "delete" ? "diff-del" : "diff-ins", kind === "punctuation" && "diff-punct")}>
								{text}
							</Tag>
						</bdi>
					);
				})}
			</p>
		</>
	);
}
