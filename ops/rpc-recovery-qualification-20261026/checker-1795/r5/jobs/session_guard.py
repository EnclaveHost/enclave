#!/usr/bin/env python3
"""composite-mdbx-validation-stage/r5 jobs/session_guard.py (prepared by Claude 1792; NOT run by Claude). Stdlib only, read-only /proc.

Fixture ADMISSION guard (replaces r2-r4's `pgrep -f 'orchestrate\\.py|overlay_session\\.py|composite_session\\.py'`, which matched the
names ANYWHERE in ANY of this user's command lines - a shell, editor, grep, monitor or review command that merely MENTIONS a path
refused the job, and the refusal logged no PID). It refuses (rc 1) only while a REAL session process is live: a process of this
uid whose argv[0] is a Python interpreter and whose SCRIPT argument (the first non-option argument; -c / -m / - mean no script)
has the basename orchestrate.py, overlay_session.py or composite_session.py - the exact way the r3 wrapper, r9 and this stage start
them. Its own process and all its ancestors (the job shell, memory guard, queue) are excluded. Every refusal prints the PID, its
/proc start time and argv (first 8 items). Text-only mentions are printed as INFO with PID, start time, comm and the argv[0]
basename ONLY (never their arguments) and do NOT refuse. The stage-mount check and the exclusive 512/1024 MiB queue lane stay.
Exit 0 admitted; 1 refused (a live session); 2 internal error (treated as a refusal by jobs/common.sh).
"""
import json, os, sys

SCRIPTS = ("orchestrate.py", "overlay_session.py", "composite_session.py")
VALUE_OPTS = {"-W", "-X", "-Q"}                       # Python options whose value is the NEXT argument


def script_of(argv):
    """the script path a Python interpreter argv runs, or None (not Python, -c / -m / stdin, or options only)"""
    if not argv or not os.path.basename(argv[0]).startswith("python"):
        return None
    i = 1
    while i < len(argv):
        a = argv[i]
        if a == "-" or a == "--":
            return None if a == "-" else (argv[i + 1] if i + 1 < len(argv) else None)
        if a in VALUE_OPTS:
            i += 2; continue
        if a.startswith("--"):
            i += 1; continue
        if a.startswith("-"):
            if a[1:2] in ("W", "X", "Q"):                # an attached value (-Wdefault): no flag cluster follows
                i += 1; continue
            if "c" in a[1:] or "m" in a[1:]:              # -c / -m, alone or in a cluster (-Ic, -Bm): a command, not a script
                return None
            i += 1; continue
        return a
    return None


def is_session(argv):
    s = script_of(argv)
    return s is not None and os.path.basename(s) in SCRIPTS


def info(pid):
    with open(f"/proc/{pid}/cmdline", "rb") as f:
        argv = [x.decode(errors="replace") for x in f.read(1 << 20).split(b"\0")]
    if argv and argv[-1] == "":
        argv.pop()
    with open(f"/proc/{pid}/stat", "rb") as f:
        st = f.read(4096).decode(errors="replace")
    rest = st[st.rfind(")") + 2:].split()
    comm = st[st.find("(") + 1:st.rfind(")")]
    return argv, int(rest[1]), int(rest[19]), comm


def ancestors(pid):
    out = set()
    while pid > 1 and pid not in out:
        out.add(pid)
        try:
            pid = info(pid)[1]
        except (OSError, ValueError, IndexError):
            break
    return out


def scan(uid, exclude):
    live, mentions = [], []
    for e in os.listdir("/proc"):
        if not e.isdigit() or int(e) in exclude:
            continue
        pid = int(e)
        try:
            if os.stat(f"/proc/{pid}").st_uid != uid:
                continue
            argv, _ppid, start, comm = info(pid)
        except (OSError, ValueError, IndexError):
            continue                                      # exited meanwhile
        if is_session(argv):
            live.append({"pid": pid, "startTime": start, "argv": argv[:8]})
        elif any(n in a for a in argv for n in SCRIPTS):
            mentions.append({"pid": pid, "startTime": start, "comm": comm, "argv0": os.path.basename(argv[0]) if argv else ""})
    return live, mentions


def main():
    try:
        live, mentions = scan(os.getuid(), ancestors(os.getpid()))
    except Exception as e:                                # noqa: BLE001
        print(f"## guard ERROR: {type(e).__name__}: {e}"); return 2
    for m in mentions:
        print("## guard INFO (text mention only, not refusing): " + json.dumps(m, sort_keys=True))
    for s in live:
        print("## guard LIVE session process: " + json.dumps(s, sort_keys=True))
    return 1 if live else 0


if __name__ == "__main__":
    sys.exit(main())
