import assert from "node:assert/strict";
import test from "node:test";

import {
	graphvizArgumentsForPalette,
	validateGraphvizSource,
} from "../../src/adapters/graphviz.ts";
import { DEFAULT_ARTIFACT_PALETTE } from "../../src/palette.ts";

test("accepts graph and digraph DOT sources", () => {
	assert.doesNotThrow(() => validateGraphvizSource("digraph G { user -> agent -> tool }"));
	assert.doesNotThrow(() => validateGraphvizSource("// safe\nstrict graph { a -- b }"));
});

test("maps the artifact palette to Graphviz command-line defaults", () => {
	const args = graphvizArgumentsForPalette({
		...DEFAULT_ARTIFACT_PALETTE,
		mode: "dark",
		background: "#18181e",
		foreground: "#d4d4d4",
		accent: "#8abeb7",
	});
	assert.ok(args.includes("-Gbgcolor=#18181e"));
	assert.ok(args.includes("-Gfontcolor=#d4d4d4"));
	assert.ok(args.includes("-Ncolor=#8abeb7"));
	assert.ok(args.includes("-Nstyle=filled"));
});

test("rejects empty, oversized, malformed, and control-character DOT", () => {
	assert.throws(() => validateGraphvizSource(" \n"), /empty/);
	assert.throws(() => validateGraphvizSource("x".repeat(256 * 1024 + 1)), /exceeds/);
	assert.throws(() => validateGraphvizSource("a -> b"), /must start with graph or digraph/);
	assert.throws(() => validateGraphvizSource("digraph G { a\u0001 -> b }"), /control character/);
});

test("rejects DOT attributes that can read files or emit external links", () => {
	for (const source of [
		'digraph G { a [image="/etc/passwd"] }',
		'digraph G { graph [stylesheet="https://example.com/theme.css"] }',
		'digraph G { graph [fontpath="/tmp/fonts"] }',
		'digraph G { a [fontname="/tmp/font.ttf"] }',
		'digraph G { a [URL="https://example.com"] }',
		'digraph G { a [label=<<IMG SRC="/etc/passwd"/>>] }',
		'digraph G { a [shapefile="/etc/passwd"] }',
		'digraph G { graph [_background="I 0 0 10 10 11 -/etc/passwd"] }',
		'digraph G { "image" /* hidden */ = "/etc/passwd" }',
		'digraph G { "im" + "age" = "/etc/passwd" }',
		'digraph G { "im\\age" = "/etc/passwd" }',
	] as const) {
		assert.throws(() => validateGraphvizSource(source), /disabled for automatic rendering/);
	}
});

test("does not interpret resource-looking words inside comments or quoted labels", () => {
	assert.doesNotThrow(() =>
		validateGraphvizSource([
			"digraph G {",
			'  // image="/etc/passwd"',
			'  a [label="href=https://example.com and fontname=/tmp/font"]',
			"  /* stylesheet=file:///tmp/theme.css */",
			"}",
		].join("\n")),
	);
});
