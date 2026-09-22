#!/usr/bin/env bash
# sync.sh -- ship the Windows consumer node's agent to the box and restart its task.
#   ./sync.sh            sync + restart      ./sync.sh no-restart   sync only
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"; BOX="${BOX:-minipc-zt}"; DEST="C:/Users/claude/vbs/node"
ssh "$BOX" 'New-Item -ItemType Directory -Force -Path C:\Users\claude\vbs\node | Out-Null'
scp -q "$HERE"/agent.mjs "$HERE"/host.mjs "$HERE"/chain.mjs "$HERE"/apprun.mjs "$HERE"/client.mjs \
       "$HERE"/appframe.mjs "$HERE"/apptool.mjs "$HERE"/secrets.mjs \
       "$HERE"/apptls.mjs "$HERE"/appzone.mjs \
       "$HERE"/fetch-cid.py "$HERE"/package.json "$HERE"/install-node.cmd "$BOX:$DEST/"
# the CID verifier is the platform's own (wasm/ipfs_fetch.py), copied rather than forked
scp -q "$HERE"/../../wasm/ipfs_fetch.py "$BOX:$DEST/ipfs_fetch.py"
ssh "$BOX" "cmd /c \"cd /d C:\\Users\\claude\\vbs\\node && npm.cmd install --silent --no-audit --no-fund\"" >/dev/null 2>&1 || true
if [ "${1:-}" != "no-restart" ]; then
  ssh "$BOX" 'schtasks /end /tn EnclaveWindowsNode 2>$null | Out-Null; Stop-Process -Name node,ee-host,shielded-worker,tpmattest -Force -ErrorAction SilentlyContinue; Start-Sleep 2; Remove-Item C:\Users\claude\vbs\node\agent.log -ErrorAction SilentlyContinue; schtasks /run /tn EnclaveWindowsNode' 2>&1 | grep -v "^\*\*" | tail -1
fi
