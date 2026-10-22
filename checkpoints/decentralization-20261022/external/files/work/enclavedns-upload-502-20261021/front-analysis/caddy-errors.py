#!/usr/bin/env python3
"""READ-ONLY: on each front, the enclave-bootstrap-tls (public Caddy) journal since 18:00Z, filtered REMOTELY to lines
naming add-wasm, the pinned CID, or level error/warn; parsed LOCALLY and reduced to: ts, level, logger, msg, method, path
(no query values beyond format), status, duration, upstream, error text (200 chars). No headers, client IPs, bodies or
config. Raw lines are never written. -> caddy-errors.json"""
import json, subprocess, datetime, re
CID = "bafybeic3peeqxip4w2sxz66krxbhkjygfnkqyigdgvoajw6moykvtkfeau"
REMOTE = ("journalctl -u enclave-bootstrap-tls.service --since '2026-10-21 18:00:00 UTC' -o cat --no-pager 2>/dev/null"
          " | grep -E 'add-wasm|" + CID[:20] + "|\"level\":\"(error|warn)\"' | tail -n 400")
out = {}
for h in ["eu-central", "us-west", "ap-southeast", "ca-east"]:
    r = subprocess.run(["timeout", "60", "ssh", "-n", "-o", "BatchMode=yes", "-o", "ConnectTimeout=15", h, REMOTE], capture_output=True, text=True, errors="replace")
    ev = []
    for l in r.stdout.splitlines():
        try: j = json.loads(l)
        except Exception: ev.append({"unparsed": re.sub(r"\d+\.\d+\.\d+\.\d+", "<ip>", l)[:160]}); continue
        rq = j.get("request") or {}
        uri = str(rq.get("uri", ""))
        path, _, q = uri.partition("?")
        ts = j.get("ts"); ts = datetime.datetime.fromtimestamp(ts, datetime.timezone.utc).strftime("%H:%M:%S.%f")[:-3] if isinstance(ts, (int, float)) else ts
        ev.append({"ts": ts, "level": j.get("level"), "logger": j.get("logger"), "msg": str(j.get("msg", ""))[:120], "method": rq.get("method"),
                   "host": rq.get("host"), "path": path[:120], "format": (re.search(r"format=([a-z]+)", q) or [None, None])[1],
                   "status": j.get("status"), "duration": j.get("duration"), "upstream": j.get("upstream"),
                   "error": re.sub(r"\d+\.\d+\.\d+\.\d+:\d+->", "<local>->", str(j.get("error", "")))[:200] if j.get("error") else None})
    out[h] = {"rc": r.returncode, "events": ev}
json.dump(out, open("caddy-errors.json", "w"), indent=1); print({h: len(v["events"]) for h, v in out.items()})
