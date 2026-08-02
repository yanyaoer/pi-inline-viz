import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
	resetCapabilitiesCache,
	setCapabilities,
	TUI,
	type Terminal,
	visibleWidth,
} from "@earendil-works/pi-tui";

import { encodeKittyPlaceholderImage, encodeTmuxKittyImage } from "../../src/renderer/kitty.ts";
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

test("encodes all four image ID bytes in Kitty placeholders", () => {
	const lines = encodeKittyPlaceholderImage(ONE_PIXEL_PNG.toString("base64"), {
		columns: 2,
		rows: 2,
		imageId: 33_554_474,
	});

	const placeholder = String.fromCodePoint(0x10eeee);
	assert.match(lines[0] ?? "", /\x1b\[38:2:0:0:42m/);
	assert.ok(lines[0]?.includes(`${placeholder}\u0305\u0305\u030e`));
	assert.ok(lines[1]?.includes(`${placeholder}\u030d\u030d\u030e`));

	const viewportLines = encodeKittyPlaceholderImage("AAAA", {
		columns: 80,
		rows: 40,
		imageId: 0xffffffff,
	});
	assert.equal(viewportLines.length, 40);
	assert.ok(viewportLines.slice(1).every((line) => visibleWidth(line) === 80));
	assert.ok(viewportLines.at(-1)?.includes("\ua8e5"));
	assert.throws(
		() => encodeKittyPlaceholderImage("AAAA", { columns: 257, rows: 1, imageId: 1 }),
		/between 1 and 256/,
	);
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
					capabilities: {
						backend: "kitty",
						transport: "direct",
						supportsUnicode: true,
						kittyPlaceholders: false,
					},
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

test("anchors direct Kitty images to Unicode placeholder cells", async () => {
	const root = await mkdtemp(join(tmpdir(), "pi-rich-direct-placeholder-test-"));
	const pngPath = join(root, "pixel.png");
	try {
		await writeFile(pngPath, ONE_PIXEL_PNG);
		const lines = new TerminalImageRenderer()
			.render(
				{
					asset: { format: "png", mediaType: "image/png", path: pngPath },
					capabilities: {
						backend: "kitty",
						transport: "direct",
						supportsUnicode: true,
						kittyPlaceholders: true,
					},
					viewport: { columns: 4, rows: 3 },
					scalePolicy: { mode: "fixed", scale: 1 },
				},
				{ fallbackColor: (text) => text },
			)
			.render(6);

		const placeholder = String.fromCodePoint(0x10eeee);
		assert.equal(lines.length, 2);
		assert.match(lines[0] ?? "", /^\x1b_Ga=T,U=1,/);
		assert.ok(lines.every((line) => visibleWidth(line) === 4));
		assert.ok(lines.every((line) => line.split(placeholder).length - 1 === 4));
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("can preserve a small image's native size instead of filling the viewport", async () => {
	const root = await mkdtemp(join(tmpdir(), "pi-rich-native-size-test-"));
	const pngPath = join(root, "pixel.png");
	try {
		await writeFile(pngPath, ONE_PIXEL_PNG);
		const lines = new TerminalImageRenderer()
			.render(
				{
					asset: { format: "png", mediaType: "image/png", path: pngPath },
					capabilities: {
						backend: "kitty",
						transport: "direct",
						supportsUnicode: true,
						kittyPlaceholders: true,
					},
					viewport: { columns: 80, rows: 40 },
					scalePolicy: { mode: "fixed", scale: 1 },
					upscale: false,
				},
				{ fallbackColor: (text) => text },
			)
			.render(82);

		assert.equal(lines.length, 1);
		assert.equal(visibleWidth(lines[0] ?? ""), 1);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("caps and indents a formula-sized image in terminal cells", async () => {
	const root = await mkdtemp(join(tmpdir(), "pi-rich-formula-presentation-test-"));
	const pngPath = join(root, "formula.png");
	try {
		await writeFile(pngPath, pngWithDimensions(400, 400));
		const lines = new TerminalImageRenderer()
			.render(
				{
					asset: { format: "png", mediaType: "image/png", path: pngPath },
					capabilities: {
						backend: "kitty",
						transport: "direct",
						supportsUnicode: true,
						kittyPlaceholders: true,
					},
					viewport: { columns: 80, rows: 40 },
					scalePolicy: { mode: "fixed", scale: 1 },
					upscale: false,
					maxHeightCells: 3,
					leftPaddingCells: 2,
				},
				{ fallbackColor: (text) => text },
			)
			.render(80);

		assert.equal(lines.length, 3);
		assert.ok(lines.every((line) => line.startsWith("  ")));
		assert.ok(
			new TerminalImageRenderer()
				.render(
					{
						asset: { format: "png", mediaType: "image/png", path: pngPath },
						capabilities: {
							backend: "kitty",
							transport: "direct",
							supportsUnicode: true,
							kittyPlaceholders: true,
						},
						viewport: { columns: 2, rows: 3 },
						scalePolicy: { mode: "fixed", scale: 1 },
						leftPaddingCells: 2,
					},
					{ fallbackColor: (text) => text },
				)
				.render(2)
				.every((line) => visibleWidth(line) <= 2),
		);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("Pi TUI deletes a direct placeholder image when its component disappears", async () => {
	const root = await mkdtemp(join(tmpdir(), "pi-rich-direct-placeholder-lifecycle-test-"));
	const pngPath = join(root, "pixel.png");
	try {
		await writeFile(pngPath, ONE_PIXEL_PNG);
		const component = new TerminalImageRenderer().render(
			{
				asset: { format: "png", mediaType: "image/png", path: pngPath },
				capabilities: {
					backend: "kitty",
					transport: "direct",
					supportsUnicode: true,
					kittyPlaceholders: true,
				},
				viewport: { columns: 4, rows: 3 },
				scalePolicy: { mode: "fixed", scale: 1 },
			},
			{ fallbackColor: (text) => text },
		);
		const terminal = new RecordingTerminal(20, 10);
		const tui = new TUI(terminal, false);
		tui.addChild(component);
		renderNow(tui);
		const imageId = /\bi=(\d+)/.exec(terminal.writes.at(-1) ?? "")?.[1];
		assert.ok(imageId);

		tui.removeChild(component);
		renderNow(tui);
		assert.match(terminal.writes.at(-1) ?? "", new RegExp(`a=d,d=I,i=${imageId},q=2`));
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("bounds placeholder layouts to the Kitty diacritic table", async () => {
	const root = await mkdtemp(join(tmpdir(), "pi-rich-placeholder-limit-test-"));
	const pngPath = join(root, "pixel.png");
	try {
		await writeFile(pngPath, ONE_PIXEL_PNG);
		const lines = new TerminalImageRenderer()
			.render(
				{
					asset: { format: "png", mediaType: "image/png", path: pngPath },
					capabilities: {
						backend: "kitty",
						transport: "direct",
						supportsUnicode: true,
						kittyPlaceholders: true,
					},
					viewport: { columns: 400, rows: 400 },
					scalePolicy: { mode: "fixed", scale: 1 },
				},
				{ fallbackColor: (text) => text },
			)
			.render(402);

		assert.equal(visibleWidth(lines[0] ?? ""), 256);
		assert.ok(lines.length <= 256);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("uses text-anchored Kitty placeholders through tmux", async () => {
	const root = await mkdtemp(join(tmpdir(), "pi-rich-tmux-placeholder-test-"));
	const pngPath = join(root, "pixel.png");
	try {
		await writeFile(pngPath, ONE_PIXEL_PNG);
		const lines = new TerminalImageRenderer()
			.render(
				{
					asset: { format: "png", mediaType: "image/png", path: pngPath },
					capabilities: {
						backend: "kitty",
						transport: "tmux-passthrough",
						supportsUnicode: true,
						kittyPlaceholders: true,
					},
					viewport: { columns: 4, rows: 3 },
					scalePolicy: { mode: "fixed", scale: 1 },
				},
				{ fallbackColor: (text) => text },
			)
			.render(6);

		const placeholder = String.fromCodePoint(0x10eeee);
		assert.equal(lines.length, 2);
		assert.match(lines[0] ?? "", /a=T,U=1/);
		for (const [index, line] of lines.entries()) {
			if (index > 0) assert.equal(visibleWidth(line), 4);
			assert.equal(line.split(placeholder).length - 1, 4);
		}
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("tmux redraw does not leak an unwrapped Kitty delete command", async () => {
	const root = await mkdtemp(join(tmpdir(), "pi-rich-tmux-redraw-test-"));
	const pngPath = join(root, "pixel.png");
	try {
		await writeFile(pngPath, ONE_PIXEL_PNG);
		const component = new TerminalImageRenderer().render(
			{
				asset: { format: "png", mediaType: "image/png", path: pngPath },
				capabilities: {
					backend: "kitty",
					transport: "tmux-passthrough",
					supportsUnicode: true,
					kittyPlaceholders: true,
				},
				viewport: { columns: 4, rows: 3 },
				scalePolicy: { mode: "fixed", scale: 1 },
			},
			{ fallbackColor: (text) => text },
		);
		const terminal = new RecordingTerminal(20, 10);
		const tui = new TUI(terminal, false);
		tui.addChild(component);
		renderNow(tui);
		assert.doesNotMatch(terminal.writes.at(-1) ?? "", /\x1b\[\d+[AB]/);

		terminal.columns = 21;
		renderNow(tui);

		const redraw = terminal.writes.at(-1) ?? "";
		assert.doesNotMatch(redraw, /(?<!\x1b)\x1b_Ga=d,d=I,i=\d+,q=2/);
	} finally {
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
						capabilities: {
							backend: "sixel",
							transport: "direct",
							supportsUnicode: true,
							kittyPlaceholders: false,
						},
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

test("rejects tmux placeholders without Unicode support", () => {
	assert.throws(
		() =>
			new TerminalImageRenderer().render(
				{
					asset: { format: "png", mediaType: "image/png", path: "/missing.png" },
					capabilities: {
						backend: "kitty",
						transport: "tmux-passthrough",
						supportsUnicode: false,
						kittyPlaceholders: true,
					},
					viewport: { columns: 10, rows: 10 },
					scalePolicy: { mode: "auto" },
				},
				{ fallbackColor: (text) => text },
			),
		/require Unicode support/,
	);
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
					capabilities: {
						backend: "none",
						transport: "direct",
						supportsUnicode: true,
						kittyPlaceholders: false,
					},
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
					capabilities: {
						backend: "iterm",
						transport: "direct",
						supportsUnicode: true,
						kittyPlaceholders: false,
					},
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

test("text fallback does not read raster bytes", () => {
	const output = new TerminalImageRenderer()
		.render(
			{
				asset: { format: "png", mediaType: "image/png", path: "/missing/planned-diagram.png" },
				capabilities: {
					backend: "none",
					transport: "direct",
					supportsUnicode: true,
					kittyPlaceholders: false,
				},
				viewport: { columns: 80, rows: 24 },
				scalePolicy: { mode: "auto" },
			},
			{ fallbackColor: (text) => text },
		)
		.render(80)
		.join("\n");
	assert.match(output, /planned-diagram\.png/);
});

class RecordingTerminal implements Terminal {
	readonly writes: string[] = [];
	readonly rows: number;
	columns: number;
	readonly kittyProtocolActive = false;

	constructor(columns: number, rows: number) {
		this.columns = columns;
		this.rows = rows;
	}

	start(): void {}
	stop(): void {}
	async drainInput(): Promise<void> {}
	write(data: string): void {
		this.writes.push(data);
	}
	moveBy(): void {}
	hideCursor(): void {}
	showCursor(): void {}
	clearLine(): void {}
	clearFromCursor(): void {}
	clearScreen(): void {}
	setTitle(): void {}
	setProgress(): void {}
}

function pngWithDimensions(width: number, height: number): Buffer {
	const png = Buffer.from(ONE_PIXEL_PNG);
	png.writeUInt32BE(width, 16);
	png.writeUInt32BE(height, 20);
	return png;
}

function renderNow(tui: TUI): void {
	const render = Reflect.get(tui, "doRender") as () => void;
	render.call(tui);
}
