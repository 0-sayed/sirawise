import { afterEach, expect, it, vi } from "vite-plus/test";
import { loadUiFonts } from "./ui-fonts";

afterEach(() => vi.unstubAllGlobals());

it("waits for all real Arabic weights before completing", async () => {
	let release = () => {};
	const pending = new Promise<void>((resolve) => {
		release = resolve;
	});
	const requests: string[] = [];
	vi.stubGlobal("document", {
		fonts: {
			load: (face: string) => {
				requests.push(face);
				return pending;
			},
		},
	});
	let complete = false;
	const loading = loadUiFonts("ar-SA").then(() => {
		complete = true;
	});
	await Promise.resolve();
	expect(complete).toBe(false);
	expect(requests).toEqual([
		'400 16px "Noto Sans Arabic"',
		'500 16px "Noto Sans Arabic"',
		'600 16px "Noto Sans Arabic"',
		'700 16px "Noto Sans Arabic"',
		'400 16px "Noto Sans"',
		'500 16px "Noto Sans"',
		'600 16px "Noto Sans"',
		'700 16px "Noto Sans"',
		'500 32px "Noto Serif"',
	]);
	release();
	await loading;
	expect(complete).toBe(true);
});

it("a failed font download preserves account access with the browser fallback", async () => {
	vi.stubGlobal("document", { fonts: { load: () => Promise.reject(new Error("Offline")) } });
	const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
	await expect(loadUiFonts("ar-SA")).resolves.toBeUndefined();
	expect(warning).toHaveBeenCalledWith("UI fonts could not load; using the browser fallback.");
	warning.mockRestore();
});

it("declares and preloads the bundled Arabic bold face", async () => {
	const { readFile } = await import("node:fs/promises");
	const css = await readFile("src/index.css", "utf8");
	const html = await readFile("index.html", "utf8");
	const face = css.match(/@font-face\s*\{[^}]*font-weight:\s*700;[^}]*\}/)?.[0];
	expect(face).toContain('font-family: "Noto Sans Arabic"');
	expect(face).toContain("NotoSansArabic-Bold.ttf");
	expect(html).toContain('href="/fonts/noto-sans-arabic/2.009/NotoSansArabic-Bold.ttf"');
	const bytes = await readFile("public/fonts/noto-sans-arabic/2.009/NotoSansArabic-Bold.ttf");
	expect(bytes.byteLength).toBeGreaterThan(0);
});
