#!/usr/bin/env python3
"""r5: also a FRESH-mtime pass (directories created milliseconds before the copy, like the 1302 fixtures; the r4 run used
only old 2020 mtimes and every flag preserved them). Informational: compares old vs fresh results, proves nothing alone.
r4 diagnostic (ROOT runs it; temp files only): which flag of the pinned rsync argv leaves destination DIRECTORY mtimes at
copy time (root runs 1302/1303)? Each variant copies the same small fixture whose directories carry fixed old mtimes, then
reports, per directory, whether the destination mtime equals the source's. Control: --omit-dir-times must NOT preserve.
Usage: rsync-dir-mtime-diagnostic.py <rsync> <tmpdir>   (prints JSON lines; exit 0 always unless the fixture fails)"""
import json, os, subprocess, sys, tempfile

RSYNC, TMP = sys.argv[1], sys.argv[2]
OLD = 1_600_000_000_123_456_789
VARIANTS = [["-rt"], ["-a"], ["-a", "--omit-dir-times"], ["-a", "--protect-args"], ["-aH"], ["-aA"], ["-aX"], ["-aHAX"],
            ["-a", "--numeric-ids"], ["-a", "--one-file-system"], ["-a", "--bwlimit=100000"],
            ["-aHAX", "--numeric-ids", "--one-file-system", "--protect-args", "--bwlimit=100000"]]


def fixture(root, fresh=False):
    for d in ("t", "t/a", "t/a/b", "t/empty"):
        os.makedirs(os.path.join(root, d), exist_ok=True)
    with open(os.path.join(root, "t/a/b/f"), "wb") as f:
        f.write(b"x" * 4096)
    with open(os.path.join(root, "t/a/h1"), "wb") as f:
        f.write(b"h")
    os.link(os.path.join(root, "t/a/h1"), os.path.join(root, "t/a/h2"))
    os.symlink("b/f", os.path.join(root, "t/a/l"))
    if fresh:                                                        # r5: mtimes milliseconds before the copy, as in
        return                                                       # the test fixtures of root run 1302
    for d in ("t/a/b", "t/a", "t/empty", "t"):                      # deepest first, then nothing touches them
        os.utime(os.path.join(root, d), ns=(OLD, OLD))


v = subprocess.run([RSYNC, "--version"], capture_output=True, text=True).stdout.splitlines()[:1]
print(json.dumps({"rsync": RSYNC, "version": v, "euid": os.geteuid(), "env_rsync_vars": sorted(k for k in os.environ if k.startswith("RSYNC")),
                  "home_set": "HOME" in os.environ}))
for fresh, flags in [(False, f) for f in VARIANTS] + [(True, f) for f in VARIANTS]:
    w = tempfile.mkdtemp(dir=TMP)
    fixture(w, fresh)
    dst = os.path.join(w, "dst"); os.mkdir(dst)
    r = subprocess.run([RSYNC, *flags, os.path.join(w, "t"), dst + "/"], capture_output=True, text=True)
    res = {}
    for d in ("t", "t/a", "t/a/b", "t/empty"):
        res[d] = os.lstat(os.path.join(dst, d)).st_mtime_ns == os.lstat(os.path.join(w, d)).st_mtime_ns
    print(json.dumps({"fixture": "fresh-mtimes" if fresh else "old-mtimes", "flags": flags, "rc": r.returncode, "dir_mtime_preserved": res, "stderr": r.stderr[-300:]}))
