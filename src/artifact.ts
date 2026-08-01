import { createHash } from "node:crypto";

export const ARTIFACT_VERSION = 1 as const;

export type ArtifactType = "diagram" | "formula" | "chart";
export type RasterQuality = "default";
export type RasterBackground = "transparent" | "white";

export interface Artifact {
	version: typeof ARTIFACT_VERSION;
	type: ArtifactType;
	format: string;
	content: string;
}

export interface RenderOptions {
	theme?: string;
	dpi?: number;
	scale?: number;
	quality?: RasterQuality;
	background?: RasterBackground;
}

export interface ResolvedRenderOptions {
	theme: string;
	dpi: number;
	scale: number;
	quality: RasterQuality;
	background: RasterBackground;
}

export interface ExecutionPolicy {
	timeoutMs: number;
	maxInputBytes: number;
	maxOutputBytes: number;
	network: "deny";
	filesystem: "isolated-workdir";
}

export interface ArtifactRenderRequest {
	artifact: Readonly<Artifact>;
	options?: Readonly<RenderOptions>;
	policy?: Readonly<ExecutionPolicy>;
}

export interface ResolvedArtifactRenderRequest {
	artifact: Readonly<Artifact>;
	options: Readonly<ResolvedRenderOptions>;
	policy: Readonly<ExecutionPolicy>;
}

export interface RendererIdentity {
	id: string;
	version: string;
}

export const DEFAULT_RENDER_OPTIONS: Readonly<ResolvedRenderOptions> = Object.freeze({
	theme: "0",
	dpi: 96,
	scale: 1,
	quality: "default",
	background: "transparent",
});

export const DEFAULT_EXECUTION_POLICY: Readonly<ExecutionPolicy> = Object.freeze({
	timeoutMs: 15_000,
	maxInputBytes: 256 * 1024,
	maxOutputBytes: 20 * 1024 * 1024,
	network: "deny",
	filesystem: "isolated-workdir",
});

export function validateArtifact(artifact: Readonly<Artifact>): void {
	if (artifact.version !== ARTIFACT_VERSION) {
		throw new Error(`unsupported artifact version: ${String(artifact.version)}`);
	}
	if (artifact.type !== "diagram" && artifact.type !== "formula" && artifact.type !== "chart") {
		throw new Error(`unsupported artifact type: ${String(artifact.type)}`);
	}
	if (!/^[a-z0-9][a-z0-9+.-]{0,63}$/u.test(artifact.format)) {
		throw new Error(`invalid artifact format: ${String(artifact.format)}`);
	}
	if (typeof artifact.content !== "string") throw new Error("artifact content must be a string");
}

export function resolveRenderOptions(options: Readonly<RenderOptions>): Readonly<ResolvedRenderOptions> {
	for (const key of Object.keys(options)) {
		if (!RENDER_OPTION_KEYS.has(key)) throw new Error(`unsupported render option: ${key}`);
	}
	const resolved: ResolvedRenderOptions = {
		theme: options.theme ?? DEFAULT_RENDER_OPTIONS.theme,
		dpi: options.dpi ?? DEFAULT_RENDER_OPTIONS.dpi,
		scale: options.scale ?? DEFAULT_RENDER_OPTIONS.scale,
		quality: options.quality ?? DEFAULT_RENDER_OPTIONS.quality,
		background: options.background ?? DEFAULT_RENDER_OPTIONS.background,
	};
	validateResolvedRenderOptions(resolved);
	return Object.freeze(resolved);
}

const RENDER_OPTION_KEYS = new Set(["theme", "dpi", "scale", "quality", "background"]);

export function resolveArtifactRenderRequest(
	request: Readonly<ArtifactRenderRequest>,
): Readonly<ResolvedArtifactRenderRequest> {
	validateArtifact(request.artifact);
	const artifact: Readonly<Artifact> = Object.freeze({
		version: request.artifact.version,
		type: request.artifact.type,
		format: request.artifact.format,
		content: request.artifact.content,
	});
	const requestedPolicy = request.policy ?? DEFAULT_EXECUTION_POLICY;
	validateExecutionPolicy(requestedPolicy);
	const policy: Readonly<ExecutionPolicy> = Object.freeze({
		timeoutMs: requestedPolicy.timeoutMs,
		maxInputBytes: requestedPolicy.maxInputBytes,
		maxOutputBytes: requestedPolicy.maxOutputBytes,
		network: requestedPolicy.network,
		filesystem: requestedPolicy.filesystem,
	});
	return Object.freeze({
		artifact,
		options: resolveRenderOptions(request.options ?? {}),
		policy,
	});
}

export function artifactIdentity(artifact: Readonly<Artifact>): string {
	validateArtifact(artifact);
	return hashIdentity({
		version: artifact.version,
		type: artifact.type,
		format: artifact.format,
		content: artifact.content,
	});
}

export function artifactRenderIdentity(input: {
	artifactKey: string;
	adapter: Readonly<RendererIdentity>;
	options: Readonly<RenderOptions>;
}): string {
	const options = resolveRenderOptions(input.options);
	return hashIdentity({
		version: 1,
		artifact_key: input.artifactKey,
		adapter: input.adapter,
		// Only adapter-stage options belong to the SVG identity. Raster options
		// remain in the existing raster key so scale/background reuse the SVG.
		options: { theme: options.theme },
	});
}

export function canonicalRenderOptions(options: Readonly<RenderOptions>): string {
	return canonicalSerialize(resolveRenderOptions(options));
}

export function hashIdentity(identity: unknown): string {
	return createHash("sha256").update(canonicalSerialize(identity)).digest("hex");
}

export function canonicalSerialize(value: unknown): string {
	return JSON.stringify(canonicalize(value, new Set<object>()));
}

function validateResolvedRenderOptions(options: ResolvedRenderOptions): void {
	if (!options.theme || options.theme.length > 64 || /[\u0000-\u001f\u007f]/u.test(options.theme)) {
		throw new Error("theme must be a non-empty string without control characters");
	}
	if (!Number.isFinite(options.dpi) || options.dpi <= 0) throw new Error("dpi must be positive");
	if (!Number.isFinite(options.scale) || options.scale <= 0) throw new Error("scale must be positive");
	if (options.quality !== "default") {
		throw new Error(`unsupported raster quality: ${String(options.quality)}`);
	}
	if (options.background !== "transparent" && options.background !== "white") {
		throw new Error(`unsupported raster background: ${String(options.background)}`);
	}
}

function validateExecutionPolicy(policy: Readonly<ExecutionPolicy>): void {
	if (!Number.isInteger(policy.timeoutMs) || policy.timeoutMs <= 0) {
		throw new Error("timeoutMs must be positive");
	}
	if (!Number.isInteger(policy.maxInputBytes) || policy.maxInputBytes <= 0) {
		throw new Error("maxInputBytes must be positive");
	}
	if (!Number.isInteger(policy.maxOutputBytes) || policy.maxOutputBytes <= 0) {
		throw new Error("maxOutputBytes must be positive");
	}
	if (policy.network !== "deny") throw new Error("networked renderers are not supported");
	if (policy.filesystem !== "isolated-workdir") {
		throw new Error("renderers require an isolated working directory");
	}
}

function canonicalize(value: unknown, ancestors: Set<object>): unknown {
	if (value === null || typeof value === "string" || typeof value === "boolean") return value;
	if (typeof value === "number") {
		if (!Number.isFinite(value)) throw new Error("identity numbers must be finite");
		return value;
	}
	if (typeof value !== "object") throw new Error(`unsupported identity value: ${typeof value}`);
	if (ancestors.has(value)) throw new Error("identity values must not contain cycles");
	ancestors.add(value);
	try {
		if (Array.isArray(value)) return value.map((item) => canonicalize(item, ancestors));
		const prototype = Object.getPrototypeOf(value);
		if (prototype !== Object.prototype && prototype !== null) {
			throw new Error("identity values must contain only plain objects and arrays");
		}
		return Object.fromEntries(
			Object.entries(value)
				.sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
				.map(([key, item]) => [key, canonicalize(item, ancestors)]),
		);
	} finally {
		ancestors.delete(value);
	}
}
