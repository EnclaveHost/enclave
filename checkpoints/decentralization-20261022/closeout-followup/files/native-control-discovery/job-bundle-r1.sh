#!/usr/bin/env bash
# Build the deployable single-file native discovery bundle OUTSIDE the repo (deploy/), list its closure, refuse any bundled
# module with its own "am I main?" check, then smoke-run the bundle offline (loopback-only namespace, port 8187 private to
# the namespace) with a throwaway CA: not configured -> control names 503; configured with dead loopback RPCs -> bounded 503.
# Immutable.
set -euo pipefail
HERE=/home/steven/Documents/Codex/2026-10-18/wo/work/resume-after-checkpoint-20261022/native-control-discovery
REPO="$HERE/repo"; OUT="$HERE/deploy"
export PATH="$HERE/stubs:/usr/local/bin:/usr/bin:/bin"; export TMPDIR="$HERE/tmp"
for t in ssh scp sftp; do [ "$(command -v "$t")" = "$HERE/stubs/$t" ] || { echo "[job] FAIL: $t not stubbed"; exit 90; }; done
echo "[job] ssh/scp/sftp -> denial stubs"
cd "$REPO"
rm -f "$OUT/native-discovery.bundle.mjs" "$OUT/native-discovery.meta.json"
node_modules/.bin/esbuild relay/native-discovery.mjs --bundle --platform=node --format=esm --target=node22 --legal-comments=none \
  --banner:js="import{createRequire as __cr}from'module';const require=__cr(import.meta.url);" \
  --metafile="$OUT/native-discovery.meta.json" --outfile="$OUT/native-discovery.bundle.mjs" --log-level=warning
node -e '
const m=require(process.argv[1]),fs=require("fs");const ins=Object.keys(m.inputs).sort();
const mains=ins.filter(f=>!f.includes("node_modules")&&f!=="relay/native-discovery.mjs"&&/process\.argv\[1\]/.test(fs.readFileSync(f,"utf8")));
const own=ins.filter(f=>!f.includes("node_modules"));console.log("[job] closure: "+ins.length+" inputs, repo modules: "+own.join(" "));
if(mains.length){console.log("[job] FAIL: bundled modules with a main check: "+mains.join(" "));process.exit(94);}
' "$OUT/native-discovery.meta.json"
sha256sum "$OUT/native-discovery.bundle.mjs"
openssl req -x509 -newkey ec -pkeyopt ec_paramgen_curve:P-256 -nodes -keyout "$TMPDIR/smoke-ca.key" -out "$TMPDIR/smoke-ca.pem" -subj /CN=smoke -days 1 2>/dev/null
cd "$OUT"
set +e
unshare -r -n bash -c '
set -euo pipefail; ip link set lo up
smoke() { local tag="$1"; shift
  env -i PATH="$PATH" NATIVE_CA_CERT="$TMPDIR/smoke-ca.pem" "$@" /usr/bin/node native-discovery.bundle.mjs > "$TMPDIR/smoke-$tag.log" 2>&1 & local pid=$!
  for i in $(seq 1 50); do curl -s -o /dev/null http://127.0.0.1:8187/native/status && break; sleep 0.1; done
  local st; st=$(curl -s -w " %{http_code}" http://127.0.0.1:8187/native/status); echo "[smoke:$tag] status: $st"
  local t0=$(date +%s%N); local r; r=$(curl -s --max-time 30 -w " %{http_code}" "http://127.0.0.1:8187/native/resolve?name=api.enclavehost.eth"); local ms=$(( ($(date +%s%N)-t0)/1000000 ))
  echo "[smoke:$tag] api: $r (${ms} ms)"
  local u; u=$(curl -s -w " %{http_code}" "http://127.0.0.1:8187/native/resolve?name=other.enclavehost.eth"); echo "[smoke:$tag] unknown: $u"
  kill $pid; wait $pid 2>/dev/null || true; sed "s/^/[smoke:$tag] log: /" "$TMPDIR/smoke-$tag.log" | head -8
  case "$r" in *control_route_unavailable*503|*route_discovery_unavailable*503) ;; *) echo "[smoke:$tag] FAIL: expected an explicit 503"; exit 95;; esac
  case "$u" in *no_current_route*404) ;; *) echo "[smoke:$tag] FAIL: unknown name"; exit 96;; esac
  case "$r" in *134.199.235.187*|*134.209.248.172*|*165.245.191.129*|*146.190.246.39*) echo "[smoke:$tag] FAIL: fleet address"; exit 97;; esac
}
smoke unconfigured
smoke configured NATIVE_CONTROL_SERVICE_INDEX=0x54dEcb43DE6f9Cc953Ba582B190b56C5a60B5941@0x696944fed82d8b312e4db3ab89069240f8063a6a49b47e8a322804cdfd127898 \
  NATIVE_CONTROL_RPCS=http://127.0.0.1:9,http://127.0.0.1:10 NATIVE_CONTROL_EXCLUDE=134.199.235.187,134.209.248.172,165.245.191.129,146.190.246.39
'
rc=$?
set -e
echo "[job] smoke exit=$rc"
exit "$rc"
