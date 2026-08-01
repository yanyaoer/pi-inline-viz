import assert from "node:assert/strict";
import test from "node:test";

import { ARTIFACT_VERSION } from "../../src/artifact.ts";
import { extractD2Blocks } from "../../src/parser/d2.ts";
import { extractGraphvizBlocks } from "../../src/parser/graphviz.ts";
import { extractLatexBlocks } from "../../src/parser/latex.ts";
import { parseFencedCodeBlocks } from "../../src/parser/markdown.ts";
import { extractMermaidBlocks } from "../../src/parser/mermaid.ts";

test("extracts complete D2 fences and preserves source order", () => {
	const markdown = [
		"before",
		"```d2",
		"user -> agent",
		"```",
		"~~~D2 title=architecture",
		"agent -> tool",
		"~~~~",
	].join("\n");

	assert.deepEqual(extractD2Blocks(markdown), [
		{ version: ARTIFACT_VERSION, type: "diagram", format: "d2", content: "user -> agent", startLine: 2, endLine: 4 },
		{ version: ARTIFACT_VERSION, type: "diagram", format: "d2", content: "agent -> tool", startLine: 5, endLine: 7 },
	]);
});

test("does not treat a nested fence as a standalone block", () => {
	const markdown = [
		"````markdown",
		"```d2",
		"hidden -> diagram",
		"```",
		"````",
		"```d2",
		"visible -> diagram",
		"```",
	].join("\n");

	assert.deepEqual(extractD2Blocks(markdown), [
		{ version: ARTIFACT_VERSION, type: "diagram", format: "d2", content: "visible -> diagram", startLine: 6, endLine: 8 },
	]);
});

test("ignores unfinished fences", () => {
	assert.deepEqual(extractD2Blocks("```d2\na -> b"), []);
});

test("parses CRLF input and ignores non-D2 languages", () => {
	const blocks = parseFencedCodeBlocks("```ts\r\nconst x = 1\r\n```\r\n```d2\r\na -> b\r\n```");
	assert.equal(blocks.length, 2);
	assert.equal(blocks[0]?.language, "ts");
	assert.deepEqual(extractD2Blocks("```ts\r\nx\r\n```\r\n```d2\r\na -> b\r\n```"), [
		{ version: ARTIFACT_VERSION, type: "diagram", format: "d2", content: "a -> b", startLine: 4, endLine: 6 },
	]);
});

test("extracts complete Mermaid fences without conflating D2", () => {
	const markdown = [
		"```d2",
		"a -> b",
		"```",
		"~~~MERMAID",
		"flowchart LR",
		"  a --> b",
		"~~~",
	].join("\n");
	assert.deepEqual(extractMermaidBlocks(markdown), [
		{
			version: ARTIFACT_VERSION,
			type: "diagram",
			format: "mermaid",
			content: "flowchart LR\n  a --> b",
			startLine: 4,
			endLine: 7,
		},
	]);
});

test("extracts dot and graphviz fences into canonical DOT artifacts", () => {
	const markdown = [
		"```dot",
		"digraph G { a -> b }",
		"```",
		"~~~GRAPHVIZ",
		"graph G { a -- b }",
		"~~~",
	].join("\n");
	assert.deepEqual(extractGraphvizBlocks(markdown), [
		{
			version: ARTIFACT_VERSION,
			type: "diagram",
			format: "dot",
			content: "digraph G { a -> b }",
			startLine: 1,
			endLine: 3,
		},
		{
			version: ARTIFACT_VERSION,
			type: "diagram",
			format: "dot",
			content: "graph G { a -- b }",
			startLine: 4,
			endLine: 6,
		},
	]);
});

test("extracts inline and display LaTeX in source order", () => {
	const markdown = [
		"before $E=mc^2$",
		"$$",
		String.raw`QK^T/\sqrt d`,
		"$$",
		"`$hidden$`",
		"```markdown",
		"$hidden$",
		"```",
		String.raw`after $\alpha + \beta$`,
	].join("\n");

	assert.deepEqual(extractLatexBlocks(markdown), [
		{
			version: ARTIFACT_VERSION,
			type: "formula",
			format: "latex-inline",
			content: "E=mc^2",
			startLine: 1,
			endLine: 1,
		},
		{
			version: ARTIFACT_VERSION,
			type: "formula",
			format: "latex-display",
			content: String.raw`QK^T/\sqrt d`,
			startLine: 2,
			endLine: 4,
		},
		{
			version: ARTIFACT_VERSION,
			type: "formula",
			format: "latex-inline",
			content: String.raw`\alpha + \beta`,
			startLine: 9,
			endLine: 9,
		},
	]);
});

test("ignores escaped dollars, currency, code, and unfinished formulas", () => {
	const markdown = [String.raw`\$escaped$`, "Price is $5 and $10.", "``$code$``", "$$unfinished"].join("\n");
	assert.deepEqual(extractLatexBlocks(markdown), []);
});
