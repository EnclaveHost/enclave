#!/usr/bin/env bash
# LOCAL (queue 256): installer patch tests in pwsh 7.4.6 (the node-hold package's copy). Nothing Windows is touched.
cd /home/steven/Documents/Codex/2026-10-18/wo/work/g4-release-integration-20261021/installer
P=/home/steven/Documents/Codex/2026-10-18/wo/work/node-hold-package-20261021/tools/pwsh/pwsh
date -u +%FT%TZ; sha256sum install-host.patched.ps1 install-host.base-0dc5a801.ps1 test-installer.ps1 | cut -c1-16,65-
timeout 180 $P -NoProfile -NonInteractive -File test-installer.ps1 -Patched "$PWD/install-host.patched.ps1" -Base "$PWD/install-host.base-0dc5a801.ps1" > ../evidence/installer-test.json 2>&1; echo "pwsh rc=$?"
python3 -c "
import json;d=json.load(open('../evidence/installer-test.json'))
bad={k:v for k,v in d.items() if v!='PASS'};print(len(d)-len(bad),'/',len(d),'PASS');print(json.dumps(bad,indent=1)) if bad else None"
date -u +%FT%TZ
