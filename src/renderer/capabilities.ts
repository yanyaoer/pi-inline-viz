import { execFileSync } from "node:child_process";
import { fstatSync, statSync } from "node:fs";
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
	kittyPlaceholders?: boolean;
}

export function currentTerminalEnvironment(): TerminalEnvironment {
	const tuiCapabilities = getCapabilities();
	const supportsUnicode = terminalSupportsUnicode();
	const tmuxClientTermname = currentTmuxClientTermname(process.env);
	const kittyPlaceholders =
		supportsUnicode &&
		(tmuxClientTermname === undefined
			? directTerminalSupportsKittyUnicodePlaceholders(process.env)
			: kittyCompatibleTerminalName(tmuxClientTermname));
	return {
		capabilities: resolveTerminalCapabilities(tuiCapabilities.images, {
			tmuxKittyPassthrough:
				tmuxClientTermname !== undefined && kittyPlaceholders && tmuxKittyPassthroughEnabled(),
			supportsUnicode,
			kittyPlaceholders,
		}),
		viewport: createTerminalViewport(process.stdout.columns, process.stdout.rows, getCellDimensions()),
	};
}

export function resolveTerminalCapabilities(
	imageProtocol: ImageProtocol,
	options: CapabilityOptions = {},
): TerminalCapabilities {
	if (options.tmuxKittyPassthrough) {
		if (options.supportsUnicode === false) {
			return { backend: "none", transport: "direct", supportsUnicode: false, kittyPlaceholders: false };
		}
		return {
			backend: "kitty",
			transport: "tmux-passthrough",
			supportsUnicode: true,
			kittyPlaceholders: true,
		};
	}
	const backend = imageProtocol === "kitty" ? "kitty" : imageProtocol === "iterm2" ? "iterm" : "none";
	const supportsUnicode = options.supportsUnicode ?? true;
	return {
		backend,
		transport: "direct",
		supportsUnicode,
		kittyPlaceholders:
			backend === "kitty" && supportsUnicode && options.kittyPlaceholders === true,
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

export function terminalSupportsKittyUnicodePlaceholders(
	environment: NodeJS.ProcessEnv = process.env,
	tmuxClientTermname?: string,
): boolean {
	const clientTermname = tmuxClientTermname ?? currentTmuxClientTermname(environment);
	if (clientTermname) return kittyCompatibleTerminalName(clientTermname);
	return directTerminalSupportsKittyUnicodePlaceholders(environment);
}

function directTerminalSupportsKittyUnicodePlaceholders(environment: NodeJS.ProcessEnv): boolean {
	const termProgram = environment.TERM_PROGRAM?.toLowerCase();
	return Boolean(
		environment.KITTY_WINDOW_ID ||
			environment.GHOSTTY_RESOURCES_DIR ||
			termProgram === "kitty" ||
			termProgram === "ghostty",
	);
}

function currentTmuxClientTermname(environment: NodeJS.ProcessEnv): string | undefined {
	const pane = environment.TMUX_PANE;
	if (!environment.TMUX || !pane) return undefined;
	try {
		const [paneTty, clientTermname] = execFileSync(
			"tmux",
			["display-message", "-p", "-t", pane, "#{pane_tty}\t#{client_termname}"],
			{
				encoding: "utf8",
				timeout: 250,
				stdio: ["ignore", "pipe", "ignore"],
			},
		).trimEnd().split("\t");
		if (!paneTty) return undefined;
		const currentTty = fstatSync(process.stdout.fd);
		const tmuxTty = statSync(paneTty);
		if (
			!terminalIsTmuxPane(
				environment,
				currentTty.isCharacterDevice() ? currentTty.rdev : undefined,
				tmuxTty.isCharacterDevice() ? tmuxTty.rdev : undefined,
			)
		) return undefined;
		return clientTermname?.trim() || undefined;
	} catch {
		return undefined;
	}
}

export function terminalIsTmuxPane(
	environment: NodeJS.ProcessEnv,
	currentTtyDevice: number | undefined,
	paneTtyDevice: number | undefined,
): boolean {
	if (!environment.TMUX || !environment.TMUX_PANE) return false;
	return currentTtyDevice !== undefined && currentTtyDevice === paneTtyDevice;
}

function kittyCompatibleTerminalName(name: string): boolean {
	return /^(?:xterm-)?(?:kitty|ghostty)$/iu.test(name.trim());
}

function positiveInteger(value: number | undefined, fallback: number): number {
	return Number.isInteger(value) && Number(value) > 0 ? Number(value) : fallback;
}
