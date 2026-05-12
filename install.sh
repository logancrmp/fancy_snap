#!/usr/bin/env bash
# Install or upgrade the fancy_snap KWin script, then reload it live.
# Usage: ./install.sh
set -euo pipefail

cd "$(dirname "$0")"
PKG="$PWD/fancy_snap"
MAIN="$PKG/contents/code/main.js"
ID="fancy_snap"

if kpackagetool6 -t KWin/Script -l 2>/dev/null | grep -qx "$ID"; then
    echo "[install.sh] upgrading existing package..."
    kpackagetool6 -t KWin/Script -u "$PKG"
else
    echo "[install.sh] installing fresh..."
    kpackagetool6 -t KWin/Script -i "$PKG"
fi

# Enable the plugin in kwinrc.
kwriteconfig6 --file kwinrc --group Plugins --key "${ID}Enabled" true

QDBUS=$(command -v qdbus-qt6 || command -v qdbus6 || command -v qdbus)
if [ -z "$QDBUS" ]; then
    echo "[install.sh] no qdbus binary found; reload skipped (logout/login or 'Reload' from System Settings)"
    exit 0
fi

# Reload without re-logging-in. The unload is best-effort.
"$QDBUS" org.kde.KWin /Scripting unloadScript "$ID" >/dev/null 2>&1 || true
SCRIPT_ID=$("$QDBUS" org.kde.KWin /Scripting loadScript "$MAIN" "$ID")
"$QDBUS" org.kde.KWin /Scripting start

echo "[install.sh] loaded as script id=$SCRIPT_ID"
echo "[install.sh] tail logs with:"
echo "    journalctl --user -f _COMM=kwin_wayland | grep fancy_snap"
