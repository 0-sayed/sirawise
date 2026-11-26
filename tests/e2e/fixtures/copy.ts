import { readFileSync } from "node:fs";

const deck = JSON.parse(readFileSync("Planning/context/design/copy-deck.json", "utf8")) as {
	entries: Array<{ key: string; messages: Record<"en-US" | "ar-SA", string> }>;
};

/** Literal delivered copy. Keep parameterized messages in tests that supply their actual values. */
export function copyMessage(key: string, locale: "en-US" | "ar-SA" = "en-US") {
	const message = deck.entries.find((entry) => entry.key === key)?.messages[locale];
	if (!message || message.includes("{")) throw new Error(`Expected literal delivered copy: ${key} (${locale})`);
	return message;
}
