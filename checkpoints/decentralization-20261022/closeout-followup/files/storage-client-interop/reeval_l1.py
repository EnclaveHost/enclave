#!/usr/bin/env python3
"""Offline re-evaluation of run l1's ONE failed check from its recorded evidence (no test re-run): the ballot generation
reported by /healthz compared NUMERICALLY with the lease16 generation and with indexd's installed fence bytes.
The original FAIL stays in runs/l1/results.json unchanged."""
import hashlib, json, os, sys
src = "runs/l1/results.json"; out = "logs/reeval-l1.json"
d = json.load(open(src))
gen1 = (16 << 48) | (52515800 << 16) | 3
ballot = d["healthzClaim1"]["writerFence"]["ballot"]["gen"]
fence = d["db"]["afterEnrollment"]["fenceHex"]
orig = [c for c in d["checks"] if c["name"].startswith("C: the ballot generation")][0]
res = {"source": src, "sourceSha256": hashlib.sha256(open(src, "rb").read()).hexdigest(), "originalCheck": orig,
       "cause": "harness compared strings: healthz prints the u64 unpadded (0x10032153d80003), the driver expected 16-digit zero padding (0x0010032153d80003)",
       "ballotGenReported": ballot, "expectedGen": hex(gen1), "fenceFirst8BytesHex": fence[:16],
       "ballotEqualsLease16Gen": int(ballot, 16) == gen1, "dbFenceEqualsLease16Gen": int(fence[:16], 16) == gen1, "ballotEqualsDbFence": int(ballot, 16) == int(fence[:16], 16)}
res["correctedVerdict"] = "PASS" if res["ballotEqualsLease16Gen"] and res["dbFenceEqualsLease16Gen"] and res["ballotEqualsDbFence"] else "FAIL"
fd = os.open(out, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o644)
os.write(fd, (json.dumps(res, indent=1) + "\n").encode()); os.close(fd)
print(json.dumps({k: res[k] for k in ("ballotGenReported", "expectedGen", "fenceFirst8BytesHex", "correctedVerdict")}))
sys.exit(0 if res["correctedVerdict"] == "PASS" else 1)
