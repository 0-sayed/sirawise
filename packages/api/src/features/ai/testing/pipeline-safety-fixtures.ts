import { readFileSync } from "node:fs";

type SafetyLabel = {
	id: string;
	mode: "deterministic" | "semantic";
	caught: Array<{ itemId: string; issueClass: string; stage: "deterministic" | "semantic" }>;
	retainedIds: string[];
};

export function loadSafetyCases<T>(suite: "extraction" | "job-evidence" | "translation") {
	const root = new URL("../../../../../../tooling/evaluations/review/pipeline-safety/", import.meta.url);
	return {
		inputs: JSON.parse(readFileSync(new URL(`fixtures/${suite}.json`, root), "utf8")) as T[],
		labels: JSON.parse(readFileSync(new URL(`expected/${suite}.json`, root), "utf8")) as SafetyLabel[],
	};
}
