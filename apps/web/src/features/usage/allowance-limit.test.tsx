// @vitest-environment happy-dom
import type { StartUsageView } from "@reactive-resume/schema/ai-usage";
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it } from "vite-plus/test";
import { i18n } from "@lingui/core";
import { I18nProvider } from "@lingui/react";
import { AllowanceLimitNotice, getAllowanceModel, getAllowanceReason, isAiAllowanceExhausted } from "./allowance-limit";
import { getUiLocaleMessages } from "@/libs/locale";

const usage: StartUsageView = {
	plan: "start",
	operations: { used: 4, reserved: 1, limit: 5, remaining: 0 },
	baseCvs: { used: 1, limit: 1 },
};
beforeEach(() => i18n.loadAndActivate({ locale: "en-US", messages: {} }));
afterEach(cleanup);

it.each([
	["AI_OPERATIONS_LIMIT", "AI use limit reached", "does not reset"],
	["BASE_CV_LIMIT", "Base CV limit reached", "existing CV"],
	["LANGUAGE_COPY_LIMIT", "Language copy limit reached", "existing language copy"],
	["JOB_COPY_LIMIT", "Job copy limit reached", "existing job copy"],
	["AI_PLATFORM_BUSY", "AI is busy", "Try again shortly"],
	["AI_BUDGET_LIMIT", "AI budget limit reached", "Try again later"],
	["AI_CONCURRENCY_LIMIT", "Simultaneous AI operation limit reached", "Wait for an operation to finish"],
	["AI_TARGET_BUSY", "An AI review is already running for this draft", "Wait for it to finish"],
	["AI_PROVIDER_CHANGED", "AI settings changed", "Review the current processing notice"],
] as const)("explains %s with the matching recovery", (reason, title, recovery) => {
	expect(getAllowanceReason({ code: "PRECONDITION_FAILED", data: { reason } })).toBe(reason);
	const model = getAllowanceModel(reason, usage);
	expect(model.title).toBe(title);
	expect(model.nextStep).toContain(recovery);
});

it("does not classify ordinary errors or unknown reasons as allowance denials", () => {
	for (const error of [
		null,
		"AI_OPERATIONS_LIMIT",
		{ code: "FORBIDDEN", message: "BASE_CV_LIMIT" },
		{ code: "PRECONDITION_FAILED", data: { reason: "UNRECOGNIZED_LIMIT" } },
	]) {
		expect(getAllowanceReason(error)).toBeNull();
		const view = render(
			<I18nProvider i18n={i18n}>
				<AllowanceLimitNotice error={error} />
			</I18nProvider>,
		);
		expect(view.container.textContent).toBe("");
		view.unmount();
	}
});

it("recognizes structured allowance reasons across transport codes", () => {
	expect(getAllowanceReason({ code: "FORBIDDEN", data: { reason: "BASE_CV_LIMIT" } })).toBe("BASE_CV_LIMIT");
});

it("includes spent and reserved counts without inventing a reset", () => {
	const model = getAllowanceModel("AI_OPERATIONS_LIMIT", usage);
	expect(model.description).toContain("4 of 5 AI uses used");
	expect(model.description).toContain("1 reserved");
	expect(model.nextStep).not.toMatch(/tomorrow|upgrade|pay/i);
	expect(getAllowanceModel("BASE_CV_LIMIT", usage).description).toContain("1 of 1 base CVs used");
});

it("uses the server denial snapshot instead of stale usage", () => {
	render(
		<I18nProvider i18n={i18n}>
			<AllowanceLimitNotice
				usage={usage}
				error={{
					code: "PRECONDITION_FAILED",
					data: { reason: "AI_OPERATIONS_LIMIT", allowance: { limit: 8, used: 8, reserved: 0, remaining: 0 } },
				}}
			/>
		</I18nProvider>,
	);
	expect(screen.getByText(/8 of 8 AI uses used/)).toBeDefined();
	expect(screen.getByRole("link", { name: "Help and contact" }).getAttribute("href")).toBe("/help");
});

it.each([
	[
		"LANGUAGE_COPY_LIMIT",
		{ used: 0, reserved: 1, limit: 1, remaining: 0 },
		"0 of 1 language copies used for this base CV. 1 being created.",
	],
	[
		"JOB_COPY_LIMIT",
		{ used: 1, reserved: 0, limit: 1, remaining: 0 },
		"1 of 1 job copies used for this base CV. 0 being created.",
	],
	[
		"AI_CONCURRENCY_LIMIT",
		{ used: 0, reserved: 3, limit: 3, remaining: 0 },
		"3 of 3 simultaneous AI operations in progress.",
	],
] as const)("uses reason-specific counts for %s rather than lifetime AI usage", (reason, allowance, expected) => {
	render(
		<I18nProvider i18n={i18n}>
			<AllowanceLimitNotice usage={usage} error={{ code: "PRECONDITION_FAILED", data: { reason, allowance } }} />
		</I18nProvider>,
	);
	expect(screen.getByText(expected)).toBeDefined();
	expect(document.body.textContent).not.toContain("4 of 5");
});

it("does not invent a numeric limit when account usage is unavailable", () => {
	const model = getAllowanceModel("AI_OPERATIONS_LIMIT");
	expect(model.description).toBe("No AI uses are available in your current allowance.");
	expect(model.description).not.toMatch(/\d/);
});

it("keeps platform capacity neutral and omits account quota details", () => {
	render(
		<I18nProvider i18n={i18n}>
			<AllowanceLimitNotice reason="AI_PLATFORM_BUSY" usage={usage} />
		</I18nProvider>,
	);
	expect(screen.getByText("AI is busy")).toBeDefined();
	expect(screen.getByText(/Try again shortly/)).toBeDefined();
	expect(document.body.textContent).not.toMatch(/4 of 5|budget|tomorrow|quota|\$/i);
	expect(screen.getByText("AI is busy").closest("[data-slot=alert]")?.getAttribute("data-variant")).toBe("info");
});

it("preserves caller recovery controls and description", () => {
	render(
		<I18nProvider i18n={i18n}>
			<AllowanceLimitNotice
				reason="BASE_CV_LIMIT"
				description="Your selections are kept."
				actions={<button>Open the exact existing CV</button>}
			>
				<select aria-label="Existing CV">
					<option>My CV</option>
				</select>
			</AllowanceLimitNotice>
		</I18nProvider>,
	);
	expect(screen.getByText("Your selections are kept.")).toBeDefined();
	expect(screen.getByRole("combobox", { name: "Existing CV" })).toBeDefined();
	expect(screen.getByRole("button", { name: "Open the exact existing CV" })).toBeDefined();
	expect(screen.getByRole("alert")).toHaveTextContent("Base CV limit reached");
});

it("only marks known zero remaining as exhausted, preserving unlimited and unloaded states", () => {
	expect(isAiAllowanceExhausted(usage)).toBe(true);
	expect(isAiAllowanceExhausted(undefined)).toBe(false);
	expect(
		isAiAllowanceExhausted({ ...usage, operations: { used: 99, reserved: 0, limit: null, remaining: null } }),
	).toBe(false);
	expect(isAiAllowanceExhausted({ ...usage, operations: { used: 3, reserved: 1, limit: 5, remaining: 1 } })).toBe(
		false,
	);
});

it("switches the rendered notice to the delivered Arabic catalog with Latin usage counts", async () => {
	render(
		<I18nProvider i18n={i18n}>
			<AllowanceLimitNotice reason="AI_OPERATIONS_LIMIT" usage={usage} />
		</I18nProvider>,
	);
	expect(screen.getByText("AI use limit reached")).toBeDefined();
	await act(async () => i18n.loadAndActivate(await getUiLocaleMessages("ar-SA")));
	expect(screen.queryByText("AI use limit reached")).toBeNull();
	const notice = document.querySelector("[data-slot=alert]");
	expect(notice?.textContent).toMatch(/[\u0600-\u06ff]/);
	expect(notice?.textContent).toContain("4");
	expect(notice?.textContent).toContain("5");
	expect(notice?.textContent).toContain("1");
	expect(notice?.textContent).not.toMatch(/[٠-٩]|\{used\}|\{limit\}|\{reserved\}/);
	expect(notice?.textContent).not.toContain("This allowance does not reset automatically");
	expect(screen.getByRole("link", { name: "المساعدة والتواصل" }).getAttribute("href")).toBe("/help");
});

it.each(["en-US", "ar-SA"] as const)(
	"explains account and target denials in %s with preserved drafts",
	async (locale) => {
		i18n.loadAndActivate(await getUiLocaleMessages(locale));
		for (const reason of ["AI_CONCURRENCY_LIMIT", "AI_TARGET_BUSY"] as const) {
			const view = render(
				<I18nProvider i18n={i18n}>
					<AllowanceLimitNotice
						error={{
							data: {
								reason,
								...(reason === "AI_CONCURRENCY_LIMIT"
									? { allowance: { limit: 3, used: 0, reserved: 3, remaining: 0 } }
									: {}),
							},
						}}
					/>
				</I18nProvider>,
			);
			const notice = screen.getByRole("alert");
			expect(notice.textContent).toContain(locale === "ar-SA" ? "مسودتك محفوظة" : "Your draft is kept");
			if (reason === "AI_CONCURRENCY_LIMIT")
				expect(notice.textContent).toContain(locale === "ar-SA" ? "3 من 3" : "3 of 3");
			else
				expect(notice.textContent).toContain(
					locale === "ar-SA"
						? "تجري مراجعة بالذكاء الاصطناعي لهذه السيرة الذاتية بالفعل."
						: "An AI review is already running for this CV.",
				);
			if (locale === "ar-SA") expect(notice.textContent).not.toMatch(/AI review|Your draft|[٠-٩]/);
			view.unmount();
		}
	},
);

it.each([
	[
		"cover-letter",
		"An AI review is already running for this letter.",
		"تجري مراجعة بالذكاء الاصطناعي لهذا الخطاب بالفعل.",
	],
	["import", "An AI review is already running for this import.", "تجري مراجعة بالذكاء الاصطناعي لهذا الاستيراد بالفعل."],
] as const)("names the busy %s in both locales", async (target, english, arabic) => {
	render(
		<I18nProvider i18n={i18n}>
			<AllowanceLimitNotice reason="AI_TARGET_BUSY" target={target} />
		</I18nProvider>,
	);
	expect(screen.getByRole("alert").textContent).toContain(english);
	await act(async () => i18n.loadAndActivate(await getUiLocaleMessages("ar-SA")));
	expect(screen.getByRole("alert").textContent).toContain(arabic);
});
