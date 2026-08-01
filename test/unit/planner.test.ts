import assert from "node:assert/strict";
import test from "node:test";

import { AssetPlanner, parseSvgDimensions } from "../../src/planner.ts";
import { hashCacheIdentity } from "../../src/renderer/cache.ts";
import type {
	AssetPlanContext,
	AssetPlanInput,
	TerminalCapabilities,
} from "../../src/renderer/types.ts";

const planner = new AssetPlanner();
const viewport = { columns: 80, rows: 40, pixelWidth: 720, pixelHeight: 720 } as const;
const terminals: Record<string, TerminalCapabilities> = {
	kitty: { backend: "kitty", transport: "direct", supportsUnicode: true },
	tmux: { backend: "kitty", transport: "tmux-passthrough", supportsUnicode: true },
	iterm: { backend: "iterm", transport: "direct", supportsUnicode: true },
	fallback: { backend: "none", transport: "direct", supportsUnicode: true },
};
const shapes = [
	{ name: "small", width: 200, height: 100, scale: 2 },
	{ name: "large", width: 1600, height: 1200, scale: 1 },
	{ name: "wide", width: 1600, height: 300, scale: 1 },
] as const;

test("plans the capability and shape matrix without backend-specific raster keys", () => {
	for (const shape of shapes) {
		const input = planInput(shape.name, shape.width, shape.height);
		const rasterKeys: string[] = [];
		for (const [terminalName, terminal] of Object.entries(terminals)) {
			const plan = planner.plan(input, planContext(terminal));
			if (terminalName === "fallback") {
				assert.equal(plan.kind, "text", `${shape.name}/${terminalName}`);
				continue;
			}
			assert.equal(plan.kind, "raster", `${shape.name}/${terminalName}`);
			if (plan.kind !== "raster") continue;
			assert.equal(plan.format, "png");
			assert.equal(plan.scale, shape.scale);
			assert.equal(plan.width, shape.width * shape.scale);
			assert.equal(plan.height, shape.height * shape.scale);
			rasterKeys.push(plan.cacheKey);
		}
		assert.equal(new Set(rasterKeys).size, 1, `${shape.name} should share one raster plan`);
	}
});

test("quantizes auto scale so raw viewport dimensions do not become cache identity", () => {
	const input = planInput("small", 200, 100);
	const kitty = terminals.kitty;
	assert.ok(kitty);
	const first = planner.plan(input, planContext(kitty));
	const wider = planner.plan(input, {
		terminal: kitty,
		viewport: { columns: 120, rows: 50, pixelWidth: 1080, pixelHeight: 900 },
		policy: { mode: "auto" },
		raster: rasterPolicy(),
	});
	assert.equal(first.kind, "raster");
	assert.equal(wider.kind, "raster");
	assert.equal(first.cacheKey, wider.cacheKey);
	assert.equal(first.kind === "raster" ? first.scale : 0, 2);

	const fixed = planner.plan(input, {
		terminal: kitty,
		viewport,
		policy: { mode: "fixed", scale: 1.25 },
		raster: rasterPolicy(),
	});
	assert.equal(fixed.kind, "raster");
	if (fixed.kind === "raster") {
		assert.equal(fixed.scale, 1.25);
		assert.equal(fixed.width, 250);
		assert.equal(fixed.height, 125);
		assert.notEqual(fixed.cacheKey, first.cacheKey);
	}
});

test("keys materialization inputs but not compatible terminal backends", () => {
	const input = planInput("identity", 200, 100);
	const kitty = terminals.kitty!;
	const transparent = planner.plan(input, planContext(kitty));
	const white = planner.plan(input, {
		...planContext(kitty),
		raster: { ...rasterPolicy(), background: "white" },
	});
	const upgraded = planner.plan(input, {
		...planContext(kitty),
		raster: { ...rasterPolicy(), materializer: { id: "rsvg-convert", version: "2.63.0" } },
	});
	assert.equal(transparent.kind, "raster");
	assert.equal(white.kind, "raster");
	assert.equal(upgraded.kind, "raster");
	assert.notEqual(transparent.cacheKey, white.cacheKey);
	assert.notEqual(transparent.cacheKey, upgraded.cacheKey);
});

test("text fallback does not require a raster materialization policy", () => {
	const plan = planner.plan(planInput("fallback-only", 200, 100), {
		terminal: terminals.fallback!,
		viewport,
		policy: { mode: "auto" },
	});
	assert.equal(plan.kind, "text");
});

test("parses SVG viewBox and absolute dimensions", () => {
	assert.deepEqual(
		parseSvgDimensions('<svg xmlns="http://www.w3.org/2000/svg" viewBox="-10 -20 288 600"></svg>'),
		{ width: 288, height: 600 },
	);
	assert.deepEqual(parseSvgDimensions("<svg width='72pt' height='25.4mm'></svg>"), {
		width: 96,
		height: 96,
	});
	assert.deepEqual(
		parseSvgDimensions('<svg width="2in" height="1in" viewBox="0 0 20 10"></svg>', 192),
		{ width: 384, height: 192 },
	);
	assert.throws(() => parseSvgDimensions("<svg width='100%' height='20'></svg>"), /intrinsic dimensions/);
	assert.throws(() => parseSvgDimensions("<svg width='10' height='10'></svg>", 0), /DPI must be positive/);
});

test("fails closed for invalid planner states and unsupported Sixel", () => {
	const input = planInput("invalid", 200, 100);
	assert.throws(
		() =>
			planner.plan(input, {
				terminal: { backend: "sixel", transport: "direct", supportsUnicode: true },
				viewport,
				policy: { mode: "auto" },
			}),
		/Sixel asset planning is not implemented/,
	);
	assert.throws(
		() =>
			planner.plan(input, {
				terminal: terminals.kitty!,
				viewport: { columns: 80, rows: 40, pixelWidth: 720 },
				policy: { mode: "auto" },
				raster: rasterPolicy(),
			}),
		/pixel dimensions must be paired/,
	);
	assert.throws(
		() =>
			planner.plan(planInput("huge", Number.MAX_VALUE, 100), {
				terminal: terminals.kitty!,
				viewport,
				policy: { mode: "fixed", scale: 2 },
				raster: rasterPolicy(),
			}),
		/safe integer range/,
	);
	assert.throws(
		() =>
			planner.plan(input, {
				terminal: { backend: "kitty", transport: "tmux-passthrough", supportsUnicode: false },
				viewport,
				policy: { mode: "auto" },
				raster: rasterPolicy(),
			}),
		/requires Unicode support/,
	);
});

function planInput(name: string, width: number, height: number): AssetPlanInput {
	return {
		source: { format: "svg", mediaType: "image/svg+xml", path: `/cache/${name}/output.svg` },
		sourceHash: hashCacheIdentity({ name }),
		width,
		height,
		altText: `[diagram: ${name}]`,
	};
}

function planContext(terminal: TerminalCapabilities): AssetPlanContext {
	return { terminal, viewport, policy: { mode: "auto" }, raster: rasterPolicy() };
}

function rasterPolicy() {
	return {
		materializer: { id: "rsvg-convert", version: "2.62.3" },
		dpi: 96,
		quality: "default" as const,
		background: "transparent" as const,
	};
}
