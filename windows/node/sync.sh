#!/usr/bin/env bash
# sync.sh -- ship the Windows consumer node's agent to the box and restart its task.
#   ./sync.sh            sync + restart      ./sync.sh no-restart   sync only
#
# WHAT is shipped is DERIVED, never listed: deploy-files.mjs walks the agent's import graph (static, dynamic and require)
# and REFUSES, naming the file, if an imported module is missing, an npm package is undeclared, or a module outside
# windows/node imports a package the box cannot resolve. The hand-written scp list this replaces had gone stale (no
# hvnode-evidence.mjs, isolation-client.mjs, isolation-lifecycle.mjs or windows/vbslike/) - the relay's named-file trap.
# WHERE: the repository's layout is mirrored under C:/Users/claude with windows/ as vbs/ (windows/node -> vbs/node, as
# before), so every relative import - ../vbslike/..., ../../relay/..., ../../../isolation/... - resolves on the box
# exactly as it does in the tree.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"; REPO="$(cd "$HERE/../.." && pwd)"; BOX="${BOX:-minipc-zt}"; ROOT="C:/Users/claude"
files="$(node "$HERE/deploy-files.mjs")" || { echo "sync.sh: REFUSED by deploy-files.mjs (above); nothing was shipped" >&2; exit 1; }
boxpath() { case "$1" in windows/*) echo "$ROOT/vbs/${1#windows/}" ;; *) echo "$ROOT/$1" ;; esac; }
mk=""; for d in $(for f in $files; do dirname "$(boxpath "$f")"; done | sort -u); do mk="$mk New-Item -ItemType Directory -Force -Path '$d' | Out-Null;"; done
ssh "$BOX" "$mk"
for f in $files; do scp -q "$REPO/$f" "$BOX:$(boxpath "$f")"; done
echo "shipped $(printf '%s\n' $files | wc -l) files from the agent's import graph (deploy-files.mjs)"
DEST="$ROOT/vbs/node"
# the CID verifier is the platform's own (wasm/ipfs_fetch.py), copied rather than forked
scp -q "$REPO"/wasm/ipfs_fetch.py "$BOX:$DEST/ipfs_fetch.py"
# the platform's own shielded probe, so the box can prove its card rather than assert it
ssh "$BOX" 'New-Item -ItemType Directory -Force -Path C:\Users\claude\vbs\probe | Out-Null'
scp -q "$REPO"/metal/guest/shielded.mjs "$REPO"/metal/guest/shielded-probe.mjs "$BOX:$ROOT/vbs/probe/"
ssh "$BOX" "cmd /c \"cd /d C:\\Users\\claude\\vbs\\node && npm.cmd install --silent --no-audit --no-fund\"" >/dev/null 2>&1 || true
if [ "${1:-}" != "no-restart" ]; then
  ssh "$BOX" 'schtasks /end /tn EnclaveWindowsNode 2>$null | Out-Null; Stop-Process -Name node,ee-host,shielded-worker,tpmattest -Force -ErrorAction SilentlyContinue; Start-Sleep 2; Remove-Item C:\Users\claude\vbs\node\agent.log -ErrorAction SilentlyContinue; schtasks /run /tn EnclaveWindowsNode' 2>&1 | grep -v "^\*\*" | tail -1
fi
