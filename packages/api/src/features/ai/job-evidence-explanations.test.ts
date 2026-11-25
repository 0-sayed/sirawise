import { expect, it } from "vite-plus/test";
import { validateVariantOutput } from "./variant-validation";

const snapshot = {
	category: "job-evidence" as const,
	resumeId: "cv",
	sourceRevision: "r1",
	cv: [{ id: "career", section: "experience", text: "React web development. Used SQL for reporting." }],
	jobAd: {
		segments: [{ id: "job", text: "Required: 10 or more years of web development, native iOS, Swift or Kotlin." }],
	},
};
const response = (explanation: string) => ({
	requirements: Array.from({ length: 20 }, (_, index) => ({
		id: `r${index}`,
		spanIds: ["job"],
		importance: "essential",
		verdict: "partial",
		explanation,
		evidenceIds: ["career"],
	})),
	notes: [],
});

it.each([
	"The CV documents React web development but does not establish 10 or more years.",
	"The CV documents React web development. No native iOS, Swift or Kotlin.",
	"The job requires native iOS, Swift or Kotlin. The CV documents React web development.",
	"The CV documents React web development, with no evidence of native iOS, Swift or Kotlin.",
])("keeps job references separate from CV assertions: %s", (explanation) => {
	expect(() => validateVariantOutput(snapshot, response(explanation))).not.toThrow();
});

it.each([
	"The CV documents Swift and Kotlin expertise.",
	"The CV documents React web development but does not establish 10 years. The candidate used Swift.",
	"No native iOS evidence. The candidate increased revenue 30% using SQL.",
	"The job requires SAP. The CV documents React web development.",
])("still rejects fabricated candidate facts or job references: %s", (explanation) => {
	expect(() => validateVariantOutput(snapshot, response(explanation))).toThrow();
});
