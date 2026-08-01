import { dirname } from "node:path";

import {
	DEFAULT_EXECUTION_POLICY,
	type ExecutionPolicy,
	type ResolvedArtifactRenderRequest,
} from "../artifact.ts";
import { runCommand } from "../process.ts";
import {
	type Asset,
	type ArtifactAdapter,
	type ContentRenderContext,
	type RendererIdentity,
} from "../renderer/types.ts";

export class D2ArtifactAdapter implements ArtifactAdapter {
	readonly sourceFilename = "source.d2";
	#identity: Promise<RendererIdentity> | undefined;

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
		await runCommand(
			"d2",
			[`--theme=${request.options.theme}`, context.sourcePath, context.outputPath],
			{
				cwd: workingDirectory,
				home: workingDirectory,
				timeoutMs: request.policy.timeoutMs,
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
