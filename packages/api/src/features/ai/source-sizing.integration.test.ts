import { expect, it } from "vite-plus/test";
import { withOwnerDatabase } from "@reactive-resume/db/owner-scope";
import { buildJobPassages } from "@reactive-resume/resume/ats";
import { experienceItemSchema } from "@reactive-resume/schema/resume/data";
import { defaultResumeData } from "@reactive-resume/schema/resume/default";
import { saveJobTarget, selectResumeJob } from "../career/job-targets";
import { buildLetterWriterPayload } from "../cover-letters/review-handler";
import { resumeService } from "../resume/service";
import { createVariant } from "../resume/variants";
import { buildModelPayload } from "./payload";
import { reviewHandlers } from "./review-handlers";
import { createImportReviewSource, loadReviewSource, prepareResumeReview } from "./review-sources";
import { aiTestDatabase } from "./testing/database";
import { buildVariantWriterPayload } from "./variant-contracts";
import { loadConfirmedCvContext, loadVariantSnapshot, prepareVariantReview } from "./variant-sources";

const database = aiTestDatabase();
const size = (value: unknown) => [...JSON.stringify(value)].length;

it("sizes selected summary, wording, import help, tailoring and letter context independently of a 20-year CV", async () => {
	const data = structuredClone(defaultResumeData);
	data.sections.experience.hidden = false;
	data.sections.experience.items = Array.from({ length: 20 }, (_, index) =>
		experienceItemSchema.parse({
			id: `role-${index}`,
			hidden: false,
			company: "Sample organization",
			position: "Coordinator",
			location: "",
			period: `${2000 + index}`,
			website: { url: "", label: "" },
			description: `<p>${index === 19 ? "Used PostgreSQL for reporting. Did not administer databases." : "Filed historical documents and organized paper records. ".repeat(90)}</p>`,
		}),
	);
	data.metadata.layout.pages = [{ fullWidth: false, main: ["experience"], sidebar: [] }];
	const passages = buildJobPassages(data);
	expect(size(passages)).toBeGreaterThan(45000);
	const selected = passages.find((passage) => passage.text.includes("PostgreSQL"));
	if (!selected) throw new Error("Missing selected passage");
	const resumeId = await database.run(() =>
		resumeService.create({ userId: "alice", name: "Long CV", tags: [], data, locale: "en-US" }),
	);
	const revision = (
		await database.admin().query("SELECT updated_at FROM resume WHERE id=$1", [resumeId])
	).rows[0].updated_at.toISOString();
	const summary = await database.run(() =>
		prepareVariantReview("alice", {
			kind: "review.summary",
			resumeId,
			expectedUpdatedAt: revision,
			selectedEvidenceIds: [selected.id],
		}),
	);
	const summarySnapshot = await database.run(() =>
		withOwnerDatabase("alice", (tx) => loadVariantSnapshot(tx, "alice", summary)),
	);
	expect(summarySnapshot.cv.map((fact) => fact.id)).toEqual([selected.id]);
	expect(summarySnapshot.cv[0]?.text).toBe(selected.text);
	expect(size(buildVariantWriterPayload(summarySnapshot))).toBeLessThan(2000);

	const wording = await database.run(() =>
		prepareResumeReview("alice", { resumeId, expectedUpdatedAt: revision, targets: [selected.target] }),
	);
	const wordingInput = await database.run(() =>
		reviewHandlers["review.wording"].buildInput("alice", {
			kind: "review.wording",
			requestKey: "bounded-wording",
			sources: wording.sources,
			parameters: { resumeId, targets: [selected.target], action: "review" },
			route: { routeId: "synthetic", routeRevision: "1", configRevision: "1" },
			consentVersion: "1",
		}),
	);
	expect(size(buildModelPayload(wordingInput))).toBeLessThan(2000);
	expect(JSON.stringify(wordingInput)).toContain("Did not administer databases.");

	const staged = await database.run(() =>
		createImportReviewSource("alice", {
			flowId: "selected-long-cv",
			section: "experience",
			text: selected.text,
			partial: true,
			contactValues: [],
		}),
	);
	const imported = await database.run(() =>
		withOwnerDatabase("alice", (tx) => loadReviewSource(tx, "alice", staged.source)),
	);
	expect(size(buildModelPayload({ selections: imported.selections, contactValues: [] }))).toBeLessThan(2000);
	expect(imported.partial).toBe(true);

	const job = await database.run(() =>
		saveJobTarget("alice", { role: "Engineer", employer: "", text: "PostgreSQL reporting required." }),
	);
	const selection = await database.run(() =>
		selectResumeJob("alice", { resumeId, expectedUpdatedAt: revision, jobId: job.jobId, jobRevision: job.revision }),
	);
	const context = await database.run(() =>
		withOwnerDatabase("alice", (tx) =>
			loadConfirmedCvContext(tx, "alice", {
				kind: "review.cover-letter",
				parameters: {
					resumeId,
					expectedUpdatedAt: revision,
					jobId: job.jobId,
					jobRevision: job.revision,
					expectedSelectionRevision: selection.revision,
					letterId: "letter",
					expectedLetterRevision: 1,
					documentLocale: "en-US",
					length: "short",
				},
				sources: [
					{ kind: "resume", id: resumeId, revision },
					{ kind: "job", id: job.jobId, revision: job.revision },
				],
			}),
		),
	);
	expect(context.cv).toContainEqual(expect.objectContaining({ id: selected.id, text: selected.text }));
	expect(
		size(
			buildLetterWriterPayload({ category: "cover-letter", ...context }, { documentLocale: "en-US", length: "short" }),
		),
	).toBeLessThanOrEqual(16000);

	const copy = await database.run(() =>
		createVariant("alice", {
			sourceResumeId: resumeId,
			expectedUpdatedAt: revision,
			requestKey: "long-tailoring",
			variantKind: "job",
			jobId: job.jobId,
			jobRevision: job.revision,
		}),
	);
	const copyRevision = (
		await database.admin().query("SELECT updated_at FROM resume WHERE id=$1", [copy.resumeId])
	).rows[0].updated_at.toISOString();
	const copySelection = (
		await database.admin().query("SELECT updated_at FROM resume_job_selection WHERE resume_id=$1", [copy.resumeId])
	).rows[0].updated_at.toISOString();
	const tailoring = await database.run(() =>
		prepareVariantReview("alice", {
			kind: "review.tailoring",
			resumeId: copy.resumeId,
			expectedUpdatedAt: copyRevision,
			jobId: job.jobId,
			jobRevision: job.revision,
			expectedSelectionRevision: copySelection,
		}),
	);
	const snapshot = await database.run(() =>
		withOwnerDatabase("alice", (tx) => loadVariantSnapshot(tx, "alice", tailoring)),
	);
	expect(snapshot.cv.some((fact) => fact.text === selected.text)).toBe(true);
	expect(size(buildVariantWriterPayload(snapshot))).toBeLessThanOrEqual(16000);
	expect(snapshot.variant?.fields.some((field) => field.text === selected.text)).toBe(true);
});
