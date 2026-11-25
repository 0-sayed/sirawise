import type { DateFormat, YearMonth } from "@reactive-resume/schema/resume/dates";
import { t } from "@lingui/core/macro";
import { useId, useMemo, useRef, useState } from "react";
import { formatYearMonth, toYearMonth } from "@reactive-resume/schema/resume/dates";
import { readSingleDate } from "@reactive-resume/schema/resume/period";
import { Button } from "@reactive-resume/ui/components/button";
import { Icon } from "@reactive-resume/ui/components/icon";
import { inputBaseClassName, fieldDirectionProps } from "@reactive-resume/ui/components/input";
import { NativeSelect } from "@reactive-resume/ui/components/native-select";
import { Popover, PopoverContent, PopoverTrigger } from "@reactive-resume/ui/components/popover";
import { normalizeNumericDigits } from "@reactive-resume/utils/string";
import { cn } from "@reactive-resume/utils/style";

type DateSettings = { locale: string; format?: DateFormat | undefined };
const monthDateSamples = Array.from({ length: 12 }, (_, month) => new Date(Date.UTC(2020, month, 1)));

/** What someone typed as a date: a year-month, null when cleared, or undefined when it can't be read. */
function readTypedDate(text: string, locale: string): YearMonth | null | undefined {
	const value = text.trim();
	if (!value) return null;
	const reading = readSingleDate(value, locale);
	return reading ? toYearMonth(reading.endpoint) : undefined;
}

type MonthYearInputProps = DateSettings & {
	label: string;
	id?: string;
	name?: string;
	value: YearMonth | null;
	disabled?: boolean;
	/** Shown instead of the value, e.g. "Present" while the entry is ongoing. */
	placeholderValue?: string | undefined;
	onCommit: (value: YearMonth | null) => void;
	onInvalid: (invalid: boolean) => void;
};

/**
 * One date, typed the way people write it ("Mar 2022", "03/2022", "2022-03" or just "2022"). A readable value
 * saves as you type; on blur the field shows it in the resume's date format.
 */
export function MonthYearInput({
	id,
	name,
	label,
	value,
	locale,
	format,
	disabled,
	placeholderValue,
	onCommit,
	onInvalid,
}: MonthYearInputProps) {
	const [invalid, setInvalid] = useState(false);
	const [typed, setTyped] = useState<string | null>(null);
	const [open, setOpen] = useState(false);
	const popupRef = useRef<HTMLDivElement>(null);
	const triggerRef = useRef<HTMLButtonElement>(null);
	const triggerId = useId();
	const [currentYear] = useState(() => new Date().getFullYear());
	const selectedYear = value ? Number(value.slice(0, 4)) : currentYear;
	const [calendarYear, setCalendarYear] = useState(selectedYear);
	const months = useMemo(
		() =>
			monthDateSamples.map((date, month) => ({
				value: month,
				label: new Intl.DateTimeFormat(locale, { month: "long", timeZone: "UTC" }).format(date),
			})),
		[locale],
	);
	const formatted = value ? formatYearMonth(value, { locale, format }) : "";
	const years = Array.from({ length: 111 }, (_, index) => selectedYear + 10 - index);
	const chooseMonth = (month: number) => {
		const next = `${calendarYear}-${String(month + 1).padStart(2, "0")}` as YearMonth;
		setTyped(null);
		setOpen(false);
		setInvalid(false);
		onInvalid(false);
		if (next !== value) onCommit(next);
	};

	return (
		<div
			className="relative min-w-0 flex-1"
			onBlur={(event) => {
				const field = event.currentTarget;
				queueMicrotask(() => {
					const next = field.ownerDocument.activeElement;
					if (!field.contains(next) && !popupRef.current?.contains(next)) setOpen(false);
				});
			}}
		>
			<Popover
				open={open}
				triggerId={triggerId}
				onOpenChange={(next) => {
					if (next) setCalendarYear(selectedYear);
					setOpen(next);
				}}
			>
				<input
					{...fieldDirectionProps({ placeholder: t`Mar 2022` })}
					id={id}
					name={name}
					type="text"
					inputMode="text"
					autoComplete="off"
					aria-label={label}
					aria-invalid={invalid}
					disabled={disabled}
					placeholder={t`Mar 2022`}
					value={placeholderValue ?? typed ?? formatted}
					className={cn(inputBaseClassName, "h-11 pe-12 disabled:bg-sunken disabled:text-ink-2 disabled:opacity-100")}
					onClick={() => {
						setCalendarYear(selectedYear);
						setOpen(true);
					}}
					onKeyDown={(event) => {
						// The trigger's preceding focus guard exits the popup backwards.
						// Enter the trigger directly when tabbing forward from this alternate opener.
						if (event.key === "Tab" && !event.shiftKey && open) {
							event.preventDefault();
							triggerRef.current?.focus();
						}
						if (event.key === "Escape" && open) {
							event.stopPropagation();
							setOpen(false);
						}
					}}
					onChange={(event) => {
						setOpen(false);
						const normalized = normalizeNumericDigits(event.target.value);
						setTyped(normalized);
						const next = readTypedDate(normalized, locale);
						setInvalid(next === undefined);
						onInvalid(next === undefined);
						if (next !== undefined && next !== value) onCommit(next);
					}}
					onBlur={() => {
						if (typed === null) return;
						const next = readTypedDate(typed, locale);
						setInvalid(next === undefined);
						onInvalid(next === undefined);
						if (next !== undefined) setTyped(null);
					}}
				/>
				<PopoverTrigger
					id={triggerId}
					ref={triggerRef}
					render={
						<Button
							variant="ghost"
							size="icon-lg"
							className="absolute inset-e-0 top-0"
							aria-label={t`Choose a date.`}
							disabled={disabled}
						>
							<Icon name="calendar-dots" />
						</Button>
					}
				/>
				<PopoverContent ref={popupRef} className="w-72" aria-label={label} initialFocus={false}>
					<NativeSelect
						aria-label={label}
						value={calendarYear}
						onChange={(event) => setCalendarYear(Number(event.target.value))}
					>
						{years.map((year) => (
							<option key={year} value={year}>
								{year}
							</option>
						))}
					</NativeSelect>
					<div className="grid grid-cols-3 gap-1">
						{months.map(({ value: month, label: monthLabel }) => (
							<Button
								key={month}
								variant={value === `${calendarYear}-${String(month + 1).padStart(2, "0")}` ? "secondary" : "ghost"}
								size="calendar-date"
								onClick={() => chooseMonth(month)}
							>
								{monthLabel}
							</Button>
						))}
					</div>
				</PopoverContent>
			</Popover>
		</div>
	);
}
