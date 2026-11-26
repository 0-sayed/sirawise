import type { ResumeData } from "@reactive-resume/schema/resume/data";
import type { TailoringOutput } from "@reactive-resume/schema/resume/variant-outputs";
import { SectionCardTitle } from "@reactive-resume/ui/components/section-card";
import { describeEntry, getEntries, getSectionObject, resolveSection } from "../editor/write/model";
import { useVariantsCopy } from "./copy.generated";

type Order = TailoringOutput["order"];
type OrderItem = { id: string; title: string };
type SectionOrder = {
	sectionId: string;
	title: string;
	current: OrderItem[];
	proposed: OrderItem[];
	moved: string;
	above: string;
};

export function resolveTailoringOrder(data: ResumeData, orders: Order, beforeOrder?: Order): SectionOrder[] {
	const sections: SectionOrder[] = [];
	for (const { sectionId, itemIds } of orders) {
		const section = resolveSection(data, sectionId);
		if (!section) return [];

		const entries = getEntries(data, section);
		const byId = new Map(entries.map((entry) => [entry.id, entry]));
		const currentIds = beforeOrder?.find((order) => order.sectionId === sectionId)?.itemIds ?? [...byId.keys()];
		if (currentIds.length !== entries.length || itemIds.length !== entries.length) return [];
		if (new Set(itemIds).size !== itemIds.length) return [];

		const readItem = (id: string) => {
			const entry = byId.get(id);
			if (!entry) return null;
			const fields =
				section.type === "experience" && "company" in entry
					? [entry.position, entry.company]
					: section.type === "education" && "school" in entry
						? [entry.degree, entry.school]
						: [describeEntry(section.type, entry).title];
			const title = fields
				.map((field) => field.trim())
				.filter(Boolean)
				.join(" · ");
			return title && title !== id ? { id, title } : null;
		};
		const current = currentIds.map(readItem);
		const proposed = itemIds.map(readItem);
		// The server applies all reordered sections in a single decision.
		if (!current.every((item) => item !== null) || !proposed.every((item) => item !== null)) return [];

		const firstChange = proposed.findIndex((item, index) => item.id !== current[index]?.id);
		const moved = proposed[firstChange];
		const above = current[firstChange];
		if (moved && above)
			sections.push({
				sectionId,
				title: getSectionObject(data, section)?.title.trim() ?? "",
				current,
				proposed,
				moved: moved.title,
				above: above.title,
			});
	}
	return sections;
}

export function TailoringOrder({
	sections,
	sectionTitle,
}: {
	sections: SectionOrder[];
	sectionTitle: (sectionId: string) => string;
}) {
	const copy = useVariantsCopy();
	const isolate = (title: string) => `\u2068${title}\u2069`;
	return sections.map(({ sectionId, title, current, proposed, moved, above }) => (
		<div key={sectionId} className="grid min-w-0 gap-2">
			<SectionCardTitle>
				<bdi dir="auto">{title || sectionTitle(sectionId)}</bdi>
			</SectionCardTitle>
			<div className="grid min-w-0 gap-3 sm:grid-cols-2">
				{[
					{ label: copy("review.tailoring.order.current"), items: current },
					{ label: copy("review.tailoring.order.proposed"), items: proposed },
				].map(({ label, items }) => (
					<div key={label} className="grid min-w-0 content-start gap-1">
						<p className="type-label">{label}</p>
						<ol aria-label={label} className="list-decimal ps-5 type-body wrap-anywhere">
							{items.map((item) => (
								<li key={item.id}>
									<bdi dir="auto">{item.title}</bdi>
								</li>
							))}
						</ol>
					</div>
				))}
			</div>
			<p className="type-body wrap-anywhere text-ink-2">
				{copy("review.tailoring.order.move", { moved: isolate(moved), above: isolate(above) })}
			</p>
		</div>
	));
}
