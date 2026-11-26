import type { OperationRequest, SourceRevision } from "@reactive-resume/schema/ai-operation";
import { expect, it } from "vite-plus/test";
import { assertOperationConcurrency } from "./concurrency";

const request = (id: string, kind: SourceRevision["kind"] = "resume"): OperationRequest => ({
	requestKey: "request",
	kind: "review",
	parameters: {},
	sources: [{ kind, id, revision: "1" }],
	route: { routeId: "synthetic", routeRevision: "1", configRevision: "1" },
	consentVersion: "1",
});
const active = (id: string, target = id) => ({ ...request(target), id });
it("admits different CVs until three logical operations are active", () => {
	for (const count of [0, 1, 2])
		expect(() =>
			assertOperationConcurrency(
				request("new"),
				Array.from({ length: count }, (_, i) => active(String(i))),
			),
		).not.toThrow();
	expect(() => assertOperationConcurrency(request("new"), [active("a"), active("b"), active("c")])).toThrowError(
		expect.objectContaining({
			data: { reason: "AI_CONCURRENCY_LIMIT", allowance: { limit: 3, used: 0, reserved: 3, remaining: 0 } },
		}),
	);
});
it.each(["resume", "cover-letter", "import"] as const)(
	"denies the same %s regardless of request key or revision",
	(kind) => {
		const previous = { ...request("same", kind), id: "previous" };
		expect(() =>
			assertOperationConcurrency({ ...request("same", kind), sources: [{ kind, id: "same", revision: "2" }] }, [
				previous,
			]),
		).toThrowError(expect.objectContaining({ data: { reason: "AI_TARGET_BUSY" } }));
	},
);
it("locks a letter rather than its shared source CV and job", () => {
	const previous = {
		...active("first"),
		sources: [...request("cv").sources, ...request("letter-a", "cover-letter").sources],
	};
	expect(() =>
		assertOperationConcurrency(
			{ ...request("cv"), sources: [...request("cv").sources, ...request("letter-b", "cover-letter").sources] },
			[previous],
		),
	).not.toThrow();
});
it("uses the target CV rather than the shared original for language copies", () => {
	const previous = {
		...active("first"),
		parameters: { resumeId: "copy-a" },
		sources: [...request("copy-a").sources, ...request("base").sources],
	};
	expect(() =>
		assertOperationConcurrency(
			{
				...request("copy-b"),
				parameters: { resumeId: "copy-b" },
				sources: [...request("copy-b").sources, ...request("base").sources],
			},
			[previous],
		),
	).not.toThrow();
});
it("keeps the requested CV as the target when the request also lists a letter", () => {
	const original = request("cv");
	const wording = {
		...original,
		kind: "review.wording",
		parameters: { resumeId: "cv" },
		sources: [...original.sources, ...request("letter", "cover-letter").sources],
	};
	expect(() => assertOperationConcurrency(wording, [active("first", "cv")])).toThrowError(
		expect.objectContaining({ data: { reason: "AI_TARGET_BUSY" } }),
	);
});
it("uses the same target for separately staged selections of one import flow", () => {
	const existing = { ...request("selection-a", "import"), id: "existing" };
	const importFlows = new Map([
		["selection-a", "flow-a"],
		["selection-b", "flow-a"],
		["selection-c", "flow-b"],
	]);
	expect(() => assertOperationConcurrency(request("selection-b", "import"), [existing], { importFlows })).toThrowError(
		expect.objectContaining({ data: { reason: "AI_TARGET_BUSY" } }),
	);
	expect(() => assertOperationConcurrency(request("selection-c", "import"), [existing], { importFlows })).not.toThrow();
});
it("counts six translation parts as one and permits its internal continuation", () => {
	const parts = Array.from({ length: 6 }, (_, i) => ({
		...active(`part-${i}`, "translated"),
		kind: "review.translation",
		parameters: { translationBatch: { rootId: "root" } },
	}));
	expect(() => assertOperationConcurrency(request("other"), parts)).not.toThrow();
	expect(() => assertOperationConcurrency(request("third"), [...parts, active("second")])).not.toThrow();
	expect(() =>
		assertOperationConcurrency(request("fourth"), [...parts, active("second"), active("third")]),
	).toThrowError(
		expect.objectContaining({
			data: { reason: "AI_CONCURRENCY_LIMIT", allowance: { limit: 3, used: 0, reserved: 3, remaining: 0 } },
		}),
	);
	expect(() =>
		assertOperationConcurrency(request("translated"), [...parts, active("second"), active("third")], {
			internalRootId: "root",
		}),
	).not.toThrow();
	expect(() => assertOperationConcurrency(request("translated"), parts)).toThrowError(
		expect.objectContaining({ data: { reason: "AI_TARGET_BUSY" } }),
	);
});
