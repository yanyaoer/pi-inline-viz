import assert from "node:assert/strict";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resetCapabilitiesCache, setCapabilities, visibleWidth } from "@earendil-works/pi-tui";

import { D2ContentRenderer } from "../src/engines/d2.ts";
import { RichMediaPipeline } from "../src/pipeline.ts";
import { AssetPlanner, readSvgDimensions } from "../src/planner.ts";
import { TerminalImageRenderer } from "../src/renderer/terminal.ts";
import { SvgAssetRenderer } from "../src/renderer/svg.ts";

const root = await mkdtemp(join(tmpdir(), "pi-rich-smoke-"));
try {
	const source = "direction: right\nuser -> agent -> tool";
	const block = { type: "diagram", language: "d2", content: source, startLine: 1, endLine: 3 } as const;
	const pipeline = new RichMediaPipeline(new D2ContentRenderer(), new SvgAssetRenderer());
	const first = await pipeline.render(block, { cacheDirectory: root });
	const second = await pipeline.render(block, { cacheDirectory: root });
	const dimensions = await readSvgDimensions(first.intermediate.path, first.profile.dpi);
	const viewport = { columns: 80, rows: 40, pixelWidth: 720, pixelHeight: 720 } as const;
	const plan = new AssetPlanner().plan(
		{
			source: first.intermediate,
			sourceHash: first.sourceHash,
			...dimensions,
			altText: first.asset.path,
		},
		{
			terminal: {
				backend: "kitty",
				transport: "direct",
				supportsUnicode: true,
				kittyPlaceholders: true,
			},
			viewport,
			policy: { mode: "fixed", scale: first.profile.scale },
			raster: {
				materializer: first.assetRenderer,
				dpi: first.profile.dpi,
				quality: first.profile.quality,
				background: first.profile.background,
			},
		},
	);
	assert.equal(plan.kind, "raster");
	assert.equal(plan.cacheKey, first.key);
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
				viewport,
				scalePolicy: { mode: "fixed", scale: first.profile.scale },
			},
			{ fallbackColor: (text) => text },
		)
		.render(80);
	const tmuxLines = new TerminalImageRenderer()
		.render(
			{
				asset: first.asset,
				capabilities: {
					backend: "kitty",
					transport: "tmux-passthrough",
					supportsUnicode: true,
					kittyPlaceholders: true,
				},
				viewport,
				scalePolicy: { mode: "fixed", scale: first.profile.scale },
			},
			{ fallbackColor: (text) => text },
		)
		.render(80);
	assert.deepEqual(second.cacheHit, { content: true, asset: true });
	assert.ok((lines[0] ?? "").includes("\x1b_G"));
	const placeholder = String.fromCodePoint(0x10eeee);
	const directPlaceholderColumns = (lines[0] ?? "").split(placeholder).length - 1;
	const placeholderColumns = (tmuxLines[0] ?? "").split(placeholder).length - 1;
	assert.equal(tmuxLines.length, lines.length);
	assert.ok((lines[0] ?? "").includes("a=T,U=1"));
	assert.ok(directPlaceholderColumns > 0);
	assert.ok(lines.every((line) => line.includes(placeholder)));
	assert.ok((tmuxLines[0] ?? "").includes("a=T,U=1"));
	assert.ok(placeholderColumns > 0);
	assert.ok(tmuxLines.every((line) => line.includes(placeholder)));
	assert.ok(tmuxLines.slice(1).every((line) => visibleWidth(line) === placeholderColumns));

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
			terminalBackend: "kitty",
			viewport: "80x40",
			plan: plan.kind,
			planKey: plan.cacheKey,
			kittySequence: true,
			kittyPlaceholder: true,
			tmuxPlaceholder: true,
		})}\n`,
	);
} finally {
	resetCapabilitiesCache();
	await rm(root, { recursive: true, force: true });
}
