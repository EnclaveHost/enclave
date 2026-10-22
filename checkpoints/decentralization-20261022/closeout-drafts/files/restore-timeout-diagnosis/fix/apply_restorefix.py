#!/usr/bin/env python3
"""apply the restore-timeout fix (restore-timeout-diagnosis) to a COPY of an r5 controller: exact text replacements,
each of which must match exactly once. Usage: apply_restorefix.py <copy.py>"""
import sys
from pathlib import Path

DOC_OLD = "    own file. Only our own temp is ever removed.\n"
DOC_NEW = (
    "    own file. Only our own temp is ever removed.\n"
    "  restore-timeout fix (restore-timeout-diagnosis, after integration run a7e53855b0f9f535):\n"
    "  - PostgreSQL is PID 1 of its container (no --init), so it reaps every process orphaned inside the container, and\n"
    "    a reaped child that died from a signal is a crashed \"untracked child process\" to it: every session is ended and\n"
    "    the server reinitializes. Plain `timeout -s KILL` (GNU) also KILLs its own process group, itself included, so\n"
    "    the killed pg_restore was orphaned to the postmaster and the restore bound crash-restarted the whole server.\n"
    "  - the restore now runs as `exec timeout --foreground -s KILL`: timeout KILLs pg_restore only, stays alive and\n"
    "    reaps it itself (exit 137). The container's timeout must be GNU coreutils (BusyBox has no --foreground and\n"
    "    always leaves an orphaned watcher); otherwise nothing is created.\n")
PROBE_OLD = ('    r = subprocess.run(["docker", "exec", node["pg_container"], "sh", "-c", "command -v timeout"], capture_output=True, timeout=qb.cap(60))\n'
             '    if r.returncode != 0:\n'
             '        rep["problems"].append("no `timeout` in the database container: the restore cannot be bounded; nothing created")\n')
PROBE_NEW = ('    r = subprocess.run(["docker", "exec", node["pg_container"], "timeout", "--version"], capture_output=True, timeout=qb.cap(60))\n'
             '    if r.returncode != 0 or "GNU coreutils" not in r.stdout.decode(errors="replace").split("\\n", 1)[0]:\n'
             '        rep["problems"].append("no GNU coreutils `timeout` (with --foreground) in the database container: the restore "\n'
             '                               "cannot be bounded without orphaning a killed process to the postmaster; nothing created")\n')
CMD_OLD = """'timeout -s KILL "$2" pg_restore -U '"""
CMD_NEW = """'exec timeout --foreground -s KILL "$2" pg_restore -U '"""
CMT_OLD = "    # 2. restore, bounded inside the container (pg_restore is KILLed at tmo) and on the host (tmo + 60)\n"
CMT_NEW = ("    # 2. restore, bounded inside the container (pg_restore is KILLed at tmo) and on the host (tmo + 60). --foreground:\n"
           "    #    timeout signals pg_restore only and reaps it itself, so no killed process is ever orphaned to the postmaster\n")
MSG_OLD = '            rep["problems"].append("pg_restore failed: " + r.stderr.decode()[-300:])\n'
MSG_NEW = '            rep["problems"].append(f"pg_restore failed (rc {r.returncode}): " + r.stderr.decode()[-300:])\n'


def apply(text):
    for old, new in ((DOC_OLD, DOC_NEW), (PROBE_OLD, PROBE_NEW), (CMD_OLD, CMD_NEW), (CMT_OLD, CMT_NEW), (MSG_OLD, MSG_NEW)):
        n = text.count(old)
        if n != 1:
            raise SystemExit(f"expected exactly one match, found {n}: {old[:70]!r}")
        text = text.replace(old, new)
    return text


if __name__ == "__main__":
    p = Path(sys.argv[1])
    p.write_text(apply(p.read_text()))
