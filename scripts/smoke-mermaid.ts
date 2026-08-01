import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ARTIFACT_VERSION } from "../src/artifact.ts";
import { MermaidArtifactAdapter } from "../src/engines/mermaid.ts";
import { RichMediaPipeline } from "../src/pipeline.ts";
import { SvgAssetRenderer } from "../src/renderer/svg.ts";

const root = await mkdtemp(join(tmpdir(), "agent-artifact-mermaid-smoke-"));
try {
	const block = {
		version: ARTIFACT_VERSION,
		type: "diagram",
		format: "mermaid",
		content: "flowchart LR\n  user --> agent --> tool",
	} as const;
	const pipeline = new RichMediaPipeline(new MermaidArtifactAdapter(), new SvgAssetRenderer());
	const first = await pipeline.render({ artifact: block }, { cacheDirectory: root });
	const second = await pipeline.render({ artifact: block }, { cacheDirectory: root });
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
