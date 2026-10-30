#!/bin/bash
# state-production-validation-stage/r2: ordered stop of ONE state runtime (pidfd + start time + exact argv; composite r10 stop_session
# with this state_gate.py as the script). Usage: bash jobs/stop-session.sh <runs/prod-ID/session>
set -u
exec python3 -I -B /home/steven/Documents/Codex/2026-10-18/wo/work/rpc-production-final-20261025/state-production-validation-stage/r2/state_gate.py stop "${1:?SESSION_DIR}"
