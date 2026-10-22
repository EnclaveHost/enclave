#!/usr/bin/env python3
"""http-probe.py OUT.json: READ-ONLY, bounded public probes (GET/HEAD only, no credentials, no writes) of the adapter
0x7ae476a3 and the publisher 0xd9798e4c, in the style of the reviewed work/ens-outage-20261022/adapter-after-job-fix-http.py.
  - DNS A records of the app and front names, compared with the four DigitalOcean front addresses root's cold-browser probe
    lists; the TLS certificate each name presents (subject, issuer, SANs, validity).
  - adapter: /api/status; the trustless probe HEAD/GET /ipfs/bafkqaaa?format=raw over HTTP/2 (curl, status + protocol);
    the new release CID, the live ENS CID and the logo-hotfix CID by ?format=raw (status; body must hash to the CID);
    /api/files (bounded) reduced to a count, a top-level prefix histogram and any key under sites/; the catalog version's
    wasm fetched by CID (bounded 64 MiB), re-imported to that CID, hashed, and scanned for the version banner and the probe
    route marker. Same status and probe checks against ipfs.enclave.host for comparison.
  - publisher: /api/status reduced to identity/value/sequence/validity/ipni fields; /ipni/v1/ad/head status.
Every response is capped; every request has a timeout; nothing secret is requested or recorded."""
import hashlib, json, socket, ssl, subprocess, sys, time, datetime, urllib.request, urllib.error
OUT = sys.argv[1]
ADAPTER, PUBLISHER, FRONT = "https://7ae476a3.app.enclave.host", "https://d9798e4c.app.enclave.host", "https://ipfs.enclave.host"
DO = {"134.199.235.187", "134.209.248.172", "165.245.191.129", "146.190.246.39"}   # root-public-cold-browser probe.mjs knownDO
NEW, LIVE, HOTFIX = ("bafybeifkfgxsjz6gnj234fvdkxa37pc4fcevydu6tb55wtidjejfsuxake", "bafybeieuxt6vy424gnmtb5eo6mey6x5p5xbu2mpr4xkiwvz25cbeotzaou",
                     "bafybeig3rai3tyoimbhb32vo6hkkw3o336wluht7owbs7mefhtiridwp6y")
WASM_CID = sys.argv[2] if len(sys.argv) > 2 else None
UA = {"User-Agent": "Enclave-availability-diagnostic/1.0"}
B32 = "abcdefghijklmnopqrstuvwxyz234567"

def b32dec(s):
    acc = bits = 0; out = bytearray()
    for ch in s[1:]:
        acc = (acc << 5) | B32.index(ch); bits += 5
        if bits >= 8: bits -= 8; out.append((acc >> bits) & 255)
    return bytes(out)

def get(url, cap, method="GET", accept=None, timeout=30):
    d = {"url": url, "method": method}; t = time.monotonic()
    h = dict(UA); h.update({"Accept": accept} if accept else {})
    try:
        with urllib.request.urlopen(urllib.request.Request(url, headers=h, method=method), timeout=timeout) as r:
            body = r.read(cap + 1) if method == "GET" else b""
            d.update(status=r.status, server=r.headers.get("Server"), contentType=r.headers.get("Content-Type"), truncated=len(body) > cap); d["_body"] = body[:cap]
    except urllib.error.HTTPError as e:
        d.update(status=e.code, server=e.headers.get("Server"), sample=e.read(300).decode(errors="replace"))
    except Exception as e:
        d["error"] = str(e)[:200]
    d["seconds"] = round(time.monotonic() - t, 2); return d

def strip(d): return {k: v for k, v in d.items() if k != "_body"}

def raw_block(base, cid):
    d = get(f"{base}/ipfs/{cid}?format=raw", 4 << 20, accept="application/vnd.ipld.raw")
    if d.get("_body") is not None and d.get("status") == 200:
        d["hashMatchesCid"] = hashlib.sha256(d["_body"]).digest() == b32dec(cid)[4:]
    return strip(d)

def curl_probe(base, method):
    args = ["curl", "-s", "-o", "/dev/null", "--http2", "--max-time", "20", "-H", "Accept: application/vnd.ipld.raw", "-w", "%{http_code} %{http_version}"]
    if method == "HEAD": args.append("-I")
    try: code, ver = subprocess.run(args + [f"{base}/ipfs/bafkqaaa?format=raw"], capture_output=True, text=True, timeout=30).stdout.split()
    except Exception as e: return {"method": method, "error": str(e)[:120]}
    return {"method": method, "status": int(code), "httpVersion": ver}

def dns_tls(name):
    d = {"name": name}
    try: d["a"] = sorted({ai[4][0] for ai in socket.getaddrinfo(name, 443, socket.AF_INET, socket.SOCK_STREAM)})
    except Exception as e: d["dnsError"] = str(e)[:120]; return d
    d["allDigitalOceanFronts"] = bool(d["a"]) and set(d["a"]) <= DO; d["anyDigitalOceanFront"] = bool(set(d["a"]) & DO)
    try:
        ctx = ssl.create_default_context()
        with socket.create_connection((name, 443), timeout=15) as s, ctx.wrap_socket(s, server_hostname=name) as t:
            c = t.getpeercert()
            d["tls"] = {"subject": dict(x[0] for x in c["subject"]), "issuer": dict(x[0] for x in c["issuer"]).get("organizationName"),
                        "san": [v for k, v in c.get("subjectAltName", ())][:6], "notBefore": c["notBefore"], "notAfter": c["notAfter"], "peer": t.getpeername()[0]}
    except Exception as e: d["tlsError"] = str(e)[:160]
    return d

def status_of(base):
    d = get(f"{base}/api/status", 65536)
    try:
        s = json.loads(d.pop("_body")); d["status_json"] = {k: s.get(k) for k in ("app", "state", "prefix", "files", "totalBytes", "dagNodes", "rootCid", "truncated", "refreshSecs", "lastIndexAge", "error")}
    except Exception: d.pop("_body", None)
    return d

out = {"at": datetime.datetime.now(datetime.timezone.utc).isoformat(), "dns": [dns_tls(n) for n in ("7ae476a3.app.enclave.host", "d9798e4c.app.enclave.host", "ipfs.enclave.host", "enclave.host")]}
for label, base in (("adapter", ADAPTER), ("front", FRONT)):
    r = {"status": status_of(base), "probe": [curl_probe(base, "HEAD"), curl_probe(base, "GET")], "blocks": {"new": raw_block(base, NEW), "liveEns": raw_block(base, LIVE), "hotfix": raw_block(base, HOTFIX)}}
    if label == "adapter":
        f = get(f"{base}/api/files", 32 << 20, timeout=60)
        try:
            files = json.loads(f.pop("_body")); tops = {}
            for x in files: tops[x["path"].split("/", 1)[0] if "/" in x["path"] else "(root)"] = tops.get(x["path"].split("/", 1)[0] if "/" in x["path"] else "(root)", 0) + 1
            r["files"] = {**f, "count": len(files), "topLevel": dict(sorted(tops.items(), key=lambda kv: -kv[1])[:15]),
                          "underSites": sum(1 for x in files if x["path"].startswith("sites/")), "underNewPrefix": sum(1 for x in files if x["path"].startswith(f"sites/{NEW}/"))}
        except Exception as e: f.pop("_body", None); r["files"] = {**f, "parseError": str(e)[:120]}
        if WASM_CID:
            w = get(f"{base}/ipfs/{WASM_CID}", 64 << 20, timeout=120); body = w.pop("_body", None)
            if body is not None and w.get("status") == 200:
                imp = subprocess.run(["node", "--input-type=module", "-e", "import fs from 'node:fs';const {importFile,cidString}=await import('/home/steven/Documents/Codex/2026-10-18/wo/work/enclave/scripts/site-release/unixfs.mjs');process.stdout.write(cidString(importFile(fs.readFileSync(0)).cid))"],
                                     input=body, capture_output=True, timeout=60)
                banner = sorted({m.decode() for m in __import__("re").findall(rb"s3-ipfs-adapter/\d+\.\d+\.\d+", body)})
                w.update(bytes=len(body), sha256=hashlib.sha256(body).hexdigest(), reimportedCid=imp.stdout.decode(), cidMatches=imp.stdout.decode() == WASM_CID,
                         versionBanners=banner, hasProbeMarker=b"bafkqaaa" in body)
            r["catalogWasm"] = w
    out[label] = r
pub = get(f"{PUBLISHER}/api/status", 65536)
try:
    s = json.loads(pub.pop("_body")); pub["status_json"] = {k: s.get(k) for k in ("peerId", "authorityMode", "sequence", "value", "validUntil", "publishedAt", "recovered", "mode", "ipni", "durableState", "lastError", "configError", "uptimeSecs")}
except Exception: pub.pop("_body", None)
head = get(f"{PUBLISHER}/ipni/v1/ad/head", 65536); head.pop("_body", None)
out["publisher"] = {"status": pub, "adHead": head}
open(OUT, "w").write(json.dumps(out, indent=1) + "\n"); print(json.dumps(out, indent=1))
