#!/bin/bash
# Stop ONE composite session: SIGTERM to the PID recorded in RUN_DIR/session.pid, only if that PID still has the recorded start time
# and runs composite_session.py with this --run-dir. Never signals any other process (the session ends its own children itself).
set -uo pipefail
RUN=${1:?RUN_DIR}
python3 -I -B - "$RUN" <<'PY'
import json, os, signal, sys
run = sys.argv[1]
with open(os.path.join(run, "session.pid")) as f:
    s = json.load(f)
pid = int(s["pid"])
with open(f"/proc/{pid}/stat", "rb") as f:
    st = f.read().decode(errors="replace")
with open(f"/proc/{pid}/cmdline", "rb") as f:
    cmd = f.read().split(b"\0")
if int(st[st.rfind(")") + 2:].split()[19]) != s["startTime"] or b"--run-dir" not in cmd or cmd[cmd.index(b"--run-dir") + 1] != run.encode() \
        or not any(c.endswith(b"composite_session.py") for c in cmd):
    sys.exit("REFUSED: that PID is not this run's session (exited or reused)")
os.kill(pid, signal.SIGTERM); print(f"SIGTERM sent to session {pid}")
PY
