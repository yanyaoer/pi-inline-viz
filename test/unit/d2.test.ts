import assert from "node:assert/strict";
import test from "node:test";

import { validateD2Source } from "../../src/engines/d2.ts";

test("accepts a basic architecture diagram", () => {
	assert.doesNotThrow(() => validateD2Source("direction: right\nuser -> agent -> tool"));
});

test("rejects empty and oversized D2", () => {
	assert.throws(() => validateD2Source(" \n"), /empty/);
	assert.throws(() => validateD2Source("x".repeat(256 * 1024 + 1)), /exceeds/);
});

test("rejects file imports in regular and spread forms", () => {
	assert.throws(() => validateD2Source("system: @/etc/passwd"), /imports are disabled/);
	assert.throws(() => validateD2Source("container: { ...@../secret }"), /imports are disabled/);
	assert.throws(() => validateD2Source("...@shared"), /imports are disabled/);
});

test("rejects icons because D2 can fetch local or remote resources", () => {
	assert.throws(() => validateD2Source("server.icon: https://example.com/server.svg"), /icons are disabled/);
	assert.throws(() => validateD2Source("server: { icon: ./secret.png }"), /icons are disabled/);
});
