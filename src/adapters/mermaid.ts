import { readFile, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

import {
	DEFAULT_EXECUTION_POLICY,
	type ExecutionPolicy,
	type ResolvedArtifactRenderRequest,
} from "../artifact.ts";
import { configuredValue } from "../config.ts";
import { mixArtifactColors, type ArtifactPalette } from "../palette.ts";
import { resolveExecutable, runCommand } from "../process.ts";
import { validateGeneratedSvg } from "../renderer/svg-safety.ts";
import {
	type ArtifactAdapter,
	type Asset,
	type ContentRenderContext,
	type RendererIdentity,
} from "../renderer/types.ts";

// v3: merge mermaid per-word tspans before rasterization (librsvg drops
// leading whitespace inside tspan text, deleting spaces between words).
const POLICY_VERSION = 3;
const BASE_MERMAID_CONFIG = Object.freeze({
	securityLevel: "strict",
	htmlLabels: false,
	deterministicIds: true,
	deterministicIDSeed: "pi-inline-viz",
	maxEdges: 500,
	flowchart: { htmlLabels: false },
});

export interface MermaidAdapterOptions {
	mmdcCommand?: string;
	chromePath?: string;
}

export class MermaidArtifactAdapter implements ArtifactAdapter {
	readonly sourceFilename = "source.mmd";
	readonly #mmdcCommand: string;
	readonly #chromeCommand: string | undefined;
	#mmdcExecutable: Promise<string> | undefined;
	#chromeExecutable: Promise<string> | undefined;
	#identity: Promise<RendererIdentity> | undefined;

	constructor(options: MermaidAdapterOptions = {}) {
		this.#mmdcCommand =
			options.mmdcCommand ??
			configuredValue(["PI_INLINE_VIZ_MMDC_COMMAND", "AGENT_ARTIFACT_MERMAID_COMMAND"]) ??
			"mmdc";
		this.#chromeCommand =
			options.chromePath ??
			configuredValue([
				"PI_INLINE_VIZ_CHROME_PATH",
				"AGENT_ARTIFACT_CHROME_PATH",
				"PUPPETEER_EXECUTABLE_PATH",
			]);
	}

	validate(request: Readonly<ResolvedArtifactRenderRequest>): void {
		assertMermaidArtifact(request);
		validateMermaidSource(request.artifact.content, request.policy);
	}

	getIdentity(): Promise<RendererIdentity> {
		this.#identity ??= this.#readIdentity();
		return this.#identity;
	}

	async render(
		request: Readonly<ResolvedArtifactRenderRequest>,
		context: ContentRenderContext,
	): Promise<Asset> {
		this.validate(request);
		const workingDirectory = dirname(context.sourcePath);
		const mermaidConfigPath = join(workingDirectory, ".mermaid-config.json");
		const puppeteerConfigPath = join(workingDirectory, ".puppeteer-config.json");
		const [mmdcExecutable, chromeExecutable] = await Promise.all([
			this.#getMmdcExecutable(),
			this.#getChromeExecutable(),
		]);
		const puppeteerConfig: {
			executablePath?: string;
			headless: true;
			args: string[];
		} = {
			headless: true,
			args: [
				"--disable-background-networking",
				"--disable-component-update",
				"--disable-default-apps",
				"--disable-sync",
				"--no-default-browser-check",
				"--no-first-run",
				"--proxy-server=http://127.0.0.1:9",
				"--proxy-bypass-list=<-loopback>",
			],
		};
		if (chromeExecutable) puppeteerConfig.executablePath = chromeExecutable;
		const mermaidConfig = mermaidConfigForPalette(request.options.palette);

		await Promise.all([
			writeFile(mermaidConfigPath, `${JSON.stringify(mermaidConfig)}\n`, { mode: 0o600 }),
			writeFile(puppeteerConfigPath, `${JSON.stringify(puppeteerConfig)}\n`, { mode: 0o600 }),
		]);
		try {
			await runCommand(
				mmdcExecutable,
				[
					"--input",
					context.sourcePath,
					"--output",
					context.outputPath,
					"--outputFormat",
					"svg",
					"--backgroundColor",
					"transparent",
					"--configFile",
					mermaidConfigPath,
					"--puppeteerConfigFile",
					puppeteerConfigPath,
					"--svgId",
					"pi-inline-viz",
					"--quiet",
				],
				{
					cwd: workingDirectory,
					home: workingDirectory,
					environment: { PUPPETEER_CACHE_DIR: puppeteerCacheDirectory() },
					timeoutMs: request.policy.timeoutMs,
					maxBufferBytes: 1024 * 1024,
				},
			);
			// librsvg drops leading whitespace at the start of tspan text, and
			// mermaid emits every label word as its own text-inner-tspan with the
			// inter-word space as leading whitespace in the following tspan. That
			// combination makes rasterized labels lose all spaces between words,
			// so merge consecutive inner tspans into one before validation.
			await normalizeMermaidSvgTspans(context.outputPath);
			await validateMermaidSvg(context.outputPath, request.policy.maxOutputBytes);
			return { format: "svg", mediaType: "image/svg+xml", path: context.outputPath };
		} finally {
			await Promise.all([
				rm(mermaidConfigPath, { force: true }),
				rm(puppeteerConfigPath, { force: true }),
			]);
		}
	}

	async #readIdentity(): Promise<RendererIdentity> {
		const [mmdcExecutable, chromeExecutable] = await Promise.all([
			this.#getMmdcExecutable(),
			this.#getChromeExecutable(),
		]);
		const mmdc = await runCommand(mmdcExecutable, ["--version"], {
			cwd: process.cwd(),
			home: process.cwd(),
			timeoutMs: DEFAULT_EXECUTION_POLICY.timeoutMs,
		});
		const browser = chromeExecutable
			? commandVersion(
					await runCommand(chromeExecutable, ["--version"], {
						cwd: process.cwd(),
						home: process.cwd(),
						timeoutMs: DEFAULT_EXECUTION_POLICY.timeoutMs,
					}),
				)
			: "puppeteer-managed";
		return {
			id: "mermaid-cli",
			version: [
				`policy=${POLICY_VERSION}`,
				`mmdc=${commandVersion(mmdc)}`,
				`browser=${browser}`,
			].join(";"),
		};
	}

	#getMmdcExecutable(): Promise<string> {
		this.#mmdcExecutable ??= resolveExecutable(this.#mmdcCommand);
		return this.#mmdcExecutable;
	}

	#getChromeExecutable(): Promise<string | undefined> {
		if (!this.#chromeCommand) return Promise.resolve(undefined);
		this.#chromeExecutable ??= resolveExecutable(this.#chromeCommand);
		return this.#chromeExecutable;
	}
}

export function mermaidConfigForPalette(palette: Readonly<ArtifactPalette>): Record<string, unknown> {
	const surface = mixArtifactColors(palette.background, palette.accent, 0.16);
	const secondarySurface = mixArtifactColors(palette.background, palette.border, 0.14);
	const tertiarySurface = mixArtifactColors(palette.background, palette.muted, 0.12);
	return {
		...BASE_MERMAID_CONFIG,
		theme: "base",
		themeVariables: {
			darkMode: palette.mode === "dark",
			background: palette.background,
			primaryColor: surface,
			primaryTextColor: palette.foreground,
			primaryBorderColor: palette.accent,
			secondaryColor: secondarySurface,
			secondaryTextColor: palette.foreground,
			secondaryBorderColor: palette.border,
			tertiaryColor: tertiarySurface,
			tertiaryTextColor: palette.foreground,
			tertiaryBorderColor: palette.muted,
			lineColor: palette.border,
			textColor: palette.foreground,
			mainBkg: surface,
			nodeBorder: palette.accent,
			clusterBkg: secondarySurface,
			clusterBorder: palette.border,
			edgeLabelBackground: palette.background,
			titleColor: palette.foreground,
			labelTextColor: palette.foreground,
			noteBkgColor: tertiarySurface,
			noteTextColor: palette.foreground,
			noteBorderColor: palette.border,
		},
	};
}

export function validateMermaidSource(
	content: string,
	policy: Readonly<ExecutionPolicy> = DEFAULT_EXECUTION_POLICY,
): void {
	if (!content.trim()) throw new Error("Mermaid block is empty");
	if (Buffer.byteLength(content) > policy.maxInputBytes) {
		throw new Error(`Mermaid block exceeds the ${policy.maxInputBytes}-byte limit`);
	}
	if (content.includes("\0")) throw new Error("Mermaid block contains a null byte");
	if (/^\s*---[\t ]*(?:\r?\n|$)/u.test(content)) {
		throw new Error("Mermaid frontmatter is disabled for automatic rendering");
	}
	if (/%%\s*\{/u.test(content)) {
		throw new Error("Mermaid configuration directives are disabled for automatic rendering");
	}
	if (/^\s*click\b/imu.test(content)) {
		throw new Error("Mermaid click directives are disabled for automatic rendering");
	}
	if (/(?:https?|file|data|javascript):|\/\/[^\s]/iu.test(content)) {
		throw new Error("Mermaid external URLs are disabled for automatic rendering");
	}
	if (/@import\b|url\s*\(/iu.test(content)) {
		throw new Error("Mermaid external styles are disabled for automatic rendering");
	}
	if (/<\s*(?:embed|iframe|img|link|object|script|style)\b/iu.test(content)) {
		throw new Error("Mermaid embedded HTML resources are disabled for automatic rendering");
	}
	if (/@\{[^}\n]*\b(?:icon|img)\s*:/iu.test(content)) {
		throw new Error("Mermaid image and icon shapes are disabled for automatic rendering");
	}
	if (/[\u0001-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(content)) {
		throw new Error("Mermaid block contains a control character");
	}
}

function assertMermaidArtifact(request: Readonly<ResolvedArtifactRenderRequest>): void {
	const { artifact } = request;
	if (artifact.type !== "diagram" || artifact.format !== "mermaid") {
		throw new Error(`Mermaid adapter cannot render ${artifact.type}/${artifact.format}`);
	}
}

const INNER_TSPAN_SOURCE_RE =
	/<tspan\b[^>]*\bclass="[^"]*\btext-inner-tspan\b[^"]*"[^>]*>[\s\S]*?<\/tspan>/gu;
const POSITIONED_ATTR_RE = /(?:^|\s)(?:x|y|dx|dy)\s*=/u;

/**
 * Merge runs of consecutive mermaid word tspans into a single tspan.
 *
 * Mermaid renders every word of a label (with `htmlLabels: false`) as its own
 * `<tspan class="text-inner-tspan">`, putting the inter-word space at the start
 * of the following tspan's text. librsvg trims leading whitespace inside tspan
 * text, so rasterizing the SVG as-is silently deletes every space between
 * words ("natural language request" renders as "naturallanguagerequest").
 *
 * Consecutive word tspans under the same parent (separated only by whitespace)
 * are merged into one tspan that keeps a single space between words, which
 * librsvg renders correctly. Runs whose first tspan carries explicit x/y/dx/dy
 * positioning are left untouched.
 */
export function mergeWordTspans(svg: string): string {
	const matches: { start: number; end: number; tag: string; text: string }[] = [];
	for (const match of svg.matchAll(INNER_TSPAN_SOURCE_RE)) {
		const raw = match[0];
		const tagEnd = raw.indexOf(">") + 1;
		matches.push({
			start: match.index ?? 0,
			end: (match.index ?? 0) + raw.length,
			tag: raw.slice(0, tagEnd),
			text: raw.slice(tagEnd, raw.length - "</tspan>".length),
		});
	}
	if (matches.length === 0) return svg;

	const out: string[] = [];
	let cursor = 0;
	let run: typeof matches = [];

	const flush = () => {
		if (run.length === 0) return;
		const first = run[0];
		if (first === undefined) return;
		if (run.length === 1 || POSITIONED_ATTR_RE.test(first.tag)) {
			for (const match of run) out.push(svg.slice(match.start, match.end));
		} else {
			const mergedText = run
				.map((match) => match.text.trim())
				.filter((text) => text.length > 0)
				.join(" ");
			out.push(first.tag, mergedText, "</tspan>");
		}
		run = [];
	};

	for (const match of matches) {
		const gap = svg.slice(cursor, match.start);
		if (run.length === 0) {
			out.push(gap);
		} else if (/[^\s]/.test(gap)) {
			// Non-whitespace between word tspans means they are not siblings
			// (for example a new row); flush the current run first.
			flush();
			out.push(gap);
		}
		run.push(match);
		cursor = match.end;
	}
	flush();
	out.push(svg.slice(cursor));
	return out.join("");
}

async function normalizeMermaidSvgTspans(path: string): Promise<void> {
	const svg = await readFile(path, "utf8");
	const normalized = mergeWordTspans(svg);
	if (normalized !== svg) {
		await writeFile(path, normalized, { mode: 0o600 });
	}
}

export async function validateMermaidSvg(path: string, maximumBytes: number): Promise<void> {
	await validateGeneratedSvg(path, maximumBytes, { producer: "Mermaid" });
}

function puppeteerCacheDirectory(): string {
	return configuredValue(["PUPPETEER_CACHE_DIR"]) ?? join(homedir(), ".cache", "puppeteer");
}

function commandVersion(result: { stdout: string; stderr: string }): string {
	return result.stdout.trim() || result.stderr.trim() || "unknown";
}
