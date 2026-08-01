import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { SvgAssetRenderer } from "../../src/renderer/svg.ts";

test("uses a configured rsvg-convert path", async () => {
	const root = await mkdtemp(join(tmpdir(), "pi-inline-viz-rsvg-path-test-"));
	try {
		const executable = await fakeVersionCommand(root, "custom-rsvg", "rsvg-convert version 2.62.3");
		const identity = await new SvgAssetRenderer({ rsvgCommand: executable }).getIdentity();
		assert.deepEqual(identity, { id: "rsvg-convert", version: "rsvg-convert version 2.62.3" });
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("falls back to a configured ImageMagick path", async () => {
	const root = await mkdtemp(join(tmpdir(), "pi-inline-viz-magick-path-test-"));
	try {
		const executable = await fakeVersionCommand(root, "custom-magick", "ImageMagick 7.1.2");
		const identity = await new SvgAssetRenderer({
			rsvgCommand: join(root, "missing-rsvg"),
			magickCommand: executable,
		}).getIdentity();
		assert.deepEqual(identity, { id: "magick", version: "ImageMagick 7.1.2" });
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

async function fakeVersionCommand(root: string, name: string, version: string): Promise<string> {
	const directory = join(root, "bin");
	const executable = join(directory, name);
	await mkdir(directory, { recursive: true });
	await writeFile(executable, `#!/bin/sh\nprintf '%s\\n' '${version}'\n`, { mode: 0o700 });
	return executable;
}
