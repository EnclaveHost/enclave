#!/usr/bin/env python3
"""compare.py BEFORE AFTER --expect init|rollback : compare two pg-init-probe.sh outputs (local; reads two files only).
Exit 0 only if:
- every identity, data and container-config key is EQUAL (only --init may differ);
- the server restarted cleanly;
- the AFTER state is the expected one: init = docker-init is PID 1 and postgres is not; rollback = the exact old unit,
  with postgres as PID 1 again."""
import sys

OLD_UNIT = "e0a45f510d35181c02800f08a65d1b6da308dbc236ff4b495c11d9ba7d280012"
NEW_UNIT = "59b60ddd739d3ff5e27317faf794f4c25ce150acff38d2ec1a3de0322afdd183"
EQUAL = ["unit.stat", "docker.initBinary", "container.image", "container.imageId", "container.network", "container.readOnly",
         "container.memory", "container.autoRemove", "container.mounts", "container.tmpfs", "container.entrypoint",
         "container.cmd", "container.envNames", "pg.serverVersion", "pg.dataDirectory", "pg.systemIdentifier", "pg.fsync",
         "pg.databases", "pg.roles", "db.version"]


def load(path):
    d = {}
    for line in open(path):
        k, sep, v = line.rstrip("\n").partition("=")
        if sep:
            d[k] = v
    return d


def main(argv):
    if len(argv) != 4 or argv[2] != "--expect" or argv[3] not in ("init", "rollback"):
        print(__doc__)
        return 2
    b, a, mode = load(argv[0]), load(argv[1]), argv[3]
    bad = []

    def need(cond, what):
        if not cond:
            bad.append(what)
    for d, name in ((b, "before"), (a, "after")):
        need(d.get("probe.complete") == "yes" and d.get("container.running") == "yes", f"{name}: probe incomplete or container not running")
        need(d.get("digest.rc") == "0", f"{name}: digest failed")
        need(d.get("pg.otherClientSessions") == "0", f"{name}: other client sessions {d.get('pg.otherClientSessions')} (indexd must be stopped)")
        need(d.get("indexdUnit.ActiveState") == "inactive", f"{name}: indexd is {d.get('indexdUnit.ActiveState')}")
    for k in EQUAL:
        need(k in b and b.get(k) == a.get(k), f"{k}: {b.get(k)!r} -> {a.get(k)!r}")
    db, da = {k: v for k, v in b.items() if k.startswith("digest.")}, {k: v for k, v in a.items() if k.startswith("digest.")}
    need(len(db) > 2 and db == da, f"digest differs: {sorted(set(db.items()) ^ set(da.items()))[:6]}")
    need(b.get("pg.postmasterStart") != a.get("pg.postmasterStart"), "the server did not restart")
    need(a.get("wait.ready") == "yes", "after: server not ready within the wait")
    need((a.get("container.startupLine") or "").startswith("database system was shut down"),
         f"after: not a clean restart: {a.get('container.startupLine')!r}")
    need(a.get("pgUnit.ActiveState") == "active" and a.get("pgUnit.SubState") == "running" and a.get("pgUnit.NeedDaemonReload") == "no",
         "after: PostgreSQL unit not active/running, or a daemon-reload is pending")
    need(b.get("unit.sha256") == OLD_UNIT and b.get("container.init") in ("<nil>", "false") and b.get("pid1.comm") == "postgres",
         "before: not the original state (BEFORE is always the probe taken under the old unit)")
    if mode == "init":
        need(a.get("unit.sha256") == NEW_UNIT and a.get("unit.execStartInit") == "yes", "after: the candidate unit is not installed")
        need(a.get("container.init") == "true", f"after: container.init {a.get('container.init')!r}")
        need(a.get("pid1.comm") == "docker-init", f"after: PID 1 is {a.get('pid1.comm')!r}")
        need(a.get("postmaster.pid", "1") != "1" and a.get("postmaster.comm") == "postgres", "after: the postmaster is still PID 1")
    else:
        need(a.get("unit.sha256") == OLD_UNIT and a.get("unit.execStartInit") == "no", "after: the old unit is not restored")
        need(a.get("container.init") in ("<nil>", "false"), f"after: container.init {a.get('container.init')!r}")
        need(a.get("pid1.comm") == "postgres" and a.get("postmaster.pid") == "1", "after: postgres is not PID 1")
    print(("PASS" if not bad else "FAIL") + f" ({mode})")
    for x in bad:
        print("  -", x)
    return 0 if not bad else 1


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
