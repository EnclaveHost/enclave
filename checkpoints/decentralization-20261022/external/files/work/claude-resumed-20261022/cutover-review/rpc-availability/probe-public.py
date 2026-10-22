#!/usr/bin/env python3
"""Low-rate keyless read-only probe of the PUBLIC Base RPCs already in the node's own 5-host default (chain.mjs).
base.drpc.org is deliberately NOT probed: it is already proven rate-limited (code 15) and this site shares minipc's egress IP.
Per host: eth_chainId, eth_blockNumber, eth_getBlockByNumber(head-2) = 3 requests, sequential, 15 s timeout. -> probe-public.json"""
import json, time, urllib.request, datetime
HOSTS = ["https://base-rpc.publicnode.com", "https://base.gateway.tenderly.co", "https://base-public.nodies.app", "https://mainnet.base.org"]
def rpc(u, m, p):
    t = time.time(); body = json.dumps({"jsonrpc": "2.0", "id": 1, "method": m, "params": p}).encode()
    try:
        r = urllib.request.urlopen(urllib.request.Request(u, body, {"content-type": "application/json", "user-agent": "rpc-probe/1"}), timeout=15)
        j = json.loads(r.read(1 << 20)); e = j.get("error")
        return {"method": m, "http": r.status, "ms": round((time.time() - t) * 1000), "ok": "result" in j, "error": (e or {}).get("message") if isinstance(e, dict) else e}, j.get("result")
    except Exception as e: return {"method": m, "ms": round((time.time() - t) * 1000), "ok": False, "error": str(e)[:160]}, None
out = {"at": datetime.datetime.now(datetime.timezone.utc).isoformat(), "skipped": {"base.drpc.org": "known code 15 public rate limit; not probed to spare the shared egress IP"}, "results": []}
for u in HOSTS:
    calls = []; c, cid = rpc(u, "eth_chainId", []); c["result"] = cid; calls.append(c)
    c, head = rpc(u, "eth_blockNumber", []); c["result"] = head; calls.append(c)
    if head:
        b = hex(int(head, 16) - 2); c, blk = rpc(u, "eth_getBlockByNumber", [b, False]); c["block"] = b; c["hash"] = (blk or {}).get("hash"); calls.append(c)
    out["results"].append({"host": u.split("//")[1], "calls": calls}); time.sleep(0.5)
json.dump(out, open("probe-public.json", "w"), indent=1)
for r in out["results"]: print(r["host"], [(c["method"], c.get("http"), c["ms"], c["ok"], c.get("result") or c.get("hash") or c.get("error")) for c in r["calls"]])
