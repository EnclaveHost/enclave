#!/usr/bin/env python3
# Read-only: every 15 s, each directory's providers (seconds of qualification left per provider, per checker) and
# route label count + cron addresses. Bounded: 10 s per request.
import json, time, urllib.request, sys, datetime
F = {"usw": "134.199.235.187", "cae": "146.190.246.39", "aps": "165.245.191.129", "euc": "134.209.248.172"}
ROUNDS = int(sys.argv[1]) if len(sys.argv) > 1 else 24
def get(ip, p):
    return json.load(urllib.request.urlopen(f"http://{ip}:8188{p}", timeout=10))
for i in range(ROUNDS):
    now = time.time() * 1000; row = {"at": datetime.datetime.now(datetime.UTC).strftime("%H:%M:%SZ")}
    for n, ip in F.items():
        o = {}
        try:
            d = get(ip, "/v1/network/providers")
            for p in d["providers"]:
                a = p["record"]["record"]["address"].split(".")[-1]
                qs = p.get("qualifications") or []
                o[a] = sorted(int((q["qualification"]["expiresAt"] - now) / 1000) for q in qs)
        except Exception as e:
            o["perr"] = str(e)[:60]
        try:
            r = get(ip, "/v1/network/routes"); c = r["labels"].get("38f368d6")
            o["labels"] = len(r["labels"]); o["cron"] = [x.split(".")[-1] for x in c["addresses"]] if c else None
        except Exception as e:
            o["rerr"] = str(e)[:60]
        row[n] = o
    print(json.dumps(row), flush=True)
    if i < ROUNDS - 1: time.sleep(15)
