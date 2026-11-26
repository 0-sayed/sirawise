import type { AttemptFailure } from "./adapter";
import { ZodError } from "zod";

export type VerificationFailureDetail = { rule: string };
export type TransportFailureDetail = {
	errorClass: string;
	message: string;
	code?: string;
	causeCode?: string;
	httpStatus: number | null;
	bytesReceived: boolean;
	requestSent: boolean;
	abortCause?: NonNullable<AttemptFailure["abortCause"]>;
	timedOut?: boolean;
	providerErrorCode?: string;
	causes?: { errorClass: string; message: string; code?: string }[];
};
export type OperationFailureDetail = VerificationFailureDetail | TransportFailureDetail | ProviderAccountFailureDetail;
export type VerificationGateRule =
	| "AI_VERIFICATION_SCHEMA"
	| "AI_VERIFICATION_CLAIM_IDS"
	| "AI_VERIFICATION_PREMISE_IDS"
	| "AI_VERIFICATION_ABSENCE_IDS"
	| "AI_VERIFICATION_COVERAGE"
	| "AI_VERIFICATION_CLAIM_SUPPORT"
	| "AI_VERIFICATION_RETENTION"
	| "AI_VERIFICATION_ABSENCE"
	| "AI_VERIFICATION_PREMISE";

/** Preserve the public failure contract while retaining the precise internal gate. */
export class VerificationGateError extends Error {
	constructor(
		readonly rule: VerificationGateRule,
		code = "AI_VERIFICATION_FAILED",
	) {
		super(code);
	}
}

const diagnosticRules = new Set([
	"JOB_DUPLICATE_REQUIREMENT",
	"JOB_NOT_SUPPLIED",
	"JOB_INVALID_SPAN",
	"JOB_UNSUPPORTED_IMPORTANCE",
	"JOB_PARTIAL_EVIDENCE_ABSENCE",
	"JOB_UNBOUNDED_ABSENCE",
	"JOB_INVALID_ASSESSMENT",
	"SUMMARY_EMPTY_RESPONSE",
	"SUMMARY_UNCOVERED_TEXT",
	"SUMMARY_MISSING_QUESTION",
	"TAILORING_SOURCE_CHANGED",
	"TAILORING_DUPLICATE_TARGET",
	"TAILORING_INVALID_TARGET",
	"TAILORING_UNCOVERED_TEXT",
	"TAILORING_INVALID_ORDER",
	"AI_INPUT_LIMIT",
	"AI_DUPLICATE_EVIDENCE",
	"AI_DUPLICATE_SUBJECT",
	"AI_MISSING_EVIDENCE",
	"LETTER_VERIFICATION_REJECTED",
	"LETTER_VERIFICATION_EVIDENCE",
	"LETTER_VERIFICATION_INCOMPLETE",
	"LETTER_VERIFICATION_UNKNOWN_ITEM",
	"LETTER_DUPLICATE_CLAIM_ID",
	"LETTER_NOT_PLAIN_PARAGRAPHS",
	"LETTER_UNSUPPORTED_CLAIM",
	"AI_STALE_SOURCE",
	"AI_SOURCE_CHANGED",
	"AI_WRONG_LANGUAGE",
	"AI_EVIDENCE_COLLISION",
	"AI_GUARD_FAILED",
	"AI_INVALID_EVIDENCE",
	"AI_INVALID_GUARD_POLICY",
	"AI_LOST_FACT",
	"AI_UNSUPPORTED_CLAIM",
	"AI_VERIFICATION_CITATION",
	"AI_VERIFICATION_DUPLICATE_ID",
	"AI_VERIFICATION_FAILED",
	"AI_VERIFICATION_INCOMPLETE",
	"AI_VERIFICATION_INPUT_LIMIT",
	"AI_VERIFICATION_RETENTION_SCOPE",
	"AI_VERIFICATION_REQUIRED",
	"AI_FACT_RETENTION_FAILED",
	"AI_UNSUPPORTED_DATE",
	"AI_AMBIGUOUS_DATE",
	"AI_SOURCE_BINDING",
	"AI_CONTRADICTION",
	"AI_UNVERIFIED_NEGATION",
	"AI_INVALID_MARKUP",
	"TRANSLATION_INVALID_EVIDENCE",
	"TRANSLATION_SEGMENT_IDS",
	"TRANSLATION_SOURCE_CHANGED",
	"TRANSLATION_UNCOVERED_TEXT",
]);

/** Store bounded rule codes only, never model prose, CV text, or SDK exception details. */
export function verificationFailureDetail(error: unknown): VerificationFailureDetail {
	if (error instanceof VerificationGateError) return { rule: error.rule };
	if (error instanceof ZodError) return { rule: "AI_VERIFICATION_SCHEMA" };
	return {
		rule: error instanceof Error && diagnosticRules.has(error.message) ? error.message : "AI_VERIFICATION_UNKNOWN",
	};
}

export type ProviderAccountFailureDetail = {
	httpStatus: number | null;
	statusMeaning: "401 key" | "402 credits" | "403 limit" | "account error";
	providerErrorCode?: string;
};

export function providerAccountFailureDetail(failure?: {
	httpStatus?: number | null;
	providerErrorCode?: string | null;
}): ProviderAccountFailureDetail {
	const httpStatus = typeof failure?.httpStatus === "number" ? failure.httpStatus : null;
	const statusMeaning =
		httpStatus === 401
			? "401 key"
			: httpStatus === 402
				? "402 credits"
				: httpStatus === 403
					? "403 limit"
					: "account error";
	const rawCode = typeof failure?.providerErrorCode === "string" ? failure.providerErrorCode.trim().slice(0, 80) : "";
	return {
		httpStatus,
		statusMeaning,
		...(rawCode ? { providerErrorCode: rawCode } : {}),
	};
}
