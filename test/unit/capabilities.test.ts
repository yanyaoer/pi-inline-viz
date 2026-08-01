import assert from "node:assert/strict";
import test from "node:test";

import {
	createTerminalViewport,
	limitTerminalViewport,
	resolveTerminalCapabilities,
	terminalIsTmuxPane,
	terminalSupportsKittyUnicodePlaceholders,
	terminalSupportsUnicode,
} from "../../src/renderer/capabilities.ts";

test("normalizes Pi image protocols and tmux transport", () => {
	assert.deepEqual(
		resolveTerminalCapabilities("kitty", { supportsUnicode: true, kittyPlaceholders: true }),
		{
			backend: "kitty",
			transport: "direct",
			supportsUnicode: true,
			kittyPlaceholders: true,
		},
	);
	assert.deepEqual(resolveTerminalCapabilities("iterm2", { supportsUnicode: false }), {
		backend: "iterm",
		transport: "direct",
		supportsUnicode: false,
		kittyPlaceholders: false,
	});
	assert.equal(
		resolveTerminalCapabilities("kitty", {
			supportsUnicode: false,
			kittyPlaceholders: true,
		}).kittyPlaceholders,
		false,
	);
	assert.deepEqual(resolveTerminalCapabilities(null, { tmuxKittyPassthrough: true }), {
		backend: "kitty",
		transport: "tmux-passthrough",
		supportsUnicode: true,
		kittyPlaceholders: true,
	});
	assert.deepEqual(
		resolveTerminalCapabilities("kitty", {
			tmuxKittyPassthrough: true,
			supportsUnicode: false,
		}),
		{ backend: "none", transport: "direct", supportsUnicode: false, kittyPlaceholders: false },
	);
	assert.equal(resolveTerminalCapabilities(null).backend, "none");
});

test("detects placeholders only for known compatible Kitty terminals", () => {
	assert.equal(terminalSupportsKittyUnicodePlaceholders({ KITTY_WINDOW_ID: "1" }), true);
	assert.equal(terminalSupportsKittyUnicodePlaceholders({ TERM_PROGRAM: "ghostty" }), true);
	assert.equal(
		terminalSupportsKittyUnicodePlaceholders({ TMUX: "/tmp/tmux/default" }, "xterm-kitty"),
		true,
	);
	assert.equal(
		terminalSupportsKittyUnicodePlaceholders({ TMUX: "/tmp/tmux/default" }, "xterm-ghostty"),
		true,
	);
	assert.equal(
		terminalSupportsKittyUnicodePlaceholders(
			{ TMUX: "/tmp/tmux/default", KITTY_WINDOW_ID: "stale" },
			"xterm-256color",
		),
		false,
	);
	assert.equal(terminalSupportsKittyUnicodePlaceholders({ WEZTERM_PANE: "1" }), false);
	assert.equal(terminalSupportsKittyUnicodePlaceholders({ WARP_SESSION_ID: "1" }), false);
});

test("distinguishes a real tmux pane from stale inherited tmux variables", () => {
	const environment = { TMUX: "/tmp/tmux/default", TMUX_PANE: "%8" };
	assert.equal(terminalIsTmuxPane(environment, 17, 17), true);
	assert.equal(terminalIsTmuxPane(environment, 17, 8), false);
	assert.equal(terminalIsTmuxPane({ TMUX: environment.TMUX }, 17, 17), false);
	assert.equal(terminalIsTmuxPane(environment, undefined, 17), false);
});

test("keeps dynamic viewport dimensions separate from capabilities", () => {
	const viewport = createTerminalViewport(120, 50, { widthPx: 9, heightPx: 18 });
	assert.deepEqual(viewport, {
		columns: 120,
		rows: 50,
		pixelWidth: 1080,
		pixelHeight: 900,
	});
	assert.deepEqual(limitTerminalViewport(viewport, 80, 40), {
		columns: 80,
		rows: 40,
		pixelWidth: 720,
		pixelHeight: 720,
	});
	assert.deepEqual(createTerminalViewport(undefined, undefined), { columns: 80, rows: 24 });
});

test("uses locale as a conservative Unicode capability hint", () => {
	assert.equal(terminalSupportsUnicode({ LANG: "C" }), false);
	assert.equal(terminalSupportsUnicode({ LC_ALL: "POSIX", LANG: "en_US.UTF-8" }), false);
	assert.equal(terminalSupportsUnicode({ LANG: "C.UTF-8" }), true);
	assert.equal(terminalSupportsUnicode({}), true);
});
