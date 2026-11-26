import type {
	CaseReceipt,
	QualificationCall,
	QualificationRoute,
	QualificationCase,
	SafetyInput,
	SafetyIssue,
} from "./types";
import type { VariantSnapshot } from "@reactive-resume/api/features/ai/variant-types";
import { randomUUID } from "node:crypto";
import { chmod, readFile, rename, writeFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import { z, ZodError } from "zod";
import { executeApprovedStep, verificationCallBound } from "@reactive-resume/api/features/ai/adapter";
import { buildModelPayload, prepareImportSelection, type ModelPayload } from "@reactive-resume/api/features/ai/payload";
import {
	extractionCandidateHandler,
	prepareExtractionFromSnapshot,
	reviewHandlers,
} from "@reactive-resume/api/features/ai/review-handlers";
import {
	buildExtractionVerifierSchema,
	extractionVerifierSchema,
	filterExtractionVerification,
	reviewVerifierSchema,
} from "@reactive-resume/api/features/ai/review-verifier";
import {
	withAiRuntime,
	withMeasuredReviewExecution,
	type ApprovedRoute,
} from "@reactive-resume/api/features/ai/route-policy";
import { jobEvidenceCandidateContract } from "@reactive-resume/api/features/ai/variant-contracts";
import { prepareJobEvidenceCandidate } from "@reactive-resume/api/features/ai/variant-handlers";
import {
	buildVariantVerifierSchema,
	filterVariantVerification,
	planVariantVerificationBatches,
} from "@reactive-resume/api/features/ai/variant-verifier";
import {
	canonicalVerifierRouteSha256,
	resolveReviewVerifierRoute,
} from "@reactive-resume/api/features/ai/verifier-policy";
import { resolveWriterRoute } from "@reactive-resume/api/features/ai/writer-policy";
import { jobEvidenceSchema } from "@reactive-resume/schema/resume/variant-outputs";
import { opaqueFixture, qualificationSelectionId } from "./fixture-identifiers";
import { sha256 } from "./run";
import { plannedVerifier } from "./types";

type Hold = { manifest: string; suite: string; caseId: string; batchKey: string; bound: number; cost: number | null };
type LedgerState = {
	campaignId: string;
	capMicros: number;
	overBound: boolean;
	holds: Hold[];
	completed: { manifest: string; receipt: CaseReceipt }[];
};

const spends = (holds: Hold[]) => ({
	measured: holds.reduce((sum, hold) => sum + (hold.cost ?? 0), 0),
	held: holds.reduce((sum, hold) => sum + (hold.cost === null ? hold.bound : 0), 0),
});
const liability = (holds: Hold[]) => {
	const { measured, held } = spends(holds);
	return measured + held;
};

/** Keep spend and unresolved dispatches across process restarts and manifest changes. */
export class QualificationLedger {
	constructor(
		private readonly path: string,
		private readonly campaignId: string,
		private readonly capMicros: number,
		private readonly previousCapMicros?: number,
	) {}

	private async read(): Promise<LedgerState> {
		const state = await readFile(this.path, "utf8").then(
			(data) => JSON.parse(data) as LedgerState,
			(error: NodeJS.ErrnoException) => {
				if (error.code !== "ENOENT") throw error;
				return { campaignId: this.campaignId, capMicros: this.capMicros, overBound: false, holds: [], completed: [] };
			},
		);
		if (state.campaignId !== this.campaignId) throw new Error("QUALIFICATION_CAMPAIGN_CHANGED");
		if (state.capMicros === this.capMicros) return state;
		if (
			this.previousCapMicros === undefined ||
			state.capMicros !== this.previousCapMicros ||
			state.capMicros >= this.capMicros
		)
			throw new Error("QUALIFICATION_CAMPAIGN_CHANGED");
		// Persist the approved increase on the next locked write, keeping every prior hold and receipt.
		return { ...state, capMicros: this.capMicros };
	}

	private async update<T>(edit: (state: LedgerState) => T): Promise<T> {
		// SQLite releases its OS lock when the process dies. Legacy .lock files have no owner
		// information. The ledger remains authoritative for holds and completed receipts.
		const lock = `${this.path}.lock.sqlite`;
		const mutex = new DatabaseSync(lock);
		try {
			await chmod(lock, 0o600);
			mutex.exec("BEGIN IMMEDIATE");
			const state = await this.read();
			const result = edit(state);
			const temporary = `${this.path}.${randomUUID()}`;
			await writeFile(temporary, JSON.stringify(state), { mode: 0o600, flush: true });
			await rename(temporary, this.path);
			return result;
		} finally {
			mutex.close();
		}
	}

	async reserve(manifest: string, suite: string, caseId: string, batchKey: string, bound: number, cap: number) {
		await this.update((state) => {
			const findCase = (hold: Hold) => hold.manifest === manifest && hold.suite === suite && hold.caseId === caseId;
			if (
				state.holds.some((hold) => findCase(hold) && hold.batchKey === batchKey) ||
				state.completed.some(
					(entry) => entry.manifest === manifest && entry.receipt.suite === suite && entry.receipt.caseId === caseId,
				)
			)
				throw new Error("QUALIFICATION_ALREADY_DISPATCHED");
			if (
				state.overBound ||
				!Number.isSafeInteger(bound) ||
				bound <= 0 ||
				liability(state.holds) + bound > state.capMicros ||
				liability(state.holds.filter((hold) => hold.suite === suite)) + bound > cap ||
				liability(state.holds.filter(findCase)) + bound > 200000
			)
				throw new Error("QUALIFICATION_BUDGET");
			state.holds.push({ manifest, suite, caseId, batchKey, bound, cost: null });
		});
	}

	async settle(manifest: string, suite: string, caseId: string, call: QualificationCall) {
		const exceeded = await this.update((state) => {
			const hold = state.holds.find(
				(entry) =>
					entry.manifest === manifest &&
					entry.suite === suite &&
					entry.caseId === caseId &&
					entry.batchKey === call.batchKey,
			);
			if (!hold || hold.cost !== null) throw new Error("QUALIFICATION_HOLD_REQUIRED");
			hold.cost = call.costMicros;
			const exceeded = call.costMicros !== null && call.costMicros > hold.bound;
			state.overBound ||= exceeded;
			return exceeded;
		});
		if (exceeded) throw new Error("QUALIFICATION_BOUND_EXCEEDED");
	}

	async complete(manifest: string, receipt: CaseReceipt) {
		await this.update((state) => {
			state.completed.push({ manifest, receipt });
		});
	}

	async existing(manifest: string, suite: string, caseId: string): Promise<CaseReceipt | undefined> {
		const state = await this.read();
		return state.completed.find(
			(entry) => entry.manifest === manifest && entry.receipt.suite === suite && entry.receipt.caseId === caseId,
		)?.receipt;
	}

	async spend() {
		return spends((await this.read()).holds);
	}
}

type BatchVerdicts = QualificationCall["verdicts"];
type PreparedBatch = {
	key: string;
	itemIds: string[];
	payload: ModelPayload;
	schema: z.ZodType<Record<string, unknown>>;
	prompt: string;
	validate: (raw: unknown) => BatchVerdicts;
};
type FixedCase = { batches: PreparedBatch[]; localIssues: SafetyIssue[] };

const candidateItems = z.array(z.object({ id: z.string() }));
const claimItems = z.array(z.object({ claimId: z.string(), text: z.string() }).passthrough());
const fixtureText = z.object({
	text: z.string(),
	section: z.string(),
	contactValues: z.array(z.string()).default([]),
	partial: z.boolean().default(false),
});
function deterministic(itemIds: readonly string[], issueClass: string): FixedCase {
	return {
		batches: [],
		localIssues: [...new Set(itemIds)].map((itemId) => ({ itemId, issueClass, stage: "deterministic" })),
	};
}

function verdictsFromWithheld(
	itemIds: readonly string[],
	withheld: readonly { id: string; reason?: string | undefined }[],
): BatchVerdicts {
	const rejected = new Map(withheld.map(({ id, reason }) => [id, reason ?? "AI_VERIFICATION_CLAIM_SUPPORT"]));
	return itemIds.map((itemId) => ({ itemId, issueClass: rejected.get(itemId) ?? null }));
}

export function prepareFixedCase(fixture: SafetyInput, route: QualificationRoute, seed: string): FixedCase {
	const { input } = opaqueFixture(fixture, seed);
	if (input.feature !== route.feature) throw new Error("QUALIFICATION_FEATURE_CHANGED");
	if (input.feature === "translation") throw new Error("QUALIFICATION_FEATURE_RETIRED");
	if (input.feature === "job-evidence") {
		const candidate = jobEvidenceSchema.parse(input.candidate);
		const original = {
			...candidate,
			requirements: candidate.requirements.toSorted((a, b) => a.id.localeCompare(b.id)),
		};
		const snapshot = input.source as unknown as VariantSnapshot;
		try {
			const prepared = prepareJobEvidenceCandidate(snapshot, original, route.limits);
			const plan = planVariantVerificationBatches(prepared.snapshot, prepared.output);
			const localIssues = [...(prepared.guardWithheld?.items ?? []), ...(plan.oversizeWithheld?.items ?? [])].flatMap(
				({ id, reason }) => deterministic([id], reason ?? "AI_UNSUPPORTED_CLAIM").localIssues,
			);
			return {
				localIssues,
				batches: plan.batches.map((batch, index) => ({
					key: `batch-${index + 1}`,
					itemIds: batch.itemIds,
					payload: batch.payload,
					schema: buildVariantVerifierSchema(batch.payload),
					prompt: jobEvidenceCandidateContract.verifierPrompt,
					validate: (raw) =>
						verdictsFromWithheld(
							batch.itemIds,
							filterVariantVerification(batch.snapshot, batch.output, raw, { allowEmptyJobBatch: true }).withheld
								?.items ?? [],
						),
				})),
			};
		} catch (error) {
			if (
				!(error instanceof Error) ||
				!/^AI_[A-Z_]+$/u.test(error.message) ||
				original.requirements.length !== 1 ||
				original.notes.length
			)
				throw error;
			return deterministic(
				original.requirements.map(({ id }) => id),
				error.message,
			);
		}
	}
	const source = fixtureText.parse(input.source);
	const wording = input.feature === "wording";
	const handler = wording ? reviewHandlers["review.wording"] : extractionCandidateHandler;
	const verifier = handler.verifier;
	if (!verifier) throw new Error("QUALIFICATION_CONTRACT_REQUIRED");
	const selection = wording
		? buildModelPayload({
				selections: [
					{
						id: qualificationSelectionId,
						kind: "confirmed_content",
						section: source.section,
						text: source.text,
					},
				],
				contactValues: source.contactValues,
			}).selections[0]
		: prepareImportSelection(source);
	if (!selection) throw new Error("QUALIFICATION_SOURCE_REQUIRED");
	const selections = [
		{
			id: qualificationSelectionId,
			kind: wording ? ("confirmed_content" as const) : ("unconfirmed_source" as const),
			section: selection.section,
			text: selection.text,
		},
	];
	const original = handler.output.parse(input.candidate);
	let output = original;
	let localIssues: SafetyIssue[] = [];
	if (!wording) {
		const pin = {
			kind: "import" as const,
			id: qualificationSelectionId,
			revision: sha256(JSON.stringify(input.source)),
		};
		try {
			const prepared = prepareExtractionFromSnapshot(
				{
					source: pin,
					selections,
					expiresAt: null,
					partial: source.partial,
					evidence: [
						{
							id: qualificationSelectionId,
							source: pin,
							factId: null,
							factRevision: null,
							target: null,
							quote: selections[0]?.text ?? "",
							confirmation: "source_unconfirmed",
						},
					],
				},
				original,
			);
			output = prepared.output;
			localIssues = prepared.withheld.flatMap(({ id, reason }) => deterministic([id], reason).localIssues);
		} catch (error) {
			const items = candidateItems.parse(original.candidates);
			if (
				!(error instanceof Error) ||
				!/^AI_[A-Z_]+$/u.test(error.message) ||
				items.length !== 1 ||
				candidateItems.parse(original.questions).length
			)
				throw error;
			return deterministic(
				items.map(({ id }) => id),
				error.message,
			);
		}
	}
	const payload = verifier.buildInput(buildModelPayload({ selections, contactValues: [] }, !wording), output);
	const wireToLogical = new Map<string, string>();
	if (!wording) {
		const inventory = payload.selections.find((entry) => "id" in entry && entry.id === "verification-claims");
		const task = payload.selections.find((entry) => "id" in entry && entry.id === "verification-task");
		if (!inventory || !task) throw new Error("QUALIFICATION_CONTRACT_REQUIRED");
		const claims = claimItems
			.parse(JSON.parse(inventory.text))
			.map((claim) => {
				const wireId = claim.claimId.replace(/^question:/u, "");
				return { claim, wireId };
			})
			.sort((a, b) => a.wireId.localeCompare(b.wireId));
		inventory.text = JSON.stringify(
			claims.map(({ wireId, claim }) => {
				if (wireToLogical.has(wireId)) throw new Error("QUALIFICATION_ID_COLLISION");
				wireToLogical.set(wireId, claim.claimId);
				return { ...claim, claimId: wireId };
			}),
		);
		task.text = JSON.stringify({
			...z.looseObject({}).parse(JSON.parse(task.text)),
			requiredClaimIds: claims.map(({ wireId }) => wireId),
		});
	}
	const itemIds = wording ? candidateItems.parse(output.proposals).map(({ id }) => id) : [...wireToLogical.values()];
	return {
		localIssues,
		batches: [
			{
				key: "batch-1",
				itemIds,
				payload,
				schema: wording ? verifier.output : buildExtractionVerifierSchema(payload),
				prompt: verifier.systemPrompt,
				validate: (raw) => {
					try {
						const result = (wording ? reviewVerifierSchema : extractionVerifierSchema).parse(raw);
						const filtered = wording
							? verifier.validate(output, result)
							: filterExtractionVerification(
									output,
									{
										...result,
										verdicts: result.verdicts.map((verdict) => ({
											...verdict,
											claimId: wireToLogical.get(verdict.claimId),
										})),
									},
									{ allowEmptyResult: true },
								);
						const withheld = z
							.array(z.object({ id: z.string(), reason: z.string().optional() }))
							.parse((filtered?.withheld as { items?: unknown } | undefined)?.items ?? []);
						return verdictsFromWithheld(itemIds, withheld);
					} catch (error) {
						if (wording && error instanceof Error && error.message === "AI_FACT_RETENTION_FAILED")
							return itemIds.map((itemId) => ({ itemId, issueClass: error.message }));
						throw error;
					}
				},
			},
		],
	};
}

export const batchHashes = (batch: PreparedBatch) => ({
	promptSha256: sha256(JSON.stringify([batch.prompt, batch.payload])),
	schemaSha256: sha256(JSON.stringify(z.toJSONSchema(batch.schema, { unrepresentable: "any" }))),
});

export function qualificationBatchBound(batch: PreparedBatch, route: ApprovedRoute) {
	return verificationCallBound(route, {
		payload: batch.payload,
		outputSchema: batch.schema,
		systemPrompt: batch.prompt,
	});
}

function executeQualificationBatch(
	batch: PreparedBatch,
	route: ApprovedRoute,
	operationId: string,
	verificationBoundMicros: number,
	fetch?: typeof globalThis.fetch,
) {
	return withAiRuntime({ routes: [route], handlers: {}, workerAvailable: false, ...(fetch ? { fetch } : {}) }, () =>
		executeApprovedStep(
			{
				route,
				operationId,
				attemptId: batch.key,
				stepId: "verify",
				signal: AbortSignal.timeout(route.callTimeoutMs),
				payload: batch.payload,
				outputSchema: batch.schema,
				systemPrompt: batch.prompt,
				verificationBoundMicros,
			},
			{ retry: false, concurrencyLimit: 1 },
		),
	);
}

/** Measure the SDK's final request without opening a connection or using credentials. */
export async function batchInputBytes(batch: PreparedBatch, route: ApprovedRoute, boundMicros: number) {
	let bytes: number | undefined;
	await executeQualificationBatch(
		batch,
		{ ...route, apiKey: "offline-serialization" },
		"qualification-serialization",
		boundMicros,
		(_, init) => {
			if (typeof init?.body === "string") bytes = Buffer.byteLength(init.body, "utf8");
			return Promise.reject(new Error("OFFLINE_SERIALIZATION_ONLY"));
		},
	);
	if (bytes === undefined) throw new Error("QUALIFICATION_SERIALIZATION_FAILED");
	return bytes;
}

export function effectiveQualificationRoute(input: Pick<SafetyInput, "feature">, writer: ApprovedRoute) {
	return resolveReviewVerifierRoute(
		resolveWriterRoute(withMeasuredReviewExecution(writer), { kind: `review.${input.feature}`, parameters: {} }),
	);
}

export async function runFixedCase(
	input: SafetyInput,
	route: QualificationRoute,
	execution?: {
		suite: string;
		manifestSha256: string;
		fixtureIdentifierSeed: string;
		planned: QualificationCase;
		capMicros: number;
		ledger: QualificationLedger;
		writer: ApprovedRoute;
	},
): Promise<CaseReceipt> {
	const started = Date.now();
	if (!execution) throw new Error("QUALIFICATION_NOT_ARMED");
	const prepared = prepareFixedCase(input, route, execution.fixtureIdentifierSeed);
	const { suite, manifestSha256, planned, capMicros, ledger, writer } = execution;
	const inputSha256 = sha256(JSON.stringify(input));
	const logicalInputSha256 = sha256(JSON.stringify([input.source, input.candidate]));
	if (
		input.id !== planned.id ||
		inputSha256 !== planned.inputSha256 ||
		logicalInputSha256 !== planned.logicalInputSha256 ||
		planned.batches.length !== prepared.batches.length
	)
		throw new Error("QUALIFICATION_CASE_CHANGED");
	const existing = await ledger.existing(manifestSha256, suite, input.id);
	if (existing) return existing;
	if (route.endpointSlot !== "primary") throw new Error("QUALIFICATION_TRANSPORT_DENIED");
	const effective = effectiveQualificationRoute(input, writer);
	if (canonicalVerifierRouteSha256(effective) !== route.routeSha256) throw new Error("QUALIFICATION_ROUTE_CHANGED");
	const receipt: CaseReceipt = {
		suite,
		caseId: input.id,
		inputSha256,
		logicalInputSha256,
		plannedVerifier: plannedVerifier(planned, route.routeSha256),
		elapsedMs: 0,
		stage: prepared.batches.length ? "semantic" : "deterministic",
		status: "evaluated",
		retainedIds: [],
		issues: [...prepared.localIssues],
		calls: [],
	};
	for (const [index, batch] of prepared.batches.entries()) {
		const callPlan = planned.batches[index];
		const hashes = batchHashes(batch);
		const boundMicros = await qualificationBatchBound(batch, effective);
		if (
			!callPlan ||
			callPlan.batchKey !== batch.key ||
			JSON.stringify(callPlan.itemIds) !== JSON.stringify(batch.itemIds) ||
			callPlan.promptSha256 !== hashes.promptSha256 ||
			callPlan.schemaSha256 !== hashes.schemaSha256 ||
			callPlan.boundMicros !== boundMicros ||
			[...JSON.stringify(batch.payload)].length > effective.maxInputCodePoints
		)
			throw new Error("QUALIFICATION_CALL_CHANGED");
		try {
			await ledger.reserve(manifestSha256, suite, input.id, batch.key, callPlan.boundMicros, capMicros);
		} catch (error) {
			if (
				error instanceof Error &&
				["QUALIFICATION_BUDGET", "QUALIFICATION_ALREADY_DISPATCHED"].includes(error.message)
			) {
				receipt.status = "budget_exhausted";
				break;
			}
			throw error;
		}
		const calledAt = Date.now();
		const result = await executeQualificationBatch(batch, effective, inputSha256, boundMicros);
		const call: QualificationCall = {
			batchKey: batch.key,
			endpointSlot: route.endpointSlot,
			transport: "real",
			routeSha256: route.routeSha256,
			...hashes,
			observedModel: result.observedModel ?? null,
			observedProvider: result.observedProvider ?? null,
			responseId: result.responseId,
			costMicros: result.costMicros,
			heldMicros: result.costMicros === null ? callPlan.boundMicros : 0,
			elapsedMs: Date.now() - calledAt,
			verdicts: [],
			adapterOutcome: result.outcome,
			outputTokens: result.outputTokens,
			reasoningTokens: result.reasoningTokens ?? null,
		};
		receipt.calls.push(call);
		try {
			await ledger.settle(manifestSha256, suite, input.id, call);
		} catch (error) {
			if (!(error instanceof Error) || error.message !== "QUALIFICATION_BOUND_EXCEEDED") throw error;
			receipt.status = "budget_exhausted";
			break;
		}
		if (result.outcome !== "valid" || !result.output) {
			receipt.status =
				result.outcome === "refusal"
					? "refused"
					: ["invalid", "truncated", "REQUEST_SCHEMA_ERROR"].includes(result.outcome)
						? "invalid_verdict"
						: "transport_failed";
			break;
		}
		try {
			call.verdicts = batch.validate(result.output);
		} catch (error) {
			receipt.status = error instanceof ZodError ? "invalid_verdict" : "incomplete_verdict";
			break;
		}
		for (const { itemId, issueClass } of call.verdicts) {
			if (issueClass) receipt.issues.push({ itemId, issueClass, stage: "semantic" });
			else receipt.retainedIds.push(itemId);
		}
	}
	receipt.elapsedMs = Date.now() - started;
	await ledger.complete(manifestSha256, receipt);
	return receipt;
}
