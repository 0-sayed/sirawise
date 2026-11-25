import { afterEach, expect, it, vi } from "vite-plus/test";
const mocks = vi.hoisted(() => ({ tx: { select: vi.fn(), update: vi.fn(), execute: vi.fn() }, lockAccount: vi.fn() }));
vi.mock("@reactive-resume/db/owner-scope", () => ({
	withOwnerDatabase: (_ownerId: string, work: (tx: typeof mocks.tx) => unknown) => work(mocks.tx),
}));
vi.mock("@reactive-resume/db/account-state", () => ({ lockAccountForAccounting: mocks.lockAccount }));
vi.mock("../documents/ownership", () => ({ lockDocumentOwner: async () => undefined }));
import { claimNextOperation } from "./operations";
afterEach(() => {
	vi.useRealTimers();
	vi.resetAllMocks();
});
it.each([
	{ state: "queued", test: "starts the execution clock at the first lease claim" },
	{ state: "running", test: "does not extend a recovered lease" },
])("$test", async ({ state }) => {
	vi.useFakeTimers();
	vi.setSystemTime(new Date("2026-11-20T12:00:00Z"));
	const now = Date.now();
	const createdAt = new Date(now - (state === "queued" ? 600000 : 60000));
	const deadlineAt = new Date(createdAt.getTime() + 120000);
	const operation = { id: "operation", state, createdAt, deadlineAt, queueExpiresAt: new Date(now + 30 * 60_000) };
	mocks.lockAccount.mockResolvedValue({ deleting: false });
	mocks.tx.execute
		.mockResolvedValueOnce({ rows: [{ claimed_at_ms: now }] })
		.mockResolvedValueOnce({ rows: [{ allowed: true }] });
	mocks.tx.select
		.mockReturnValueOnce({
			from: () => ({ where: () => ({ orderBy: () => ({ limit: () => ({ for: async () => [operation] }) }) }) }),
		})
		.mockReturnValueOnce({ from: () => ({ where: async () => [] }) });
	const set = vi.fn((_values: Record<string, unknown>) => ({
		where: async () => undefined,
	}));
	mocks.tx.update.mockReturnValue({ set });
	const lease = await claimNextOperation("owner");
	expect(lease).toMatchObject({ ownerId: "owner", operationId: "operation" });
	expect(lease?.token).toEqual(expect.any(String));
	expect(set).toHaveBeenCalledExactlyOnceWith({
		state: "running",
		leaseUntil: new Date(now + 60000),
		leaseToken: lease?.token,
		...(state === "queued" ? { executionStartedAt: new Date(now) } : {}),
	});
});
it("claims nothing for an account pending deletion", async () => {
	mocks.lockAccount.mockResolvedValue({ deleting: true });
	await expect(claimNextOperation("owner")).resolves.toBeNull();
	expect(mocks.tx.select).not.toHaveBeenCalled();
});
