import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { RichMediaPipeline } from "../../src/pipeline.ts";
import type {
	Asset,
	AssetRenderer,
	AssetRenderContext,
	ContentRenderer,
	ContentRenderContext,
	RendererIdentity,
	RichBlock,
} from "../../src/renderer/types.ts";

const PNG = Buffer.from(
	"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
	"base64",
);

test("reuses SVG across raster profiles and keys renderer versions", async () => {
	const root = await mkdtemp(join(tmpdir(), "pi-rich-pipeline-test-"));
	try {
		const contentRenderer = new FakeContentRenderer("d2-v1");
		const assetRenderer = new FakeAssetRenderer("raster-v1");
		const pipeline = new RichMediaPipeline(contentRenderer, assetRenderer);
		const block: RichBlock = {
			type: "diagram",
			language: "d2",
			content: "a -> b",
			startLine: 1,
			endLine: 3,
		};

		const first = await pipeline.render(block, { cacheDirectory: root });
		const second = await pipeline.render(block, { cacheDirectory: root });
		const scaled = await pipeline.render(block, { cacheDirectory: root, profile: { scale: 2 } });

		assert.deepEqual(first.cacheHit, { content: false, asset: false });
		assert.deepEqual(second.cacheHit, { content: true, asset: true });
		assert.deepEqual(scaled.cacheHit, { content: true, asset: false });
		assert.equal(first.contentKey, scaled.contentKey);
		assert.notEqual(first.key, scaled.key);
		assert.equal(contentRenderer.validations, 3);
		assert.equal(contentRenderer.renders, 1);
		assert.equal(assetRenderer.renders, 2);
		assert.equal(await readFile(first.sourcePath, "utf8"), block.content);

		const upgradedRenderer = new FakeContentRenderer("d2-v2");
		const upgraded = await new RichMediaPipeline(upgradedRenderer, assetRenderer).render(block, {
			cacheDirectory: root,
		});
		assert.notEqual(upgraded.contentKey, first.contentKey);
		assert.equal(upgradedRenderer.validations, 1);
		assert.equal(upgradedRenderer.renders, 1);

		const metadata = JSON.parse(await readFile(first.metadataPath, "utf8")) as {
			resource_budget: { network: boolean };
			asset_renderer: RendererIdentity;
		};
		assert.equal(metadata.resource_budget.network, false);
		assert.deepEqual(metadata.asset_renderer, { id: "fake-raster", version: "raster-v1" });
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("rebuilds cached assets that violate the current resource budget", async () => {
	const root = await mkdtemp(join(tmpdir(), "pi-rich-pipeline-budget-test-"));
	try {
		const contentRenderer = new FakeContentRenderer("d2-v1");
		const assetRenderer = new FakeAssetRenderer("raster-v1");
		const pipeline = new RichMediaPipeline(contentRenderer, assetRenderer);
		const block: RichBlock = {
			type: "diagram",
			language: "d2",
			content: "a -> b",
			startLine: 1,
			endLine: 3,
		};

		const first = await pipeline.render(block, { cacheDirectory: root });
		await writeFile(first.intermediate.path, "x".repeat(101));
		const rebuiltContent = await pipeline.render(block, {
			cacheDirectory: root,
			budget: { maxOutputBytes: 100 },
		});
		assert.deepEqual(rebuiltContent.cacheHit, { content: false, asset: false });

		await writeFile(rebuiltContent.asset.path, Buffer.alloc(101));
		const rebuiltAsset = await pipeline.render(block, {
			cacheDirectory: root,
			budget: { maxOutputBytes: 100 },
		});
		assert.deepEqual(rebuiltAsset.cacheHit, { content: true, asset: false });
		assert.equal(contentRenderer.renders, 2);
		assert.equal(assetRenderer.renders, 3);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

class FakeContentRenderer implements ContentRenderer<RichBlock> {
	readonly sourceFilename = "source.d2";
	validations = 0;
	renders = 0;
	readonly #version: string;

	constructor(version: string) {
		this.#version = version;
	}

	validate(): void {
		this.validations += 1;
	}

	async getIdentity(): Promise<RendererIdentity> {
		return { id: "fake-content", version: this.#version };
	}

	async render(_block: RichBlock, context: ContentRenderContext): Promise<Asset> {
		this.renders += 1;
		await writeFile(context.outputPath, "<svg/>");
		return { format: "svg", mediaType: "image/svg+xml", path: context.outputPath };
	}
}

class FakeAssetRenderer implements AssetRenderer {
	renders = 0;
	readonly #version: string;

	constructor(version: string) {
		this.#version = version;
	}

	async getIdentity(): Promise<RendererIdentity> {
		return { id: "fake-raster", version: this.#version };
	}

	async render(_asset: Asset, context: AssetRenderContext): Promise<Asset> {
		this.renders += 1;
		await writeFile(context.outputPath, PNG);
		return { format: "png", mediaType: "image/png", path: context.outputPath };
	}
}
