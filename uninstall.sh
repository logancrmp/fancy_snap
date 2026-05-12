#!/usr/bin/env bash
# Uninstall the fancy_snap KWin script.
# Usage: ./uninstall.sh
set -euo pipefail

ID="fancy_snap"
QDBUS=$(command -v qdbus-qt6 || command -v qdbus6 || command -v qdbus || true)

if [ -n "$QDBUS" ]; then
    "$QDBUS" org.kde.KWin /Scripting unloadScript "$ID" >/dev/null 2>&1 || true
fi

if kpackagetool6 -t KWin/Script -l 2>/dev/null | grep -qx "$ID"; then
    echo "[uninstall.sh] removing package..."
    kpackagetool6 -t KWin/Script -r "$ID"
else
    echo "[uninstall.sh] package not installed; skipping kpackagetool6 -r"
fi

kwriteconfig6 --file kwinrc --group Plugins --key "${ID}Enabled" --delete

if [ -n "$QDBUS" ]; then
    "$QDBUS" org.kde.KWin /KWin reconfigure >/dev/null 2>&1 || true
fi

echo "[uninstall.sh] done. fancy_snap removed and disabled in kwinrc."
