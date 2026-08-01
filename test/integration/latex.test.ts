import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { appendFile, mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { ARTIFACT_VERSION } from "../../src/artifact.ts";
import { LatexArtifactAdapter } from "../../src/engines/latex.ts";
import type { LatexBlock } from "../../src/parser/latex.ts";
import { RichMediaPipeline } from "../../src/pipeline.ts";
import { SvgAssetRenderer } from "../../src/renderer/svg.ts";
import { createFakeRatexSvg, readFakeRatexInvocation } from "../helpers/fake-ratex-svg.ts";

test("renders LaTeX through the self-contained RaTeX SVG contract and reuses both caches", async () => {
	const root = await mkdtemp(join(tmpdir(), "pi-rich-latex-integration-"));
	try {
		const ratex = await createFakeRatexSvg(root);
		const pipeline = new RichMediaPipeline(
			new LatexArtifactAdapter({ ratexSvgCommand: ratex.command }),
			new SvgAssetRenderer(),
		);
		const cacheDirectory = join(root, "cache");
		const block = latexBlock("E=mc^2");
		const request = { artifact: block, options: { background: "white" as const } };
		const first = await pipeline.render(request, { cacheDirectory });
		const second = await pipeline.render(request, { cacheDirectory });

		assert.deepEqual(first.cacheHit, { content: false, asset: false });
		assert.deepEqual(second.cacheHit, { content: true, asset: true });
		assert.equal(second.contentKey, first.contentKey);
		assert.equal(second.key, first.key);
		assert.equal(await readFile(first.sourcePath, "utf8"), "E=mc^2");
		assert.match(await readFile(first.intermediate.path, "utf8"), /<svg/);
		assert.deepEqual((await readFile(first.asset.path)).subarray(0, 8), Buffer.from("89504e470d0a1a0a", "hex"));
		assert.deepEqual((await readdir(join(cacheDirectory, first.contentKey))).sort(), [
			"metadata.json",
			"output.svg",
			"renders",
			"source.tex",
		]);

		const invocation = await readFakeRatexInvocation(ratex.log);
		assert.ok(invocation.args.includes("--input"));
		assert.ok(invocation.args.includes("--stdout"));
		assert.ok(invocation.args.includes("--office-compatible-colors"));
		assert.equal(invocation.inline, true);
		assert.equal(invocation.formula, "E=mc^2\n");

		await appendFile(ratex.command, "\n");
		const changed = await new RichMediaPipeline(
			new LatexArtifactAdapter({ ratexSvgCommand: ratex.command }),
			new SvgAssetRenderer(),
		).render(request, { cacheDirectory });
		assert.notEqual(changed.contentKey, first.contentKey);
		assert.deepEqual(changed.cacheHit, { content: false, asset: false });
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("rejects a RaTeX binary without embedded fonts", async () => {
	const root = await mkdtemp(join(tmpdir(), "pi-rich-ratex-font-mode-integration-"));
	try {
		const ratex = await createFakeRatexSvg(root, { embeddedFonts: false });
		const pipeline = new RichMediaPipeline(
			new LatexArtifactAdapter({ ratexSvgCommand: ratex.command }),
			new SvgAssetRenderer(),
		);
		await assert.rejects(
			pipeline.render({ artifact: latexBlock("E=mc^2") }, { cacheDirectory: join(root, "cache") }),
			/embed-fonts/,
		);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("discovers the managed RaTeX installation without a PATH override", async () => {
	const root = await mkdtemp(join(tmpdir(), "pi-rich-ratex-managed-integration-"));
	const previousCacheDirectory = process.env.PI_RICH_MEDIA_CACHE_DIR;
	const previousCommand = process.env.PI_RICH_MEDIA_RATEX_SVG_COMMAND;
	try {
		await createFakeRatexSvg(root);
		process.env.PI_RICH_MEDIA_CACHE_DIR = root;
		delete process.env.PI_RICH_MEDIA_RATEX_SVG_COMMAND;

		const identity = await new LatexArtifactAdapter().getIdentity();
		assert.equal(identity.id, "ratex-svg");
		assert.match(identity.version, /^policy=1;binary_sha256=[a-f0-9]{64}$/);
	} finally {
		restoreEnvironment("PI_RICH_MEDIA_CACHE_DIR", previousCacheDirectory);
		restoreEnvironment("PI_RICH_MEDIA_RATEX_SVG_COMMAND", previousCommand);
		await rm(root, { recursive: true, force: true });
	}
});

test("renders a real RaTeX formula when a test binary is configured", async (context) => {
	const command = process.env.PI_RICH_MEDIA_TEST_RATEX_SVG_COMMAND;
	if (!command || !hasCommand(command) || (!hasCommand("rsvg-convert") && !hasCommand("magick"))) {
		context.skip("requires PI_RICH_MEDIA_TEST_RATEX_SVG_COMMAND and an SVG rasterizer");
		return;
	}

	const root = await mkdtemp(join(tmpdir(), "pi-rich-ratex-real-integration-"));
	try {
		const pipeline = new RichMediaPipeline(
			new LatexArtifactAdapter({ ratexSvgCommand: command }),
			new SvgAssetRenderer(),
		);
		const artifact = await pipeline.render(
			{
				artifact: latexBlock(String.raw`\frac{QK^T}{\sqrt{d}}`, "block"),
				options: { background: "white" },
			},
			{ cacheDirectory: root },
		);
		assert.deepEqual(artifact.cacheHit, { content: false, asset: false });
		assert.match(await readFile(artifact.intermediate.path, "utf8"), /<svg[\s>].*<path/s);
		assert.deepEqual((await readFile(artifact.asset.path)).subarray(0, 8), Buffer.from("89504e470d0a1a0a", "hex"));
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

function latexBlock(content: string, displayMode: "inline" | "block" = "inline"): LatexBlock {
	return {
		version: ARTIFACT_VERSION,
		type: "formula",
		format: displayMode === "inline" ? "latex-inline" : "latex-display",
		content,
		startLine: 1,
		endLine: 1,
	};
}

function hasCommand(command: string): boolean {
	try {
		execFileSync(command, ["--help"], { stdio: "ignore", timeout: 15_000 });
		return true;
	} catch {
		return false;
	}
}

function restoreEnvironment(name: string, value: string | undefined): void {
	if (value === undefined) delete process.env[name];
	else process.env[name] = value;
}
