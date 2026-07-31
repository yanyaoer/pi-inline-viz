export type RichMediaType = "diagram" | "formula" | "chart";
export type AssetFormat = "svg" | "png";

export interface RichBlock {
	type: RichMediaType;
	language: string;
	content: string;
	startLine: number;
	endLine: number;
}

export interface Asset {
	format: AssetFormat;
	mediaType: "image/svg+xml" | "image/png";
	path: string;
}

export type TerminalBackend = "kitty" | "iterm" | "sixel" | "none";
export type TerminalTransport = "direct" | "tmux-passthrough";

export interface TerminalCapabilities {
	backend: TerminalBackend;
	transport: TerminalTransport;
	supportsUnicode: boolean;
}

export interface TerminalViewport {
	columns: number;
	rows: number;
	pixelWidth?: number;
	pixelHeight?: number;
}

export type ScalePolicy = { mode: "auto" } | { mode: "fixed"; scale: number };

export interface AssetPlanInput {
	source: Asset;
	sourceKey: string;
	width: number;
	height: number;
	altText?: string;
}

export interface AssetPlanContext {
	terminal: Readonly<TerminalCapabilities>;
	viewport: Readonly<TerminalViewport>;
	policy: Readonly<ScalePolicy>;
}

export type PlannedAsset =
	| {
			kind: "raster";
			source: Asset;
			width: number;
			height: number;
			scale: number;
			format: "png" | "rgba";
			cacheKey: string;
	  }
	| {
			kind: "text";
			source: Asset;
			altText: string;
			cacheKey: string;
	  };

export interface TerminalRenderRequest {
	asset: Asset;
	capabilities: Readonly<TerminalCapabilities>;
	viewport: Readonly<TerminalViewport>;
	scalePolicy: Readonly<ScalePolicy>;
}

export interface RendererIdentity {
	id: string;
	version: string;
}

export interface RenderProfile {
	theme: number;
	dpi: number;
	scale: number;
}

export interface ResourceBudget {
	timeoutMs: number;
	maxInputBytes: number;
	maxOutputBytes: number;
	network: boolean;
}

export const DEFAULT_RENDER_PROFILE: Readonly<RenderProfile> = Object.freeze({
	theme: 0,
	dpi: 96,
	scale: 1,
});

export const DEFAULT_RESOURCE_BUDGET: Readonly<ResourceBudget> = Object.freeze({
	timeoutMs: 15_000,
	maxInputBytes: 256 * 1024,
	maxOutputBytes: 20 * 1024 * 1024,
	network: false,
});

export interface ContentRenderContext {
	sourcePath: string;
	outputPath: string;
	profile: Readonly<RenderProfile>;
	budget: Readonly<ResourceBudget>;
}

export interface AssetRenderContext {
	outputPath: string;
	profile: Readonly<RenderProfile>;
	budget: Readonly<ResourceBudget>;
}

export interface TerminalRenderContext {
	fallbackColor: (text: string) => string;
}

export interface ContentRenderer<TBlock extends RichBlock = RichBlock> {
	readonly sourceFilename: string;
	validate(block: TBlock, budget: Readonly<ResourceBudget>): void;
	getIdentity(): Promise<RendererIdentity>;
	render(block: TBlock, context: ContentRenderContext): Promise<Asset>;
}

export interface AssetRenderer {
	getIdentity(): Promise<RendererIdentity>;
	render(asset: Asset, context: AssetRenderContext): Promise<Asset>;
}

export interface TerminalRenderer<TOutput> {
	readonly id: string;
	render(request: TerminalRenderRequest, context: TerminalRenderContext): TOutput;
}

export interface RenderedArtifact {
	type: RichMediaType;
	key: string;
	contentKey: string;
	sourcePath: string;
	intermediate: Asset;
	asset: Asset;
	profile: Readonly<RenderProfile>;
	metadataPath: string;
	cacheHit: {
		content: boolean;
		asset: boolean;
	};
}
