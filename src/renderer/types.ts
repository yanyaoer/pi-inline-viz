import type {
	Artifact,
	ArtifactRenderRequest,
	ArtifactType,
	ExecutionPolicy,
	RendererIdentity,
	ResolvedArtifactRenderRequest,
	ResolvedRenderOptions,
	RasterBackground,
	RasterQuality,
} from "../artifact.ts";

export type RichMediaType = ArtifactType;
export type AssetFormat = "svg" | "png";

export interface RichBlock extends Artifact {
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
	kittyPlaceholders: boolean;
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
	sourceHash: string;
	width: number;
	height: number;
	altText?: string;
}

export interface RasterPlanPolicy {
	materializer: Readonly<RendererIdentity>;
	dpi: number;
	quality: RasterQuality;
	background: RasterBackground;
}

export interface AssetPlanContext {
	terminal: Readonly<TerminalCapabilities>;
	viewport: Readonly<TerminalViewport>;
	policy: Readonly<ScalePolicy>;
	raster?: Readonly<RasterPlanPolicy>;
}

export type PlannedAsset =
	| {
			kind: "raster";
			source: Asset;
			width: number;
			height: number;
			scale: number;
			format: "png" | "rgba";
			materializer: Readonly<RendererIdentity>;
			dpi: number;
			quality: RasterQuality;
			background: RasterBackground;
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
	upscale?: boolean;
}

export interface ArtifactCompatibilityFix {
	from: string;
	to: string;
	reason: string;
}

export interface ArtifactNormalization {
	content: string;
	fixes: readonly ArtifactCompatibilityFix[];
}

export type RenderProfile = ResolvedRenderOptions;

export interface ContentRenderContext {
	sourcePath: string;
	outputPath: string;
}

export interface AssetRenderContext {
	outputPath: string;
	profile: Readonly<RenderProfile>;
	policy: Readonly<ExecutionPolicy>;
}

export interface TerminalRenderContext {
	fallbackColor: (text: string) => string;
}

export interface ArtifactAdapter {
	readonly sourceFilename: string;
	normalize?(request: Readonly<ResolvedArtifactRenderRequest>): ArtifactNormalization;
	validate(request: Readonly<ResolvedArtifactRenderRequest>): void;
	getIdentity(): Promise<RendererIdentity>;
	render(
		request: Readonly<ResolvedArtifactRenderRequest>,
		context: ContentRenderContext,
	): Promise<Asset>;
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
	artifact: Readonly<Artifact>;
	artifactKey: string;
	renderKey: string;
	type: RichMediaType;
	key: string;
	contentKey: string;
	sourceHash: string;
	sourcePath: string;
	intermediate: Asset;
	asset: Asset;
	assetRenderer: Readonly<RendererIdentity>;
	profile: Readonly<RenderProfile>;
	metadataPath: string;
	compatibilityFixes: readonly ArtifactCompatibilityFix[];
	cacheHit: {
		content: boolean;
		asset: boolean;
	};
}

export type {
	ArtifactRenderRequest,
	ExecutionPolicy,
	RendererIdentity,
	ResolvedArtifactRenderRequest,
	ResolvedRenderOptions,
	RasterBackground,
	RasterQuality,
};
