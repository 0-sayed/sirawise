import type { ComponentProps } from "react";

export function Progress(props: ComponentProps<"progress">) {
	return (
		<progress
			data-slot="progress"
			className="block h-1.5 w-full overflow-hidden rounded-full bg-press accent-accent [&::-moz-progress-bar]:bg-accent [&::-webkit-progress-bar]:bg-press [&::-webkit-progress-value]:bg-accent"
			{...props}
		/>
	);
}
