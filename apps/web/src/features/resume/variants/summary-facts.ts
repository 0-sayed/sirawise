import type { ResumeData } from "@reactive-resume/schema/resume/data";
import { buildJobPassages } from "@reactive-resume/resume/ats";
import { describeEntry, findEntry, getSectionType } from "../editor/write/model";

export const MAX_SELECTED_FACTS = 49;
const priority = ["basics", "experience", "projects", "skills", "education"];

type SummaryFact = ReturnType<typeof buildJobPassages>[number];
type FactEntry = { id: string; title: string; facts: SummaryFact[] };
type FactSection = { id: string; entries: FactEntry[] };

export function getSummaryFacts(data: ResumeData) {
	return buildJobPassages(data).filter(({ target }) => target.sectionId !== "summary");
}

export function recommendSummaryFacts(facts: SummaryFact[]) {
	const rank = (sectionId: string) => {
		const index = priority.indexOf(sectionId);
		return index === -1 ? priority.length : index;
	};
	return facts
		.toSorted((a, b) => rank(a.target.sectionId) - rank(b.target.sectionId))
		.slice(0, MAX_SELECTED_FACTS)
		.map(({ id }) => id);
}

export function groupSummaryFacts(data: ResumeData, facts: SummaryFact[]): FactSection[] {
	const sections = new Map<string, Map<string, FactEntry>>();
	for (const fact of facts) {
		const { sectionId, itemId } = fact.target;
		let entries = sections.get(sectionId);
		if (!entries) {
			entries = new Map();
			sections.set(sectionId, entries);
		}
		const id = itemId ?? sectionId;
		let group = entries.get(id);
		if (!group) {
			const type = getSectionType(data, sectionId);
			const entry = itemId && findEntry(data, sectionId, itemId);
			let title = "";
			if (type && entry) {
				const description = describeEntry(type, entry);
				const company = type === "experience" && "company" in entry && entry.company.trim();
				title = company && company !== description.title ? `${description.title} · ${company}` : description.title;
			}
			group = { id, title, facts: [] };
			entries.set(id, group);
		}
		group.facts.push(fact);
	}
	return Array.from(sections, ([id, entries]) => ({ id, entries: [...entries.values()] }));
}

export function filterSummaryFacts(
	sections: FactSection[],
	query: string,
	sectionTitle: (id: string) => string,
	fieldTitle: (field: string) => string,
) {
	const search = query.trim().normalize("NFKC").toLowerCase();
	if (!search) return sections;
	const matches = (text: string) => text.normalize("NFKC").toLowerCase().includes(search);
	return sections
		.map((section) => ({
			...section,
			entries: section.entries
				.map((entry) => ({
					...entry,
					facts:
						matches(sectionTitle(section.id)) || matches(entry.title)
							? entry.facts
							: entry.facts.filter(({ text, target }) => matches(text) || matches(fieldTitle(target.field))),
				}))
				.filter(({ facts }) => facts.length > 0),
		}))
		.filter(({ entries }) => entries.length > 0);
}
