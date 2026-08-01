import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { validateMermaidSource, validateMermaidSvg } from "../../src/engines/mermaid.ts";

test("accepts a basic Mermaid flowchart", () => {
	assert.doesNotThrow(() => validateMermaidSource("flowchart LR\n  user --> agent --> tool"));
});

test("rejects empty, oversized, and control-character Mermaid", () => {
	assert.throws(() => validateMermaidSource(" \n"), /empty/);
	assert.throws(() => validateMermaidSource("x".repeat(256 * 1024 + 1)), /exceeds/);
	assert.throws(() => validateMermaidSource("flowchart LR\na\u0001 --> b"), /control character/);
});

test("rejects source-controlled configuration, links, images, and styles", () => {
	for (const [source, message] of [
		["---\nconfig:\n  securityLevel: loose\n---\nflowchart LR\na --> b", /frontmatter/],
		['%%{init: {"securityLevel": "loose"}}%%\nflowchart LR\na --> b', /configuration directives/],
		['flowchart LR\na --> b\nclick a "https://example.com"', /click directives/],
		['flowchart LR\na@{ img: "file:///etc/passwd" }', /external URLs/],
		['flowchart LR\na@{ img: "/etc/passwd" }', /image and icon shapes/],
		["flowchart LR\na --> b\nclassDef remote fill:url(//example.com/x)", /external URLs/],
		['flowchart LR\na["<img src=/etc/passwd>"]', /embedded HTML/],
		['flowchart LR\na@{ icon: "logos:github" }', /image and icon shapes/],
	] as const) {
		assert.throws(() => validateMermaidSource(source), message);
	}
});

test("rejects unsafe SVG output before it enters the shared asset pipeline", async () => {
	const root = await mkdtemp(join(tmpdir(), "agent-artifact-mermaid-svg-test-"));
	try {
		const path = join(root, "output.svg");
		await writeFile(path, '<svg xmlns="http://www.w3.org/2000/svg"><image href="file:///etc/passwd"/></svg>');
		await assert.rejects(validateMermaidSvg(path, 1024), /unsafe element/);
		await writeFile(
			path,
			'<svg xmlns="http://www.w3.org/2000/svg"><path onclick="alert(1)" d="M0 0"/></svg>',
		);
		await assert.rejects(validateMermaidSvg(path, 1024), /event handler/);
		await writeFile(
			path,
			'<svg xmlns="http://www.w3.org/2000/svg"><a href="https://example.com"><path d="M0 0"/></a></svg>',
		);
		await assert.rejects(validateMermaidSvg(path, 1024), /external reference/);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});
