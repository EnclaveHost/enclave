#!/usr/bin/env python3
"""ONE round of read-only public probes of the pinned EnclaveDNS CID, sequential, each bounded (no retries):
direct (7ae476a3.app.enclave.host pinned to the Frankfurt address root used) and canonical (ipfs.enclave.host).
Records status, curl exit, timing (connect/tls/first byte/total), byte counts, response header NAMES + a few safe values,
and for non-200 small JSON bodies the error text. curl -v connection lines are kept (no headers with credentials exist:
no Authorization is sent). -> probes1.json"""
import json, subprocess, datetime, pathlib, re
here = pathlib.Path(__file__).resolve().parent
CID = "bafybeic3peeqxip4w2sxz66krxbhkjygfnkqyigdgvoajw6moykvtkfeau"
D = "https://7ae476a3.app.enclave.host"; DR = "7ae476a3.app.enclave.host:443:134.209.248.172"; C = "https://ipfs.enclave.host"
W = '{"code":"%{http_code}","ver":"%{http_version}","connect":%{time_connect},"tls":%{time_appconnect},"ttfb":%{time_starttransfer},"total":%{time_total},"down":%{size_download},"hdr":%{size_header}}'
def run(label, url, resolve=None, extra=(), maxtime=60):
    body = here / f"p1-{label}.body"
    cmd = ["curl", "-sS", "-v", "--max-time", str(maxtime), "--max-filesize", "6000000", "-o", str(body), "-D", "-", "-w", "\n@@W@@" + W] + list(extra) + [url]
    if resolve: cmd += ["--resolve", resolve]
    t = datetime.datetime.now(datetime.timezone.utc).isoformat()
    r = subprocess.run(cmd, capture_output=True, text=True, errors="replace", timeout=maxtime + 15)
    head, _, w = r.stdout.rpartition("\n@@W@@")
    out = {"label": label, "at": t, "curlExit": r.returncode, "w": json.loads(w) if w.startswith("{") else w}
    out["headers"] = [l.strip() for l in head.splitlines() if re.match(r"(?i)^(HTTP/|server|content-type|content-length|transfer-encoding|x-ipfs|etag|via|connection|date)", l.strip())]
    out["verbose"] = [l[:200] for l in r.stderr.splitlines() if l.startswith("*") and not re.search(r"(?i)certificate|subject|issuer|expire|start date|SSL connection using|ALPN|CAfile|CApath", l)][-14:]
    if body.exists():
        b = body.read_bytes(); out["bodyBytes"] = len(b)
        if out["w"] and isinstance(out["w"], dict) and out["w"]["code"] != "200" and len(b) < 2000:
            out["bodyText"] = b.decode("utf-8", "replace")[:400]
        if label.endswith("raw-root") and b: out["rawRootFirstBytes"] = b[:8].hex()
    return out
P = [("direct-head-car", f"{D}/ipfs/{CID}?format=car", DR, ["-I"]),
     ("direct-raw-root", f"{D}/ipfs/{CID}?format=raw", DR, []),
     ("direct-range1", f"{D}/ipfs/{CID}", DR, ["-r", "0-0"]),
     ("direct-status", f"{D}/api/status", DR, []),
     ("canonical-raw-root", f"{C}/ipfs/{CID}?format=raw", None, []),
     ("direct-get-car", f"{D}/ipfs/{CID}?format=car", DR, [])]
res = [run(l, u, r, e) for (l, u, r, e) in P]
for x in res:
    if x["label"] == "direct-status":
        try:
            s = json.loads((here / "p1-direct-status.body").read_text()); x["status"] = {k: s.get(k) for k in ("app", "state", "files", "totalBytes", "dagNodes", "rootCid", "uptime")}
        except Exception as e: x["status"] = str(e)[:100]
(here / "probes1.json").write_text(json.dumps(res, indent=1) + "\n"); print(json.dumps(res)[:300])
