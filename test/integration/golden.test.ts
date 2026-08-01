import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { D2ArtifactAdapter } from "../../src/engines/d2.ts";
import { RichMediaPipeline } from "../../src/pipeline.ts";
import { SvgAssetRenderer } from "../../src/renderer/svg.ts";

const fixtureDirectory = new URL("../fixtures/", import.meta.url);
const expectedDirectory = new URL("expected/", fixtureDirectory);

test("matches version-pinned SVG and PNG golden hashes", async (context) => {
	if (!hasCommand("d2") || !hasCommand("rsvg-convert")) {
		context.skip("requires d2 and rsvg-convert");
		return;
	}

	const expectedToolchain = JSON.parse(
		await readFile(new URL("toolchain.json", expectedDirectory), "utf8"),
	) as Record<string, string>;
	assert.deepEqual(currentToolchain(), expectedToolchain, "update golden hashes after reviewing toolchain drift");

	const root = await mkdtemp(join(tmpdir(), "pi-rich-golden-"));
	try {
		const content = await readFile(new URL("architecture.d2", fixtureDirectory), "utf8");
		const block = {
			type: "diagram",
			language: "d2",
			content,
			startLine: 1,
			endLine: content.split("\n").length,
		} as const;
		const pipeline = new RichMediaPipeline(new D2ArtifactAdapter(), new SvgAssetRenderer());
		const one = await pipeline.render(block, { cacheDirectory: root, profile: { scale: 1 } });
		const two = await pipeline.render(block, { cacheDirectory: root, profile: { scale: 2 } });

		assert.deepEqual(one.cacheHit, { content: false, asset: false });
		assert.deepEqual(two.cacheHit, { content: true, asset: false });
		assert.equal(two.contentKey, one.contentKey);
		assert.notEqual(two.key, one.key);
		await assertGoldenHash(one.intermediate.path, "architecture.svg.sha256");
		await assertGoldenHash(one.asset.path, "architecture@1x.png.sha256");
		await assertGoldenHash(two.asset.path, "architecture@2x.png.sha256");
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

async function assertGoldenHash(path: string, filename: string): Promise<void> {
	const expected = (await readFile(new URL(filename, expectedDirectory), "utf8")).trim();
	const actual = createHash("sha256").update(await readFile(path)).digest("hex");
	assert.equal(actual, expected, filename);
}

function currentToolchain(): Record<string, string> {
	return {
		d2: version("d2"),
		"rsvg-convert": version("rsvg-convert").split("\n")[0] ?? "",
	};
}

function hasCommand(command: string): boolean {
	try {
		version(command);
		return true;
	} catch {
		return false;
	}
}

function version(command: string): string {
	return execFileSync(command, ["--version"], {
		encoding: "utf8",
		stdio: ["ignore", "pipe", "pipe"],
		timeout: 2_000,
	}).trim();
}
