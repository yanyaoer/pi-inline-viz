import { readFile, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import {
	DEFAULT_EXECUTION_POLICY,
	type ExecutionPolicy,
	type ResolvedArtifactRenderRequest,
} from "../artifact.ts";
import { configuredValue } from "../config.ts";
import { resolveExecutable, runCommand } from "../process.ts";
import {
	type ArtifactAdapter,
	type Asset,
	type ContentRenderContext,
	type RendererIdentity,
} from "../renderer/types.ts";

const POLICY_VERSION = 1;
const MERMAID_CONFIG = Object.freeze({
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
	readonly #chromeCandidates: readonly string[];
	#mmdcExecutable: Promise<string> | undefined;
	#chromeExecutable: Promise<string> | undefined;
	#identity: Promise<RendererIdentity> | undefined;

	constructor(options: MermaidAdapterOptions = {}) {
		this.#mmdcCommand =
			options.mmdcCommand ??
			configuredValue(["PI_INLINE_VIZ_MMDC_COMMAND", "AGENT_ARTIFACT_MERMAID_COMMAND"]) ??
			"mmdc";
		this.#chromeCandidates = chromeCandidates(options.chromePath);
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
		const puppeteerConfig = {
			executablePath: chromeExecutable,
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

		await Promise.all([
			writeFile(mermaidConfigPath, `${JSON.stringify(MERMAID_CONFIG)}\n`, { mode: 0o600 }),
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
					timeoutMs: request.policy.timeoutMs,
					maxBufferBytes: 1024 * 1024,
				},
			);
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
		const [mmdc, chrome] = await Promise.all([
			runCommand(mmdcExecutable, ["--version"], {
				cwd: process.cwd(),
				home: process.cwd(),
				timeoutMs: DEFAULT_EXECUTION_POLICY.timeoutMs,
			}),
			runCommand(chromeExecutable, ["--version"], {
				cwd: process.cwd(),
				home: process.cwd(),
				timeoutMs: DEFAULT_EXECUTION_POLICY.timeoutMs,
			}),
		]);
		return {
			id: "mermaid-cli",
			version: [
				`policy=${POLICY_VERSION}`,
				`mmdc=${commandVersion(mmdc)}`,
				`chrome=${commandVersion(chrome)}`,
			].join(";"),
		};
	}

	#getMmdcExecutable(): Promise<string> {
		this.#mmdcExecutable ??= resolveExecutable(this.#mmdcCommand);
		return this.#mmdcExecutable;
	}

	#getChromeExecutable(): Promise<string> {
		this.#chromeExecutable ??= firstExecutable(this.#chromeCandidates);
		return this.#chromeExecutable;
	}
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

export async function validateMermaidSvg(path: string, maximumBytes: number): Promise<void> {
	const file = await stat(path);
	if (!file.isFile() || file.size === 0) throw new Error("Mermaid produced no SVG output");
	if (file.size > maximumBytes) {
		throw new Error(`Mermaid SVG exceeds the ${maximumBytes}-byte limit`);
	}
	const svg = (await readFile(path, "utf8")).trim();
	if (!svg.startsWith("<svg") || !svg.endsWith("</svg>") || svg.indexOf("<svg", 1) !== -1) {
		throw new Error("Mermaid produced invalid SVG output");
	}
	if (/<!DOCTYPE|<!ENTITY|<\?(?:xml-stylesheet|xml-model)\b/iu.test(svg)) {
		throw new Error("Mermaid SVG contains an external document declaration");
	}
	if (/<\s*(?:embed|foreignObject|iframe|image|object|script)\b/iu.test(svg)) {
		throw new Error("Mermaid SVG contains an unsafe element");
	}
	if (/\son[a-z][\w:.-]*\s*=/iu.test(svg)) {
		throw new Error("Mermaid SVG contains an event handler");
	}
	if (/\b(?:href|xlink:href|src)\s*=\s*(["'])(?!#)[\s\S]*?\1/iu.test(svg)) {
		throw new Error("Mermaid SVG contains an external reference");
	}
	if (/@import\b|url\(\s*(?!#|["']#)/iu.test(svg)) {
		throw new Error("Mermaid SVG contains an external stylesheet reference");
	}
}

function chromeCandidates(configured: string | undefined): readonly string[] {
	const explicit =
		configured ??
		configuredValue([
			"PI_INLINE_VIZ_CHROME_PATH",
			"AGENT_ARTIFACT_CHROME_PATH",
			"PUPPETEER_EXECUTABLE_PATH",
		]);
	if (explicit) return [explicit];
	if (process.platform === "darwin") {
		return [
			"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
			"/Applications/Chromium.app/Contents/MacOS/Chromium",
			"google-chrome",
			"chromium",
		];
	}
	if (process.platform === "win32") {
		return [
			join(process.env.PROGRAMFILES ?? "C:\\Program Files", "Google", "Chrome", "Application", "chrome.exe"),
			join(
				process.env["PROGRAMFILES(X86)"] ?? "C:\\Program Files (x86)",
				"Google",
				"Chrome",
				"Application",
				"chrome.exe",
			),
			"chrome.exe",
		];
	}
	return ["google-chrome-stable", "google-chrome", "chromium", "chromium-browser"];
}

async function firstExecutable(candidates: readonly string[]): Promise<string> {
	for (const candidate of candidates) {
		try {
			return await resolveExecutable(candidate);
		} catch {
			// Try the next known Chrome command.
		}
	}
	throw new Error(
		"Mermaid rendering requires Chrome or Chromium; set PI_INLINE_VIZ_CHROME_PATH to its executable",
	);
}

function commandVersion(result: { stdout: string; stderr: string }): string {
	return result.stdout.trim() || result.stderr.trim() || "unknown";
}
