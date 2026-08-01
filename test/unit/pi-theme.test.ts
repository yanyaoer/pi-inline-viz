import assert from "node:assert/strict";
import test from "node:test";
import type { Theme } from "@earendil-works/pi-coding-agent";

import { artifactColorFromAnsi, artifactPaletteFromPiTheme } from "../../src/pi-theme.ts";

test("extracts the active Pi truecolor palette", () => {
	const colors: Record<string, string> = {
		customMessageText: "\u001b[38;2;212;212;212m",
		text: "\u001b[39m",
		accent: "\u001b[38;2;138;190;183m",
		muted: "\u001b[38;2;128;128;128m",
		border: "\u001b[38;2;95;135;255m",
	};
	const theme = {
		name: "custom",
		getFgAnsi(name: string) {
			return colors[name] ?? "\u001b[39m";
		},
		getBgAnsi() {
			return "\u001b[48;2;45;40;56m";
		},
	} as unknown as Theme;

	assert.deepEqual(artifactPaletteFromPiTheme(theme), {
		mode: "dark",
		background: "#2d2838",
		foreground: "#d4d4d4",
		accent: "#8abeb7",
		muted: "#808080",
		border: "#5f87ff",
	});
});

test("supports 256-color themes and safe fallbacks for terminal-default colors", () => {
	assert.equal(artifactColorFromAnsi("\u001b[38;5;67m"), "#5f87af");
	assert.equal(artifactColorFromAnsi("\u001b[48;5;255m"), "#eeeeee");
	assert.equal(artifactColorFromAnsi("\u001b[39m"), undefined);

	const light = {
		name: "light",
		getFgAnsi() {
			return "\u001b[39m";
		},
		getBgAnsi() {
			return "\u001b[49m";
		},
	} as unknown as Theme;
	assert.equal(artifactPaletteFromPiTheme(light).mode, "light");
	assert.equal(artifactPaletteFromPiTheme(light).background, "#f8f8f8");
});
