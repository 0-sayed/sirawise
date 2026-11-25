import { expect, it } from "vite-plus/test";
import { fitVerificationWave } from "./attempt-budget";

it("fits a prefix of physical calls within the remaining reservation and concurrency", () => {
	expect(fitVerificationWave(200_000, 9_000, [100_000, 100_000], 5)).toBe(1);
	expect(fitVerificationWave(200_000, 109_000, [100_000], 5)).toBe(0);
	expect(fitVerificationWave(200_000, 100_000, Array(5).fill(20_000), 5)).toBe(5);
	expect(fitVerificationWave(200_000, 20_000, [40_000, 50_000, 100_000, 5_000], 5)).toBe(2);
	expect(fitVerificationWave(200_000, 20_000, [40_000, 50_000, 10_000], 1)).toBe(1);
});
