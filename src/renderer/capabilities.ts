import { execFileSync } from "node:child_process";
import {
	getCapabilities,
	getCellDimensions,
	type CellDimensions,
	type ImageProtocol,
} from "@earendil-works/pi-tui";

import type { TerminalCapabilities, TerminalViewport } from "./types.ts";

export interface TerminalEnvironment {
	capabilities: TerminalCapabilities;
	viewport: TerminalViewport;
}

export interface CapabilityOptions {
	tmuxKittyPassthrough?: boolean;
	supportsUnicode?: boolean;
}

export function currentTerminalEnvironment(): TerminalEnvironment {
	const tuiCapabilities = getCapabilities();
	return {
		capabilities: resolveTerminalCapabilities(tuiCapabilities.images, {
			tmuxKittyPassthrough: tmuxKittyPassthroughEnabled(),
			supportsUnicode: terminalSupportsUnicode(),
		}),
		viewport: createTerminalViewport(process.stdout.columns, process.stdout.rows, getCellDimensions()),
	};
}

export function resolveTerminalCapabilities(
	imageProtocol: ImageProtocol,
	options: CapabilityOptions = {},
): TerminalCapabilities {
	if (options.tmuxKittyPassthrough) {
		return {
			backend: "kitty",
			transport: "tmux-passthrough",
			supportsUnicode: options.supportsUnicode ?? true,
		};
	}
	return {
		backend: imageProtocol === "kitty" ? "kitty" : imageProtocol === "iterm2" ? "iterm" : "none",
		transport: "direct",
		supportsUnicode: options.supportsUnicode ?? true,
	};
}

export function createTerminalViewport(
	columns: number | undefined,
	rows: number | undefined,
	cellDimensions?: CellDimensions,
): TerminalViewport {
	const safeColumns = positiveInteger(columns, 80);
	const safeRows = positiveInteger(rows, 24);
	const viewport: TerminalViewport = { columns: safeColumns, rows: safeRows };
	if (
		cellDimensions &&
		Number.isFinite(cellDimensions.widthPx) &&
		cellDimensions.widthPx > 0 &&
		Number.isFinite(cellDimensions.heightPx) &&
		cellDimensions.heightPx > 0
	) {
		viewport.pixelWidth = Math.round(safeColumns * cellDimensions.widthPx);
		viewport.pixelHeight = Math.round(safeRows * cellDimensions.heightPx);
	}
	return viewport;
}

export function limitTerminalViewport(
	viewport: Readonly<TerminalViewport>,
	maxColumns: number,
	maxRows: number,
): TerminalViewport {
	const sourceColumns = positiveInteger(viewport.columns, 80);
	const sourceRows = positiveInteger(viewport.rows, 24);
	const columns = Math.min(sourceColumns, positiveInteger(maxColumns, 80));
	const rows = Math.min(sourceRows, positiveInteger(maxRows, 24));
	const limited: TerminalViewport = { columns, rows };
	if (viewport.pixelWidth !== undefined) {
		limited.pixelWidth = Math.max(1, Math.round((viewport.pixelWidth * columns) / sourceColumns));
	}
	if (viewport.pixelHeight !== undefined) {
		limited.pixelHeight = Math.max(1, Math.round((viewport.pixelHeight * rows) / sourceRows));
	}
	return limited;
}

export function terminalSupportsUnicode(environment: NodeJS.ProcessEnv = process.env): boolean {
	const locale = environment.LC_ALL ?? environment.LC_CTYPE ?? environment.LANG;
	if (!locale) return true;
	return !/^(?:c|posix)$/i.test(locale.trim());
}

let tmuxPassthroughEnabled: boolean | undefined;

export function resetTerminalCapabilityCache(): void {
	tmuxPassthroughEnabled = undefined;
}

function tmuxKittyPassthroughEnabled(): boolean {
	if (!process.env.TMUX || !outerTerminalSupportsKitty(process.env)) return false;
	if (tmuxPassthroughEnabled !== undefined) return tmuxPassthroughEnabled;
	try {
		const value = execFileSync("tmux", ["show-options", "-gv", "allow-passthrough"], {
			encoding: "utf8",
			timeout: 250,
			stdio: ["ignore", "pipe", "ignore"],
		}).trim();
		tmuxPassthroughEnabled = value === "on" || value === "all";
	} catch {
		tmuxPassthroughEnabled = false;
	}
	return tmuxPassthroughEnabled;
}

function outerTerminalSupportsKitty(environment: NodeJS.ProcessEnv): boolean {
	const termProgram = environment.TERM_PROGRAM?.toLowerCase();
	return Boolean(
		environment.KITTY_WINDOW_ID ||
			environment.GHOSTTY_RESOURCES_DIR ||
			environment.WEZTERM_PANE ||
			environment.WARP_SESSION_ID ||
			environment.WARP_TERMINAL_SESSION_UUID ||
			termProgram === "kitty" ||
			termProgram === "ghostty" ||
			termProgram === "wezterm" ||
			termProgram === "warpterminal",
	);
}

function positiveInteger(value: number | undefined, fallback: number): number {
	return Number.isInteger(value) && Number(value) > 0 ? Number(value) : fallback;
}
