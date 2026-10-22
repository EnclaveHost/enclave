# READ-ONLY, bounded probe 3 (GET/HEAD only, 30 s per request, <=64 KiB read). Separates the failure modes:
#   V. the publisher's value source (config value https://ipfs.enclave.host/site-root): what it answers
#   H. ipfs.enclave.host as an HTTP-retrieval (trustless gateway) provider: the boxo/rainbow probe CID bafkqaaa,
#      a raw child block, a CAR of the root entity, HTTP/2
#   G. public gateways by CID vs by IPNS name (subdomain form, no redirect follow), so name and content are separated
import json, time, ssl, socket, urllib.request, urllib.error, datetime, pathlib, http.client

NAME = "k51qzi5uqu5dma8l0w05o02gkz7l80f3r3mb536qh8fuhrr2qj4nsa2afe9b52"
CID = "bafybeieuxt6vy424gnmtb5eo6mey6x5p5xbu2mpr4xkiwvz25cbeotzaou"     # IPNS seq 1026 (valid to 2026-10-28)
PROD = "bafybeig3rai3tyoimbhb32vo6hkkw3o336wluht7owbs7mefhtiridwp6y"    # what enclave.host serves (Caddy Last-Modified 10-20 02:20)
out = {"at": datetime.datetime.now(datetime.timezone.utc).isoformat(), "checks": []}

class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *a, **k): return None
opener = urllib.request.build_opener(NoRedirect)

def get(url, method="GET", accept=None, limit=65536, note=None, show=300):
    t0 = time.time(); r = {"url": url, "method": method, "note": note}
    try:
        req = urllib.request.Request(url, method=method, headers={"User-Agent": "enclave-ens-diagnosis/3", **({"Accept": accept} if accept else {})})
        with opener.open(req, timeout=30) as res:
            b = res.read(limit) if method == "GET" else b""
            r.update(status=res.status, headers=dict((k, v) for k, v in res.headers.items() if k.lower() in ("content-type", "content-length", "location", "server", "x-ipfs-path", "x-ipfs-roots", "cache-control")), bytes=len(b))
            if show and b: r["sample"] = b[:show].decode("utf-8", "replace")
            r["_raw"] = b
    except urllib.error.HTTPError as e:
        r.update(status=e.code, headers={k: v for k, v in e.headers.items() if k.lower() in ("location", "server", "content-type")}, sample=e.read(300).decode("utf-8", "replace"))
    except Exception as e:
        r["error"] = f"{type(e).__name__}: {e}"
    r["seconds"] = round(time.time() - t0, 2); out["checks"].append(r); return r

# V
v = get("https://ipfs.enclave.host/site-root", note="publisher value source (deployment config `value`)", show=200)
# H
get("https://ipfs.enclave.host/ipfs/bafkqaaa?format=raw", method="HEAD", accept="application/vnd.ipld.raw", note="boxo httpnet connectivity probe (HEAD)")
get("https://ipfs.enclave.host/ipfs/bafkqaaa?format=raw", accept="application/vnd.ipld.raw", note="boxo httpnet connectivity probe (GET)", show=0)
root = get(f"https://ipfs.enclave.host/ipfs/{CID}", accept="application/vnd.ipld.raw", note="root block by Accept only (no ?format)", show=0)
car = get(f"https://ipfs.enclave.host/ipfs/{CID}?format=car&dag-scope=entity", accept="application/vnd.ipld.car", note="root entity CAR", show=0, limit=1 << 20)
for r in (root, car): r.pop("_raw", None)
try:   # HTTP/2 offered by the front? (ALPN)
    ctx = ssl.create_default_context(); ctx.set_alpn_protocols(["h2", "http/1.1"])
    with socket.create_connection(("ipfs.enclave.host", 443), timeout=15) as s, ctx.wrap_socket(s, server_hostname="ipfs.enclave.host") as t:
        out["alpn"] = t.selected_alpn_protocol()
except Exception as e: out["alpnError"] = str(e)
# G
get(f"https://{CID}.ipfs.dweb.link/", method="HEAD", note="public gateway by CID (seq-1026 site)")
get(f"https://{NAME}.ipns.dweb.link/", method="HEAD", note="public gateway by IPNS name")
get(f"https://{PROD}.ipfs.dweb.link/", method="HEAD", note="public gateway by CID (current enclave.host site, no providers)")
for c in out["checks"]: c.pop("_raw", None)
pathlib.Path(__file__).with_name("probe3.json").write_text(json.dumps(out, indent=1))
print(json.dumps(out, indent=1)[:9000])
