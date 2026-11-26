import { describe, expect, it } from "vite-plus/test";
import { matchJobDescription } from "./match";
import { matchingWindows, tokenize } from "./tokenize";

describe("tokenize", () => {
	it("keeps technical surface forms intact", () => {
		expect(tokenize("c++ and c# with .net")).toEqual(["c++", "and", "c#", "with", ".net"]);
		expect(tokenize("node.js, ci/cd, back-end")).toEqual(["node.js", "ci/cd", "back-end"]);
	});

	it("matches singular and plural possessives without altering the source span", () => {
		expect(tokenize("client's users' Node.js’s C++'s C# .net don't")).toEqual([
			"client",
			"users",
			"Node.js",
			"C++",
			"C#",
			".net",
			"don't",
		]);
		expect(matchingWindows("AWS’s Lambda", 2)).toContainEqual({
			text: "aws lambda",
			start: 0,
			end: 12,
			quote: "AWS’s Lambda",
		});
	});

	it("does not glue a sentence-ending full stop onto the next word", () => {
		expect(tokenize("shipped react. built node services")).toEqual(["shipped", "react", "built", "node", "services"]);
	});
});

describe("matchJobDescription", () => {
	it("matches a posting's abbreviation against the resume's spelled-out form", () => {
		const report = matchJobDescription({
			jobDescription: "Requirements\n- Strong K8s experience\n- Solid JS fundamentals",
			resumeText: "Ran Kubernetes clusters and wrote JavaScript services.",
		});

		expect(report.missingTerms).not.toContain("kubernetes");
		expect(report.missingTerms).not.toContain("javascript");
	});

	it("ignores the boilerplate every posting shares", () => {
		const report = matchJobDescription({
			jobDescription: "We are an equal opportunity employer offering a competitive salary and benefits package.",
			resumeText: "Engineer.",
		});

		expect(report.terms).toEqual([]);
		expect(report.weightedCoverage).toBe(0);
	});

	it("excludes English contractions and Arabic function words from keyword candidates", () => {
		const report = matchJobDescription({
			jobDescription: "You'll use React. We’re hiring. It’s TypeScript. Don’t use Java. وأيضا وفي حينما مع Kubernetes.",
			resumeText: "React, TypeScript, TypeScript, Kubernetes.",
		});

		expect(report.terms.map(({ term }) => term)).toEqual(
			expect.arrayContaining(["react", "typescript", "java", "kubernetes"]),
		);
		expect(report.terms.map(({ term }) => term).some((term) => /['’]|وأيضا|وفي|حينما/u.test(term))).toBe(false);
		expect(report.terms.find(({ term }) => term === "typescript")?.resumeCount).toBe(2);
	});

	it("drops generic standalone terms while keeping specific phrases and aliases", () => {
		const report = matchJobDescription({
			jobDescription: "Design, research, system design, user research, artificial intelligence, data pipelines",
			resumeText: "System design, user research, AI, data pipelines.",
		});

		expect(report.matchedTerms).toEqual(
			expect.arrayContaining(["system design", "user-research", "artificial-intelligence", "data-pipelines"]),
		);
		expect(report.terms.map(({ term }) => term)).not.toContain("design");
		expect(report.terms.map(({ term }) => term)).not.toContain("research");
	});

	it("flags a term the resume repeats far past what the posting asks for", () => {
		const report = matchJobDescription({
			jobDescription: "Requirements\n- Kubernetes experience",
			resumeText: "kubernetes ".repeat(12),
		});

		expect(report.stuffedTerms).toContain("kubernetes");
	});

	it("does not accuse a specialist of stuffing their own field", () => {
		// A game developer writes "Unity" in every role; the posting writes it once. That is a
		// resume doing its job, not someone gaming a search.
		const resumeText = [
			"Senior Game Developer at Cascade Studios, building gameplay systems in Unity for console and PC.",
			"Led the Unity migration for two shipped titles and mentored four engineers through it.",
			"Built custom Unity editor tooling that cut level iteration time by forty percent.",
			"Earlier: Unity gameplay programmer on a mobile title with two million installs.",
			"Wrote the studio's internal Unity style guide and ran its onboarding sessions.",
		].join(" ");

		const report = matchJobDescription({
			jobDescription: "Requirements\n- Strong Unity experience",
			resumeText,
		});

		expect(report.missingTerms).not.toContain("unity");
		expect(report.stuffedTerms).toEqual([]);
	});

	it("drops recruiting filler from a phrase rather than reporting it as its own gap", () => {
		const report = matchJobDescription({
			jobDescription: "Requirements\n- Deep C# knowledge and strong C++ expertise",
			resumeText: "Shipped systems in C# and C++.",
		});

		expect(report.terms.map((term) => term.term)).not.toContain("c# knowledge");
		expect(report.missingTerms).toEqual([]);
	});
});
