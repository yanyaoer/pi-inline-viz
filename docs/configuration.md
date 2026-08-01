# Configuration

Pi Inline Viz requires only the renderers for formats you use, plus one SVG rasterizer. A missing optional renderer does not disable the formats that are ready. Run `/inline-viz-doctor` inside Pi after setup; its output identifies the exact missing layer.

## Dependencies

### macOS

```sh
brew install librsvg
pi install npm:pi-inline-viz
```

Add only the formats you use:

- D2: `brew install d2`
- Mermaid: `npm install -g @mermaid-js/mermaid-cli@11.16.0`
- LaTeX: run `/inline-viz-install-ratex` inside Pi

`/inline-viz-install-ratex` downloads the pinned RaTeX release for the current platform, verifies its SHA-256, checks for embedded fonts, and installs `render-svg` under the configured Pi Inline Viz cache root. This is `$XDG_CACHE_HOME/pi-inline-viz/bin` when `XDG_CACHE_HOME` is absolute, otherwise `~/.cache/pi-inline-viz/bin`.

### Linux

Install the Pi package:

```sh
pi install npm:pi-inline-viz
```

Install one shared SVG rasterizer:

```sh
# Debian or Ubuntu
sudo apt install librsvg2-bin

# Fedora
sudo dnf install librsvg2-tools

# Arch Linux
sudo pacman -S librsvg

# Alpine Linux
sudo apk add rsvg-convert
```

ImageMagick 7's `magick` command is also supported as a fallback. Then add only the format renderers you use:

- D2: follow the [official D2 Linux instructions](https://www.d2lang.com/tour/install/), which provide a dry-run installer and release binaries.
- LaTeX: run `/inline-viz-install-ratex` inside Pi. The installer provides pinned musl binaries for Linux x64 and arm64.
- Mermaid: install the pinned CLI:

```sh
npm install -g @mermaid-js/mermaid-cli@11.16.0
```

`mmdc` installs Puppeteer and normally downloads its matching Chrome for Testing. Pi Inline Viz lets `mmdc` use that managed browser, so a separate system Chrome is not required. Set `PI_INLINE_VIZ_CHROME_PATH` only when you intentionally manage the browser yourself.

Start Pi and run `/inline-viz-doctor`. Missing optional formats may remain `MISSING`; every `READY` format remains usable.

## Executable discovery

For a command name such as `d2` or `mmdc`, Pi Inline Viz checks `PATH` first, then the Node executable directory and common user locations including `~/bin`, `~/.local/bin`, global npm directories, `~/go/bin`, `~/.cargo/bin`, Homebrew/Linuxbrew, `/usr/local/bin`, `/usr/bin`, and `/snap/bin`. It also honors `GOBIN`, `GOPATH`, `PNPM_HOME`, `VOLTA_HOME`, `BUN_INSTALL`, and npm prefix variables.

Use the explicit variables below when a tool lives elsewhere. Absolute paths and `~/...` paths are accepted. Run `/reload` after changing the environment of an already-running Pi process.

## Environment variables

No environment variables are required for the standard setup. Use these only when executables or cache files live in non-standard locations.

| Variable | Purpose |
| --- | --- |
| `PI_INLINE_VIZ_CACHE_DIR` | Cache root; defaults to `$XDG_CACHE_HOME/pi-inline-viz` when set, otherwise `~/.cache/pi-inline-viz` |
| `PI_INLINE_VIZ_D2_COMMAND` | Absolute path or command name for D2 |
| `PI_INLINE_VIZ_MMDC_COMMAND` | Absolute path or command name for Mermaid CLI |
| `PI_INLINE_VIZ_CHROME_PATH` | Optional system Chrome/Chromium override; omitted by default |
| `PUPPETEER_CACHE_DIR` | Override the managed browser cache used by `mmdc` |
| `PI_INLINE_VIZ_RATEX_COMMAND` | Absolute path or command name for RaTeX `render-svg` |
| `PI_INLINE_VIZ_RSVG_COMMAND` | Absolute path or command name for `rsvg-convert` |
| `PI_INLINE_VIZ_MAGICK_COMMAND` | Absolute path or command name for ImageMagick 7's `magick` |
| `PI_INLINE_VIZ_DEBUG=1` | Show cache, planner, renderer, and viewport diagnostics in entries |

For example:

```sh
export PI_INLINE_VIZ_CHROME_PATH=/usr/bin/chromium
export PI_INLINE_VIZ_MMDC_COMMAND=$HOME/.local/bin/mmdc
export PI_INLINE_VIZ_RSVG_COMMAND=/opt/librsvg/bin/rsvg-convert
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

At each assistant turn boundary, Pi Inline Viz reads the active Pi theme's resolved ANSI colors. Truecolor and 256-color themes are normalized into a small artifact palette containing background, foreground, accent, muted, and border colors. D2 theme overrides, Mermaid base-theme variables, and the RaTeX formula color all use that palette.

The resolved palette is included in SVG cache identity. Changing Pi's theme affects newly generated artifacts without corrupting or aliasing previous cache entries. Existing transcript images are intentionally not rerendered on theme changes.

Pi-hosted artifacts use the active theme's custom-entry background for raster padding. This avoids a fixed white canvas in dark terminals and keeps light-on-dark formulas readable when `[open/zoom]` opens the PNG in a system image viewer. Host-independent callers may still request `transparent`, `white`, or an explicit six-digit hex background through `RenderOptions`.
