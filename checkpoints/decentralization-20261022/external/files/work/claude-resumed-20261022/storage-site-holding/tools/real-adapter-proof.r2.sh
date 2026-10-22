#!/usr/bin/env bash
# real-adapter-proof.sh (r2; r1 = real-adapter-proof.before.sh e6895fa8): ONE offline proof, root-authorized, queue 1024.
# The REAL s3-ipfs-adapter (the already-built wasm, copied; no Rust build) holds the reviewed release through its own
# /api/upload route against a loopback MinIO, and hold-site.mjs verifies the hold: 884-file index == manifest, root and child
# blocks, the complete CAR (accepted fetchRelease) and a byte-identical derived release. The bafkqaaa probe is recorded
# SEPARATELY: the 2026-10-19 wasm (132ba32f, enclave-apps 50f93d7) predates src/probe.rs and is expected to answer 400.
#
# Isolation (r2): everything runs inside a PRIVATE user + mount + PID + network namespace
#   timeout --kill-after=30 1200 unshare -Urnmfp --mount-proc --kill-child <this script>
# The inner script is PID 1 of its namespace, the network has loopback only, and /proc shows only the namespace. When it
# ends (normally, by error, or because timeout killed unshare -> --kill-child SIGKILLs it) the kernel kills every remaining
# process of the namespace, so nothing here can signal or outlive into a host process. No process scan of any kind.
# Cleanup order: helpers (adapter, MinIO) are signalled by their own PIDs, then waited for (bounded), and only then are
# temporary files removed. Evidence stays in real-run/: logs, provenance, manifest, verify.json, hash lists. On FAILURE the
# MinIO data, the fetched release and tmp are kept too; on success those large copies are removed after their hashes are listed.
# The S3 secret and the API key are random per-run test values (never a deployment secret); configs carry only $NAME refs.
set -euo pipefail
P=$(cd "$(dirname "$0")/.." && pwd); W=/home/steven/Documents/Codex/2026-10-18/wo/work
CID=bafybeifkfgxsjz6gnj234fvdkxa37pc4fcevydu6tb55wtidjejfsuxake
REL=${SITE_RELEASE_DIR:-$W/claude-resumed-20261022/site-release-stage/release/$CID}
SRC_WASM=${ADAPTER_WASM:-$W/enclave-apps/s3-ipfs-adapter/target/wasm32-wasip2/release/s3-ipfs-adapter.wasm}
WT=${WASMTIME:-$W/site-host-package/engines/fleet-49.0.0-manager.sh}; EXPECT_PROBE=${EXPECT_PROBE:-400}
R=$P/real-run
if [ -z "${IN_PROOF_NS:-}" ]; then
  [ -e "$R" ] && { echo "$R exists: one proof per package state"; exit 1; }
  mkdir -p "$R/tmp"
  set +e; timeout --kill-after=30 1200 unshare -Urnmfp --mount-proc --kill-child env IN_PROOF_NS=1 bash "$0" "$@"; rc=$?; set -e
  echo "proof rc=$rc (124 = outer timeout)"; exit $rc
fi

# ---- inside the namespace (PID 1) ---------------------------------------------------------------------------------------
[ "$$" = 1 ] || { echo "not PID 1 of a private namespace"; exit 1; }
ip link set lo up
export TMPDIR="$R/tmp"; PIDS=(); OK=0
stop_helpers() {
  for p in "${PIDS[@]:-}"; do [ -n "$p" ] && kill -TERM "$p" 2>/dev/null || true; done
  for i in $(seq 1 50); do local alive=0; for p in "${PIDS[@]:-}"; do [ -n "$p" ] && kill -0 "$p" 2>/dev/null && alive=1; done; [ $alive = 0 ] && break; sleep 0.2; done
  for p in "${PIDS[@]:-}"; do [ -n "$p" ] && kill -KILL "$p" 2>/dev/null || true; done
  for p in "${PIDS[@]:-}"; do [ -n "$p" ] && wait "$p" 2>/dev/null || true; done
}
finish() {
  stop_helpers
  if [ "$OK" = 1 ]; then
    (cd "$R" && find fetched -type f -print0 2>/dev/null | sort -z | xargs -0 -r sha256sum) > "$R/fetched.sha256" || true
    rm -rf "$R/minio" "$R/fetched" "$R/tmp"
  else echo "FAILED: evidence kept in $R (minio data, fetched, tmp)"; fi
}
trap finish EXIT
{
  echo "namespace: pid $$, uid $(id -u), net $(ip -o link | awk -F': ' '{print $2}' | tr '\n' ' ')"
  echo "wasm $SRC_WASM"; sha256sum "$SRC_WASM"; stat -c '%s bytes, mtime %y' "$SRC_WASM"
  echo "engine wrapper $WT"; sha256sum "$WT"; "$WT" --version
  echo "engine binary"; sha256sum "$W/site-host-package/fleet-engine/wasmtime"
  echo "minio $(command -v minio)"; sha256sum "$(readlink -f "$(command -v minio)")"; minio --version 2>&1 | head -1
  echo "node $(node --version); curl $(curl --version | head -1 | cut -d' ' -f2)"
  echo "release $REL"; sha256sum "$REL/release.json" "$REL/site.car"
} > "$R/provenance.txt" 2>&1
cp "$SRC_WASM" "$R/adapter.wasm"
AK=holdtest; SK=$(head -c 18 /dev/urandom | base64 | tr -dc A-Za-z0-9); export HOLD_TEST_KEY=$(head -c 18 /dev/urandom | base64 | tr -dc A-Za-z0-9) S3_SK=$SK
S3=http://127.0.0.1:19100; APP=http://127.0.0.1:18500
MINIO_ROOT_USER=$AK MINIO_ROOT_PASSWORD=$SK minio server --address 127.0.0.1:19100 "$R/minio" > "$R/minio.log" 2>&1 & PIDS+=($!)
for i in $(seq 1 100); do curl -sf "$S3/minio/health/ready" >/dev/null && break; sleep 0.2; [ "$i" = 100 ] && { echo "minio did not start"; exit 1; }; done
curl -sf -X PUT --aws-sigv4 "aws:amz:us-east-1:s3" --user "$AK:$SK" "$S3/holdbkt/" >/dev/null
# what a production bucket already holds next to the hold
printf 'pinned' | curl -sf -X PUT --aws-sigv4 "aws:amz:us-east-1:s3" --user "$AK:$SK" -T - "$S3/holdbkt/pins/bafkreia4wrrx3ljhfog5r4sa7yd5e3d6bblbvngwyjnmce2q2f3grbu36e" >/dev/null
CONFIG=$(python3 -c 'import json,sys;print(json.dumps({"endpoint":sys.argv[1],"region":"us-east-1","bucket":"holdbkt","credentials":{"accessKeyId":sys.argv[2],"secretAccessKey":"$S3_SK"},"refreshSecs":0,"api_key":"$HOLD_TEST_KEY"}))' "$S3" "$AK")
"$WT" run -Scli -Stcp -Sinherit-network -Sallow-ip-name-lookup --env "ENCLAVE_PORTS=http:8000=18500" --env "ENCLAVE_CONFIG=$CONFIG" \
  --env S3_SK --env HOLD_TEST_KEY "$R/adapter.wasm" > "$R/adapter.log" 2>&1 & PIDS+=($!)
for i in $(seq 1 120); do curl -sf "$APP/ping" >/dev/null && break; sleep 0.5; [ "$i" = 120 ] && { tail -5 "$R/adapter.log"; echo "adapter did not start"; exit 1; }; done
state() { curl -sf --max-time 10 "$APP/api/status" | python3 -c 'import sys,json;print(json.load(sys.stdin)["state"])'; }
wait_ready() { for i in $(seq 1 600); do [ "$(state)" = ready ] && return 0; sleep 1; done; echo "index never ready"; return 1; }
wait_ready
cd "$P"
timeout 120 node tools/hold-site.mjs plan --release "$REL" --out "$R/manifest.json"
timeout 600 node tools/hold-site.mjs upload --adapter "$APP" --api-key-env HOLD_TEST_KEY --manifest "$R/manifest.json" --release "$REL" --execute > "$R/upload.out" 2>&1 || { cat "$R/upload.out"; exit 1; }
cat "$R/upload.out"
wait_ready
curl -sf "$APP/api/status" > "$R/status-after.json"
set +e; timeout 300 node tools/hold-site.mjs verify --adapter "$APP" --manifest "$R/manifest.json" --release "$REL" --out "$R/fetched" > "$R/verify.json" 2> "$R/verify.err"; vrc=$?; set -e
node - "$R/verify.json" "$EXPECT_PROBE" <<'JS'
const fs = require("fs"), [f, probe] = process.argv.slice(2), t = fs.readFileSync(f, "utf8"), r = JSON.parse(t.slice(t.indexOf("{"), t.lastIndexOf("}") + 1));
const other = r.failures.filter((x) => !/bafkqaaa/.test(x)), probeAsExpected = String(r.probeGET) === probe && String(r.probeHEAD) === probe;
console.log(JSON.stringify({ status: r.status, index: r.index, rootBlock: r.rootBlock, childBlock: r.childBlock, car: r.car, probe: { HEAD: r.probeHEAD, GET: r.probeGET, expected: probe },
  otherFailures: other }, null, 1));
if (other.length || !probeAsExpected || r.index.held !== 884 || r.index.missing || r.index.extra || r.index.wrong) { console.error("REAL-ADAPTER-PROOF-FAILED"); process.exit(1); }
console.log(`REAL-ADAPTER-PROOF-OK: 884-file index, root + child blocks, complete CAR, byte-identical release; probe ${probe} recorded separately (legacy build)`);
JS
echo "verify rc=$vrc (non-zero only from the probe when EXPECT_PROBE=400)"
OK=1
