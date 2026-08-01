import assert from "node:assert/strict";
import test from "node:test";

import {
	ansi256ArtifactColor,
	artifactColorLuminance,
	mixArtifactColors,
	resolveArtifactPalette,
} from "../../src/palette.ts";

test("normalizes and validates artifact palettes", () => {
	const palette = resolveArtifactPalette({
		mode: "dark",
		background: "#18181E",
		foreground: "#D4D4D4",
		accent: "#8ABEB7",
		muted: "#808080",
		border: "#5F87FF",
	});

	assert.equal(palette.background, "#18181e");
	assert.equal(palette.accent, "#8abeb7");
	assert.ok(artifactColorLuminance(palette.background) < artifactColorLuminance(palette.foreground));
	assert.throws(
		() => resolveArtifactPalette({ ...palette, accent: "red" as never }),
		/invalid artifact color/,
	);
});

test("mixes palette colors and resolves ANSI 256 colors deterministically", () => {
	assert.equal(mixArtifactColors("#000000", "#ffffff", 0.5), "#808080");
	assert.equal(ansi256ArtifactColor(16), "#000000");
	assert.equal(ansi256ArtifactColor(231), "#ffffff");
	assert.equal(ansi256ArtifactColor(232), "#080808");
	assert.equal(ansi256ArtifactColor(255), "#eeeeee");
	assert.equal(ansi256ArtifactColor(256), undefined);
});
