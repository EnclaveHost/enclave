#!/usr/bin/env python3
"""root_scan_supervisor.py - cold-scan v2 (prepared by Claude 1607; NOT run by Claude). Standard library only; imports nothing else.

ROOT runs THIS file only as a private staged copy (/run/nvme-cold-wc10.*, sha256-pinned in run-read-only-cold-scan-v2.sh) under the
same 1 GiB system scope as the frozen r10 read-only scan:
    python3 -I -B $W/root_scan_supervisor.py  $W  CONFIG  HEARTBEAT
It starts EXACTLY  /bin/bash $W/jobs/root-writer-check.sh $W CONFIG  (the frozen r10 job; it execs the r10 scanner) as its own child in
a NEW session / process group (start_new_session) with PR_SET_PDEATHSIG=SIGKILL, passes its stdout/stderr through, and supervises it
continuously, every POLL_SEC, from INSIDE the root scope (independent of the user's queue placeholder):
  - host MemAvailable < FLOOR_MIB (16 GiB), or /proc/meminfo unreadable  -> stop (exit 70)
  - running longer than TIMEOUT_SEC                                      -> stop (exit 71)
  - the owner's heartbeat file (lstat only: never opened, never followed) missing, not a regular file or older than
    HEARTBEAT_MAX_AGE_SEC (the owner touches it only while its queue lane is held)                    -> stop (exit 72)
  - SIGTERM / SIGINT / SIGHUP to the supervisor                          -> stop (exit 73)
"stop" = SIGTERM to the child's OWN process group (the pgid it created), KILL_GRACE_SEC later SIGKILL, then reap. After a normal exit
the same group gets a best-effort SIGKILL so nothing of it outlives the supervisor (a pid is never reused while it names a live group).
No other process is ever signalled. Otherwise the exit code is the child's. The supervisor writes nothing but one stderr line.
"""
import ctypes, os, re, signal, stat, subprocess, sys, time

FLOOR_MIB = 16384
START_MIB = 16384 + 1024            # the r10 job's own start check, repeated here before anything starts
TIMEOUT_SEC = 3600
HEARTBEAT_MAX_AGE_SEC = 15
POLL_SEC = 0.25
KILL_GRACE_SEC = 5
STAGED = re.compile(r"^/run/nvme-cold-wc10\.[A-Za-z0-9]{8}$")
STOP = {"floor": 70, "timeout": 71, "heartbeat": 72, "signal": 73}


def mem_available_mib(path):
    with open(path, "rb") as f:
        for line in f.read(1 << 16).decode("ascii", "replace").splitlines():
            if line.startswith("MemAvailable:"):
                return int(line.split()[1]) // 1024
    raise ValueError("no MemAvailable")


def heartbeat_age(path, now):
    st = os.lstat(path)
    if not stat.S_ISREG(st.st_mode):
        raise ValueError("heartbeat is not a regular file")
    return now - st.st_mtime


_PRCTL = ctypes.CDLL(None, use_errno=True).prctl       # resolved before any fork: the child below only calls it


_PARENT = [0]


def _pdeathsig():
    if _PRCTL(1, int(signal.SIGKILL), 0, 0, 0) != 0 or os.getppid() != _PARENT[0]:   # PR_SET_PDEATHSIG; the parent died before it?
        os._exit(126)


def supervise(argv, *, heartbeat, floor_mib=FLOOR_MIB, start_mib=START_MIB, timeout_sec=TIMEOUT_SEC,
              heartbeat_max_age=HEARTBEAT_MAX_AGE_SEC, meminfo="/proc/meminfo", poll=POLL_SEC, grace=KILL_GRACE_SEC,
              log=lambda m: print(f"supervisor: {m}", file=sys.stderr, flush=True)):
    got = []
    old = {s: signal.signal(s, lambda n, f: got.append(n)) for s in (signal.SIGTERM, signal.SIGINT, signal.SIGHUP)}
    try:
        def why_stop(started):
            if got:
                return "signal", f"signal {got[0]}"
            try:
                m = mem_available_mib(meminfo)
            except (OSError, ValueError) as e:
                return "floor", f"MemAvailable unreadable ({e})"
            if m < floor_mib:
                return "floor", f"MemAvailable {m} MiB < {floor_mib} MiB floor"
            if started is not None and time.monotonic() - started > timeout_sec:
                return "timeout", f"running longer than {timeout_sec} s"
            try:
                age = heartbeat_age(heartbeat, time.time())
            except (OSError, ValueError) as e:
                return "heartbeat", f"owner heartbeat lost ({e})"
            if age > heartbeat_max_age:
                return "heartbeat", f"owner heartbeat {age:.0f} s old (> {heartbeat_max_age} s)"
            return None
        pre = why_stop(None)
        if pre is None:
            try:
                if mem_available_mib(meminfo) < start_mib:
                    pre = ("floor", f"MemAvailable below the {start_mib} MiB start bound")
            except (OSError, ValueError) as e:
                pre = ("floor", f"MemAvailable unreadable ({e})")
        if pre:
            log(f"not started: {pre[1]}")
            return STOP[pre[0]]
        _PARENT[0] = os.getpid()
        child = subprocess.Popen(argv, stdin=subprocess.DEVNULL, start_new_session=True, close_fds=True, preexec_fn=_pdeathsig)
        pgid, started, reason = child.pid, time.monotonic(), None
        # the leader is NOT reaped until its group was signalled last: while it is an unreaped zombie its pid (= the pgid) cannot be
        # reused, so every killpg below can only reach the group this supervisor created
        while not _exited(pgid):
            reason = why_stop(started)
            if reason:
                log(f"stopping the scan (process group {pgid}): {reason[1]}")
                _signal_group(pgid, signal.SIGTERM)
                end = time.monotonic() + grace
                while not _exited(pgid) and time.monotonic() < end:
                    time.sleep(0.05)
                break
            time.sleep(poll)
        if not _exited(pgid):
            _signal_group(pgid, signal.SIGKILL)
            os.waitid(os.P_PID, pgid, os.WEXITED | os.WNOWAIT)
        _signal_group(pgid, signal.SIGKILL)                  # anything left of the group (normally nothing); the leader is still unreaped
        rc = child.wait()
        if reason:
            return STOP[reason[0]]
        return rc if rc >= 0 else 128 - rc
    finally:
        for s, h in old.items():
            signal.signal(s, h)


def _exited(pid):
    """has the child exited? (WNOWAIT: it stays an unreaped zombie, so its pid / pgid stays reserved)"""
    return os.waitid(os.P_PID, pid, os.WEXITED | os.WNOHANG | os.WNOWAIT) is not None


def _signal_group(pgid, sig):
    try:
        os.killpg(pgid, sig)
    except ProcessLookupError:
        pass


def main(argv):
    if len(argv) != 3 or not STAGED.match(argv[0]) or os.path.realpath(argv[0]) != argv[0] \
            or any(not a.startswith("/") or "\0" in a for a in argv[1:]):
        print("supervisor: usage: root_scan_supervisor.py /run/nvme-cold-wc10.XXXXXXXX /ABS/CONFIG.json /ABS/HEARTBEAT", file=sys.stderr)
        return 2
    w, config, heartbeat = argv
    return supervise(["/bin/bash", f"{w}/jobs/root-writer-check.sh", w, config], heartbeat=heartbeat)


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
