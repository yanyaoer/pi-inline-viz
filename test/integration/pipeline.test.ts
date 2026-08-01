import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { ARTIFACT_VERSION, DEFAULT_EXECUTION_POLICY, DEFAULT_RENDER_OPTIONS } from "../../src/artifact.ts";
import { D2ArtifactAdapter } from "../../src/adapters/d2.ts";
import type { D2Block } from "../../src/parser/d2.ts";
import { ArtifactPipeline } from "../../src/pipeline.ts";
import { SvgAssetRenderer } from "../../src/renderer/svg.ts";

test("renders D2 to cached SVG and PNG assets", async (context) => {
	if (!hasCommand("d2") || (!hasCommand("rsvg-convert") && !hasCommand("magick"))) {
		context.skip("requires d2 and either rsvg-convert or magick");
		return;
	}

	const root = await mkdtemp(join(tmpdir(), "pi-rich-integration-"));
	try {
		const pipeline = new ArtifactPipeline(new D2ArtifactAdapter(), new SvgAssetRenderer());
		const block = d2Block([
			"direction: right",
			"user -> memo -> store",
			"memo: {",
			"  shape: note",
			"}",
			"store: {",
			"  shape: database",
			"}",
		].join("\n"));
		const canonicalContent = block.content
			.replace("shape: note", "shape: document")
			.replace("shape: database", "shape: cylinder");
		const first = await pipeline.render({ artifact: block }, { cacheDirectory: root });
		const second = await pipeline.render({ artifact: block }, { cacheDirectory: root });
		const scaled = await pipeline.render({ artifact: block, options: { scale: 2 } }, { cacheDirectory: root });
		const white = await pipeline.render(
			{ artifact: block, options: { background: "white" } },
			{ cacheDirectory: root },
		);

		assert.deepEqual(first.cacheHit, { content: false, asset: false });
		assert.deepEqual(second.cacheHit, { content: true, asset: true });
		assert.deepEqual(scaled.cacheHit, { content: true, asset: false });
		assert.deepEqual(white.cacheHit, { content: true, asset: false });
		assert.equal(second.key, first.key);
		assert.equal(scaled.contentKey, first.contentKey);
		assert.notEqual(scaled.key, first.key);
		assert.notEqual(white.key, first.key);
		assert.equal(await readFile(first.sourcePath, "utf8"), canonicalContent);
		assert.deepEqual(first.compatibilityFixes.map(({ from, to }) => ({ from, to })), [
			{ from: "note", to: "document" },
			{ from: "database", to: "cylinder" },
		]);
		assert.match(await readFile(first.intermediate.path, "utf8"), /<svg/);
		assert.deepEqual((await readFile(first.asset.path)).subarray(0, 8), Buffer.from("89504e470d0a1a0a", "hex"));
		assert.ok((await stat(first.metadataPath)).size > 0);
		assert.deepEqual(await readdir(root), [first.contentKey]);
		assert.deepEqual((await readdir(join(root, first.contentKey))).sort(), [
			"metadata.json",
			"output.svg",
			"renders",
			"source.d2",
		]);
		const contentMetadata = JSON.parse(
			await readFile(join(root, first.contentKey, "metadata.json"), "utf8"),
		) as { adapter: { id: string; version: string } };
		assert.equal(contentMetadata.adapter.id, "d2");
		assert.match(contentMetadata.adapter.version, /^policy=3;d2=0\.7\.1$/);
		const metadata = JSON.parse(await readFile(first.metadataPath, "utf8")) as {
			version: number;
			execution_policy: { network: string; filesystem: string };
			asset_renderer: { id: string; version: string };
			source_hash: string;
			background: string;
		};
		assert.equal(metadata.version, 4);
		assert.equal(metadata.execution_policy.network, "deny");
		assert.equal(metadata.execution_policy.filesystem, "isolated-workdir");
		assert.equal(metadata.source_hash, first.sourceHash);
		assert.equal(metadata.background, "transparent");
		assert.ok(["rsvg-convert", "magick"].includes(metadata.asset_renderer.id));
		assert.notEqual(metadata.asset_renderer.version, "unknown");
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("materializes explicit transparent and white background policies", async (context) => {
	if (!hasCommand("rsvg-convert") && !hasCommand("magick")) {
		context.skip("requires rsvg-convert or magick");
		return;
	}

	const root = await mkdtemp(join(tmpdir(), "pi-rich-background-integration-"));
	try {
		const source = join(root, "source.svg");
		await writeFile(
			source,
			'<svg xmlns="http://www.w3.org/2000/svg" width="2" height="2"><rect width="1" height="1" fill="red"/></svg>',
		);
		const renderer = new SvgAssetRenderer();
		const asset = { format: "svg", mediaType: "image/svg+xml", path: source } as const;
		const transparent = await renderer.render(asset, {
			outputPath: join(root, "transparent.png"),
			profile: DEFAULT_RENDER_OPTIONS,
			policy: DEFAULT_EXECUTION_POLICY,
		});
		const white = await renderer.render(asset, {
			outputPath: join(root, "white.png"),
			profile: { ...DEFAULT_RENDER_OPTIONS, background: "white" },
			policy: DEFAULT_EXECUTION_POLICY,
		});
		const themed = await renderer.render(asset, {
			outputPath: join(root, "themed.png"),
			profile: { ...DEFAULT_RENDER_OPTIONS, background: "#18181e" },
			policy: DEFAULT_EXECUTION_POLICY,
		});
		assert.notDeepEqual(await readFile(transparent.path), await readFile(white.path));
		assert.notDeepEqual(await readFile(white.path), await readFile(themed.path));
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("reports invalid D2 and removes partial cache files", async (context) => {
	if (!hasCommand("d2")) {
		context.skip("requires d2");
		return;
	}

	const root = await mkdtemp(join(tmpdir(), "pi-rich-integration-error-"));
	try {
		const pipeline = new ArtifactPipeline(new D2ArtifactAdapter(), new SvgAssetRenderer());
		await assert.rejects(
			pipeline.render(
				{ artifact: d2Block("unknown: { shape: sticky-note }") },
				{ cacheDirectory: root },
			),
			/d2 failed:.*unknown shape.*Suggestion: use a supported D2 shape/s,
		);
		assert.deepEqual(await readdir(root), []);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("applies a dark Pi palette alongside an existing D2 config", async (context) => {
	if (!hasCommand("d2") || (!hasCommand("rsvg-convert") && !hasCommand("magick"))) {
		context.skip("requires d2 and either rsvg-convert or magick");
		return;
	}

	const root = await mkdtemp(join(tmpdir(), "pi-inline-viz-themed-d2-"));
	try {
		const artifact = await new ArtifactPipeline(
			new D2ArtifactAdapter(),
			new SvgAssetRenderer(),
		).render(
			{
				artifact: d2Block([
					"vars: {",
					"  d2-config: {",
					"    layout-engine: dagre",
					'    theme-overrides: { B1: "#ff0000" }',
					"  }",
					"}",
					"user -> agent -> tool",
				].join("\n")),
				options: {
					palette: {
						mode: "dark",
						background: "#18181e",
						foreground: "#d4d4d4",
						accent: "#8abeb7",
						muted: "#808080",
						border: "#5f87ff",
					},
				},
			},
			{ cacheDirectory: root },
		);
		const svg = (await readFile(artifact.intermediate.path, "utf8")).toLowerCase();
		assert.match(svg, /#18181e/);
		assert.match(svg, /#d4d4d4/);
		assert.match(svg, /#8abeb7/);
		assert.doesNotMatch(svg, /#ff0000/);
		assert.equal(await readFile(artifact.sourcePath, "utf8"), [
			"vars: {",
			"  d2-config: {",
			"    layout-engine: dagre",
			'    theme-overrides: { B1: "#ff0000" }',
			"  }",
			"}",
			"user -> agent -> tool",
		].join("\n"));
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

function hasCommand(command: string): boolean {
	try {
		execFileSync(command, ["--version"], { stdio: "ignore", timeout: 2_000 });
		return true;
	} catch {
		return false;
	}
}

function d2Block(content: string): D2Block {
	return { version: ARTIFACT_VERSION, type: "diagram", format: "d2", content, startLine: 1, endLine: 3 };
}
