import type { ReactNode } from "react";
import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import { useEffect, useState } from "react";
import { Button } from "@reactive-resume/ui/components/button";
import { NativeSelect } from "@reactive-resume/ui/components/native-select";
import { AllowanceLimitNotice } from "@/features/usage/allowance-limit";
import { client } from "@/libs/orpc/client";

export { baseCvLimitMessage } from "./creation-error";

type BaseCvLimitNoticeProps = {
	error?: unknown;
	description?: ReactNode;
	busy?: boolean;
	onOpen: (id: string) => void;
	onReplace?: (id: string) => void;
	replaceDisabled?: boolean;
	children?: ReactNode;
};

export function BaseCvLimitNotice({
	error,
	description,
	busy,
	onOpen,
	onReplace,
	replaceDisabled,
	children,
}: BaseCvLimitNoticeProps) {
	const [resumes, setResumes] = useState<Array<{ id: string; name: string }>>([]);
	const [selected, setSelected] = useState("");
	const [failed, setFailed] = useState(false);
	const [attempt, setAttempt] = useState(0);
	useEffect(() => {
		const controller = new AbortController();
		void client.resume
			.list({}, { signal: controller.signal })
			.then((items) => {
				if (controller.signal.aborted) return;
				const bases = items.filter((item) => item.variantKind === "base");
				setResumes(bases);
				setSelected(bases[0]?.id ?? "");
				if (bases.length === 0) setFailed(true);
			})
			.catch(() => {
				if (!controller.signal.aborted) setFailed(true);
			});
		return () => controller.abort();
	}, [attempt]);
	return (
		<AllowanceLimitNotice
			reason="BASE_CV_LIMIT"
			error={error}
			description={description}
			actions={
				<>
					{onReplace && (
						<Button
							variant="secondary"
							disabled={busy || replaceDisabled || !selected}
							onClick={() => onReplace(selected)}
						>
							<Trans context="review.import.replaceExisting">Replace existing base CV</Trans>
						</Button>
					)}
					{children}
					<Button variant="secondary" disabled={busy || !selected} onClick={() => onOpen(selected)}>
						<Trans context="documents.baseCvLimit.openExisting">Open existing CV</Trans>
					</Button>
					{failed && (
						<Button
							variant="secondary"
							disabled={busy}
							onClick={() => {
								setFailed(false);
								setAttempt((value) => value + 1);
							}}
						>
							<Trans>Try again</Trans>
						</Button>
					)}
				</>
			}
		>
			{resumes.length > 1 && (
				<NativeSelect
					aria-label={t({ context: "documents.baseCvLimit.existing", message: "Existing CV" })}
					value={selected}
					onChange={(event) => setSelected(event.target.value)}
					disabled={busy}
				>
					{resumes.map((resume) => (
						<option key={resume.id} value={resume.id}>
							{resume.name}
						</option>
					))}
				</NativeSelect>
			)}
			{failed && (
				<p>
					<Trans context="documents.baseCvLimit.loadExisting">Could not load your existing CV. Try again.</Trans>
				</p>
			)}
		</AllowanceLimitNotice>
	);
}
