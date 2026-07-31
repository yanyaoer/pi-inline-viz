import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { resetCapabilitiesCache, setCapabilities } from "@earendil-works/pi-tui";

import richMediaRenderer, { type RichMediaEntry } from "../../src/index.ts";
import { resetTerminalCapabilityCache } from "../../src/renderer/capabilities.ts";

test("turn_end renders D2 through the terminal capability contract", async () => {
	const root = await mkdtemp(join(tmpdir(), "pi-rich-extension-integration-"));
	const previousCache = process.env.PI_RICH_MEDIA_CACHE_DIR;
	const previousDebug = process.env.PI_RICH_MEDIA_DEBUG;
	const previousTmux = process.env.TMUX;
	const handlers = new Map<string, (...args: any[]) => unknown>();
	let entryRenderer: ((...args: any[]) => any) | undefined;
	const entries: RichMediaEntry[] = [];
	try {
		process.env.PI_RICH_MEDIA_CACHE_DIR = root;
		process.env.PI_RICH_MEDIA_DEBUG = "1";
		delete process.env.TMUX;
		resetTerminalCapabilityCache();
		const api = {
			registerEntryRenderer(_type: string, renderer: (...args: any[]) => any) {
				entryRenderer = renderer;
			},
			on(type: string, handler: (...args: any[]) => unknown) {
				handlers.set(type, handler);
			},
			appendEntry(_type: string, data: RichMediaEntry) {
				entries.push(data);
			},
		} as unknown as ExtensionAPI;
		richMediaRenderer(api);

		const turnEnd = handlers.get("turn_end");
		assert.ok(turnEnd);
		await turnEnd(
			{
				message: {
					role: "assistant",
					content: [{ type: "text", text: "```d2\ndirection: right\nuser -> agent -> tool\n```" }],
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
		}
		assert.ok(entryRenderer);
		setCapabilities({ images: "kitty", trueColor: true, hyperlinks: true });
		const component = entryRenderer(
			{ data: entries[0] },
			{ expanded: false },
			{ fg: (_color: string, text: string) => text },
		);
		const output = component.render(80).join("\n");
		assert.match(output, /\[RICH\]/);
		assert.match(output, /cache: content=miss asset=miss/);
		assert.match(output, /renderer: backend=kitty transport=direct scale=1/);
		assert.match(output, /plan: mode=raster format=png size=\d+x\d+ scale=1 key=[a-f0-9]{12}/);
		assert.match(output, /\x1b_Ga=T,f=100/);
	} finally {
		if (previousCache === undefined) delete process.env.PI_RICH_MEDIA_CACHE_DIR;
		else process.env.PI_RICH_MEDIA_CACHE_DIR = previousCache;
		if (previousDebug === undefined) delete process.env.PI_RICH_MEDIA_DEBUG;
		else process.env.PI_RICH_MEDIA_DEBUG = previousDebug;
		if (previousTmux === undefined) delete process.env.TMUX;
		else process.env.TMUX = previousTmux;
		resetTerminalCapabilityCache();
		resetCapabilitiesCache();
		await rm(root, { recursive: true, force: true });
	}
});
