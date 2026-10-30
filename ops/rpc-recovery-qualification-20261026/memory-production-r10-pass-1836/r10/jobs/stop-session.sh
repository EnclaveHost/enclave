#!/bin/bash
# composite-mdbx-validation-stage/r10 stop (PREPARED by Claude 1829/1833; NOT run by Claude). Root 1828 #1: stops ONE r10 production runtime:
#   bash composite-mdbx-validation-stage/r10/jobs/stop-session.sh <r10 runs/prod-ID>/session
# memory_gate.py stop: pidfd of the PID in SESSION/session.pid, then its start time, owner and EXACT argv (/usr/bin/python3 -I -B
# <r10>/memory_gate.py runtime --tree-root-pid N -- ... --run-dir SESSION ... --expect-kind production, no fixture exec) are checked and
# SIGTERM goes through that pidfd only. The runtime then cancels in r6 order (validator, unmount, servers). Never the r6 helper, never a
# process group, never the queue. rc 0 signalled; 3 refused.
set -u
exec python3 -I -B /home/steven/Documents/Codex/2026-10-18/wo/work/rpc-production-final-20261025/composite-mdbx-validation-stage/r10/memory_gate.py stop "${1:?SESSION_DIR}"
