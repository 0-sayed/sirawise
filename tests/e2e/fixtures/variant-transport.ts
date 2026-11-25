import type { VariantSnapshot } from "@reactive-resume/api/features/ai/variant-types";

const translationVerificationAttempts = new Map<string, number>();
const compactVerificationAttempts = new Map<string, number>();

function compactRetryMarker(text: string) {
	return /Compact retry [0-9a-f-]{36}/u.exec(text)?.[0];
}
export const translationAlignmentSentences = {
	"en-US": "I built reliable services.",
	"ar-SA": "بنيت خدمات موثوقة.",
};

/** Scripted transport for synthetic browser fixtures only; identity output does not measure translation quality. */
export function scriptedVariantResponse(selections: Array<{ id: string; text: string }>): unknown {
	const compactSource = selections.find(({ id }) => id === "translation-source");
	if (compactSource) {
		const { direction, sourceRevision, segments } = JSON.parse(compactSource.text) as {
			direction: string;
			sourceRevision: string;
			segments: Array<{ id: string; text: string }>;
		};
		return {
			direction,
			sourceRevision,
			segments: segments.map(({ id, text }) => {
				const marker = compactRetryMarker(text);
				const retrying = marker && (compactVerificationAttempts.get(marker) ?? 0) >= 2;
				return {
					sourceId: id,
					text: text
						.replace("Documented the QA flow.", "وثقت خطوات الاختبار.")
						.replace("Supported the release lead.", retrying ? "ساندت مسؤول الإصدار." : "قدت الإصدار.")
						.replace("Engineer", "مهندس"),
				};
			}),
		};
	}
	const compactCheck = selections.find(({ id }) => id === "translation-check");
	if (compactCheck) {
		const { batchId, pairs } = JSON.parse(compactCheck.text) as {
			batchId: string;
			pairs: Array<{ sourceId: string; target: string }>;
		};
		const shiftedResponsibility = pairs
			.filter(({ target }) => {
				if (!target.includes("قدت الإصدار.")) return false;
				const marker = compactRetryMarker(target);
				if (marker) compactVerificationAttempts.set(marker, (compactVerificationAttempts.get(marker) ?? 0) + 1);
				return true;
			})
			.map(({ sourceId }) => sourceId);
		return {
			schemaVersion: 1,
			batchId,
			checkedSourceIds: pairs.map(({ sourceId }) => sourceId),
			supportedSourceIds: pairs
				.filter(({ sourceId }) => !shiftedResponsibility.includes(sourceId))
				.map(({ sourceId }) => sourceId),
			quality: { status: "appropriate", reason: '{"mqm":[]}' },
			issues: shiftedResponsibility.length ? [{ sourceIds: shiftedResponsibility, code: "responsibility" }] : [],
		};
	}
	const task = selections.find((item) => item.id === "variant-task");
	if (task) {
		const metadata = JSON.parse(task.text) as Omit<VariantSnapshot, "cv" | "jobAd">;
		const cv = selections.find((item) => item.id === "variant-cv-evidence");
		const job = selections.find((item) => item.id === "variant-job-context");
		if (!cv || !job) throw new Error("Missing synthetic writer evidence pools");
		const source: VariantSnapshot = { ...metadata, cv: JSON.parse(cv.text), jobAd: JSON.parse(job.text) };
		if (source.jobAd?.segments.some((span) => span.text === "Synthetic provider failure"))
			return new Response(JSON.stringify({ error: "Synthetic provider failure" }), { status: 503 });
		if (source.category === "job-evidence")
			return {
				requirements: (source.jobAd?.segments ?? []).map((span, index) => ({
					id: `requirement-${index}`,
					spanIds: [span.id],
					importance: "unstated",
					verdict: span.text === "TypeScript and SAP required" ? "partial" : "no_evidence",
					evidenceIds: span.text === "TypeScript and SAP required" ? source.cv.slice(0, 1).map((fact) => fact.id) : [],
					explanation:
						span.text === "TypeScript and SAP required"
							? source.cv[0]?.text
							: span.text.startsWith("Synthetic backup recovery")
								? "The selected passages do not show SAP."
								: span.text.startsWith("Synthetic ability claim")
									? "The candidate cannot use Rust."
									: "No supporting evidence was found in this CV.",
				})),
				notes: source.jobAd?.segments.some((span) => span.text === "TypeScript required.")
					? ["Read the selected evidence before acting.", "The candidate improved delivery by 83%."]
					: [],
			};
		if (source.category === "translation")
			return {
				direction: source.direction,
				sourceRevision: source.sourceRevision,
				segments: source.cv.map((item) => {
					const text =
						item.text === translationAlignmentSentences["en-US"]
							? translationAlignmentSentences["ar-SA"]
							: item.text === translationAlignmentSentences["ar-SA"]
								? translationAlignmentSentences["en-US"]
								: item.text.replace("Documented the QA flow.", "وثقت خطوات الاختبار.");
					return {
						sourceId: item.id,
						text,
						claims: [{ id: "translation", text, evidenceIds: [item.id], kind: "translation" }],
					};
				}),
				notes: [],
			};
		if (source.category === "summary")
			return {
				summary: {
					text: source.cv.map((fact) => fact.text).join(" "),
					claims: source.cv.map((fact, index) => ({
						id: `fact-${index}`,
						text: fact.text,
						evidenceIds: [fact.id],
						kind: "fact",
					})),
				},
				questions: source.cv.length
					? []
					: [{ id: "work", prompt: "What work or study can you confirm?", evidenceIds: [] }],
				notes: [],
			};
		if (source.category === "tailoring" && source.variant)
			return {
				resumeId: source.resumeId,
				baseRevision: source.sourceRevision,
				patches: source.variant.fields.flatMap((field, index) => {
					const after = field.text.replace(/\bBuilt\b/gu, "Developed").replace(/بنيت/gu, "طورت");
					if (after === field.text) return [];
					return [
						{
							id: `wording-${index}`,
							target: {
								resumeId: source.resumeId,
								baseRevision: source.sourceRevision,
								sectionId: field.sectionId,
								itemId: field.itemId,
								roleId: field.roleId,
								field: field.field,
							},
							before: field.text,
							after,
							why: field.text.startsWith("بنيت")
								? "توضح الصياغة العمل المؤكد."
								: "Focus the wording on the confirmed TypeScript work without adding facts.",
							evidenceIds: field.evidenceIds,
							claims: [{ id: "wording", text: after, evidenceIds: field.evidenceIds, kind: "fact" }],
						},
					];
				}),
				order: [],
				notes: [],
			};
	}
	const verification = selections.find((item) => item.id === "variant-verification-task");
	if (verification) {
		const inventory = JSON.parse(verification.text) as {
			category: string;
			jobEvidenceSchemaVersion?: 2;
			claims: Array<{ id: string; evidenceIds: string[] }>;
			premises: Array<{ id: string }>;
			absence: Array<{ id: string }>;
			retention: boolean;
		};
		const cvEvidence = selections.find((item) => item.id === "variant-cv-evidence");
		if (!cvEvidence) throw new Error("Missing synthetic CV evidence");
		const evidence = JSON.parse(cvEvidence.text) as Array<{
			id: string;
			text: string;
		}>;
		// A unique paragraph scopes two independent verifier failures to this disposable browser fixture.
		const stopped = evidence.find((fact) => fact.text.includes("Synthetic batched translation retry"));
		let rejectStopped = false;
		if (stopped) {
			const key = `${stopped.id}:${stopped.text}`;
			const attempt = (translationVerificationAttempts.get(key) ?? 0) + 1;
			translationVerificationAttempts.set(key, attempt);
			rejectStopped = attempt <= 2;
		}
		const job = inventory.jobEvidenceSchemaVersion === 2;
		const reason = job
			? "Scripted synthetic verdict."
			: "Scripted synthetic fixture; no semantic quality qualification.";
		return {
			schemaVersion: job ? 2 : 1,
			verdicts: inventory.claims.map((claim) => ({
				claimId: claim.id,
				verdict: rejectStopped && stopped && claim.evidenceIds.includes(stopped.id) ? "unsupported" : "supported",
				evidenceIds: claim.evidenceIds,
				reason,
			})),
			retention: inventory.retention
				? { status: "retained", evidenceIds: evidence.map((item) => item.id), reason }
				: null,
			absence: inventory.absence.map((item) => ({ id: item.id, verdict: "confirmed_absent" })),
			coverage: { status: "complete", reason },
			premises: inventory.premises.map((item) => ({
				id: item.id,
				verdict: job && item.id.startsWith("requirement:") ? "supported" : "no_candidate_premise",
				reason,
				...(job ? { issueClass: null } : {}),
			})),
			quality: {
				...(inventory.category === "translation" ? { assessment: "translation_language_quality" } : {}),
				status: "appropriate",
				reason,
			},
		};
	}
	return undefined;
}
