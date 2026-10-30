#!/usr/bin/env python3
"""base-state-readonly-stage/r5 jobs/disk_guard.py (PREPARED by Claude 1728; NOT run by Claude). Standard library only.

Runs ONE build command with its scratch on a pinned filesystem and stops ONLY that command's own process group when space runs low:
  1. --base (e.g. /vm/enclave-volumes/rpc-recovery-validation-build): its parent must be a real directory (no symlink); the base is
     created 0700 if absent, else must be a real directory owned by us on the parent's device; the filesystem holding it must be the
     pinned mount (mountinfo maj:min + source + fstype)
  2. free space >= --min-start-gib, else refused before anything is created
  3. a NEW private run dir base/run-<UTC>-<pid> (mkdir 0700: never an existing path, never a symlink)
  4. the command runs in its OWN session/process group (cwd = run dir, env BSRO_RUN_DIR = run dir); every --interval s:
       free < --floor-gib            -> stop (rc 70)
       allocated blocks of the run dir > --max-scratch-gib (lstat, no symlink follow, <= MAX_ENTRIES) -> stop (rc 71)
       --timeout elapsed             -> stop (rc 72)
       SIGTERM/SIGINT/SIGHUP to us   -> stop (rc 73)
     stop = SIGTERM to the group, <= 10 s, then SIGKILL, ALWAYS while the leader is still our UNREAPED child (waitid WNOWAIT), so the
     pgid cannot be reused; then the single reap (pattern of mdbx-recovery-validator-stage r4 bounded_run). No other process is signalled.
  5. the run dir is NEVER deleted (kept for review); guard-receipt.json (O_EXCL) records every sample and the reason.
Exit: the command's rc when it ended by itself; 3 refused (nothing started); 70/71/72/73 stopped by the guard.
    disk_guard.py --base DIR --mount-majmin M:N --mount-source SRC --mount-fstype T [--min-start-gib 64] [--floor-gib 40]
                  [--max-scratch-gib 20] [--interval 15] [--timeout 7500] -- CMD ...
"""
import argparse, json, os, re, signal, stat, sys, time

GIB = 1 << 30
MOUNTINFO = "/proc/self/mountinfo"
MAX_ENTRIES = 2_000_000
TERM_GRACE = 10.0
STOP_RC = {"diskFloor": 70, "scratchCap": 71, "timeout": 72, "cancelled": 73}


class Refused(Exception):
    pass


def free_bytes(path):                                    # provider (tests substitute a synthetic one)
    v = os.statvfs(path)
    return v.f_bavail * v.f_frsize


def alloc_bytes(root):                                   # provider: allocated blocks of the tree, never following symlinks
    total, n, stack = 0, 0, [root]
    while stack:
        d = stack.pop()
        try:
            it = os.scandir(d)
        except OSError:
            continue
        with it:
            for e in it:
                n += 1
                if n > MAX_ENTRIES:
                    return float("inf")                  # fail closed: too many entries to account
                try:
                    st = e.stat(follow_symlinks=False)
                except OSError:
                    continue
                total += st.st_blocks * 512
                if stat.S_ISDIR(st.st_mode):
                    stack.append(e.path)
    return total


def mount_of(path):
    """(majmin, mountpoint, fstype, source) of the mount holding path: same st_dev, longest mountpoint prefix"""
    st = os.stat(path)
    want = f"{os.major(st.st_dev)}:{os.minor(st.st_dev)}"
    real, best = os.path.realpath(path), None
    with open(MOUNTINFO) as f:
        for line in f:
            pre, _, post = line.partition(" - ")
            a, b = pre.split(), post.split()
            if len(a) < 5 or len(b) < 2 or a[2] != want:
                continue
            mp = re.sub(r"\\([0-7]{3})", lambda m: chr(int(m.group(1), 8)), a[4])
            if (real == mp or real.startswith(mp.rstrip("/") + "/")) and (best is None or len(mp) > len(best[1])):
                best = (a[2], mp, b[0], b[1])
    return best


def real_dir(path, what):
    st = os.lstat(path)
    if stat.S_ISLNK(st.st_mode) or not stat.S_ISDIR(st.st_mode):
        raise Refused(f"{what} {path} must be a real directory (not a symlink)")
    return st


def group_alive(pgid):
    for d in os.listdir("/proc"):
        if d.isdigit() and int(d) != pgid:
            try:
                with open(f"/proc/{d}/stat") as f:
                    s = f.read()
                rest = s[s.rfind(")") + 2:].split()
                if int(rest[2]) == pgid and rest[0] != "Z":
                    return True
            except (OSError, ValueError, IndexError):
                pass
    return False


def main(argv=None):
    ap = argparse.ArgumentParser()
    ap.add_argument("--base", required=True); ap.add_argument("--mount-majmin", required=True)
    ap.add_argument("--mount-source", required=True); ap.add_argument("--mount-fstype", required=True)
    ap.add_argument("--min-start-gib", type=float, default=64); ap.add_argument("--floor-gib", type=float, default=40)
    ap.add_argument("--max-scratch-gib", type=float, default=20); ap.add_argument("--interval", type=float, default=15)
    ap.add_argument("--timeout", type=float, default=7500)
    ap.add_argument("cmd", nargs=argparse.REMAINDER)
    a = ap.parse_args(argv)
    cmd = a.cmd[1:] if a.cmd[:1] == ["--"] else a.cmd
    rec = {"format": "bsro-disk-guard/r5", "args": {k: v for k, v in vars(a).items() if k != "cmd"}, "cmd": cmd, "samples": []}
    try:
        if not cmd or not os.path.isabs(a.base) or not 0 < a.floor_gib < a.min_start_gib or a.max_scratch_gib <= 0 or a.interval <= 0 or a.timeout <= 0:
            raise Refused("need an absolute --base, 0 < floor < min-start, positive scratch cap/interval/timeout and a command")
        parent = os.path.dirname(a.base.rstrip("/"))
        pst = real_dir(parent, "base parent")
        m = mount_of(parent)                                 # identity BEFORE anything is created
        rec["mount"] = m
        if m is None or (m[0], m[3], m[2]) != (a.mount_majmin, a.mount_source, a.mount_fstype):
            raise Refused(f"base parent is not on the pinned mount {a.mount_majmin} {a.mount_source} {a.mount_fstype}: {m}")
        if not os.path.lexists(a.base):
            os.mkdir(a.base, 0o700)
        bst = real_dir(a.base, "base")
        if bst.st_uid != os.geteuid() or bst.st_dev != pst.st_dev:
            raise Refused("base must be ours and on its parent's filesystem")
        free0 = free_bytes(a.base)
        rec["freeAtStart"] = free0
        if free0 < a.min_start_gib * GIB:
            raise Refused(f"free {free0 / GIB:.1f} GiB < min start {a.min_start_gib} GiB")
        run = os.path.join(a.base, time.strftime("run-%Y%m%dT%H%M%SZ", time.gmtime()) + f"-{os.getpid()}")
        os.mkdir(run, 0o700)                                 # FileExistsError -> refused: never an existing path
        if real_dir(run, "run dir").st_dev != bst.st_dev:
            raise Refused("run dir is not on the base filesystem")
    except (Refused, OSError) as e:
        rec["refused"] = f"{type(e).__name__}: {e}"
        print(json.dumps(rec), file=sys.stderr)
        return 3
    rec["runDir"] = run
    print(f"## disk-guard run dir {run}", flush=True)
    cancel = {"sig": None}
    old = {s: signal.signal(s, lambda n, _f: cancel.__setitem__("sig", n)) for s in (signal.SIGTERM, signal.SIGINT, signal.SIGHUP)}
    import subprocess
    p = subprocess.Popen(cmd, cwd=run, env={**os.environ, "BSRO_RUN_DIR": run}, stdin=subprocess.DEVNULL, start_new_session=True)
    reason, start, next_check = None, time.monotonic(), 0.0
    try:
        while True:
            if os.waitid(os.P_PID, p.pid, os.WEXITED | os.WNOHANG | os.WNOWAIT) is not None:
                break
            now = time.monotonic()
            if cancel["sig"] is not None:
                reason = "cancelled"
            elif now - start >= a.timeout:
                reason = "timeout"
            elif now >= next_check:
                fb, ab = free_bytes(run), alloc_bytes(run)
                rec["samples"] = (rec["samples"] + [[round(now - start, 1), fb, ab]])[-500:]
                reason = "diskFloor" if fb < a.floor_gib * GIB else "scratchCap" if ab > a.max_scratch_gib * GIB else None
                next_check = now + a.interval
            if reason:
                break
            time.sleep(0.2)
    finally:
        if reason or os.waitid(os.P_PID, p.pid, os.WEXITED | os.WNOHANG | os.WNOWAIT) is None or group_alive(p.pid):
            for sig, grace in ((signal.SIGTERM, TERM_GRACE), (signal.SIGKILL, 5.0)):
                try:
                    os.killpg(p.pid, sig)                    # our group only; leader unreaped -> pgid not reusable
                except ProcessLookupError:
                    pass
                end = time.monotonic() + grace
                while time.monotonic() < end and (os.waitid(os.P_PID, p.pid, os.WEXITED | os.WNOHANG | os.WNOWAIT) is None or group_alive(p.pid)):
                    time.sleep(0.2)
        p.wait()                                             # the only reap
        for s, h in old.items():
            signal.signal(s, h)
    rec.update(reason=reason, childRc=p.returncode, groupLeftAlive=group_alive(p.pid), seconds=round(time.monotonic() - start, 1),
               scratchKept=True)
    fd = os.open(os.path.join(run, "guard-receipt.json"), os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    os.write(fd, json.dumps(rec, indent=1).encode()); os.close(fd)
    print(f"## disk-guard reason={reason} childRc={p.returncode} run={run}", flush=True)
    return STOP_RC[reason] if reason else (128 - p.returncode if p.returncode < 0 else p.returncode)


if __name__ == "__main__":
    sys.exit(main())
