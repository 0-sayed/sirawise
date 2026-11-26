import { settleScreen } from "../fixtures/screen";
import { expect, test } from "../fixtures/test";

type CanvasFrame = { time: number; path: string; x: number; width: number; controlsX: number };
type CanvasWindow = typeof globalThis & { canvasFrames: CanvasFrame[]; sampleCanvas: boolean };

for (const locale of ["ar-SA", "en-US"] as const) {
	for (const width of [1912, 1440, 390]) {
		test(`${locale} ${width}: documents keep their canvas until the editor renders`, async ({
			authPage: page,
			baseURL,
		}, info) => {
			if (!baseURL) throw new Error("Browser baseURL missing");
			await page.setViewportSize({ width, height: 900 });
			const created = await page.request.post("/api/openapi/resumes", {
				data: { name: "Synthetic navigation CV", tags: [], withSampleData: true },
			});
			await expect(created).toBeOK();
			const resumeId = (await created.json()) as string;
			await expect(
				await page.request.post("/api/auth/update-user", { headers: { origin: baseURL }, data: { uiLocale: locale } }),
			).toBeOK();
			await page.context().addCookies([{ name: "locale", value: locale, url: baseURL }]);
			await page.goto("/dashboard");
			await settleScreen(page);
			const card = page.locator(`a[href="/builder/${resumeId}"]`).first();
			await expect(card).toBeVisible();
			let release = () => {};
			const editorGate = new Promise<void>((resolve) => {
				release = resolve;
			});
			await page.route("**/api/rpc/resume/getById**", async (route) => {
				await editorGate;
				await route.continue();
			});
			await page.evaluate(() => {
				const audit = globalThis as CanvasWindow;
				audit.canvasFrames = [];
				audit.sampleCanvas = true;
				const sample = (time: number) => {
					const content = document.querySelector('[data-slot="dashboard-content"]');
					const controls = document.querySelector('[data-slot="dashboard-header-controls"]');
					if (content && controls) {
						const box = content.getBoundingClientRect();
						audit.canvasFrames.push({
							time,
							path: location.pathname,
							x: box.x,
							width: box.width,
							controlsX: controls.getBoundingClientRect().x,
						});
					}
					if (audit.sampleCanvas) requestAnimationFrame(sample);
				};
				requestAnimationFrame(sample);
			});
			try {
				await card.click();
				await page.waitForFunction(() => {
					const frames = (globalThis as CanvasWindow).canvasFrames;
					const firstPending = frames.find((frame) => frame.path.startsWith("/builder/"));
					const last = frames.at(-1);
					return firstPending && last && last.time - firstPending.time >= 500;
				});
			} finally {
				release();
			}
			await expect(page.getByRole("button", { name: /^(Download PDF|تنزيل PDF)$/u })).toBeVisible();
			const frames = await page.evaluate(() => {
				const audit = globalThis as CanvasWindow;
				audit.sampleCanvas = false;
				return audit.canvasFrames;
			});
			await info.attach("navigation-canvas-frames", { body: JSON.stringify(frames), contentType: "application/json" });
			const first = frames[0];
			if (!first) throw new Error("No dashboard frames sampled");
			expect(frames.some((frame) => frame.path.startsWith("/builder/"))).toBe(true);
			for (const frame of frames) {
				expect(Math.abs(frame.x - first.x), JSON.stringify(frame)).toBeLessThan(1);
				expect(Math.abs(frame.width - first.width), JSON.stringify(frame)).toBeLessThan(1);
				expect(Math.abs(frame.controlsX - first.controlsX), JSON.stringify(frame)).toBeLessThan(1);
			}
		});
	}
}
