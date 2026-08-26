#!/usr/bin/env bash
# nan-pin-adapter-wasm.sh — keep the CATALOG pinned in nan's local kubo,
# automatically, so ipfs.enclave.host can always serve what the fleet needs to
# launch. Started life pinning only the s3-ipfs-adapter's own wasm (hence the
# name and the enclave-pin-adapter.timer unit); widened 2026-08-26 to every
# approved, non-yanked catalog version.
#
# Why: ipfs.enclave.host is served by the s3-ipfs-adapter — a fleet TENANT.
# Every app provision (the adapter's own included) prefetches from that host, so
# with the adapter down and a wasm not in a box's cache, the fleet deadlocks
# (2026-08-23: every deployment queued on "prefetch … 502" until a hand-pinned
# kubo shim broke the loop). Caddy's ipfs.enclave.host block falls back to the
# local kubo gateway (127.0.0.1:8080, Gateway.NoFetch) for /ipfs/* when the
# tenant answers 502/503/504, 404/403, or is unreachable — this script is what
# keeps the bytes present there. Pinning the adapter's own wasm made the gateway
# restartable; pinning the whole catalog makes it USEFUL while restarting,
# because a CID that lives only in R2 is unfetchable exactly when the adapter
# that reads R2 is the thing that is down (2026-08-25: 9 of 140 missing CIDs
# were in that state, one of them a LIVE production app's wasm).
#
# The adapter's own wasm+config are pinned FIRST, every run: if anything below
# fails, the bootstrap escape is already in place. Old versions stay pinned
# (rollback safety); kubo never GCs pins.
#
# Runs hourly via enclave-pin-adapter.timer on nan; safe to run by hand.
# Deploy: /opt/enclave-gateway/pin-adapter-wasm.sh (this file, tracked in the
# enclave repo at scripts/nan-pin-adapter-wasm.sh).
#
# Env: MAX_NEW_PINS  new CIDs to fetch per run (default 25, 0 = unlimited).
#      The first runs have a whole catalog to pull and every byte comes through
#      the fleet adapter, so a run converges a slice at a time rather than
#      hammering the tenant it is protecting. Steady state is zero fetches.
set -euo pipefail

KUBO="--api=/ip4/127.0.0.1/tcp/5001"
GATEWAY="${GATEWAY:-https://ipfs.enclave.host}"   # fetch source (adapter, with kubo fallback)
MAX_NEW_PINS="${MAX_NEW_PINS:-25}"
ADAPTER_DEP="0x7ae476a3a1e4b0b144248075ff6656a0a10c3ae4cea8b6e4ad2b59dd8989ce33"

# The catalog and the deployments ledger are resolved through EnclaveAddressBook
# — the on-chain root — so a redeploy of either never stales this script. All
# reads are raw eth_call with hardcoded selectors (no node_modules on this box).
export ADAPTER_DEP
LIST=$(python3 <<'PY'
import json, os, sys, urllib.request

RPCS = ["https://mainnet.base.org", "https://base.drpc.org", "https://base-rpc.publicnode.com"]
BOOK = "0xab214342d5A490150A4A977063A2f88E21F80907"
S_ALL      = "0x10c4e8b0"  # all() -> (bytes32[] keys, address[] addrs)
S_APPCOUNT = "0xb55ca2c3"  # appCount() -> uint256
S_APPIDAT  = "0xcbe6673d"  # appIdAt(uint256) -> bytes32
S_VERPAGE  = "0x2eb7c1f0"  # getVersionsPage(bytes32,uint256,uint256) -> Version[]
S_CFGCIDS  = "0x5ea1708a"  # versionConfigCids(bytes32) -> string[]
S_DEPPAGE  = "0xcd1a2e91"  # getPage(uint256,uint256) -> Deployment[]

def ethcall(to, data):
    body = json.dumps({"jsonrpc": "2.0", "id": 1, "method": "eth_call",
                       "params": [{"to": to, "data": data}, "latest"]}).encode()
    last = None
    for rpc in RPCS:
        for _ in range(2):
            try:
                req = urllib.request.Request(rpc, data=body,
                    headers={"content-type": "application/json", "user-agent": "curl/8"})
                with urllib.request.urlopen(req, timeout=30) as r:
                    j = json.load(r)
                if "result" in j:
                    return j["result"]
                last = j.get("error")
            except Exception as e:
                last = e
    raise RuntimeError("eth_call failed: %s" % (last,))

w  = lambda h, i: h[2 + i * 64: 2 + (i + 1) * 64]
n  = lambda h, i: int(w(h, i), 16)
u256 = lambda i: "%064x" % i
b32  = lambda x: x[2:].rjust(64, "0")
def rd_str(h, off):                       # off = word index of the length word
    ln = n(h, off)
    return bytes.fromhex(h[2 + (off + 1) * 64: 2 + (off + 1) * 64 + ln * 2]).decode("utf8", "replace")

def book(key):
    h = ethcall(BOOK, S_ALL)
    ko, ao = n(h, 0) // 32, n(h, 1) // 32
    for i in range(n(h, ko)):
        if bytes.fromhex(w(h, ko + 1 + i)).decode().rstrip("\0") == key:
            return "0x" + w(h, ao + 1 + i)[24:]
    raise RuntimeError("the address book has no %s entry" % key)

CATALOG = book("appCatalog")
LEDGER  = book("deployments")
ADAPTER = os.environ["ADAPTER_DEP"].lower()

rows, seen = [], set()
def want(cid, label):
    cid = (cid or "").strip()
    if cid and cid not in seen:
        seen.add(cid)
        rows.append((cid, label))

# --- deployments: the adapter's CURRENT appRef, and every envelope config CID.
# A deployment's options envelope may pin its config at its own CID
# ({"configCid": "…"}) and the LAUNCH fetches those bytes, so losing one strands
# that deployment exactly like losing its wasm (lived through 2026-08-22:
# eyesoff-ai failed provision on "ipfs fetch failed for config bafkreicl…", a
# CID no catalog row references). Rows inactive with nothing left to spend are
# skipped — nothing can launch them.
adapter_ref, envelopes = None, []
start = 0
while True:
    h = ethcall(LEDGER, S_DEPPAGE + u256(start) + u256(100))
    arr = n(h, 0) // 32
    cnt = n(h, arr)
    for i in range(cnt):
        st = arr + 1 + n(h, arr + 1 + i) // 32
        if ("0x" + w(h, st + 0)).lower() == ADAPTER:
            adapter_ref = rd_str(h, st + n(h, st + 2) // 32)
        if not bool(n(h, st + 9)) and n(h, st + 12) == 0:
            continue
        env = rd_str(h, st + n(h, st + 4) // 32).strip()
        if not env.startswith("{"):
            continue
        try:
            cid = json.loads(env).get("configCid")
        except Exception:
            continue
        if isinstance(cid, str) and cid.strip():
            envelopes.append((cid.strip(), "deployment %s (envelope config)" % ("0x" + w(h, st + 0))[:10]))
    if cnt < 100:
        break
    start += 100

# --- catalog: every version, so the adapter's exact release can be found by
# (appId, index) and every approved, non-yanked release gets pinned.
# Version head words are append-only across catalog revs: 0 cid, 1 version,
# 8 yanked, 10 approval (0 Pending, 1 Approved, 2 Rejected).
catalog = {}
for i in range(n(ethcall(CATALOG, S_APPCOUNT), 0)):
    app_id = "0x" + w(ethcall(CATALOG, S_APPIDAT + u256(i)), 0)
    h = ethcall(CATALOG, S_VERPAGE + b32(app_id) + u256(0) + u256(1000))
    arr = n(h, 0) // 32
    vers = []
    for k in range(n(h, arr)):
        st = arr + 1 + n(h, arr + 1 + k) // 32
        vers.append({"cid": rd_str(h, st + n(h, st + 0) // 32),
                     "version": rd_str(h, st + n(h, st + 1) // 32),
                     "yanked": bool(n(h, st + 8)), "approval": n(h, st + 10)})
    h = ethcall(CATALOG, S_CFGCIDS + b32(app_id))
    arr = n(h, 0) // 32
    cfgs = [rd_str(h, arr + 1 + n(h, arr + 1 + k) // 32) for k in range(n(h, arr))]
    for k, v in enumerate(vers):
        v["configCid"] = cfgs[k] if k < len(cfgs) else ""
    catalog[app_id.lower()] = vers

# The gateway's own bytes go first: if the rest of this run dies, the bootstrap
# escape is still current.
if adapter_ref and adapter_ref.startswith("catalog://"):
    ref = adapter_ref[len("catalog://"):]
    app_id, _, idx = ref.partition("/")
    vers = catalog.get(app_id.lower(), [])
    if idx.isdigit() and int(idx) < len(vers):
        v = vers[int(idx)]
        want(v["cid"], "s3-ipfs-adapter %s (wasm) [BOOTSTRAP]" % v["version"])
        want(v["configCid"], "s3-ipfs-adapter %s (config) [BOOTSTRAP]" % v["version"])
    else:
        print("[pin-catalog] WARN adapter appRef %s not in the catalog" % adapter_ref, file=sys.stderr)
else:
    print("[pin-catalog] WARN could not read the adapter's appRef from the ledger", file=sys.stderr)

for app_id, vers in catalog.items():
    for k, v in enumerate(vers):
        if v["approval"] != 1 or v["yanked"]:
            continue
        want(v["cid"], "%s:%s (wasm)" % (app_id[:10], v["version"]))
        want(v["configCid"], "%s:%s (config)" % (app_id[:10], v["version"]))
for cid, label in envelopes:
    want(cid, label)

print("[pin-catalog] catalog %s, ledger %s: %d distinct CIDs" % (CATALOG, LEDGER, len(rows)), file=sys.stderr)
for cid, label in rows:
    print("%s\t%s" % (cid, label))
PY
)

total=0; already=0; pinned=0; failed=0; deferred=0
while IFS=$'\t' read -r cid label; do
  [ -n "$cid" ] || continue
  total=$((total + 1))
  if ipfs $KUBO pin ls --type recursive "$cid" >/dev/null 2>&1; then
    already=$((already + 1))
    continue
  fi
  if [ "$MAX_NEW_PINS" -gt 0 ] && [ "$pinned" -ge "$MAX_NEW_PINS" ]; then
    deferred=$((deferred + 1))
    continue
  fi
  echo "[pin-catalog] pinning $cid  <- $label"
  tmp=$(mktemp)
  # A CAR whose root block never arrives is a MISS even at HTTP 200: kubo answers
  # a CID it lacks with a 59-byte header-only CAR, and the adapter's kubo
  # fallback can hand us exactly that. dag import only confirms a root it
  # actually received, so the grep below is the check that catches it.
  if curl -sf --max-time 300 -H "Accept: application/vnd.ipld.car" \
       "$GATEWAY/ipfs/$cid?format=car&dag-scope=all" -o "$tmp" \
     && ipfs $KUBO dag import --pin-roots=true "$tmp" 2>/dev/null | grep -q "$cid"; then
    pinned=$((pinned + 1))
    echo "[pin-catalog] pinned $cid"
  else
    failed=$((failed + 1))
    echo "[pin-catalog] FAILED $cid  <- $label (gateway cannot serve it either)" >&2
  fi
  rm -f "$tmp"
  sleep 1
done <<< "$LIST"

echo "[pin-catalog] done: $total CIDs, $already already pinned, $pinned newly pinned, $failed failed, $deferred deferred to the next run"
# Failures are the alarm this script can raise: a CID neither kubo nor the
# gateway can produce is one nothing on the fleet can launch.
[ "$failed" -eq 0 ]
