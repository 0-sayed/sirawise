import type { RouterClient } from "@orpc/server";
import type { Page, TestInfo } from "@playwright/test";
import type router from "@reactive-resume/api/routers";
import { createORPCClient } from "@orpc/client";
import { RPCLink } from "@orpc/client/fetch";
import { expect, test } from "@playwright/test";
import { educationItemSchema, projectItemSchema } from "@reactive-resume/schema/resume/data";
import { defaultResumeData } from "@reactive-resume/schema/resume/default";
import { assertSyntheticSession } from "./isolation";
import { seedReview } from "./reviewable-ai";

export async function seedVariantReview(
	page: Page,
	info: TestInfo,
	officialTerm = false,
	documentLocale: "en-US" | "ar-SA" = "en-US",
) {
	const id = await seedReview(page, info);
	const api = variantClient(page);
	const current = await api.resume.getById({ id });
	const data = structuredClone(defaultResumeData);
	const ar = documentLocale === "ar-SA";
	data.basics.name = ar ? "شخص تجريبي" : "Synthetic Person";
	data.basics.headline = ar ? "مهندس" : "Engineer";
	data.summary.hidden = false;
	data.summary.content = ar
		? "<p>بنيت خدمات باستخدام تايب سكريبت. لم أدر ميزانية.</p>"
		: "<p>Built TypeScript services. Did not manage a budget.</p>";
	data.metadata.page.locale = documentLocale;
	data.metadata.layout.pages = [{ fullWidth: false, main: ["summary"], sidebar: [] }];
	if (officialTerm) {
		data.sections.education.hidden = false;
		data.sections.education.items = [
			educationItemSchema.parse({
				id: "school",
				hidden: false,
				school: "Synthetic Institute",
				degree: "Training certificate",
				area: "",
				grade: "",
				location: "",
				period: "1445 AH",
				website: { url: "", label: "" },
				description: "",
			}),
		];
		data.metadata.layout.pages[0]?.main.push("education");
	}
	const response = await page.request.put(`/api/openapi/resumes/${id}`, {
		data: { data, expectedUpdatedAt: current.updatedAt.toISOString() },
	});
	await expect(response).toBeOK();
	return id;
}
export function variantClient(page: Page): RouterClient<typeof router> {
	return createORPCClient(
		new RPCLink({
			url: new URL("/api/rpc", String(test.info().project.use.baseURL)).href,
			fetch: async (request, init) => {
				const session = await page.request.get("/api/auth/get-session");
				if (!session.ok()) throw new Error("Cannot establish disposable fixture ownership.");
				assertSyntheticSession(await session.json());
				const actual = new Request(request, init);
				const response = await page.request.fetch(actual.url, {
					method: actual.method,
					headers: Object.fromEntries(actual.headers),
					...(actual.method !== "GET" && actual.method !== "HEAD" ? { data: await actual.text() } : {}),
				});
				return new Response(await response.body(), { status: response.status(), headers: response.headers() });
			},
		}),
	);
}
export async function readProcessingNotice(page: Page, purpose: string, locale: "ar-SA" | "en-US" = "en-US") {
	const response = await page.request.get("/api/openapi/ai/processing-notices", { params: { purpose, locale } });
	await expect(response).toBeOK();
	const [notice] = await response.json();
	expect(notice).toBeDefined();
	const { content, alreadyGranted, ...acceptance } = notice;
	return { acceptance, alreadyGranted, content };
}

export async function acceptProcessingNotice(page: Page, purpose: string) {
	const { acceptance, alreadyGranted } = await readProcessingNotice(page, purpose);
	if (!alreadyGranted)
		await expect(await page.request.post("/api/openapi/ai/processing-consent", { data: acceptance })).toBeOK();
	return acceptance;
}

export async function startVariantReview(
	page: Page,
	prepared: { kind: string; sources: unknown[]; parameters: Record<string, unknown> },
) {
	const notice = await acceptProcessingNotice(page, prepared.kind);
	const response = await page.request.post("/api/openapi/ai/operations", {
		data: {
			kind: prepared.kind,
			sources: prepared.sources,
			parameters: prepared.parameters,
			requestKey: crypto.randomUUID(),
			route: notice.route,
			consentVersion: notice.noticeVersion,
		},
	});
	await expect(response).toBeOK();
	const operation = await response.json();
	const completedState = prepared.kind === "review.translation" ? /^(waiting_review|succeeded)$/u : /^waiting_review$/u;
	await expect
		.poll(async () => (await (await page.request.get(`/api/openapi/ai/operations/${operation.id}`)).json()).state, {
			timeout: 30000,
		})
		.toMatch(completedState);
	return operation.id as string;
}

/** Three independently reviewable passages, all synthetic and intentionally free of personal data. */
export async function seedTailoringReview(
	page: Page,
	info: TestInfo,
	jobText = "TypeScript services required.",
	documentLocale: "en-US" | "ar-SA" = "en-US",
) {
	const sourceId = await seedVariantReview(page, info, false, documentLocale);
	const api = variantClient(page);
	const source = await api.resume.getById({ id: sourceId });
	const data = structuredClone(source.data);
	data.sections.projects.hidden = false;
	const descriptions =
		documentLocale === "ar-SA"
			? { dashboard: "<p>بنيت لوحات تحكم.</p>", pipeline: "<p>بنيت خطوط بيانات.</p>" }
			: { dashboard: "<p>Built TypeScript dashboards.</p>", pipeline: "<p>Built TypeScript pipelines.</p>" };
	data.sections.projects.items = Object.entries(descriptions).map(([id, description]) =>
		projectItemSchema.parse({
			id,
			hidden: false,
			name: `Synthetic ${id}`,
			period: "",
			website: { url: "", label: "" },
			description,
		}),
	);
	data.metadata.layout.pages[0]?.main.push("projects");
	await expect(
		await page.request.put(`/api/openapi/resumes/${sourceId}`, {
			data: { data, expectedUpdatedAt: source.updatedAt.toISOString() },
		}),
	).toBeOK();
	const original = await api.resume.getById({ id: sourceId });
	const job = await api.career.jobTargets.save({ role: "Synthetic engineer", employer: "", text: jobText });
	const copy = await api.resume.variants.create({
		sourceResumeId: sourceId,
		expectedUpdatedAt: original.updatedAt.toISOString(),
		variantKind: "job",
		jobId: job.jobId,
		jobRevision: job.revision,
		requestKey: crypto.randomUUID(),
	});
	return { sourceId, copyId: copy.resumeId, original };
}

export async function launchTailoringReview(page: Page, copyId: string) {
	await page.goto(`/dashboard/resumes/${copyId}/job`);
	await page.getByRole("button", { name: /^(Review tailored wording|مراجعة الصياغة المخصصة)$/u }).click();
	await page
		.getByRole("dialog")
		.getByRole("button", { name: /^(Start review|بدء المراجعة)$/u })
		.click();
	await expect(page.getByRole("dialog")).toHaveCount(0);
}
