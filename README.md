# fancy_snap

A small KWin script that turns KDE Plasma 6's built-in custom tiles (`Meta+T`) into a FancyZones-style fixed-zone window snapper: the zones you define never drift, mouse-resizing a tiled window detaches it instead of mutating the zone, and the boundary between two tiled windows can be re-dragged iteratively without ever editing the saved layout.

## What problem this solves

KDE Plasma 6 ships custom tiles plus `Shift`+drag to snap, which is almost what you want. The problem: edge-resizing a tiled window updates `Tile.relativeGeometry` in place and persists it to `~/.config/kwinrc` on a 2-second debounce. Over a session of normal use, your zones drift away from their intended ratios. There is no built-in "lock tiles" toggle as of 6.6.

This script intercepts every tile-related event and ensures:

- Window placement always uses the **frozen** zone rect from script load, not whatever drifted state KWin has accumulated.
- Edge-resizing a tiled window detiles it (zone untouched) rather than mutating the zone boundary.
- Coupled-edge resize across two tiles re-flows both windows symmetrically while leaving the zones alone.
- Once two windows are paired via a coupled untile, the script remembers them and lets you keep dragging their shared edge iteratively without re-tiling.

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
