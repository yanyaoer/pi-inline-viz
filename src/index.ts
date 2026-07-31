import { stat } from "node:fs/promises";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Container, Text } from "@earendil-works/pi-tui";

import { D2ContentRenderer } from "./engines/d2.ts";
import { extractD2Blocks } from "./parser/d2.ts";
import { RichMediaPipeline } from "./pipeline.ts";
import { currentTerminalEnvironment, limitTerminalViewport } from "./renderer/capabilities.ts";
import { TerminalImageRenderer } from "./renderer/terminal.ts";
import { SvgAssetRenderer } from "./renderer/svg.ts";
import type { RenderedArtifact, RichMediaType, TerminalRenderRequest } from "./renderer/types.ts";

const ENTRY_TYPE = "pi-rich-media-renderer:asset";
const SYSTEM_HINT =
	"This Pi session can render fenced D2 blocks inline. When the user asks for a diagram, emit valid D2 inside a ```d2 fenced code block.";
const d2Pipeline = new RichMediaPipeline(new D2ContentRenderer(), new SvgAssetRenderer());
const terminalRenderer = new TerminalImageRenderer();

export interface RichMediaDiagnostics {
	language: string;
	svgBytes: number;
	pngBytes: number;
	contentCacheHit: boolean;
	assetCacheHit: boolean;
	scale: number;
}

export type RichMediaEntry =
	| {
			status: "ready";
			type: RichMediaType;
			renderer: string;
			key: string;
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
	pi.registerEntryRenderer<RichMediaEntry>(ENTRY_TYPE, (entry, _options, theme) => {
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
			const request: TerminalRenderRequest = {
				asset: { format: "png", mediaType: "image/png", path: data.asset },
				capabilities: environment.capabilities,
				viewport: limitTerminalViewport(environment.viewport, 80, 40),
				scalePolicy: { mode: "fixed", scale: data.diagnostics.scale },
			};
			const image = terminalRenderer.render(request, {
				fallbackColor: (text) => theme.fg("dim", text),
			});
			if (!debugEnabled()) return image;
			const container = new Container();
			container.addChild(new Text(theme.fg("dim", formatDebugEntry(data.diagnostics, request))));
			container.addChild(image);
			return container;
		} catch (error) {
			return new Text(theme.fg("error", `Rich media asset unavailable: ${errorMessage(error)}`));
		}
	});

	pi.on("before_agent_start", (event, ctx) => {
		if (!ctx.hasUI) return;
		if (event.systemPrompt.includes(SYSTEM_HINT)) return;
		return { systemPrompt: `${event.systemPrompt}\n\n${SYSTEM_HINT}` };
	});

	pi.on("turn_end", async (event, ctx) => {
		if (!ctx.hasUI) return;
		const markdown = assistantText(event.message);
		if (markdown === undefined) return;

		for (const block of extractD2Blocks(markdown)) {
			try {
				const artifact = await d2Pipeline.render(block);
				const diagnostics = await artifactDiagnostics(block.language, artifact);
				pi.appendEntry<RichMediaEntry>(ENTRY_TYPE, {
					status: "ready",
					type: artifact.type,
					renderer: terminalRenderer.id,
					key: artifact.key,
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
				if (ctx.hasUI) ctx.ui.notify(`D2 render failed: ${message}`, "error");
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
	const [svg, png] = await Promise.all([stat(artifact.intermediate.path), stat(artifact.asset.path)]);
	return {
		language,
		svgBytes: svg.size,
		pngBytes: png.size,
		contentCacheHit: artifact.cacheHit.content,
		assetCacheHit: artifact.cacheHit.asset,
		scale: artifact.profile.scale,
	};
}

function debugEnabled(environment: NodeJS.ProcessEnv = process.env): boolean {
	return environment.PI_RICH_MEDIA_DEBUG === "1";
}

function formatDebugEntry(
	diagnostics: RichMediaDiagnostics,
	request: TerminalRenderRequest,
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
		`renderer: backend=${capabilities.backend} transport=${capabilities.transport} scale=${diagnostics.scale}`,
		`viewport: cells=${viewport.columns}x${viewport.rows}${pixels} unicode=${capabilities.supportsUnicode ? "yes" : "no"}`,
	].join("\n");
}

function cacheStatus(hit: boolean): "hit" | "miss" {
	return hit ? "hit" : "miss";
}
