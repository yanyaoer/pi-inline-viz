import { rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import {
	DEFAULT_EXECUTION_POLICY,
	type ExecutionPolicy,
	type ResolvedArtifactRenderRequest,
} from "../artifact.ts";
import { configuredValue } from "../config.ts";
import { mixArtifactColors, type ArtifactPalette } from "../palette.ts";
import { resolveExecutable, runCommand } from "../process.ts";
import {
	type Asset,
	type ArtifactAdapter,
	type ArtifactNormalization,
	type ContentRenderContext,
	type RendererIdentity,
} from "../renderer/types.ts";

const POLICY_VERSION = 3;
const D2_PADDING = 24;
const D2_SHAPE_ALIASES = {
	note: {
		to: "document",
		reason: 'D2 represents note-like nodes with the "document" shape',
	},
	database: {
		to: "cylinder",
		reason: 'D2 represents database-like nodes with the "cylinder" shape',
	},
} as const;

type D2ShapeAlias = keyof typeof D2_SHAPE_ALIASES;
type D2Quote = '"';

export interface D2AdapterOptions {
	d2Command?: string;
}

export class D2ArtifactAdapter implements ArtifactAdapter {
	readonly sourceFilename = "source.d2";
	readonly #d2Command: string;
	#executable: Promise<string> | undefined;
	#identity: Promise<RendererIdentity> | undefined;

	constructor(options: D2AdapterOptions = {}) {
		this.#d2Command =
			options.d2Command ??
			configuredValue(["PI_INLINE_VIZ_D2_COMMAND", "AGENT_ARTIFACT_D2_COMMAND"]) ??
			"d2";
	}

	normalize(request: Readonly<ResolvedArtifactRenderRequest>): ArtifactNormalization {
		return normalizeD2Source(request.artifact.content);
	}

	validate(request: Readonly<ResolvedArtifactRenderRequest>): void {
		assertD2Artifact(request);
		validateD2Source(request.artifact.content, request.policy);
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
		const renderSourcePath = join(workingDirectory, "render.d2");
		await writeFile(
			renderSourcePath,
			withD2Palette(request.artifact.content, request.options.palette),
			{ mode: 0o600 },
		);
		try {
			const executable = await this.#getExecutable();
			await runCommand(
				executable,
				[
					`--theme=${d2ThemeId(request.options.theme, request.options.palette)}`,
					`--pad=${D2_PADDING}`,
					renderSourcePath,
					context.outputPath,
				],
				{
					cwd: workingDirectory,
					home: workingDirectory,
					timeoutMs: request.policy.timeoutMs,
				},
			);
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			if (/unknown shape /i.test(message)) {
				throw new Error(
					`${message}\nSuggestion: use a supported D2 shape; compatibility aliases are limited to note -> document and database -> cylinder.`,
					{ cause: error },
				);
			}
			throw error;
		} finally {
			await rm(renderSourcePath, { force: true });
		}
		return { format: "svg", mediaType: "image/svg+xml", path: context.outputPath };
	}

	async #readIdentity(): Promise<RendererIdentity> {
		const executable = await this.#getExecutable();
		const result = await runCommand(executable, ["--version"], {
			cwd: process.cwd(),
			home: process.cwd(),
			timeoutMs: 2_000,
		});
		return {
			id: "d2",
			version: `policy=${POLICY_VERSION};d2=${result.stdout.trim() || result.stderr.trim() || "unknown"}`,
		};
	}

	#getExecutable(): Promise<string> {
		this.#executable ??= resolveExecutable(this.#d2Command);
		return this.#executable;
	}
}

export function withD2Palette(content: string, palette: Readonly<ArtifactPalette>): string {
	const { background, foreground, accent, muted, border } = palette;
	const colors = {
		N1: foreground,
		N2: mixArtifactColors(muted, foreground, 0.35),
		N3: muted,
		N4: border,
		N5: mixArtifactColors(background, border, 0.34),
		N6: mixArtifactColors(background, border, 0.16),
		N7: background,
		B1: accent,
		B2: accent,
		B3: mixArtifactColors(background, accent, 0.5),
		B4: mixArtifactColors(background, accent, 0.34),
		B5: mixArtifactColors(background, accent, 0.2),
		B6: mixArtifactColors(background, accent, 0.1),
		AA2: border,
		AA4: mixArtifactColors(background, border, 0.25),
		AA5: mixArtifactColors(background, border, 0.12),
		AB4: mixArtifactColors(background, muted, 0.25),
		AB5: mixArtifactColors(background, muted, 0.12),
	};
	const overrides = Object.entries(colors).map(([name, color]) => `      ${name}: "${color}"`);
	return [
		content,
		"",
		"vars: {",
		"  d2-config: {",
		"    theme-overrides: {",
		...overrides,
		"    }",
		"  }",
		"}",
	].join("\n");
}

function d2ThemeId(theme: string, palette: Readonly<ArtifactPalette>): string {
	return theme === "0" && palette.mode === "dark" ? "200" : theme;
}

export function normalizeD2Source(content: string): ArtifactNormalization {
	const fixes: ArtifactNormalization["fixes"][number][] = [];
	const lines = content.match(/[^\r\n]*(?:\r\n|\r|\n|$)/g)?.filter(Boolean) ?? [];
	let blockString = false;
	let quote: D2Quote | undefined;
	let normalized = "";

	for (const line of lines) {
		if (blockString) {
			normalized += line;
			if (/^[\t ]*\|[\t ]*(?:\r\n|\r|\n)?$/u.test(line)) blockString = false;
			continue;
		}

		const scan = scanD2Line(line, quote);
		quote = scan.quote;
		normalized += normalizeD2Line(line, scan.protectedCharacters, fixes);
		if (quote === undefined && startsD2BlockString(line, scan.protectedCharacters)) {
			blockString = true;
		}
	}

	return { content: normalized, fixes };
}

function normalizeD2Line(
	line: string,
	protectedCharacters: Uint8Array,
	fixes: ArtifactNormalization["fixes"][number][],
): string {
	const replacements: { start: number; end: number; to: string }[] = [];
	const shapeProperty = /\bshape[\t ]*:[\t ]*(note|database)\b/g;
	for (const match of line.matchAll(shapeProperty)) {
		const alias = match[1] as D2ShapeAlias;
		const start = match.index;
		const valueStart = start + match[0].lastIndexOf(alias);
		const end = valueStart + alias.length;
		if (hasProtectedCharacter(protectedCharacters, start, end)) continue;

		let previous = start - 1;
		while (previous >= 0 && (line[previous] === " " || line[previous] === "\t")) previous -= 1;
		if (previous >= 0 && !".{;".includes(line[previous] ?? "")) continue;

		let next = end;
		while (line[next] === " " || line[next] === "\t") next += 1;
		if (next < line.length && !"#;}\r\n".includes(line[next] ?? "")) continue;

		const replacement = D2_SHAPE_ALIASES[alias];
		replacements.push({ start: valueStart, end, to: replacement.to });
		fixes.push({ from: alias, to: replacement.to, reason: replacement.reason });
	}

	if (replacements.length === 0) return line;
	let cursor = 0;
	let normalized = "";
	for (const replacement of replacements) {
		normalized += line.slice(cursor, replacement.start);
		normalized += replacement.to;
		cursor = replacement.end;
	}
	return normalized + line.slice(cursor);
}

function scanD2Line(
	line: string,
	initialQuote: D2Quote | undefined,
): { protectedCharacters: Uint8Array; quote: D2Quote | undefined } {
	const protectedCharacters = new Uint8Array(line.length);
	let quote = initialQuote;
	let escaped = false;
	for (let index = 0; index < line.length; index += 1) {
		const character = line[index] as string;
		if (quote !== undefined) {
			protectedCharacters[index] = 1;
			if (escaped) escaped = false;
			else if (character === "\\") escaped = true;
			else if (character === quote) quote = undefined;
			continue;
		}
		if (character === "'" || character === "`") {
			protectedCharacters.fill(1);
			break;
		}
		if (character === '"') {
			quote = character;
			protectedCharacters[index] = 1;
			continue;
		}
		if (character === "#") {
			protectedCharacters.fill(1, index);
			break;
		}
	}
	return { protectedCharacters, quote };
}

function hasProtectedCharacter(characters: Uint8Array, start: number, end: number): boolean {
	for (let index = start; index < end; index += 1) {
		if (characters[index] === 1) return true;
	}
	return false;
}

function startsD2BlockString(line: string, protectedCharacters: Uint8Array): boolean {
	let code = "";
	for (let index = 0; index < line.length; index += 1) {
		const character = line[index] as string;
		if (character === "\r" || character === "\n") break;
		code += protectedCharacters[index] === 1 ? " " : character;
	}
	return /:[\t ]*\|[a-zA-Z0-9_-]*[\t ]*$/u.test(code);
}

export function validateD2Source(
	content: string,
	policy: Readonly<ExecutionPolicy> = DEFAULT_EXECUTION_POLICY,
): void {
	if (!content.trim()) throw new Error("D2 block is empty");
	if (Buffer.byteLength(content) > policy.maxInputBytes) {
		throw new Error(`D2 block exceeds the ${policy.maxInputBytes}-byte limit`);
	}
	if (content.includes("\0")) throw new Error("D2 block contains a null byte");
	if (/(?:^|[:{;]\s*)(?:\.\.\.)?@/m.test(content)) {
		throw new Error("D2 imports are disabled for automatic rendering");
	}
	if (/(?:^|[.\s{])icon\s*:/m.test(content)) {
		throw new Error("D2 icons are disabled for automatic rendering");
	}
}

function assertD2Artifact(request: Readonly<ResolvedArtifactRenderRequest>): void {
	const { artifact } = request;
	if (artifact.type !== "diagram" || artifact.format !== "d2") {
		throw new Error(`D2 adapter cannot render ${artifact.type}/${artifact.format}`);
	}
	if (!/^(?:0|[1-9]\d*)$/u.test(request.options.theme)) {
		throw new Error("D2 theme must be a non-negative integer");
	}
}
