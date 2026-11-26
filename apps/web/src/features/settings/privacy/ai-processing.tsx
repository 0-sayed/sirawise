import { Trans } from "@lingui/react/macro";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ActionGroup } from "@reactive-resume/ui/components/action-group";
import { Button } from "@reactive-resume/ui/components/button";
import { SettingsSection } from "../section";
import { PrivacyNotice } from "./notice";
import { QuerySkeleton } from "@/components/query-skeleton";
import { useAssistantCopy } from "@/features/assistant/copy.generated";
import { useUiLocale } from "@/features/locale/provider";
import { client, orpc } from "@/libs/orpc/client";

export function AiProcessingSettings() {
	const copy = useAssistantCopy();
	const { locale } = useUiLocale();
	const query = useQueryClient();
	const options = orpc.ai.processing.status.queryOptions({ input: { locale } });
	const status = useQuery(options);
	const withdraw = useMutation({
		mutationFn: () => client.ai.processing.revoke({}),
		onSuccess: async () => {
			await query.invalidateQueries({ queryKey: orpc.ai.processing.status.key() });
		},
	});
	const notices = status.data?.notices ?? [];
	const formatter = new Intl.DateTimeFormat(locale, {
		dateStyle: "medium",
		calendar: "gregory",
		numberingSystem: "latn",
	});
	return (
		<SettingsSection id="ai-and-privacy" width="full" presentation="card" title={copy("privacy.ai.title")}>
			{status.isPending && <QuerySkeleton shape="settings" count={1} label={copy("review.launch.loadingConsent")} />}
			{status.isError ? (
				<PrivacyNotice
					error
					title={copy("privacy.ai.statusUnavailable")}
					action={
						<Button variant="secondary" onClick={() => void status.refetch()}>
							<Trans context="workspace.privacy.d8b8392e2c54">Try again</Trans>
						</Button>
					}
				/>
			) : (
				status.isSuccess && (
					<>
						{notices.length === 0 && (
							<p className="type-body text-ink-2">{copy("review.assistant.environmentUnavailable")}</p>
						)}
						{notices.map(({ content, grantedAt }) => (
							<div className="grid gap-2" key={content}>
								<p className="type-body text-ink-2">{content}</p>
								{grantedAt && (
									<time className="type-label" dateTime={grantedAt}>
										{copy("privacy.ai.grantedAt", { date: formatter.format(new Date(grantedAt)) })}
									</time>
								)}
							</div>
						))}
						{!notices.some((notice) => notice.grantedAt) && (
							<p className="type-body text-ink-2" aria-live="polite">
								{copy("privacy.ai.noConsent")}
							</p>
						)}
						{status.data.canWithdraw && (
							<ActionGroup>
								<Button variant="secondary" disabled={withdraw.isPending} onClick={() => withdraw.mutate()}>
									{copy("privacy.ai.withdraw")}
								</Button>
							</ActionGroup>
						)}
						{withdraw.isError && <PrivacyNotice error title={copy("privacy.ai.withdrawFailed")} />}
					</>
				)
			)}
		</SettingsSection>
	);
}
