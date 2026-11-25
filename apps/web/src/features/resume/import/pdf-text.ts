import { pdfImportText } from "@reactive-resume/import/pdf-lines";
import { PDF_IMPORT_OPERATOR_BUDGET_MS } from "@reactive-resume/resume/ats-pdf";
import { extractPdf } from "@/features/ats-checker/extract-client";

export { documentToLines } from "@reactive-resume/import/pdf-lines";

export async function extractPdfText(file: File, signal?: AbortSignal) {
	const raw = await extractPdf(file, {
		operatorBudgetMs: PDF_IMPORT_OPERATOR_BUDGET_MS,
		...(signal ? { signal } : {}),
	});
	return pdfImportText(raw, { allowPartial: true });
}
