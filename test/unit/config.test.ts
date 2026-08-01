import assert from "node:assert/strict";
import test from "node:test";

import { defaultArtifactCacheDirectory } from "../../src/config.ts";

test("prefers the Pi Inline Viz cache setting and retains legacy fallbacks", () => {
	assert.equal(
		defaultArtifactCacheDirectory({
			PI_INLINE_VIZ_CACHE_DIR: "/new-cache",
			AGENT_ARTIFACT_CACHE_DIR: "/old-cache",
		}),
		"/new-cache",
	);
	assert.equal(
		defaultArtifactCacheDirectory({
			PI_INLINE_VIZ_CACHE_DIR: "",
			PI_RICH_MEDIA_CACHE_DIR: "/legacy-cache",
		}),
		"/legacy-cache",
	);
});

test("uses an absolute XDG cache root on Linux-style environments", () => {
	assert.equal(
		defaultArtifactCacheDirectory({ XDG_CACHE_HOME: "/xdg-cache" }, "/home/tester"),
		"/xdg-cache/pi-inline-viz",
	);
	assert.equal(
		defaultArtifactCacheDirectory({ XDG_CACHE_HOME: "relative-cache" }, "/home/tester"),
		"/home/tester/.cache/pi-inline-viz",
	);
});
