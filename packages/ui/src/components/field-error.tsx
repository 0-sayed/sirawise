import type { ComponentProps } from "react";
import { cn } from "@reactive-resume/utils/style";
import { Icon } from "./icon";

type FieldErrorProps = ComponentProps<"p"> & { reserveSpace?: boolean };

/** Connect a submitted field error to its control with aria-describedby. */
export function FieldError({ children, className, reserveSpace = false, ...props }: FieldErrorProps) {
	if (!children && !reserveSpace) return null;
	return (
		<p
			role={children ? "alert" : undefined}
			aria-hidden={!children || undefined}
			data-slot="field-error"
			className={cn("flex items-start gap-1 type-metadata text-danger-text", reserveSpace && "min-h-lh", className)}
			{...props}
		>
			{children && (
				<>
					<Icon name="warning-circle" size={16} className="shrink-0" />
					<span>{children}</span>
				</>
			)}
		</p>
	);
}
