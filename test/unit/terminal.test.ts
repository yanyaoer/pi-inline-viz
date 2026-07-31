import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { resetCapabilitiesCache, setCapabilities } from "@earendil-works/pi-tui";

import { TerminalImageRenderer, wrapTmuxPassthrough } from "../../src/renderer/terminal.ts";

const ONE_PIXEL_PNG = Buffer.from(
	"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
	"base64",
);

test("wraps each Kitty graphics chunk for tmux passthrough", () => {
	const first = "\x1b_Ga=T,f=100,m=1;AAAA\x1b\\";
	const second = "\x1b_Gm=0;BBBB\x1b\\";
	const wrapped = wrapTmuxPassthrough(first + second);

	assert.equal((wrapped.match(/\x1bPtmux;/g) ?? []).length, 2);
	assert.match(wrapped, /\x1bPtmux;\x1b\x1b_Ga=T/);
	assert.ok(wrapped.endsWith("\x1b\\"));
});

test("creates a native Kitty image component from cached PNG data", async () => {
	const root = await mkdtemp(join(tmpdir(), "pi-rich-kitty-test-"));
	const pngPath = join(root, "pixel.png");
	const previousTmux = process.env.TMUX;
	try {
		delete process.env.TMUX;
		await writeFile(pngPath, ONE_PIXEL_PNG);
		setCapabilities({ images: "kitty", trueColor: true, hyperlinks: true });

		const renderer = new TerminalImageRenderer();
		assert.equal(renderer.id, "terminal-image");
		const lines = renderer
			.render(
				{
					asset: { format: "png", mediaType: "image/png", path: pngPath },
					capabilities: { backend: "kitty", transport: "direct", supportsUnicode: true },
					viewport: { columns: 10, rows: 10 },
					scalePolicy: { mode: "fixed", scale: 1 },
				},
				{ fallbackColor: (text) => text },
			)
			.render(40);
		assert.match(lines[0] ?? "", /\x1b_Ga=T,f=100,q=2,C=1/);
		assert.match(lines[0] ?? "", /i=/);
	} finally {
		if (previousTmux === undefined) delete process.env.TMUX;
		else process.env.TMUX = previousTmux;
		resetCapabilitiesCache();
		await rm(root, { recursive: true, force: true });
	}
});

test("rejects an advertised backend that is not implemented", async () => {
	const root = await mkdtemp(join(tmpdir(), "pi-rich-sixel-test-"));
	const pngPath = join(root, "pixel.png");
	try {
		await writeFile(pngPath, ONE_PIXEL_PNG);
		assert.throws(
			() =>
				new TerminalImageRenderer().render(
					{
						asset: { format: "png", mediaType: "image/png", path: pngPath },
						capabilities: { backend: "sixel", transport: "direct", supportsUnicode: true },
						viewport: { columns: 10, rows: 10 },
						scalePolicy: { mode: "auto" },
					},
					{ fallbackColor: (text) => text },
				),
			/Sixel terminal rendering is not implemented/,
		);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("uses the requested backend instead of ambient terminal detection", async () => {
	const root = await mkdtemp(join(tmpdir(), "pi-rich-backend-test-"));
	const pngPath = join(root, "pixel.png");
	try {
		await writeFile(pngPath, ONE_PIXEL_PNG);
		setCapabilities({ images: "kitty", trueColor: true, hyperlinks: true });
		const renderer = new TerminalImageRenderer();
		const baseRequest = {
			asset: { format: "png", mediaType: "image/png", path: pngPath } as const,
			viewport: { columns: 10, rows: 10 },
			scalePolicy: { mode: "fixed", scale: 1 } as const,
		};

		const fallback = renderer
			.render(
				{
					...baseRequest,
					capabilities: { backend: "none", transport: "direct", supportsUnicode: true },
				},
				{ fallbackColor: (text) => text },
			)
			.render(40)
			.join("\n");
		assert.doesNotMatch(fallback, /\x1b_G/);
		assert.match(fallback, /pixel\.png/);

		const iterm = renderer
			.render(
				{
					...baseRequest,
					capabilities: { backend: "iterm", transport: "direct", supportsUnicode: true },
				},
				{ fallbackColor: (text) => text },
			)
			.render(40)
			.join("\n");
		assert.match(iterm, /\x1b\]1337;File=/);
		assert.doesNotMatch(iterm, /\x1b_G/);
	} finally {
		resetCapabilitiesCache();
		await rm(root, { recursive: true, force: true });
	}
});
