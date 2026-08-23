#!/usr/bin/env bash
# nan-pin-adapter-wasm.sh — keep the s3-ipfs-adapter's OWN wasm pinned in nan's
# local kubo, automatically, so the gateway's bootstrap escape is always current.
#
# Why: ipfs.enclave.host is served by the s3-ipfs-adapter — a fleet TENANT.
# Every app provision (the adapter's own included) prefetches from that host, so
# with the adapter down and its wasm not in a box's cache, the fleet deadlocks
# (2026-08-23: every deployment queued on "prefetch … 502" until a hand-pinned
# kubo shim broke the loop). Caddy's ipfs.enclave.host block falls back to the
# local kubo gateway (127.0.0.1:8080, Gateway.NoFetch) for /ipfs/* when the
# tenant answers 502/503/504 or is unreachable — this script is what keeps the
# CID that matters present there. Old versions stay pinned (rollback safety);
# kubo never GCs pins.
#
# Runs hourly via enclave-pin-adapter.timer on nan; safe to run by hand.
# Deploy: /opt/enclave-gateway/pin-adapter-wasm.sh (this file, tracked in the
# enclave repo at scripts/nan-pin-adapter-wasm.sh).
set -euo pipefail

API="http://127.0.0.1:8100"                 # api-relay on this box (ledger-backed reads)
KUBO="--api=/ip4/127.0.0.1/tcp/5001"
GATEWAY="https://ipfs.enclave.host"         # fetch source (the tenant, while healthy)
ADAPTER_DEP="0x7ae476a3a1e4b0b144248075ff6656a0a10c3ae4cea8b6e4ad2b59dd8989ce33"
RPCS=("https://mainnet.base.org" "https://base.drpc.org" "https://base-rpc.publicnode.com")
# EnclaveAddressBook — the on-chain root; the catalog is resolved through it so
# a catalog redeploy never stales this script.
BOOK="0xab214342d5A490150A4A977063A2f88E21F80907"
SEL_ALL="0x10c4e8b0"                        # all() -> (bytes32[] keys, address[] addrs)
SEL_GET_VERSION="0xaf904a06"               # getVersion(bytes32,uint256) -> Version struct
SEL_VERSION_CONFIGCID="0x637d5777"          # versionConfigCid(bytes32,uint256) -> string

ethcall() { # to, data -> result hex (or fails)
  local to=$1 data=$2 r
  for rpc in "${RPCS[@]}"; do
    r=$(curl -sf --max-time 20 -A "curl/8" -H 'content-type: application/json' \
      -d "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"eth_call\",\"params\":[{\"to\":\"$to\",\"data\":\"$data\"},\"latest\"]}" \
      "$rpc" | python3 -c 'import json,sys; r=json.load(sys.stdin); print(r["result"]) if "result" in r else sys.exit(1)') && { echo "$r"; return 0; }
  done
  return 1
}

# The deployment's current appRef (catalog://<appId>/<index>) from the local relay.
REF=$(curl -sf --max-time 15 "$API/v1/deployments/$ADAPTER_DEP" \
  | python3 -c 'import json,sys; print(json.load(sys.stdin)["image"]["reference"])')
APPID=${REF#catalog://}; APPID=${APPID%%/*}
INDEX=${REF##*/}
echo "[pin-adapter] current appRef: $REF"

# catalog address via the book
CAT=$(ethcall "$BOOK" "$SEL_ALL" | python3 -c '
import sys
h=sys.stdin.read().strip()
w=lambda i: h[2+i*64:2+(i+1)*64]
ko,ao=int(w(0),16)//32,int(w(1),16)//32
for i in range(int(w(ko),16)):
    if bytes.fromhex(w(ko+1+i)).decode().rstrip("\0")=="appCatalog":
        print("0x"+w(ao+1+i)[24:]); break')
[ -n "$CAT" ] || { echo "[pin-adapter] no appCatalog in the book"; exit 1; }

IDXHEX=$(printf '%064x' "$INDEX")
# getVersion returns the Version struct; field 0 is the wasm cid and fields are
# append-only across catalog revs, so decoding ONLY field 0 is rev-proof.
CID=$(ethcall "$CAT" "${SEL_GET_VERSION}${APPID#0x}${IDXHEX}" | python3 -c '
import sys
h=sys.stdin.read().strip()
w=lambda i: int(h[2+i*64:2+(i+1)*64],16)
t=w(0)//32                    # offset of the struct
s=t+w(t)//32                  # field 0: offset (relative to struct) of the cid string
n=w(s)
print(bytes.fromhex(h[2+(s+1)*64:2+(s+1)*64+n*2]).decode())')
CFG=$(ethcall "$CAT" "${SEL_VERSION_CONFIGCID}${APPID#0x}${IDXHEX}" | python3 -c '
import sys
h=sys.stdin.read().strip()
w=lambda i: int(h[2+i*64:2+(i+1)*64],16)
o=w(0)//32; n=w(o)
print(bytes.fromhex(h[2+(o+1)*64:2+(o+1)*64+n*2]).decode())' || true)

for cid in $CID $CFG; do
  [ -n "$cid" ] || continue
  if ipfs $KUBO pin ls --type recursive "$cid" >/dev/null 2>&1; then
    echo "[pin-adapter] $cid already pinned"
    continue
  fi
  echo "[pin-adapter] pinning $cid"
  tmp=$(mktemp)
  curl -sf --max-time 120 -H "Accept: application/vnd.ipld.car" \
    "$GATEWAY/ipfs/$cid?format=car&dag-scope=all" -o "$tmp"
  ipfs $KUBO dag import --pin-roots=true "$tmp" | grep -q "$cid" \
    || { echo "[pin-adapter] import did not confirm $cid"; rm -f "$tmp"; exit 1; }
  rm -f "$tmp"
  echo "[pin-adapter] pinned $cid"
done
echo "[pin-adapter] done"
