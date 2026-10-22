#!/usr/bin/env python3
"""READ-ONLY public GET probe (run only through work/claude-test-queue.py). Sequential, each request bounded (15 s, 4 MiB).
  1 the SHIPPED site: enclavehost.eth.limo /apps chunk list (root's probe r3) -> which chunks carry the media gateway code
  2 the 8 media CIDs root's browser saw blocked: GET from ipfs.enclave.host (preferred, DO fleet), ipfs.io and dweb.link (the
    product's existing public gateways: site IPFS_GATEWAY, CLI/supervisor GUEST_BOOTSTRAP_GATEWAYS); the BYTES are verified
    against the CID's own sha256 multihash (raw-leaf CIDv1 'bafkrei'), never a status code alone
  3 who PROVIDES each CID: delegated-ipfs.dev /routing/v1/providers (public read API); addresses classified against the known
    DigitalOcean fleet IPs. Retrieval through a public gateway does NOT prove the content is held outside the fleet.
No upload, POST, signing, wallet or credential. Output: probe/live-media.json (O_EXCL)."""
import base64, hashlib, json, os, pathlib, re, socket, sys, time, urllib.request, urllib.error
OUT = pathlib.Path(__file__).resolve().parent / "live-media.json"
ROOT = pathlib.Path("/home/steven/Documents/Codex/2026-10-18/wo/work/root-public-cold-browser-r3-20261022/result.json")
DO = {"134.199.235.187", "134.209.248.172", "165.245.191.129", "146.190.246.39"}
MAX = 4 << 20
def get(url, accept=None):
    req = urllib.request.Request(url, headers={"User-Agent": "enclave-public-cold-probe/1", **({"Accept": accept} if accept else {})})
    t = time.time()
    try:
        with urllib.request.urlopen(req, timeout=15) as r:
            body = r.read(MAX + 1)
            return {"status": r.status, "final": r.geturl(), "type": r.headers.get("content-type"), "len": len(body), "ms": int(1000 * (time.time() - t)), "truncated": len(body) > MAX}, body[:MAX]
    except urllib.error.HTTPError as e:
        return {"status": e.code, "final": url, "ms": int(1000 * (time.time() - t))}, b""
    except Exception as e:
        return {"status": None, "error": type(e).__name__ + ": " + str(e)[:160], "ms": int(1000 * (time.time() - t))}, b""
B32 = "abcdefghijklmnopqrstuvwxyz234567"
def cid_digest(cid):
    """bafkrei... = base32 'b' + CIDv1(0x01) raw(0x55) sha2-256(0x12, 0x20) digest -> the expected sha256 of the bytes"""
    s = cid[1:]; bits = "".join(format(B32.index(c), "05b") for c in s); raw = bytes(int(bits[i:i + 8], 2) for i in range(0, len(bits) - len(bits) % 8, 8))
    if raw[:4] != bytes([0x01, 0x55, 0x12, 0x20]): return None
    return raw[4:36].hex()
def main():
    if OUT.exists(): raise SystemExit(f"{OUT} exists (never overwritten)")
    root = json.loads(ROOT.read_text())
    res = {"at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()), "site": {}, "cids": {}, "notes": []}
    # 1 shipped site chunks
    paths = [r["path"] for r in root["requests"] if r["origin"] == "https://enclavehost.eth.limo" and r["path"].startswith("/js/")]
    for p in ["/apps/"] + paths:
        m, body = get("https://enclavehost.eth.limo" + p)
        t = body.decode("utf-8", "replace")
        m.update(sha256=hashlib.sha256(body).hexdigest() if body else None,
                 hasImgGateway="ipfs.enclave.host/ipfs/" in t, svgKey=("enclave-logo.svg" if "filename=enclave-logo.svg" in t else "i.svg" if "filename=i.svg" in t else None),
                 hasDweb="dweb.link" in t, hasIpfsIo="ipfs.io/ipfs/" in t, hasMediaFallback=("mediaFallback" in t or "MEDIA_GATEWAYS" in t))
        res["site"][p] = m
    # 2 + 3 the observed media CIDs
    cids = sorted({b["path"].split("/ipfs/")[1].split("?")[0] for b in root["blocked"] if "/ipfs/" in b["path"]})
    for c in cids:
        want = cid_digest(c); row = {"expectedSha256": want, "gateways": {}, "providers": None}
        for g in ("https://ipfs.enclave.host/ipfs/", "https://ipfs.io/ipfs/", "https://dweb.link/ipfs/"):
            m, body = get(g + c)
            m["verified"] = bool(body) and want is not None and hashlib.sha256(body).hexdigest() == want
            row["gateways"][g] = m
        m, body = get("https://delegated-ipfs.dev/routing/v1/providers/" + c, "application/json")
        prov = []
        try:
            for p in (json.loads(body or b"{}").get("Providers") or [])[:20]:
                addrs = p.get("Addrs") or []
                ips = sorted({x.split("/")[2] for x in addrs if x.startswith(("/ip4/", "/ip6/"))})
                prov.append({"id": (p.get("ID") or "")[:16] + "...", "protocols": p.get("Protocols"), "ips": ips[:8], "doFleet": bool(set(ips) & DO), "nonDo": [i for i in ips if i not in DO and not i.startswith(("10.", "127.", "192.168.", "::1", "fe80"))][:4]})
        except Exception as e: row["providerError"] = str(e)[:120]
        row["providers"] = {"http": m, "count": len(prov), "list": prov}
        res["cids"][c] = row
    with open(OUT, "x") as f: json.dump(res, f, indent=1)
    s = {c: {g.split("/")[2]: (r["gateways"][g]["status"], r["gateways"][g]["verified"]) for g in r["gateways"]} | {"providers": r["providers"]["count"], "nonDoProviders": sum(1 for p in r["providers"]["list"] if p["nonDo"])} for c, r in res["cids"].items()}
    print(json.dumps({"siteMediaChunks": {p: (m.get("status"), m.get("svgKey"), m.get("hasDweb")) for p, m in res["site"].items() if m.get("hasImgGateway")}, "cids": s}, indent=1))
main()
