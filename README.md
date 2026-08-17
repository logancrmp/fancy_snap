# fancy_snap

A small KWin script that turns KDE Plasma 6's built-in custom tiles (`Meta+T`) into a FancyZones-style fixed-zone window snapper: the zones you define never drift, mouse-resizing a tiled window detaches it instead of mutating the zone, and the boundary between two tiled windows can be re-dragged iteratively without ever editing the saved layout.

## What problem this solves

KDE Plasma 6 ships custom tiles plus `Shift`+drag to snap, which is almost what you want. The problem: edge-resizing a tiled window updates `Tile.relativeGeometry` in place and persists it to `~/.config/kwinrc` on a 2-second debounce. Over a session of normal use, your zones drift away from their intended ratios. There is no built-in "lock tiles" toggle as of 6.6.

This script intercepts every tile-related event and ensures:

- Window placement always uses the zone rect **recomputed from `ZONES` against the live work area**, not whatever drifted state KWin has accumulated. Nothing is cached, so a panel move, resolution change or output swap is picked up automatically.
- KWin's own tile ratios are reset to `ZONES` the moment they drift, so the drift never reaches `kwinrc` either.
- Edge-resizing a tiled window detiles it (zone untouched) rather than mutating the zone boundary.
- Coupled-edge resize across two tiles re-flows both windows symmetrically while leaving the zones alone.
- Once two windows are paired via a coupled untile, the script remembers them and lets you keep dragging their shared edge iteratively without re-tiling.

## Configuring your zones

There is one knob — the `ZONES` constant at the top of
`fancy_snap/contents/code/main.js`:

```js
const ZONES = [0.25, 0.5, 0.25];  // column fractions, left -> right; sum ~1.0
```

These fractions are authoritative. When your KWin layout is a horizontal split
into exactly this many columns, fancy_snap **derives the snap zones from
`ZONES` against the current work area, every time it needs them, and resets
KWin's own ratios to match the moment they drift** — so the zones can never
drift off-center. A drifted "center" column snaps back to true center
automatically. Edit the line, save, and run `./install.sh`.

Zones are re-asserted on: script load, virtual-desktop switch, output
add/remove, resolution change, work-area change (i.e. a panel move — including
the `Meta+Shift+G` panel-edge toggle, which is followed for ~1s while the
struts settle), any edit to the tile layout, and `Meta+Shift+T` to force it.

Layouts that don't match `ZONES` (different column count, nested splits, etc.)
are left entirely to KWin, and the script logs `enforce.skip` saying so.

## Install

```bash
./install.sh
```

That puts the package in `~/.local/share/kwin/scripts/fancy_snap/`, enables it in `~/.config/kwinrc` under `[Plugins]`, and loads it into the running KWin session via D-Bus. It auto-loads on every subsequent login.

Tail logs:

```bash
journalctl --user -f _COMM=kwin_wayland | grep fancy_snap
```

## Uninstall

```bash
./uninstall.sh
```

Removes the package files, clears the `kwinrc` enable flag, and unloads from the running session.
