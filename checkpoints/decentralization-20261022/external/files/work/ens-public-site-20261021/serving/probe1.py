# READ-ONLY, bounded public HTTP probe of the content path behind enclavehost.eth (ENS contenthash -> IPNS -> IPFS).
# Not repeated here: root's eth.limo / eth.link probes (initial-http.json) and worker 9d's chain reads.
# Every request: GET/HEAD only, 25 s timeout, at most 64 KiB read. No keys, no writes, no publish.
import json, time, urllib.request, urllib.error, base64, datetime, pathlib, sys

NAME = "k51qzi5uqu5dma8l0w05o02gkz7l80f3r3mb536qh8fuhrr2qj4nsa2afe9b52"   # docs/design/nan-retirement.md; scripts/nan-prune-site-roots.py
PUB = "https://d9798e4c.app.enclave.host"                              # the ipns-publisher deployment (root's initial-http.json)
out = {"at": datetime.datetime.now(datetime.timezone.utc).isoformat(), "name": NAME, "checks": []}

def get(url, accept=None, method="GET", limit=65536, timeout=25):
    t0 = time.time(); r = {"url": url, "method": method}
    try:
        req = urllib.request.Request(url, method=method, headers={"User-Agent": "enclave-ens-diagnosis/1", **({"Accept": accept} if accept else {})})
        with urllib.request.urlopen(req, timeout=timeout) as res:
            body = res.read(limit) if method == "GET" else b""
            r.update(status=res.status, headers={k: v for k, v in res.headers.items() if k.lower() in
                     ("content-type", "content-length", "x-ipfs-path", "x-ipfs-roots", "x-content-type-options", "server", "etag", "cache-control", "location", "x-ipfs-resolved-path")}, bytes=len(body))
            r["_body"] = body
    except urllib.error.HTTPError as e:
        r.update(status=e.code, error=str(e), sample=e.read(400).decode("utf-8", "replace"))
    except Exception as e:
        r.update(error=f"{type(e).__name__}: {e}")
    r["seconds"] = round(time.time() - t0, 2)
    return r

def varint(b, i):
    v = s = 0
    while True:
        x = b[i]; i += 1; v |= (x & 127) << s; s += 7
        if not x & 128: return v, i

def ipns_record(b):
    """IpnsEntry protobuf: 1 value, 3 validity, 5 sequence, 6 ttl (and V2 data); -> dict."""
    f, i = {}, 0
    while i < len(b):
        key, i = varint(b, i); fn, wt = key >> 3, key & 7
        if wt == 0: v, i = varint(b, i)
        elif wt == 2: n, i = varint(b, i); v = b[i:i + n]; i += n
        else: raise ValueError("wire type %d" % wt)
        f[fn] = v
    return {"value": f.get(1, b"").decode("utf-8", "replace"), "validity": f.get(3, b"").decode("utf-8", "replace"),
            "sequence": f.get(5), "ttlNs": f.get(6), "bytes": len(b)}

def keep(r, note=None, show=0):
    body = r.pop("_body", b"")
    if show and body: r["sample"] = body[:show].decode("utf-8", "replace")
    if note: r["note"] = note
    out["checks"].append(r); return body

records = {}
for label, url in [("publisher-app", f"{PUB}/routing/v1/ipns/{NAME}"), ("delegated-ipfs.dev", f"https://delegated-ipfs.dev/routing/v1/ipns/{NAME}")]:
    r = get(url, accept="application/vnd.ipfs.ipns-record"); body = keep(r)
    if r.get("status") == 200 and body:
        try: records[label] = ipns_record(body); r["record"] = records[label]
        except Exception as e: r["decodeError"] = str(e)
keep(get(f"{PUB}/api/status"), show=4000)
keep(get(f"{PUB}/ipni/v1/ad/head"), show=600)

cids = sorted({rec["value"].removeprefix("/ipfs/").split("/")[0] for rec in records.values() if rec["value"].startswith("/ipfs/")})
out["recordCids"] = cids
for cid in cids:
    keep(get(f"https://delegated-ipfs.dev/routing/v1/providers/{cid}", accept="application/json"), show=3000)
    keep(get(f"https://cid.contact/routing/v1/providers/{cid}", accept="application/json"), show=3000)
    keep(get(f"https://trustless-gateway.link/ipfs/{cid}?format=raw", accept="application/vnd.ipld.raw"), note="root block via a public trustless gateway")
    keep(get(f"https://ipfs.enclave.host/ipfs/{cid}/", method="HEAD"), note="Enclave's own HTTPS IPFS front")
    keep(get(f"https://dweb.link/ipfs/{cid}/", method="HEAD"), note="public gateway by CID")
keep(get(f"https://ipfs.io/ipns/{NAME}/", method="HEAD"), note="public gateway by IPNS name")
keep(get(f"https://ipfs.enclave.host/ipns/{NAME}/", method="HEAD"), note="Enclave front by IPNS name")
pathlib.Path(__file__).with_name("probe1.json").write_text(json.dumps(out, indent=1))
print(json.dumps({"records": records, "cids": cids, "statuses": [(c["url"][:90], c.get("status"), c.get("error", "")[:80], c["seconds"]) for c in out["checks"]]}, indent=1))
