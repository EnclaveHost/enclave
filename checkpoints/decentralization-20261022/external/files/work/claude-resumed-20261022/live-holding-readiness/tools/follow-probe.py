#!/usr/bin/env python3
"""follow-probe.py OUT.json WASM_CID: READ-ONLY follow-up to http-probe.py. Six samples 30 s apart of DNS + TLS + GET /api/status
(capped) for the adapter and publisher app names (flap vs persistent); then the adapter's catalog wasm fetched BY CID through
ipfs.enclave.host (capped 64 MiB), re-imported to its CID, hashed and scanned for the version banner and the probe marker;
and, if the adapter name answered in any sample, its probe / new-CID block / files summary once."""
import json, sys, time, socket, ssl, hashlib, subprocess, re, datetime, urllib.request, urllib.error
OUT, WASM_CID = sys.argv[1], sys.argv[2]
DO = {"134.199.235.187", "134.209.248.172", "165.245.191.129", "146.190.246.39"}
UA = {"User-Agent": "Enclave-availability-diagnostic/1.0"}
def sample(name):
    d = {"name": name}
    try: d["a"] = sorted({ai[4][0] for ai in socket.getaddrinfo(name, 443, socket.AF_INET, socket.SOCK_STREAM)}); d["allDO"] = set(d["a"]) <= DO
    except Exception as e: d["dns"] = str(e)[:80]; return d
    try:
        ctx = ssl.create_default_context()
        with socket.create_connection((name, 443), timeout=10) as s, ctx.wrap_socket(s, server_hostname=name) as t:
            c = t.getpeercert(); d["tls"] = {"cn": dict(x[0] for x in c["subject"]).get("commonName"), "issuer": dict(x[0] for x in c["issuer"]).get("organizationName"), "notBefore": c["notBefore"]}
    except Exception as e: d["tlsError"] = str(e)[:100]; return d
    try:
        with urllib.request.urlopen(urllib.request.Request(f"https://{name}/api/status", headers=UA), timeout=15) as r:
            b = r.read(65537); d["status"] = r.status; d["server"] = r.headers.get("Server")
            try: s = json.loads(b); d["summary"] = {k: s.get(k) for k in ("app", "state", "files", "rootCid", "truncated", "error", "sequence", "value", "validUntil")}
            except Exception: d["summary"] = None
    except urllib.error.HTTPError as e: d["status"] = e.code
    except Exception as e: d["httpError"] = str(e)[:100]
    return d
out = {"at": datetime.datetime.now(datetime.timezone.utc).isoformat(), "samples": []}
for i in range(6):
    out["samples"].append({"t": datetime.datetime.now(datetime.timezone.utc).isoformat(), "adapter": sample("7ae476a3.app.enclave.host"), "publisher": sample("d9798e4c.app.enclave.host")})
    if i < 5: time.sleep(30)
w = {"url": f"https://ipfs.enclave.host/ipfs/{WASM_CID}"}
try:
    with urllib.request.urlopen(urllib.request.Request(w["url"], headers=UA), timeout=120) as r:
        body = r.read((64 << 20) + 1); w.update(status=r.status, server=r.headers.get("Server"), truncated=len(body) > (64 << 20))
    imp = subprocess.run(["node", "--input-type=module", "-e", "import fs from 'node:fs';const {importFile,cidString}=await import('/home/steven/Documents/Codex/2026-10-18/wo/work/enclave/scripts/site-release/unixfs.mjs');process.stdout.write(cidString(importFile(fs.readFileSync(0)).cid))"], input=body, capture_output=True, timeout=60)
    w.update(bytes=len(body), sha256=hashlib.sha256(body).hexdigest(), cidMatches=imp.stdout.decode() == WASM_CID,
             versionBanners=sorted({m.decode() for m in re.findall(rb"s3-ipfs-adapter/\d+\.\d+\.\d+", body)}), hasProbeMarker=b"bafkqaaa" in body,
             hasWalletUploadMarker=b"enclave-storage-upload:v1" in body, hasContractWalletMarker=b"erc1271-v2" in body)
except urllib.error.HTTPError as e: w.update(status=e.code, sample=e.read(200).decode(errors="replace"))
except Exception as e: w["error"] = str(e)[:160]
out["catalogWasm"] = w
open(OUT, "w").write(json.dumps(out, indent=1) + "\n"); print(json.dumps(out, indent=1))
