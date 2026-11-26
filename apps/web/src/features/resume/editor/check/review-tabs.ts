import { msg } from "@lingui/core/macro";

export const reviewTabs = [
	{ id: "ats", icon: "file-text", label: msg`Machine readability (ATS)` },
	{ id: "data", icon: "database", label: msg`Information completeness` },
	{ id: "ai", icon: "sparkle", label: msg({ message: "AI", context: "reviewGuide.tabs.ai" }) },
] as const;
