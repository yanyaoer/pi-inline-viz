import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { ARTIFACT_VERSION } from "../../src/artifact.ts";
import { MermaidArtifactAdapter } from "../../src/engines/mermaid.ts";
import type { MermaidBlock } from "../../src/parser/mermaid.ts";
import { RichMediaPipeline } from "../../src/pipeline.ts";
import { SvgAssetRenderer } from "../../src/renderer/svg.ts";
import { createFakeMermaidCli, readFakeMermaidArgs } from "../helpers/fake-mermaid-cli.ts";

test("renders Mermaid through a fixed CLI and browser policy", async () => {
	const root = await mkdtemp(join(tmpdir(), "agent-artifact-mermaid-test-"));
	try {
		const cli = await createFakeMermaidCli(root);
		const adapter = new MermaidArtifactAdapter({ mmdcCommand: cli.command, chromePath: cli.chrome });
		const pipeline = new RichMediaPipeline(adapter, new SvgAssetRenderer());
		const block = mermaidBlock("flowchart LR\n  user --> agent --> tool");
		const first = await pipeline.render({ artifact: block }, { cacheDirectory: join(root, "cache") });
		const second = await pipeline.render({ artifact: block }, { cacheDirectory: join(root, "cache") });

		assert.deepEqual(first.cacheHit, { content: false, asset: false });
		assert.deepEqual(second.cacheHit, { content: true, asset: true });
		assert.equal(await readFile(first.sourcePath, "utf8"), block.content);
		assert.match(await readFile(first.intermediate.path, "utf8"), /^<svg/);
		assert.deepEqual((await readFile(first.asset.path)).subarray(0, 8), Buffer.from("89504e470d0a1a0a", "hex"));

		const args = await readFakeMermaidArgs(cli.log);
		assert.ok(args.includes("--configFile"));
		assert.ok(args.includes("--puppeteerConfigFile"));
		assert.ok(args.includes("--backgroundColor"));
		assert.ok(args.includes("transparent"));
		assert.ok(!args.includes("--iconPacks"));
		assert.ok(!args.includes("--iconPacksNamesAndUrls"));

		const mermaidConfig = JSON.parse(
			await readFile(join(cli.log, "mermaid-config.json"), "utf8"),
		) as Record<string, unknown>;
		assert.equal(mermaidConfig.securityLevel, "strict");
		assert.equal(mermaidConfig.htmlLabels, false);
		assert.equal(mermaidConfig.deterministicIds, true);

		const puppeteerConfig = JSON.parse(
			await readFile(join(cli.log, "puppeteer-config.json"), "utf8"),
		) as { executablePath: string; args: string[] };
		assert.equal(puppeteerConfig.executablePath, cli.chrome);
		assert.ok(puppeteerConfig.args.includes("--proxy-server=http://127.0.0.1:9"));
		assert.ok(puppeteerConfig.args.includes("--proxy-bypass-list=<-loopback>"));

		const metadata = JSON.parse(await readFile(first.metadataPath, "utf8")) as {
			execution_policy: { network: string; filesystem: string };
		};
		assert.equal(metadata.execution_policy.network, "deny");
		assert.equal(metadata.execution_policy.filesystem, "isolated-workdir");
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

function mermaidBlock(content: string): MermaidBlock {
	return {
		version: ARTIFACT_VERSION,
		type: "diagram",
		format: "mermaid",
		content,
		startLine: 1,
		endLine: 3,
	};
}
