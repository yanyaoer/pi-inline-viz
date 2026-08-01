import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { MermaidArtifactAdapter } from "../src/engines/mermaid.ts";
import { RichMediaPipeline } from "../src/pipeline.ts";
import { SvgAssetRenderer } from "../src/renderer/svg.ts";

const root = await mkdtemp(join(tmpdir(), "agent-artifact-mermaid-smoke-"));
try {
	const block = {
		type: "diagram",
		language: "mermaid",
		content: "flowchart LR\n  user --> agent --> tool",
		startLine: 1,
		endLine: 2,
	} as const;
	const pipeline = new RichMediaPipeline(new MermaidArtifactAdapter(), new SvgAssetRenderer());
	const first = await pipeline.render(block, { cacheDirectory: root });
	const second = await pipeline.render(block, { cacheDirectory: root });
	assert.deepEqual(second.cacheHit, { content: true, asset: true });
	assert.match(await readFile(first.intermediate.path, "utf8"), /^<svg[\s>]/);
	assert.deepEqual((await readFile(first.asset.path)).subarray(0, 8), Buffer.from("89504e470d0a1a0a", "hex"));

	const [svg, png] = await Promise.all([stat(first.intermediate.path), stat(first.asset.path)]);
	process.stdout.write(
		`${JSON.stringify({
			ok: true,
			cacheHitOnSecondRun: second.cacheHit,
			contentKey: first.contentKey,
			assetKey: first.key,
			svgBytes: svg.size,
			pngBytes: png.size,
		})}\n`,
	);
} finally {
	await rm(root, { recursive: true, force: true });
}
