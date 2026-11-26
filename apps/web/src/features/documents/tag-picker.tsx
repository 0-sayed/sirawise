import type { TagCount, TagLimitError } from "./tag-selection";
import type { KeyboardEvent } from "react";
import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import { useId, useRef, useState } from "react";
import { Badge } from "@reactive-resume/ui/components/badge";
import { Checkbox } from "@reactive-resume/ui/components/checkbox";
import { Chip } from "@reactive-resume/ui/components/chip";
import {
	Command,
	CommandEmpty,
	CommandGroup,
	CommandInput,
	CommandItem,
	CommandList,
	CommandShortcut,
} from "@reactive-resume/ui/components/command";
import { FieldError } from "@reactive-resume/ui/components/field-error";
import { Icon } from "@reactive-resume/ui/components/icon";
import { IconButton } from "@reactive-resume/ui/components/icon-button";
import { documentTagKey, documentTagMaxCount, documentTagMaxLength } from "@reactive-resume/utils/ui-format";
import { isImeComposing } from "@/libs/keyboard";

export type TagSelectionAction = "toggle" | "add" | "remove";

type TagPickerProps = {
	options: { matches: TagCount[]; exact: string | null; create: string | null };
	selected: readonly TagCount[];
	targetCount: number;
	largestTagCount: number;
	draft: string;
	draftLength: number;
	error: TagLimitError | null;
	disabled: boolean;
	onDraftChange: (value: string, composing: boolean) => void;
	onSelect: (tag: string, action: TagSelectionAction) => void;
};

const optionValue = (tag: string) => `tag:${documentTagKey(tag)}`;

export function TagPicker({
	options,
	selected,
	targetCount,
	largestTagCount,
	draft,
	draftLength,
	error,
	disabled,
	onDraftChange,
	onSelect,
}: TagPickerProps) {
	const errorId = useId();
	const [active, setActive] = useState("");
	const navigated = useRef(false);
	const composing = useRef(false);
	const placeholder = t`Search or create a tag…`;
	const limitMessage =
		error === "length"
			? t`Tag must be 40 characters or fewer.`
			: error === "count"
				? t`Up to 20 tags per document.`
				: null;
	const selectedCounts = new Map(selected.map(({ tag, count }) => [documentTagKey(tag), count]));
	const { matches, exact, create } = options;

	function select(tag: string, action: TagSelectionAction = "toggle") {
		navigated.current = false;
		onSelect(tag, action);
	}

	function onKeyDown(event: KeyboardEvent<HTMLInputElement>) {
		if (isImeComposing(event) || composing.current) return;
		if (["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) navigated.current = true;
		if (event.key !== "Enter" && event.key !== "," && event.key !== "،") return;
		event.preventDefault();
		// cmdk highlights its first row automatically. Use it after deliberate arrow navigation.
		const highlighted = navigated.current
			? active === "create"
				? create
				: matches.find(({ tag }) => optionValue(tag) === active)?.tag
			: null;
		const tag = exact ?? create;
		if (highlighted) select(highlighted);
		else if (tag && draft.trim()) select(tag, "add");
	}

	return (
		<div className="grid min-w-0 gap-2">
			{selected.length > 0 && (
				<div className="flex flex-wrap gap-2">
					{selected.map(({ tag, count }) => (
						<Chip key={documentTagKey(tag)}>
							<bdi dir="auto" className="min-w-0 wrap-anywhere">
								{tag}
							</bdi>
							{count < targetCount && (
								<Badge variant="outline">
									<bdi dir="ltr" className="tabular-nums">
										{count}/{targetCount}
									</bdi>
								</Badge>
							)}
							<IconButton
								icon="x"
								label={t`Remove tag ${tag}`}
								size="icon-chip"
								variant="quiet"
								className="shrink-0"
								disabled={disabled}
								onClick={() => onSelect(tag, "remove")}
							/>
						</Chip>
					))}
				</div>
			)}
			{largestTagCount >= 15 && (
				<bdi dir="ltr" className="justify-self-end type-metadata text-ink-3 tabular-nums">
					{largestTagCount}/{documentTagMaxCount}
				</bdi>
			)}
			<Command
				shouldFilter={false}
				vimBindings={false}
				value={active}
				onValueChange={setActive}
				label={placeholder}
				className="rounded-lg border border-line-2 focus-within:border-accent"
			>
				<CommandInput
					placeholder={placeholder}
					dir="auto"
					disabled={disabled}
					value={draft}
					onValueChange={(next) => {
						navigated.current = false;
						onDraftChange(next, composing.current);
					}}
					onKeyDown={onKeyDown}
					onCompositionStart={() => {
						composing.current = true;
					}}
					onCompositionEnd={(event) => {
						composing.current = false;
						onDraftChange(event.currentTarget.value, false);
					}}
					aria-invalid={Boolean(error)}
					aria-describedby={error ? errorId : undefined}
					hint={
						draftLength >= 30 && (
							<bdi
								dir="ltr"
								className={`type-metadata tabular-nums ${draftLength > documentTagMaxLength ? "text-danger-text" : "text-ink-3"}`}
							>
								{draftLength}/{documentTagMaxLength}
							</bdi>
						)
					}
				/>
				<CommandList aria-multiselectable="true" label={t`Tags`} fixedHeight>
					{matches.length > 0 && (
						<CommandGroup heading={t`Existing tags`}>
							{matches.map(({ tag, count }) => {
								const appliedCount = selectedCounts.get(documentTagKey(tag)) ?? 0;
								const checked = appliedCount > 0 && appliedCount === targetCount;
								const mixed = appliedCount > 0 && !checked;
								return (
									<CommandItem
										key={optionValue(tag)}
										value={optionValue(tag)}
										aria-checked={mixed ? "mixed" : checked}
										disabled={disabled}
										onSelect={() => select(tag)}
									>
										<Checkbox
											aria-hidden="true"
											tabIndex={-1}
											checked={checked}
											indeterminate={mixed}
											className="pointer-events-none"
										/>
										<bdi dir="auto" className="min-w-0 truncate">
											{tag}
										</bdi>
										<CommandShortcut>
											<Badge variant="neutral">
												<bdi dir="ltr" className="tabular-nums">
													{count}
												</bdi>
											</Badge>
										</CommandShortcut>
									</CommandItem>
								);
							})}
						</CommandGroup>
					)}
					{create && (
						<CommandItem value="create" disabled={disabled} onSelect={() => select(create)}>
							<Icon name="plus" />
							<span className="min-w-0 truncate">
								<Trans>
									Create “<bdi dir="auto">{create}</bdi>”
								</Trans>
							</span>
						</CommandItem>
					)}
					<CommandEmpty>
						{draft.trim() ? (
							<Trans>No matching tags.</Trans>
						) : (
							<Trans>No tags yet. Type a name to create your first tag.</Trans>
						)}
					</CommandEmpty>
				</CommandList>
			</Command>
			<FieldError id={errorId} reserveSpace>
				{limitMessage}
			</FieldError>
		</div>
	);
}
