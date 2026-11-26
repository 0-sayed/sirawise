import { beforeEach, describe, expect, it } from "vite-plus/test";
import { i18n } from "@lingui/core";
import { ORPCError } from "@orpc/client";
import { getOrpcErrorMessage, getReadableErrorMessage, getResumeErrorMessage } from "./error-message";
import { getUiLocaleMessages } from "./locale";

beforeEach(async () => i18n.loadAndActivate(await getUiLocaleMessages("ar-SA")));

describe("localized error messages", () => {
	it.each(["database password leaked", new Error("private upstream failure"), { message: "private auth failure" }])(
		"does not expose unknown server prose",
		(error) => {
			expect(getReadableErrorMessage(error, "تعذّر إكمال الطلب")).toBe("تعذّر إكمال الطلب");
		},
	);
	it("maps a known authentication code without showing server prose", () => {
		expect(getReadableErrorMessage({ code: "SESSION_NOT_FRESH", message: "private" }, "fallback")).toBe(
			"سجّل الدخول مجددًا، ثم أعد محاولة هذا الإجراء.",
		);
	});
	it("maps file validation metadata and ignores its raw message", () => {
		const error = new ORPCError("BAD_REQUEST", {
			data: { issues: [{ code: "too_big", origin: "file", maximum: 10485760, message: "private" }] },
		});
		expect(getReadableErrorMessage(error, "fallback")).toBe("يجب أن يكون حجم الملف أقل من 10 ميجابايت.");
		expect(getOrpcErrorMessage(error, { fallback: "fallback" })).toBe("يجب أن يكون حجم الملف أقل من 10 ميجابايت.");
	});
	it("uses the caller fallback for unknown validation issues", () => {
		const error = new ORPCError("BAD_REQUEST", { data: { issues: [{ code: "custom", message: "private" }] } });
		expect(getReadableErrorMessage(error, "fallback")).toBe("fallback");
	});
	it("prefers explicit localized code mappings and never returns an oRPC message", () => {
		const error = new ORPCError("UNKNOWN", { message: "private" });
		expect(getOrpcErrorMessage(error, { fallback: "fallback" })).toBe("fallback");
		expect(getOrpcErrorMessage(error, { fallback: "fallback", byCode: { UNKNOWN: "رسالة آمنة" } })).toBe("رسالة آمنة");
	});
	it.each(["RESUME_SLUG_ALREADY_EXISTS", "RESUME_LOCKED", "UNKNOWN"])("localizes resume errors (%s)", (code) => {
		expect(getResumeErrorMessage(new ORPCError(code))).toMatch(/[\u0600-\u06ff]/);
	});
});

it.each([
	"BASE_CV_LIMIT",
	"LANGUAGE_COPY_LIMIT",
	"JOB_COPY_LIMIT",
	"AI_OPERATIONS_LIMIT",
	"AI_BUDGET_LIMIT",
	"AI_PLATFORM_BUSY",
	"AI_CONCURRENCY_LIMIT",
	"AI_TARGET_BUSY",
])("maps %s for every document creation error caller", (reason) => {
	i18n.loadAndActivate({ locale: "en-US", messages: {} });
	const error = new ORPCError("PRECONDITION_FAILED", { data: { reason }, message: "private upstream failure" });
	const message = getOrpcErrorMessage(error, { fallback: "creation fallback" });
	expect(message).not.toBe("creation fallback");
	expect(message).not.toContain("private upstream failure");
	expect(getResumeErrorMessage(error)).toBe(message);
});

it("preserves the exact server allowance counts for toast consumers", () => {
	i18n.loadAndActivate({ locale: "en-US", messages: {} });
	expect(
		getOrpcErrorMessage(
			new ORPCError("PRECONDITION_FAILED", {
				data: { reason: "BASE_CV_LIMIT", allowance: { limit: 1, used: 1, reserved: 0, remaining: 0 } },
			}),
			{ fallback: "fallback" },
		),
	).toContain("1 of 1 base CVs used.");
});
