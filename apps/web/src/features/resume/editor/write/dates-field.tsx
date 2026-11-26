import type { DateFormat, ResumeDates, YearMonth } from "@reactive-resume/schema/resume/dates";
import { Trans, useLingui } from "@lingui/react/macro";
import { useId, useState } from "react";
import { Icon } from "@reactive-resume/ui/components/icon";
import { Switch } from "@reactive-resume/ui/components/switch";
import { cn } from "@reactive-resume/utils/style";
import { MonthYearInput } from "@/components/input/month-year-input";

type DateSettings = { locale: string; format?: DateFormat | undefined };
const isBefore = (end: YearMonth, start: YearMonth) => end.localeCompare(start) < 0 && !start.startsWith(end);

type DatesFieldProps = DateSettings & {
	dates: ResumeDates;
	/** Awards, certifications and publications have one date. */
	single?: boolean | undefined;
	onChange: (dates: ResumeDates) => void;
	className?: string;
};

/**
 * Structured dates: start – end with a Present switch, or a single date. Editing any part clears the
 * "needs a look" note left by text that couldn't be read exactly.
 */
export function DatesField({ dates, single = false, locale, format, onChange, className }: DatesFieldProps) {
	const { t } = useLingui();
	const id = useId();
	const [invalid, setInvalid] = useState<Record<"start" | "end", boolean>>({ start: false, end: false });
	// Any edit replaces the dates without `raw`, which clears the review note.
	const current: ResumeDates = { start: dates.start, end: dates.end, present: dates.present };
	const reversed = !single && !dates.present && dates.start && dates.end && isBefore(dates.end, dates.start);
	const hasError = invalid.start || (!dates.present && invalid.end);

	const setInvalidFor = (part: "start" | "end") => (value: boolean) =>
		setInvalid((state) => (state[part] === value ? state : { ...state, [part]: value }));

	return (
		<fieldset className={cn("grid min-w-0 gap-1.5", className)} aria-describedby={`${id}-note`}>
			<legend className="mb-1.5 text-[13px] leading-4 font-medium text-ink">
				{single ? <Trans>Date</Trans> : <Trans>Dates</Trans>}
			</legend>

			<div className="flex items-center gap-2">
				<MonthYearInput
					label={single ? t`Date` : t`Start`}
					value={dates.start}
					locale={locale}
					format={format}
					onCommit={(start) => onChange({ ...current, start })}
					onInvalid={setInvalidFor("start")}
				/>

				{!single && (
					<>
						<span aria-hidden="true" className="text-ink-3">
							–
						</span>
						<MonthYearInput
							label={t`End`}
							value={dates.end}
							locale={locale}
							format={format}
							disabled={dates.present}
							placeholderValue={dates.present ? t`Present` : undefined}
							onCommit={(end) => onChange({ ...current, end })}
							onInvalid={setInvalidFor("end")}
						/>
					</>
				)}
			</div>

			{!single && (
				<>
					{/* oxlint-disable-next-line jsx-a11y/label-has-associated-control -- Base UI's Switch is the control; wrapping it in a label is its documented pattern. */}
					<label className="flex w-fit cursor-pointer items-center gap-2 p-1 text-sm">
						<Switch
							checked={dates.present}
							// The date schema stores a null end date when the user marks a role as ongoing.
							onCheckedChange={(present) => onChange({ ...current, present, end: present ? null : dates.end })}
						/>
						<Trans>Present</Trans>
					</label>
				</>
			)}

			<div id={`${id}-note`}>
				{hasError ? (
					<p className="flex items-start gap-1 text-xs leading-4 text-danger-text">
						<Icon name="warning-circle" size={16} className="shrink-0" />
						<Trans>
							This date hasn't been saved. Use a month and year, like Mar 2022, or just a year. The resume keeps the
							last valid date.
						</Trans>
					</p>
				) : dates.raw !== undefined ? (
					<p className="flex items-start gap-1 text-xs leading-4 text-warn-text">
						<Icon name="warning" size={16} className="shrink-0" />
						{dates.start ? (
							<Trans>We read "{dates.raw}". Pick a month so it sorts and prints consistently.</Trans>
						) : (
							<Trans>We couldn't read "{dates.raw}". Enter the dates so they sort and print consistently.</Trans>
						)}
					</p>
				) : reversed ? (
					<p className="flex items-start gap-1 text-xs leading-4 text-warn-text">
						<Icon name="warning" size={16} className="shrink-0" />
						<Trans>The end is before the start.</Trans>
					</p>
				) : null}
			</div>
		</fieldset>
	);
}
