import { lstat, readFile, stat } from "node:fs/promises";

import {
	assetCachePaths,
	assetWorkPaths,
	commitCacheDirectory,
	contentCachePaths,
	contentWorkPaths,
	createWorkDirectory,
	defaultCacheDirectory,
	hashCacheIdentity,
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
	DEFAULT_RENDER_PROFILE,
	DEFAULT_RESOURCE_BUDGET,
	type Asset,
	type AssetRenderer,
	type ContentRenderer,
	type RenderedArtifact,
	type RenderProfile,
	type ResourceBudget,
	type RichBlock,
} from "./renderer/types.ts";

export interface PipelineRenderOptions {
	cacheDirectory?: string;
	profile?: Partial<RenderProfile>;
	budget?: Partial<ResourceBudget>;
}

export class RichMediaPipeline<TBlock extends RichBlock> {
	readonly #contentRenderer: ContentRenderer<TBlock>;
	readonly #assetRenderer: AssetRenderer;

	constructor(contentRenderer: ContentRenderer<TBlock>, assetRenderer: AssetRenderer) {
		this.#contentRenderer = contentRenderer;
		this.#assetRenderer = assetRenderer;
	}

	async render(block: TBlock, options: PipelineRenderOptions = {}): Promise<RenderedArtifact> {
		const profile = { ...DEFAULT_RENDER_PROFILE, ...options.profile };
		const budget = { ...DEFAULT_RESOURCE_BUDGET, ...options.budget };
		validateSettings(profile, budget);
		this.#contentRenderer.validate(block, budget);
		const inputBytes = Buffer.byteLength(block.content);
		if (inputBytes > budget.maxInputBytes) {
			throw new Error(`${block.language} block exceeds the ${budget.maxInputBytes}-byte limit`);
		}

		const [contentIdentity, assetIdentity] = await Promise.all([
			this.#contentRenderer.getIdentity(),
			this.#assetRenderer.getIdentity(),
		]);
		const contentKey = hashCacheIdentity({
			version: 2,
			type: block.type,
			language: block.language,
			content_renderer: contentIdentity,
			theme: profile.theme,
			content: block.content,
		});
		const contentPaths = contentCachePaths(
			contentKey,
			options.cacheDirectory ?? defaultCacheDirectory(),
			this.#contentRenderer.sourceFilename,
		);

		const hasUsableContentCache = () =>
			contentCacheIsUsable(contentPaths, block.content, budget.maxInputBytes, budget.maxOutputBytes);
		let contentCacheHit = await hasUsableContentCache();
		if (!contentCacheHit) {
			const workDirectory = await createWorkDirectory(contentPaths.root, contentKey);
			const work = contentWorkPaths(
				contentPaths.root,
				contentKey,
				workDirectory,
				this.#contentRenderer.sourceFilename,
			);
			try {
				await writeCacheFile(work.source, block.content);
				const intermediate = await this.#contentRenderer.render(block, {
					sourcePath: work.source,
					outputPath: work.svg,
					profile,
					budget,
				});
				assertExpectedAsset(intermediate, "svg", work.svg);
				const svgBytes = await checkedFileSize(work.svg, budget.maxOutputBytes, "SVG");
				const metadata: ContentCacheMetadata = {
					version: 2,
					cache: "content",
					key: contentKey,
					created_at: new Date().toISOString(),
					type: block.type,
					language: block.language,
					theme: profile.theme,
					content_renderer: contentIdentity,
					assets: {
						source: this.#contentRenderer.sourceFilename,
						svg: "output.svg",
					},
					resource_budget: budgetMetadata(contentIdentity.id, budget),
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
		const assetBudget = { ...budget, maxInputBytes: budget.maxOutputBytes };

		const hasUsableAssetCache = () => assetCacheIsUsable(assetPaths, assetBudget.maxOutputBytes);
		let assetCacheHit = await hasUsableAssetCache();
		if (!assetCacheHit) {
			const workDirectory = await createWorkDirectory(contentPaths.renders, key);
			const work = assetWorkPaths(contentPaths, key, workDirectory);
			try {
				const asset = await this.#assetRenderer.render(intermediate, {
					outputPath: work.png,
					profile,
					budget: assetBudget,
				});
				assertExpectedAsset(asset, "png", work.png);
				const [svgBytes, pngBytes] = await Promise.all([
					checkedFileSize(contentPaths.svg, assetBudget.maxInputBytes, "SVG"),
					checkedFileSize(work.png, assetBudget.maxOutputBytes, "PNG"),
				]);
				const metadata: AssetCacheMetadata = {
					version: 3,
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
					resource_budget: budgetMetadata(assetIdentity.id, assetBudget),
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
			type: block.type,
			key,
			contentKey,
			sourceHash,
			sourcePath: contentPaths.source,
			intermediate,
			asset: { format: "png", mediaType: "image/png", path: assetPaths.png },
			assetRenderer: assetIdentity,
			profile,
			metadataPath: assetPaths.metadata,
			cacheHit: { content: contentCacheHit, asset: assetCacheHit },
		};
	}
}

function validateSettings(profile: RenderProfile, budget: ResourceBudget): void {
	if (!Number.isInteger(profile.theme) || profile.theme < 0) throw new Error("theme must be a non-negative integer");
	if (!Number.isFinite(profile.dpi) || profile.dpi <= 0) throw new Error("dpi must be positive");
	if (!Number.isFinite(profile.scale) || profile.scale <= 0) throw new Error("scale must be positive");
	if (profile.quality !== "default") throw new Error(`unsupported raster quality: ${String(profile.quality)}`);
	if (profile.background !== "transparent" && profile.background !== "white") {
		throw new Error(`unsupported raster background: ${String(profile.background)}`);
	}
	if (!Number.isInteger(budget.timeoutMs) || budget.timeoutMs <= 0) throw new Error("timeoutMs must be positive");
	if (!Number.isInteger(budget.maxInputBytes) || budget.maxInputBytes <= 0) {
		throw new Error("maxInputBytes must be positive");
	}
	if (!Number.isInteger(budget.maxOutputBytes) || budget.maxOutputBytes <= 0) {
		throw new Error("maxOutputBytes must be positive");
	}
	if (budget.network !== false) throw new Error("networked renderers are not supported");
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

function budgetMetadata(renderer: string, budget: ResourceBudget) {
	return {
		renderer,
		timeout_ms: budget.timeoutMs,
		max_input_bytes: budget.maxInputBytes,
		max_output_bytes: budget.maxOutputBytes,
		network: budget.network,
	};
}
