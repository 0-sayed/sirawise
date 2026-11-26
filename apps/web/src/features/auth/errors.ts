import { t } from "@lingui/core/macro";
import { z } from "zod";

/** Codes are stable API contracts; server exception text is never product copy. */
export function authErrorMessage(
	code: string | undefined,
	fallback = t`We could not complete this request. Please try again.`,
): string {
	switch (code) {
		case "INVALID_EMAIL":
			return t({ context: "auth.validation.email", message: "Enter a valid email address, such as name@example.com." });
		case "INVALID_USERNAME":
		case "USERNAME_IS_INVALID":
		case "USERNAME_TOO_SHORT":
		case "USERNAME_TOO_LONG":
			return t({
				context: "auth.validation.username",
				message: "Use 3 to 64 lowercase letters, digits, dots, underscores or hyphens for your username.",
			});
		case "PASSWORD_TOO_SHORT":
		case "PASSWORD_TOO_LONG":
		case "PASSWORD_TOO_WEAK":
		case "WEAK_PASSWORD":
		case "PASSWORD_COMPROMISED":
			return t({ context: "auth.validation.password", message: "Use a stronger password with 8 to 64 characters." });

		case "INVALID_PASSWORD":
		case "INCORRECT_PASSWORD":
			return t`Check your current password, then try again.`;
		case "INVALID_TWO_FACTOR_CODE":
		case "INVALID_CODE":
		case "INVALID_BACKUP_CODE":
		case "OTP_HAS_EXPIRED":
			return t`Check your authenticator code, then try again.`;
		case "SESSION_NOT_FRESH":
		case "SESSION_EXPIRED":
		case "UNAUTHORIZED":
			return t`Sign in again, then retry this action.`;
		case "INVALID_EMAIL_OR_PASSWORD":
		case "INVALID_USERNAME_OR_PASSWORD":
			return t`Check your email and password, then try again.`;
		case "EMAIL_NOT_VERIFIED":
			return t`Verify your email before signing in.`;
		case "USER_ALREADY_EXISTS":
		case "USER_ALREADY_EXISTS_USE_ANOTHER_EMAIL":
			return t`Unable to create this account. Try signing in or use another email.`;
		case "USERNAME_IS_ALREADY_TAKEN":
			return t`This username is unavailable. Choose another.`;
		case "RATE_LIMITED":
		case "RATE_LIMIT_EXCEEDED":
		case "TOO_MANY_REQUESTS":
			return t`Please wait before trying again.`;
		case "INVALID_TOKEN":
		case "TOKEN_EXPIRED":
			return t`This link is invalid or expired. Request a new link.`;
		default:
			return fallback;
	}
}

/** Account surfaces accept codes only, including thrown network failures. */
export function accountErrorMessage(error: unknown): string {
	const code =
		typeof error === "object" && error !== null && "code" in error && typeof error.code === "string"
			? error.code
			: undefined;
	return authErrorMessage(code);
}

export function validAuthEmail(email: string): boolean {
	return z.email().safeParse(email.trim()).success;
}
export function authErrorField(code: string | undefined): "email" | "username" | "password" | null {
	if (["INVALID_EMAIL", "USER_ALREADY_EXISTS", "USER_ALREADY_EXISTS_USE_ANOTHER_EMAIL"].includes(code ?? ""))
		return "email";
	if (
		[
			"INVALID_USERNAME",
			"USERNAME_IS_INVALID",
			"USERNAME_TOO_SHORT",
			"USERNAME_TOO_LONG",
			"USERNAME_IS_ALREADY_TAKEN",
		].includes(code ?? "")
	)
		return "username";
	if (
		["PASSWORD_TOO_SHORT", "PASSWORD_TOO_LONG", "PASSWORD_TOO_WEAK", "WEAK_PASSWORD", "PASSWORD_COMPROMISED"].includes(
			code ?? "",
		)
	)
		return "password";
	return null;
}
