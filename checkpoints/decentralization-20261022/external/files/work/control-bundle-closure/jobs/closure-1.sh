#!/bin/bash
# control-bundle-closure job 1 (immutable): regenerate ONLY metal/guest/platform-api.bundle.mjs and its manifest from a
# snapshot of CURRENT main (conduit 51984324…, measured-control cef62460…), then narrow acceptance. Run through
# work/claude-test-queue.py --mib 768. Each step: logs/closure-1/<step>.log|.rc; the job fails if any step failed.
set -euo pipefail
B=/home/steven/Documents/Codex/2026-10-18/wo/work/control-bundle-closure
L=$B/logs/closure-1
mkdir -p "$L"
cd "$B/tree"
fail=0
step() {
  local name=$1; shift
  set +e
  "$@" > "$L/$name.log" 2>&1
  local rc=$?
  set -e
  echo "$rc" > "$L/$name.rc"
  echo "step $name rc=$rc"
  if [ "$rc" -ne 0 ]; then fail=1; fi
}
step bundle-build node scripts/build-platform-api-guest-bundle.mjs
step bundle-check node scripts/build-platform-api-guest-bundle.mjs --check
step inputs-equal-tree node -e '
  const fs = require("fs"), c = require("crypto"), sha = (f) => c.createHash("sha256").update(fs.readFileSync(f)).digest("hex");
  const m = JSON.parse(fs.readFileSync("metal/guest/platform-api.bundle.mjs.manifest.json", "utf8"));
  for (const [k, v] of Object.entries(m.inputs)) if (sha(k) !== v) throw new Error("input differs from the tree: " + k);
  for (const [k, s] of Object.entries(m.sidecars)) if (sha(s.source) !== s.sha256) throw new Error("sidecar differs: " + k);
  if (m.inputs["metal/guest/lease-gas-conduit.bundle.mjs"] !== "519843244a06baa3ec9c561439655c255f913a0ead3cca1ede163d21b1c61ead") throw new Error("not the current conduit");
  if (m.inputs["metal/guest/measured-control.mjs"] !== "cef62460deac9080660c7ef15cb2c3d6c26b2a7ac9bed16e9a0de911b82c06e8") throw new Error("not the composed measured-control");
  if (m.sha256 !== sha("metal/guest/platform-api.bundle.mjs")) throw new Error("manifest sha256 is not the bundle");
  console.log("all", Object.keys(m.inputs).length, "inputs and", Object.keys(m.sidecars).length, "sidecar equal the tree; bundle", m.sha256);'
step bundle-diff python3 "$B/jobs/bundle-diff.py" "$B/before/metal/guest/platform-api.bundle.mjs" "$B/tree/metal/guest/platform-api.bundle.mjs" "$B/before/metal/guest/platform-api.bundle.mjs.manifest.json" "$B/tree/metal/guest/platform-api.bundle.mjs.manifest.json"
step api-config node --test --test-concurrency=1 test/platform-api-config.test.mjs
step api-hosted node --test --test-concurrency=1 test/platform-api-hosted.test.mjs
step lease-gas-conduit node --test --test-concurrency=1 test/metal-lease-gas-conduit.test.mjs
echo "closure-1 fail=$fail"
exit "$fail"
