// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vite-plus/test";
import { setupI18n } from "@lingui/core";
import { I18nProvider } from "@lingui/react";
import { ORPCError } from "@orpc/client";
import { messages as arabicMessages } from "../../../../../locales/ar-SA.po";
import { type ProcessingNotice, useTranslationRetryConsent } from "./processing-consent";
import { ReviewFailureReason } from "./review-failure";

const api = vi.hoisted(() => ({ notices: vi.fn(), grant: vi.fn() }));
vi.mock("@/libs/orpc/client", () => ({ client: { ai: { processing: api } } }));

afterEach(() => {
	cleanup();
	vi.resetAllMocks();
});

function RetrySurface({ retry }: { retry: (notice: ProcessingNotice) => Promise<unknown> }) {
	const consent = useTranslationRetryConsent(retry);
	return (
		<>
			<button type="button" onClick={() => consent.open()}>
				Open
			</button>
			{consent.dialog}
		</>
	);
}

it.each(["en-US", "ar-SA"] as const)(
	"requires a displayed %s notice after revocation and a stale grant",
	async (locale) => {
		const i18n = setupI18n({ locale, messages: { [locale]: locale === "ar-SA" ? arabicMessages : {} } });
		const notice = {
			content: locale === "ar-SA" ? "نص المعالجة الأول" : "First processing notice",
			locale,
			purpose: "review.translation",
			noticeVersion: "1",
			route: { routeId: "route", routeRevision: "1", configRevision: "1" },
			noticeSha256: "a".repeat(64),
			alreadyGranted: true,
		};
		const current = { ...notice, alreadyGranted: false };
		const changed = { ...current, content: current.content + " — 2", noticeSha256: "b".repeat(64) };
		let finishLoading: (value: ProcessingNotice[]) => void = () => {
			throw new Error("Notice request did not start");
		};
		const pending = new Promise<ProcessingNotice[]>((resolve) => {
			finishLoading = resolve;
		});
		const retry = vi
			.fn()
			.mockRejectedValueOnce(new ORPCError("PRECONDITION_FAILED", { data: { reason: "AI_CONSENT_REQUIRED" } }))
			.mockResolvedValue(undefined);
		api.notices
			.mockReturnValueOnce(pending)
			.mockResolvedValueOnce([notice])
			.mockResolvedValueOnce([current])
			.mockResolvedValueOnce([changed]);
		api.grant
			.mockRejectedValueOnce(new ORPCError("PRECONDITION_FAILED", { data: { reason: "AI_CONSENT_NOTICE_CHANGED" } }))
			.mockResolvedValue(undefined);
		const cancel = locale === "ar-SA" ? "إلغاء" : "Cancel";
		const review = locale === "ar-SA" ? "مراجعة الموافقة" : "Review consent";
		const acceptance = locale === "ar-SA" ? "إعادة محاولة الأجزاء المتعثرة" : "Retry failed parts";
		render(
			<I18nProvider i18n={i18n}>
				<RetrySurface retry={retry} />
			</I18nProvider>,
		);
		const open = () => fireEvent.click(screen.getByRole("button", { name: "Open" }));
		open();
		expect(screen.getByRole("button", { name: acceptance })).toBeDisabled();
		fireEvent.click(screen.getByRole("button", { name: cancel }));
		await act(async () => finishLoading([notice]));
		expect(api.grant).not.toHaveBeenCalled();
		expect(retry).not.toHaveBeenCalled();
		open();
		await waitFor(() => expect(retry).toHaveBeenCalledTimes(1));
		expect(api.grant).not.toHaveBeenCalled();
		fireEvent.click(await screen.findByRole("button", { name: review }));
		expect(await screen.findByText(current.content)).toBeVisible();
		fireEvent.click(screen.getByRole("button", { name: acceptance }));
		await waitFor(() =>
			expect(api.grant).toHaveBeenCalledWith(expect.objectContaining({ noticeSha256: current.noticeSha256 })),
		);
		expect(retry).toHaveBeenCalledTimes(1);
		fireEvent.click(await screen.findByRole("button", { name: review }));
		expect(await screen.findByText(changed.content)).toBeVisible();
		expect(api.grant).toHaveBeenCalledTimes(1);
		expect(retry).toHaveBeenCalledTimes(1);
		fireEvent.click(screen.getByRole("button", { name: acceptance }));
		await waitFor(() => expect(retry).toHaveBeenCalledTimes(2));
		expect(api.grant).toHaveBeenLastCalledWith(expect.objectContaining({ noticeSha256: changed.noticeSha256 }));
		expect(api.notices).toHaveBeenCalledTimes(4);
		expect(api.notices).toHaveBeenLastCalledWith({ purpose: notice.purpose, locale });
	},
);

it.each([
	["en-US", "This request expired while waiting to start. Your draft is kept. Retry to put it back in the queue."],
	["ar-SA", "انتهت مهلة الطلب قبل بدء المعالجة. بقيت مسودتك محفوظة. أعد المحاولة لإضافته إلى قائمة الانتظار."],
] as const)("explains queue expiry and recovery in %s", (locale, message) => {
	const i18n = setupI18n({ locale, messages: { [locale]: locale === "ar-SA" ? arabicMessages : {} } });
	render(
		<I18nProvider i18n={i18n}>
			<ReviewFailureReason code="AI_QUEUE_EXPIRED" />
		</I18nProvider>,
	);
	expect(screen.getByText(message)).toBeDefined();
});
