import type { AllowanceFailure, AllowanceReason, StartUsageView } from "@reactive-resume/schema/ai-usage";
import type { ReactNode } from "react";
import { t } from "@lingui/core/macro";
import { useLingui } from "@lingui/react";
import { Trans } from "@lingui/react/macro";
import { allowanceFailureSchema, allowanceReasonSchema } from "@reactive-resume/schema/ai-usage";
import { Alert, AlertActions, AlertDescription, AlertTitle } from "@reactive-resume/ui/components/alert";
import { buttonVariants } from "@reactive-resume/ui/components/button";
import { Icon } from "@reactive-resume/ui/components/icon";

export type { AllowanceReason } from "@reactive-resume/schema/ai-usage";

type AllowanceSnapshot = AllowanceFailure["allowance"];
type AiReviewTarget = "resume" | "cover-letter" | "import";
type AllowanceModel = {
	reason: AllowanceReason;
	title: string;
	description: string;
	nextStep: string;
	tone: "warn" | "info";
};

export function getAllowanceFailure(error: unknown): AllowanceFailure | null {
	if (!error || typeof error !== "object" || !("data" in error)) return null;
	const parsed = allowanceFailureSchema.safeParse(error.data);
	return parsed.success ? parsed.data : null;
}

export function getAllowanceReason(error: unknown): AllowanceReason | null {
	if (
		!error ||
		typeof error !== "object" ||
		!("data" in error) ||
		!error.data ||
		typeof error.data !== "object" ||
		!("reason" in error.data)
	)
		return null;
	const parsed = allowanceReasonSchema.safeParse(error.data.reason);
	return parsed.success ? parsed.data : null;
}

export function isAiAllowanceExhausted(usage?: StartUsageView): boolean {
	return usage?.operations.remaining === 0;
}

export function getAllowanceModel(
	reason: AllowanceReason,
	usage?: StartUsageView,
	allowance?: AllowanceSnapshot,
	target: AiReviewTarget = "resume",
): AllowanceModel {
	const operations = allowance ?? usage?.operations;
	const baseCvs = allowance ?? usage?.baseCvs;
	switch (reason) {
		case "AI_OPERATIONS_LIMIT": {
			const { used, limit, reserved } = operations ?? {};
			return {
				reason,
				tone: "warn",
				title: t({ context: "allowance.ai.title", message: "AI use limit reached" }),
				description:
					used !== undefined && limit != null && reserved !== undefined
						? t({
								context: "allowance.ai.usage",
								message: `${used} of ${limit} AI uses used. ${reserved} reserved for operations in progress.`,
							})
						: t({
								context: "allowance.ai.description",
								message: "No AI uses are available in your current allowance.",
							}),
				nextStep: t({
					context: "allowance.ai.next",
					message:
						"This allowance does not reset automatically. Continue editing manually or contact support. Your draft is kept.",
				}),
			};
		}
		case "BASE_CV_LIMIT": {
			const { used, limit } = baseCvs ?? {};
			return {
				reason,
				tone: "warn",
				title: t({ context: "allowance.base.title", message: "Base CV limit reached" }),
				description:
					used !== undefined && limit != null
						? t({ context: "allowance.base.usage", message: `${used} of ${limit} base CVs used.` })
						: t({ context: "allowance.base.description", message: "Your base CV allowance is full." }),
				nextStep: t({
					context: "allowance.base.next",
					message: "Open your existing CV to continue. Your selections are kept.",
				}),
			};
		}
		case "LANGUAGE_COPY_LIMIT":
		case "JOB_COPY_LIMIT": {
			const language = reason === "LANGUAGE_COPY_LIMIT";
			const { used, limit, reserved } = allowance ?? {};
			return {
				reason,
				tone: "warn",
				title: language
					? t({ context: "allowance.language.title", message: "Language copy limit reached" })
					: t({ context: "allowance.job.title", message: "Job copy limit reached" }),
				description:
					used !== undefined && limit != null && reserved !== undefined
						? language
							? t({
									context: "allowance.language.usage",
									message: `${used} of ${limit} language copies used for this base CV. ${reserved} being created.`,
								})
							: t({
									context: "allowance.job.usage",
									message: `${used} of ${limit} job copies used for this base CV. ${reserved} being created.`,
								})
						: language
							? t({
									context: "allowance.language.description",
									message: "The language copy allowance for this base CV is full.",
								})
							: t({
									context: "allowance.job.description",
									message: "The job copy allowance for this base CV is full.",
								}),
				nextStep: language
					? t({
							context: "allowance.language.next",
							message: "Open the existing language copy, or wait for its creation to finish. Your selections are kept.",
						})
					: t({
							context: "allowance.job.next",
							message: "Open the existing job copy, or wait for its creation to finish. Your selections are kept.",
						}),
			};
		}
		case "AI_PLATFORM_BUSY":
			return {
				reason,
				tone: "info",
				title: t({ context: "allowance.busy.title", message: "AI is busy" }),
				description: t({ context: "allowance.capacity.description", message: "AI is at capacity." }),
				nextStep: t({
					context: "allowance.capacity.next",
					message: "Try again shortly. Your draft is kept.",
				}),
			};
		case "AI_BUDGET_LIMIT":
			return {
				reason,
				tone: "info",
				title: t({ context: "allowance.budget.title", message: "AI budget limit reached" }),
				description: t({
					context: "allowance.budget.description",
					message: "The platform cannot reserve the AI budget for this request.",
				}),
				nextStep: t({ context: "allowance.busy.next", message: "Try again later. Your draft is kept." }),
			};
		case "AI_CONCURRENCY_LIMIT": {
			const { reserved, limit } = allowance ?? {};
			return {
				reason,
				tone: "info",
				title: t({ context: "allowance.concurrent.title", message: "Simultaneous AI operation limit reached" }),
				description:
					reserved !== undefined && limit != null
						? t({
								context: "allowance.concurrent.usage",
								message: `${reserved} of ${limit} simultaneous AI operations in progress.`,
							})
						: t({
								context: "allowance.concurrent.description",
								message: "Your simultaneous AI operation allowance is in use.",
							}),
				nextStep: t({
					context: "allowance.concurrent.next",
					message: "Wait for an operation to finish, then try again. Your draft is kept.",
				}),
			};
		}
		case "AI_TARGET_BUSY":
			return {
				reason,
				tone: "info",
				title: t({ context: "allowance.target.title", message: "An AI review is already running for this draft" }),
				description:
					target === "cover-letter"
						? t({
								context: "allowance.target.letter",
								message: "An AI review is already running for this letter.",
							})
						: target === "import"
							? t({
									context: "allowance.target.import",
									message: "An AI review is already running for this import.",
								})
							: t({
									context: "allowance.target.description",
									message: "An AI review is already running for this CV.",
								}),
				nextStep: t({
					context: "allowance.target.next",
					message: "Wait for it to finish, then try again. Your draft is kept.",
				}),
			};
		case "AI_PROVIDER_CHANGED":
			return {
				reason,
				tone: "info",
				title: t({ context: "allowance.provider.title", message: "AI settings changed" }),
				description: t({
					context: "allowance.provider.description",
					message: "This conversation no longer matches the active AI settings.",
				}),
				nextStep: t({
					context: "allowance.provider.next",
					message: "Review the current processing notice before trying again. Your draft is kept.",
				}),
			};
	}
}

type AllowanceLimitNoticeProps = {
	reason?: AllowanceReason;
	error?: unknown;
	target?: AiReviewTarget;
	usage?: StartUsageView | undefined;
	description?: ReactNode;
	children?: ReactNode;
	actions?: ReactNode;
};

export function AllowanceLimitNotice({
	reason,
	error,
	target,
	usage,
	description,
	children,
	actions,
}: AllowanceLimitNoticeProps) {
	useLingui();
	const resolvedReason = reason ?? getAllowanceReason(error);
	if (!resolvedReason) return null;
	const failure = getAllowanceFailure(error);
	const model = getAllowanceModel(
		resolvedReason,
		usage,
		failure?.reason === resolvedReason ? failure.allowance : undefined,
		target,
	);
	return (
		<Alert variant={model.tone} role="alert">
			<Icon name={model.tone === "warn" ? "warning-circle" : "info"} />
			<AlertTitle>{model.title}</AlertTitle>
			<AlertDescription>
				<p>{model.description}</p>
				<p>{model.nextStep}</p>
				{description && <p>{description}</p>}
				{children}
			</AlertDescription>
			<AlertActions>
				{actions}
				{model.tone === "warn" && (
					<a
						data-slot="button"
						data-variant="secondary"
						href="/help"
						className={buttonVariants({ variant: "secondary" })}
					>
						<Trans context="help.page.title">Help and contact</Trans>
					</a>
				)}
			</AlertActions>
		</Alert>
	);
}
