# fancy_snap

A small KWin script that turns KDE Plasma 6's built-in custom tiles (`Meta+T`) into a FancyZones-style fixed-zone window snapper: the zones you define never drift, mouse-resizing a tiled window detaches it instead of mutating the zone, and the boundary between two tiled windows can be re-dragged iteratively without ever editing the saved layout.

## What Is It?

fancy_snap is a small KWin script for KDE Plasma 6 that turns the built-in custom tiles (the ones you set up with Meta+T) into fixed, FancyZones-style snap zones. You define your column layout once as fractions in a single line of the script — `const ZONES = [0.25, 0.5, 0.25]` — and those zones stay exactly where you put them: normally KDE lets you drag a tile boundary and quietly rewrites the saved layout, so your zones creep off-center over a session.

Instead, edge-resizing a tiled window pops it out of its zone and resizes it freely, leaving the zone untouched; if there's a window in the neighbouring zone, both are released together so their shared edge moves as one, and you can keep dragging that edge afterwards. Windows sit flush — edge to edge and top to taskbar, no gaps — and the zones re-assert themselves automatically when anything changes underneath them, like switching virtual desktops, moving your panel, or plugging in a monitor.

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
