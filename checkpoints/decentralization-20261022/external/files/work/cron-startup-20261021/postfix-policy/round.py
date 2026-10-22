#!/usr/bin/env python3
"""ONE read-only round: ../probe.py grep of node.log (its in-session watchdog + redaction; log tail only, matching lines
only) for policy / quorum / retire / renew / tick lines, filtered to lines AFTER the 15:01:03Z agent restart, classified.
Appends to rounds.jsonl. Usage: round.py <n>"""
import json, re, subprocess, sys, datetime, pathlib
HERE = pathlib.Path(__file__).resolve().parent; SINCE = "15:01:03"
pats = "38f368d6|wallet policy|chain quorum|RPC failure|retired|renew|tick:|not taking|gave up|giving up|released|lease lapsed|stopped "
r = subprocess.run(["python3", str(HERE.parent / "probe.py"), "grep", "node.log", "--tail", "40000", "--max", "300", "--pat", pats,
                    "--not", "isolation adopted"], capture_output=True, text=True, timeout=200)
raw = r.stdout
try: d, _ = json.JSONDecoder().raw_decode(raw[raw.index("{"):])
except Exception: d = {"error": "unparsed", "stderr": r.stderr[-300:]}
lines = (d.get("node.log") or {}).get("lines") or []
after = [l for l in lines if (m := re.match(r"node\.log: (\d\d:\d\d:\d\d) ", l)) and m.group(1) >= SINCE]
cls = {"walletUnknown": r"wallet policy unavailable", "rpcReasons": r"RPC failure", "retired": r"retired",
       "renewFailed": r"renew(al)? failed|NOT renewed|not renewed|renew .*failed", "renewed": r"\brenewed\b", "tickError": r"\btick: ",
       "claimRefused": r"not taking", "released": r"\breleased?\b", "stopped": r"stopped ", "cron": r"38f368d6"}
counts = {k: sum(1 for l in after if re.search(p, l)) for k, p in cls.items()}
rec = {"round": int(sys.argv[1]), "at": datetime.datetime.now(datetime.timezone.utc).isoformat(timespec="seconds"), "since": SINCE + "Z",
       "matchesInTail": (d.get("node.log") or {}).get("matches"), "linesAfterRestart": len(after), "counts": counts,
       "lines": [l[:320] for l in after[-60:]], "probeError": d.get("error")}
with open(HERE / "rounds.jsonl", "a") as f: f.write(json.dumps(rec) + "\n")
print(json.dumps({k: rec[k] for k in ("round", "at", "linesAfterRestart", "counts", "probeError")}))
for l in after[-25:]: print("  ", l[:260])
