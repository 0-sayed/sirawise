import type { ReactNode } from "react";
import { useEffect, useRef } from "react";
import { cn } from "@reactive-resume/utils/style";
import { ActionGroup } from "./action-group";

export function StickyActions({
	children,
	actions,
	hint,
	header,
}: {
	children: ReactNode;
	actions: ReactNode;
	hint?: ReactNode;
	header?: ReactNode;
}) {
	const container = useRef<HTMLDivElement>(null);
	const bar = useRef<HTMLElement>(null);
	useEffect(() => {
		const element = bar.current;
		if (!element || !container.current || typeof ResizeObserver === "undefined") return;
		const layout = container.current;
		const measure = () => layout.style.setProperty("--sticky-actions-size", `${element.offsetHeight}px`);
		measure();
		const observer = new ResizeObserver(measure);
		observer.observe(element);
		return () => observer.disconnect();
	}, []);
	return (
		<div
			ref={container}
			className={cn("grid min-w-0 gap-4", header && "lg:grid-cols-[minmax(0,1fr)_auto] lg:items-start")}
		>
			{header && <div className="min-w-0">{header}</div>}
			<div
				data-slot="sticky-actions-content"
				className={cn("grid min-w-0 gap-4 pb-(--sticky-actions-size)", header && "lg:col-span-full lg:pb-0")}
			>
				{children}
			</div>
			<footer
				ref={bar}
				data-slot="sticky-actions"
				className={cn(
					"sticky bottom-0 z-10 grid gap-2 border-t border-line bg-surface px-3 py-2",
					header && "lg:static lg:col-start-2 lg:row-start-1 lg:border-0 lg:bg-transparent lg:p-0",
				)}
			>
				{hint}
				<ActionGroup>{actions}</ActionGroup>
			</footer>
		</div>
	);
}
