import type { ExtractedDocument, PdfAnalysisCoverage, PdfCheckResult, RawExtraction } from "./types";
import { buildExtractedDocument } from "./extract";

export function pdfTextCoverage(raw: RawExtraction, document: ExtractedDocument) {
	const ambiguous = new Set(
		document.pages
			.filter((page) => page.lines.some((line) => line.logical?.recovery === "ambiguous"))
			.map((page) => page.pageNumber),
	);
	const pages = (raw.coverage?.pages ?? []).map((page) =>
		page.text === "complete" && ambiguous.has(page.pageNumber) ? { ...page, text: "partial" as const } : page,
	);
	return {
		pages,
		partial: raw.truncated || pages.some((page) => page.text !== "complete") || ambiguous.size > 0,
		reasons: [...ambiguous].map((pageNumber) => `page-${pageNumber}-text-order-ambiguous`),
	};
}

/** Coverage is independent of score: no findings never proves every check ran. */
export function summarizePdfCoverage(
	raw: RawExtraction,
	checks: readonly PdfCheckResult[],
	document = buildExtractedDocument(raw),
): PdfAnalysisCoverage {
	const textCoverage = pdfTextCoverage(raw, document);
	const reasons = [...(raw.coverage?.reasons ?? []), ...textCoverage.reasons];
	if (!raw.coverage) reasons.push("coverage-unknown");
	if (raw.truncated) reasons.push("pages-truncated");
	const pages = textCoverage.pages;
	const validPages = (values: readonly { pageNumber: number }[]) =>
		values.length === raw.pageCount &&
		new Set(values.map((page) => page.pageNumber)).size === raw.pageCount &&
		values.every(
			(page) => Number.isInteger(page.pageNumber) && page.pageNumber >= 1 && page.pageNumber <= raw.pageCount,
		);
	if (!validPages(pages) || !validPages(raw.pages)) reasons.push("pages-missing");
	for (const page of pages)
		for (const key of ["text", "annotations", "operators"] as const)
			if (page[key] !== "complete") reasons.push(`page-${page.pageNumber}-${key}-${page[key]}`);
	for (const check of checks)
		if (
			check.status === "skip" &&
			(check.skipReason === "execution-failed" ||
				check.skipReason === "no-operators" ||
				check.skipReason === "encrypted")
		)
			reasons.push(`check-${check.code}-${check.skipReason}`);
	const unique = [...new Set(reasons)];
	const readablePages = new Set(
		raw.pages
			.filter((page) => page.items.some((item) => (item.glyphText ?? item.str).trim()))
			.map((page) => page.pageNumber),
	);
	const hasText = readablePages.size > 0;
	const noSuccessfulText =
		!!raw.coverage &&
		!pages.some((page) => page.text === "complete" || (page.text === "partial" && readablePages.has(page.pageNumber)));
	return {
		status: !hasText || noSuccessfulText ? "failed" : unique.length ? "partial" : "complete",
		reasons: !hasText ? [...unique, "no-usable-text"] : unique,
	};
}
