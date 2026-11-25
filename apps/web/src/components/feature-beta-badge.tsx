import { Badge } from "@reactive-resume/ui/components/badge";
import { useAssistantCopy } from "@/features/assistant/copy.generated";

export function FeatureBetaBadge() {
	const copy = useAssistantCopy();
	return <Badge variant="neutral">{copy("review.beta")}</Badge>;
}
