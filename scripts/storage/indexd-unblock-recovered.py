#!/usr/bin/env python3
"""Unblock Sia hosts the indexer blocked for uptime that pass every usability check again.

Run as root on the indexd machine (it reads the admin password from indexd.yml).
indexd lifts a usability block by itself only for hosts WITHOUT an active
contract. A host that holds our sectors stays blocked until its contract ends,
and while it is blocked the indexer leaves it out of the host list it gives to
apps, so its sectors cannot be read. After an outage on our side (2026-11-16:
the storage VM could not resolve names for 61 hours) that took 47 of 94 contract
hosts out for good, although every one of them answered again.

Only hosts whose single block reason is "Uptime" and whose usability checks all
pass are touched: price, collateral and manual blocks stay. Without --apply it
only reports.
"""
import base64
import collections
import json
import sys
import urllib.request
from pathlib import Path

import yaml

CONFIG = Path(sys.argv[sys.argv.index("--config") + 1]) if "--config" in sys.argv else Path("/etc/enclave-indexd/indexd.yml")
cfg = yaml.safe_load(CONFIG.read_text())
addr = cfg["adminAPI"].get("address", "127.0.0.1:9980")
BASE = "http://" + (("127.0.0.1" + addr) if addr.startswith(":") else addr) + "/api/"
AUTH = "Basic " + base64.b64encode((":" + cfg["adminAPI"]["password"]).encode()).decode()


def call(method, path):
    req = urllib.request.Request(BASE + path, method=method)
    req.add_header("Authorization", AUTH)
    with urllib.request.urlopen(req, timeout=30) as r:
        body = r.read()
        return json.loads(body) if body else None


def page(path):
    out, off = [], 0
    while True:
        chunk = call("GET", f"{path}?limit=500&offset={off}")
        out += chunk
        off += len(chunk)
        if len(chunk) < 500:
            return out


hosts, contracts = page("hosts"), page("contracts")
active = {c["hostKey"] for c in contracts if c["state"] == "active"}
blocked = [h for h in hosts if h.get("blocked") and h["publicKey"] in active]
uptime_only = [h for h in blocked if (h.get("blockedReasons") or []) == ["Uptime"]]
recovered = [h for h in uptime_only if all(h["usability"].values())]
print(json.dumps({
    "activeContractHosts": len(active),
    "goodContracts": sum(1 for c in contracts if c["good"]),
    "blockedContractHosts": dict(collections.Counter(",".join(h.get("blockedReasons") or []) for h in blocked)),
    "uptimeOnly": len(uptime_only),
    "recovered": len(recovered),
}))
if "--apply" in sys.argv:
    done = 0
    for h in recovered:
        try:
            call("DELETE", "hosts/blocklist/" + h["publicKey"])
            done += 1
        except Exception as e:  # one refused host must not keep the others blocked
            print("not unblocked", h["publicKey"][:24], repr(e)[:160], file=sys.stderr)
    print(json.dumps({"unblocked": done}))
    if done != len(recovered):
        sys.exit(1)
