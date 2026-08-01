import { readFileSync } from "node:fs";
import {
	allocateImageId,
	encodeITerm2,
	encodeKitty,
	getCellDimensions,
	getPngDimensions,
	imageFallback,
	truncateToWidth,
	type Component,
} from "@earendil-works/pi-tui";

import type {
	TerminalRenderer,
	TerminalRenderContext,
	TerminalRenderRequest,
} from "./types.ts";
import {
	encodeKittyPlaceholderImage,
	encodeTmuxKittyImage,
	MAX_KITTY_PLACEHOLDER_DIMENSION,
} from "./kitty.ts";

export { wrapTmuxPassthrough } from "./kitty.ts";

interface TerminalImageOptions {
	maxWidthCells: number;
	maxHeightCells: number;
	upscale: boolean;
}

export class TerminalImageRenderer implements TerminalRenderer<Component> {
	readonly id = "terminal-image";

	render(request: TerminalRenderRequest, context: TerminalRenderContext): Component {
		validateRequest(request);
		const { asset, capabilities, viewport } = request;
		if (asset.format !== "png") throw new Error(`terminal image renderer cannot process ${asset.format}`);
		if (capabilities.backend === "none") return new AssetFallback(asset.path, context.fallbackColor);
		const base64Data = readFileSync(asset.path).toString("base64");
		return new CapabilityImage(base64Data, capabilities, {
			maxWidthCells: viewport.columns,
			maxHeightCells: viewport.rows,
			upscale: request.upscale ?? true,
		});
	}
}

class CapabilityImage implements Component {
	readonly #base64Data: string;
	readonly #capabilities: TerminalRenderRequest["capabilities"];
	readonly #options: TerminalImageOptions;
	readonly #imageId = allocateImageId();
	readonly #dimensions: { widthPx: number; heightPx: number };
	#cachedWidth: number | undefined;
	#cachedLines: string[] | undefined;

	constructor(
		base64Data: string,
		capabilities: TerminalRenderRequest["capabilities"],
		options: TerminalImageOptions,
	) {
		this.#base64Data = base64Data;
		this.#capabilities = capabilities;
		this.#options = options;
		this.#dimensions = getPngDimensions(base64Data) ?? { widthPx: 800, heightPx: 600 };
	}

	render(width: number): string[] {
		if (this.#cachedWidth === width && this.#cachedLines) return this.#cachedLines;

		const placeholderLimit = this.#capabilities.kittyPlaceholders
			? MAX_KITTY_PLACEHOLDER_DIMENSION
			: Number.POSITIVE_INFINITY;
		const maxWidth = Math.max(1, Math.min(width - 2, this.#options.maxWidthCells, placeholderLimit));
		const maxHeight = Math.min(this.#options.maxHeightCells, placeholderLimit);
		const cellDimensions = getCellDimensions();
		const size = calculateImageCellSize(
			this.#dimensions,
			maxWidth,
			maxHeight,
			cellDimensions,
			this.#options.upscale,
		);
		const lines = this.#renderBackend(size);

		this.#cachedWidth = width;
		this.#cachedLines = lines;
		return lines;
	}

	invalidate(): void {
		this.#cachedWidth = undefined;
		this.#cachedLines = undefined;
	}

	#renderBackend(size: { columns: number; rows: number }): string[] {
		if (this.#capabilities.backend === "iterm") {
			const sequence = encodeITerm2(this.#base64Data, {
				width: size.columns,
				height: "auto",
				preserveAspectRatio: true,
			});
			const lines = Array.from({ length: Math.max(0, size.rows - 1) }, () => "");
			const rowOffset = size.rows - 1;
			lines.push(`${rowOffset > 0 ? `\x1b[${rowOffset}A` : ""}${sequence}`);
			return lines;
		}

		if (this.#capabilities.transport === "tmux-passthrough") {
			return encodeTmuxKittyImage(this.#base64Data, {
				columns: size.columns,
				rows: size.rows,
				imageId: this.#imageId,
			});
		}
		if (this.#capabilities.kittyPlaceholders) {
			return encodeKittyPlaceholderImage(this.#base64Data, {
				columns: size.columns,
				rows: size.rows,
				imageId: this.#imageId,
			});
		}

		const sequence = encodeKitty(this.#base64Data, {
			columns: size.columns,
			rows: size.rows,
			imageId: this.#imageId,
			moveCursor: false,
		});
		const lines = [sequence];
		for (let index = 1; index < size.rows; index += 1) lines.push("");
		return lines;
	}
}

class AssetFallback implements Component {
	readonly #filename: string;
	readonly #fallbackColor: (text: string) => string;

	constructor(filename: string, fallbackColor: (text: string) => string) {
		this.#filename = filename;
		this.#fallbackColor = fallbackColor;
	}

	render(width: number): string[] {
		return [truncateToWidth(this.#fallbackColor(imageFallback("image/png", undefined, this.#filename)), width)];
	}

	invalidate(): void {}
}

function calculateImageCellSize(
	dimensions: { widthPx: number; heightPx: number },
	maxWidthCells: number,
	maxHeightCells: number,
	cellDimensions: { widthPx: number; heightPx: number },
	upscale: boolean,
): { columns: number; rows: number } {
	const widthScale = (maxWidthCells * cellDimensions.widthPx) / Math.max(1, dimensions.widthPx);
	const heightScale = (maxHeightCells * cellDimensions.heightPx) / Math.max(1, dimensions.heightPx);
	const scale = Math.min(widthScale, heightScale, upscale ? Number.POSITIVE_INFINITY : 1);
	return {
		columns: Math.max(
			1,
			Math.min(maxWidthCells, Math.ceil((dimensions.widthPx * scale) / cellDimensions.widthPx)),
		),
		rows: Math.max(
			1,
			Math.min(maxHeightCells, Math.ceil((dimensions.heightPx * scale) / cellDimensions.heightPx)),
		),
	};
}

function validateRequest(request: TerminalRenderRequest): void {
	const { capabilities, viewport, scalePolicy } = request;
	if (!Number.isInteger(viewport.columns) || viewport.columns <= 0) {
		throw new Error("terminal viewport columns must be a positive integer");
	}
	if (!Number.isInteger(viewport.rows) || viewport.rows <= 0) {
		throw new Error("terminal viewport rows must be a positive integer");
	}
	if (scalePolicy.mode === "fixed" && (!Number.isFinite(scalePolicy.scale) || scalePolicy.scale <= 0)) {
		throw new Error("fixed terminal scale must be positive");
	}
	if (capabilities.backend === "sixel") {
		throw new Error("Sixel terminal rendering is not implemented");
	}
	if (capabilities.transport === "tmux-passthrough" && capabilities.backend !== "kitty") {
		throw new Error("tmux passthrough requires the Kitty backend");
	}
	if (capabilities.transport === "tmux-passthrough" && !capabilities.supportsUnicode) {
		throw new Error("tmux Kitty placeholders require Unicode support");
	}
	if (capabilities.kittyPlaceholders && capabilities.backend !== "kitty") {
		throw new Error("Kitty placeholders require the Kitty backend");
	}
	if (capabilities.kittyPlaceholders && !capabilities.supportsUnicode) {
		throw new Error("Kitty placeholders require Unicode support");
	}
	if (capabilities.transport === "tmux-passthrough" && !capabilities.kittyPlaceholders) {
		throw new Error("tmux passthrough requires Kitty placeholders");
	}
}
