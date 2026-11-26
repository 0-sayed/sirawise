import { setImmediate } from "node:timers/promises";
import { afterEach, expect, it, vi } from "vite-plus/test";
const work = vi.hoisted(() => ({
	discover: vi.fn(),
	reconcile: vi.fn(),
	claim: vi.fn(),
	lease: vi.fn(),
	failed: vi.fn(),
}));
vi.mock("./operations", () => ({
	discoverAiOwners: work.discover,
	reconcileExpiredAccounting: work.reconcile,
	claimNextOperation: work.claim,
	withOperationLease: work.lease,
	failOperation: work.failed,
	heartbeatOperation: vi.fn(),
	assertSourceRevisions: vi.fn(),
	deliverOperation: vi.fn(),
	operationRequest: vi.fn(),
	MAX_TRANSLATION_CONCURRENT_PARTS: 6,
}));
import { runAiOperations } from "./operation-worker";
afterEach(() => vi.resetAllMocks());
it("starts all admitted owners concurrently and drains every active lease on shutdown", async () => {
	const owners = Array.from({ length: 100 }, (_, i) => `owner-${i}`);
	work.discover.mockResolvedValue(owners);
	work.reconcile.mockResolvedValue(undefined);
	const claimedOwners = new Set<string>();
	work.claim.mockImplementation(async (ownerId: string) => {
		if (claimedOwners.has(ownerId)) return null;
		claimedOwners.add(ownerId);
		return { ownerId, operationId: ownerId, token: ownerId };
	});
	const pending: Array<() => void> = [];
	work.lease.mockImplementation(
		() => new Promise((_resolve, reject) => pending.push(() => reject(new Error("Synthetic lease finished")))),
	);
	work.failed.mockResolvedValue(undefined);
	const controller = new AbortController();
	let drained = false;
	const running = runAiOperations(controller.signal).then(() => {
		drained = true;
	});
	try {
		await vi.waitFor(() => expect(pending).toHaveLength(100));
		controller.abort();
		expect(drained).toBe(false);
	} finally {
		controller.abort();
		for (const finish of pending) finish();
		await running;
	}
	expect(drained).toBe(true);
	expect(work.failed).toHaveBeenCalledTimes(100);
	expect(claimedOwners).toEqual(new Set(owners));
});

it("drains other leases before reporting a failed claim", async () => {
	work.discover.mockResolvedValue(["unavailable-owner", "active-owner"]);
	work.reconcile.mockResolvedValue(undefined);
	const claimed = new Set<string>();
	work.claim.mockImplementation(async (ownerId: string) => {
		if (claimed.has(ownerId)) return null;
		claimed.add(ownerId);
		if (ownerId === "unavailable-owner") throw new Error("Synthetic claim failure");
		return { ownerId, operationId: ownerId, token: ownerId };
	});
	let finish: () => void = () => undefined;
	work.lease.mockImplementation(
		() =>
			new Promise((_resolve, reject) => {
				finish = () => reject(new Error("Synthetic lease finished"));
			}),
	);
	work.failed.mockResolvedValue(undefined);
	let settled = false;
	const running = runAiOperations(undefined, 2).catch((error: unknown) => {
		settled = true;
		return error;
	});
	try {
		await vi.waitFor(() => expect(work.lease).toHaveBeenCalledTimes(1));
		expect(settled).toBe(false);
	} finally {
		finish();
	}
	const error = await running;
	expect(error).toBeInstanceOf(AggregateError);
	expect((error as AggregateError).errors).toEqual([new Error("Synthetic claim failure")]);
	expect(work.failed).toHaveBeenCalledTimes(1);
});

it("rescans if the last active lease finishes during a scan for waiting work", async () => {
	const activeLease = Promise.withResolvers<never>();
	work.discover.mockResolvedValue(["active-owner", "waiting-owner"]);
	work.reconcile.mockResolvedValue(undefined);
	work.claim
		.mockResolvedValueOnce({ ownerId: "active-owner", operationId: "active", token: "active" })
		.mockResolvedValueOnce(null)
		.mockResolvedValueOnce(null)
		.mockResolvedValueOnce(null)
		.mockImplementationOnce(async () => {
			activeLease.reject(new Error("Synthetic active lease finished"));
			await setImmediate();
			return null;
		})
		.mockResolvedValueOnce(null)
		.mockResolvedValueOnce({ ownerId: "waiting-owner", operationId: "waiting", token: "waiting" })
		.mockResolvedValue(null);
	work.lease.mockReturnValueOnce(activeLease.promise).mockRejectedValueOnce(new Error("Synthetic waiter finished"));
	work.failed.mockResolvedValue(undefined);
	await runAiOperations(undefined, 2);
	expect(work.lease).toHaveBeenCalledTimes(2);
});
