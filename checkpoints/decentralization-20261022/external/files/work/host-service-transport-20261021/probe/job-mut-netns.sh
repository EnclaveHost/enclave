#!/bin/bash
# One queue job (512): the auth-boundary mutation suite (unmutated baseline first), then the real-kernel netns e2e.
set -uo pipefail
H=$(cd "$(dirname "$0")/.." && pwd)
rc=0
echo "== mutation"; python3 "$H/probe/mutate.py" || rc=1
echo "== netns e2e"; bash "$H/probe/netns-job.sh" || rc=1
exit $rc
