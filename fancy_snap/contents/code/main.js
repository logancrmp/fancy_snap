// fancy_snap — FancyZones-style fixed-zone snapping for KWin custom tiles.
//
// At a glance:
//   * On load (and on virtual-desktop switch), snapshots every leaf tile's
//     geometry into a frozen-layout cache keyed by Tile JS-object identity.
//   * At resize-start of a tiled window, pre-emptively detiles it and pins
//     its frame to the in-tile rect — KWin would otherwise pop the window
//     back to its pre-snap remembered free-floating geometry mid-drag.
//   * If the dragged edge has a sibling tile across it, also detiles the
//     top-of-stack window in that sibling and writes a mirrored rect on
//     resize-finish. Stack-mates underneath either window stay tiled.
//   * After a coupled untile, the two windows are recorded as a sticky pair
//     so iterative re-drags of their shared edge keep working without ever
//     re-tiling. Pair drops on re-tile, move-out-of-flush, or close.
//   * On any tile-change with a non-null tile, asserts the frozen rect's
//     split-axis dimensions while leaving KWin's panel-aware perpendicular
//     axis alone.
//   * Meta+Shift+T clears the freeze cache and re-snapshots the current live
//     layout (run after editing zones via Meta+T).
//
// Tail logs with:
//   journalctl --user -f _COMM=kwin_wayland | grep fancy_snap

const TAG = "[fancy_snap]";
const DEBUG = false;  // when true, also emit win.geom / win.mrChanged / stackProbe / per-leaf-tile dumps

function log() {
    const parts = [TAG];
    for (let i = 0; i < arguments.length; i++) parts.push(arguments[i]);
    console.info(parts.join(" "));
}

function dbg() {
    if (!DEBUG) return;
    const parts = [TAG];
    for (let i = 0; i < arguments.length; i++) parts.push(arguments[i]);
    console.info(parts.join(" "));
}

function rectStr(r) {
    if (!r) return "null";
    return "{" + r.x + "," + r.y + " " + r.width + "x" + r.height + "}";
}

function safeId(obj) {
    if (!obj) return "null";
    try { return obj.internalId || obj.windowId || obj.resourceClass || "?"; }
    catch (e) { return "?"; }
}

// --- Stacking-order helpers ------------------------------------------------
// `workspace.stackingOrder` is bottom-to-top. The top-of-stack window inside
// a tile is the one whose frame straddles the dragged border, so that's the
// one we untile + mirror on a coupled resize.
function topOfStackInTile(tile) {
    if (!tile || !tile.windows || tile.windows.length === 0) return null;
    if (tile.windows.length === 1) return tile.windows[0];
    let order = [];
    try { order = workspace.stackingOrder || []; }
    catch (e) { log("stackingOrder threw:", e); return tile.windows[0]; }
    // Walk top→bottom; first window of `order` that's also in tile.windows wins.
    for (let i = order.length - 1; i >= 0; i--) {
        const w = order[i];
        for (let j = 0; j < tile.windows.length; j++) {
            if (tile.windows[j] === w) return w;
        }
    }
    return tile.windows[0];
}

function dumpTileStack(tile, label) {
    if (!tile || !tile.windows) return;
    const ids = [];
    for (let i = 0; i < tile.windows.length; i++) ids.push(safeId(tile.windows[i]));
    const top = topOfStackInTile(tile);
    log("stackProbe", label, "tile.windows=[" + ids.join(",") + "]",
        "topOfStack=" + safeId(top));
}

// --- Mirror rect ------------------------------------------------------------
// Given the sibling's frozen rect and the grabbed window's new rect, compute
// the sibling's new rect so its shared edge follows the grabbed window's
// matching edge while its three other edges stay at the frozen-zone values.
function mirrorRect(siblingFrozen, edge, grabbedNew) {
    const gR = grabbedNew.x + grabbedNew.width;
    const gB = grabbedNew.y + grabbedNew.height;
    const sR = siblingFrozen.x + siblingFrozen.width;
    const sB = siblingFrozen.y + siblingFrozen.height;
    switch (edge) {
        case "right":  // sibling is to the right; its left edge follows grabbed's new right
            return { x: gR, y: siblingFrozen.y, width: Math.max(1, sR - gR), height: siblingFrozen.height };
        case "left":   // sibling is to the left; its right edge follows grabbed's new left
            return { x: siblingFrozen.x, y: siblingFrozen.y, width: Math.max(1, grabbedNew.x - siblingFrozen.x), height: siblingFrozen.height };
        case "bottom": // sibling is below; its top edge follows grabbed's new bottom
            return { x: siblingFrozen.x, y: gB, width: siblingFrozen.width, height: Math.max(1, sB - gB) };
        case "top":    // sibling is above; its bottom edge follows grabbed's new top
            return { x: siblingFrozen.x, y: siblingFrozen.y, width: siblingFrozen.width, height: Math.max(1, grabbedNew.y - siblingFrozen.y) };
    }
    return null;
}

// --- Frozen layout cache ---------------------------------------------------
// Map<Tile, {x, y, width, height}>. Tile JS object identity is stable across
// reads, so the Tile itself is the cache key. Populated additively at script
// load and on virtual-desktop switch; never overwrites an existing entry, so
// the original frozen rect survives any drift in KWin's live tile geometry.
const frozenLayout = new Map();

function rectClone(r) {
    return { x: r.x, y: r.y, width: r.width, height: r.height };
}

function rectApproxEqual(a, b) {
    return Math.abs(a.x - b.x) <= 1 && Math.abs(a.y - b.y) <= 1
        && Math.abs(a.width - b.width) <= 1 && Math.abs(a.height - b.height) <= 1;
}

function freezeTree(t) {
    if (!t) return;
    const kids = t.tiles || [];
    if (kids.length === 0) {
        if (!frozenLayout.has(t)) frozenLayout.set(t, rectClone(t.absoluteGeometry));
        return;
    }
    for (let i = 0; i < kids.length; i++) freezeTree(kids[i]);
}

function freezeCurrentVD(reason) {
    const screens = workspace.screens || [];
    const before = frozenLayout.size;
    for (let i = 0; i < screens.length; i++) {
        try {
            const tm = workspace.tilingForScreen(screens[i]);
            if (tm && tm.rootTile) freezeTree(tm.rootTile);
        } catch (e) { log("freezeCurrentVD threw on screen", i, e); }
    }
    log("freeze", reason, "leaves=" + frozenLayout.size, "added=" + (frozenLayout.size - before));
}

// --- Pending coupled-resize state ------------------------------------------
const pendingCoupled = new Map();  // grabbed window -> { sibWindow, edge, siblingFrozen }

// --- Sticky pair state -----------------------------------------------------
// pairing.get(A) = { partner: B, edge: "right" } means A's `right` edge is
// paired with B's `left` edge. Registered after a successful coupled untile
// + mirror so that subsequent resizes of either window's shared edge stay
// coupled even though both windows are now free-floating. Dropped when
// either window is re-tiled, moved out-of-flush, or closed.
const pairing = new Map();
const FLUSH_TOL = 12;  // px — edge-flush tolerance

function oppositeEdge(e) {
    if (e === "left")   return "right";
    if (e === "right")  return "left";
    if (e === "top")    return "bottom";
    if (e === "bottom") return "top";
    return null;
}

function edgePos(rect, edge) {
    if (edge === "left")   return rect.x;
    if (edge === "right")  return rect.x + rect.width;
    if (edge === "top")    return rect.y;
    if (edge === "bottom") return rect.y + rect.height;
    return NaN;
}

function isFlush(a, b, aEdge) {
    try {
        const aPos = edgePos(a.frameGeometry, aEdge);
        const bPos = edgePos(b.frameGeometry, oppositeEdge(aEdge));
        return Math.abs(aPos - bPos) <= FLUSH_TOL;
    } catch (e) { return false; }
}

function setPair(a, b, edge) {
    pairing.set(a, { partner: b, edge: edge });
    pairing.set(b, { partner: a, edge: oppositeEdge(edge) });
    log("pair.set", "a=" + safeId(a), "b=" + safeId(b), "edge=" + edge);
}

function dropPair(w, reason) {
    const p = pairing.get(w);
    if (!p) return;
    pairing.delete(w);
    pairing.delete(p.partner);
    log("pair.dropped", "a=" + safeId(w), "b=" + safeId(p.partner), "reason=" + reason);
}

// --- Edge detection ---------------------------------------------------------
function edgeFromCursor(cursor, frame) {
    // Returns "left" | "right" | "top" | "bottom" — whichever frame edge the
    // cursor is closest to at gesture start. Slight overshoot past the frame
    // (e.g. cursor 8px outside the right edge) is normal for the grab band.
    const dLeft   = Math.abs(cursor.x - frame.x);
    const dRight  = Math.abs(cursor.x - (frame.x + frame.width));
    const dTop    = Math.abs(cursor.y - frame.y);
    const dBottom = Math.abs(cursor.y - (frame.y + frame.height));
    const min = Math.min(dLeft, dRight, dTop, dBottom);
    if (min === dLeft)   return "left";
    if (min === dRight)  return "right";
    if (min === dTop)    return "top";
    return "bottom";
}

// --- Sibling traversal ------------------------------------------------------
// Walk up the tile tree to find the leaf tile adjacent across `edge`.
function siblingAcrossEdge(tile, edge) {
    const horizontal = (edge === "left" || edge === "right");
    const dir = (edge === "right" || edge === "bottom") ? +1 : -1;
    let cur = tile;
    while (cur && cur.parent) {
        const p = cur.parent;
        // KWin's Tile.layoutDirection is an int: 1 = horizontal, 2 = vertical.
        const pIsHorizontal = (p.layoutDirection === 1);
        if (pIsHorizontal === horizontal) {
            const kids = p.tiles || [];
            const i = kids.indexOf(cur);
            const j = i + dir;
            if (j >= 0 && j < kids.length) {
                let s = kids[j];
                while (s.tiles && s.tiles.length > 0) {
                    // Descend into the sub-tile nearest the shared edge.
                    const subDir = dir > 0 ? 0 : s.tiles.length - 1;
                    s = s.tiles[subDir];
                }
                return s;
            }
        }
        cur = p;
    }
    return null;  // edge is against the screen, no sibling
}

// --- Debug helpers (only used when DEBUG=true) -----------------------------
function probeTileIdentity(rootTile, label) {
    if (!rootTile) { log("identity", label, "rootTile=null"); return; }
    const a = rootTile.tiles && rootTile.tiles[0];
    const b = rootTile.tiles && rootTile.tiles[0];
    log("identity", label,
        "rootTile.tiles[0] === rootTile.tiles[0]:", (a === b),
        "len:", (rootTile.tiles ? rootTile.tiles.length : "n/a"));
}

function walkTile(tile, depth, indexPath) {
    const indent = "  ".repeat(depth);
    const kids = tile.tiles || [];
    const leaf = kids.length === 0;
    log("tile", indent + indexPath,
        "leaf=" + leaf,
        "dir=" + (tile.layoutDirection !== undefined ? tile.layoutDirection : "?"),
        "abs=" + rectStr(tile.absoluteGeometry),
        "wins=" + (tile.windows ? tile.windows.length : "?"));
    for (let i = 0; i < kids.length; i++) {
        walkTile(kids[i], depth + 1, indexPath + "." + i);
    }
}

function dumpAllTiles(reason) {
    log("==== dumpAllTiles (" + reason + ") ====");
    const screens = workspace.screens || [];
    log("screens.count=" + screens.length,
        "activeScreen.name=" + (workspace.activeScreen ? workspace.activeScreen.name : "?"),
        "currentDesktop=" + (workspace.currentDesktop ? workspace.currentDesktop.name : "?"),
        "desktops.count=" + (workspace.desktops ? workspace.desktops.length : "?"));
    for (let i = 0; i < screens.length; i++) {
        const o = screens[i];
        log("screen[" + i + "] name=" + o.name,
            "geom=" + rectStr(o.geometry));
        let tm = null;
        try { tm = workspace.tilingForScreen(o); }
        catch (e) { log("tilingForScreen threw:", e); continue; }
        if (!tm) { log("tilingForScreen returned null"); continue; }
        const rt = tm.rootTile;
        probeTileIdentity(rt, "screen=" + o.name);
        if (rt) walkTile(rt, 1, "0");
    }
    log("==== end dump ====");
}

// --- Per-window hookup ------------------------------------------------------
function hookWindow(w) {
    if (!w) return;
    const id = safeId(w);

    function snapshot(evt) {
        return [
            "id=" + id,
            "evt=" + evt,
            "move=" + w.move,
            "resize=" + w.resize,
            "tile=" + (w.tile ? "T" : "null"),
            "frame=" + rectStr(w.frameGeometry),
            "cursor=" + rectStr({x: workspace.cursorPos.x, y: workspace.cursorPos.y, width: 0, height: 0}),
            "output=" + (w.output ? w.output.name : "?"),
            "desktop=" + (w.desktops && w.desktops[0] ? w.desktops[0].name : "?")
        ].join(" ");
    }

    try {
        w.interactiveMoveResizeStarted.connect(function () {
            log("win.start", snapshot("start"));

            // Sticky-pair branch: free-floating window, formerly paired with a
            // partner across a still-flush shared edge — re-runs the coupled
            // resize without anyone needing to be tiled.
            if (w.resize && !w.tile && pairing.has(w)) {
                const p = pairing.get(w);
                const cursor = workspace.cursorPos;
                const edge = edgeFromCursor(cursor, w.frameGeometry);
                if (edge !== p.edge) {
                    log("pair.notPairedEdge", "id=" + id, "grabbed=" + edge, "paired=" + p.edge);
                } else if (!isFlush(w, p.partner, edge)) {
                    log("pair.notFlush", "id=" + id);
                    dropPair(w, "not-flush-at-start");
                } else {
                    const partner = p.partner;
                    log("pair.coupled", "id=" + id, "partner=" + safeId(partner), "edge=" + edge);
                    const fg = w.frameGeometry;
                    w.frameGeometry = { x: fg.x, y: fg.y, width: fg.width, height: fg.height };  // re-assert
                    const pg = partner.frameGeometry;
                    const partnerFrozen = { x: pg.x, y: pg.y, width: pg.width, height: pg.height };
                    pendingCoupled.set(w, { sibWindow: partner, edge: edge, siblingFrozen: partnerFrozen });
                    return;  // skip tiled-resize branch below
                }
            }

            // Tiled-resize branch: pre-emptive untile + sibling untile.
            if (w.resize && w.tile) {
                const tile = w.tile;
                const cursor = workspace.cursorPos;
                const edge = edgeFromCursor(cursor, w.frameGeometry);
                log("tiled.detect", "id=" + id, "edge=" + edge,
                    "tile.abs=" + rectStr(tile.absoluteGeometry),
                    "tile.parent.layoutDirection=" + (tile.parent ? tile.parent.layoutDirection : "no-parent"));
                if (DEBUG) dumpTileStack(tile, "grabbedTile");

                const sib = siblingAcrossEdge(tile, edge);
                let sibWindow = null;
                let siblingFrozen = null;
                if (sib) {
                    if (DEBUG) dumpTileStack(sib, "siblingTile");
                    sibWindow = topOfStackInTile(sib);
                    if (sibWindow) {
                        // Snapshot the sibling window's actual frame (panel-aware) rather
                        // than tile.absoluteGeometry, which includes panel-blocked space
                        // and would over-stretch the window when used in the mirror calc.
                        const sf = sibWindow.frameGeometry;
                        siblingFrozen = { x: sf.x, y: sf.y, width: sf.width, height: sf.height };
                    }
                    log("tiled.sibling", "id=" + id,
                        "sibFrozen=" + rectStr(siblingFrozen),
                        "sibTop=" + safeId(sibWindow));
                } else {
                    log("tiled.sibling", "id=" + id, "edge=" + edge, "none (screen edge)");
                }

                // Snapshot the in-tile frame so we can pin to it after the untile,
                // overriding KWin's "pop back to remembered free-floating geometry" reflex.
                const fg = w.frameGeometry;
                const pinned = { x: fg.x, y: fg.y, width: fg.width, height: fg.height };
                log("tiled.detile", "id=" + id, "setting window.tile = null pinned=" + rectStr(pinned));
                w.tile = null;
                w.frameGeometry = { x: pinned.x, y: pinned.y, width: pinned.width, height: pinned.height };
                log("tiled.afterDetile", snapshot("afterDetile"));

                // Symmetric untile of the sibling top-of-stack window. Anything stacked
                // underneath either window remains tiled to its zone.
                if (sibWindow && siblingFrozen) {
                    const sg = sibWindow.frameGeometry;
                    const sPinned = { x: sg.x, y: sg.y, width: sg.width, height: sg.height };
                    log("tiled.sibDetile", "sibId=" + safeId(sibWindow), "sibPinned=" + rectStr(sPinned));
                    sibWindow.tile = null;
                    sibWindow.frameGeometry = sPinned;
                    pendingCoupled.set(w, { sibWindow: sibWindow, edge: edge, siblingFrozen: siblingFrozen });
                    log("tiled.pendingStored", "grabId=" + id, "sibId=" + safeId(sibWindow), "edge=" + edge);
                }
            }
        });
    } catch (e) { log("hook start failed for", id, e); }

    try {
        w.interactiveMoveResizeFinished.connect(function () {
            log("win.finish", snapshot("finish"));
            const pending = pendingCoupled.get(w);
            if (pending) {
                pendingCoupled.delete(w);
                const grabbedNew = w.frameGeometry;
                const mirror = mirrorRect(pending.siblingFrozen, pending.edge, grabbedNew);
                log("mirror.compute",
                    "grabbedNew=" + rectStr(grabbedNew),
                    "sibFrozen=" + rectStr(pending.siblingFrozen),
                    "edge=" + pending.edge,
                    "mirror=" + rectStr(mirror));
                if (mirror && pending.sibWindow) {
                    pending.sibWindow.frameGeometry = mirror;
                    log("mirror.applied", "sibId=" + safeId(pending.sibWindow));
                    // Register the sticky pair so iterative border drags work without
                    // requiring re-tile in between.
                    setPair(w, pending.sibWindow, pending.edge);
                }
            } else if (pairing.has(w)) {
                // Plain move-finish on a paired free-floating window — check flushness.
                const pp = pairing.get(w);
                if (!isFlush(w, pp.partner, pp.edge)) {
                    dropPair(w, "moved-out-of-flush");
                }
            }
        });
    } catch (e) { log("hook finish failed for", id, e); }

    try {
        w.moveResizedChanged.connect(function () {
            dbg("win.mrChanged", snapshot("mrChanged"));
        });
    } catch (e) { log("hook moveResizedChanged failed for", id, e); }

    try {
        w.tileChanged.connect(function () {
            log("win.tileChanged", snapshot("tileChanged"),
                "tile.abs=" + (w.tile ? rectStr(w.tile.absoluteGeometry) : "null"));
            if (w.tile) {
                // Re-tile invalidates any sticky pair.
                if (pairing.has(w)) dropPair(w, "re-tiled");
                // Assert the frozen rect, but only along the axis the split owns.
                // tile.absoluteGeometry includes panel-blocked space; KWin places the
                // window at the panel-adjusted size. Enforcing the full frozen rect
                // would push the window over the panel. For a horizontal-split parent,
                // pin only x/width; for vertical, only y/height. The other axis stays
                // at KWin's panel-aware live value.
                const frozen = frozenLayout.get(w.tile);
                if (frozen) {
                    const live = w.frameGeometry;
                    const target = { x: live.x, y: live.y, width: live.width, height: live.height };
                    const p = w.tile.parent;
                    if (p && p.layoutDirection === 1) {
                        target.x = frozen.x;
                        target.width = frozen.width;
                    } else if (p && p.layoutDirection === 2) {
                        target.y = frozen.y;
                        target.height = frozen.height;
                    }
                    if (!rectApproxEqual(live, target)) {
                        log("freeze.assert", "id=" + id,
                            "live=" + rectStr(live),
                            "target=" + rectStr(target));
                        w.frameGeometry = target;
                    }
                }
            }
        });
    } catch (e) { log("hook tileChanged failed for", id, e); }

    try {
        w.frameGeometryChanged.connect(function () {
            // High-frequency; off unless DEBUG.
            if (w.tile) dbg("win.geom", snapshot("frameGeom"));
        });
    } catch (e) { /* not all windows expose this; ignore */ }
}

// --- Bootstrapping ----------------------------------------------------------
function bootstrap() {
    log("loaded.");
    freezeCurrentVD("bootstrap");

    try {
        const list = workspace.windowList ? workspace.windowList() : (workspace.clientList ? workspace.clientList() : []);
        log("existing windows:", list.length);
        for (let i = 0; i < list.length; i++) hookWindow(list[i]);
    } catch (e) { log("windowList failed:", e); }

    workspace.windowAdded.connect(function (w) {
        log("workspace.windowAdded id=" + safeId(w));
        hookWindow(w);
    });

    try {
        workspace.windowRemoved.connect(function (w) {
            log("workspace.windowRemoved id=" + safeId(w));
            if (pairing.has(w)) dropPair(w, "window-removed");
            pendingCoupled.delete(w);
        });
    } catch (e) { log("hook windowRemoved failed:", e); }

    try {
        workspace.currentDesktopChanged.connect(function () {
            log("workspace.currentDesktopChanged ->", workspace.currentDesktop ? workspace.currentDesktop.name : "?");
            freezeCurrentVD("VD-change");
            if (DEBUG) dumpAllTiles("currentDesktopChanged");
        });
    } catch (e) { log("hook currentDesktopChanged failed:", e); }

    registerShortcut("FancySnapRefreeze", "fancy_snap: re-freeze current tile layout as zones",
                     "Meta+Shift+T", function () {
        const before = frozenLayout.size;
        frozenLayout.clear();
        freezeCurrentVD("refreeze-hotkey");
        log("refreeze.done", "cleared=" + before, "now=" + frozenLayout.size);
        if (DEBUG) dumpAllTiles("refreeze-hotkey");
    });

    if (DEBUG) dumpAllTiles("bootstrap");
}

bootstrap();
