#!/usr/bin/env bash
# e2e-mcp-adapter.sh - M1 of restoring api-mcp-adapter on the per-app SNP backend: the app runs on a config that was
# delivered at RUNTIME and resolved by the guest's own code (package appconfig), with its secrets reaching the
# component only through the environment. QEMU/KVM is NOT involved: this is the runtime half, on the host's wasmtime,
# with SYNTHETIC secrets and a synthetic config of the real deployment's shape.
#
# It checks what M1 must hold before any guest work builds on it:
#   1. the real component (catalog 0x5bca36b5…/0, pinned by sha256) serves MCP tools/list from ENCLAVE_CONFIG;
#   2. the api_key placeholder was resolved and is ENFORCED (no key and a wrong key are 401, the synthetic key is 200);
#   3. no secret value appears in the runtime's argv or its log (ENCLAVE_CONFIG is inherited, `--env NAME` with no value).
#
# Usage: bash isolation/m2/appconfig/e2e-mcp-adapter.sh   (needs go, wasmtime, curl, node; fetches the component once)
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
CID=bafybeie5qxmirydhcjn2g4v23npfhrw3mskaxgdlddijksa7zpt56knq6i
SHA=ca30761416d5b15be66c469f4bc9a375f3178714b94061d6bda01e1678b4d7f2
WORK="$(mktemp -d)"; trap 'kill "${WP:-0}" 2>/dev/null || true; rm -rf "$WORK"' EXIT
cd "$HERE/../"   # the isolation/m2 module

go build -o "$WORK/resolve" ./appconfig/cmd/resolve
curl -sfSL -m 120 -o "$WORK/app.wasm" "https://ipfs.enclave.host/ipfs/$CID"
got="$(sha256sum "$WORK/app.wasm" | cut -c1-64)"
[ "$got" = "$SHA" ] || { echo "FAIL: the component is not the pinned one (sha256 $got)"; exit 1; }

# synthetic secrets: generated here, a 0600 file, never an argument
KEY="synthetic-$(head -c 12 /dev/urandom | od -An -tx1 | tr -d ' \n')"
( umask 077; printf '{"MCP_ADAPTER_API_KEY":"%s","IMAGE_ENDPOINT":"http://127.0.0.1:9","VM_ENDPOINT":"http://127.0.0.1:9","VM_API_KEY":"synthetic-vm","NOTES_ENDPOINT":"http://127.0.0.1:9","NOTES_API_KEY":"synthetic-notes"}' "$KEY" > "$WORK/secrets.json" )

PORT=$((20000 + RANDOM % 20000))
( export ENCLAVE_CONFIG="$("$WORK/resolve" "$HERE/testdata/mcp-adapter-synthetic.json" "$WORK/secrets.json")"
  exec wasmtime serve -S cli -C cache=n --addr "127.0.0.1:$PORT" --env ENCLAVE_CONFIG "$WORK/app.wasm" ) > "$WORK/serve.log" 2>&1 &
WP=$!
for _ in $(seq 1 50); do curl -s -o /dev/null "http://127.0.0.1:$PORT/" && break; sleep 0.2; done

fail=0
mcp() { curl -sS -m 10 -o "$WORK/out.json" -w '%{http_code}' -X POST "http://127.0.0.1:$PORT/mcp" -H 'content-type: application/json' "$@" \
          -d '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}'; }
code="$(mcp -H "X-Api-Key: $KEY")"
tools="$(node -e 'const j=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")); console.log((j.result&&j.result.tools||[]).map(t=>t.name).join(","))' "$WORK/out.json")"
if [ "$code" = 200 ] && [ -n "$tools" ]; then echo "ok   tools/list with the resolved key: 200 [$tools]"; else echo "FAIL tools/list with the key: $code"; fail=1; fi
for k in "" "wrong"; do
  c="$(if [ -n "$k" ]; then mcp -H "X-Api-Key: $k"; else mcp; fi)"
  if [ "$c" = 401 ]; then echo "ok   tools/list with ${k:-no} key: 401"; else echo "FAIL tools/list with ${k:-no} key: $c"; fail=1; fi
done
if tr '\0' ' ' < "/proc/$WP/cmdline" | grep -q "synthetic"; then echo "FAIL a secret value is in the runtime's argv"; fail=1; else echo "ok   no secret value in the runtime's argv"; fi
if grep -q "$KEY\|synthetic-vm\|synthetic-notes" "$WORK/serve.log"; then echo "FAIL a secret value is in the runtime's log"; fail=1; else echo "ok   no secret value in the runtime's log"; fi
[ "$fail" = 0 ] && echo "PASS (QEMU/KVM not involved; runtime half only, synthetic secrets)" || { echo "FAILED"; exit 1; }
