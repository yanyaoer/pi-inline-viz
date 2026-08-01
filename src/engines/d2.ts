import { dirname } from "node:path";

import { runCommand } from "../process.ts";
import {
	DEFAULT_RESOURCE_BUDGET,
	type Asset,
	type ArtifactAdapter,
	type ContentRenderContext,
	type RendererIdentity,
	type ResourceBudget,
} from "../renderer/types.ts";
import type { D2Block } from "../parser/d2.ts";

export class D2ArtifactAdapter implements ArtifactAdapter<D2Block> {
	readonly sourceFilename = "source.d2";
	#identity: Promise<RendererIdentity> | undefined;

	validate(block: D2Block, budget: Readonly<ResourceBudget>): void {
		validateD2Source(block.content, budget);
	}

	getIdentity(): Promise<RendererIdentity> {
		this.#identity ??= this.#readIdentity();
		return this.#identity;
	}

	async render(block: D2Block, context: ContentRenderContext): Promise<Asset> {
		this.validate(block, context.budget);
		const workingDirectory = dirname(context.sourcePath);
		await runCommand(
			"d2",
			[`--theme=${context.profile.theme}`, context.sourcePath, context.outputPath],
			{
				cwd: workingDirectory,
				home: workingDirectory,
				timeoutMs: context.budget.timeoutMs,
			},
		);
		return { format: "svg", mediaType: "image/svg+xml", path: context.outputPath };
	}

	async #readIdentity(): Promise<RendererIdentity> {
		const result = await runCommand("d2", ["--version"], {
			cwd: process.cwd(),
			home: process.cwd(),
			timeoutMs: 2_000,
		});
		return {
			id: "d2",
			version: result.stdout.trim() || result.stderr.trim() || "unknown",
		};
	}
}

export function validateD2Source(
	content: string,
	budget: Readonly<ResourceBudget> = DEFAULT_RESOURCE_BUDGET,
): void {
	if (!content.trim()) throw new Error("D2 block is empty");
	if (Buffer.byteLength(content) > budget.maxInputBytes) {
		throw new Error(`D2 block exceeds the ${budget.maxInputBytes}-byte limit`);
	}
	if (content.includes("\0")) throw new Error("D2 block contains a null byte");
	if (/(?:^|[:{;]\s*)(?:\.\.\.)?@/m.test(content)) {
		throw new Error("D2 imports are disabled for automatic rendering");
	}
	if (/(?:^|[.\s{])icon\s*:/m.test(content)) {
		throw new Error("D2 icons are disabled for automatic rendering");
	}
}
