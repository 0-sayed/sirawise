import type { ReviewEditFeedback } from "./edit-highlight";
import type { PageMap, PageMapTarget } from "@reactive-resume/pdf/page-map";
import { useReducedMotion } from "motion/react";
import { useEffect, useRef, useState } from "react";
import { isSameSelection } from "../editor/store";
import { D3, REVIEW_HIGHLIGHT_MS } from "@/libs/motion";

type EditHighlightsProps = {
	pageIndex: number;
	pageMap: PageMap | undefined;
	targets: PageMapTarget[];
	feedback?: Pick<ReviewEditFeedback, "id" | "action" | "startedAt"> | undefined;
};

/** Screen-only feedback over the acknowledged PDF's semantic blocks; never alters document layout. */
export function EditHighlights({ pageIndex, pageMap, targets, feedback }: EditHighlightsProps) {
	const reduced = useReducedMotion();
	const first = useRef<HTMLSpanElement>(null);
	const [visible, setVisible] = useState(!feedback || Boolean(reduced));
	const nodes = pageMap?.nodes.filter((node) =>
		targets.some((target) =>
			isSameSelection(
				node.kind === "item"
					? { kind: "item", sectionId: node.sectionId, itemId: node.itemId }
					: node.kind === "section"
						? { kind: "section", sectionId: node.sectionId }
						: { kind: "header" },
				target,
			),
		),
	);
	const page = pageMap?.pages[pageIndex];
	const hasTarget = Boolean(
		page && page.width > 0 && page.height > 0 && nodes?.some((node) => node.page === pageIndex),
	);
	useEffect(() => {
		if (!feedback || !hasTarget) return;
		const delay = reduced ? 0 : Math.max(0, D3 * 1000 - (Date.now() - feedback.startedAt));
		let clear: number | undefined;
		const show = window.setTimeout(() => {
			setVisible(true);
			clear = window.setTimeout(() => setVisible(false), REVIEW_HIGHLIGHT_MS);
		}, delay);
		return () => {
			window.clearTimeout(show);
			window.clearTimeout(clear);
		};
	}, [feedback, hasTarget, reduced]);
	const firstPage = nodes?.[0]?.page;
	useEffect(() => {
		if (!visible || !feedback || pageIndex !== firstPage) return;
		const block = first.current;
		const scroller = block?.closest<HTMLElement>('[data-slot="preview-scroll-area"]');
		if (!block || !scroller) return;
		const box = block.getBoundingClientRect();
		const viewport = scroller.getBoundingClientRect();
		if (box.top < viewport.top || box.bottom > viewport.bottom) {
			// Only scroll the canvas: keep the review card and its Undo control in place.
			scroller.scrollTo({
				top: scroller.scrollTop + box.top - viewport.top - (viewport.height - box.height) / 2,
				behavior: reduced ? "instant" : "smooth",
			});
		}
	}, [visible, feedback, pageIndex, firstPage, reduced]);
	if (!visible || !page || !hasTarget) return null;
	return (
		<div aria-hidden="true" className="pointer-events-none absolute inset-0">
			{nodes
				?.filter((node) => node.page === pageIndex)
				.map((node, index) => (
					<span
						ref={index === 0 ? first : undefined}
						key={`${node.key}:${node.y}`}
						data-slot="preview-edit-highlight"
						data-section-id={node.kind === "header" ? "header" : node.sectionId}
						data-item-id={node.kind === "item" ? node.itemId : undefined}
						data-review-action={feedback?.action}
						data-motion={reduced ? "static" : "animated"}
						className="preview-edit-highlight"
						style={{
							left: `${(node.x / page.width) * 100}%`,
							top: `${(node.y / page.height) * 100}%`,
							width: `${(node.width / page.width) * 100}%`,
							height: `${(node.height / page.height) * 100}%`,
						}}
					/>
				))}
		</div>
	);
}
