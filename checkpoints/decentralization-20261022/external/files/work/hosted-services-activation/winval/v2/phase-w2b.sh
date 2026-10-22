#!/bin/bash
# W2 probe rerun with per-step progress marks on minipc (the root and binaries from phase-w2 are reused, verified again).
set -uo pipefail
cd "$(dirname "$0")"; . ./lib2.sh
OUT=results-w2b; rm -rf "$OUT"; mkdir -p "$OUT"
capacity_gate || { echo "NOT STARTED: capacity"; exit 9; }
want="bin\\hostsvc-supervisor.exe=42be59ff5fef8bbc35654ac4240b09fbb71ed0c735ae0bd4da1154c170da37b1;bin\\jobprobe.exe=$(sha256sum < ../dist/jobprobe.exe | cut -c1-64);w2\\supervisor.json=$(sha256sum < upload/w2/supervisor.json | cut -c1-64)"
ps_remote "\$bad = 0; foreach (\$kv in '$want'.Split(';')) { \$k, \$v = \$kv.Split('='); if ((Get-FileHash -Algorithm SHA256 -LiteralPath (Join-Path '$VAL' \$k)).Hash.ToLower() -ne \$v) { 'HASH MISMATCH ' + \$k; \$bad++ } }; if (\$bad) { exit 4 }; 'binaries verified'" || exit 4
run_ps harness/w2-probe.ps1 400 "$OUT/w2-probe.json"; rc=$?
scp -q -r "${SSHOPT[@]}" "minipc:$VAL_SFTP/w2/state/*" "minipc:$VAL_SFTP/w2/harness-progress.log" "$OUT/" 2>/dev/null; ls "$OUT"
ps_remote "@(Get-CimInstance Win32_Process | Where-Object { \$_.ExecutablePath -and \$_.ExecutablePath.StartsWith('$VAL', 'OrdinalIgnoreCase') }).Count.ToString() + ' process(es) of ours left'"
exit $rc
