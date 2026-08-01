# Troubleshooting

Start with:

```text
/inline-viz-doctor
```

It checks the actual commands and versions used by the extension, not only configuration values.

## A source block remains text

- Use an explicit `d2` or `mermaid` fenced block.
- Put display formulas between matching `$$` delimiters.
- Inline `$...$` is intentionally not converted into a detached image.
- Run `/reload` if the package was installed while Pi was already running.
- Run `pi config` and confirm the `pi-inline-viz` extension is enabled.

## The entry shows an image path instead of an image

The current terminal did not expose a supported inline-image backend. Direct Kitty, Ghostty, and iTerm2 sessions are supported. Inside tmux, enable `allow-passthrough` and restart the tmux server as described in [Configuration](configuration.md#tmux).

Run with `PI_INLINE_VIZ_DEBUG=1` and inspect the entry's `backend`, `transport`, and `placeholders` values.

## Kitty shows a blank image area

Confirm the same image works outside tmux first. For tmux, verify:

```sh
tmux show-options -gv allow-passthrough
```

It must print `on` or `all`. Old tmux clients may retain stale terminal features; restart the server and attach a new client.

Do not configure a classic cursor-anchored Kitty image command for these entries. Pi Inline Viz uses Unicode placeholders so the image remains tied to transcript cells.

## The tmux image is too large

The display planner caps transcript images by cells and preserves aspect ratio. If an entry was created by an older build, generate it again after `/reload`; historical entries retain their original raster metadata. Debug output should report a bounded viewport and `scale=1` for ordinary transcript images.

## `[open/zoom]` does not open the system viewer

First confirm the terminal recognizes the link with its modifier-click gesture. In Kitty, a generic `file` open-action may launch another Kitty window. Add the `mime image/*` Preview rule from [Configuration](configuration.md#kitty-and-ghostty) before broader rules.

Inside tmux, ensure `#{client_termfeatures}` contains `hyperlinks`. Detach and reattach after changing `terminal-features`.

## Mermaid is missing

Install the pinned compatible CLI:

```sh
npm install -g @mermaid-js/mermaid-cli@11.16.0
```

Mermaid CLI still needs Chrome or Chromium. Set `PI_INLINE_VIZ_CHROME_PATH` when auto-detection cannot find it. Pi Inline Viz does not depend on jsdom, `mermaid-isomorphic`, or Playwright; browser automation remains isolated inside the optional `mmdc` tool.

## Formula rendering is missing

Run:

```text
/inline-viz-install-ratex
/inline-viz-doctor
```

The installer does not run during package installation and never downloads on a normal render. This keeps package installation deterministic and makes the network action explicit.

## Clear generated assets

Stop Pi, then remove only the Pi Inline Viz cache directory:

```sh
rm -rf ~/.cache/pi-inline-viz
```

The cache is fully regenerable. This also removes the managed RaTeX binary, so run `/inline-viz-install-ratex` again afterward. Old caches at `~/.cache/agent-artifact-renderer` and `~/.cache/pi-rich-media` are not used for new assets.
