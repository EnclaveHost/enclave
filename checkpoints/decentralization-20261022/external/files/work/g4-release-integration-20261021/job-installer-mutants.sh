#!/usr/bin/env bash
cd /home/steven/Documents/Codex/2026-10-18/wo/work/g4-release-integration-20261021/installer
P=/home/steven/Documents/Codex/2026-10-18/wo/work/node-hold-package-20261021/tools/pwsh/pwsh
date -u +%FT%TZ; k=0; n=0
for m in mutants/*.ps1; do n=$((n+1)); timeout 180 $P -NoProfile -NonInteractive -File test-installer.ps1 -Patched "$PWD/$m" -Base "$PWD/install-host.base-0dc5a801.ps1" > /tmp/mut.json 2>&1
  f=$(python3 -c "import json;d=json.load(open('/tmp/mut.json'));print(','.join(x for x,v in d.items() if v!='PASS'))" 2>/dev/null || echo "NO-RESULT(crash)")
  [ -n "$f" ] && { k=$((k+1)); echo "KILLED $(basename $m): $f"; } || echo "SURVIVED $(basename $m)"; done
rm -f /tmp/mut.json; echo "killed $k/$n"; date -u +%FT%TZ
