import { createHash, randomBytes } from "node:crypto";
import { chmod, lstat, mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

import type {
	RasterBackground,
	RasterQuality,
	RendererIdentity,
	RichMediaType,
} from "./types.ts";

export interface ContentCachePaths {
	key: string;
	root: string;
	directory: string;
	source: string;
	svg: string;
	metadata: string;
	renders: string;
}

export interface AssetCachePaths {
	key: string;
	contentKey: string;
	directory: string;
	png: string;
	metadata: string;
}

export interface ResourceMetadata {
	resource_budget: {
		renderer: string;
		timeout_ms: number;
		max_input_bytes: number;
		max_output_bytes: number;
		network: boolean;
	};
	resource_usage: {
		input_bytes: number;
		output_bytes: number;
	};
}

export interface ContentCacheMetadata extends ResourceMetadata {
	version: 2;
	cache: "content";
	key: string;
	created_at: string;
	type: RichMediaType;
	language: string;
	theme: number;
	content_renderer: RendererIdentity;
	assets: {
		source: string;
		svg: "output.svg";
	};
}

export interface AssetCacheMetadata extends ResourceMetadata {
	version: 3;
	cache: "asset";
	key: string;
	content_key: string;
	source_hash: string;
	created_at: string;
	format: "png";
	dpi: number;
	scale: number;
	quality: RasterQuality;
	background: RasterBackground;
	asset_renderer: RendererIdentity;
	assets: {
		input: "../../output.svg";
		output: "output.png";
	};
}

export function defaultCacheDirectory(): string {
	return process.env.PI_RICH_MEDIA_CACHE_DIR ?? join(homedir(), ".cache", "pi-rich-media");
}

export function hashCacheIdentity(identity: unknown): string {
	return createHash("sha256").update(JSON.stringify(canonicalize(identity))).digest("hex");
}

export async function hashFile(path: string): Promise<string> {
	return createHash("sha256").update(await readFile(path)).digest("hex");
}

export function rasterCacheKey(identity: {
	sourceHash: string;
	materializer: Readonly<RendererIdentity>;
	format: "png" | "rgba";
	dpi: number;
	scale: number;
	quality: RasterQuality;
	background: RasterBackground;
}): string {
	return hashCacheIdentity({
		version: 3,
		source_hash: identity.sourceHash,
		materializer: identity.materializer,
		format: identity.format,
		dpi: identity.dpi,
		scale: identity.scale,
		quality: identity.quality,
		background: identity.background,
	});
}

export function contentCachePaths(
	key: string,
	root = defaultCacheDirectory(),
	sourceFilename = "source.d2",
): ContentCachePaths {
	const directory = join(root, key);
	return {
		key,
		root,
		directory,
		source: join(directory, sourceFilename),
		svg: join(directory, "output.svg"),
		metadata: join(directory, "metadata.json"),
		renders: join(directory, "renders"),
	};
}

export function assetCachePaths(content: ContentCachePaths, key: string): AssetCachePaths {
	const directory = join(content.renders, key);
	return {
		key,
		contentKey: content.key,
		directory,
		png: join(directory, "output.png"),
		metadata: join(directory, "metadata.json"),
	};
}

export function contentWorkPaths(
	root: string,
	key: string,
	directory: string,
	sourceFilename = "source.d2",
): ContentCachePaths {
	return {
		...contentCachePaths(key, root, sourceFilename),
		directory,
		source: join(directory, sourceFilename),
		svg: join(directory, "output.svg"),
		metadata: join(directory, "metadata.json"),
		renders: join(directory, "renders"),
	};
}

export function assetWorkPaths(content: ContentCachePaths, key: string, directory: string): AssetCachePaths {
	return {
		...assetCachePaths(content, key),
		directory,
		png: join(directory, "output.png"),
		metadata: join(directory, "metadata.json"),
	};
}

export async function ensureCacheDirectory(directory: string): Promise<void> {
	await mkdir(directory, { recursive: true, mode: 0o700 });
	await chmod(directory, 0o700);
}

export async function createWorkDirectory(parent: string, key: string): Promise<string> {
	await ensureCacheDirectory(parent);
	const directory = await mkdtemp(join(parent, `.${key}.`));
	await chmod(directory, 0o700);
	return directory;
}

export async function readContentCache(
	paths: ContentCachePaths,
): Promise<ContentCacheMetadata | undefined> {
	try {
		const [source, svg, metadataFile] = await Promise.all([
			lstat(paths.source),
			lstat(paths.svg),
			lstat(paths.metadata),
		]);
		if (!source.isFile() || !svg.isFile() || !metadataFile.isFile() || source.size === 0 || svg.size === 0) {
			return undefined;
		}
		const metadata = JSON.parse(await readFile(paths.metadata, "utf8")) as ContentCacheMetadata;
		if (metadata.version !== 2 || metadata.cache !== "content" || metadata.key !== paths.key) {
			return undefined;
		}
		return metadata;
	} catch {
		return undefined;
	}
}

export async function readAssetCache(paths: AssetCachePaths): Promise<AssetCacheMetadata | undefined> {
	try {
		const [png, metadataFile] = await Promise.all([lstat(paths.png), lstat(paths.metadata)]);
		if (!png.isFile() || !metadataFile.isFile() || png.size === 0) return undefined;
		const metadata = JSON.parse(await readFile(paths.metadata, "utf8")) as AssetCacheMetadata;
		if (
			metadata.version !== 3 ||
			metadata.cache !== "asset" ||
			metadata.key !== paths.key ||
			metadata.content_key !== paths.contentKey
		) {
			return undefined;
		}
		return metadata;
	} catch {
		return undefined;
	}
}

export async function writeCacheFile(path: string, content: string | Uint8Array): Promise<void> {
	await writeFile(path, content, { mode: 0o600 });
}

export async function writeCacheMetadata(
	path: string,
	metadata: ContentCacheMetadata | AssetCacheMetadata,
): Promise<void> {
	await writeCacheFile(path, `${JSON.stringify(metadata, null, 2)}\n`);
}

export async function commitCacheDirectory(
	workDirectory: string,
	destination: string,
	isDestinationValid: () => Promise<boolean>,
): Promise<boolean> {
	try {
		await rename(workDirectory, destination);
		return false;
	} catch (error) {
		if (!isExistingDestinationError(error)) throw error;
	}

	if (await isDestinationValid()) {
		await removeCacheDirectory(workDirectory);
		return true;
	}

	const stale = `${destination}.stale.${process.pid}.${randomBytes(6).toString("hex")}`;
	try {
		await rename(destination, stale);
	} catch (error) {
		if (!isMissingPathError(error)) throw error;
	}
	try {
		await rename(workDirectory, destination);
	} finally {
		await removeCacheDirectory(stale);
	}
	return false;
}

export async function removeCacheDirectory(directory: string): Promise<void> {
	await rm(directory, { recursive: true, force: true });
}

function canonicalize(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(canonicalize);
	if (value === null || typeof value !== "object") return value;
	return Object.fromEntries(
		Object.entries(value as Record<string, unknown>)
			.sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
			.map(([key, item]) => [key, canonicalize(item)]),
	);
}

function isExistingDestinationError(error: unknown): boolean {
	const code = (error as NodeJS.ErrnoException | undefined)?.code;
	return code === "EEXIST" || code === "ENOTEMPTY";
}

function isMissingPathError(error: unknown): boolean {
	return (error as NodeJS.ErrnoException | undefined)?.code === "ENOENT";
}
