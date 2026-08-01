import { lstat, readFile, stat } from "node:fs/promises";

import {
	artifactIdentity,
	artifactRenderIdentity,
	resolveArtifactRenderRequest,
	type ArtifactRenderRequest,
	type ExecutionPolicy,
} from "./artifact.ts";
import {
	assetCachePaths,
	assetWorkPaths,
	commitCacheDirectory,
	contentCachePaths,
	contentWorkPaths,
	createWorkDirectory,
	defaultCacheDirectory,
	hashFile,
	rasterCacheKey,
	readAssetCache,
	readContentCache,
	removeCacheDirectory,
	writeCacheFile,
	writeCacheMetadata,
	type AssetCacheMetadata,
	type ContentCacheMetadata,
} from "./renderer/cache.ts";
import {
	type Asset,
	type ArtifactAdapter,
	type AssetRenderer,
	type RenderedArtifact,
} from "./renderer/types.ts";

export interface PipelineRenderOptions {
	cacheDirectory?: string;
}

export class ArtifactPipeline {
	readonly #adapter: ArtifactAdapter;
	readonly #assetRenderer: AssetRenderer;

	constructor(adapter: ArtifactAdapter, assetRenderer: AssetRenderer) {
		this.#adapter = adapter;
		this.#assetRenderer = assetRenderer;
	}

	async render(
		request: Readonly<ArtifactRenderRequest>,
		pipelineOptions: PipelineRenderOptions = {},
	): Promise<RenderedArtifact> {
		const resolved = resolveArtifactRenderRequest(request);
		const { artifact, options: profile, policy } = resolved;
		const originalInputBytes = Buffer.byteLength(artifact.content);
		if (originalInputBytes > policy.maxInputBytes) {
			throw new Error(`${artifact.format} artifact exceeds the ${policy.maxInputBytes}-byte limit`);
		}
		this.#adapter.validate(resolved);
		const normalization = this.#adapter.normalize?.(resolved) ?? { content: artifact.content, fixes: [] };
		const normalized = normalization.content === artifact.content
			? resolved
			: resolveArtifactRenderRequest({
					artifact: { ...artifact, content: normalization.content },
					options: profile,
					policy,
				});
		const inputBytes = Buffer.byteLength(normalized.artifact.content);
		if (inputBytes > policy.maxInputBytes) {
			throw new Error(
				`${artifact.format} artifact exceeds the ${policy.maxInputBytes}-byte limit after normalization`,
			);
		}
		if (normalized !== resolved) this.#adapter.validate(normalized);

		const [contentIdentity, assetIdentity] = await Promise.all([
			this.#adapter.getIdentity(),
			this.#assetRenderer.getIdentity(),
		]);
		const artifactKey = artifactIdentity(artifact);
		const renderKey = artifactRenderIdentity({
			artifactKey,
			adapter: contentIdentity,
			options: profile,
		});
		const contentKey = renderKey;
		const contentPaths = contentCachePaths(
			contentKey,
			pipelineOptions.cacheDirectory ?? defaultCacheDirectory(),
			this.#adapter.sourceFilename,
		);

		const hasUsableContentCache = () =>
			contentCacheIsUsable(
				contentPaths,
				normalized.artifact.content,
				policy.maxInputBytes,
				policy.maxOutputBytes,
			);
		let contentCacheHit = await hasUsableContentCache();
		if (!contentCacheHit) {
			const workDirectory = await createWorkDirectory(contentPaths.root, contentKey);
			const work = contentWorkPaths(
				contentPaths.root,
				contentKey,
				workDirectory,
				this.#adapter.sourceFilename,
			);
			try {
				await writeCacheFile(work.source, normalized.artifact.content);
				const intermediate = await this.#adapter.render(normalized, {
					sourcePath: work.source,
					outputPath: work.svg,
				});
				assertExpectedAsset(intermediate, "svg", work.svg);
				const svgBytes = await checkedFileSize(work.svg, policy.maxOutputBytes, "SVG");
				const metadata: ContentCacheMetadata = {
					version: 3,
					cache: "content",
					key: contentKey,
					created_at: new Date().toISOString(),
					artifact_key: artifactKey,
					artifact: {
						version: artifact.version,
						type: artifact.type,
						format: artifact.format,
					},
					render_options: { theme: profile.theme, palette: profile.palette },
					adapter: contentIdentity,
					assets: {
						source: this.#adapter.sourceFilename,
						svg: "output.svg",
					},
					execution_policy: executionPolicyMetadata(contentIdentity.id, policy),
					resource_usage: { input_bytes: inputBytes, output_bytes: svgBytes },
				};
				await writeCacheMetadata(work.metadata, metadata);
				contentCacheHit = await commitCacheDirectory(
					workDirectory,
					contentPaths.directory,
					hasUsableContentCache,
				);
			} finally {
				await removeCacheDirectory(workDirectory);
			}
		}

		const intermediate: Asset = {
			format: "svg",
			mediaType: "image/svg+xml",
			path: contentPaths.svg,
		};
		const sourceHash = await hashFile(contentPaths.svg);
		const key = rasterCacheKey({
			sourceHash,
			materializer: assetIdentity,
			format: "png",
			dpi: profile.dpi,
			scale: profile.scale,
			quality: profile.quality,
			background: profile.background,
		});
		const assetPaths = assetCachePaths(contentPaths, key);
		const assetPolicy: ExecutionPolicy = { ...policy, maxInputBytes: policy.maxOutputBytes };

		const hasUsableAssetCache = () => assetCacheIsUsable(assetPaths, assetPolicy.maxOutputBytes);
		let assetCacheHit = await hasUsableAssetCache();
		if (!assetCacheHit) {
			const workDirectory = await createWorkDirectory(contentPaths.renders, key);
			const work = assetWorkPaths(contentPaths, key, workDirectory);
			try {
				const asset = await this.#assetRenderer.render(intermediate, {
					outputPath: work.png,
					profile,
					policy: assetPolicy,
				});
				assertExpectedAsset(asset, "png", work.png);
				const [svgBytes, pngBytes] = await Promise.all([
					checkedFileSize(contentPaths.svg, assetPolicy.maxInputBytes, "SVG"),
					checkedFileSize(work.png, assetPolicy.maxOutputBytes, "PNG"),
				]);
				const metadata: AssetCacheMetadata = {
					version: 4,
					cache: "asset",
					key,
					content_key: contentKey,
					source_hash: sourceHash,
					created_at: new Date().toISOString(),
					format: "png",
					dpi: profile.dpi,
					scale: profile.scale,
					quality: profile.quality,
					background: profile.background,
					asset_renderer: assetIdentity,
					assets: { input: "../../output.svg", output: "output.png" },
					execution_policy: executionPolicyMetadata(assetIdentity.id, assetPolicy),
					resource_usage: { input_bytes: svgBytes, output_bytes: pngBytes },
				};
				await writeCacheMetadata(work.metadata, metadata);
				assetCacheHit = await commitCacheDirectory(
					workDirectory,
					assetPaths.directory,
					hasUsableAssetCache,
				);
			} finally {
				await removeCacheDirectory(workDirectory);
			}
		}

		return {
			artifact,
			artifactKey,
			renderKey,
			type: artifact.type,
			key,
			contentKey,
			sourceHash,
			sourcePath: contentPaths.source,
			intermediate,
			asset: { format: "png", mediaType: "image/png", path: assetPaths.png },
			assetRenderer: assetIdentity,
			profile,
			metadataPath: assetPaths.metadata,
			compatibilityFixes: normalization.fixes,
			cacheHit: { content: contentCacheHit, asset: assetCacheHit },
		};
	}
}


async function contentCacheIsUsable(
	paths: ReturnType<typeof contentCachePaths>,
	content: string,
	maxInputBytes: number,
	maxOutputBytes: number,
): Promise<boolean> {
	if (!(await readContentCache(paths))) return false;
	try {
		const [source, svg] = await Promise.all([lstat(paths.source), lstat(paths.svg)]);
		if (source.size > maxInputBytes || svg.size > maxOutputBytes) return false;
		return (await readFile(paths.source, "utf8")) === content;
	} catch {
		return false;
	}
}

async function assetCacheIsUsable(
	paths: ReturnType<typeof assetCachePaths>,
	maxOutputBytes: number,
): Promise<boolean> {
	if (!(await readAssetCache(paths))) return false;
	try {
		return (await lstat(paths.png)).size <= maxOutputBytes;
	} catch {
		return false;
	}
}

async function checkedFileSize(path: string, maximum: number, label: string): Promise<number> {
	const file = await stat(path);
	if (!file.isFile() || file.size === 0) throw new Error(`${label} renderer produced no output`);
	if (file.size > maximum) throw new Error(`${label} output exceeds the ${maximum}-byte limit`);
	return file.size;
}

function assertExpectedAsset(asset: Asset, format: Asset["format"], path: string): void {
	if (asset.format !== format || asset.path !== path) {
		throw new Error(`renderer returned unexpected ${asset.format} asset at ${asset.path}`);
	}
}

function executionPolicyMetadata(renderer: string, policy: Readonly<ExecutionPolicy>) {
	return {
		renderer,
		timeout_ms: policy.timeoutMs,
		max_input_bytes: policy.maxInputBytes,
		max_output_bytes: policy.maxOutputBytes,
		network: policy.network,
		filesystem: policy.filesystem,
	};
}
