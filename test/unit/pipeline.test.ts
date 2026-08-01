import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
	ARTIFACT_VERSION,
	DEFAULT_EXECUTION_POLICY,
	type Artifact,
	type ResolvedArtifactRenderRequest,
} from "../../src/artifact.ts";
import { RichMediaPipeline } from "../../src/pipeline.ts";
import type {
	Asset,
	AssetRenderer,
	AssetRenderContext,
	ArtifactAdapter,
	ContentRenderContext,
	RendererIdentity,
} from "../../src/renderer/types.ts";

const PNG = Buffer.from(
	"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
	"base64",
);

test("reuses SVG across raster profiles and keys renderer versions", async () => {
	const root = await mkdtemp(join(tmpdir(), "pi-rich-pipeline-test-"));
	try {
		const contentRenderer = new FakeArtifactAdapter("d2-v1");
		const assetRenderer = new FakeAssetRenderer("raster-v1");
		const pipeline = new RichMediaPipeline(contentRenderer, assetRenderer);
		const artifact: Artifact = {
			version: ARTIFACT_VERSION,
			type: "diagram",
			format: "d2",
			content: "a -> b",
		};
		const annotated = { ...artifact, startLine: 99, comment: "ignored" };

		const first = await pipeline.render({ artifact }, { cacheDirectory: root });
		const second = await pipeline.render({ artifact: annotated }, { cacheDirectory: root });
		const scaled = await pipeline.render({ artifact, options: { scale: 2 } }, { cacheDirectory: root });
		const white = await pipeline.render(
			{ artifact, options: { background: "white" } },
			{ cacheDirectory: root },
		);
		const policyOnly = await pipeline.render(
			{ artifact, policy: { ...DEFAULT_EXECUTION_POLICY, timeoutMs: 1_000 } },
			{ cacheDirectory: root },
		);

		assert.deepEqual(first.cacheHit, { content: false, asset: false });
		assert.deepEqual(second.cacheHit, { content: true, asset: true });
		assert.deepEqual(scaled.cacheHit, { content: true, asset: false });
		assert.equal(first.contentKey, scaled.contentKey);
		assert.notEqual(first.key, scaled.key);
		assert.equal(white.contentKey, first.contentKey);
		assert.notEqual(white.key, first.key);
		assert.deepEqual(policyOnly.cacheHit, { content: true, asset: true });
		assert.equal(policyOnly.contentKey, first.contentKey);
		assert.equal(policyOnly.key, first.key);
		assert.equal(contentRenderer.validations, 5);
		assert.equal(contentRenderer.renders, 1);
		assert.equal(assetRenderer.renders, 3);
		assert.equal(await readFile(first.sourcePath, "utf8"), artifact.content);

		const upgradedRenderer = new FakeArtifactAdapter("d2-v2");
		const upgraded = await new RichMediaPipeline(upgradedRenderer, assetRenderer).render(
			{ artifact },
			{ cacheDirectory: root },
		);
		assert.notEqual(upgraded.contentKey, first.contentKey);
		assert.equal(upgradedRenderer.validations, 1);
		assert.equal(upgradedRenderer.renders, 1);

		const metadata = JSON.parse(await readFile(first.metadataPath, "utf8")) as {
			execution_policy: { network: string; filesystem: string };
			asset_renderer: RendererIdentity;
			source_hash: string;
			quality: string;
			background: string;
		};
		assert.equal(metadata.execution_policy.network, "deny");
		assert.equal(metadata.execution_policy.filesystem, "isolated-workdir");
		assert.deepEqual(metadata.asset_renderer, { id: "fake-raster", version: "raster-v1" });
		assert.equal(metadata.source_hash, first.sourceHash);
		assert.equal(metadata.quality, "default");
		assert.equal(metadata.background, "transparent");
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("rebuilds cached assets that violate the current execution policy", async () => {
	const root = await mkdtemp(join(tmpdir(), "pi-rich-pipeline-budget-test-"));
	try {
		const contentRenderer = new FakeArtifactAdapter("d2-v1");
		const assetRenderer = new FakeAssetRenderer("raster-v1");
		const pipeline = new RichMediaPipeline(contentRenderer, assetRenderer);
		const artifact: Artifact = {
			version: ARTIFACT_VERSION,
			type: "diagram",
			format: "d2",
			content: "a -> b",
		};

		const first = await pipeline.render({ artifact }, { cacheDirectory: root });
		await writeFile(first.intermediate.path, "x".repeat(101));
		const rebuiltContent = await pipeline.render(
			{ artifact, policy: { ...DEFAULT_EXECUTION_POLICY, maxOutputBytes: 100 } },
			{ cacheDirectory: root },
		);
		assert.deepEqual(rebuiltContent.cacheHit, { content: false, asset: false });

		await writeFile(rebuiltContent.asset.path, Buffer.alloc(101));
		const rebuiltAsset = await pipeline.render(
			{ artifact, policy: { ...DEFAULT_EXECUTION_POLICY, maxOutputBytes: 100 } },
			{ cacheDirectory: root },
		);
		assert.deepEqual(rebuiltAsset.cacheHit, { content: true, asset: false });
		assert.equal(contentRenderer.renders, 2);
		assert.equal(assetRenderer.renders, 3);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("rejects protocol version mismatches before adapter work", async () => {
	const contentRenderer = new FakeArtifactAdapter("d2-v1");
	const assetRenderer = new FakeAssetRenderer("raster-v1");
	const pipeline = new RichMediaPipeline(contentRenderer, assetRenderer);
	const artifact = {
		version: 2 as never,
		type: "diagram" as const,
		format: "d2",
		content: "a -> b",
	};

	await assert.rejects(pipeline.render({ artifact }), /unsupported artifact version: 2/);
	assert.equal(contentRenderer.validations, 0);
	assert.equal(contentRenderer.renders, 0);
	assert.equal(assetRenderer.renders, 0);
});

class FakeArtifactAdapter implements ArtifactAdapter {
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

	async render(_request: ResolvedArtifactRenderRequest, context: ContentRenderContext): Promise<Asset> {
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
