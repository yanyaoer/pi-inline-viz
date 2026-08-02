import { execFile } from "node:child_process";
import { stat } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import type {
	CustomEntry,
	ExtensionAPI,
	SessionEntry,
	Theme,
} from "@earendil-works/pi-coding-agent";
import { Container, hyperlink, Text, type Component } from "@earendil-works/pi-tui";

import { D2ArtifactAdapter } from "./adapters/d2.ts";
import { GraphvizArtifactAdapter } from "./adapters/graphviz.ts";
import { LatexArtifactAdapter } from "./adapters/latex.ts";
import { MermaidArtifactAdapter } from "./adapters/mermaid.ts";
import { defaultArtifactCacheDirectory } from "./config.ts";
import { formatArtifactDoctorReport, inspectArtifactRuntime } from "./doctor.ts";
import { extractD2Blocks } from "./parser/d2.ts";
import { extractGraphvizBlocks } from "./parser/graphviz.ts";
import { extractLatexBlocks } from "./parser/latex.ts";
import { extractMermaidBlocks } from "./parser/mermaid.ts";
import { ArtifactPipeline } from "./pipeline.ts";
import { artifactPaletteFromPiTheme } from "./pi-theme.ts";
import { AssetPlanner, readSvgDimensions } from "./planner.ts";
import { currentTerminalEnvironment, limitTerminalViewport } from "./renderer/capabilities.ts";
import { TerminalImageRenderer } from "./renderer/terminal.ts";
import { SvgAssetRenderer } from "./renderer/svg.ts";
import type {
	ArtifactCompatibilityFix,
	PlannedAsset,
	RasterPlanPolicy,
	RenderedArtifact,
	ArtifactMediaType,
	TerminalRenderRequest,
} from "./renderer/types.ts";
import type { ArtifactPalette } from "./palette.ts";

const execFileAsync = promisify(execFile);
const ENTRY_TYPE = "pi-inline-viz:asset";
const CONTROL_ENTRY_TYPE = "pi-inline-viz:control";
const LEGACY_ENTRY_TYPES = ["agent-artifact-renderer:asset", "pi-rich-media-renderer:asset"] as const;
const SYSTEM_HINT =
	"This Pi session can render fenced D2, Graphviz DOT, and Mermaid diagrams plus display LaTeX formulas. Emit valid D2 inside a ```d2 fenced code block, Graphviz DOT inside a ```dot fenced code block, Mermaid inside a ```mermaid fenced code block, and display math as $$...$$. Use plain text or Unicode for inline math. Prefer top-to-bottom layouts for large diagrams so labels remain readable in a terminal.";
const INLINE_MAX_COLUMNS = 256;
const INLINE_MAX_ROWS = 40;
const FORMULA_MAX_ROWS = 5;
const FORMULA_LEFT_PADDING = 1;
const assetPlanner = new AssetPlanner();
const terminalRenderer = new TerminalImageRenderer();
const PRESENTATION_ACTIONS = ["on", "off", "clear", "draw"] as const;

type PresentationAction = (typeof PRESENTATION_ACTIONS)[number];
type PresentationOverride = {
	mode: "clear" | "draw";
	throughSequence: number;
};

interface PresentationState {
	enabled: boolean;
	override?: PresentationOverride;
	sequence: number;
	revision: number;
}

interface PresentationControlEntry {
	version: 1;
	sequence: number;
	enabled: boolean;
	override?: PresentationOverride;
}

export interface ArtifactDiagnostics {
	language: string;
	svgBytes: number;
	pngBytes: number;
	contentCacheHit: boolean;
	assetCacheHit: boolean;
	scale: number;
	sourceWidth: number;
	sourceHeight: number;
	compatibilityFixes?: readonly ArtifactCompatibilityFix[];
	palette?: Readonly<ArtifactPalette>;
}

export type ArtifactEntry =
	| {
			status: "ready";
			type: ArtifactMediaType;
			renderer: string;
			key: string;
			contentKey: string;
			sourceHash: string;
			rasterPolicy: RasterPlanPolicy;
			asset: string;
			intermediate: string;
			startLine: number;
			format?: string;
			source?: string;
			sequence?: number;
			diagnostics: ArtifactDiagnostics;
	  }
	| {
			status: "error";
			type: ArtifactMediaType;
			renderer: string;
			message: string;
			startLine: number;
			format?: string;
			source?: string;
			sequence?: number;
	  };

export default function piInlineViz(pi: ExtensionAPI): void {
	const presentation = createPresentationState();
	const svgRenderer = new SvgAssetRenderer();
	const d2Pipeline = new ArtifactPipeline(new D2ArtifactAdapter(), svgRenderer);
	const graphvizPipeline = new ArtifactPipeline(new GraphvizArtifactAdapter(), svgRenderer);
	const latexPipeline = new ArtifactPipeline(new LatexArtifactAdapter(), svgRenderer);
	const mermaidPipeline = new ArtifactPipeline(new MermaidArtifactAdapter(), svgRenderer);
	const renderEntry: Parameters<typeof pi.registerEntryRenderer<ArtifactEntry>>[1] = (entry, _options, theme) => {
		const data = entry.data;
		if (!data) return;
		return new PresentationAwareArtifact(
			presentation,
			data.sequence ?? 0,
			() => renderArtifact(data, theme),
			() => renderArtifactFallback(data, theme),
		);
	};
	pi.registerEntryRenderer<ArtifactEntry>(ENTRY_TYPE, renderEntry);
	for (const legacyType of LEGACY_ENTRY_TYPES) {
		pi.registerEntryRenderer<ArtifactEntry>(legacyType, renderEntry);
	}
	registerCommands(pi, presentation);

	const restoreState = (_event: unknown, ctx: { sessionManager: { getBranch(): SessionEntry[] } }) => {
		restorePresentationState(presentation, ctx.sessionManager.getBranch());
	};
	pi.on("session_start", restoreState);
	pi.on("session_tree", restoreState);

	pi.on("before_agent_start", (event, ctx) => {
		if (!ctx.hasUI) return;
		if (!presentation.enabled) return;
		if (event.systemPrompt.includes(SYSTEM_HINT)) return;
		return { systemPrompt: `${event.systemPrompt}\n\n${SYSTEM_HINT}` };
	});

	pi.on("turn_end", async (event, ctx) => {
		if (!ctx.hasUI) return;
		if (!presentation.enabled) return;
		const markdown = assistantText(event.message);
		if (markdown === undefined) return;

		const blocks = [
			...extractD2Blocks(markdown),
			...extractGraphvizBlocks(markdown),
			...extractMermaidBlocks(markdown),
			...extractLatexBlocks(markdown).filter((block) => block.format === "latex-display"),
		].sort(
			(left, right) => left.startLine - right.startLine || left.endLine - right.endLine,
		);
		const palette = artifactPaletteFromPiTheme(ctx.ui.theme);
		for (const block of blocks) {
			const sequence = nextPresentationSequence(presentation);
			try {
				const request = {
					artifact: block,
					options: {
						palette,
						background: block.type === "formula" ? ("transparent" as const) : palette.background,
					},
				};
				const artifact = block.format === "d2"
					? await d2Pipeline.render(request)
					: block.format === "dot"
						? await graphvizPipeline.render(request)
						: block.format === "mermaid"
							? await mermaidPipeline.render(request)
							: await latexPipeline.render(request);
				const diagnostics = await artifactDiagnostics(block.format, artifact);
				pi.appendEntry<ArtifactEntry>(ENTRY_TYPE, {
					status: "ready",
					type: artifact.type,
					renderer: terminalRenderer.id,
					key: artifact.key,
					contentKey: artifact.contentKey,
					sourceHash: artifact.sourceHash,
					rasterPolicy: {
						materializer: artifact.assetRenderer,
						dpi: artifact.profile.dpi,
						quality: artifact.profile.quality,
						background: artifact.profile.background,
					},
					asset: artifact.asset.path,
					intermediate: artifact.intermediate.path,
					startLine: block.startLine,
					format: block.format,
					source: block.content,
					sequence,
					diagnostics,
				});
			} catch (error) {
				const message = errorMessage(error);
				pi.appendEntry<ArtifactEntry>(ENTRY_TYPE, {
					status: "error",
					type: block.type,
					renderer: terminalRenderer.id,
					message,
					startLine: block.startLine,
					format: block.format,
					source: block.content,
					sequence,
				});
				if (ctx.hasUI) ctx.ui.notify(`${block.format} render failed: ${message}`, "error");
			}
		}
	});
}

class PresentationAwareArtifact implements Component {
	#component: Component | undefined;
	#revision = -1;

	constructor(
		readonly state: PresentationState,
		readonly sequence: number,
		readonly draw: () => Component,
		readonly fallback: () => Component,
	) {}

	render(width: number): string[] {
		this.#sync();
		return this.#component?.render(width) ?? [];
	}

	invalidate(): void {
		this.#component?.invalidate();
	}

	#sync(): void {
		if (this.#component && this.#revision === this.state.revision) return;
		this.#component = shouldDrawArtifact(this.state, this.sequence) ? this.draw() : this.fallback();
		this.#revision = this.state.revision;
	}
}

function renderArtifact(data: ArtifactEntry, theme: Theme): Component {
	if (data.status === "error") {
		return new Text(theme.fg("error", `Artifact render failed: ${data.message}`));
	}
	if (data.renderer !== terminalRenderer.id) {
		return new Text(theme.fg("error", `Unknown terminal renderer: ${data.renderer}`));
	}
	try {
		const environment = currentTerminalEnvironment();
		const viewport = limitTerminalViewport(
			environment.viewport,
			INLINE_MAX_COLUMNS,
			INLINE_MAX_ROWS,
		);
		const plan = assetPlanner.plan(
			{
				source: { format: "svg", mediaType: "image/svg+xml", path: data.intermediate },
				sourceHash: data.sourceHash,
				width: data.diagnostics.sourceWidth,
				height: data.diagnostics.sourceHeight,
				altText: data.asset,
			},
			{
				terminal: environment.capabilities,
				viewport,
				policy: { mode: "fixed", scale: data.diagnostics.scale },
				raster: data.rasterPolicy,
			},
		);
		if (plan.kind === "raster" && plan.cacheKey !== data.key) {
			throw new Error("cached raster does not satisfy the current asset plan");
		}
		const request: TerminalRenderRequest = {
			asset: { format: "png", mediaType: "image/png", path: data.asset },
			capabilities: environment.capabilities,
			viewport,
			scalePolicy: { mode: "fixed", scale: data.diagnostics.scale },
			upscale: false,
			...(data.type === "formula"
				? { maxHeightCells: FORMULA_MAX_ROWS, leftPaddingCells: FORMULA_LEFT_PADDING }
				: {}),
		};
		const image = terminalRenderer.render(request, {
			fallbackColor: (text) => theme.fg("dim", text),
		});
		const container = new Container();
		if (debugEnabled()) {
			container.addChild(new Text(theme.fg("dim", formatDebugEntry(data.diagnostics, request, plan))));
		}
		container.addChild(image);
		container.addChild(
			new Text(
				artifactOpenLink(
					data.asset,
					theme.fg("accent", `${data.type === "formula" ? " " : ""}[open/zoom]`),
				),
			),
		);
		return container;
	} catch (error) {
		return new Text(theme.fg("error", `Artifact asset unavailable: ${errorMessage(error)}`));
	}
}

function renderArtifactFallback(data: ArtifactEntry, theme: Theme): Component {
	const format = data.format ?? (data.status === "ready" ? data.diagnostics.language : data.type);
	if (data.source === undefined) {
		return new Text(theme.fg("dim", `[inline-viz ${format} hidden; source is in the message above]`));
	}
	const source = sanitizeFallbackSource(data.source);
	if (data.type === "formula") {
		return new Text(theme.fg("dim", `$$\n${source}\n$$`));
	}
	const fence = markdownFence(source);
	return new Text(theme.fg("dim", `${fence}${format}\n${source}\n${fence}`));
}

function sanitizeFallbackSource(source: string): string {
	return source
		.replace(/\r\n?/gu, "\n")
		.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/gu, "");
}

function markdownFence(source: string): string {
	let longest = 0;
	for (const match of source.matchAll(/`+/gu)) longest = Math.max(longest, match[0].length);
	return "`".repeat(Math.max(3, longest + 1));
}

function createPresentationState(): PresentationState {
	return { enabled: true, sequence: 0, revision: 0 };
}

function nextPresentationSequence(state: PresentationState): number {
	state.sequence += 1;
	return state.sequence;
}

function shouldDrawArtifact(state: PresentationState, sequence: number): boolean {
	const override = state.override;
	if (override && sequence <= override.throughSequence) return override.mode === "draw";
	return state.enabled;
}

function applyPresentationAction(state: PresentationState, action: PresentationAction): void {
	const sequence = nextPresentationSequence(state);
	if (action === "on" || action === "off") {
		state.enabled = action === "on";
		delete state.override;
	} else {
		state.override = { mode: action, throughSequence: sequence };
	}
	state.revision += 1;
}

function snapshotPresentationState(state: PresentationState): PresentationControlEntry {
	return {
		version: 1,
		sequence: state.sequence,
		enabled: state.enabled,
		...(state.override ? { override: { ...state.override } } : {}),
	};
}

function restorePresentationState(state: PresentationState, entries: readonly SessionEntry[]): void {
	let sequence = 0;
	let restored: PresentationControlEntry | undefined;
	for (const entry of entries) {
		if (entry.type !== "custom") continue;
		if (entry.customType !== CONTROL_ENTRY_TYPE && !isArtifactEntryType(entry.customType)) continue;
		const entrySequence = readSequence(entry.data);
		if (entrySequence !== undefined) sequence = Math.max(sequence, entrySequence);
		if (entry.customType !== CONTROL_ENTRY_TYPE) continue;
		const control = parsePresentationControl(entry);
		if (control) restored = control;
	}
	state.enabled = restored?.enabled ?? true;
	state.sequence = Math.max(sequence, restored?.sequence ?? 0);
	if (restored?.override) state.override = { ...restored.override };
	else delete state.override;
	state.revision += 1;
}

function isArtifactEntryType(customType: string): boolean {
	return customType === ENTRY_TYPE || LEGACY_ENTRY_TYPES.some((legacyType) => legacyType === customType);
}

function parsePresentationControl(entry: CustomEntry<unknown>): PresentationControlEntry | undefined {
	const data = entry.data;
	if (typeof data !== "object" || data === null) return undefined;
	const candidate = data as Record<string, unknown>;
	if (candidate.version !== 1 || typeof candidate.enabled !== "boolean") return undefined;
	const sequence = readSequence(candidate);
	if (sequence === undefined) return undefined;
	const override = parsePresentationOverride(candidate.override);
	if (candidate.override !== undefined && override === undefined) return undefined;
	return {
		version: 1,
		sequence,
		enabled: candidate.enabled,
		...(override ? { override } : {}),
	};
}

function parsePresentationOverride(value: unknown): PresentationOverride | undefined {
	if (typeof value !== "object" || value === null) return undefined;
	const candidate = value as Record<string, unknown>;
	if (candidate.mode !== "clear" && candidate.mode !== "draw") return undefined;
	const throughSequence = readSequence({ sequence: candidate.throughSequence });
	if (throughSequence === undefined) return undefined;
	return { mode: candidate.mode, throughSequence };
}

function readSequence(value: unknown): number | undefined {
	if (typeof value !== "object" || value === null) return undefined;
	const sequence = (value as { sequence?: unknown }).sequence;
	return Number.isSafeInteger(sequence) && Number(sequence) >= 0 ? Number(sequence) : undefined;
}

function registerCommands(pi: ExtensionAPI, state: PresentationState): void {
	pi.registerCommand("inline-viz", {
		description: "Control inline artifacts: on, off, clear, or draw",
		getArgumentCompletions: (prefix) => {
			const normalized = prefix.trim().toLowerCase();
			return PRESENTATION_ACTIONS.filter((action) => action.startsWith(normalized)).map((action) => ({
				value: action,
				label: action,
				description: presentationActionDescription(action),
			}));
		},
		handler: async (args, ctx) => {
			const action = args.trim().toLowerCase();
			if (!isPresentationAction(action)) {
				ctx.ui.notify("Usage: /inline-viz on|off|clear|draw", "warning");
				return;
			}
			applyPresentationAction(state, action);
			pi.appendEntry<PresentationControlEntry>(CONTROL_ENTRY_TYPE, snapshotPresentationState(state));
			ctx.ui.notify(presentationActionResult(action, state), "info");
		},
	});

	pi.registerCommand("inline-viz-doctor", {
		description: "Check Pi Inline Viz renderers and terminal support",
		handler: async (_args, ctx) => {
			const [report, terminal] = await Promise.all([
				inspectArtifactRuntime(),
				currentTerminalEnvironment(),
			]);
			const terminalSummary = `${terminal.capabilities.backend}/${terminal.capabilities.transport}; Unicode placeholders=${terminal.capabilities.kittyPlaceholders ? "yes" : "no"}`;
			ctx.ui.notify(
				formatArtifactDoctorReport(report, terminalSummary),
				report.ready ? "info" : "warning",
			);
		},
	});

	pi.registerCommand("inline-viz-install-ratex", {
		description: "Install the pinned RaTeX formula renderer",
		handler: async (_args, ctx) => {
			const confirmed = await ctx.ui.confirm(
				"Install RaTeX renderer?",
				"Download the pinned release, verify its SHA-256, and install it in the Pi Inline Viz cache?",
			);
			if (!confirmed) return;
			ctx.ui.notify("Installing the RaTeX renderer...", "info");
			try {
				const installed = await installRatex();
				ctx.ui.notify(
					`RaTeX installed at ${installed.path}. Run /inline-viz-doctor to verify.`,
					"info",
				);
			} catch (error) {
				ctx.ui.notify(`RaTeX installation failed: ${errorMessage(error)}`, "error");
			}
		},
	});
}

function isPresentationAction(value: string): value is PresentationAction {
	return PRESENTATION_ACTIONS.some((action) => action === value);
}

function presentationActionDescription(action: PresentationAction): string {
	switch (action) {
		case "on":
			return "Enable future rendering and draw stored artifacts";
		case "off":
			return "Disable future rendering and show source blocks";
		case "clear":
			return "Replace current artifacts with source blocks";
		case "draw":
			return "Redraw current artifacts from cached assets";
	}
}

function presentationActionResult(action: PresentationAction, state: PresentationState): string {
	switch (action) {
		case "on":
			return "Pi Inline Viz enabled; stored artifacts are drawn and future blocks will render.";
		case "off":
			return "Pi Inline Viz disabled; stored artifacts use source fallback and future blocks will not render.";
		case "clear":
			return `Current inline artifacts cleared; future artifacts are ${state.enabled ? "enabled" : "disabled"}.`;
		case "draw":
			return `Current inline artifacts redrawn; future artifacts are ${state.enabled ? "enabled" : "disabled"}.`;
	}
}

async function installRatex(): Promise<{ path: string }> {
	const script = fileURLToPath(new URL("../scripts/install-ratex.mjs", import.meta.url));
	const result = await execFileAsync(process.execPath, [script], {
		cwd: dirname(script),
		env: {
			...process.env,
			HOME: homedir(),
			PI_INLINE_VIZ_CACHE_DIR: defaultArtifactCacheDirectory(),
		},
		encoding: "utf8",
		timeout: 120_000,
		maxBuffer: 1024 * 1024,
		windowsHide: true,
	});
	const output = String(result.stdout).trim();
	const parsed = JSON.parse(output) as { ok?: unknown; path?: unknown };
	if (parsed.ok !== true || typeof parsed.path !== "string") {
		throw new Error("RaTeX installer returned an invalid result");
	}
	return { path: parsed.path };
}

function assistantText(message: unknown): string | undefined {
	const candidate = message as { role?: unknown; content?: unknown };
	if (candidate.role !== "assistant") return undefined;
	if (typeof candidate.content === "string") return candidate.content;
	if (!Array.isArray(candidate.content)) return undefined;
	return candidate.content
		.filter((block): block is { type: "text"; text: string } => {
			if (typeof block !== "object" || block === null) return false;
			const item = block as { type?: unknown; text?: unknown };
			return item.type === "text" && typeof item.text === "string";
		})
		.map((block) => block.text)
		.join("\n");
}

function errorMessage(error: unknown): string {
	const message = error instanceof Error ? error.message : String(error);
	return message.length <= 500 ? message : `${message.slice(0, 497)}...`;
}

async function artifactDiagnostics(
	language: string,
	artifact: RenderedArtifact,
): Promise<ArtifactDiagnostics> {
	const [svg, png, dimensions] = await Promise.all([
		stat(artifact.intermediate.path),
		stat(artifact.asset.path),
		readSvgDimensions(artifact.intermediate.path, artifact.profile.dpi),
	]);
	return {
		language,
		svgBytes: svg.size,
		pngBytes: png.size,
		contentCacheHit: artifact.cacheHit.content,
		assetCacheHit: artifact.cacheHit.asset,
		scale: artifact.profile.scale,
		sourceWidth: dimensions.width,
		sourceHeight: dimensions.height,
		compatibilityFixes: artifact.compatibilityFixes,
		palette: artifact.profile.palette,
	};
}

function debugEnabled(environment: NodeJS.ProcessEnv = process.env): boolean {
	return (
		environment.PI_INLINE_VIZ_DEBUG ??
		environment.AGENT_ARTIFACT_DEBUG ??
		environment.PI_RICH_MEDIA_DEBUG
	) === "1";
}

function formatDebugEntry(
	diagnostics: ArtifactDiagnostics,
	request: TerminalRenderRequest,
	plan: PlannedAsset,
): string {
	const { capabilities, viewport } = request;
	const pixels =
		viewport.pixelWidth !== undefined && viewport.pixelHeight !== undefined
			? ` pixels=${viewport.pixelWidth}x${viewport.pixelHeight}`
			: "";
	return [
		"[PI INLINE VIZ]",
		`block: type=${diagnostics.language}`,
		`asset: svg=${diagnostics.svgBytes} bytes png=${diagnostics.pngBytes} bytes`,
		`cache: content=${cacheStatus(diagnostics.contentCacheHit)} asset=${cacheStatus(diagnostics.assetCacheHit)}`,
		`compatibility: ${formatCompatibilityFixes(diagnostics.compatibilityFixes)}`,
		`theme: ${formatPalette(diagnostics.palette)}`,
		`renderer: backend=${capabilities.backend} transport=${capabilities.transport} placeholders=${capabilities.kittyPlaceholders ? "yes" : "no"} scale=${diagnostics.scale}`,
		formatPlan(plan),
		`viewport: cells=${viewport.columns}x${viewport.rows}${pixels} unicode=${capabilities.supportsUnicode ? "yes" : "no"}`,
	].join("\n");
}

function formatPalette(palette: Readonly<ArtifactPalette> | undefined): string {
	if (!palette) return "legacy";
	return `${palette.mode} bg=${palette.background} fg=${palette.foreground} accent=${palette.accent}`;
}

function formatCompatibilityFixes(fixes: readonly ArtifactCompatibilityFix[] | undefined): string {
	return fixes === undefined || fixes.length === 0
		? "none"
		: fixes.map((fix) => `${fix.from}->${fix.to}`).join(", ");
}

function formatPlan(plan: PlannedAsset): string {
	if (plan.kind === "text") return `plan: mode=text key=${plan.cacheKey.slice(0, 12)}`;
	return `plan: mode=raster format=${plan.format} size=${plan.width}x${plan.height} scale=${plan.scale} dpi=${plan.dpi} background=${plan.background} materializer=${plan.materializer.id} key=${plan.cacheKey.slice(0, 12)}`;
}

function cacheStatus(hit: boolean): "hit" | "miss" {
	return hit ? "hit" : "miss";
}

function artifactOpenLink(assetPath: string, label: string): string {
	return hyperlink(label, pathToFileURL(assetPath).href);
}
