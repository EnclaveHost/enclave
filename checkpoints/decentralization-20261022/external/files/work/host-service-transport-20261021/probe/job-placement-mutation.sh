#!/bin/bash
# One queue job: hosted-service-placement on the now-complete tree, then the auth-boundary mutation suite (baseline first).
set -uo pipefail
H=$(cd "$(dirname "$0")/.." && pwd)
rc=0
bash "$H/probe/node-rerun2.sh" || rc=1
python3 "$H/probe/mutate.py" || rc=1
exit $rc
