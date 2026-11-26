import type { ReactNode } from "react";
import { useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Button } from "./button";
import { Popover, PopoverContent, PopoverTitle, PopoverTrigger } from "./popover";

type TourStep = { targetId: string; title: ReactNode; description: ReactNode };
type TourLabels = {
	start: string;
	back: string;
	next: string;
	skip: string;
	done: string;
	step: (current: number, total: number) => string;
};

function readSeen(key: string | null) {
	try {
		return key !== null && localStorage.getItem(key) === "seen";
	} catch {
		return false;
	}
}

type GuidedTourProps = {
	tourId: string;
	userId?: string;
	steps: TourStep[];
	labels: TourLabels;
};

/** Optional, replayable guidance anchored to the actual controls; never performs their actions. */
export function GuidedTour(props: GuidedTourProps) {
	return <GuidedTourContent key={`${props.userId ?? ""}:${props.tourId}`} {...props} />;
}

function GuidedTourContent({ tourId, userId, steps, labels }: GuidedTourProps) {
	const storageKey = userId ? `sirawise:guided-tour:${encodeURIComponent(userId)}:${tourId}` : null;
	const [seen, setSeen] = useState(() => readSeen(storageKey));
	const [index, setIndex] = useState<number | null>(null);
	const trigger = useRef<HTMLButtonElement>(null);
	const heading = useRef<HTMLHeadingElement>(null);
	const [target, setTarget] = useState<HTMLElement | null>(null);
	const [bounds, setBounds] = useState<DOMRect | null>(null);
	const [direction, setDirection] = useState<"rtl" | "ltr">("ltr");
	const descriptionId = useId();
	const step = index === null ? undefined : steps[index];

	useEffect(() => {
		if (!target) return;
		const measure = () => {
			if (!target.isConnected) {
				setIndex(null);
				return;
			}
			setBounds(target.getBoundingClientRect());
		};
		const observer = new ResizeObserver(measure);
		observer.observe(target);
		window.addEventListener("resize", measure);
		document.addEventListener("scroll", measure, true);
		return () => {
			observer.disconnect();
			window.removeEventListener("resize", measure);
			document.removeEventListener("scroll", measure, true);
		};
	}, [target]);
	useEffect(() => {
		if (index !== null && target) heading.current?.focus();
	}, [index, target]);

	function finish() {
		setIndex(null);
		setTarget(null);
		setSeen(true);
		try {
			if (storageKey) localStorage.setItem(storageKey, "seen");
		} catch {
			/* Guidance remains usable when browser storage is blocked. */
		}
	}
	function goTo(nextIndex: number) {
		const nextStep = steps[nextIndex];
		const element = nextStep ? document.getElementById(nextStep.targetId) : null;
		if (!element) {
			setIndex(null);
			setTarget(null);
			return;
		}
		// Immediate scrolling also honors reduced motion without introducing a second motion system.
		element.scrollIntoView?.({ block: "nearest", behavior: "instant" });
		setTarget(element);
		setBounds(element.getBoundingClientRect());
		setIndex(nextIndex);
	}
	const progress = index === null ? "" : labels.step(index + 1, steps.length);
	return (
		<Popover
			open={Boolean(step && target)}
			onOpenChange={(open, details) => {
				if (open) {
					setDirection(trigger.current?.closest("[dir]")?.getAttribute("dir") === "rtl" ? "rtl" : "ltr");
					goTo(0);
				} else if (details.reason === "focus-out" || details.reason === "outside-press") {
					// Users can try the highlighted control without losing their place.
					details.cancel();
				} else finish();
			}}
		>
			<PopoverTrigger
				ref={trigger}
				data-seen={seen}
				disabled={steps.length === 0}
				render={<Button variant="secondary" />}
			>
				{labels.start}
			</PopoverTrigger>
			{step &&
				target &&
				bounds &&
				createPortal(
					<div
						dir={direction}
						aria-hidden="true"
						className="pointer-events-none fixed inset-0 z-40"
						data-slot="guided-tour-spotlight"
						data-target={step.targetId}
					>
						<div className="absolute inset-x-0 top-0 bg-scrim" style={{ height: Math.max(0, bounds.top) }} />
						<div className="absolute inset-x-0 bottom-0 bg-scrim" style={{ top: Math.max(0, bounds.bottom) }} />
						<div
							className="absolute start-0 bg-scrim"
							style={{
								top: bounds.top,
								height: bounds.height,
								width: direction === "rtl" ? Math.max(0, window.innerWidth - bounds.right) : Math.max(0, bounds.left),
							}}
						/>
						<div
							className="absolute end-0 bg-scrim"
							style={{
								top: bounds.top,
								height: bounds.height,
								width: direction === "rtl" ? Math.max(0, bounds.left) : Math.max(0, window.innerWidth - bounds.right),
							}}
						/>
						<div
							className="absolute rounded-lg ring-2 ring-accent"
							style={{ top: bounds.top, left: bounds.left, width: bounds.width, height: bounds.height }}
						/>
					</div>,
					document.body,
				)}
			{step && target && (
				<PopoverContent
					anchor={target}
					dir={direction}
					align="start"
					initialFocus={heading}
					finalFocus={trigger}
					aria-describedby={descriptionId}
					className="max-w-[calc(100vw-var(--spacing)*8)] motion-reduce:transition-none"
				>
					<PopoverTitle ref={heading} tabIndex={-1} render={<h3>{step.title}</h3>} />
					<p id={descriptionId} className="type-body text-ink-2">
						{step.description}
					</p>
					<p role="status" aria-live="polite" aria-atomic="true" className="type-meta text-ink-2">
						{progress}
					</p>
					<div className="flex flex-wrap items-center justify-end gap-2">
						<Button variant="ghost" onClick={finish}>
							{labels.skip}
						</Button>
						<Button
							variant="secondary"
							disabled={index === 0}
							onClick={() => {
								if (index !== null) goTo(Math.max(0, index - 1));
							}}
						>
							{labels.back}
						</Button>
						<Button
							onClick={() => {
								if (index === steps.length - 1) finish();
								else if (index !== null) goTo(index + 1);
							}}
						>
							{index === steps.length - 1 ? labels.done : labels.next}
						</Button>
					</div>
				</PopoverContent>
			)}
		</Popover>
	);
}
