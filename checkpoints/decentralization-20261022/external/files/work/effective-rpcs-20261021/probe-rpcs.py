#!/usr/bin/env python3
"""Bounded keyless read-only probe of the two intended-but-unused RPCs (tenderly, nodies): eth_chainId, eth_blockNumber,
eth_getBlockByNumber(head-2) and eth_call Multicall3.getBlockNumber() at head-2 (the shape LeaseReader.agreed() uses). 4
requests per host, no account, no key. -> rpc-probe.json"""
import json, time, urllib.request, datetime
HOSTS = ["https://base.gateway.tenderly.co", "https://base-public.nodies.app"]
def rpc(u, m, p):
    t = time.time(); body = json.dumps({"jsonrpc": "2.0", "id": 1, "method": m, "params": p}).encode()
    try:
        r = urllib.request.urlopen(urllib.request.Request(u, body, {"content-type": "application/json", "user-agent": "rpc-probe/1"}), timeout=15)
        j = json.loads(r.read(1 << 20)); return {"method": m, "http": r.status, "ms": round((time.time() - t) * 1000), "ok": "result" in j, "error": j.get("error")}, j.get("result")
    except Exception as e: return {"method": m, "ms": round((time.time() - t) * 1000), "ok": False, "error": str(e)[:160]}, None
out = {"at": datetime.datetime.now(datetime.timezone.utc).isoformat(), "results": []}
for u in HOSTS:
    calls = []; c, cid = rpc(u, "eth_chainId", []); c["result"] = cid; calls.append(c)
    c, head = rpc(u, "eth_blockNumber", []); c["result"] = head; calls.append(c)
    if head:
        b = hex(int(head, 16) - 2)
        c, blk = rpc(u, "eth_getBlockByNumber", [b, False]); c["hash"] = (blk or {}).get("hash"); calls.append(c)
        c, res = rpc(u, "eth_call", [{"to": "0xcA11bde05977b3631167028862bE2a173976CA11", "data": "0x42cbb15c"}, b]); c["equalsBlock"] = bool(res) and int(res, 16) == int(b, 16); calls.append(c)
    out["results"].append({"host": u.split("//")[1], "calls": calls})
json.dump(out, open("rpc-probe.json", "w"), indent=1); print(json.dumps(out)[:1500])
