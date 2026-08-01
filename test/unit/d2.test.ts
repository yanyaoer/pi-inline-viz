import assert from "node:assert/strict";
import test from "node:test";

import { ARTIFACT_VERSION, resolveArtifactRenderRequest } from "../../src/artifact.ts";
import {
	D2ArtifactAdapter,
	normalizeD2Source,
	validateD2Source,
	withD2Palette,
} from "../../src/adapters/d2.ts";
import { DEFAULT_ARTIFACT_PALETTE } from "../../src/palette.ts";

test("accepts a basic architecture diagram", () => {
	assert.doesNotThrow(() => validateD2Source("direction: right\nuser -> agent -> tool"));
});

test("rejects empty and oversized D2", () => {
	assert.throws(() => validateD2Source(" \n"), /empty/);
	assert.throws(() => validateD2Source("x".repeat(256 * 1024 + 1)), /exceeds/);
});

test("rejects file imports in regular and spread forms", () => {
	assert.throws(() => validateD2Source("system: @/etc/passwd"), /imports are disabled/);
	assert.throws(() => validateD2Source("container: { ...@../secret }"), /imports are disabled/);
	assert.throws(() => validateD2Source("...@shared"), /imports are disabled/);
});

test("rejects icons because D2 can fetch local or remote resources", () => {
	assert.throws(() => validateD2Source("server.icon: https://example.com/server.svg"), /icons are disabled/);
	assert.throws(() => validateD2Source("server: { icon: ./secret.png }"), /icons are disabled/);
});

test("validates the semantic artifact and D2-specific theme", () => {
	const adapter = new D2ArtifactAdapter();
	const artifact = { version: ARTIFACT_VERSION, type: "diagram", format: "d2", content: "a -> b" } as const;
	assert.doesNotThrow(() => adapter.validate(resolveArtifactRenderRequest({ artifact })));
	assert.throws(
		() => adapter.validate(resolveArtifactRenderRequest({ artifact, options: { theme: "dark" } })),
		/D2 theme must be a non-negative integer/,
	);
	assert.throws(
		() => adapter.validate(resolveArtifactRenderRequest({ artifact: { ...artifact, format: "mermaid" } })),
		/D2 adapter cannot render diagram\/mermaid/,
	);
});

test("normalizes only known D2 node-shape compatibility aliases", () => {
	const source = [
		"note: { shape: note }",
		"store.shape: database # Graphviz-style database",
		"a -> b: { target-arrowhead.shape: box }",
	].join("\n");
	const normalized = normalizeD2Source(source);

	assert.equal(
		normalized.content,
		[
			"note: { shape: document }",
			"store.shape: cylinder # Graphviz-style database",
			"a -> b: { target-arrowhead.shape: box }",
		].join("\n"),
	);
	assert.deepEqual(normalized.fixes, [
		{
			from: "note",
			to: "document",
			reason: 'D2 represents note-like nodes with the "document" shape',
		},
		{
			from: "database",
			to: "cylinder",
			reason: 'D2 represents database-like nodes with the "cylinder" shape',
		},
	]);
});

test("does not rewrite comments, text, block strings, unknown shapes, or valid arrowhead boxes", () => {
	const source = [
		"# shape: note",
		'quoted: "shape: note}"',
		"single: '{ shape: database }'",
		"code: `{ shape: note }`",
		"markdown: |md",
		"  shape: note",
		"|",
		"unknown.shape: sticky-note",
		"notebook.shape: notebook",
		"a -> b: { target-arrowhead: { shape: box } }",
	].join("\n");

	assert.deepEqual(normalizeD2Source(source), { content: source, fixes: [] });
});

test("appends host-controlled D2 theme overrides without changing the cached source", () => {
	const themed = withD2Palette("a -> b", DEFAULT_ARTIFACT_PALETTE);

	assert.match(themed, /^a -> b\n\nvars:/);
	assert.match(themed, /N1: "#1f2328"/);
	assert.match(themed, /N7: "#f8f8f8"/);
	assert.match(themed, /B1: "#5a8080"/);
});
