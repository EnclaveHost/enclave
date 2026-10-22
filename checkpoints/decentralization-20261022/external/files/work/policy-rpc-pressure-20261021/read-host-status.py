#!/usr/bin/env python3
# ONE public GET of nucbox-k11-4's /v1/deployments (the console's public view), filtered to the audit's allowed fields:
# id prefix, status, rate6, leaseUntil, walletHeld, provenAt, and whether an isolation block exists. Nothing else is kept.
import json, sys, urllib.request, datetime
URL = "https://api.enclave.host/t/nucbox-k11-4/v1/deployments"
at = datetime.datetime.now(datetime.timezone.utc).isoformat()
req = urllib.request.Request(URL, headers={"user-agent": "policy-pressure-audit/1"})
with urllib.request.urlopen(req, timeout=20) as r:
    status = r.status
    body = json.loads(r.read(4 * 1024 * 1024))
rows = []
for d in body.get("deployments", []):
    did = str(d.get("id", ""))
    rows.append({"id": did[:10], "status": d.get("status"), "rate6": d.get("rate6"), "leaseUntil": d.get("leaseUntil"),
                 "walletHeld": d.get("walletHeld"), "provenAt": d.get("provenAt"), "isolation": bool(d.get("isolation"))})
out = {"at": at, "url": URL, "http": status, "count": len(rows), "rows": rows}
json.dump(out, open(sys.argv[1], "w"), indent=1)
print(json.dumps(out)[:3000])
