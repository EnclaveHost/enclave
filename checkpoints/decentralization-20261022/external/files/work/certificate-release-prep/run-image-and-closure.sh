#!/bin/bash
# One 1024 MiB queue job (Go compile + igvmfilegen; the closure tests are multiprocess and smaller):
#  A. the minipc control closure = the ACTIVATED 80-file baseline (notes/baseline-installed-closure.json of the relay migration)
#     plus this work's 4 windows/node files: node --check on all 80, import of the 3 side-effect-free changed modules, and
#     the tests that exercise them, run ON that closure (wclosure/, inside an unshared network namespace);
#  B. the Shield-direct guest image from the CURRENT integrated source (image-kit/rebuild-current.sh).
# Exit 0 only if both pass. Scratch on disk.
set -uo pipefail
W="$(cd "$(dirname "$0")" && pwd)"; export TMPDIR="$W/scratch"; rc=0
echo "=== A. minipc control closure"
( set -euo pipefail; cd "$W/wclosure"
  python3 - "$W" <<'PY'
import json,sys,subprocess
W=sys.argv[1]
base=json.load(open(W+'/../windows-local-relay-migration/notes/baseline-installed-closure.json'))
bad=[f['path'] for f in base['files'] if f['path'].endswith(('.mjs','.js')) and subprocess.run(['node','--check',f['path']],capture_output=True).returncode!=0]
assert not bad, 'node --check failed: '+', '.join(bad)
print('[closure] node --check: all', sum(1 for f in base['files'] if f['path'].endswith(('.mjs','.js'))), 'control modules parse')
PY
  node --input-type=module -e 'for (const m of ["./windows/node/shield-sessions.mjs","./windows/node/shield-startup.mjs","./windows/node/shield-verdict.mjs"]) { const x = await import(m); console.log("[closure] import", m, Object.keys(x).length, "exports"); }
    const s = await import("./windows/node/shield-sessions.mjs"); if (typeof s.appZoneTargets !== "function") throw new Error("appZoneTargets missing");'
  unshare -rn bash -c 'ip link set lo up; node --test --test-concurrency=1 --test-reporter=spec test/app-zone-shield.test.mjs test/shield-dns-challenge.test.mjs test/windows-shield-custody-transport.test.mjs test/windows-shield-startup.test.mjs test/windows-node-session.test.mjs test/windows-node-hv-attach.test.mjs'
) || { echo "[closure] FAILED"; rc=1; }
echo "[closure] exit=$rc"
echo "=== B. Shield-direct image from the current integrated source"
c=0; SHIELD_SOURCE_LABEL="main e762a9c5 + integrated working tree copied $(cat "$W/main-copied-at.txt")" bash "$W/image-kit/rebuild-current.sh" || c=$?
echo "[image] exit=$c"; [ $c -eq 0 ] || rc=1
echo "[image-and-closure] exit=$rc"; exit $rc
