import type { ResumeData } from "@reactive-resume/schema/resume/data";
import { useLingui } from "@lingui/react";
import { sectionTypeSchema } from "@reactive-resume/schema/resume/data";
import { useVariantsCopy } from "./copy.generated";

export function useReviewSectionTitle() {
	const copy = useVariantsCopy();
	return (sectionId: string, data?: ResumeData) => {
		if (sectionId === "basics") return copy("review.tailoring.section.basics");
		const section = sectionTypeSchema.safeParse(sectionId);
		if (section.success) return copy(`review.tailoring.section.${section.data}`);
		return data?.customSections.find((item) => item.id === sectionId)?.title || copy("review.tailoring.section.custom");
	};
}

export function useReviewInterfaceText() {
	const copy = useVariantsCopy();
	const { i18n } = useLingui();
	return (text: string, type: "wording" | "summary" | "requirement" | "import" | "finding") => {
		// Quoted CV passages and technical names can use a different language from the question.
		const prose = text.replace(/"[^"]*"|“[^”]*”|«[^»]*»|\[[^\]]+\]/gu, "");
		const arabic = prose.match(/\p{Script=Arabic}/gu)?.length ?? 0;
		const latin = prose.match(/\p{Script=Latin}/gu)?.length ?? 0;
		if (i18n.locale === "ar-SA" ? arabic > 0 && arabic >= latin : latin > arabic) return text;
		return type === "finding" ? copy("review.explanation.checkEvidence") : copy(`review.clarification.${type}`);
	};
}
