// fancy_snap — FancyZones-style fixed-zone snapping for KWin custom tiles.
//
// At a glance:
//   * The snap zones are defined by the ZONES constant below (canonical column
//     fractions, e.g. 0.25 / 0.5 / 0.25), NOT by whatever ratios KWin happens
//     to have drifted to. Zone rects are never cached — they are recomputed on
//     demand from ZONES against the root tile's LIVE geometry, which is the
//     current work area. So a panel move, resolution change or output swap is
//     picked up automatically instead of pinning windows to a stale rect.
//   * KWin's own tile ratios are reset to ZONES whenever they drift, so the
//     drift never reaches ~/.config/kwinrc either.
//   * At resize-start of a tiled window, pre-emptively detiles it and pins
//     its frame to the in-tile rect — KWin would otherwise pop the window
//     back to its pre-snap remembered free-floating geometry mid-drag.
//   * If the dragged edge has a sibling tile across it, also detiles the
//     top-of-stack window in that sibling and writes a mirrored rect on
//     resize-finish. Stack-mates underneath either window stay tiled.
//   * After a coupled untile, the two windows are recorded as a sticky pair
//     so iterative re-drags of their shared edge keep working without ever
//     re-tiling. Pair drops on re-tile, move-out-of-flush, or close.
//   * On any tile-change into a canonical zone, asserts that zone's x/width
//     while leaving KWin's panel-aware y/height alone.
//   * Meta+Shift+T forces a re-assert (rarely needed; the signal hooks below
//     should catch everything on their own).
//
// Tail logs with:
//   journalctl --user -f _COMM=kwin_wayland | grep fancy_snap

const TAG = "[fancy_snap]";
const DEBUG = false;  // when true, also emit win.geom / win.mrChanged / stackProbe / per-leaf-tile dumps

// --- Zone config ------------------------------------------------------------
// THE one place to edit your layout. Column fractions, left -> right; should
// sum to ~1.0. These are authoritative: zone rects are always derived from
// them against the live work area, and any KWin tile layout whose top level is
// a horizontal split into exactly this many columns is reset to these
// fractions whenever it drifts. To change zones, edit this line and run
// ./install.sh.
const ZONES = [0.25, 0.5, 0.25];

// Padding KWin leaves around each zone, in px. 0 = windows sit edge to edge and
// run from the top of the work area to the panel, with no gap between columns.
//
// This is enforced too, because KWin stores padding per (virtual desktop,
// output) — setting it in the Meta+T editor only fixes the desktop you happen
// to be on, which is why gaps come back when you switch desktops or plug in a
// display. Note KWin applies the full value against a screen edge but only half
// of it against a shared edge between two columns, so a padding of 4 shows up
// as a 4px gap at the screen border and a 4px gap between windows.
const GAP = 0;

// Sum of fractions before column i (cumulative left edge as a fraction).
function zoneOffset(i) {
    let acc = 0;
    for (let j = 0; j < i; j++) acc += ZONES[j];
    return acc;
}

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

function rectApproxEqual(a, b) {
    return Math.abs(a.x - b.x) <= 1 && Math.abs(a.y - b.y) <= 1
        && Math.abs(a.width - b.width) <= 1 && Math.abs(a.height - b.height) <= 1;
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
// matching edge while its three other edges stay put.
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

// --- Canonical zone geometry ------------------------------------------------
// Nothing here is cached. Every zone rect is a pure function of ZONES and the
// root tile's live absoluteGeometry (== the current work area, already minus
// panel struts), so a panel move or resolution change needs no invalidation.

// True when the root is a horizontal split into exactly ZONES.length leaves —
// i.e. the layout we own and re-center. Anything else is left alone entirely.
function isCanonicalRoot(root) {
    if (!root) return false;
    const kids = root.tiles || [];
    if (root.layoutDirection !== 1 || kids.length !== ZONES.length) return false;

    for (let i = 0; i < kids.length; i++) {
        if (kids[i].tiles && kids[i].tiles.length > 0) return false;
    }

    return true;
}

// Absolute rect of column i, matching how KWin itself insets a window inside a
// tile: full `pad` against a screen edge, `pad/2` against a shared edge with
// the neighbouring column (measured on KWin 6.7 — a 4px padding yields a 4px
// outer inset and a 2px inner one). Getting this right matters because the
// assert below compares against it; a wrong convention means fighting KWin by
// pad/2 on every single snap.
function canonicalRect(area, i, pad) {
    const x0 = Math.round(area.x + zoneOffset(i) * area.width);
    const x1 = Math.round(area.x + zoneOffset(i + 1) * area.width);
    const padL = (i === 0) ? pad : pad / 2;
    const padR = (i === ZONES.length - 1) ? pad : pad / 2;
    return {
        x: x0 + padL,
        y: area.y + pad,
        width: (x1 - x0) - padL - padR,
        height: area.height - 2 * pad
    };
}

function tilePadding(leaf, root) {
    if (leaf && leaf.padding !== undefined) return leaf.padding;
    if (root && root.padding !== undefined) return root.padding;
    return GAP;
}

// Force GAP onto a tile and everything under it. Returns how many tiles moved.
function resetPadding(tile) {
    let changed = 0;
    try {
        if (tile.padding !== GAP) {
            tile.padding = GAP;
            changed++;
        }
    } catch (e) { dbg("padding.set.failed", e); }
    const kids = tile.tiles || [];
    for (let i = 0; i < kids.length; i++) changed += resetPadding(kids[i]);
    return changed;
}

// If `tile` is one of the canonical columns, return its index, else -1.
function canonicalIndexOf(tile) {
    if (!tile) return -1;
    const root = tile.parent;
    if (!isCanonicalRoot(root)) return -1;
    const kids = root.tiles;
    for (let i = 0; i < kids.length; i++) {
        if (kids[i] === tile) return i;
    }
    return -1;
}

// --- Ratio enforcement ------------------------------------------------------
// Push ZONES back into KWin's own tile ratios so the drift never reaches
// kwinrc. `applying` guards against the re-entrancy this causes: writing
// relativeGeometry synchronously emits layoutModified / relativeGeometryChanged,
// which are hooked below.
let applying = false;

// Fractional slop tolerated before rewriting a ratio. Only there to avoid
// pointless writes, so keep it well under a pixel: 0.0001 is 0.4px on a 4096px
// screen, and far above double-precision noise. (The previous 0.001 was ~4px,
// loose enough to let a visibly off-center column sit there unfixed.)
const RATIO_EPSILON = 0.0001;

function resetLeafRatio(leaf, i) {
    try {
        const rel = { x: zoneOffset(i), y: 0, width: ZONES[i], height: 1 };
        const cur = leaf.relativeGeometry;
        if (cur
            && Math.abs(cur.x - rel.x) <= RATIO_EPSILON
            && Math.abs(cur.y - rel.y) <= RATIO_EPSILON
            && Math.abs(cur.width - rel.width) <= RATIO_EPSILON
            && Math.abs(cur.height - rel.height) <= RATIO_EPSILON) {
            return false;
        }

        leaf.relativeGeometry = rel;
        log("zone.reset", "col=" + i,
            "was=" + (cur ? cur.x.toFixed(4) + "/" + cur.width.toFixed(4) : "?"),
            "->", rel.x + "/" + rel.width);
        return true;
    } catch (e) {
        log("zone.reset.failed", "col=" + i, e);
        return false;
    }
}

// Re-assert ZONES on every screen. Cheap and idempotent: when nothing has
// drifted this is ZONES.length float comparisons per screen and no writes.
function enforceZones(reason) {
    if (applying) return;
    applying = true;
    try {
        const screens = workspace.screens || [];
        for (let s = 0; s < screens.length; s++) {
            let root = null;
            try {
                const tm = workspace.tilingForScreen(screens[s]);
                root = tm ? tm.rootTile : null;
            } catch (e) {
                log("enforce.threw", "screen=" + s, e);
                continue;
            }
            if (!root) continue;

            const name = screens[s].name || ("screen" + s);

            // Padding first, and regardless of layout shape — a gap is a gap
            // whether or not the columns are ours.
            const padded = resetPadding(root);
            if (padded > 0) {
                log("gap.reset", reason, "screen=" + name,
                    "padding -> " + GAP, "tiles=" + padded);
            }

            if (!isCanonicalRoot(root)) {
                // Loud on purpose: silence here is what made the previous
                // freeze-cache failure invisible for days.
                log("enforce.skip", reason, "screen=" + name,
                    "root is not a " + ZONES.length + "-column horizontal split",
                    "(dir=" + root.layoutDirection +
                    " kids=" + (root.tiles ? root.tiles.length : "?") + ")");
                continue;
            }

            let changed = 0;
            const kids = root.tiles;
            for (let i = 0; i < kids.length; i++) {
                if (resetLeafRatio(kids[i], i)) changed++;
            }
            if (changed > 0) {
                log("enforce", reason, "screen=" + name,
                    "area=" + rectStr(root.absoluteGeometry),
                    "cols=" + ZONES.join("/"), "reset=" + changed);
            } else {
                dbg("enforce", reason, "screen=" + name, "already canonical");
            }
        }
    } finally {
        applying = false;
    }
}

// --- Deferred enforcement ---------------------------------------------------
// A panel move (Meta+Shift+G) does not land in one step: plasmashell restores
// the panel thickness and KWin only republishes struts once that has happened,
// so the work area — and therefore every zone rect — is still moving for about
// a second afterwards. Straddle the settle with several passes, matching what
// panel-edge-toggle does for windows.
const SETTLE_DELAYS = [0, 450, 1000];

// Timers must outlive the function that starts them or they are collected
// before firing.
let pendingTimers = [];

function enforceSoon(reason) {
    for (let i = 0; i < pendingTimers.length; i++) {
        try { pendingTimers[i].stop(); } catch (e) { /* already fired */ }
    }
    pendingTimers = [];

    for (let i = 0; i < SETTLE_DELAYS.length; i++) {
        const delay = SETTLE_DELAYS[i];
        if (delay === 0) {
            enforceZones(reason);
            continue;
        }
        const timer = new QTimer();
        timer.singleShot = true;
        timer.interval = delay;
        timer.timeout.connect(function () {
            enforceZones(reason + "+" + delay + "ms");
        });
        timer.start();
        pendingTimers.push(timer);
    }
}

// --- Tiling signal hookup ---------------------------------------------------
// KWin rebuilds the custom-tile tree on output and work-area changes, handing
// out fresh Tile objects each time, so never hold a reference to one: re-resolve
// through tilingForScreen() on demand and re-hook whenever the root is replaced.
const hookedRoots = new Set();
const hookedManagers = new Set();

function hookRoot(root, screenName) {
    if (!root || hookedRoots.has(root)) return;
    hookedRoots.add(root);

    // Work area changed (panel moved / resized / resolution change): the zone
    // rects move with it, and KWin may have rescaled the ratios to fit.
    try {
        root.absoluteGeometryChanged.connect(function () {
            enforceSoon("area-change:" + screenName);
        });
    } catch (e) { dbg("hook absoluteGeometryChanged failed", screenName, e); }

    // Someone edited the layout (Meta+T drag, or KWin resizing a tile).
    try {
        root.layoutModified.connect(function () {
            enforceZones("layout-modified:" + screenName);
        });
    } catch (e) { dbg("hook layoutModified failed", screenName, e); }

    // Tiles added/removed — shape change, may or may not still be canonical.
    try {
        root.childTilesChanged.connect(function () {
            enforceSoon("child-tiles:" + screenName);
        });
    } catch (e) { dbg("hook childTilesChanged failed", screenName, e); }
}

function hookTiling(reason) {
    const screens = workspace.screens || [];
    for (let s = 0; s < screens.length; s++) {
        const name = screens[s].name || ("screen" + s);
        let tm = null;
        try { tm = workspace.tilingForScreen(screens[s]); }
        catch (e) { log("hookTiling threw", name, e); continue; }
        if (!tm) continue;

        if (!hookedManagers.has(tm)) {
            hookedManagers.add(tm);
            try {
                tm.rootTileChanged.connect(function () {
                    log("tiling.rootTileChanged", "screen=" + name);
                    hookTiling("root-replaced:" + name);
                    enforceSoon("root-replaced:" + name);
                });
            } catch (e) { dbg("hook rootTileChanged failed", name, e); }
        }

        hookRoot(tm.rootTile, name);
    }
    dbg("hookTiling", reason, "roots=" + hookedRoots.size);
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
        if (tm.rootTile) walkTile(tm.rootTile, 1, "0");
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
                        "sibTop=" + safeId(sibWindow),
                        sibWindow ? "" : "(sibling zone is empty — nothing to couple to)");
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
            if (!w.tile) return;

            // Re-tile invalidates any sticky pair.
            if (pairing.has(w)) dropPair(w, "re-tiled");

            // Assert the canonical zone, recomputed live — but only along the
            // split axis. tile.absoluteGeometry is the work area, and KWin
            // places the window with its own padding convention; pinning the
            // full rect would fight it on y/height. For our horizontal split
            // that means x/width only, leaving y/height at KWin's live value.
            const i = canonicalIndexOf(w.tile);
            if (i < 0) return;

            const root = w.tile.parent;
            const zone = canonicalRect(root.absoluteGeometry, i, tilePadding(w.tile, root));
            const live = w.frameGeometry;
            const target = { x: zone.x, y: live.y, width: zone.width, height: live.height };
            if (!rectApproxEqual(live, target)) {
                log("zone.assert", "id=" + id, "col=" + i,
                    "live=" + rectStr(live),
                    "target=" + rectStr(target));
                w.frameGeometry = target;
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
    log("loaded.", "zones=" + ZONES.join("/"));

    hookTiling("bootstrap");
    enforceZones("bootstrap");

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
            // KWin keeps a separate tile tree per (output, desktop) pair, so the
            // root we were hooked to is not the one now in effect.
            hookTiling("VD-change");
            enforceZones("VD-change");
            if (DEBUG) dumpAllTiles("currentDesktopChanged");
        });
    } catch (e) { log("hook currentDesktopChanged failed:", e); }

    // Output added/removed/enabled/disabled — new tile managers and roots.
    try {
        workspace.screensChanged.connect(function () {
            log("workspace.screensChanged", "screens=" + (workspace.screens ? workspace.screens.length : "?"));
            hookTiling("screens-change");
            enforceSoon("screens-change");
        });
    } catch (e) { log("hook screensChanged failed:", e); }

    // Resolution / arrangement change. Panel moves surface through the root
    // tile's absoluteGeometryChanged instead, hooked in hookRoot().
    try {
        workspace.virtualScreenGeometryChanged.connect(function () {
            log("workspace.virtualScreenGeometryChanged",
                "geom=" + rectStr(workspace.virtualScreenGeometry));
            hookTiling("vscreen-change");
            enforceSoon("vscreen-change");
        });
    } catch (e) { log("hook virtualScreenGeometryChanged failed:", e); }

    registerShortcut("FancySnapRefreeze", "fancy_snap: re-assert canonical zones",
                     "Meta+Shift+T", function () {
        hookTiling("hotkey");
        enforceSoon("hotkey");
        if (DEBUG) dumpAllTiles("hotkey");
    });

    if (DEBUG) dumpAllTiles("bootstrap");
}

bootstrap();
