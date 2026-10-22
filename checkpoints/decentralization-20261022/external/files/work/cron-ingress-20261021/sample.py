#!/usr/bin/env python3
# Read-only: every 15 s for ROUNDS rounds, each front's public directory routes (cron's addresses, label count) and
# each ns-* answer for cron. Bounded: 10 s per request.
import json, subprocess, time, urllib.request, sys, datetime
F = {"us-west": "134.199.235.187", "ca-east": "146.190.246.39", "ap-southeast": "165.245.191.129", "eu-central": "134.209.248.172"}
ROUNDS = int(sys.argv[1]) if len(sys.argv) > 1 else 12
for i in range(ROUNDS):
    t = datetime.datetime.utcnow().strftime("%H:%M:%SZ"); row = {"at": t}
    for n, ip in F.items():
        try:
            s = time.time(); d = json.load(urllib.request.urlopen(f"http://{ip}:8188/v1/network/routes", timeout=10))
            c = d["labels"].get("38f368d6"); row[n] = {"dir": c["addresses"] if c else None, "labels": len(d["labels"]), "ms": int((time.time() - s) * 1000), "updatedAt": d.get("updatedAt")}
        except Exception as e:
            row[n] = {"dir": "ERR " + str(e)[:80]}
        try:
            a = subprocess.run(["dig", "+short", "+norecurse", "+time=3", "+tries=1", f"@{ip}", "38f368d6.app.enclave.host", "A"], capture_output=True, text=True, timeout=8).stdout.split()
            row[n]["dns"] = sorted(a)
        except Exception as e:
            row[n]["dns"] = "ERR " + str(e)[:60]
    print(json.dumps(row), flush=True)
    if i < ROUNDS - 1: time.sleep(15)
