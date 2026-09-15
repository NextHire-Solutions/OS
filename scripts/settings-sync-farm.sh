#!/bin/sh
# Mirror src/ into the isolated dev-server copy used by the settings tests.
#
# A second `next dev` cannot share this repo's `.next/dev/lock` with the one
# already running, so the settings work drives its own server on PORT=3370 from
# a copy of the tree. Turbopack refuses a symlinked project, so the copy is
# real and this rsyncs into it; the copy's own watcher then recompiles.
set -e
FARM="${SETTINGS_FARM:?set SETTINGS_FARM to the path of the copy}"
REPO="$(cd "$(dirname "$0")/.." && pwd)"
rsync -a --delete "$REPO/src/" "$FARM/src/"
echo "synced $REPO/src -> $FARM/src"
