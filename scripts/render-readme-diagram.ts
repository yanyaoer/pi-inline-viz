import assert from "node:assert/strict";
import { copyFile, mkdir, mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { D2ArtifactAdapter } from "../src/engines/d2.ts";
import { extractD2Blocks } from "../src/parser/d2.ts";
import { RichMediaPipeline } from "../src/pipeline.ts";
import { SvgAssetRenderer } from "../src/renderer/svg.ts";

const root = await mkdtemp(join(tmpdir(), "pi-rich-readme-"));
try {
	const markdown = await readFile(new URL("../README.md", import.meta.url), "utf8");
	const block = extractD2Blocks(markdown)[0];
	assert.ok(block, "README must contain an architecture D2 block");

	const pipeline = new RichMediaPipeline(new D2ArtifactAdapter(), new SvgAssetRenderer());
	const artifact = await pipeline.render(block, { cacheDirectory: root });
	const docs = new URL("../docs/", import.meta.url);
	await mkdir(docs, { recursive: true });
	const output = new URL("architecture.png", docs);
	await copyFile(artifact.asset.path, output);
	const outputStats = await stat(output);

	process.stdout.write(
		`${JSON.stringify({
			ok: true,
			output: "docs/architecture.png",
			bytes: outputStats.size,
			contentKey: artifact.contentKey,
			assetKey: artifact.key,
		})}\n`,
	);
} finally {
	await rm(root, { recursive: true, force: true });
}
