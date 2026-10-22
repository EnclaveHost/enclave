#!/usr/bin/env python3
"""READ-ONLY, spaced (15 s) public GETs for 2 of the 8 media CIDs (queue only): trustless-gateway.link ?format=raw (used by the repo's
isolation/restore/owner-payloads.mjs), ipfs.io again after a pause, and the IPNI index cid.contact. Bytes verified against the CID."""
import hashlib, json, pathlib, time, urllib.request, urllib.error, importlib.util
H = pathlib.Path(__file__).resolve().parent; OUT = H / "availability2.json"
spec = importlib.util.spec_from_file_location("p1", H / "live-media-probe.py"); src = (H / "live-media-probe.py").read_text()
ns = {"__file__": str(H / "live-media-probe.py")}; exec(src.split("def main():")[0], ns)                 # reuse get() and cid_digest() verbatim (no main run)
get, digest = ns["get"], ns["cid_digest"]
cids = ["bafkreia4wrrx3ljhfog5r4sa7yd5e3d6bblbvngwyjnmce2q2f3grbu36e", "bafkreifvqozjx45dsmikegrd5lvuqb75r4uhjq5s2f5iqxrgqlm4ib3e5a"]
if OUT.exists(): raise SystemExit("exists")
res = {"at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()), "cids": {}}
for c in cids:
    row = {}
    for name, url, acc in (("trustless-gateway.link", f"https://trustless-gateway.link/ipfs/{c}?format=raw", "application/vnd.ipld.raw"),
                           ("ipfs.io", f"https://ipfs.io/ipfs/{c}", None), ("cid.contact", f"https://cid.contact/cid/{c}", "application/json")):
        time.sleep(15); m, body = get(url, acc)
        if name != "cid.contact": m["verified"] = bool(body) and hashlib.sha256(body).hexdigest() == digest(c)
        else: m["body"] = body[:300].decode("utf-8", "replace")
        row[name] = m
    res["cids"][c] = row
with open(OUT, "x") as f: json.dump(res, f, indent=1)
print(json.dumps({c: {k: (v.get("status"), v.get("verified"), v.get("error"), (v.get("body") or "")[:80]) for k, v in r.items()} for c, r in res["cids"].items()}, indent=1))
