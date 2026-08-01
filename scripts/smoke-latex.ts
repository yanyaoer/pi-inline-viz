import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resetCapabilitiesCache, setCapabilities } from "@earendil-works/pi-tui";

import { ARTIFACT_VERSION } from "../src/artifact.ts";
import { LatexArtifactAdapter } from "../src/adapters/latex.ts";
import { ArtifactPipeline } from "../src/pipeline.ts";
import { TerminalImageRenderer } from "../src/renderer/terminal.ts";
import { SvgAssetRenderer } from "../src/renderer/svg.ts";

const root = await mkdtemp(join(tmpdir(), "pi-inline-viz-latex-smoke-"));
try {
	const block = {
		version: ARTIFACT_VERSION,
		type: "formula",
		format: "latex-display",
		content: String.raw`QK^T/\sqrt d`,
	} as const;
	const pipeline = new ArtifactPipeline(new LatexArtifactAdapter(), new SvgAssetRenderer());
	const request = { artifact: block, options: { background: "white" as const } };
	const first = await pipeline.render(request, { cacheDirectory: root });
	const second = await pipeline.render(request, { cacheDirectory: root });
	assert.deepEqual(second.cacheHit, { content: true, asset: true });
	assert.match(await readFile(first.intermediate.path, "utf8"), /<svg[\s>].*<path/s);
	assert.deepEqual((await readFile(first.asset.path)).subarray(0, 8), Buffer.from("89504e470d0a1a0a", "hex"));

	setCapabilities({ images: "kitty", trueColor: true, hyperlinks: true });
	const lines = new TerminalImageRenderer()
		.render(
			{
				asset: first.asset,
				capabilities: {
					backend: "kitty",
					transport: "direct",
					supportsUnicode: true,
					kittyPlaceholders: true,
				},
				viewport: { columns: 80, rows: 40, pixelWidth: 720, pixelHeight: 720 },
				scalePolicy: { mode: "fixed", scale: first.profile.scale },
				upscale: false,
			},
			{ fallbackColor: (text) => text },
		)
		.render(80);
	assert.ok((lines[0] ?? "").includes("\x1b_G"));
	assert.ok((lines[0] ?? "").includes("a=T,U=1"));
	assert.ok(lines.every((line) => line.includes(String.fromCodePoint(0x10eeee))));
	assert.ok(lines.length <= 6, `formula should remain compact, got ${lines.length} rows`);

	const [svg, png] = await Promise.all([stat(first.intermediate.path), stat(first.asset.path)]);
	process.stdout.write(
		`${JSON.stringify({
			ok: true,
			cacheHitOnSecondRun: second.cacheHit,
			contentKey: first.contentKey,
			assetKey: first.key,
			svgBytes: svg.size,
			pngBytes: png.size,
			terminalRows: lines.length,
			kittySequence: true,
			kittyPlaceholder: true,
		})}\n`,
	);
} finally {
	resetCapabilitiesCache();
	await rm(root, { recursive: true, force: true });
}
