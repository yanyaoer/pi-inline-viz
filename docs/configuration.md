# Configuration

Pi Inline Viz requires only the renderers for formats you use, plus one SVG rasterizer. Run `/inline-viz-doctor` inside Pi after setup; its output identifies the exact missing layer.

## Dependencies

### macOS

```sh
brew install d2 librsvg
npm install -g @mermaid-js/mermaid-cli@11.16.0
pi install git:github.com/yanyaoer/pi-inline-viz
```

Then run these commands inside Pi:

```text
/inline-viz-install-ratex
/inline-viz-doctor
```

`/inline-viz-install-ratex` downloads the pinned RaTeX release for the current platform, verifies its SHA-256, checks for embedded fonts, and installs `render-svg` under `~/.cache/pi-inline-viz/bin`.

### Linux

Install these commands from the package manager used by your distribution:

- `d2`
- `rsvg-convert` from librsvg, or ImageMagick's `magick`
- Google Chrome or Chromium
- Node.js 22 or newer and npm

Then install Mermaid CLI and the Pi package:

```sh
npm install -g @mermaid-js/mermaid-cli@11.16.0
pi install git:github.com/yanyaoer/pi-inline-viz
```

Start Pi and run `/inline-viz-install-ratex`, followed by `/inline-viz-doctor`.

## Environment variables

No environment variables are required for the standard setup. Use these only when executables or cache files live in non-standard locations.

| Variable | Purpose |
| --- | --- |
| `PI_INLINE_VIZ_CACHE_DIR` | Cache root; defaults to `~/.cache/pi-inline-viz` |
| `PI_INLINE_VIZ_D2_COMMAND` | Absolute path or command name for D2 |
| `PI_INLINE_VIZ_MMDC_COMMAND` | Absolute path or command name for Mermaid CLI |
| `PI_INLINE_VIZ_CHROME_PATH` | Absolute path to Chrome or Chromium |
| `PI_INLINE_VIZ_RATEX_COMMAND` | Absolute path or command name for RaTeX `render-svg` |
| `PI_INLINE_VIZ_DEBUG=1` | Show cache, planner, renderer, and viewport diagnostics in entries |

For example:

```sh
export PI_INLINE_VIZ_CHROME_PATH=/usr/bin/chromium
export PI_INLINE_VIZ_MMDC_COMMAND=$HOME/.local/bin/mmdc
```

Legacy environment names from `agent-artifact-renderer` and `pi-rich-media-renderer` remain accepted for existing installations, but new configuration should use only `PI_INLINE_VIZ_*`.

## Terminal setup

### Kitty and Ghostty

Direct sessions require no extension configuration. Pi Inline Viz uses Kitty Unicode-placeholder placements so transcript scrolling and redraws move or remove images with their text rows.

The `[open/zoom]` action is an OSC 8 `file://` hyperlink. On macOS, follow it with Cmd-click. On Linux, use the terminal's configured link gesture, commonly Ctrl-click.

Kitty can route image links to macOS Preview. Put this rule before broader `file` rules in `~/.config/kitty/open-actions.conf`, then reload Kitty's configuration:

```conf
protocol file
mime image/*
action launch --type=background /usr/bin/open -a Preview $FILE_PATH
```

### tmux

Kitty graphics passthrough is enabled only when the outer terminal supports Unicode placeholders and tmux explicitly permits passthrough:

```tmux
set -g allow-passthrough on
```

If file links are not clickable, advertise hyperlink support:

```tmux
set-option -s 'terminal-features[100]' "xterm-kitty:hyperlinks"
set-option -s 'terminal-features[101]' "xterm-ghostty:hyperlinks"
```

Restart the tmux server after changing passthrough. For terminal-feature changes, detach and reattach the client, then verify:

```sh
tmux show-options -gv allow-passthrough
tmux display-message -p '#{client_termfeatures}'
```

## Rendering policy

Inline images retain their native size until they exceed the bounded transcript viewport. The planner does not include terminal backend, tmux transport, or raw viewport dimensions in the cache key. It does not listen to `SIGWINCH` or redraw transcript history on resize.

Formula PNGs use a white background for predictable contrast. D2 and Mermaid use transparent backgrounds. These policies are included in raster cache identity.
