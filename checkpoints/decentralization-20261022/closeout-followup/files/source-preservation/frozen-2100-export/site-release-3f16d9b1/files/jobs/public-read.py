#!/usr/bin/env python3
# bounded read-only public probe: publisher status, front index/ledger hashes. No auth, no writes.
import json, hashlib, datetime, urllib.request
out = {"at": datetime.datetime.now(datetime.timezone.utc).isoformat(), "readOnly": True, "reads": []}
def get(url, cap=4 << 20):
    r = {"url": url}
    try:
        req = urllib.request.Request(url, headers={"user-agent": "enclave-release-check/1"})
        with urllib.request.urlopen(req, timeout=15) as resp:
            b = resp.read(cap + 1)
            r.update(status=resp.status, bytes=len(b), sha256=hashlib.sha256(b).hexdigest(), oversize=len(b) > cap,
                     headers={k: v for k, v in resp.headers.items() if k.lower() in ("etag", "x-ipfs-path", "x-ipfs-roots", "last-modified", "content-type")})
            r["_body"] = b
    except Exception as e:
        r["error"] = str(e)[:200]
    return r
st = get("https://d9798e4c.app.enclave.host/api/status", 65536)
if "_body" in st:
    j = json.loads(st.pop("_body"))
    st["publicStatus"] = {k: j[k] for k in ["name", "sequence", "value", "validUntil", "publishedAt", "mode"] if k in j}
out["reads"].append(st)
for u in ["https://enclave.host/", "https://enclave.host/index.html", "https://enclave.host/.well-known/enclave-site-release.json", "https://enclave.host/dashboard.html"]:
    r = get(u); body = r.pop("_body", None)
    if body is not None and u.endswith(".json") and r.get("status") == 200:
        try: r["json"] = json.loads(body)
        except Exception: pass
    out["reads"].append(r)
print(json.dumps(out, indent=1))
