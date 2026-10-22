#!/bin/bash
# control-hosted-final joint job 1 (immutable). The composed API + MCP + root-merged shared files, against CURRENT main.
# Run through work/claude-test-queue.py --mib 768 (multiprocess). Every step runs; each step's own output is
# logs/joint-1/<step>.log, its exit code logs/joint-1/<step>.rc; the job fails if any step failed, or if a protected source
# changed during the run (the composed tree's owned files are hashed before and after; the API bundle is hashed AFTER its
# rebuild, which is the one intended change).
set -euo pipefail
F=/home/steven/Documents/Codex/2026-10-18/wo/work/control-hosted-final
L=$F/logs/joint-1
mkdir -p "$L"
cd "$F/tree"
G=/home/steven/Documents/Codex/2026-10-18/wo/work/enclave/.git
OWNED="metal/guest/measured-control.mjs metal/guest/gsup.mjs metal/build-image.mjs relay/state-replica.mjs relay/mcp.js metal/guest/platform-api-role.mjs
 metal/guest/platform-api-verify.mjs metal/guest/mcp-server.bundle.mjs metal/guest/mcp-server.bundle.mjs.manifest.json mcp/server.mjs mcp/hosted-client.mjs
 mcp/hosted-connector.mjs scripts/build-platform-api-guest-bundle.mjs scripts/build-mcp-guest-bundle.mjs test/platform-api-config.test.mjs
 test/platform-api-hosted.test.mjs test/mcp-hosted-control.test.mjs test/metal-measured-control.test.mjs"
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
sha256sum $OWNED > "$L/owned.before"
# the API bundle carries metal/guest/measured-control.mjs (via the verifier): rebuild it against the COMPOSED source
step api-bundle-build node scripts/build-platform-api-guest-bundle.mjs
step api-bundle-check node scripts/build-platform-api-guest-bundle.mjs --check
step api-bundle-pins-composed node -e '
  const fs = require("fs"), c = require("crypto"), sha = (f) => c.createHash("sha256").update(fs.readFileSync(f)).digest("hex");
  const m = JSON.parse(fs.readFileSync("metal/guest/platform-api.bundle.mjs.manifest.json", "utf8"));
  const want = sha("metal/guest/measured-control.mjs");
  if (m.inputs["metal/guest/measured-control.mjs"] !== want) throw new Error("the API bundle manifest does not pin the composed measured-control.mjs");
  if (m.sha256 !== sha("metal/guest/platform-api.bundle.mjs")) throw new Error("manifest sha256 is not the bundle");
  for (const [k, v] of Object.entries(m.inputs)) if (sha(k) !== v) throw new Error("input changed after the build: " + k);
  console.log("API bundle", m.sha256, "pins composed measured-control.mjs", want, "and", Object.keys(m.inputs).length, "inputs as built");'
step mcp-bundle-check node scripts/build-mcp-guest-bundle.mjs --check
step api-config node --test --test-concurrency=1 test/platform-api-config.test.mjs
step api-hosted node --test --test-concurrency=1 test/platform-api-hosted.test.mjs
step mc-compat env GIT_DIR="$G" node --test --test-concurrency=1 test/metal-measured-control.test.mjs
step mcp-hosted node --test --test-concurrency=1 --test-timeout=240000 test/mcp-hosted-control.test.mjs
step composition env CONTROL_COMPOSED_MODULE="$F/tree/metal/guest/measured-control.mjs" node --test --test-concurrency=1 "$F/joint/composition.test.mjs"
step static-launcher-isolation env GIT_DIR="$G" node --test --test-concurrency=1 test/metal-launcher-isolation.test.mjs
step static-lease-gas-conduit env GIT_DIR="$G" node --test --test-concurrency=1 test/metal-lease-gas-conduit.test.mjs
step static-shielded-build env GIT_DIR="$G" node --test --test-concurrency=1 test/metal-shielded-build.test.mjs
step static-shielded-fault-logs env GIT_DIR="$G" node --test --test-concurrency=1 test/shielded-fault-logs.test.mjs
step static-shielded-multi-card env GIT_DIR="$G" node --test --test-concurrency=1 test/shielded-multi-card.test.mjs
step static-tenant-eligibility env GIT_DIR="$G" node --test --test-concurrency=1 test/tenant-compute-eligibility.test.mjs
sha256sum $OWNED > "$L/owned.after"
if ! cmp -s "$L/owned.before" "$L/owned.after"; then echo "PROTECTED SOURCE CHANGED during the run"; diff "$L/owned.before" "$L/owned.after" || true; fail=1; fi
echo "joint-1 fail=$fail"
exit "$fail"
