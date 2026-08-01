import { readFile } from "node:fs/promises";

import { hashCacheIdentity, rasterCacheKey } from "./renderer/cache.ts";
import type {
	AssetPlanContext,
	AssetPlanInput,
	PlannedAsset,
	ScalePolicy,
} from "./renderer/types.ts";

const PLANNER_VERSION = 2;

export class AssetPlanner {
	plan(input: AssetPlanInput, context: AssetPlanContext): PlannedAsset {
		validateInput(input, context);
		if (context.terminal.backend === "none") {
			const altText = input.altText ?? input.source.path;
			return {
				kind: "text",
				source: input.source,
				altText,
				cacheKey: hashCacheIdentity({
					version: PLANNER_VERSION,
					source_hash: input.sourceHash,
					kind: "text",
					alt_text: altText,
				}),
			};
		}
		if (context.terminal.backend === "sixel") {
			throw new Error("Sixel asset planning is not implemented");
		}
		const raster = context.raster;
		if (!raster) throw new Error("raster planning requires a materialization policy");
		validateRasterPolicy(raster);

		const scale = chooseScale(input, context.policy, context.viewport.pixelWidth, context.viewport.pixelHeight);
		const width = Math.ceil(input.width * scale);
		const height = Math.ceil(input.height * scale);
		if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height)) {
			throw new Error("planned raster dimensions exceed the safe integer range");
		}
		const format = "png" as const;
		return {
			kind: "raster",
			source: input.source,
			width: Math.max(1, width),
			height: Math.max(1, height),
			scale,
			format,
			materializer: raster.materializer,
			dpi: raster.dpi,
			quality: raster.quality,
			background: raster.background,
			cacheKey: rasterCacheKey({
				sourceHash: input.sourceHash,
				materializer: raster.materializer,
				format,
				dpi: raster.dpi,
				scale,
				quality: raster.quality,
				background: raster.background,
			}),
		};
	}
}

export async function readSvgDimensions(
	path: string,
	dpi = 96,
): Promise<{ width: number; height: number }> {
	return parseSvgDimensions(await readFile(path, "utf8"), dpi);
}

export function parseSvgDimensions(source: string, dpi = 96): { width: number; height: number } {
	if (!Number.isFinite(dpi) || dpi <= 0) throw new Error("SVG DPI must be positive");
	const root = source.match(/<svg\b[^>]*>/i)?.[0];
	if (!root) throw new Error("SVG asset has no root element");

	const width = svgLength(attribute(root, "width"), dpi);
	const height = svgLength(attribute(root, "height"), dpi);
	if (width !== undefined && height !== undefined) return { width, height };

	const viewBox = attribute(root, "viewBox");
	if (viewBox !== undefined) {
		const values = viewBox
			.trim()
			.split(/[\s,]+/)
			.map(Number);
		if (values.length === 4 && values.every(Number.isFinite)) {
			const width = values[2];
			const height = values[3];
			if (width !== undefined && height !== undefined && width > 0 && height > 0) {
				return { width, height };
			}
		}
	}

	throw new Error("SVG asset has no positive intrinsic dimensions");
}

function chooseScale(
	input: AssetPlanInput,
	policy: Readonly<ScalePolicy>,
	pixelWidth: number | undefined,
	pixelHeight: number | undefined,
): number {
	if (policy.mode === "fixed") return policy.scale;
	if (pixelWidth === undefined || pixelHeight === undefined) return 1;
	const availableScale = Math.min(pixelWidth / input.width, pixelHeight / input.height);
	return availableScale > 1 ? 2 : 1;
}

function validateInput(input: AssetPlanInput, context: AssetPlanContext): void {
	if (input.source.format !== "svg") throw new Error("asset planner requires an SVG source");
	if (!/^[a-f0-9]{64}$/.test(input.sourceHash)) throw new Error("asset planner requires an SVG SHA-256 hash");
	if (!Number.isFinite(input.width) || input.width <= 0) throw new Error("asset width must be positive");
	if (!Number.isFinite(input.height) || input.height <= 0) throw new Error("asset height must be positive");
	if (!Number.isInteger(context.viewport.columns) || context.viewport.columns <= 0) {
		throw new Error("planner viewport columns must be a positive integer");
	}
	if (!Number.isInteger(context.viewport.rows) || context.viewport.rows <= 0) {
		throw new Error("planner viewport rows must be a positive integer");
	}
	const hasPixelWidth = context.viewport.pixelWidth !== undefined;
	const hasPixelHeight = context.viewport.pixelHeight !== undefined;
	if (hasPixelWidth !== hasPixelHeight) throw new Error("planner viewport pixel dimensions must be paired");
	if (hasPixelWidth && (!Number.isFinite(context.viewport.pixelWidth) || Number(context.viewport.pixelWidth) <= 0)) {
		throw new Error("planner viewport pixel width must be positive");
	}
	if (hasPixelHeight && (!Number.isFinite(context.viewport.pixelHeight) || Number(context.viewport.pixelHeight) <= 0)) {
		throw new Error("planner viewport pixel height must be positive");
	}
	if (
		context.policy.mode === "fixed" &&
		(!Number.isFinite(context.policy.scale) || context.policy.scale <= 0)
	) {
		throw new Error("fixed planner scale must be positive");
	}
	if (
		context.terminal.transport === "tmux-passthrough" &&
		context.terminal.backend !== "kitty"
	) {
		throw new Error("tmux passthrough planning requires the Kitty backend");
	}
	if (context.terminal.transport === "tmux-passthrough" && !context.terminal.supportsUnicode) {
		throw new Error("tmux Kitty placeholder planning requires Unicode support");
	}
}

function validateRasterPolicy(policy: NonNullable<AssetPlanContext["raster"]>): void {
	if (!policy.materializer.id.trim() || !policy.materializer.version.trim()) {
		throw new Error("raster materializer identity is incomplete");
	}
	if (!Number.isFinite(policy.dpi) || policy.dpi <= 0) throw new Error("raster DPI must be positive");
	if (policy.quality !== "default") throw new Error(`unsupported raster quality: ${String(policy.quality)}`);
	if (policy.background !== "transparent" && policy.background !== "white") {
		throw new Error(`unsupported raster background: ${String(policy.background)}`);
	}
}

function attribute(tag: string, name: string): string | undefined {
	return new RegExp(`\\b${name}\\s*=\\s*(["'])(.*?)\\1`, "i").exec(tag)?.[2];
}

function svgLength(value: string | undefined, dpi: number): number | undefined {
	if (value === undefined) return undefined;
	const match = /^\s*(\d+(?:\.\d+)?)(px|pt|pc|in|cm|mm)?\s*$/i.exec(value);
	if (!match) return undefined;
	const amount = Number(match[1]);
	const unit = match[2]?.toLowerCase() ?? "px";
	const factors: Record<string, number> = {
		px: 1,
		pt: dpi / 72,
		pc: dpi / 6,
		in: dpi,
		cm: dpi / 2.54,
		mm: dpi / 25.4,
	};
	return amount > 0 ? amount * (factors[unit] ?? 1) : undefined;
}
