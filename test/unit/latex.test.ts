import assert from "node:assert/strict";
import test from "node:test";

import { validateLatexSource } from "../../src/engines/latex.ts";

test("accepts a constrained set of common math commands", () => {
	assert.doesNotThrow(() => validateLatexSource(String.raw`\frac{QK^T}{\sqrt{d}} + \alpha \in \mathbb{R}`));
	assert.doesNotThrow(() => validateLatexSource(String.raw`\text{energy} = mc^2`));
});

test("rejects empty, oversized, malformed, and raw delimiter input", () => {
	assert.throws(() => validateLatexSource(" \n"), /empty/);
	assert.throws(() => validateLatexSource("x".repeat(256 * 1024 + 1)), /exceeds/);
	assert.throws(() => validateLatexSource(String.raw`\frac{a}{b`), /unbalanced braces/);
	assert.throws(() => validateLatexSource("E=$mc^2$"), /unescaped LaTeX character/);
});

test("rejects file, network, document, macro, and tokenization primitives", () => {
	for (const source of [
		String.raw`\input{/etc/passwd}`,
		String.raw`\include{secret}`,
		String.raw`\includegraphics{https://example.com/x.png}`,
		String.raw`\documentclass{article}`,
		String.raw`\usepackage{tikz}`,
		String.raw`\newcommand{\x}{secret}`,
		String.raw`\begin{tikzpicture}`,
		String.raw`\write18{whoami}`,
		String.raw`\special{raw renderer instruction}`,
		String.raw`\csname input\endcsname`,
		String.raw`\in^^70ut{/etc/passwd}`,
		"\\inp% comment\nut{/etc/passwd}",
	]) {
		assert.throws(() => validateLatexSource(source), /disabled/);
	}
});
