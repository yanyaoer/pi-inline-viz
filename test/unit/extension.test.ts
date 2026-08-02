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
	assert.deepEqual(commands, ["inline-viz", "inline-viz-doctor", "inline-viz-install-ratex"]);
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

test("/inline-viz controls current and future artifact presentation", async () => {
	const commands = new Map<string, any>();
	const controls: Array<{ type: string; data: unknown }> = [];
	let entryRenderer: ((...args: any[]) => any) | undefined;
	const api = {
		registerEntryRenderer(_type: string, renderer: (...args: any[]) => any) {
			entryRenderer = renderer;
		},
		registerCommand(name: string, command: unknown) {
			commands.set(name, command);
		},
		appendEntry(type: string, data: unknown) {
			controls.push({ type, data });
		},
		on() {},
	} as unknown as ExtensionAPI;

	piInlineViz(api);
	assert.ok(entryRenderer);
	const command = commands.get("inline-viz");
	assert.ok(command);
	assert.deepEqual(
		command.getArgumentCompletions("d").map(({ value }: { value: string }) => value),
		["draw"],
	);

	const theme = { fg: (_color: string, text: string) => text };
	const oldEntry = {
		status: "error",
		type: "diagram",
		renderer: "terminal-image",
		message: "renderer unavailable",
		startLine: 1,
		format: "d2",
		source: "user -> agent\u001b]8;;https://example.invalid\u0007",
		sequence: 1,
	};
	const futureEntry = { ...oldEntry, source: "agent -> tool", sequence: 100 };
	const oldComponent = entryRenderer({ data: oldEntry }, { expanded: false }, theme);
	const futureComponent = entryRenderer({ data: futureEntry }, { expanded: false }, theme);
	const notifications: Array<{ message: string; type: string }> = [];
	const context = {
		ui: {
			notify(message: string, type: string) {
				notifications.push({ message, type });
			},
		},
	};

	assert.match(oldComponent.render(80).join("\n"), /Artifact render failed/);
	await command.handler("clear", context);
	const cleared = oldComponent.render(80).join("\n");
	assert.match(cleared, /^\s*```d2/m);
	assert.match(cleared, /user -> agent/);
	assert.doesNotMatch(cleared, /\u001b|\u0007/);
	assert.match(futureComponent.render(80).join("\n"), /Artifact render failed/);

	await command.handler("off", context);
	assert.match(oldComponent.render(80).join("\n"), /^\s*```d2/m);
	assert.match(futureComponent.render(80).join("\n"), /^\s*```d2/m);
	await command.handler("draw", context);
	assert.match(oldComponent.render(80).join("\n"), /Artifact render failed/);
	assert.match(futureComponent.render(80).join("\n"), /^\s*```d2/m);
	await command.handler("on", context);
	assert.match(oldComponent.render(80).join("\n"), /Artifact render failed/);
	assert.match(futureComponent.render(80).join("\n"), /Artifact render failed/);

	assert.equal(controls.length, 4);
	assert.ok(controls.every(({ type }) => type === "pi-inline-viz:control"));
	const beforeInvalid = controls.length;
	await command.handler("invalid", context);
	assert.equal(controls.length, beforeInvalid);
	assert.deepEqual(notifications.at(-1), {
		message: "Usage: /inline-viz on|off|clear|draw",
		type: "warning",
	});
});

test("/inline-viz state is restored from the active session branch", async () => {
	const firstCommands = new Map<string, any>();
	const controls: Array<{ type: string; data: unknown }> = [];
	const firstApi = {
		registerEntryRenderer() {},
		registerCommand(name: string, command: unknown) {
			firstCommands.set(name, command);
		},
		appendEntry(type: string, data: unknown) {
			controls.push({ type, data });
		},
		on() {},
	} as unknown as ExtensionAPI;
	piInlineViz(firstApi);
	await firstCommands.get("inline-viz").handler("off", { ui: { notify() {} } });

	const handlers = new Map<string, (...args: any[]) => unknown>();
	let entryRenderer: ((...args: any[]) => any) | undefined;
	const secondApi = {
		registerEntryRenderer(_type: string, renderer: (...args: any[]) => any) {
			entryRenderer = renderer;
		},
		registerCommand() {},
		appendEntry() {},
		on(type: string, handler: (...args: any[]) => unknown) {
			handlers.set(type, handler);
		},
	} as unknown as ExtensionAPI;
	piInlineViz(secondApi);
	const sessionStart = handlers.get("session_start");
	assert.ok(sessionStart);
	await sessionStart(
		{ type: "session_start", reason: "reload" },
		{
			sessionManager: {
				getBranch: () => [{
					type: "custom",
					id: "control-1",
					parentId: null,
					timestamp: new Date(0).toISOString(),
					customType: controls[0]?.type,
					data: controls[0]?.data,
				}],
			},
		},
	);

	const beforeStart = handlers.get("before_agent_start");
	assert.ok(beforeStart);
	assert.equal(await beforeStart({ systemPrompt: "base" }, { hasUI: true }), undefined);
	assert.ok(entryRenderer);
	const component = entryRenderer(
		{
			data: {
				status: "error",
				type: "formula",
				renderer: "terminal-image",
				message: "renderer unavailable",
				startLine: 1,
				format: "latex-display",
				source: "E=mc^2",
				sequence: 0,
			},
		},
		{ expanded: false },
		{ fg: (_color: string, text: string) => text },
	);
	assert.deepEqual(
		component.render(80).map((line: string) => line.trim()).filter(Boolean),
		["$$", "E=mc^2", "$$"],
	);
});
