#!/bin/bash
# control-bundle-closure job 3 (immutable): the third bundle comparison (shorthand rule) on the bundle closure-1 built (no rebuild),
# and the final input check against CURRENT main at this moment (not the snapshot). Run through work/claude-test-queue.py.
set -euo pipefail
B=/home/steven/Documents/Codex/2026-10-18/wo/work/control-bundle-closure; E=/home/steven/Documents/Codex/2026-10-18/wo/work/enclave
L=$B/logs/closure-3; mkdir -p "$L"; fail=0
step() { local name=$1; shift; set +e; "$@" > "$L/$name.log" 2>&1; local rc=$?; set -e; echo "$rc" > "$L/$name.rc"; echo "step $name rc=$rc"; [ "$rc" -eq 0 ] || fail=1; }
step bundle-diff-3 python3 "$B/jobs/bundle-diff-3.py" "$B/before/metal/guest/platform-api.bundle.mjs" "$B/tree/metal/guest/platform-api.bundle.mjs" "$B/before/metal/guest/platform-api.bundle.mjs.manifest.json" "$B/tree/metal/guest/platform-api.bundle.mjs.manifest.json"
step inputs-equal-current-main node -e '
  const fs = require("fs"), c = require("crypto"), path = require("path"), sha = (f) => c.createHash("sha256").update(fs.readFileSync(f)).digest("hex");
  const E = process.argv[1], m = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
  const drift = [];
  for (const [k, v] of Object.entries(m.inputs)) { const p = path.join(E, k); if (!fs.existsSync(p)) drift.push("MISSING " + k); else if (sha(p) !== v) drift.push("DRIFT " + k); }
  for (const [k, s] of Object.entries(m.sidecars)) if (sha(path.join(E, s.source)) !== s.sha256) drift.push("SIDECAR " + k);
  if (drift.length) { console.log(drift.join("\n")); process.exit(1); }
  console.log("all", Object.keys(m.inputs).length, "inputs and", Object.keys(m.sidecars).length, "sidecar equal CURRENT main now");' "$E" "$B/tree/metal/guest/platform-api.bundle.mjs.manifest.json"
echo "closure-3 fail=$fail"; exit "$fail"
