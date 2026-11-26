import type { ResumeData } from "@reactive-resume/schema/resume/data";
import { useEffect, useId, useMemo, useRef, useState } from "react";
import { Accordion, AccordionContent, AccordionItem, AccordionTrigger } from "@reactive-resume/ui/components/accordion";
import { ActionGroup } from "@reactive-resume/ui/components/action-group";
import { Alert, AlertActions, AlertDescription } from "@reactive-resume/ui/components/alert";
import { Badge } from "@reactive-resume/ui/components/badge";
import { Button } from "@reactive-resume/ui/components/button";
import { Checkbox } from "@reactive-resume/ui/components/checkbox";
import { Disclosure, DisclosureContent, DisclosureSummary } from "@reactive-resume/ui/components/disclosure";
import { EmptyState } from "@reactive-resume/ui/components/empty-state";
import { Icon } from "@reactive-resume/ui/components/icon";
import { InputGroup, InputGroupAddon, InputGroupInput } from "@reactive-resume/ui/components/input-group";
import { ScrollArea } from "@reactive-resume/ui/components/scroll-area";
import { SectionCard } from "@reactive-resume/ui/components/section-card";
import { cn } from "@reactive-resume/utils/style";
import { useVariantsCopy } from "./copy.generated";
import { useReviewSectionTitle } from "./review-interface-copy";
import { filterSummaryFacts, type getSummaryFacts, groupSummaryFacts, MAX_SELECTED_FACTS } from "./summary-facts";

type Fact = ReturnType<typeof getSummaryFacts>[number];
type FactField =
	| "headline"
	| "title"
	| "name"
	| "company"
	| "organization"
	| "awarder"
	| "issuer"
	| "publisher"
	| "school"
	| "degree"
	| "area"
	| "position"
	| "description"
	| "language"
	| "fluency"
	| "proficiency"
	| "keywords";

export function SummaryFactPicker({
	data,
	facts,
	selected,
	recommended,
	locked,
	onSelect,
}: {
	data: ResumeData;
	facts: Fact[];
	selected: string[];
	recommended: string[];
	locked: boolean;
	onSelect: (update: (previous: string[]) => string[]) => void;
}) {
	const copy = useVariantsCopy();
	const getSectionTitle = useReviewSectionTitle();
	const [query, setQuery] = useState("");
	const [closedSections, setClosedSections] = useState<string[]>([]);
	const groups = useMemo(() => groupSummaryFacts(data, facts), [data, facts]);
	const selectedIds = new Set(selected);
	const sectionTitle = (id: string) => getSectionTitle(id, data);
	const fieldTitle = (field: string) => copy(`review.summary.field.${field as FactField}`);
	const sections = filterSummaryFacts(groups, facts.length > 10 ? query : "", sectionTitle, fieldTitle);
	const atLimit = selected.length === MAX_SELECTED_FACTS;
	const total = facts.length;
	const count = selected.length;
	const hasRecommended = recommended.length === count && recommended.every((id) => selectedIds.has(id));
	const description =
		count === total
			? copy("review.summary.allFacts", { count })
			: hasRecommended
				? copy("review.summary.topFacts", { total })
				: copy("review.summary.selectedFacts", { count, total });
	const selectRecommended = () => onSelect(() => recommended);
	const toggleFacts = (ids: string[], checked: boolean) =>
		onSelect((previous) => {
			const next = new Set(previous);
			for (const id of ids) {
				if (!checked) next.delete(id);
				else if (next.size < MAX_SELECTED_FACTS) next.add(id);
			}
			return [...next];
		});

	if (!total) return <EmptyState density="compact" description={copy("review.summary.noFacts")} />;

	return (
		<>
			<SectionCard variant="flush">
				<Disclosure>
					<DisclosureSummary description={description}>
						{copy("review.summary.facts")}
						<Badge variant={atLimit ? "warn" : "accent"}>
							<bdi dir="ltr" className="tabular-nums">
								{count}/{MAX_SELECTED_FACTS}
							</bdi>
						</Badge>
					</DisclosureSummary>
					<DisclosureContent className="text-content-start">
						{total > 10 && (
							<InputGroup>
								<InputGroupAddon>
									<Icon name="magnifying-glass" aria-hidden />
								</InputGroupAddon>
								<InputGroupInput
									aria-label={copy("review.summary.filterFacts")}
									placeholder={copy("review.summary.filterFacts")}
									type="search"
									value={query}
									onChange={(event) => {
										setQuery(event.target.value);
										if (event.target.value.trim()) setClosedSections([]);
									}}
								/>
							</InputGroup>
						)}
						<ActionGroup density="compact">
							<Button
								type="button"
								variant="quiet"
								size="sm"
								disabled={locked || hasRecommended}
								onClick={selectRecommended}
							>
								{copy("review.summary.selectRecommended")}
							</Button>
							<Button
								type="button"
								variant="quiet"
								size="sm"
								disabled={locked || !count}
								onClick={() => onSelect(() => [])}
							>
								{copy("review.summary.clear")}
							</Button>
						</ActionGroup>
						{total > MAX_SELECTED_FACTS && (
							<Alert variant="info">
								<Icon name="info" aria-hidden />
								<AlertDescription>{copy("review.summary.factLimit")}</AlertDescription>
							</Alert>
						)}
						{sections.length ? (
							<ScrollArea className="max-h-80">
								<Accordion
									multiple
									value={sections.map(({ id }) => id).filter((id) => !closedSections.includes(id))}
									onValueChange={(open) =>
										setClosedSections((closed) => [
											...closed.filter((id) => !sections.some((section) => section.id === id)),
											...sections.map(({ id }) => id).filter((id) => !open.includes(id)),
										])
									}
								>
									{sections.map(({ id, entries }) => (
										<AccordionItem key={id} value={id}>
											<AccordionTrigger>
												<bdi dir="auto">{sectionTitle(id)}</bdi>
											</AccordionTrigger>
											<AccordionContent className="grid gap-2">
												{entries.map((entry) => {
													const entryIds = entry.facts.map(({ id }) => id);
													const entryCount = entryIds.filter((id) => selectedIds.has(id)).length;
													const complete = entryCount === entryIds.length;
													const title =
														entry.title || (id === "basics" ? sectionTitle(id) : copy("review.summary.untitledEntry"));
													return (
														<div
															key={entry.id}
															role="group"
															aria-label={title}
															className="grid gap-1 border-t border-line"
														>
															<label className="flex min-h-11 items-start gap-2 py-1.5">
																<Checkbox
																	aria-label={copy("review.summary.selectEntry", { entry: title })}
																	checked={complete}
																	indeterminate={entryCount > 0 && !complete}
																	disabled={locked || (atLimit && entryCount === 0)}
																	onCheckedChange={() => toggleFacts(entryIds, !complete && !atLimit)}
																/>
																<bdi dir="auto" className="min-w-0 flex-1 type-body wrap-anywhere">
																	{title}
																</bdi>
																<Badge variant="neutral">
																	<bdi dir="ltr" className="tabular-nums">
																		{entryCount}/{entryIds.length}
																	</bdi>
																</Badge>
															</label>
															<div className="grid ps-3">
																{entry.facts.map((fact) => (
																	<FactRow
																		key={fact.id}
																		fact={fact}
																		fieldTitle={fieldTitle(fact.target.field)}
																		checked={selectedIds.has(fact.id)}
																		disabled={locked || (atLimit && !selectedIds.has(fact.id))}
																		onChange={(checked) => toggleFacts([fact.id], checked)}
																	/>
																))}
															</div>
														</div>
													);
												})}
											</AccordionContent>
										</AccordionItem>
									))}
								</Accordion>
							</ScrollArea>
						) : (
							<EmptyState density="compact" description={copy("review.summary.noMatches")} />
						)}
					</DisclosureContent>
				</Disclosure>
			</SectionCard>
			{atLimit && (
				<p role="status" className="type-metadata text-warn-text">
					{copy("review.summary.limitReached")}
				</p>
			)}
			{!count && (
				<Alert variant="warn">
					<Icon name="warning-circle" aria-hidden />
					<AlertDescription>{copy("review.summary.factsRequired")}</AlertDescription>
					<AlertActions>
						<Button type="button" variant="secondary" size="sm" disabled={locked} onClick={selectRecommended}>
							{copy("review.summary.selectRecommended")}
						</Button>
					</AlertActions>
				</Alert>
			)}
		</>
	);
}

function FactRow({
	fact,
	fieldTitle,
	checked,
	disabled,
	onChange,
}: {
	fact: Fact;
	fieldTitle: string;
	checked: boolean;
	disabled: boolean;
	onChange: (checked: boolean) => void;
}) {
	const copy = useVariantsCopy();
	const textId = useId();
	const textRef = useRef<HTMLSpanElement>(null);
	const [expanded, setExpanded] = useState(false);
	const [overflows, setOverflows] = useState(false);
	const description = fact.target.field === "description";
	useEffect(() => {
		const text = textRef.current;
		if (!description || !text || expanded) return;
		const measure = () => setOverflows(text.scrollHeight > text.clientHeight + 1);
		measure();
		const observer = new ResizeObserver(measure);
		observer.observe(text);
		return () => observer.disconnect();
	}, [description, expanded, fact.text]);
	return (
		<div>
			<label className="flex min-h-11 items-start gap-2 py-1.5">
				<Checkbox aria-labelledby={textId} checked={checked} disabled={disabled} onCheckedChange={onChange} />
				<span
					id={textId}
					ref={textRef}
					dir="auto"
					className={cn("min-w-0 flex-1 type-body wrap-anywhere text-ink", description && !expanded && "line-clamp-2")}
				>
					{fact.text}
				</span>
				<Badge variant="outline" shape="tag">
					{fieldTitle}
				</Badge>
			</label>
			{description && (overflows || expanded) && (
				<Button
					type="button"
					variant="link"
					size="link-compact"
					aria-controls={textId}
					aria-expanded={expanded}
					onClick={() => setExpanded(!expanded)}
				>
					{copy(expanded ? "review.summary.less" : "review.summary.more")}
				</Button>
			)}
		</div>
	);
}
