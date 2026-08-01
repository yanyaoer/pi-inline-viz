import { createHash } from "node:crypto";
import { constants, existsSync } from "node:fs";
import { access, readFile, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";

import type { LatexBlock } from "../parser/latex.ts";
import { runCommand } from "../process.ts";
import {
	DEFAULT_RESOURCE_BUDGET,
	type Asset,
	type ContentRenderer,
	type ContentRenderContext,
	type RendererIdentity,
	type ResourceBudget,
} from "../renderer/types.ts";

const POLICY_VERSION = 1;
const ALLOWED_CONTROL_WORDS = new Set(
	`acute aleph alpha angle approx arccos arcsin arctan arg ast asymp bar beta big Big bigg Bigg
	bigcap bigcup bigodot bigoplus bigotimes bigsqcup bigtriangledown bigtriangleup biguplus bigvee bigwedge binom
	bmod bot bowtie breve bullet cap cdot cdots check chi circ clubsuit coloneqq cong coprod cos cosh cot coth csc cup
	dagger dashv ddagger ddot ddots deg delta Delta det diamond diamondsuit dim displaystyle div doteq dot dfrac ell
	emptyset epsilon equiv eta exists exp flat forall frac Gamma gamma gcd geq gg glb heartsuit hom hookleftarrow
	hookrightarrow iff Im imath implies in inf infty int iint iiint jmath kappa ker lambda Lambda land langle lbrace
	lceil ldotp ldots left leftarrow Leftarrow leftharpoondown leftharpoonup leftrightarrow Leftrightarrow leq lg lim
	liminf limsup ll lfloor ln log lor lVert lvert mapsto mathbb mathbf mathcal mathfrak mathit mathrm mathsf mathsterling
	mathtt max mho min models mp mu nabla natural nearrow neg neq ni nolimits not nu odot oint omega Omega ominus
	oplus operatorname oslash otimes overbrace overleftarrow overline overrightarrow overset parallel partial perp phi
	Phi pi Pi pm pmod Pr prec preceq prod propto psi Psi quad qquad rangle rbrace rceil Re right rightarrow Rightarrow
	rightharpoondown rightharpoonup rightrightarrows rfloor rho rmoustache root rVert rvert searrow sec setminus sharp
	sigma Sigma sim simeq sin sinh smallsetminus spadesuit sqcap sqcup sqrt sqsubset sqsubseteq sqsupset sqsupseteq
	star subset subseteq succ succeq sum sup supset supseteq tan tanh tau text textstyle theta Theta tilde times to top
	triangle triangleleft triangleright uparrow Uparrow updownarrow Updownarrow underbrace underline underset
	upharpoonleft upharpoonright upsilon Upsilon varepsilon varphi varpi varrho varsigma vartheta vdash vdots vec vee
	Vert vert vphantom vVert vvert wedge widehat widetilde wp xi Xi zeta`.split(/\s+/),
);
const ALLOWED_CONTROL_SYMBOLS = new Set(["{", "}", "_", "^", "%", "#", "&", "$", ",", ";", ":", "!", " ", "|", "/"]);
const FORBIDDEN_RAW_CHARACTERS = new Set(["%", "#", "&", "$", "~"]);

export interface LatexRendererOptions {
	ratexSvgCommand?: string;
}

export class LatexContentRenderer implements ContentRenderer<LatexBlock> {
	readonly sourceFilename = "source.tex";
	readonly #ratexSvgCommand: string;
	#executable: Promise<string> | undefined;
	#identity: Promise<RendererIdentity> | undefined;

	constructor(options: LatexRendererOptions = {}) {
		this.#ratexSvgCommand =
			options.ratexSvgCommand ?? process.env.PI_RICH_MEDIA_RATEX_SVG_COMMAND ?? defaultRatexSvgCommand();
	}

	validate(block: LatexBlock, budget: Readonly<ResourceBudget>): void {
		validateLatexSource(block.content, budget);
	}

	getIdentity(): Promise<RendererIdentity> {
		this.#identity ??= this.#readIdentity();
		return this.#identity;
	}

	async render(block: LatexBlock, context: ContentRenderContext): Promise<Asset> {
		this.validate(block, context.budget);
		const workingDirectory = dirname(context.sourcePath);
		const inputPath = join(workingDirectory, "render.tex");
		await writeFile(inputPath, `${normalizeFormula(block.content)}\n`, { mode: 0o600 });

		try {
			const executable = await this.#getExecutable();
			const args = [
				"--input",
				inputPath,
				"--stdout",
				"--dpr",
				"1",
				"--font-size",
				"40",
				"--color",
				"black",
				"--office-compatible-colors",
			];
			if (block.displayMode === "inline") args.push("--inline");
			const result = await runCommand(executable, args, {
				cwd: workingDirectory,
				home: workingDirectory,
				timeoutMs: context.budget.timeoutMs,
				maxBufferBytes: context.budget.maxOutputBytes,
			});
			await writeFile(context.outputPath, checkedSvg(result.stdout), { mode: 0o600 });
			return { format: "svg", mediaType: "image/svg+xml", path: context.outputPath };
		} finally {
			await rm(inputPath, { force: true });
		}
	}

	async #readIdentity(): Promise<RendererIdentity> {
		const executable = await this.#getExecutable();
		const help = await runCommand(executable, ["--help"], {
			cwd: process.cwd(),
			home: process.cwd(),
			timeoutMs: DEFAULT_RESOURCE_BUDGET.timeoutMs,
		});
		if (!/built with embedded fonts/i.test(help.stdout)) {
			throw new Error("render-svg must be built with the ratex-svg embed-fonts feature");
		}
		const binaryHash = createHash("sha256").update(await readFile(executable)).digest("hex");
		return {
			id: "ratex-svg",
			version: `policy=${POLICY_VERSION};binary_sha256=${binaryHash}`,
		};
	}

	#getExecutable(): Promise<string> {
		this.#executable ??= resolveExecutable(this.#ratexSvgCommand);
		return this.#executable;
	}
}

function defaultRatexSvgCommand(): string {
	const cacheRoot = process.env.PI_RICH_MEDIA_CACHE_DIR ?? join(homedir(), ".cache", "pi-rich-media");
	const managed = join(cacheRoot, "bin", process.platform === "win32" ? "render-svg.exe" : "render-svg");
	return existsSync(managed) ? managed : "render-svg";
}

export function validateLatexSource(
	content: string,
	budget: Readonly<ResourceBudget> = DEFAULT_RESOURCE_BUDGET,
): void {
	if (!content.trim()) throw new Error("LaTeX formula is empty");
	if (Buffer.byteLength(content) > budget.maxInputBytes) {
		throw new Error(`LaTeX formula exceeds the ${budget.maxInputBytes}-byte limit`);
	}
	if (content.includes("\0")) throw new Error("LaTeX formula contains a null byte");
	if (content.includes("^^")) throw new Error("LaTeX superscript escape notation is disabled");

	let braceDepth = 0;
	for (let index = 0; index < content.length; index += 1) {
		const character = content[index] ?? "";
		if (character === "\\") {
			const next = content[index + 1];
			if (next === undefined) throw new Error("LaTeX formula ends with an incomplete command");
			if (/[A-Za-z]/.test(next)) {
				let end = index + 2;
				while (/[A-Za-z]/.test(content[end] ?? "")) end += 1;
				const command = content.slice(index + 1, end);
				if (!ALLOWED_CONTROL_WORDS.has(command)) {
					throw new Error(`LaTeX command \\${command} is disabled`);
				}
				index = end - 1;
				continue;
			}
			if (!ALLOWED_CONTROL_SYMBOLS.has(next)) {
				throw new Error(`LaTeX command \\${next} is disabled`);
			}
			index += 1;
			continue;
		}
		if (character === "{") {
			braceDepth += 1;
			continue;
		}
		if (character === "}") {
			braceDepth -= 1;
			if (braceDepth < 0) throw new Error("LaTeX formula has unbalanced braces");
			continue;
		}
		if (FORBIDDEN_RAW_CHARACTERS.has(character)) {
			throw new Error(`unescaped LaTeX character ${character} is disabled`);
		}
		if (character < " " && character !== "\n" && character !== "\t") {
			throw new Error("LaTeX formula contains a control character");
		}
	}
	if (braceDepth !== 0) throw new Error("LaTeX formula has unbalanced braces");
}

function normalizeFormula(content: string): string {
	return content.replace(/\s+/gu, " ").trim();
}

function checkedSvg(output: string): string {
	const svg = output.trim();
	if (!svg.startsWith("<svg") || !svg.endsWith("</svg>") || svg.indexOf("<svg", 1) !== -1) {
		throw new Error("ratex-svg produced invalid SVG output");
	}
	return `${svg}\n`;
}

async function resolveExecutable(command: string): Promise<string> {
	const candidates = command.includes("/") || command.includes("\\")
		? [resolve(command)]
		: (process.env.PATH ?? "")
				.split(delimiter)
				.map((directory) => resolve(directory || process.cwd(), command));
	for (const candidate of candidates) {
		try {
			await access(candidate, constants.X_OK);
			return candidate;
		} catch {
			// Try the next PATH entry.
		}
	}
	throw new Error(`${command} is not executable or is not on PATH`);
}
