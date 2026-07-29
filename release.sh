#!/usr/bin/env sh
# Bump the service worker cache version, commit and push.
# Without the bump, installed clients never see the update.
set -e

git rev-parse --is-inside-work-tree >/dev/null 2>&1 || { echo "Not a git repo."; exit 1; }

CUR=$(sed -n "s/^const CACHE = 'arrow-chrono-v\([0-9]*\)';/\1/p" sw.js)
[ -n "$CUR" ] || { echo "Could not find the CACHE line in sw.js."; exit 1; }
NEXT=$((CUR + 1))

sed -i.bak "s/arrow-chrono-v$CUR/arrow-chrono-v$NEXT/" sw.js && rm -f sw.js.bak
echo "Cache v$CUR -> v$NEXT"

git add -A
git commit -m "${1:-Update} (cache v$NEXT)"
git push
echo "Pushed. GitHub Pages usually rebuilds within a minute."
