import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import richMediaRenderer from "../../src/index.ts";

test("registers the renderer and teaches Pi about D2 and LaTeX", async () => {
	const handlers = new Map<string, (...args: any[]) => unknown>();
	let rendererType: string | undefined;
	const api = {
		registerEntryRenderer(type: string) {
			rendererType = type;
		},
		on(type: string, handler: (...args: any[]) => unknown) {
			handlers.set(type, handler);
		},
	} as unknown as ExtensionAPI;

	richMediaRenderer(api);
	assert.equal(rendererType, "pi-rich-media-renderer:asset");
	assert.ok(handlers.has("turn_end"));

	const beforeStart = handlers.get("before_agent_start");
	assert.ok(beforeStart);
	const result = (await beforeStart({ systemPrompt: "base" }, { hasUI: true })) as { systemPrompt: string };
	assert.match(result.systemPrompt, /```d2 fenced code block/);
	assert.match(result.systemPrompt, /inline math as \$\.\.\.\$/);
	assert.match(result.systemPrompt, /display math as \$\$\.\.\.\$\$/);
	assert.equal(await beforeStart({ systemPrompt: "base" }, { hasUI: false }), undefined);
});
