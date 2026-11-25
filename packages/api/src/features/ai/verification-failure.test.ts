import { expect, it } from "vite-plus/test";
import { verificationFailureDetail } from "./verification-failure";

it.each([
	"JOB_INVALID_SPAN",
	"JOB_UNSUPPORTED_IMPORTANCE",
	"JOB_PARTIAL_EVIDENCE_ABSENCE",
	"JOB_UNBOUNDED_ABSENCE",
	"JOB_INVALID_ASSESSMENT",
	"SUMMARY_EMPTY_RESPONSE",
	"TAILORING_INVALID_TARGET",
	"LETTER_VERIFICATION_EVIDENCE",
	"LETTER_VERIFICATION_INCOMPLETE",
	"LETTER_VERIFICATION_UNKNOWN_ITEM",
	"LETTER_DUPLICATE_CLAIM_ID",
	"LETTER_NOT_PLAIN_PARAGRAPHS",
])("keeps only the bounded private failure rule %s", (rule) => {
	expect(verificationFailureDetail(new Error(rule))).toEqual({ rule });
});
it("does not retain arbitrary exception details even with a known-code prefix", () => {
	expect(verificationFailureDetail(new Error("JOB_INVALID_SPAN: private candidate details"))).toEqual({
		rule: "AI_VERIFICATION_UNKNOWN",
	});
});
