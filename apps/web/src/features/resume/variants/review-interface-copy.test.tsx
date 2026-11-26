// @vitest-environment happy-dom
import type { ReactNode } from "react";
import { renderHook } from "@testing-library/react";
import { expect, it } from "vite-plus/test";
import { setupI18n } from "@lingui/core";
import { I18nProvider } from "@lingui/react";
import { messages as arabicMessages } from "../../../../locales/ar-SA.po";
import { useReviewInterfaceText, useReviewSectionTitle } from "./review-interface-copy";

it.each([
	{
		locale: "ar-SA",
		sectionLabel: "الملخّص",
		correct: 'ما دورك في مشروع "API Gateway"?',
		wrong: "What result can you confirm?",
		fallback: "ما النتيجة أو التفصيل الذي يمكنك تأكيده في هذا المقطع؟",
	},
	{
		locale: "en-US",
		sectionLabel: "Summary",
		correct: 'What did you build in "مشروع الاختبار"?',
		wrong: "ما النتيجة التي يمكنك تأكيدها؟",
		fallback: "What result or detail can you confirm for this passage?",
	},
])(
	"uses the $locale interface for review labels and questions",
	({ locale, sectionLabel, correct, wrong, fallback }) => {
		const i18n = setupI18n({ locale, messages: { [locale]: locale === "ar-SA" ? arabicMessages : {} } });
		const { result } = renderHook(() => ({ text: useReviewInterfaceText(), section: useReviewSectionTitle() }), {
			wrapper: ({ children }: { children: ReactNode }) => <I18nProvider i18n={i18n}>{children}</I18nProvider>,
		});
		expect(result.current.section("summary")).toBe(sectionLabel);
		expect(result.current.text(correct, "wording")).toBe(correct);
		expect(result.current.text(wrong, "wording")).toBe(fallback);
	},
);
