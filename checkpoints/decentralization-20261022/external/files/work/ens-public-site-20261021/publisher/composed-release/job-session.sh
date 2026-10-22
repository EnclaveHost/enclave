#!/bin/bash
# read-only: the stored session's PUBLIC on-chain status; only whitelisted public fields are kept
cd "$(dirname "$0")"
env -u ENCLAVE_KEY -u ENCLAVE_SESSION node /home/steven/Documents/Codex/2026-10-18/wo/work/enclave/cli/enclave.mjs --json session status 2>session-status.err | python3 -c '
import json,sys
t=sys.stdin.read(); 
try: d=json.loads(t[t.index("{"):])
except Exception as e: print(json.dumps({"error":"no JSON","detail":str(e)[:100]})); sys.exit(1)
keep=["sid","state","live","source","owner","vault","label","balance6","spent6","periodSpent6","perPeriod6","periodEndsAt","periodOps","opsPerPeriod","maxFee6","expiresAt","actions","environments","apps"]
print(json.dumps({k:d.get(k) for k in keep},indent=1))' > session-status.json; rc=${PIPESTATUS[0]}
tail -c 300 session-status.err; echo rc=$rc
