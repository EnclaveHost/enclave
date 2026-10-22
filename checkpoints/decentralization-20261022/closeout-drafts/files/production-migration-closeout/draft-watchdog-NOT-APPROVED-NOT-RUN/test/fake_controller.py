#!/usr/bin/env python3
"""fake_controller.py - stands in for replicactl.py in test_migrate_step.py (its sha is passed as MS_TEST_CONTROLLER_SHA).
The wrapper gives the controller a PATH-only environment, so the test's paths and $FAKE_SCENARIO come from the sidecar
fake-controller.json next to this copy.
It mutates the fake state exactly like the real controller would at each failure point (the sidecar "scenario"), so the
wrapper's watchdog, deadline, recovery and post-checks run for real. `readiness` and `digest` answer from the state."""
import datetime as dt
import fcntl
import json
import os
import sys
import time
from pathlib import Path

CFG = json.loads((Path(__file__).resolve().parent / "fake-controller.json").read_text())
S = Path(CFG["state"])
REL = CFG["releases"]
VER = dict(zip(REL, (26, 27, 28)))
DIGEST = {"objects": {"rows": 10, "md5": "a" * 32}}


def st():
    return json.loads(S.read_text())


def mutate(f):
    lk = os.open(str(S) + ".lock", os.O_RDWR | os.O_CREAT, 0o600)
    fcntl.flock(lk, fcntl.LOCK_EX)
    try:
        s = st()
        f(s)
        t = S.with_suffix(".ctl.tmp")
        t.write_text(json.dumps(s))
        os.replace(t, S)
    finally:
        os.close(lk)


a = sys.argv[1:]
prof = json.loads(Path(a[a.index("--profile") + 1]).read_text())
cmd = a[a.index("--profile") + 2]
if a[a.index("--profile") + 2] not in ("readiness", "digest"):
    Path(CFG["invoked"]).write_text(" ".join(a))
cur = Path(prof["release_dir"]) / "current"


def switch(h):
    tmp = Path(prof["release_dir"]) / ".fake.tmp"
    if tmp.is_symlink():
        tmp.unlink()
    tmp.symlink_to(h)
    os.replace(tmp, cur)


def backup():
    b = Path(prof["backup_dir"]) / f"b{time.time_ns()}"
    b.mkdir(mode=0o700)
    (b / "manifest.json").write_text(json.dumps({"dbVersion": st()["db"]["version"], "digest": DIGEST}))
    return b


if cmd == "readiness":
    want = int(a[a.index("--expect-version") + 1])
    s = st()
    ok = s["unit"]["active"] and s["db"]["version"] == want and not s.get("readinessFails")
    print(json.dumps({"ok": ok, "dbVersion": s["db"]["version"]}))
    sys.exit(0 if ok else 1)
if cmd == "digest":
    print(json.dumps({"dbVersion": st()["db"]["version"], "digest": DIGEST}))
    sys.exit(0)

scen = CFG["scenario"]
target = a[a.index("--sha256") + 1] if "--sha256" in a else a[a.index("--fence-sha256") + 1] if "--fence-sha256" in a else a[a.index("--stock-sha256") + 1]
mutate(lambda s: s["unit"].update(active=False))                 # every step stops indexd first
if scen == "success":
    b = backup()
    if cmd.startswith("upgrade"):
        (b / "verify-indexd_verify_0123456789abcdef.json").write_text(json.dumps({"scratchState": "dropped", "cleanupOk": True}))
    switch(target)
    mutate(lambda s: (s["db"].update(version=VER[target]), s["unit"].update(active=True)))
    key = "backup" if cmd.startswith("upgrade") else "preRollbackBackup"
    print(json.dumps({"ok": True, key: str(b), "dbVersion": VER[target], "backupVerified": True, "digestPreserved": True}))
    sys.exit(0)
if scen == "die-before-switch":
    print(json.dumps({"ok": False, "error": "expected db_version 26 before upgrade, found 25"}))
    sys.exit(2)
if scen == "pgdump-hang":
    mutate(lambda s: s["sessions"].append({"pid": 777, "app": "pg_dump", "db": prof["database"],
                                           "start": dt.datetime.now(dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.%fZ")}))
    while any(x["pid"] == 777 for x in st()["sessions"]):
        time.sleep(0.2)
    print(json.dumps({"ok": False, "error": "pg_dump failed: server closed the connection unexpectedly"}))
    sys.exit(2)
if scen == "hang":
    while True:
        time.sleep(1)
if scen == "switched-not-migrated":
    backup(); switch(target)
    sys.exit(1)
if scen == "down-applied-not-switched":
    backup()
    mutate(lambda s: s["db"].update(version=VER[target]))
    sys.exit(1)
if scen == "mismatch-running":
    switch(target)
    mutate(lambda s: s["unit"].update(active=True))
    sys.exit(1)
if scen == "verify-failed-resumed":
    mutate(lambda s: s["unit"].update(active=True))                # r5's own safe resume happened
    print(json.dumps({"ok": False, "error": "backup verification failed before the switch: nothing switched",
                      "verify": {"ok": False, "cleanupOk": False, "scratch": "indexd_verify_fedcba9876543210", "scratchState": "KEPT: 1 backend(s)"},
                      "resume": {"resumed": True}, "backup": str(backup())}))
    sys.exit(1)
sys.exit(9)
