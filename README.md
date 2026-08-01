# pi-rich-media-renderer

A Pi extension that turns completed `d2` Markdown fences into inline terminal diagrams. The current release deliberately implements one semantic format and one terminal-first path; LaTeX, Mermaid, Graphviz, Vega-Lite, and adaptive raster materialization remain deferred.

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
    label: D2ContentRenderer
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

  content -> svg -> asset -> png
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

The Pi transcript entry contains the media type, renderer ID, asset paths, and compact diagnostics. The display backend is detected when the entry is rendered, so reopening a transcript in another terminal does not preserve a stale capability decision. D2 does not control terminal UI rendering, and Kitty does not know how the SVG was produced.

Terminal state is split into two contracts:

- `TerminalCapabilities`: stable backend, transport, and Unicode support.
- `TerminalViewport`: current cell dimensions and optional pixel dimensions.

The separation is deliberate: resizing changes the viewport, not the terminal's capabilities. `AssetPlanner` runs when the transcript entry is displayed and uses the current capability, viewport, and scale policy. Auto scale is deliberately quantized to `1x` or `2x`, bounding raster variants without hashing raw rows, columns, or pixel dimensions. A text-only backend produces a text plan instead of requiring raster bytes.

Pi 0.83 entry renderers are synchronous and receive neither a visibility signal nor a TUI redraw handle. The host also renders the full transcript tree, including entries outside the visible terminal viewport. Task 3A therefore plans presentation but deliberately does not launch work from a component's `render()` method: doing so would materialize all history and could not reliably redraw after completion. The current D2 path presents its already-cached fixed-scale PNG. There are no `SIGWINCH` handlers and transcript history is never actively rerendered.

## Requirements

- Node.js 22 or newer
- Pi 0.83 or newer from `@earendil-works/pi-coding-agent`
- `d2`
- `rsvg-convert` (preferred) or ImageMagick's `magick`
- Kitty, Ghostty, WezTerm, iTerm2, or a terminal with a text fallback

On macOS with Homebrew:

```sh
brew install d2 librsvg
```

## Try it

```sh
npm install
pi -e ./src/index.ts
```

Then ask:

```text
show me a d2 architecture diagram: user -> agent -> tool
```

The extension tells Pi that fenced D2 is renderable. A completed response such as this is compiled and displayed below the Markdown:

````markdown
```d2
direction: right
user -> agent -> tool
```
````

To install this checkout as a Pi package:

```sh
pi install /absolute/path/to/pi-rich-media-renderer
```

## Rendering details

[Kitty Graphics Protocol](https://sw.kovidgoyal.net/kitty/graphics-protocol/) accepts PNG, RGB, or RGBA pixel data, not SVG. D2 therefore produces the internal SVG IR, `SvgAssetRenderer` rasterizes it, and only then does `TerminalImageRenderer` create the selected terminal sequence.

`TerminalImageRenderer` uses Pi TUI's protocol encoders for direct Kitty/iTerm rendering and preserves the component invalidation contract for transcript redraws. Classic Kitty placement is tied to the outer terminal's cursor, so it drifts when tmux scrolls or redraws Pi's transcript and footer independently. The tmux path instead creates a Kitty virtual placement (`U=1`) and prints `U+10EEEE` placeholder cells. Those cells behave as ordinary tmux text: transcript scrolling, line clearing, and redraws move or remove the image with them.

Inside tmux, this extension enables Kitty DCS passthrough only when all of the following are true:

- the outer terminal is known to support Kitty Unicode placeholders (currently Kitty or Ghostty);
- `TMUX` is present; and
- `tmux show-options -gv allow-passthrough` returns `on` or `all`.

Enable it explicitly if desired:

```tmux
set -g allow-passthrough on
```

The placeholder command is quiet and the real image ID is hidden from Pi TUI's classic-placement tracker. This prevents Pi TUI from emitting an unwrapped Kitty delete command during a redraw, which tmux would otherwise expose as text. WezTerm and Warp remain supported for direct rendering; inside tmux they currently use the text fallback rather than a misplaced classic image.

If image support is unavailable, the planner selects text presentation and Pi shows a clickable or textual PNG path instead of reading raster bytes or emitting unsupported escape sequences.

`sixel` exists in the capability type so the matrix is explicit, but the current renderer rejects it rather than silently selecting an incompatible protocol.

## Cache

SVG and raster identities are separate so a new DPI or scale can reuse the existing SVG without rerunning D2:

```text
~/.cache/pi-rich-media/
└── <content-key>/
    ├── source.d2
    ├── output.svg
    ├── metadata.json
    └── renders/
        └── <asset-key>/
            ├── output.png
            └── metadata.json
```

`content-key` hashes the content, media type, D2 version, and theme. The SVG bytes are hashed separately. `asset-key` hashes that SVG hash plus format, rasterizer/version, DPI, scale, quality policy, and background policy. The default background is transparent; white is also an explicit supported policy. Cache directories are built privately and committed atomically; metadata is written only after all assets pass size validation. Cache hits are rechecked against the current source and resource budget before reuse.

A `PlannedAsset` has the same deterministic key as its compatible materialized raster. Backend, transport, and raw viewport dimensions are intentionally absent, so Kitty, tmux passthrough, and iTerm can share it. SVG bytes, format, rasterizer/version, DPI, quantized scale, quality, and background are present, so changing any renderer ABI input produces a new key. The planner can produce a text plan from the SVG hash and fallback text without a raster policy; the current eager D2 pipeline still requires an installed rasterizer before that entry exists.

Each metadata file records the renderer identity, configured resource budget, actual input/output bytes, timeout, and `network: false`. Set `PI_RICH_MEDIA_CACHE_DIR` to override the cache root, primarily for tests.

## Security limits

Assistant output is untrusted input. The renderer:

- invokes commands without a shell;
- gives child processes a minimal environment and a 15-second timeout;
- caps source at 256 KiB and generated assets at 20 MiB;
- rejects network-enabled render budgets;
- disables D2 imports, which can read arbitrary `.d2` files; and
- disables D2 icons, which can read local paths or fetch URLs.

Renderer security is defense-in-depth. The extension does not provide process isolation. `network: false` is enforced by the accepted D2 syntax, not an operating-system network sandbox. A failed block becomes a durable error entry in the transcript and does not abort the Pi turn.

## Debug mode

Enable durable per-entry rendering diagnostics without writing escape sequences or logs to stdout:

```sh
PI_RICH_MEDIA_DEBUG=1 pi -e ./src/index.ts
```

Each rich transcript entry then includes a compact block like:

```text
[RICH]
block: type=d2
asset: svg=11570 bytes png=4098 bytes
cache: content=hit asset=miss
renderer: backend=kitty transport=direct scale=1
plan: mode=raster format=png size=639x268 scale=1 dpi=96 background=transparent materializer=rsvg-convert key=e208f8934306
viewport: cells=80x40 pixels=720x720 unicode=yes
```

Diagnostics are displayed lazily with the transcript entry. Debug mode does not add resize listeners or trigger asset generation.

## Next stages

1. Task 3B: add true visibility-driven materialization after Pi exposes entry visibility and a supported redraw/invalidation handle. Do not substitute synchronous transcript-wide work.
2. Task 4: add LaTeX as a second `ContentRenderer` to validate the frozen SVG pipeline.
3. Task 5: optimize viewport invalidation and lazy rerasterization without adding eager resize listeners.

## Verification

```sh
npm run check
npm run test:integration
npm run smoke
npm run docs:architecture
```

`npm run smoke` performs a real D2 compile, SVG rasterization, two-layer cache hit, and Kitty sequence generation. Scripts print JSON result objects and do not write graphics escapes to the invoking terminal.

The integration suite also renders `test/fixtures/architecture.d2` at `1x` and `2x` and compares SHA-256 golden hashes for the SVG and both PNGs. `test/fixtures/expected/toolchain.json` pins D2 and librsvg versions so dependency drift fails visibly instead of silently changing terminal output.
