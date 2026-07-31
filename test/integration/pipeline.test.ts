import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { D2ContentRenderer } from "../../src/engines/d2.ts";
import type { D2Block } from "../../src/parser/d2.ts";
import { RichMediaPipeline } from "../../src/pipeline.ts";
import { SvgAssetRenderer } from "../../src/renderer/svg.ts";

test("renders D2 to cached SVG and PNG assets", async (context) => {
	if (!hasCommand("d2") || (!hasCommand("rsvg-convert") && !hasCommand("magick"))) {
		context.skip("requires d2 and either rsvg-convert or magick");
		return;
	}

	const root = await mkdtemp(join(tmpdir(), "pi-rich-integration-"));
	try {
		const pipeline = new RichMediaPipeline(new D2ContentRenderer(), new SvgAssetRenderer());
		const block = d2Block("direction: right\nuser -> agent -> tool");
		const first = await pipeline.render(block, { cacheDirectory: root });
		const second = await pipeline.render(block, { cacheDirectory: root });
		const scaled = await pipeline.render(block, { cacheDirectory: root, profile: { scale: 2 } });

		assert.deepEqual(first.cacheHit, { content: false, asset: false });
		assert.deepEqual(second.cacheHit, { content: true, asset: true });
		assert.deepEqual(scaled.cacheHit, { content: true, asset: false });
		assert.equal(second.key, first.key);
		assert.equal(scaled.contentKey, first.contentKey);
		assert.notEqual(scaled.key, first.key);
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
			resource_budget: { network: boolean };
			asset_renderer: { id: string; version: string };
		};
		assert.equal(metadata.resource_budget.network, false);
		assert.ok(["rsvg-convert", "magick"].includes(metadata.asset_renderer.id));
		assert.notEqual(metadata.asset_renderer.version, "unknown");
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
		const pipeline = new RichMediaPipeline(new D2ContentRenderer(), new SvgAssetRenderer());
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
