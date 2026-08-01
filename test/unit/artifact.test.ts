import assert from "node:assert/strict";
import test from "node:test";

import {
	ARTIFACT_VERSION,
	artifactIdentity,
	artifactRenderIdentity,
	canonicalRenderOptions,
	canonicalSerialize,
	resolveArtifactRenderRequest,
	type Artifact,
} from "../../src/artifact.ts";

const artifact: Artifact = {
	version: ARTIFACT_VERSION,
	type: "diagram",
	format: "d2",
	content: "a -> b",
};

test("keys only the semantic artifact contract", () => {
	const annotated = { ...artifact, metadata: { title: "ignored" }, comment: "ignored" };

	assert.match(artifactIdentity(artifact), /^[a-f0-9]{64}$/);
	assert.equal(artifactIdentity(annotated), artifactIdentity(artifact));
	assert.notEqual(artifactIdentity({ ...artifact, content: "a -> c" }), artifactIdentity(artifact));
});

test("canonicalizes render option order and explicit defaults", () => {
	const left = canonicalRenderOptions({ scale: 2, background: "white", theme: "dark" });
	const reordered = canonicalRenderOptions({ theme: "dark", background: "white", scale: 2 });

	assert.equal(left, reordered);
	assert.equal(canonicalRenderOptions({}), canonicalRenderOptions({ scale: 1, background: "transparent" }));
	assert.equal(
		canonicalRenderOptions({ background: "#18181E" }),
		canonicalRenderOptions({ background: "#18181e" }),
	);
	assert.throws(
		() => canonicalRenderOptions({ experimental: true } as never),
		/unsupported render option: experimental/,
	);
});

test("separates SVG render identity from raster options and execution policy", () => {
	const artifactKey = artifactIdentity(artifact);
	const adapter = { id: "d2", version: "0.7.1" };
	const base = artifactRenderIdentity({ artifactKey, adapter, options: {} });

	assert.equal(
		base,
		artifactRenderIdentity({ artifactKey, adapter, options: { scale: 2, background: "white", dpi: 192 } }),
	);
	assert.notEqual(base, artifactRenderIdentity({ artifactKey, adapter, options: { theme: "dark" } }));
	assert.notEqual(
		base,
		artifactRenderIdentity({
			artifactKey,
			adapter,
			options: {
				palette: {
					mode: "dark",
					background: "#18181e",
					foreground: "#d4d4d4",
					accent: "#8abeb7",
					muted: "#808080",
					border: "#5f87ff",
				},
			},
		}),
	);
	assert.notEqual(
		base,
		artifactRenderIdentity({ artifactKey, adapter: { ...adapter, version: "0.8.0" }, options: {} }),
	);
});

test("rejects unsupported artifact protocol versions", () => {
	const unsupported = { ...artifact, version: 2 as never };

	assert.throws(() => artifactIdentity(unsupported), /unsupported artifact version: 2/);
	assert.throws(() => resolveArtifactRenderRequest({ artifact: unsupported }), /unsupported artifact version: 2/);
});

test("snapshots semantic and policy inputs at the protocol boundary", () => {
	const input = { ...artifact, content: "before", comment: "host-only" };
	const policy = {
		timeoutMs: 1_000,
		maxInputBytes: 1_000,
		maxOutputBytes: 1_000,
		network: "deny" as const,
		filesystem: "isolated-workdir" as const,
	};
	const resolved = resolveArtifactRenderRequest({ artifact: input, policy });
	input.content = "after";
	policy.timeoutMs = 2_000;

	assert.equal(resolved.artifact.content, "before");
	assert.equal(resolved.policy.timeoutMs, 1_000);
	assert.equal("comment" in resolved.artifact, false);
});

test("rejects non-canonical identity values", () => {
	assert.throws(() => canonicalSerialize({ invalid: Number.NaN }), /must be finite/);
	const cyclic: Record<string, unknown> = {};
	cyclic.self = cyclic;
	assert.throws(() => canonicalSerialize(cyclic), /must not contain cycles/);
});
