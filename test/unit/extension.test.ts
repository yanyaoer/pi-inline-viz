import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import piInlineViz from "../../extensions/pi-inline-viz.ts";

test("registers the renderer and teaches Pi about artifact formats", async () => {
	const handlers = new Map<string, (...args: any[]) => unknown>();
	const rendererTypes: string[] = [];
	const commands: string[] = [];
	const api = {
		registerEntryRenderer(type: string) {
			rendererTypes.push(type);
		},
		registerCommand(name: string) {
			commands.push(name);
		},
		on(type: string, handler: (...args: any[]) => unknown) {
			handlers.set(type, handler);
		},
	} as unknown as ExtensionAPI;

	piInlineViz(api);
	assert.deepEqual(rendererTypes, [
		"pi-inline-viz:asset",
		"agent-artifact-renderer:asset",
		"pi-rich-media-renderer:asset",
	]);
	assert.deepEqual(commands, ["inline-viz-doctor", "inline-viz-install-ratex"]);
	assert.ok(handlers.has("turn_end"));

	const beforeStart = handlers.get("before_agent_start");
	assert.ok(beforeStart);
	const result = (await beforeStart({ systemPrompt: "base" }, { hasUI: true })) as { systemPrompt: string };
	assert.match(result.systemPrompt, /```d2 fenced code block/);
	assert.match(result.systemPrompt, /```dot fenced code block/);
	assert.match(result.systemPrompt, /```mermaid fenced code block/);
	assert.match(result.systemPrompt, /display math as \$\$\.\.\.\$\$/);
	assert.match(result.systemPrompt, /plain text or Unicode for inline math/);
	assert.equal(await beforeStart({ systemPrompt: "base" }, { hasUI: false }), undefined);
});
