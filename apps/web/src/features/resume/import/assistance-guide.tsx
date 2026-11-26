import { useLingui } from "@lingui/react/macro";
import { GuidedTour } from "@reactive-resume/ui/components/guided-tour";
import { useCurrentSession } from "@/hooks/use-current-session";

export function ImportAssistanceGuide({
	sectionId,
	textId,
	reviewId,
}: {
	sectionId: string;
	textId: string;
	reviewId: string;
}) {
	const { t } = useLingui();
	const session = useCurrentSession();
	return (
		<GuidedTour
			tourId="import-text-assistance"
			{...(session ? { userId: session.user.id } : {})}
			labels={{
				start: t({ context: "review.import.guide.show", message: "Show me how" }),
				back: t`Back`,
				next: t`Next`,
				skip: t`Skip`,
				done: t`Done`,
				step: (current, total) => t({ context: "review.import.guide.step", message: `Step ${current} of ${total}` }),
			}}
			steps={[
				{
					targetId: sectionId,
					title: t`Section to review`,
					description: t({ context: "review.import.guide.choose", message: "Choose the section." }),
				},
				{
					targetId: textId,
					title: t`Highlight the text you want help with`,
					description: t({
						context: "review.import.guide.highlight",
						message: "Highlight the text you want help with.",
					}),
				},
				{
					targetId: reviewId,
					title: t`Review selected text`,
					description: t({ context: "review.import.guide.review", message: "Press Review selected text." }),
				},
			]}
		/>
	);
}
