import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { ARTIFACT_VERSION } from "../../src/artifact.ts";
import { GraphvizArtifactAdapter } from "../../src/adapters/graphviz.ts";
import { ArtifactPipeline } from "../../src/pipeline.ts";
import { SvgAssetRenderer } from "../../src/renderer/svg.ts";
import { createFakeGraphvizCli, readFakeGraphvizArgs } from "../helpers/fake-graphviz-cli.ts";

test("renders Graphviz DOT through the shared SVG and raster cache", async () => {
	const root = await mkdtemp(join(tmpdir(), "pi-inline-viz-graphviz-test-"));
	try {
		const cli = await createFakeGraphvizCli(root);
		const adapter = new GraphvizArtifactAdapter({ dotCommand: cli.command });
		const pipeline = new ArtifactPipeline(adapter, new SvgAssetRenderer());
		const artifact = {
			version: ARTIFACT_VERSION,
			type: "diagram",
			format: "dot",
			content: "digraph G { user -> agent -> tool }",
		} as const;
		const options = {
			palette: {
				mode: "dark",
				background: "#18181e",
				foreground: "#d4d4d4",
				accent: "#8abeb7",
				muted: "#808080",
				border: "#5f87ff",
			} as const,
			background: "#18181e" as const,
		};
		const cacheDirectory = join(root, "cache");
		const first = await pipeline.render({ artifact, options }, { cacheDirectory });
		const second = await pipeline.render({ artifact, options }, { cacheDirectory });

		assert.deepEqual(first.cacheHit, { content: false, asset: false });
		assert.deepEqual(second.cacheHit, { content: true, asset: true });
		assert.equal(await readFile(first.sourcePath, "utf8"), artifact.content);
		const svg = await readFile(first.intermediate.path, "utf8");
		assert.match(svg, /^<svg[\s>]/);
		assert.doesNotMatch(svg, /<!DOCTYPE|<\?xml/);
		assert.deepEqual((await readFile(first.asset.path)).subarray(0, 8), Buffer.from("89504e470d0a1a0a", "hex"));

		const args = await readFakeGraphvizArgs(cli.log);
		assert.ok(args.includes("-Tsvg"));
		assert.ok(args.includes("-Gbgcolor=#18181e"));
		assert.ok(args.includes("-Ncolor=#8abeb7"));
		assert.ok(args.includes("-Ecolor=#5f87ff"));
		assert.match((await adapter.getIdentity()).version, /dot=dot - graphviz version 15\.1\.0/);

		const metadata = JSON.parse(await readFile(first.metadataPath, "utf8")) as {
			execution_policy: { network: string; filesystem: string };
		};
		assert.equal(metadata.execution_policy.network, "deny");
		assert.equal(metadata.execution_policy.filesystem, "isolated-workdir");
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});
