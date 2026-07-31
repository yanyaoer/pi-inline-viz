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

interface TerminalImageOptions {
	maxWidthCells: number;
	maxHeightCells: number;
}

export class TerminalImageRenderer implements TerminalRenderer<Component> {
	readonly id = "terminal-image";

	render(request: TerminalRenderRequest, context: TerminalRenderContext): Component {
		validateRequest(request);
		const { asset, capabilities, viewport } = request;
		if (asset.format !== "png") throw new Error(`terminal image renderer cannot process ${asset.format}`);
		const base64Data = readFileSync(asset.path).toString("base64");
		return new CapabilityImage(base64Data, asset.path, capabilities, context.fallbackColor, {
			maxWidthCells: viewport.columns,
			maxHeightCells: viewport.rows,
		});
	}
}

export function wrapTmuxPassthrough(sequence: string): string {
	const graphicsCommands = /\x1b_G.*?\x1b\\/gs;
	let matched = false;
	const wrapped = sequence.replace(graphicsCommands, (command) => {
		matched = true;
		return wrapTmuxCommand(command);
	});
	return matched ? wrapped : wrapTmuxCommand(sequence);
}

class CapabilityImage implements Component {
	readonly #base64Data: string;
	readonly #filename: string;
	readonly #capabilities: TerminalRenderRequest["capabilities"];
	readonly #fallbackColor: (text: string) => string;
	readonly #options: TerminalImageOptions;
	readonly #imageId = allocateImageId();
	readonly #dimensions: { widthPx: number; heightPx: number };
	#cachedWidth: number | undefined;
	#cachedLines: string[] | undefined;

	constructor(
		base64Data: string,
		filename: string,
		capabilities: TerminalRenderRequest["capabilities"],
		fallbackColor: (text: string) => string,
		options: TerminalImageOptions,
	) {
		this.#base64Data = base64Data;
		this.#filename = filename;
		this.#capabilities = capabilities;
		this.#fallbackColor = fallbackColor;
		this.#options = options;
		this.#dimensions = getPngDimensions(base64Data) ?? { widthPx: 800, heightPx: 600 };
	}

	render(width: number): string[] {
		if (this.#cachedWidth === width && this.#cachedLines) return this.#cachedLines;

		const maxWidth = Math.max(1, Math.min(width - 2, this.#options.maxWidthCells));
		const cellDimensions = getCellDimensions();
		const size = calculateImageCellSize(
			this.#dimensions,
			maxWidth,
			this.#options.maxHeightCells,
			cellDimensions,
		);
		const lines = this.#renderBackend(size, width);

		this.#cachedWidth = width;
		this.#cachedLines = lines;
		return lines;
	}

	invalidate(): void {
		this.#cachedWidth = undefined;
		this.#cachedLines = undefined;
	}

	#renderBackend(size: { columns: number; rows: number }, width: number): string[] {
		if (this.#capabilities.backend === "none") {
			const fallback = imageFallback("image/png", this.#dimensions, this.#filename);
			return [truncateToWidth(this.#fallbackColor(fallback), width)];
		}
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

		const sequence = encodeKitty(this.#base64Data, {
			columns: size.columns,
			rows: size.rows,
			imageId: this.#imageId,
			moveCursor: false,
		});
		const output =
			this.#capabilities.transport === "tmux-passthrough"
				? wrapTmuxPassthrough(sequence)
				: sequence;
		const lines = [output];
		for (let index = 1; index < size.rows; index += 1) lines.push("");
		return lines;
	}
}

function calculateImageCellSize(
	dimensions: { widthPx: number; heightPx: number },
	maxWidthCells: number,
	maxHeightCells: number,
	cellDimensions: { widthPx: number; heightPx: number },
): { columns: number; rows: number } {
	const widthScale = (maxWidthCells * cellDimensions.widthPx) / Math.max(1, dimensions.widthPx);
	const heightScale = (maxHeightCells * cellDimensions.heightPx) / Math.max(1, dimensions.heightPx);
	const scale = Math.min(widthScale, heightScale);
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

function wrapTmuxCommand(command: string): string {
	return `\x1bPtmux;${command.replaceAll("\x1b", "\x1b\x1b")}\x1b\\`;
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
}
