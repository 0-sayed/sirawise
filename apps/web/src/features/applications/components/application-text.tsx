import type { ComponentPropsWithoutRef } from "react";
import { cn } from "@reactive-resume/utils/style";

export function ApplicationText({
	as: Element = "span",
	className,
	...props
}: Omit<ComponentPropsWithoutRef<"span">, "dir"> & { as?: "span" | "bdi" | "strong" | "p" }) {
	return <Element {...props} dir="auto" className={cn("text-content-start", className)} />;
}

export function ApplicationTextLine({
	value,
	detail,
	truncate,
	className,
}: {
	value: string;
	detail?: string | null;
	truncate?: boolean;
	className?: string;
}) {
	const textClass = truncate ? "truncate" : "wrap-anywhere";
	return (
		<span className={cn("flex min-w-0 items-baseline gap-1", className)}>
			<ApplicationText title={truncate ? value : undefined} className={textClass}>
				{value}
			</ApplicationText>
			{detail && (
				<>
					<span aria-hidden="true">·</span>
					<ApplicationText title={truncate ? detail : undefined} className={textClass}>
						{detail}
					</ApplicationText>
				</>
			)}
		</span>
	);
}
