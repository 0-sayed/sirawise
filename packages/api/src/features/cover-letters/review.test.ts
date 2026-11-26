import type { GuardContext } from "../ai/variant-types";
import { expect, it } from "vite-plus/test";
import {
	validateLetterOutput,
	letterVerificationInventory,
	letterProposalHtml,
	assertLetterVerification,
	buildLetterWriterPayload,
	filterLetterVerification,
	letterReviewHandler,
} from "./review-handler";

const context: GuardContext = {
	category: "cover-letter",
	cv: [{ id: "fact", section: "experience", text: "Built accessible interfaces using TypeScript." }],
	jobAd: { segments: [{ id: "job", text: "Requires TypeScript and ten years of management experience." }] },
};
const supported = {
	paragraphs: [
		{
			text: "Built accessible interfaces using TypeScript.",
			claims: [
				{
					id: "claim",
					text: "Built accessible interfaces using TypeScript.",
					evidenceIds: ["fact"],
					kind: "fact",
				},
			],
		},
	],
	notes: [],
};

it("accepts supported paragraphs and produces safe editor HTML", () => {
	expect(validateLetterOutput(context, supported)).toEqual(supported);
	expect(letterProposalHtml(supported)).toBe("<p>Built accessible interfaces using TypeScript.</p>");
});

it("rejects job-only candidate facts", () => {
	const text = "I have ten years of management experience.";
	expect(() =>
		validateLetterOutput(context, {
			...supported,
			paragraphs: [
				{
					text,
					claims: [
						{
							id: "invented",
							text,
							evidenceIds: ["job"],
							kind: "fact",
						},
					],
				},
			],
		}),
	).toThrow();
});

it("sends every paragraph and note for verification even without writer annotations", () => {
	const output = { paragraphs: [{ text: "I have a PhD.", claims: [] }], notes: ["The candidate managed 90 people."] };
	const inventory = letterVerificationInventory(output);
	expect(inventory.map((item) => item.text)).toEqual([output.paragraphs[0]?.text, output.notes[0]]);
});

it("rejects duplicate claim identities and model HTML", () => {
	expect(() =>
		validateLetterOutput(context, { ...supported, paragraphs: [supported.paragraphs[0], supported.paragraphs[0]] }),
	).toThrow();
	expect(() =>
		validateLetterOutput(context, { paragraphs: [{ text: "<script>alert(1)</script>", claims: [] }], notes: [] }),
	).toThrow();
});

it("rejects incomplete whole-text verification and foreign evidence", () => {
	const unannotated = {
		paragraphs: [{ text: "Managed ten people.", claims: [] }],
		notes: ["A note also needs review."],
	};
	expect(() => assertLetterVerification(context, unannotated, { coverage: "complete", items: [] })).toThrow(
		"LETTER_VERIFICATION_INCOMPLETE",
	);
	const verdict = {
		coverage: "complete",
		items: [
			{ id: "paragraph:0", verdict: "supported", evidenceIds: ["job"], reason: "Job requirement" },
			{ id: "note:0", verdict: "no_candidate_assertion", evidenceIds: [], reason: "Procedural" },
		],
	};
	expect(() => assertLetterVerification(context, unannotated, verdict)).toThrow("LETTER_VERIFICATION_EVIDENCE");
	expect(() =>
		assertLetterVerification(context, unannotated, { ...verdict, items: [verdict.items[0], verdict.items[0]] }),
	).toThrow("LETTER_VERIFICATION_INCOMPLETE");
});
it("passes only explicit language and length parameters to the writer", () => {
	const input = { documentLocale: "ar-SA" as const, length: "short" as const, privateEmail: "private@example.com" };
	const payload = buildLetterWriterPayload(context, input);
	expect(JSON.stringify(payload)).not.toContain(input.privateEmail);
	expect(JSON.stringify(payload)).toContain("ar-SA");
});

it("allows cross-language cover-letter claims while still blocking invented numbers or tools", () => {
	const arabicCvContext: GuardContext = {
		category: "cover-letter",
		cv: [
			{
				id: "fact-ar",
				section: "experience",
				text: "قدت المسار الخلفي لمشروع هنا ودينا خلال هاكاثون وأنشأت Auto PR لـ 12 خدمة باستخدام PostgreSQL وDocker.",
			},
		],
		jobAd: { segments: [{ id: "job", text: "Senior Backend Engineer role." }] },
	};
	const crossLangValid = {
		paragraphs: [
			{
				text: "I led the backend track for Hena Wadeena during a hackathon and built Auto PR across 12 services using PostgreSQL and Docker.",
				claims: [
					{
						id: "claim-1",
						text: "I led the backend track for Hena Wadeena during a hackathon and built Auto PR across 12 services using PostgreSQL and Docker.",
						evidenceIds: ["fact-ar"],
						kind: "fact" as const,
					},
				],
			},
		],
		notes: [],
	};
	expect(validateLetterOutput(arabicCvContext, crossLangValid)).toEqual(crossLangValid);

	const crossLangInventedNumber = {
		paragraphs: [
			{
				text: "I built Auto PR across 25 services using PostgreSQL and Docker.",
				claims: [
					{
						id: "claim-1",
						text: "I built Auto PR across 25 services using PostgreSQL and Docker.",
						evidenceIds: ["fact-ar"],
						kind: "fact" as const,
					},
				],
			},
		],
		notes: [],
	};
	expect(() => validateLetterOutput(arabicCvContext, crossLangInventedNumber)).toThrow("AI_UNSUPPORTED_CLAIM");

	const crossLangInventedTool = {
		paragraphs: [
			{
				text: "I built Auto PR using Kubernetes and PostgreSQL.",
				claims: [
					{
						id: "claim-1",
						text: "I built Auto PR using Kubernetes and PostgreSQL.",
						evidenceIds: ["fact-ar"],
						kind: "fact" as const,
					},
				],
			},
		],
		notes: [],
	};
	expect(() => validateLetterOutput(arabicCvContext, crossLangInventedTool)).toThrow("AI_UNSUPPORTED_CLAIM");
});

it("allows English cover-letter opening interest clauses referencing an Arabic job posting while still rejecting fabricated facts", () => {
	const englishCvArabicJobContext: GuardContext = {
		category: "cover-letter",
		cv: [
			{ id: "cv-31", section: "basics", text: "Software Engineer" },
			{ id: "cv-68", section: "experience", text: "Inframodern" },
			{
				id: "cv-72a",
				section: "experience",
				text: "Built Dark Factory, an internal autonomous system that orchestrates multiple Codex sessions through Agent Orchestrator and Archon workflows to implement tasks in parallel, from planning through review and merge.",
			},
			{
				id: "cv-72b",
				section: "experience",
				text: "Added backend production-readiness across reliability and observability. Introduced AI-assisted development workflows and shared practical guidelines to help the team use coding agents more effectively.",
			},
		],
		jobAd: {
			segments: [
				{
					id: "job-1",
					text: "تبحث شركة أفق الرحلة عن استشاري العمليات لقيادة تحسين العمليات وقياس جودة الخدمات.",
				},
			],
		},
	};
	const validOpening = {
		paragraphs: [
			{
				text: "I’m interested in the Operations Consultant role at أفق الرحلة because my software engineering experience includes workflow automation and backend production-readiness.",
				claims: [
					{
						id: "claim-1",
						text: "I’m interested in the Operations Consultant role at أفق الرحلة because my software engineering experience includes workflow automation and backend production-readiness.",
						evidenceIds: ["cv-31", "cv-72a", "cv-72b"],
						kind: "fact" as const,
					},
				],
			},
		],
		notes: [],
	};
	expect(validateLetterOutput(englishCvArabicJobContext, validOpening)).toEqual(validOpening);

	// Same opening with an unverified employer must still fail.
	expect(() =>
		validateLetterOutput(englishCvArabicJobContext, {
			paragraphs: [
				{
					text: "I’m interested in the Operations Consultant role at شركة وهمية because my software engineering experience includes backend production-readiness.",
					claims: [
						{
							id: "claim-1",
							text: "I’m interested in the Operations Consultant role at شركة وهمية because my software engineering experience includes backend production-readiness.",
							evidenceIds: ["cv-31", "cv-72b"],
							kind: "fact" as const,
						},
					],
				},
			],
			notes: [],
		}),
	).toThrow("AI_UNSUPPORTED_CLAIM");

	// Fabricated experience/tool after "because" must still fail.
	expect(() =>
		validateLetterOutput(englishCvArabicJobContext, {
			paragraphs: [
				{
					text: "I’m interested in the Operations Consultant role at أفق الرحلة because I have 10 years of SAP experience.",
					claims: [
						{
							id: "claim-1",
							text: "I’m interested in the Operations Consultant role at أفق الرحلة because I have 10 years of SAP experience.",
							evidenceIds: ["cv-31", "cv-72b"],
							kind: "fact" as const,
						},
					],
				},
			],
			notes: [],
		}),
	).toThrow("AI_UNSUPPORTED_CLAIM");
});

it("requires all paragraphs and notes and delivers the letter intact", () => {
	const output = {
		paragraphs: [...supported.paragraphs, { text: "I led the security team.", claims: [] }],
		notes: ["Review the draft."],
	};
	const verdict = {
		coverage: "complete",
		items: [
			{ id: "paragraph:0", verdict: "supported", evidenceIds: ["fact"], reason: "Confirmed" },
			{ id: "note:0", verdict: "no_candidate_assertion", evidenceIds: [], reason: "Procedural" },
		],
	};
	const payload = {
		selections: [
			{
				id: "letter-verification-task",
				kind: "user_supplied" as const,
				section: "summary" as const,
				text: JSON.stringify({ items: letterVerificationInventory(output) }),
			},
		],
	};
	const schema = letterReviewHandler.verifier?.outputForPayload?.(payload);
	expect(schema?.safeParse(verdict).success).toBe(false);
	expect(() => filterLetterVerification(context, output, verdict)).toThrow("LETTER_VERIFICATION_INCOMPLETE");
	const complete = {
		...verdict,
		items: [...verdict.items, { id: "paragraph:1", verdict: "supported", evidenceIds: ["fact"], reason: "Confirmed" }],
	};
	expect(schema?.safeParse(complete).success).toBe(true);
	expect(filterLetterVerification(context, output, complete)).toEqual({ output });
	const rejected = {
		...complete,
		items: complete.items.map((entry) => (entry.id === "paragraph:1" ? { ...entry, verdict: "unsupported" } : entry)),
	};
	expect(() => filterLetterVerification(context, output, rejected)).toThrow("LETTER_VERIFICATION_REJECTED");
});
