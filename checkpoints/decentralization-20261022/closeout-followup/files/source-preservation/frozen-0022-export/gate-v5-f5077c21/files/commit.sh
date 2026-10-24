#!/bin/bash
set -euo pipefail
cd "$(dirname "$0")"
FILES=".gitignore PROPOSAL.md V4-TO-V5.diff verify-operational-v4.py verify-operational-v5.py apphealth.py guestrows.py q.sh scan.sh mutants-v5.py commit.sh tests/test_gate_v5.py $(ls logs/t*.out logs/t*.guard.log logs/t*.rc)"
bash scan.sh $FILES
git add -- $FILES
extra=$(comm -23 <(git ls-files | sort) <(printf '%s\n' $FILES | sort)); [ -z "$extra" ] || { echo "unexpected: $extra"; exit 1; }
git -c user.name=SteveDeFacto -c user.email=5148995+SteveDeFacto@users.noreply.github.com commit -q -m "operational gate v5 proposal: one bounded window reset on a transient app transport error (source only, root review)

v4 + one rule: after the window starts, a poll whose ONLY problem is no HTTP response (timeout/refused/reset/disconnect/DNS)
restarts the full 420 s window with new vouch cycles, at most once; the deadline never extends; HTTP status, payload, TLS,
availability, vouch, guest and journal faults FAIL as in v4. Real-subprocess fixture tests 11/11, focused mutants 7/7.
Limits: late transients still FAIL at the deadline; a reset can exceed the 1440 s lease budget; rollback re-registration cost."
git log -1 --format='%H %an <%ae>'
