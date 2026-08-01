import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ARTIFACT_VERSION } from "../src/artifact.ts";
import { GraphvizArtifactAdapter } from "../src/adapters/graphviz.ts";
import { ArtifactPipeline } from "../src/pipeline.ts";
import { SvgAssetRenderer } from "../src/renderer/svg.ts";

const root = await mkdtemp(join(tmpdir(), "pi-inline-viz-graphviz-smoke-"));
try {
	const artifact = {
		version: ARTIFACT_VERSION,
		type: "diagram",
		format: "dot",
		content: "digraph G { rankdir=LR; user -> agent -> tool }",
	} as const;
	const palette = {
		mode: "dark",
		background: "#18181e",
		foreground: "#d4d4d4",
		accent: "#8abeb7",
		muted: "#808080",
		border: "#5f87ff",
	} as const;
	const request = { artifact, options: { palette, background: palette.background } } as const;
	const adapter = new GraphvizArtifactAdapter();
	const pipeline = new ArtifactPipeline(adapter, new SvgAssetRenderer());
	const first = await pipeline.render(request, { cacheDirectory: root });
	const second = await pipeline.render(request, { cacheDirectory: root });

	assert.deepEqual(second.cacheHit, { content: true, asset: true });
	const svg = await readFile(first.intermediate.path, "utf8");
	assert.match(svg, /^<svg[\s>]/);
	assert.doesNotMatch(svg, /<!DOCTYPE|<\?xml/);
	for (const color of [palette.background, palette.foreground, palette.accent, palette.border]) {
		assert.ok(svg.includes(color), `Graphviz SVG should include ${color}`);
	}
	assert.deepEqual((await readFile(first.asset.path)).subarray(0, 8), Buffer.from("89504e470d0a1a0a", "hex"));

	const [svgFile, pngFile, identity] = await Promise.all([
		stat(first.intermediate.path),
		stat(first.asset.path),
		adapter.getIdentity(),
	]);
	process.stdout.write(
		`${JSON.stringify({
			ok: true,
			renderer: identity,
			cacheHitOnSecondRun: second.cacheHit,
			contentKey: first.contentKey,
			assetKey: first.key,
			svgBytes: svgFile.size,
			pngBytes: pngFile.size,
		})}\n`,
	);
} finally {
	await rm(root, { recursive: true, force: true });
}
