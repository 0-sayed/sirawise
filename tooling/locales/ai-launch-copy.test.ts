import { readFile } from "node:fs/promises";
import { expect, it } from "vite-plus/test";
import { formatter } from "@lingui/format-po";
import { type CopyContractInput, validateCopyBindings } from "./copy-contract";

it("binds AI launch recovery and local interview availability to Arabic and English catalogs", async () => {
	const deck = JSON.parse(
		await readFile(new URL("../../Planning/context/design/copy-deck.json", import.meta.url), "utf8"),
	) as CopyContractInput["deck"];
	const entries = deck.entries.filter(
		(entry) => entry.key.startsWith("review.launch.") || entry.key === "reviewGuide.ai.interview.location",
	);
	expect(entries.map((entry) => entry.key)).toEqual(
		expect.arrayContaining([
			"review.launch.budgetReached",
			"review.launch.allowanceUsed",
			"review.launch.consentRequired",
			"review.launch.translationStructure",
			"review.launch.busy",
			"review.launch.providerError",
			"review.launch.requestChanged",
			"review.launch.reviewConsent",
			"review.launch.documentLimit",
			"review.launch.jobRequired",
			"review.launch.jobTextRequired",
			"review.launch.unexpectedError",
			"review.launch.sourceChanged",
			"review.launch.sourceUnavailable",
			"review.launch.sourceLocked",
			"reviewGuide.ai.interview.location",
		]),
	);
	expect(entries.find(({ key }) => key === "reviewGuide.ai.interview.location")?.messages).toEqual({
		"ar-SA": "غير متاح في المشغّل المحلي. يظل التحضير للمقابلة مخصصًا للتقييم فقط.",
		"en-US": "Not available in the local launcher. Interview preparation remains benchmark-only.",
	});
	const parse = async (locale: "ar-SA" | "en-US") =>
		formatter().parse(await readFile(new URL(`../../apps/web/locales/${locale}.po`, import.meta.url), "utf8"), {
			locale,
			sourceLocale: "en-US",
			filename: `${locale}.po`,
		});
	const [ar, en] = await Promise.all([parse("ar-SA"), parse("en-US")]);
	expect(
		validateCopyBindings({
			deck: { entries },
			surfaces: [
				{
					id: "ai-launch",
					status: "active",
					sources: ["src/features/assistant/copy.generated.ts", "src/features/ats-guide/ai-features.ts"],
					keys: entries.map((entry) => entry.key),
					owner: "B-C04",
					gate: null,
				},
			],
			catalogs: { "ar-SA": ar, "en-US": en },
		}),
	).toEqual([]);
});
