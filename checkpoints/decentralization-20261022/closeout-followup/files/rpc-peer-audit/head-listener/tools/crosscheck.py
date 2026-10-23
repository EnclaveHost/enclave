"""Corroborate listener head records against one public Base RPC (read-only, bounded).

Usage: python3 -I tools/crosscheck.py <heads.jsonl> <rpc-url> [max-checks<=10]

This is corroboration only. Authenticity of a head record comes from the
sequencer signature checked by base-consensus-gossip, not from this RPC. A
mismatch can also mean an unsafe-block reorg; it is reported, not resolved.
"""
import json
import sys
import urllib.request

path, url = sys.argv[1], sys.argv[2]
limit = min(int(sys.argv[3]) if len(sys.argv) > 3 else 5, 10)
heads = []
with open(path, encoding="utf-8") as f:
    for line in f:
        rec = json.loads(line)
        if rec.get("type") == "head" and rec.get("schema") == "enclave-base-unsafe-head/v1":
            heads.append(rec)
# Check the earliest records first: they have had the most time to propagate.
picked = sorted(heads, key=lambda r: r["number"])[:limit]


def call(method, params):
    body = json.dumps({"jsonrpc": "2.0", "id": 1, "method": method, "params": params}).encode()
    req = urllib.request.Request(url, body, {"content-type": "application/json",
                                             "user-agent": "rpc-peer-audit"})
    with urllib.request.urlopen(req, timeout=20) as r:
        raw = r.read(1 << 20)
    out = json.loads(raw)
    if "error" in out:
        raise RuntimeError(f"rpc error {out['error'].get('code')}")
    return out["result"]


assert int(call("eth_chainId", []), 16) == 8453
results = []
for rec in picked:
    blk = call("eth_getBlockByNumber", [hex(rec["number"]), False])
    results.append({
        "number": rec["number"],
        "listenerHash": rec["hash"],
        "rpcHash": blk and blk["hash"],
        "hashMatch": bool(blk) and blk["hash"].lower() == rec["hash"].lower(),
        "stateRootMatch": bool(blk) and blk["stateRoot"].lower() == rec["stateRoot"].lower(),
    })
print(json.dumps({"endpoint": url, "role": "corroboration-only", "heads": len(heads),
                  "checked": len(results), "allMatch": all(r["hashMatch"] and r["stateRootMatch"]
                                                         for r in results) and bool(results),
                  "results": results}, indent=1))
