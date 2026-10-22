# READ-ONLY, bounded probe 4 (GET/HEAD only; 30 s per request; boxo httpnet's exact request shape:
# GET <base>/ipfs/<cid>?format=raw, Accept: application/vnd.ipld.raw). Can a gateway fetch the CHILD blocks of the
# IPNS target from ipfs.enclave.host once connected? The root block is parsed (dag-pb links), then the first links and
# their own first links are fetched and hash-verified against their CIDs; HEAD is checked too (boxo uses it for HAVEs).
import json, time, hashlib, base64, urllib.request, urllib.error, datetime, pathlib

CID = "bafybeieuxt6vy424gnmtb5eo6mey6x5p5xbu2mpr4xkiwvz25cbeotzaou"
BASE = "https://ipfs.enclave.host"
out = {"at": datetime.datetime.now(datetime.timezone.utc).isoformat(), "blocks": []}

def b32(b): return "b" + base64.b32encode(b).decode().lower().rstrip("=")
def unb32(s): s = s[1:].upper(); return base64.b32decode(s + "=" * (-len(s) % 8))
def varint(b, i):
    v = s = 0
    while True:
        x = b[i]; i += 1; v |= (x & 127) << s; s += 7
        if not x & 128: return v, i
def pb_fields(b):
    i, f = 0, []
    while i < len(b):
        k, i = varint(b, i); fn, wt = k >> 3, k & 7
        if wt == 0: v, i = varint(b, i)
        elif wt == 2: n, i = varint(b, i); v = b[i:i + n]; i += n
        else: raise ValueError(wt)
        f.append((fn, v))
    return f
def links(block):   # PBNode: field 2 = PBLink {1 Hash, 2 Name, 3 Tsize}
    out = []
    for fn, v in pb_fields(block):
        if fn == 2:
            l = dict(pb_fields(v)); out.append((l.get(2, b"").decode("utf-8", "replace"), b32(l[1])))
    return out
def fetch(cid, method="GET"):
    t0 = time.time(); r = {"cid": cid, "method": method}
    try:
        req = urllib.request.Request(f"{BASE}/ipfs/{cid}?format=raw", method=method, headers={"Accept": "application/vnd.ipld.raw", "User-Agent": "enclave-ens-diagnosis/4"})
        with urllib.request.urlopen(req, timeout=30) as res:
            b = res.read(4 << 20) if method == "GET" else b""
            r.update(status=res.status, server=res.headers.get("Server"), type=res.headers.get("Content-Type"), bytes=len(b))
            if method == "GET":
                raw = unb32(cid); mh = raw[2:]          # CIDv1: version, codec (1-byte varints for 0x70/0x55), multihash
                r["hashOk"] = mh[:2] == b"\x12\x20" and hashlib.sha256(b).digest() == mh[2:34]
                r["_b"] = b
    except urllib.error.HTTPError as e: r.update(status=e.code, server=e.headers.get("Server"), sample=e.read(200).decode("utf-8", "replace"))
    except Exception as e: r["error"] = f"{type(e).__name__}: {e}"
    r["seconds"] = round(time.time() - t0, 2); return r

root = fetch(CID); rb = root.pop("_b", b""); out["blocks"].append(root)
first = links(rb) if root.get("hashOk") else []
out["rootLinks"] = [n for n, _ in first]
picked = [x for x in first if x[0] in ("index.html", "404.html", "js", "css")] or first[:4]
for name, c in picked[:4]:
    r = fetch(c); b = r.pop("_b", b""); r["name"] = name; out["blocks"].append(r)
    h = fetch(c, "HEAD"); h["name"] = name; out["blocks"].append(h)
    if r.get("hashOk") and c.startswith("bafybei"):             # one level deeper for a directory
        for n2, c2 in links(b)[:2]:
            r2 = fetch(c2); r2.pop("_b", None); r2["name"] = f"{name}/{n2}"; out["blocks"].append(r2)
pathlib.Path(__file__).with_name("probe4.json").write_text(json.dumps(out, indent=1))
print(json.dumps(out, indent=1))
