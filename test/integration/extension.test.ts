import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { resetCapabilitiesCache, setCapabilities } from "@earendil-works/pi-tui";

import piInlineViz, { type ArtifactEntry } from "../../src/index.ts";
import { resetTerminalCapabilityCache } from "../../src/renderer/capabilities.ts";
import { createFakeMermaidCli } from "../helpers/fake-mermaid-cli.ts";
import { createFakeRatexSvg } from "../helpers/fake-ratex-svg.ts";

test("turn_end renders D2 through the terminal capability contract", async () => {
	const root = await mkdtemp(join(tmpdir(), "pi-inline-viz-extension-integration-"));
	const previousCache = process.env.PI_INLINE_VIZ_CACHE_DIR;
	const previousDebug = process.env.PI_INLINE_VIZ_DEBUG;
	const previousTmux = process.env.TMUX;
	const previousKittyWindow = process.env.KITTY_WINDOW_ID;
	const handlers = new Map<string, (...args: any[]) => unknown>();
	let entryRenderer: ((...args: any[]) => any) | undefined;
	const entries: ArtifactEntry[] = [];
	try {
		process.env.PI_INLINE_VIZ_CACHE_DIR = root;
		process.env.PI_INLINE_VIZ_DEBUG = "1";
		delete process.env.TMUX;
		process.env.KITTY_WINDOW_ID = "1";
		resetTerminalCapabilityCache();
		const api = {
			registerEntryRenderer(_type: string, renderer: (...args: any[]) => any) {
				entryRenderer = renderer;
			},
			registerCommand() {},
			on(type: string, handler: (...args: any[]) => unknown) {
				handlers.set(type, handler);
			},
			appendEntry(_type: string, data: ArtifactEntry) {
				entries.push(data);
			},
		} as unknown as ExtensionAPI;
		piInlineViz(api);

		const turnEnd = handlers.get("turn_end");
		assert.ok(turnEnd);
		await turnEnd(
			{
				message: {
					role: "assistant",
					content: [{
						type: "text",
						text: "```d2\ndirection: right\nuser -> memo\nmemo: {\n  shape: note\n}\n```",
					}],
				},
			},
			{ hasUI: true, ui: { notify() {} } },
		);

		assert.equal(entries.length, 1);
		assert.equal(entries[0]?.status, "ready");
		if (entries[0]?.status === "ready") {
			assert.equal(entries[0].type, "diagram");
			assert.equal(entries[0].renderer, "terminal-image");
			assert.match(entries[0].contentKey, /^[a-f0-9]{64}$/);
			assert.match(entries[0].sourceHash, /^[a-f0-9]{64}$/);
			assert.equal(entries[0].rasterPolicy.background, "transparent");
			assert.equal(entries[0].rasterPolicy.quality, "default");
			assert.ok(["rsvg-convert", "magick"].includes(entries[0].rasterPolicy.materializer.id));
			assert.match(entries[0].asset, /output\.png$/);
			assert.match(entries[0].intermediate, /output\.svg$/);
			assert.equal(entries[0].diagnostics.language, "d2");
			assert.equal(entries[0].diagnostics.contentCacheHit, false);
			assert.equal(entries[0].diagnostics.assetCacheHit, false);
			assert.equal(entries[0].diagnostics.scale, 1);
			assert.ok(entries[0].diagnostics.sourceWidth > 0);
			assert.ok(entries[0].diagnostics.sourceHeight > 0);
			assert.ok(entries[0].diagnostics.svgBytes > 0);
			assert.ok(entries[0].diagnostics.pngBytes > 0);
			const compatibilityFixes = entries[0].diagnostics.compatibilityFixes;
			assert.ok(compatibilityFixes);
			assert.deepEqual(compatibilityFixes.map(({ from, to }) => ({ from, to })), [
				{ from: "note", to: "document" },
			]);
		}
		assert.ok(entryRenderer);
		setCapabilities({ images: "kitty", trueColor: true, hyperlinks: true });
		const component = entryRenderer(
			{ data: entries[0] },
			{ expanded: false },
			{ fg: (_color: string, text: string) => text },
		);
		const output = component.render(80).join("\n");
		assert.match(output, /\[PI INLINE VIZ\]/);
		assert.match(output, /cache: content=miss asset=miss/);
		assert.match(output, /compatibility: note->document/);
		assert.match(output, /renderer: backend=kitty transport=direct placeholders=yes scale=1/);
		assert.match(
			output,
			/plan: mode=raster format=png size=\d+x\d+ scale=1 dpi=96\s+background=transparent materializer=(?:rsvg-convert|magick) key=[a-f0-9]{12}/,
		);
		assert.match(output, /\x1b_Ga=T,U=1,f=100/);
		assert.ok(output.includes(String.fromCodePoint(0x10eeee)));
		assert.match(output, /\x1b]8;;file:\/\//);
		assert.match(output, /\[open\/zoom\]/);
		const wideOutput = component.render(160);
		const placeholder = String.fromCodePoint(0x10eeee);
		const wideImageLine = wideOutput.find((line: string) => line.includes(placeholder));
		assert.ok(wideImageLine);
		assert.ok([...wideImageLine].filter((character) => character === placeholder).length < 158);
		setCapabilities({ images: null, trueColor: true, hyperlinks: true });
		const environmentHintOutput = entryRenderer(
			{ data: entries[0] },
			{ expanded: false },
			{ fg: (_color: string, text: string) => text },
		).render(80).join("\n");
		assert.match(environmentHintOutput, /\x1b_Ga=T,U=1,f=100/);
		assert.ok(environmentHintOutput.includes(placeholder));
		const readyEntry = entries[0];
		if (readyEntry?.status === "ready") {
			const legacyDiagnostics = { ...readyEntry.diagnostics };
			delete legacyDiagnostics.compatibilityFixes;
			const legacyComponent = entryRenderer(
				{ data: { ...readyEntry, diagnostics: legacyDiagnostics } },
				{ expanded: false },
				{ fg: (_color: string, text: string) => text },
			);
			assert.match(legacyComponent.render(80).join("\n"), /compatibility: none/);
		}
	} finally {
		restoreEnvironment("PI_INLINE_VIZ_CACHE_DIR", previousCache);
		restoreEnvironment("PI_INLINE_VIZ_DEBUG", previousDebug);
		if (previousTmux === undefined) delete process.env.TMUX;
		else process.env.TMUX = previousTmux;
		if (previousKittyWindow === undefined) delete process.env.KITTY_WINDOW_ID;
		else process.env.KITTY_WINDOW_ID = previousKittyWindow;
		resetTerminalCapabilityCache();
		resetCapabilitiesCache();
		await rm(root, { recursive: true, force: true });
	}
});

test("turn_end leaves inline math in prose and renders only display formulas", async () => {
	const root = await mkdtemp(join(tmpdir(), "pi-inline-viz-latex-extension-integration-"));
	const previousCache = process.env.PI_INLINE_VIZ_CACHE_DIR;
	const previousRatex = process.env.PI_INLINE_VIZ_RATEX_COMMAND;
	const previousTmux = process.env.TMUX;
	const previousKittyWindow = process.env.KITTY_WINDOW_ID;
	const handlers = new Map<string, (...args: any[]) => unknown>();
	let entryRenderer: ((...args: any[]) => any) | undefined;
	const entries: ArtifactEntry[] = [];
	try {
		const ratex = await createFakeRatexSvg(root);
		process.env.PI_INLINE_VIZ_CACHE_DIR = join(root, "cache");
		process.env.PI_INLINE_VIZ_RATEX_COMMAND = ratex.command;
		delete process.env.TMUX;
		process.env.KITTY_WINDOW_ID = "1";
		resetTerminalCapabilityCache();
		const api = {
			registerEntryRenderer(_type: string, renderer: (...args: any[]) => any) {
				entryRenderer = renderer;
			},
			registerCommand() {},
			on(type: string, handler: (...args: any[]) => unknown) {
				handlers.set(type, handler);
			},
			appendEntry(_type: string, data: ArtifactEntry) {
				entries.push(data);
			},
		} as unknown as ExtensionAPI;
		piInlineViz(api);

		const turnEnd = handlers.get("turn_end");
		assert.ok(turnEnd);
		await turnEnd(
			{
				message: {
					role: "assistant",
					content: [
						{
							type: "text",
							text: [String.raw`First $E=mc^2$, again $E=mc^2$.`, String.raw`$$QK^T/\sqrt d$$`].join(
								"\n",
							),
						},
					],
				},
			},
			{ hasUI: true, ui: { notify() {} } },
		);

		assert.equal(entries.length, 1);
		assert.ok(
			entries.every((entry) => entry.status === "ready" && entry.type === "formula"),
			JSON.stringify(entries),
		);
		assert.equal(entries[0]?.status === "ready" && entries[0].diagnostics.language, "latex-display");
		assert.equal(entries[0]?.status === "ready" && entries[0].diagnostics.assetCacheHit, false);
		assert.equal(entries[0]?.startLine, 2);
		assert.ok(entryRenderer);
		setCapabilities({ images: "kitty", trueColor: true, hyperlinks: true });
		const component = entryRenderer(
			{ data: entries[0] },
			{ expanded: false },
			{ fg: (_color: string, text: string) => text },
		);
		const rendered = component.render(80).join("\n");
		assert.match(rendered, /\x1b_Ga=T,U=1,f=100/);
		assert.ok(rendered.includes(String.fromCodePoint(0x10eeee)));
		assert.match(rendered, /\[open\/zoom\]/);
		assert.ok(component.render(80).length < 10);
	} finally {
		restoreEnvironment("PI_INLINE_VIZ_CACHE_DIR", previousCache);
		restoreEnvironment("PI_INLINE_VIZ_RATEX_COMMAND", previousRatex);
		if (previousTmux === undefined) delete process.env.TMUX;
		else process.env.TMUX = previousTmux;
		if (previousKittyWindow === undefined) delete process.env.KITTY_WINDOW_ID;
		else process.env.KITTY_WINDOW_ID = previousKittyWindow;
		resetTerminalCapabilityCache();
		resetCapabilitiesCache();
		await rm(root, { recursive: true, force: true });
	}
});

test("turn_end renders Mermaid through the artifact adapter", async () => {
	const root = await mkdtemp(join(tmpdir(), "pi-inline-viz-mermaid-extension-test-"));
	const previousCache = process.env.PI_INLINE_VIZ_CACHE_DIR;
	const previousCommand = process.env.PI_INLINE_VIZ_MMDC_COMMAND;
	const previousChrome = process.env.PI_INLINE_VIZ_CHROME_PATH;
	const handlers = new Map<string, (...args: any[]) => unknown>();
	const entries: ArtifactEntry[] = [];
	try {
		const cli = await createFakeMermaidCli(root);
		process.env.PI_INLINE_VIZ_CACHE_DIR = join(root, "cache");
		process.env.PI_INLINE_VIZ_MMDC_COMMAND = cli.command;
		process.env.PI_INLINE_VIZ_CHROME_PATH = cli.chrome;
		const api = {
			registerEntryRenderer() {},
			registerCommand() {},
			on(type: string, handler: (...args: any[]) => unknown) {
				handlers.set(type, handler);
			},
			appendEntry(_type: string, data: ArtifactEntry) {
				entries.push(data);
			},
		} as unknown as ExtensionAPI;
		piInlineViz(api);

		const turnEnd = handlers.get("turn_end");
		assert.ok(turnEnd);
		await turnEnd(
			{
				message: {
					role: "assistant",
					content: [{ type: "text", text: "```mermaid\nflowchart LR\nuser --> agent --> tool\n```" }],
				},
			},
			{ hasUI: true, ui: { notify() {} } },
		);

		assert.equal(entries.length, 1);
		assert.equal(entries[0]?.status, "ready");
		if (entries[0]?.status === "ready") {
			assert.equal(entries[0].type, "diagram");
			assert.equal(entries[0].diagnostics.language, "mermaid");
			assert.equal(entries[0].rasterPolicy.background, "transparent");
		}
	} finally {
		restoreEnvironment("PI_INLINE_VIZ_CACHE_DIR", previousCache);
		restoreEnvironment("PI_INLINE_VIZ_MMDC_COMMAND", previousCommand);
		restoreEnvironment("PI_INLINE_VIZ_CHROME_PATH", previousChrome);
		await rm(root, { recursive: true, force: true });
	}
});

function restoreEnvironment(name: string, value: string | undefined): void {
	if (value === undefined) delete process.env[name];
	else process.env[name] = value;
}
