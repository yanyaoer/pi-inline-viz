import { stat } from "node:fs/promises";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Container, Text } from "@earendil-works/pi-tui";

import { D2ArtifactAdapter } from "./engines/d2.ts";
import { LatexArtifactAdapter } from "./engines/latex.ts";
import { MermaidArtifactAdapter } from "./engines/mermaid.ts";
import { extractD2Blocks } from "./parser/d2.ts";
import { extractLatexBlocks } from "./parser/latex.ts";
import { extractMermaidBlocks } from "./parser/mermaid.ts";
import { RichMediaPipeline } from "./pipeline.ts";
import { AssetPlanner, readSvgDimensions } from "./planner.ts";
import { currentTerminalEnvironment, limitTerminalViewport } from "./renderer/capabilities.ts";
import { TerminalImageRenderer } from "./renderer/terminal.ts";
import { SvgAssetRenderer } from "./renderer/svg.ts";
import type {
	PlannedAsset,
	RasterPlanPolicy,
	RenderedArtifact,
	RichMediaType,
	TerminalRenderRequest,
} from "./renderer/types.ts";

const ENTRY_TYPE = "agent-artifact-renderer:asset";
const LEGACY_ENTRY_TYPE = "pi-rich-media-renderer:asset";
const SYSTEM_HINT =
	"This Pi session can render fenced D2 and Mermaid diagrams plus LaTeX formulas inline. Emit valid D2 inside a ```d2 fenced code block, Mermaid inside a ```mermaid fenced code block, inline math as $...$, and display math as $$...$$.";
const assetPlanner = new AssetPlanner();
const terminalRenderer = new TerminalImageRenderer();

export interface RichMediaDiagnostics {
	language: string;
	svgBytes: number;
	pngBytes: number;
	contentCacheHit: boolean;
	assetCacheHit: boolean;
	scale: number;
	sourceWidth: number;
	sourceHeight: number;
}

export type RichMediaEntry =
	| {
			status: "ready";
			type: RichMediaType;
			renderer: string;
			key: string;
			contentKey: string;
			sourceHash: string;
			rasterPolicy: RasterPlanPolicy;
			asset: string;
			intermediate: string;
			startLine: number;
			diagnostics: RichMediaDiagnostics;
	  }
	| {
			status: "error";
			type: RichMediaType;
			renderer: string;
			message: string;
			startLine: number;
	  };

export default function richMediaRenderer(pi: ExtensionAPI): void {
	const svgRenderer = new SvgAssetRenderer();
	const d2Pipeline = new RichMediaPipeline(new D2ArtifactAdapter(), svgRenderer);
	const latexPipeline = new RichMediaPipeline(new LatexArtifactAdapter(), svgRenderer);
	const mermaidPipeline = new RichMediaPipeline(new MermaidArtifactAdapter(), svgRenderer);
	const renderEntry: Parameters<typeof pi.registerEntryRenderer<RichMediaEntry>>[1] = (entry, _options, theme) => {
		const data = entry.data;
		if (!data) return;
		if (data.status === "error") {
			return new Text(theme.fg("error", `Rich media render failed: ${data.message}`));
		}
		if (data.renderer !== terminalRenderer.id) {
			return new Text(theme.fg("error", `Unknown terminal renderer: ${data.renderer}`));
		}
		try {
			const environment = currentTerminalEnvironment();
			const viewport = limitTerminalViewport(environment.viewport, 80, 40);
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
			};
			const image = terminalRenderer.render(request, {
				fallbackColor: (text) => theme.fg("dim", text),
			});
			if (!debugEnabled()) return image;
			const container = new Container();
			container.addChild(new Text(theme.fg("dim", formatDebugEntry(data.diagnostics, request, plan))));
			container.addChild(image);
			return container;
		} catch (error) {
			return new Text(theme.fg("error", `Rich media asset unavailable: ${errorMessage(error)}`));
		}
	};
	pi.registerEntryRenderer<RichMediaEntry>(LEGACY_ENTRY_TYPE, renderEntry);
	pi.registerEntryRenderer<RichMediaEntry>(ENTRY_TYPE, renderEntry);

	pi.on("before_agent_start", (event, ctx) => {
		if (!ctx.hasUI) return;
		if (event.systemPrompt.includes(SYSTEM_HINT)) return;
		return { systemPrompt: `${event.systemPrompt}\n\n${SYSTEM_HINT}` };
	});

	pi.on("turn_end", async (event, ctx) => {
		if (!ctx.hasUI) return;
		const markdown = assistantText(event.message);
		if (markdown === undefined) return;

		const blocks = [
			...extractD2Blocks(markdown),
			...extractMermaidBlocks(markdown),
			...extractLatexBlocks(markdown),
		].sort(
			(left, right) => left.startLine - right.startLine || left.endLine - right.endLine,
		);
		for (const block of blocks) {
			try {
				const request = {
					artifact: block,
					options: block.type === "formula" ? { background: "white" as const } : {},
				};
				const artifact = block.format === "d2"
					? await d2Pipeline.render(request)
					: block.format === "mermaid"
						? await mermaidPipeline.render(request)
						: await latexPipeline.render(request);
				const diagnostics = await artifactDiagnostics(block.format, artifact);
				pi.appendEntry<RichMediaEntry>(ENTRY_TYPE, {
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
					diagnostics,
				});
			} catch (error) {
				const message = errorMessage(error);
				pi.appendEntry<RichMediaEntry>(ENTRY_TYPE, {
					status: "error",
					type: block.type,
					renderer: terminalRenderer.id,
					message,
					startLine: block.startLine,
				});
				if (ctx.hasUI) ctx.ui.notify(`${block.format} render failed: ${message}`, "error");
			}
		}
	});
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
): Promise<RichMediaDiagnostics> {
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
	};
}

function debugEnabled(environment: NodeJS.ProcessEnv = process.env): boolean {
	return (environment.AGENT_ARTIFACT_DEBUG ?? environment.PI_RICH_MEDIA_DEBUG) === "1";
}

function formatDebugEntry(
	diagnostics: RichMediaDiagnostics,
	request: TerminalRenderRequest,
	plan: PlannedAsset,
): string {
	const { capabilities, viewport } = request;
	const pixels =
		viewport.pixelWidth !== undefined && viewport.pixelHeight !== undefined
			? ` pixels=${viewport.pixelWidth}x${viewport.pixelHeight}`
			: "";
	return [
		"[RICH]",
		`block: type=${diagnostics.language}`,
		`asset: svg=${diagnostics.svgBytes} bytes png=${diagnostics.pngBytes} bytes`,
		`cache: content=${cacheStatus(diagnostics.contentCacheHit)} asset=${cacheStatus(diagnostics.assetCacheHit)}`,
		`renderer: backend=${capabilities.backend} transport=${capabilities.transport} placeholders=${capabilities.kittyPlaceholders ? "yes" : "no"} scale=${diagnostics.scale}`,
		formatPlan(plan),
		`viewport: cells=${viewport.columns}x${viewport.rows}${pixels} unicode=${capabilities.supportsUnicode ? "yes" : "no"}`,
	].join("\n");
}

function formatPlan(plan: PlannedAsset): string {
	if (plan.kind === "text") return `plan: mode=text key=${plan.cacheKey.slice(0, 12)}`;
	return `plan: mode=raster format=${plan.format} size=${plan.width}x${plan.height} scale=${plan.scale} dpi=${plan.dpi} background=${plan.background} materializer=${plan.materializer.id} key=${plan.cacheKey.slice(0, 12)}`;
}

function cacheStatus(hit: boolean): "hit" | "miss" {
	return hit ? "hit" : "miss";
}
