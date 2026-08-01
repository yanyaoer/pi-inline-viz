import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
	assetCachePaths,
	contentCachePaths,
	ensureCacheDirectory,
	hashCacheIdentity,
	rasterCacheKey,
	readAssetCache,
	readContentCache,
	writeCacheFile,
	writeCacheMetadata,
	type AssetCacheMetadata,
	type ContentCacheMetadata,
} from "../../src/renderer/cache.ts";

test("cache identity is canonical and includes renderer inputs", () => {
	const left = hashCacheIdentity({ content: "a -> b", renderer: { id: "d2", version: "1" }, theme: 0 });
	const reordered = hashCacheIdentity({ theme: 0, renderer: { version: "1", id: "d2" }, content: "a -> b" });
	const upgraded = hashCacheIdentity({ content: "a -> b", renderer: { id: "d2", version: "2" }, theme: 0 });

	assert.match(left, /^[a-f0-9]{64}$/);
	assert.equal(left, reordered);
	assert.notEqual(left, upgraded);
});

test("uses separate content and raster cache directories", () => {
	const content = contentCachePaths("content-key", "/cache", "source.d2");
	const asset = assetCachePaths(content, "asset-key");

	assert.equal(content.source, "/cache/content-key/source.d2");
	assert.equal(content.svg, "/cache/content-key/output.svg");
	assert.equal(asset.png, "/cache/content-key/renders/asset-key/output.png");
});

test("keys the full raster ABI but not terminal presentation state", () => {
	const input = {
		sourceHash: "a".repeat(64),
		materializer: { id: "rsvg-convert", version: "2.62.3" },
		format: "png" as const,
		dpi: 96,
		scale: 2,
		quality: "default" as const,
		background: "transparent" as const,
	};
	const key = rasterCacheKey(input);
	assert.equal(key, rasterCacheKey({ ...input }));
	assert.notEqual(key, rasterCacheKey({ ...input, background: "white" }));
	assert.notEqual(key, rasterCacheKey({ ...input, background: "#18181e" }));
	assert.notEqual(
		key,
		rasterCacheKey({ ...input, materializer: { ...input.materializer, version: "2.63.0" } }),
	);
});

test("recognizes only complete content and raster entries", async () => {
	const root = await mkdtemp(join(tmpdir(), "pi-rich-cache-test-"));
	try {
		const content = contentCachePaths("content-key", root);
		await ensureCacheDirectory(content.directory);
		assert.equal(await readContentCache(content), undefined);

		await writeCacheFile(content.source, "a -> b");
		await writeCacheFile(content.svg, "<svg/>");
		const contentMetadata: ContentCacheMetadata = {
			version: 3,
			cache: "content",
			key: content.key,
			created_at: "2026-07-31T00:00:00.000Z",
			artifact_key: "artifact-key",
			artifact: { version: 1, type: "diagram", format: "d2" },
			render_options: { theme: "0" },
			adapter: { id: "d2", version: "v0" },
			assets: { source: "source.d2", svg: "output.svg" },
			execution_policy: {
				renderer: "d2",
				timeout_ms: 15_000,
				max_input_bytes: 100,
				max_output_bytes: 1_000,
				network: "deny",
				filesystem: "isolated-workdir",
			},
			resource_usage: { input_bytes: 6, output_bytes: 6 },
		};
		await writeCacheMetadata(content.metadata, contentMetadata);
		assert.deepEqual(await readContentCache(content), contentMetadata);

		const asset = assetCachePaths(content, "asset-key");
		await ensureCacheDirectory(asset.directory);
		await writeCacheFile(asset.png, Buffer.from("png"));
		const assetMetadata: AssetCacheMetadata = {
			version: 4,
			cache: "asset",
			key: asset.key,
			content_key: content.key,
			source_hash: "a".repeat(64),
			created_at: "2026-07-31T00:00:00.000Z",
			format: "png",
			dpi: 96,
			scale: 1,
			quality: "default",
			background: "transparent",
			asset_renderer: { id: "test", version: "v0" },
			assets: { input: "../../output.svg", output: "output.png" },
			execution_policy: {
				renderer: "test",
				timeout_ms: 15_000,
				max_input_bytes: 100,
				max_output_bytes: 1_000,
				network: "deny",
				filesystem: "isolated-workdir",
			},
			resource_usage: { input_bytes: 6, output_bytes: 3 },
		};
		await writeCacheMetadata(asset.metadata, assetMetadata);
		assert.deepEqual(await readAssetCache(asset), assetMetadata);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});
