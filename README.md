# pi-rich-media-renderer

A Pi extension that turns completed `d2` Markdown fences and constrained LaTeX formulas into terminal-native rich media. D2 and RaTeX both produce the same durable SVG IR before the existing planner, raster cache, and terminal backend take over. Mermaid, Graphviz, Vega-Lite, and visibility-driven materialization remain deferred.

## Architecture

![pi-rich-media-renderer architecture](docs/architecture.png)

The image above is dogfooded through this project's Markdown parser and rendering pipeline. Regenerate it with `npm run docs:architecture`.

<details>
<summary>D2 source</summary>

```d2
direction: right

markdown: Pi Markdown {
  shape: document
}
entry: Transcript Entry
pipeline: RichMedia Pipeline {
  direction: down
  content: ContentRenderer {
    direction: down
    d2: D2ContentRenderer
    latex: LaTeX via RaTeX
  }
  svg: SVG IR {
    shape: document
  }
  asset: AssetRenderer {
    label: SvgAssetRenderer
  }
  png: PNG Asset {
    shape: document
  }

  content.d2 -> svg
  content.latex -> svg
  svg -> asset -> png
}
planner: AssetPlanner
terminal: TerminalRenderer {
  label: TerminalImageRenderer
}
environment: Terminal Capability + Viewport
kitty: Kitty Graphics

markdown -> entry -> pipeline.content
pipeline.svg -> planner
environment -> planner
planner -> terminal
pipeline.png -> terminal
environment -> terminal
terminal -> kitty
```

</details>

The code boundary is intentionally three small renderer interfaces plus one pure planner:

- `ContentRenderer`: rich Markdown block to a durable SVG asset.
- `AssetRenderer`: SVG asset to a backend-compatible raster asset.
- `TerminalRenderer`: raster asset to a terminal UI component.
- `AssetPlanner`: SVG dimensions and display context to a raster or text presentation plan.

The Pi transcript entry contains the media type, renderer ID, asset paths, and compact diagnostics. The display backend is detected when the entry is rendered, so reopening a transcript in another terminal does not preserve a stale capability decision. Content renderers do not control terminal UI rendering, and Kitty does not know how the SVG was produced.

Terminal state is split into two contracts:

- `TerminalCapabilities`: stable backend, transport, Unicode support, and Kitty Unicode-placeholder support.
- `TerminalViewport`: current cell dimensions and optional pixel dimensions.

The separation is deliberate: resizing changes the viewport, not the terminal's capabilities. `AssetPlanner` runs when the transcript entry is displayed and uses the current capability, viewport, and scale policy. Auto scale is deliberately quantized to `1x` or `2x`, bounding raster variants without hashing raw rows, columns, or pixel dimensions. A text-only backend produces a text plan instead of requiring raster bytes.

Pi 0.83 entry renderers are synchronous and receive neither a visibility signal nor a TUI redraw handle. The extension therefore uses turn-boundary materialization: after an assistant turn completes, each detected D2 or LaTeX block is rendered and appended as a ready custom transcript entry. `AssetPlanner` still runs when that entry is displayed, but it never starts asynchronous work from a component's `render()` method. There are no `SIGWINCH` handlers and transcript history is never actively rerendered.

## Requirements

- Node.js 22 or newer
- Pi 0.83 or newer from `@earendil-works/pi-coding-agent`
- `d2`
- RaTeX `render-svg`, built with `cli embed-fonts`
- `rsvg-convert` (preferred) or ImageMagick's `magick`
- Kitty, Ghostty, WezTerm, iTerm2, or a terminal with a text fallback

On macOS with Homebrew:

```sh
brew install d2 librsvg
```

Install the self-contained formula renderer from the pinned [RaTeX GitHub release](https://github.com/erweixin/RaTeX/releases/tag/v0.1.14):

```sh
npm run install:ratex
```

This explicit command downloads the release for the current OS and architecture, verifies its pinned SHA-256, checks that `render-svg` contains embedded fonts, and installs it under `~/.cache/pi-rich-media/bin`. Normal `npm install` and formula rendering never download executables or require network access.

As a development fallback, build it from a RaTeX checkout:

```sh
cargo build --release -p ratex-svg --features "cli embed-fonts"
install -m 0755 target/release/render-svg ~/.local/bin/render-svg
```

The extension searches the explicit `PI_RICH_MEDIA_RATEX_SVG_COMMAND` path first, then the managed cache installation, then `render-svg` on `PATH`.

RaTeX also publishes `ratex-wasm` on npm, but that browser package exposes DisplayList and Canvas rendering rather than SVG export. It is not a runtime dependency of this terminal extension.

## Try it

```sh
npm install
pi -e ./src/index.ts
```

Then ask:

```text
show me a d2 architecture diagram: user -> agent -> tool
```

Or render formulas with either supported delimiter form:

```text
Explain the identity $E=mc^2$ and render $$QK^T/\sqrt d$$.
```

The extension tells Pi that fenced D2 is renderable. A completed response such as this is compiled and displayed below the Markdown:

````markdown
```d2
direction: right
user -> agent -> tool
```
````

LaTeX supports inline `$...$` and display `$$...$$` delimiters. Both forms produce separate rich transcript entries at the turn boundary; "inline" describes the accepted Markdown delimiter and RaTeX layout mode, not insertion into the same terminal text row.

To install this checkout as a Pi package:

```sh
pi install /absolute/path/to/pi-rich-media-renderer
```

## Rendering details

[Kitty Graphics Protocol](https://sw.kovidgoyal.net/kitty/graphics-protocol/) accepts PNG, RGB, or RGBA pixel data, not SVG. D2 therefore produces the internal SVG IR, `SvgAssetRenderer` rasterizes it, and only then does `TerminalImageRenderer` create the selected terminal sequence.

For formulas, `LatexContentRenderer` passes only the validated math expression to RaTeX's self-contained `render-svg` binary. Inline formulas select RaTeX text style; display formulas use display style. The resulting SVG contains outlined glyph paths and enters the same `SvgAssetRenderer` used by D2. Formula PNGs use an explicit white background for predictable contrast across terminal themes; the SVG remains reusable if that policy changes later.

`TerminalImageRenderer` uses Pi TUI's protocol encoders and preserves the component invalidation contract for transcript redraws. Known Kitty Unicode-placeholder terminals (currently Kitty and Ghostty) create a virtual placement (`U=1`) and print `U+10EEEE` placeholder cells for both direct and tmux rendering. Those cells behave as ordinary terminal text: transcript scrolling, line clearing, and differential redraws move or remove the image with them. Pi TUI tracks the transfer's image ID and frees it when the component disappears. This avoids cursor-anchored images drifting over the transcript or footer.

Inside tmux, this extension enables Kitty DCS passthrough only when all of the following are true:

- the outer terminal is known to support Kitty Unicode placeholders (currently Kitty or Ghostty);
- `TMUX` is present; and
- `tmux show-options -gv allow-passthrough` returns `on` or `all`.

Enable it explicitly if desired:

```tmux
set -g allow-passthrough on
```

The tmux placeholder command is prefixed by a quiet query and the real image ID is hidden from Pi TUI's classic-placement tracker. This prevents Pi TUI from emitting an unwrapped Kitty delete command during a redraw, which tmux would otherwise expose as text. WezTerm and Warp remain on the direct classic-placement compatibility path; inside tmux they use the text fallback rather than an unsupported placeholder placement.

If image support is unavailable, the planner selects text presentation and Pi shows a clickable or textual PNG path instead of reading raster bytes or emitting unsupported escape sequences.

`sixel` exists in the capability type so the matrix is explicit, but the current renderer rejects it rather than silently selecting an incompatible protocol.

## Cache

SVG and raster identities are separate so a new DPI or scale can reuse the existing SVG without rerunning the content renderer:

```text
~/.cache/pi-rich-media/
└── <content-key>/
    ├── source.d2 | source.tex
    ├── output.svg
    ├── metadata.json
    └── renders/
        └── <asset-key>/
            ├── output.png
            └── metadata.json
```

`content-key` hashes the content, media type/language, content renderer identity and version, and theme. The RaTeX identity includes the complete `render-svg` binary SHA-256, which also covers its embedded KaTeX fonts. Inline and display forms cannot collide even when their formula text is identical. The SVG bytes are hashed separately. `asset-key` hashes that SVG hash plus format, rasterizer/version, DPI, scale, quality policy, and background policy. D2 defaults to transparent; LaTeX explicitly requests white. Cache directories are built privately and committed atomically; metadata is written only after all assets pass size validation. Cache hits are rechecked against the current source and resource budget before reuse.

A `PlannedAsset` has the same deterministic key as its compatible materialized raster. Backend, transport, and raw viewport dimensions are intentionally absent, so Kitty, tmux passthrough, and iTerm can share it. SVG bytes, format, rasterizer/version, DPI, quantized scale, quality, and background are present, so changing any renderer ABI input produces a new key. The planner can produce a text plan from the SVG hash and fallback text without a raster policy; the current eager pipeline still requires an installed rasterizer before that entry exists.

Each metadata file records the renderer identity, configured resource budget, actual input/output bytes, timeout, and `network: false`. Set `PI_RICH_MEDIA_CACHE_DIR` to override the cache root, primarily for tests.

## Security limits

Assistant output is untrusted input. The renderer:

- invokes commands without a shell;
- gives child processes a minimal environment and a 15-second timeout;
- caps source at 256 KiB and generated assets at 20 MiB;
- rejects network-enabled render budgets;
- disables D2 imports, which can read arbitrary `.d2` files;
- disables D2 icons, which can read local paths or fetch URLs;
- accepts only a fixed whitelist of math commands and rejects full documents, macros, TikZ, file/include, URL, shell, and tokenization primitives;
- requires a self-contained RaTeX binary with embedded fonts;
- verifies the pinned GitHub release archive checksum before installing the managed RaTeX binary; and
- passes formula input to RaTeX without a shell, TeX document wrapper, network fetch, or external include stage.

Renderer security is defense-in-depth. The extension does not provide process isolation. `network: false` is an input/tool policy, not an operating-system network sandbox. A failed block becomes a durable error entry in the transcript and does not abort the Pi turn.

Override the formula renderer path with `PI_RICH_MEDIA_RATEX_SVG_COMMAND`.

## Debug mode

Enable durable per-entry rendering diagnostics without writing escape sequences or logs to stdout:

```sh
PI_RICH_MEDIA_DEBUG=1 pi -e ./src/index.ts
```

Each rich transcript entry then includes a compact block like:

```text
[RICH]
block: type=latex-display
asset: svg=11570 bytes png=4098 bytes
cache: content=hit asset=miss
renderer: backend=kitty transport=direct placeholders=yes scale=1
plan: mode=raster format=png size=639x268 scale=1 dpi=96 background=white materializer=rsvg-convert key=e208f8934306
viewport: cells=80x40 pixels=720x720 unicode=yes
```

Diagnostics are displayed lazily with the transcript entry. Debug mode does not add resize listeners or trigger asset generation.

## Next stages

1. Eager turn-boundary materialization: supported by the extension.
2. Async placeholder invalidation: optional future Pi host enhancement, not an extension dependency.
3. Visibility-driven materialization: deferred until the host exposes transcript visibility lifecycle.
4. Next format: Vega/chart through the same SVG pipeline.

## Verification

```sh
npm run check
npm run test:integration
npm run install:ratex
npm run smoke
npm run smoke:latex
npm run docs:architecture
```

`npm run smoke` performs a real D2 compile, SVG rasterization, two-layer cache hit, and Kitty sequence generation. `npm run smoke:latex` performs the equivalent real RaTeX formula path and searches the explicit command, managed cache installation, then `PATH`. The LaTeX integration suite also exercises the full extension and cache paths against a process-level RaTeX contract fixture; set `PI_RICH_MEDIA_TEST_RATEX_SVG_COMMAND` to add a real binary to that suite. Scripts print JSON result objects and do not write graphics escapes to the invoking terminal.

The integration suite also renders `test/fixtures/architecture.d2` at `1x` and `2x` and compares SHA-256 golden hashes for the SVG and both PNGs. `test/fixtures/expected/toolchain.json` pins D2 and librsvg versions so dependency drift fails visibly instead of silently changing terminal output.
