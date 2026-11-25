import type { VariantTerminology } from "@reactive-resume/schema/resume/variants";
import { expect, it } from "vite-plus/test";
import { buildTranslationInventory } from "@reactive-resume/resume/translation";
import { customSectionSchema, educationItemSchema, experienceItemSchema } from "@reactive-resume/schema/resume/data";
import { defaultResumeData } from "@reactive-resume/schema/resume/default";
import {
	chunkSubjectIds,
	groupTranslationSegments,
	groupTranslationTerms,
	groupTranslationUndoActions,
	MAX_DECISION_SUBJECTS,
	submitChunkedVariantDecision,
	submitSequentialUndo,
} from "./translation-review-model";

function makeTerm(
	id: string,
	source: string,
	value: string,
	status: "pending" | "confirmed",
): VariantTerminology["terms"][number] {
	return {
		id,
		sourceRevision: "rev-1",
		target: { sectionId: "experience", itemId: "exp-1", field: "company" },
		source,
		value,
		status,
		author: status === "confirmed" ? "user" : "source",
	};
}

it("deduplicates identical source terms, counts occurrences, and separates pending from confirmed", () => {
	const grouped = groupTranslationTerms([
		makeTerm("term:1", "مجلس الواحة", "مجلس الواحة", "confirmed"),
		makeTerm("term:2", "مجلس الواحة", "مجلس الواحة", "confirmed"),
		makeTerm("term:3", "جامعة الملك سعود", "King Saud University", "pending"),
		makeTerm("term:4", "مجلس الواحة", "مجلس الواحة", "confirmed"),
		makeTerm("term:5", "جامعة الملك سعود", "King Saud University", "confirmed"),
		makeTerm("term:6", "معهد المعرفة", "معهد المعرفة", "pending"),
	]);

	expect(grouped.pending).toHaveLength(2);
	expect(grouped.confirmed).toHaveLength(1);
	expect(grouped.pending.map((group) => group.source)).toEqual(["جامعة الملك سعود", "معهد المعرفة"]);
	expect(grouped.pending[0]?.ids).toEqual(["term:3", "term:5"]);
	expect(grouped.pending[0]?.pendingIds).toEqual(["term:3"]);
	expect(grouped.pending[0]?.count).toBe(2);
	expect(grouped.confirmed[0]?.source).toBe("مجلس الواحة");
	expect(grouped.confirmed[0]?.ids).toEqual(["term:1", "term:2", "term:4"]);
	expect(grouped.confirmed[0]?.count).toBe(3);
	expect(grouped.pendingTermIds).toEqual(["term:3", "term:6"]);
});

it("groups translation segments by CV section and scopes pending IDs to pending verified segments only", () => {
	const data = structuredClone(defaultResumeData);
	data.basics.headline = "مدير عمليات";
	data.summary.hidden = false;
	data.summary.title = "نبذة";
	data.summary.content = "<p>ملخص مهني</p>";
	data.sections.experience.hidden = false;
	data.sections.experience.items = [
		experienceItemSchema.parse({
			id: "exp-1",
			hidden: false,
			company: "مجلس الواحة",
			position: "مدير",
			location: "",
			period: "2020-2025",
			website: { url: "", label: "" },
			description: "<p>قيادة فريق العمليات</p>",
		}),
	];
	data.sections.education.hidden = false;
	data.sections.education.items = [
		educationItemSchema.parse({
			id: "edu-1",
			hidden: false,
			school: "جامعة الرياض",
			degree: "بكالوريوس",
			area: "إدارة",
			grade: "",
			location: "",
			period: "2010",
			website: { url: "", label: "" },
			description: "",
		}),
	];
	data.customSections = [
		customSectionSchema.parse({
			id: "custom-courses",
			type: "certifications",
			title: "الدورات التدريبية",
			hidden: false,
			items: [
				{
					id: "c-1",
					hidden: false,
					title: "إدارة المشاريع",
					issuer: "المعهد",
					date: "2022",
					website: { url: "", label: "" },
					description: "",
				},
			],
		}),
	];
	data.metadata.layout.pages = [
		{ fullWidth: false, main: ["summary", "experience", "education", "custom-courses"], sidebar: [] },
	];

	const inventory = buildTranslationInventory(data);
	const resultSegments = inventory.segments.map((segment) => ({
		sourceId: segment.id,
		text: `EN: ${segment.text}`,
	}));
	const sourceSegments = inventory.segments.map((segment) => ({ id: segment.id, text: segment.text }));
	const firstId = inventory.segments[0]?.id ?? "";
	const secondId = inventory.segments[1]?.id ?? "";
	const segments = Object.fromEntries(
		resultSegments.map((segment) => [
			segment.sourceId,
			{
				text: segment.text,
				status:
					segment.sourceId === firstId
						? ("accepted" as const)
						: segment.sourceId === secondId
							? ("rejected" as const)
							: ("pending" as const),
			},
		]),
	);
	const statuses = Object.fromEntries(Object.entries(segments).map(([id, value]) => [id, value.status]));

	const grouped = groupTranslationSegments({
		resultSegments,
		sourceSegments,
		segments,
		statuses,
		sourceData: data,
		terms: [],
	});

	expect(grouped.groups.map((group) => group.key)).toEqual([
		"basics",
		"summary",
		"experience",
		"education",
		"custom:custom-courses",
	]);
	expect(grouped.groups.at(-1)?.customTitle).toBe("الدورات التدريبية");
	expect(grouped.acceptedCount).toBe(1);
	expect(grouped.totalCount).toBe(resultSegments.length);
	expect(grouped.pendingSegmentIds).not.toContain(firstId);
	expect(grouped.pendingSegmentIds).not.toContain(secondId);
	expect(grouped.pendingSegmentIds).toHaveLength(resultSegments.length - 2);
});

it("chunks large subject lists into server-safe batches of at most MAX_DECISION_SUBJECTS", () => {
	const ids = Array.from({ length: 447 }, (_, index) => `seg-${index}`);
	const chunks = chunkSubjectIds(ids);
	expect(chunks.map((chunk) => chunk.length)).toEqual([100, 100, 100, 100, 47]);
	expect(chunks.every((chunk) => chunk.length <= MAX_DECISION_SUBJECTS)).toBe(true);
	expect(chunks.flat()).toEqual(ids);
});

it("excludes unverified segments missing from reviewed segments map from pendingSegmentIds", () => {
	const grouped = groupTranslationSegments({
		resultSegments: [
			{ sourceId: "seg-verified", text: "Verified" },
			{ sourceId: "seg-unverified", text: "Unverified" },
		],
		sourceSegments: [
			{ id: "seg-verified", text: "أ" },
			{ id: "seg-unverified", text: "ب" },
		],
		segments: {
			"seg-verified": { text: "Verified", status: "pending" },
		},
		statuses: {
			"seg-verified": "pending",
			"seg-unverified": "pending",
		},
		terms: [],
	});

	expect(grouped.pendingSegmentIds).toEqual(["seg-verified"]);
	expect(grouped.totalCount).toBe(2);
	expect(grouped.acceptedCount).toBe(0);
});

it("chains sequential server-safe decision batches for >100 segments and multi-occurrence term edits", async () => {
	const calls: Array<{
		subjectIds: string[];
		decision: string;
		expectedDecisionId: string | null;
		expectedUpdatedAt: string;
		editedText?: string;
	}> = [];
	let step = 0;
	const submit = async (payload: {
		subjectIds: string[];
		decision: string;
		expectedDecisionId: string | null;
		expectedUpdatedAt: string;
		editedText?: string | undefined;
	}) => {
		step += 1;
		calls.push({
			subjectIds: payload.subjectIds,
			decision: payload.decision,
			expectedDecisionId: payload.expectedDecisionId,
			expectedUpdatedAt: payload.expectedUpdatedAt,
			...(payload.editedText !== undefined ? { editedText: payload.editedText } : {}),
		});
		return { decisionId: `dec-${step}`, updatedAt: `2026-11-21T00:00:0${step}.000Z` };
	};

	const allIds = Array.from({ length: 205 }, (_, index) => `seg-${index}`);
	await submitChunkedVariantDecision({
		operationId: "op-1",
		expectedUpdatedAt: "2026-11-21T00:00:00.000Z",
		expectedDecisionId: null,
		input: { subjectIds: allIds, decision: "accept" },
		submit,
		createRequestKey: () => `req-${step + 1}`,
	});

	expect(calls.map((call) => call.subjectIds.length)).toEqual([100, 100, 5]);
	expect(calls.map((call) => call.expectedDecisionId)).toEqual([null, "dec-1", "dec-2"]);
	expect(calls.map((call) => call.expectedUpdatedAt)).toEqual([
		"2026-11-21T00:00:00.000Z",
		"2026-11-21T00:00:01.000Z",
		"2026-11-21T00:00:02.000Z",
	]);

	calls.length = 0;
	step = 0;
	await submitChunkedVariantDecision({
		operationId: "op-1",
		expectedUpdatedAt: "2026-11-21T00:00:00.000Z",
		expectedDecisionId: "dec-0",
		input: { subjectIds: ["term:1", "term:2", "term:3"], decision: "accept_edited", editedText: "Oasis Council" },
		submit,
		createRequestKey: () => `req-edit-${step + 1}`,
	});

	expect(calls).toEqual([
		{
			subjectIds: ["term:1"],
			decision: "accept_edited",
			expectedDecisionId: "dec-0",
			expectedUpdatedAt: "2026-11-21T00:00:00.000Z",
			editedText: "Oasis Council",
		},
		{
			subjectIds: ["term:2"],
			decision: "accept_edited",
			expectedDecisionId: "dec-1",
			expectedUpdatedAt: "2026-11-21T00:00:01.000Z",
			editedText: "Oasis Council",
		},
		{
			subjectIds: ["term:3"],
			decision: "accept_edited",
			expectedDecisionId: "dec-2",
			expectedUpdatedAt: "2026-11-21T00:00:02.000Z",
			editedText: "Oasis Council",
		},
	]);
});

it("groups chunked undoable decisions into section, accept-all, and single-segment actions", () => {
	const expIds = Array.from({ length: 121 }, (_, index) => `exp-${index}`);
	const eduIds = ["edu-1", "edu-2"];
	const sumIds = ["sum-1", "sum-2"];
	const allIds = [...sumIds, ...expIds, ...eduIds];
	const groupedSegments = {
		groups: [
			{
				key: "summary",
				sectionId: "summary" as const,
				items: sumIds.map((id) => ({ id, before: id, after: id, status: "accepted" as const })),
				pendingIds: [],
				unresolvedIds: [],
				acceptedCount: sumIds.length,
				totalCount: sumIds.length,
			},
			{
				key: "experience",
				sectionId: "experience" as const,
				items: expIds.map((id) => ({ id, before: id, after: id, status: "accepted" as const })),
				pendingIds: [],
				unresolvedIds: [],
				acceptedCount: expIds.length,
				totalCount: expIds.length,
			},
			{
				key: "education",
				sectionId: "education" as const,
				items: eduIds.map((id) => ({ id, before: id, after: id, status: "accepted" as const })),
				pendingIds: [],
				unresolvedIds: [],
				acceptedCount: eduIds.length,
				totalCount: eduIds.length,
			},
		],
		pendingSegmentIds: [],
		unresolvedSegmentIds: [],
		acceptedCount: allIds.length,
		totalCount: allIds.length,
	};

	const actions = groupTranslationUndoActions(
		[
			{ decisionId: "dec-sum-1", subjectIds: ["sum-1"] },
			{ decisionId: "dec-exp-1", subjectIds: expIds.slice(0, 100) },
			{ decisionId: "dec-exp-2", subjectIds: expIds.slice(100) },
		],
		groupedSegments,
	);

	expect(actions).toHaveLength(2);
	expect(actions[0]).toMatchObject({ kind: "segment", segmentId: "sum-1", sectionKey: "summary", count: 1 });
	expect(actions[1]).toMatchObject({ kind: "section", sectionKey: "experience", count: 121 });
	expect(actions[1]?.entries.map((entry) => entry.decisionId)).toEqual(["dec-exp-1", "dec-exp-2"]);

	const acceptAllActions = groupTranslationUndoActions(
		[
			{ decisionId: "dec-all-1", subjectIds: allIds.slice(0, 100) },
			{ decisionId: "dec-all-2", subjectIds: allIds.slice(100) },
		],
		groupedSegments,
	);
	expect(acceptAllActions).toHaveLength(1);
	expect(acceptAllActions[0]).toMatchObject({ kind: "all", count: allIds.length });
	expect(acceptAllActions[0]?.entries.map((entry) => entry.decisionId)).toEqual(["dec-all-1", "dec-all-2"]);
});

it("undoes multi-chunk decisions in reverse chronological order chaining revisions", async () => {
	const calls: Array<{
		undoDecisionId?: string | undefined;
		subjectIds: string[];
		expectedDecisionId: string | null;
		expectedUpdatedAt: string;
	}> = [];
	let step = 0;
	await submitSequentialUndo({
		operationId: "op-1",
		expectedUpdatedAt: "2026-11-21T00:00:02.000Z",
		expectedDecisionId: "dec-2",
		entries: [
			{ decisionId: "dec-1", subjectIds: ["seg-1", "seg-2"] },
			{ decisionId: "dec-2", subjectIds: ["seg-3"] },
		],
		createRequestKey: () => `undo-req-${step + 1}`,
		submit: async (payload) => {
			step += 1;
			calls.push({
				undoDecisionId: payload.undoDecisionId,
				subjectIds: payload.subjectIds,
				expectedDecisionId: payload.expectedDecisionId,
				expectedUpdatedAt: payload.expectedUpdatedAt,
			});
			return { decisionId: `undo-${step}`, updatedAt: `2026-11-21T00:00:1${step}.000Z` };
		},
	});

	expect(calls).toEqual([
		{
			undoDecisionId: "dec-2",
			subjectIds: ["seg-3"],
			expectedDecisionId: "dec-2",
			expectedUpdatedAt: "2026-11-21T00:00:02.000Z",
		},
		{
			undoDecisionId: "dec-1",
			subjectIds: ["seg-1", "seg-2"],
			expectedDecisionId: "undo-1",
			expectedUpdatedAt: "2026-11-21T00:00:11.000Z",
		},
	]);
});
