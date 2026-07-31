# pi-rich-media-renderer

A Pi extension that turns completed `d2` Markdown fences into inline terminal diagrams. The current release deliberately implements one format and one terminal-first path; LaTeX, Mermaid, Graphviz, Vega-Lite, and resize-aware rasterization remain deferred.

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
  terminal: TerminalRenderer {
    label: TerminalImageRenderer
  }

  content -> svg -> asset -> png -> terminal
}
environment: Terminal Capability + Viewport
kitty: Kitty Graphics

markdown -> entry -> pipeline.content
environment -> pipeline.terminal
pipeline.terminal -> kitty
```

</details>

The code boundary is intentionally three small interfaces:

- `ContentRenderer`: rich Markdown block to a durable SVG asset.
- `AssetRenderer`: SVG asset to a backend-compatible raster asset.
- `TerminalRenderer`: raster asset to a terminal UI component.

The Pi transcript entry contains the media type, renderer ID, asset paths, and compact diagnostics. The display backend is detected when the entry is rendered, so reopening a transcript in another terminal does not preserve a stale capability decision. D2 does not control terminal UI rendering, and Kitty does not know how the SVG was produced.

Terminal state is split into two contracts:

- `TerminalCapabilities`: stable backend, transport, and Unicode support.
- `TerminalViewport`: current cell dimensions and optional pixel dimensions.

The separation is deliberate: resizing changes the viewport, not the terminal's capabilities. A `TerminalRenderRequest` combines the asset, both contracts, and a discriminated scale policy. The current pipeline submits a fixed scale; `auto` is reserved for the adaptive asset planner. It does not register `SIGWINCH` handlers or rerasterize transcript history.

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

`TerminalImageRenderer` uses Pi TUI's protocol encoders for direct Kitty/iTerm rendering and preserves the component invalidation contract for transcript redraws. Inside tmux, this extension uses Kitty DCS passthrough only when all of the following are true:

- the outer terminal advertises Kitty graphics compatibility;
- `TMUX` is present; and
- `tmux show-options -gv allow-passthrough` returns `on` or `all`.

Enable it explicitly if desired:

```tmux
set -g allow-passthrough on
```

If image support is unavailable, Pi shows a clickable or textual PNG path instead of emitting unsupported escape sequences.

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

`content-key` hashes the content, media type, D2 version, and theme. `asset-key` hashes the content key, rasterizer/version, DPI, and scale. Cache directories are built privately and committed atomically; metadata is written only after all assets pass size validation. Cache hits are rechecked against the current source and resource budget before reuse.

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
viewport: cells=80x40 pixels=720x720 unicode=yes
```

Diagnostics are displayed lazily with the transcript entry. Debug mode does not add resize listeners or trigger asset generation.

## Next stages

1. Task 3: add `AssetPlanner`, adaptive size/format selection, and version-pinned SVG/PNG golden fixtures.
2. Task 4: add LaTeX as a second `ContentRenderer` to validate the frozen SVG pipeline.
3. Task 5: optimize lazy rerasterization for changed viewports without replaying transcript history.

## Verification

```sh
npm run check
npm run test:integration
npm run smoke
npm run docs:architecture
```

`npm run smoke` performs a real D2 compile, SVG rasterization, two-layer cache hit, and Kitty sequence generation. Scripts print JSON result objects and do not write graphics escapes to the invoking terminal.
