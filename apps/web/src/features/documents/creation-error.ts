import { getAllowanceFailure, getAllowanceModel, getAllowanceReason } from "@/features/usage/allowance-limit";
export function isBaseCvLimit(error: unknown): boolean {
	return getCreationLimit(error) === "BASE_CV_LIMIT";
}

function getCreationLimit(error: unknown): "BASE_CV_LIMIT" | "LANGUAGE_COPY_LIMIT" | "JOB_COPY_LIMIT" | null {
	const reason = getAllowanceReason(error);
	return reason === "BASE_CV_LIMIT" || reason === "LANGUAGE_COPY_LIMIT" || reason === "JOB_COPY_LIMIT" ? reason : null;
}
export const baseCvLimitMessage = (error?: unknown) => {
	const model = getAllowanceModel("BASE_CV_LIMIT", undefined, getAllowanceFailure(error)?.allowance);
	return `${model.description} ${model.nextStep}`;
};
