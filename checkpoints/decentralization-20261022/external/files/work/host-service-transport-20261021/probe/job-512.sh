#!/bin/bash
# One 512 job after the review fixes: every Node group, the auth/review mutation suite, the real-kernel netns e2e.
set -uo pipefail
H=$(cd "$(dirname "$0")/.." && pwd); rc=0
echo "== node groups"; bash "$H/probe/node-final.sh" || rc=1
echo "== mutation"; python3 "$H/probe/mutate.py" || rc=1
echo "== netns e2e"; bash "$H/probe/netns-job.sh" || rc=1
echo "JOB-512-RC=$rc"; exit $rc
