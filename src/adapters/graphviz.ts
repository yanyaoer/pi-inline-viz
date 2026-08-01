import { dirname } from "node:path";

import {
	DEFAULT_EXECUTION_POLICY,
	type ExecutionPolicy,
	type ResolvedArtifactRenderRequest,
} from "../artifact.ts";
import { configuredValue } from "../config.ts";
import { mixArtifactColors, type ArtifactPalette } from "../palette.ts";
import { resolveExecutable, runCommand } from "../process.ts";
import { validateGeneratedSvg } from "../renderer/svg-safety.ts";
import type {
	ArtifactAdapter,
	Asset,
	ContentRenderContext,
	RendererIdentity,
} from "../renderer/types.ts";

const POLICY_VERSION = 1;
const FORBIDDEN_RESOURCE_ATTRIBUTES = [
	"_background",
	"edgehref",
	"edgeurl",
	"face",
	"fontname",
	"fontpath",
	"headhref",
	"headurl",
	"href",
	"image",
	"imagepath",
	"labelhref",
	"labelurl",
	"shapefile",
	"src",
	"stylesheet",
	"tailhref",
	"tailurl",
	"url",
] as const;
const FORBIDDEN_RESOURCE_ATTRIBUTE = new Set<string>(FORBIDDEN_RESOURCE_ATTRIBUTES);

interface DotToken {
	value: string;
	quoted: boolean;
}

export interface GraphvizAdapterOptions {
	dotCommand?: string;
}

export class GraphvizArtifactAdapter implements ArtifactAdapter {
	readonly sourceFilename = "source.dot";
	readonly #dotCommand: string;
	#executable: Promise<string> | undefined;
	#identity: Promise<RendererIdentity> | undefined;

	constructor(options: GraphvizAdapterOptions = {}) {
		this.#dotCommand =
			options.dotCommand ?? configuredValue(["PI_INLINE_VIZ_GRAPHVIZ_COMMAND"]) ?? "dot";
	}

	validate(request: Readonly<ResolvedArtifactRenderRequest>): void {
		assertGraphvizArtifact(request);
		validateGraphvizSource(request.artifact.content, request.policy);
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
		const executable = await this.#getExecutable();
		await runCommand(
			executable,
			[
				"-Tsvg",
				...graphvizArgumentsForPalette(request.options.palette),
				"-o",
				context.outputPath,
				context.sourcePath,
			],
			{
				cwd: workingDirectory,
				home: workingDirectory,
				timeoutMs: request.policy.timeoutMs,
				maxBufferBytes: 1024 * 1024,
			},
		);
		await validateGeneratedSvg(context.outputPath, request.policy.maxOutputBytes, {
			producer: "Graphviz",
			stripLeadingMarkup: true,
		});
		return { format: "svg", mediaType: "image/svg+xml", path: context.outputPath };
	}

	async #readIdentity(): Promise<RendererIdentity> {
		const executable = await this.#getExecutable();
		const result = await runCommand(executable, ["-V"], {
			cwd: process.cwd(),
			home: process.cwd(),
			timeoutMs: DEFAULT_EXECUTION_POLICY.timeoutMs,
		});
		return {
			id: "graphviz-dot",
			version: `policy=${POLICY_VERSION};dot=${result.stdout.trim() || result.stderr.trim() || "unknown"}`,
		};
	}

	#getExecutable(): Promise<string> {
		this.#executable ??= resolveExecutable(this.#dotCommand);
		return this.#executable;
	}
}

export function graphvizArgumentsForPalette(palette: Readonly<ArtifactPalette>): string[] {
	const surface = mixArtifactColors(palette.background, palette.accent, 0.14);
	return [
		`-Gbgcolor=${palette.background}`,
		`-Gcolor=${palette.border}`,
		`-Gfontcolor=${palette.foreground}`,
		`-Ncolor=${palette.accent}`,
		`-Nfillcolor=${surface}`,
		`-Nfontcolor=${palette.foreground}`,
		"-Nstyle=filled",
		`-Ecolor=${palette.border}`,
		`-Efontcolor=${palette.foreground}`,
	];
}

export function validateGraphvizSource(
	content: string,
	policy: Readonly<ExecutionPolicy> = DEFAULT_EXECUTION_POLICY,
): void {
	if (!content.trim()) throw new Error("Graphviz DOT block is empty");
	if (Buffer.byteLength(content) > policy.maxInputBytes) {
		throw new Error(`Graphviz DOT block exceeds the ${policy.maxInputBytes}-byte limit`);
	}
	if (content.includes("\0")) throw new Error("Graphviz DOT block contains a null byte");
	if (/[\u0001-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(content)) {
		throw new Error("Graphviz DOT block contains a control character");
	}

	const tokens = tokenizeDot(content.replace(/^\uFEFF/u, ""));
	const root = tokens[0]?.value.toLowerCase() === "strict" ? 1 : 0;
	const rootType = tokens[root]?.value.toLowerCase();
	if (rootType !== "graph" && rootType !== "digraph") {
		throw new Error("Graphviz input must start with graph or digraph");
	}
	const resourceAttribute = assignedResourceAttribute(tokens);
	if (resourceAttribute) {
		throw new Error(
			`Graphviz ${resourceAttribute} attributes are disabled for automatic rendering`,
		);
	}
}

function assertGraphvizArtifact(request: Readonly<ResolvedArtifactRenderRequest>): void {
	const { artifact } = request;
	if (artifact.type !== "diagram" || artifact.format !== "dot") {
		throw new Error(`Graphviz adapter cannot render ${artifact.type}/${artifact.format}`);
	}
}

function tokenizeDot(content: string): DotToken[] {
	const tokens: DotToken[] = [];
	let lineHasCode = false;
	for (let index = 0; index < content.length;) {
		const character = content[index] as string;
		const next = content[index + 1];
		if (/\s/u.test(character)) {
			if (character === "\n" || character === "\r") lineHasCode = false;
			index += 1;
			continue;
		}
		if (!lineHasCode && character === "#") {
			index = skipDotLine(content, index + 1);
			continue;
		}
		if (character === "/" && next === "/") {
			index = skipDotLine(content, index + 2);
			continue;
		}
		if (character === "/" && next === "*") {
			index += 2;
			while (index < content.length) {
				if (content[index] === "*" && content[index + 1] === "/") {
					index += 2;
					break;
				}
				if (content[index] === "\n" || content[index] === "\r") lineHasCode = false;
				index += 1;
			}
			continue;
		}
		if (character === '"') {
			const quoted = readDotQuotedToken(content, index + 1);
			tokens.push({ value: quoted.value, quoted: true });
			index = quoted.nextIndex;
			lineHasCode = true;
			continue;
		}
		if (/[A-Za-z_\u0080-\uFFFF]/u.test(character)) {
			let end = index + 1;
			while (end < content.length && /[A-Za-z0-9_\u0080-\uFFFF]/u.test(content[end] as string)) {
				end += 1;
			}
			tokens.push({ value: content.slice(index, end), quoted: false });
			index = end;
			lineHasCode = true;
			continue;
		}
		tokens.push({ value: character, quoted: false });
		index += 1;
		lineHasCode = true;
	}
	return tokens;
}

function skipDotLine(content: string, start: number): number {
	let index = start;
	while (index < content.length && content[index] !== "\n" && content[index] !== "\r") {
		index += 1;
	}
	return index;
}

function readDotQuotedToken(content: string, start: number): { value: string; nextIndex: number } {
	let value = "";
	let index = start;
	while (index < content.length) {
		const character = content[index] as string;
		if (character === '"') return { value, nextIndex: index + 1 };
		if (character === "\\" && index + 1 < content.length) {
			const escaped = content[index + 1] as string;
			index += escaped === "\r" && content[index + 2] === "\n" ? 3 : 2;
			if (escaped !== "\n" && escaped !== "\r") value += escaped;
			continue;
		}
		value += character;
		index += 1;
	}
	return { value, nextIndex: index };
}

function assignedResourceAttribute(tokens: readonly DotToken[]): string | undefined {
	for (let index = 0; index < tokens.length; index += 1) {
		const token = tokens[index] as DotToken;
		let value = token.value;
		let next = index + 1;
		if (token.quoted) {
			while (tokens[next]?.value === "+" && tokens[next + 1]?.quoted) {
				value += (tokens[next + 1] as DotToken).value;
				next += 2;
			}
		}
		const normalized = value.toLowerCase();
		if (FORBIDDEN_RESOURCE_ATTRIBUTE.has(normalized) && tokens[next]?.value === "=") {
			return normalized;
		}
	}
	return undefined;
}
