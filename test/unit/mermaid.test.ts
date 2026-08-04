import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
	mermaidConfigForPalette,
	mergeWordTspans,
	validateMermaidSource,
	validateMermaidSvg,
} from "../../src/adapters/mermaid.ts";
import { DEFAULT_ARTIFACT_PALETTE } from "../../src/palette.ts";

test("accepts a basic Mermaid flowchart", () => {
	assert.doesNotThrow(() => validateMermaidSource("flowchart LR\n  user --> agent --> tool"));
});

test("maps the artifact palette into Mermaid base-theme variables", () => {
	const config = mermaidConfigForPalette({
		...DEFAULT_ARTIFACT_PALETTE,
		mode: "dark",
		background: "#18181e",
		foreground: "#d4d4d4",
		accent: "#8abeb7",
	}) as { theme: string; themeVariables: Record<string, unknown> };

	assert.equal(config.theme, "base");
	assert.equal(config.themeVariables.darkMode, true);
	assert.equal(config.themeVariables.background, "#18181e");
	assert.equal(config.themeVariables.primaryTextColor, "#d4d4d4");
	assert.equal(config.themeVariables.primaryBorderColor, "#8abeb7");
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

test("merges consecutive mermaid word tspans into one tspan with spaces", () => {
	const svg = `<svg xmlns="http://www.w3.org/2000/svg"><text y="-10.1"><tspan class="text-outer-tspan row" x="0" dy="1.1em"><tspan font-style="normal" class="text-inner-tspan" font-weight="normal">natural</tspan><tspan font-style="normal" class="text-inner-tspan" font-weight="normal"> language</tspan><tspan font-style="normal" class="text-inner-tspan" font-weight="normal"> request</tspan></tspan></text></svg>`;
	const merged = mergeWordTspans(svg);
	assert.equal(
		merged,
		`<svg xmlns="http://www.w3.org/2000/svg"><text y="-10.1"><tspan class="text-outer-tspan row" x="0" dy="1.1em"><tspan font-style="normal" class="text-inner-tspan" font-weight="normal">natural language request</tspan></tspan></text></svg>`,
	);
});

test("keeps separate rows of a multiline label separate", () => {
	const svg = `<svg xmlns="http://www.w3.org/2000/svg"><text y="-10.1"><tspan class="text-outer-tspan row" x="0" dy="1.1em"><tspan font-style="normal" class="text-inner-tspan" font-weight="normal">Child</tspan><tspan font-style="normal" class="text-inner-tspan" font-weight="normal"> Pi</tspan><tspan font-style="normal" class="text-inner-tspan" font-weight="normal"> session</tspan></tspan><tspan class="text-outer-tspan row" x="0" dy="1.1em"><tspan font-style="normal" class="text-inner-tspan" font-weight="normal">scout</tspan><tspan font-style="normal" class="text-inner-tspan" font-weight="normal"> /</tspan><tspan font-style="normal" class="text-inner-tspan" font-weight="normal"> researcher</tspan></tspan></text></svg>`;
	const merged = mergeWordTspans(svg);
	assert.equal(
		merged,
		`<svg xmlns="http://www.w3.org/2000/svg"><text y="-10.1"><tspan class="text-outer-tspan row" x="0" dy="1.1em"><tspan font-style="normal" class="text-inner-tspan" font-weight="normal">Child Pi session</tspan></tspan><tspan class="text-outer-tspan row" x="0" dy="1.1em"><tspan font-style="normal" class="text-inner-tspan" font-weight="normal">scout / researcher</tspan></tspan></text></svg>`,
	);
});

test("preserves XML entities while merging word tspans", () => {
	const svg = `<svg xmlns="http://www.w3.org/2000/svg"><text><tspan class="text-inner-tspan">rock</tspan><tspan class="text-inner-tspan"> &amp; </tspan><tspan class="text-inner-tspan">roll</tspan></text></svg>`;
	const merged = mergeWordTspans(svg);
	assert.equal(merged, `<svg xmlns="http://www.w3.org/2000/svg"><text><tspan class="text-inner-tspan">rock &amp; roll</tspan></text></svg>`);
});

test("leaves non-mermaid tspans and single word tspans untouched", () => {
	const svg = `<svg xmlns="http://www.w3.org/2000/svg"><text><tspan x="10">plain</tspan><tspan class="text-inner-tspan" x="20" y="30">positioned</tspan><tspan class="text-inner-tspan">single</tspan></text></svg>`;
	assert.equal(mergeWordTspans(svg), svg);
});

test("is a no-op when the SVG has no mermaid word tspans", () => {
	const svg = `<svg xmlns="http://www.w3.org/2000/svg"><text>just text</text></svg>`;
	assert.equal(mergeWordTspans(svg), svg);
});

test("merging is idempotent", () => {
	const svg = `<svg xmlns="http://www.w3.org/2000/svg"><text><tspan class="text-inner-tspan">a</tspan><tspan class="text-inner-tspan"> b</tspan><tspan class="text-inner-tspan"> c</tspan></text></svg>`;
	const once = mergeWordTspans(svg);
	assert.equal(mergeWordTspans(once), once);
});
