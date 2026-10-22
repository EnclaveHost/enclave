#!/bin/bash
# PHASE C (run 3): the harness fixes after run 2 (W1 membership by ActiveProcessLimit, W2 sampled commit, W3 detached
# orphans, W6 runner = the supervisor's node.exe child, not its conhost.exe). Replaces ONLY our fixture runner and our
# runs\ tree under the validation root (prefix-checked), verifies every uploaded byte, then phase-b for the 4 scenarios.
set -uo pipefail
cd "$(dirname "$0")"; . ./lib.sh
echo "== capacity (read-only)"; cap=$(./probe-capacity.sh); echo "$cap"
# 16 GiB must stay free AFTER our largest job (1024 MiB); a busy CPU or a too-small host is reported, never worked around
echo "$cap" | python3 -c 'import json,sys; c=json.load(sys.stdin); ok=c["freeMiB"]>=16384+1024 and c["commitFreeMiB"]>=16384+1024 and (c["cpuLoadPct"] or 0)<70 and not c["ourTasks"]; print("capacity", "OK" if ok else "INSUFFICIENT", c["freeMiB"], c["commitFreeMiB"], c["cpuLoadPct"]); sys.exit(0 if ok else 9)' || { echo "NOT STARTED: capacity"; exit 9; }
cp dist/fake-runner.mjs dist/fixture-world.mjs upload/fixtures/
ps_remote "
\$r = '$VROOT\runs'
if (-not \$r.StartsWith('C:\ProgramData\Enclave\host-services-validation-20261021\', 'OrdinalIgnoreCase')) { 'REFUSED: path'; exit 7 }
if (@(Get-CimInstance Win32_Process | Where-Object { \$_.ExecutablePath -and \$_.ExecutablePath.StartsWith('$VROOT', 'OrdinalIgnoreCase') }).Count) { 'REFUSED: a process of ours is running'; exit 7 }
Remove-Item -LiteralPath \$r -Recurse -Force; New-Item -ItemType Directory -Path \$r | Out-Null; 'runs reset'
" || exit 7
scp -q "${SSHOPT[@]}" upload/fixtures/fake-runner.mjs upload/fixtures/fixture-world.mjs "minipc:$VROOT_SFTP/fixtures/"
scp -q -r "${SSHOPT[@]}" upload/runs/* "minipc:$VROOT_SFTP/runs/"
want=$( { sha256sum upload/fixtures/fake-runner.mjs upload/fixtures/fixture-world.mjs; (cd upload && find runs -type f | sort | xargs sha256sum); } | sed 's#upload/##' | awk '{gsub("/","\\",$2); printf "%s=%s;", $2, $1}')
ps_remote "
\$bad = 0; \$n = 0
foreach (\$kv in '$want'.TrimEnd(';').Split(';')) { \$k, \$v = \$kv.Split('='); \$n++
  if ((Get-FileHash -Algorithm SHA256 -LiteralPath (Join-Path '$VROOT' \$k)).Hash.ToLower() -ne \$v) { 'HASH MISMATCH ' + \$k; \$bad++ } }
'' + \$n + ' uploaded file(s) verified, ' + \$bad + ' mismatch(es)'; if (\$bad) { exit 4 }
" || { echo "REFUSED: upload verification failed; nothing executed"; exit 4; }
SCEN="${SCEN:-w1-procs w3-orphans w2-alloc w6-real}" RES="${RES:-results-run3}" ./phase-b.sh
