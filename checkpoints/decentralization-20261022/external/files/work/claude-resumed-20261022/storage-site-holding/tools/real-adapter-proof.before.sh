#!/usr/bin/env bash
# real-adapter-proof.sh: OPTIONAL, ROOT-RUN (not run by the package author: it executes a wasm and a local S3 server).
# The REAL s3-ipfs-adapter (an already-built wasm, copied read-only; no Rust build) holds the reviewed release through its own
# /api/upload route against a loopback MinIO, inside a loopback-only network namespace, and hold-site.mjs verifies it:
# index == manifest, root + child blocks, the complete CAR (fetchRelease) and a byte-identical derived release.
#   ADAPTER_WASM  default work/enclave-apps/s3-ipfs-adapter/target/wasm32-wasip2/release/s3-ipfs-adapter.wasm (built 2026-10-19,
#                 HEAD 50f93d7 era). That build PREDATES the uncommitted probe-path change, so it is EXPECTED to answer
#                 /ipfs/bafkqaaa?format=raw with 400: the script reports that separately and passes only if every other check
#                 passes. A wasm built with src/probe.rs must pass the probe too (set EXPECT_PROBE=200).
#   WASMTIME      default the fleet engine 49.0.0 wrapper (work/site-host-package/engines/fleet-49.0.0-manager.sh)
# Queue: python3 work/claude-test-queue.py --mib 768 --log <pkg>/logs/real1.guard.log -- <pkg>/tools/real-adapter-proof.sh
#   (estimate: MinIO ~150-250 MiB + wasmtime/adapter ~100-200 MiB + node verify ~200 MiB; not measured).
# The API key is a random per-run value generated here (a test credential, not a deployment secret).
set -euo pipefail
if [ -z "${IN_NETNS:-}" ]; then exec unshare -rn env IN_NETNS=1 bash "$0" "$@"; fi
ip link set lo up
P=$(cd "$(dirname "$0")/.." && pwd); W=/home/steven/Documents/Codex/2026-10-18/wo/work
CID=bafybeifkfgxsjz6gnj234fvdkxa37pc4fcevydu6tb55wtidjejfsuxake
REL=${SITE_RELEASE_DIR:-$W/claude-resumed-20261022/site-release-stage/release/$CID}
SRC_WASM=${ADAPTER_WASM:-$W/enclave-apps/s3-ipfs-adapter/target/wasm32-wasip2/release/s3-ipfs-adapter.wasm}
WT=${WASMTIME:-$W/site-host-package/engines/fleet-49.0.0-manager.sh}; EXPECT_PROBE=${EXPECT_PROBE:-400}
R=$P/real-run; [ -e "$R" ] && { echo "$R exists"; exit 1; }; mkdir -p "$R/tmp"; export TMPDIR="$R/tmp"
cp "$SRC_WASM" "$R/adapter.wasm"; sha256sum "$R/adapter.wasm" | tee "$R/adapter.sha256"
AK=holdtest; SK=$(head -c 18 /dev/urandom | base64 | tr -dc A-Za-z0-9); export HOLD_TEST_KEY=$(head -c 18 /dev/urandom | base64 | tr -dc A-Za-z0-9)
S3=http://127.0.0.1:19100; APP=http://127.0.0.1:18500; PIDS=()
trap 'for p in "${PIDS[@]:-}"; do kill "$p" 2>/dev/null || true; done' EXIT
MINIO_ROOT_USER=$AK MINIO_ROOT_PASSWORD=$SK minio server --address 127.0.0.1:19100 "$R/minio" > "$R/minio.log" 2>&1 & PIDS+=($!)
for i in $(seq 1 100); do curl -sf "$S3/minio/health/ready" >/dev/null && break; sleep 0.2; [ "$i" = 100 ] && { echo "minio did not start"; exit 1; }; done
curl -sf -X PUT --aws-sigv4 "aws:amz:us-east-1:s3" --user "$AK:$SK" "$S3/holdbkt/" >/dev/null
# what a production bucket already holds next to the hold
printf 'pinned' | curl -sf -X PUT --aws-sigv4 "aws:amz:us-east-1:s3" --user "$AK:$SK" -T - "$S3/holdbkt/pins/bafkreia4wrrx3ljhfog5r4sa7yd5e3d6bblbvngwyjnmce2q2f3grbu36e" >/dev/null
CONFIG=$(python3 -c 'import json,sys;print(json.dumps({"endpoint":sys.argv[1],"region":"us-east-1","bucket":"holdbkt","credentials":{"accessKeyId":sys.argv[2],"secretAccessKey":"$S3_SK"},"refreshSecs":0,"api_key":"$HOLD_TEST_KEY"}))' "$S3" "$AK")
S3_SK=$SK "$WT" run -Scli -Stcp -Sinherit-network -Sallow-ip-name-lookup --env "ENCLAVE_PORTS=http:8000=18500" --env "ENCLAVE_CONFIG=$CONFIG" \
  --env S3_SK --env HOLD_TEST_KEY "$R/adapter.wasm" > "$R/adapter.log" 2>&1 & PIDS+=($!)
for i in $(seq 1 120); do curl -sf "$APP/ping" >/dev/null && break; sleep 0.5; [ "$i" = 120 ] && { tail -5 "$R/adapter.log"; echo "adapter did not start"; exit 1; }; done
cd "$P"
node tools/hold-site.mjs plan --release "$REL" --out "$R/manifest.json"
node tools/hold-site.mjs upload --adapter "$APP" --api-key-env HOLD_TEST_KEY --manifest "$R/manifest.json" --release "$REL" --execute
for i in $(seq 1 600); do [ "$(curl -sf "$APP/api/status" | python3 -c 'import sys,json;print(json.load(sys.stdin)["state"])')" = ready ] && break; sleep 1
  [ "$i" = 600 ] && { echo "index never ready"; exit 1; }; done
set +e; node tools/hold-site.mjs verify --adapter "$APP" --manifest "$R/manifest.json" --release "$REL" --out "$R/fetched" > "$R/verify.json"; vrc=$?; set -e
node - "$R/verify.json" "$EXPECT_PROBE" <<'JS'
const fs = require("fs"), [f, probe] = process.argv.slice(2), t = fs.readFileSync(f, "utf8"), r = JSON.parse(t.slice(t.indexOf("{"), t.lastIndexOf("}") + 1));
const other = r.failures.filter((x) => !/bafkqaaa/.test(x)), probeOk = String(r.probeGET) === probe && String(r.probeHEAD) === probe;
console.log(JSON.stringify({ index: r.index, rootBlock: r.rootBlock, childBlock: r.childBlock, probe: [r.probeHEAD, r.probeGET], car: r.car, otherFailures: other }, null, 1));
if (other.length || !probeOk) { console.error("REAL-ADAPTER-PROOF-FAILED"); process.exit(1); }
console.log(`REAL-ADAPTER-PROOF-OK (probe answered ${probe} as expected for this wasm)`);
JS
echo "verify rc=$vrc (non-zero only from the probe when EXPECT_PROBE=400)"
