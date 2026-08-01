import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { D2ArtifactAdapter } from "../../src/engines/d2.ts";
import type { D2Block } from "../../src/parser/d2.ts";
import { RichMediaPipeline } from "../../src/pipeline.ts";
import { SvgAssetRenderer } from "../../src/renderer/svg.ts";
import { DEFAULT_RENDER_PROFILE, DEFAULT_RESOURCE_BUDGET } from "../../src/renderer/types.ts";

test("renders D2 to cached SVG and PNG assets", async (context) => {
	if (!hasCommand("d2") || (!hasCommand("rsvg-convert") && !hasCommand("magick"))) {
		context.skip("requires d2 and either rsvg-convert or magick");
		return;
	}

	const root = await mkdtemp(join(tmpdir(), "pi-rich-integration-"));
	try {
		const pipeline = new RichMediaPipeline(new D2ArtifactAdapter(), new SvgAssetRenderer());
		const block = d2Block("direction: right\nuser -> agent -> tool");
		const first = await pipeline.render(block, { cacheDirectory: root });
		const second = await pipeline.render(block, { cacheDirectory: root });
		const scaled = await pipeline.render(block, { cacheDirectory: root, profile: { scale: 2 } });
		const white = await pipeline.render(block, {
			cacheDirectory: root,
			profile: { background: "white" },
		});

		assert.deepEqual(first.cacheHit, { content: false, asset: false });
		assert.deepEqual(second.cacheHit, { content: true, asset: true });
		assert.deepEqual(scaled.cacheHit, { content: true, asset: false });
		assert.deepEqual(white.cacheHit, { content: true, asset: false });
		assert.equal(second.key, first.key);
		assert.equal(scaled.contentKey, first.contentKey);
		assert.notEqual(scaled.key, first.key);
		assert.notEqual(white.key, first.key);
		assert.equal(await readFile(first.sourcePath, "utf8"), block.content);
		assert.match(await readFile(first.intermediate.path, "utf8"), /<svg/);
		assert.deepEqual((await readFile(first.asset.path)).subarray(0, 8), Buffer.from("89504e470d0a1a0a", "hex"));
		assert.ok((await stat(first.metadataPath)).size > 0);
		assert.deepEqual(await readdir(root), [first.contentKey]);
		assert.deepEqual((await readdir(join(root, first.contentKey))).sort(), [
			"metadata.json",
			"output.svg",
			"renders",
			"source.d2",
		]);
		const metadata = JSON.parse(await readFile(first.metadataPath, "utf8")) as {
			version: number;
			resource_budget: { network: boolean };
			asset_renderer: { id: string; version: string };
			source_hash: string;
			background: string;
		};
		assert.equal(metadata.version, 3);
		assert.equal(metadata.resource_budget.network, false);
		assert.equal(metadata.source_hash, first.sourceHash);
		assert.equal(metadata.background, "transparent");
		assert.ok(["rsvg-convert", "magick"].includes(metadata.asset_renderer.id));
		assert.notEqual(metadata.asset_renderer.version, "unknown");
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("materializes explicit transparent and white background policies", async (context) => {
	if (!hasCommand("rsvg-convert") && !hasCommand("magick")) {
		context.skip("requires rsvg-convert or magick");
		return;
	}

	const root = await mkdtemp(join(tmpdir(), "pi-rich-background-integration-"));
	try {
		const source = join(root, "source.svg");
		await writeFile(
			source,
			'<svg xmlns="http://www.w3.org/2000/svg" width="2" height="2"><rect width="1" height="1" fill="red"/></svg>',
		);
		const renderer = new SvgAssetRenderer();
		const asset = { format: "svg", mediaType: "image/svg+xml", path: source } as const;
		const transparent = await renderer.render(asset, {
			outputPath: join(root, "transparent.png"),
			profile: DEFAULT_RENDER_PROFILE,
			budget: DEFAULT_RESOURCE_BUDGET,
		});
		const white = await renderer.render(asset, {
			outputPath: join(root, "white.png"),
			profile: { ...DEFAULT_RENDER_PROFILE, background: "white" },
			budget: DEFAULT_RESOURCE_BUDGET,
		});
		assert.notDeepEqual(await readFile(transparent.path), await readFile(white.path));
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("reports invalid D2 and removes partial cache files", async (context) => {
	if (!hasCommand("d2")) {
		context.skip("requires d2");
		return;
	}

	const root = await mkdtemp(join(tmpdir(), "pi-rich-integration-error-"));
	try {
		const pipeline = new RichMediaPipeline(new D2ArtifactAdapter(), new SvgAssetRenderer());
		await assert.rejects(pipeline.render(d2Block("broken: {"), { cacheDirectory: root }), /d2 failed:/);
		assert.deepEqual(await readdir(root), []);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

function hasCommand(command: string): boolean {
	try {
		execFileSync(command, ["--version"], { stdio: "ignore", timeout: 2_000 });
		return true;
	} catch {
		return false;
	}
}

function d2Block(content: string): D2Block {
	return { type: "diagram", language: "d2", content, startLine: 1, endLine: 3 };
}
