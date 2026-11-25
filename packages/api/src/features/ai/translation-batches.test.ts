import type { VariantSnapshot } from "./variant-types";
import { createHash } from "node:crypto";
import { expect, it } from "vite-plus/test";
import { minimizeModelText } from "./payload";
import {
	planTranslationBatches,
	mergeTranslationBatches,
	mergePartialTranslationBatches,
	persistTranslationPlan,
	restoreTranslationPlan,
	recoverTranslationPlan,
} from "./translation-batches";
import { buildTranslationCheck, compactTranslationCheckTargetBytes } from "./translation-verifier";
import { buildVariantWriterPayload } from "./variant-contracts";
import { prepareCompactTranslationVerification } from "./variant-handlers";
import { buildVariantVerificationPayload } from "./variant-verifier";

const snapshot = (texts: string[]): VariantSnapshot => ({
	category: "translation",
	resumeId: "copy",
	sourceRevision: "revision",
	direction: "en-ar",
	jobAd: null,
	cv: texts.map((text, index) => ({ id: `source-${index}`, section: "summary", text })),
});
const budget = { maxInputCodePoints: 32000, maxOutputTokens: 4096 };
it("keeps admitted verifier batches stable while sizing new plans from the translated prose", () => {
	const base = snapshot(Array.from({ length: 6 }, () => "Reviewed a release."));
	const full = { ...base, translationProtection: { maskedSegments: base.cv, localMap: new Map(), assertions: [] } };
	const next = planTranslationBatches(full, budget);
	const batches = next.batches.map(({ cv }) => cv);
	const previous = { version: "compact-v1", groups: next.groups, batches };
	const restored = restoreTranslationPlan(full, {
		...previous,
		fingerprint: createHash("sha256").update(JSON.stringify(previous)).digest("hex"),
	});
	const verify = (part: VariantSnapshot) =>
		prepareCompactTranslationVerification(
			part,
			{
				direction: base.direction,
				sourceRevision: base.sourceRevision,
				segments: part.cv.map(({ id }) => ({ sourceId: id, text: "راجعت الإصدار ووثقت نطاق المراجعة. ".repeat(12) })),
			},
			"part-1",
		).batches;
	const oldPart = restored.batches[0];
	const newPart = next.batches[0];
	if (!oldPart || !newPart) throw new Error("Missing translation part");
	expect(verify(oldPart)).toHaveLength(1);
	expect(verify(newPart).length).toBeGreaterThan(1);
	expect(restoreTranslationPlan(full, persistTranslationPlan(next))).toEqual(next);
});
it.each([
	["ar-en", "عملت على تحديث تقارير الأداء ومراجعة طلبات العملاء. ", "I updated reports and reviewed requests. "],
	["en-ar", "Reviewed café menus and updated the weekly report. ", "راجعت قوائم المقاهي وحدّثت التقرير الأسبوعيّ. "],
] as const)("sizes compact %s parts by UTF-8 bytes", (direction, sentence, translation) => {
	const base = { ...snapshot([sentence.repeat(150)]), direction };
	const full = { ...base, translationProtection: { maskedSegments: base.cv, localMap: new Map(), assertions: [] } };
	const limits = { ...budget, verifierMaxInputBytes: 3000 };
	const plan = planTranslationBatches(full, limits);
	for (const part of plan.batches) {
		const candidate = {
			direction,
			sourceRevision: full.sourceRevision,
			segments: part.cv.map(({ id, text }) => ({ sourceId: id, text: text.replaceAll(sentence, translation) })),
		};
		const payload = buildTranslationCheck(
			{ ...full.translationProtection, maskedSegments: part.cv },
			candidate,
			"part-1",
		);
		expect(Buffer.byteLength(JSON.stringify(payload))).toBeLessThanOrEqual(limits.verifierMaxInputBytes);
	}
	expect(plan.batches.flatMap(({ cv }) => cv.map(({ text }) => text)).join("")).toBe(base.cv[0]?.text);
});

it("never splits a sentence to meet a batch target", () => {
	const compact = (texts: string[], direction: "en-ar" | "ar-en") => {
		const source = { ...snapshot(texts), direction };
		return { ...source, translationProtection: { maskedSegments: source.cv, localMap: new Map(), assertions: [] } };
	};
	const cases = [
		{ text: "1. Dr. A. Karim logged 3.5 hours. ", direction: "en-ar" },
		{ text: "١. راجع د. كريم التقرير في 3.5 ساعات. ", direction: "ar-en" },
	] as const;
	for (const { text, direction } of cases) {
		const source = compact([text.repeat(30), "Final item."], direction);
		const plan = planTranslationBatches(source, { ...budget, maxOutputTokens: 256 });
		const parts = plan.batches.flatMap((part) => part.cv);
		expect(parts.length).toBeGreaterThan(2);
		expect(parts.flatMap(({ id }) => id)).toEqual(plan.groups.flatMap(({ partIds }) => partIds));
		expect(parts.slice(0, -1).every(({ text: part }) => part.length % text.length === 0)).toBe(true);
		expect(parts.map(({ text }) => text).join("")).toBe(source.cv.map(({ text }) => text).join(""));
		expect(restoreTranslationPlan(source, persistTranslationPlan(plan))).toEqual(plan);
	}
	expect(() =>
		planTranslationBatches(compact(["Reported " + "data ".repeat(1000) + "once."], "en-ar"), budget),
	).toThrow("AI_INPUT_LIMIT");
});
it("recovers a legacy plan by its persisted hash across sizing and verifier-task changes", () => {
	const full = snapshot(["Confirmed career fact. ".repeat(1000)]);
	const legacy = planTranslationBatches(full, budget, true);
	expect(recoverTranslationPlan(full, { ...budget, maxOutputTokens: 1536 }, legacy.fingerprint)).toEqual(legacy);
	expect(recoverTranslationPlan(full, budget, "0".repeat(64))).toBeNull();
});
it("restores admitted boundaries independently of later planner budgets and rejects changed sources", () => {
	const full = snapshot(["Confirmed career fact. ".repeat(1000)]);
	const admitted = planTranslationBatches(full, budget);
	const next = planTranslationBatches(full, { ...budget, maxOutputTokens: 1024 });
	expect(next.fingerprint).not.toBe(admitted.fingerprint);
	expect(restoreTranslationPlan(full, persistTranslationPlan(admitted))).toEqual(admitted);
	expect(() => restoreTranslationPlan(snapshot(["Different source"]), persistTranslationPlan(admitted))).toThrow(
		"TRANSLATION_BATCH_PLAN_CHANGED",
	);
});
it("bounds writer output and serialized verifier input without capping short segments at eight", () => {
	const full = { ...snapshot(Array.from({ length: 90 }, () => "Confirmed career fact.")), direction: "ar-en" as const };
	const plan = planTranslationBatches(full, budget);
	expect(plan.batches.some((batch) => batch.cv.length > 8)).toBe(true);
	for (const batch of plan.batches) {
		const output = {
			direction: "ar-en" as const,
			sourceRevision: full.sourceRevision,
			segments: batch.cv.map((fact) => ({
				sourceId: fact.id,
				text: fact.text,
				claims: [{ id: "c", text: fact.text, evidenceIds: [fact.id], kind: "translation" as const }],
			})),
			notes: [],
		};
		expect([...JSON.stringify(output)].length / 4).toBeLessThanOrEqual(900);
		expect([...JSON.stringify(buildVariantVerificationPayload(batch, output))].length).toBeLessThanOrEqual(9000);
	}
});
it("redacts complete long paragraphs before splitting without imposing a whole-document call limit", () => {
	const text = "Used React. ".repeat(12000) + " Private Name private@example.test +966501234567";
	const minimized = minimizeModelText(text, ["Private Name", "private@example.test", "+966501234567"]);
	expect(minimized.length).toBeGreaterThan(128000);
	const plan = planTranslationBatches(snapshot([minimized]), budget);
	expect(plan.batches.length).toBeGreaterThan(1);
	expect(JSON.stringify(plan)).not.toMatch(/Private Name|private@example\.test|966501234567/u);
	expect(
		plan.batches
			.flatMap((batch) => batch.cv)
			.map((fact) => fact.text)
			.join(""),
	).toBe(minimized);
});
it("retains whitespace between translated parts even when the writer trims their boundaries", () => {
	const full = snapshot(["x".repeat(512) + " next"]);
	const plan = planTranslationBatches(full, { ...budget, maxOutputTokens: 256 });
	const outputs = plan.batches.map((batch) => ({
		direction: "en-ar" as const,
		sourceRevision: "revision",
		segments: batch.cv.map((fact) => ({
			sourceId: fact.id,
			text: fact.text.trim(),
			claims: [{ id: "claim", text: fact.text.trim(), evidenceIds: [fact.id], kind: "translation" as const }],
		})),
		notes: [],
	}));
	expect(mergeTranslationBatches(full, plan, outputs).segments[0]?.text).toBe(full.cv[0]?.text);
});
it("preserves exact compact paragraph separators in complete and partial results", () => {
	const first = "Recorded QA results ".repeat(12).trimEnd() + ".";
	const second = "Shared the weekly report ".repeat(12).trimEnd() + ".";
	const base = snapshot([`${first}\n\n${second}`]);
	const full = { ...base, translationProtection: { maskedSegments: base.cv, localMap: new Map(), assertions: [] } };
	const plan = planTranslationBatches(full, { ...budget, maxOutputTokens: 256 });
	expect(plan.batches).toHaveLength(2);
	const outputs = plan.batches.map((batch, index) => ({
		direction: "en-ar" as const,
		sourceRevision: base.sourceRevision,
		segments: batch.cv.map(({ id }) => ({
			sourceId: id,
			text: index === 0 ? "سجّلت النتائج." : "شاركت التقرير.",
			claims: [],
		})),
		notes: [],
	}));
	const expected = "سجّلت النتائج.\n\nشاركت التقرير.";
	expect(mergeTranslationBatches(full, plan, outputs).segments[0]?.text).toBe(expected);
	expect(
		mergePartialTranslationBatches(
			full,
			plan,
			outputs.map((output) => ({ status: "delivered", output })),
		).output.segments[0]?.text,
	).toBe(expected);
});
it("measures every split part when later text needs more JSON escaping", () => {
	const full = snapshot(["a".repeat(4000) + '"\n\\'.repeat(3000)]);
	const plan = planTranslationBatches(full, budget);
	expect(
		plan.batches
			.flatMap((batch) => batch.cv)
			.map((fact) => fact.text)
			.join(""),
	).toBe(full.cv[0]?.text);
	for (const batch of plan.batches) expect(buildVariantWriterPayload(batch)).toBeDefined();
});
it("partitions a full CV without losing or repeating source text and stays inside each call budget", () => {
	const full = snapshot(Array.from({ length: 900 }, (_, index) => `Confirmed career fact ${index}.`));
	const plan = planTranslationBatches(full, budget);
	expect(plan.batches.length).toBeGreaterThan(1);
	expect(plan.batches.flatMap((batch) => batch.cv).map(({ text }) => text)).toEqual(full.cv.map(({ text }) => text));
	for (const batch of plan.batches)
		expect([...JSON.stringify(batch)].length).toBeLessThan(budget.maxInputCodePoints / 2);
	expect(planTranslationBatches(full, budget)).toEqual(plan);
});
it("splits a single long field without breaking contact placeholders or Unicode and merges only complete results", () => {
	const full = snapshot(["[LOCAL_123] مرحبا 👨‍👩‍👧‍👦. ".repeat(2000)]);
	const plan = planTranslationBatches(full, budget);
	expect(plan.batches.length).toBeGreaterThan(1);
	expect(
		plan.batches
			.flatMap((batch) => batch.cv)
			.map((fact) => fact.text)
			.join(""),
	).toBe(full.cv[0]?.text);
	expect(
		plan.batches
			.flatMap((batch) => batch.cv)
			.every((fact) => !fact.text.includes("\uFFFD") && !/\[LOCAL_\d*$/.test(fact.text)),
	).toBe(true);
	const outputs = plan.batches.map((batch) => ({
		direction: "en-ar" as const,
		sourceRevision: "revision",
		segments: batch.cv.map((fact) => ({
			sourceId: fact.id,
			text: fact.text,
			claims: [{ id: "claim", text: fact.text, evidenceIds: [fact.id], kind: "translation" as const }],
		})),
		notes: [],
	}));
	expect(() => mergeTranslationBatches(full, plan, outputs.slice(1))).toThrow("TRANSLATION_BATCH_INCOMPLETE");
	const merged = mergeTranslationBatches(full, plan, outputs);
	expect(merged.segments).toHaveLength(1);
	expect(merged.segments[0]?.text).toBe(full.cv[0]?.text);
	expect(merged.segments[0]?.claims.every((claim) => claim.evidenceIds[0] === "source-0")).toBe(true);
});

it("packs substantive Arabic CV passages into bounded parts instead of one call per paragraph", () => {
	const text =
		"نسق مراجعات شهرية مع 15 فريقا وربط مؤشرات الخدمة بسجل القرارات والمخاطر وخطة التحسين. خفض زمن إعداد التقارير بنسبة 22% عبر توحيد متطلبات البيانات ومعايير المراجعة.";
	const full = {
		...snapshot(Array.from({ length: 48 }, () => text)),
		direction: "ar-en" as const,
	};
	const plan = planTranslationBatches(
		{ ...full, translationProtection: { maskedSegments: full.cv, localMap: new Map(), assertions: [] } },
		budget,
	);
	expect(plan.batches.length).toBeLessThanOrEqual(12);
	for (const { cv } of plan.batches) {
		const payload = buildTranslationCheck(
			{ maskedSegments: cv, localMap: new Map(), assertions: [] },
			{
				direction: full.direction,
				sourceRevision: full.sourceRevision,
				segments: cv.map(({ id }) => ({
					sourceId: id,
					text: "Coordinated 15 teams and reduced reporting time by 22%.",
				})),
			},
			"part-1",
		);
		expect(cv.length).toBeLessThanOrEqual(18);
		expect(Buffer.byteLength(JSON.stringify(payload))).toBeLessThanOrEqual(compactTranslationCheckTargetBytes);
	}
	expect(plan.batches.flatMap(({ cv }) => cv.map(({ text }) => text))).toEqual(full.cv.map(({ text }) => text));
});

it("packs short Arabic labels across section boundaries without exceeding verifier budgets", () => {
	const full = {
		...snapshot(Array.from({ length: 448 }, () => "متابعة طلبات العملاء")),
		direction: "ar-en" as const,
	};
	full.cv = full.cv.map((fact, index) => ({ ...fact, section: `section-${Math.floor(index / 8)}` }));
	const plan = planTranslationBatches(
		{ ...full, translationProtection: { maskedSegments: full.cv, localMap: new Map(), assertions: [] } },
		budget,
	);
	expect(plan.batches).toHaveLength(25);
	expect(plan.batches.every(({ cv }) => cv.length <= 18)).toBe(true);
	expect(plan.batches.reduce((count, batch) => count + batch.cv.length, 0)).toBe(448);
});

it("packs Arabic-to-English prose into 24 to 28 parts and restores the admitted plan", () => {
	const arabic = "عملت على تحديث تقارير الأداء ومراجعة طلبات العملاء والتنسيق مع فريق التشغيل. ";
	const base = { ...snapshot(Array.from({ length: 76 }, () => arabic.repeat(6))), direction: "ar-en" as const };
	const full = { ...base, translationProtection: { maskedSegments: base.cv, localMap: new Map(), assertions: [] } };
	const plan = planTranslationBatches(full, budget);
	expect(plan.batches.length).toBeGreaterThanOrEqual(24);
	expect(plan.batches.length).toBeLessThanOrEqual(28);
	expect(restoreTranslationPlan(full, persistTranslationPlan(plan))).toEqual(plan);
});
