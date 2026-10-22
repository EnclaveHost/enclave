#!/usr/bin/env python3
"""integration_checks.py - REAL-PostgreSQL checks of the storage-migration-r5 rev2 verifier and pre-switch verification,
run by run-integration.py inside the derived eight-stage C2 fixture run.
- Same disposable, labelled, --pull never PostgreSQL container as the stages; loopback only.
- The same node, and the r5 fixture-controller candidate (replicactl.fixture-r5.py 2ab98b4d).
- Dummy data only (the fixture's own seed).

  integration_checks.py pre     BEFORE stage 1: create the two databases that must never be touched
  integration_checks.py post    AFTER the 8 stages (indexd stopped, db v28): X1..X8 below

Deterministic timing, no "restore happened to be fast/slow":
- An EVENT TRIGGER in this run's OWN container's template1 is installed only for the duration of one check, then
  removed and verified absent.
- Every scratch database the controller creates (CREATE DATABASE copies template1) then either sleeps in its first DDL
  (pg_sleep 20/30 s, far beyond the 2 s restore bound) or RAISEs.
- So the restore cannot finish before its bound (X3, X4), or fails for certain (X7).

Checks (each asserts exact outcomes; there is no either-pass-or-fail branch):
  X1 successful verify-backup: ok, cleanupOk, scratchState "dropped", digest and v28 match, record "dropped", and no
     *_verify* database except the two pre-created ones
  X2 forced scratch-name collision (in-process: the pinned controller module, token_hex fixed to the pre-created name):
     "already existed: not ours, untouched", marker row intact, no DROP of it
  X3 killed restore (verify_timeout_seconds 2, delay trigger 20 s):
     - exit 1; ok false; "pg_restore failed" in problems;
     - the lingering backend is WAITED OUT (elapsed >= 15 s), then the scratch is "dropped", cleanupOk true;
     - afterwards no backend on any *_verify* database, and only the two markers left
  X4 total query budget (verify_timeout_seconds 2, verify_query_seconds 6, delay trigger 30 s):
     - exit 1, elapsed < 20 s, cleanupOk false, scratchState "KEPT ...";
     - the scratch exists AND is named in <backup>/verify-<scratch>.json with cleanupOk false;
     - then THIS harness waits (bounded) for its backend to leave and drops exactly that named scratch, confirmed gone
  X5 rollback-c2 --acknowledge-cas-downgrade to v27 (the precondition for X6/X7; fence release current, running)
  X6 CORRUPT backup (in-process seam: one byte of the fresh upgrade backup's dump flipped before verification):
     - upgrade-c2 exits 1, "hash mismatch", nothing created;
     - current unchanged (fence); resume {resumed: true, release: fence, dbVersion: 27};
     - readiness at v27; the acknowledged-metadata digest unchanged
  X7 restore REFUSED by the server (raise trigger), through the real CLI:
     - upgrade-c2 exits 1; verify ok false, cleanupOk true, scratch "dropped";
     - current unchanged; resume {resumed: true, release: fence, dbVersion: 27}
  X8 final invariants:
     - both markers intact;
     - no other *_verify* database, no backend on one, and no c2it trigger in template1;
     - current = fence.
Every exit path removes this module's own triggers (names c2it_delay / c2it_refuse only) and stops indexd through the
controller.
Results: <stage>/integration-results.json. Exit 0 only if every check of the mode passed and the finalize steps succeeded."""
import contextlib
import importlib.util
import io
import json
import os
import re
import secrets
import subprocess
import sys
import time
import types
from pathlib import Path

sys.dont_write_bytecode = True
STAGE = Path(os.environ["C2FX_STAGE"])
CONTROLLER = Path(os.environ["C2FX_CONTROLLER"])
FENCE, C2 = Path(os.environ["C2FX_FENCE"]), Path(os.environ["C2FX_C2"])
PROFILE = STAGE / "fixture-profile.json"
P = json.loads(PROFILE.read_text())
PG = P["pg_container"]
RESULTS = STAGE / "integration-results.json"
MARKER_DB = "indexd_verify"                                      # r4's fixed name: must survive everything
COLLIDE_HEX = "c2" * 8
COLLIDE_DB = f"indexd_verify_{COLLIDE_HEX}"                      # a valid scratch name, pre-created: must survive too
SCRATCH_RX = re.compile(r"^indexd_verify_[0-9a-f]{16}$")
TRIGGERS = ("c2it_delay", "c2it_refuse")


class Fail(Exception):
    pass


def check(cond, what):
    if not cond:
        raise Fail(what)


def sha(p):
    import hashlib
    return hashlib.sha256(Path(p).read_bytes()).hexdigest()


def psql(db, sql, timeout=60):
    """one psql call in THIS run's own container; raises on any error"""
    r = subprocess.run(["docker", "exec", "-i", PG, "sh", "-c",
                        'psql -U "${POSTGRES_USER:-postgres}" -d "$1" -X -A -t -q -v ON_ERROR_STOP=1 -f -', "psql", db],
                       input=sql.encode(), capture_output=True, timeout=timeout)
    if r.returncode != 0:
        raise RuntimeError(f"psql {db}: rc {r.returncode} {r.stderr.decode()[-300:]}")
    return r.stdout.decode().strip()


def verify_dbs():
    out = psql("postgres", r"SELECT datname FROM pg_database WHERE datname LIKE 'indexd\_verify%' ORDER BY 1;")
    return sorted(out.split()) if out else []                      # sorted in Python (not by the server's collation)


def verify_backends():
    return int(psql("postgres", r"SELECT count(*) FROM pg_stat_activity WHERE datname LIKE 'indexd\_verify%';"))


def marker(db):
    return psql(db, "SELECT v FROM c2it_marker;")


def ctl(*a, profile=PROFILE, timeout=900):
    r = subprocess.run([sys.executable, "-B", str(CONTROLLER), "--profile", str(profile), *a], capture_output=True, text=True, timeout=timeout)
    lines = r.stdout.strip().splitlines()
    try:
        out = json.loads(lines[-1]) if lines else {}
    except json.JSONDecodeError:
        out = {"raw": r.stdout[-300:]}
    return r.returncode, out, r.stderr[-400:]


def controller_module(tag):
    sp = importlib.util.spec_from_file_location(f"ctl_{tag}", CONTROLLER)
    m = importlib.util.module_from_spec(sp)
    sp.loader.exec_module(m)
    return m


def current():
    return os.readlink(Path(P["release_dir"]) / "current")


def profile_copy(name, **keys):
    p = dict(P, **keys)
    out = STAGE / name
    fd = os.open(out, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(fd, "w") as f:
        f.write(json.dumps(p, indent=1))
    return out


def install_trigger(name, body):
    check(name in TRIGGERS, "own trigger names only")
    psql("template1", f"CREATE FUNCTION {name}() RETURNS event_trigger LANGUAGE plpgsql AS $f$ BEGIN {body} END $f$;")
    psql("template1", f"CREATE EVENT TRIGGER {name} ON ddl_command_start EXECUTE FUNCTION {name}();")
    check(psql("template1", f"SELECT count(*) FROM pg_event_trigger WHERE evtname = '{name}';") == "1", f"{name} installed")


def remove_trigger(name):
    """remove THIS module's own trigger by its exact name, only if it is there; -> True when confirmed absent"""
    if psql("template1", f"SELECT count(*) FROM pg_event_trigger WHERE evtname = '{name}';") == "1":
        psql("template1", f"DROP EVENT TRIGGER {name};")
    if psql("template1", f"SELECT count(*) FROM pg_proc WHERE proname = '{name}';") == "1":
        psql("template1", f"DROP FUNCTION {name}();")
    return psql("template1", f"SELECT count(*) FROM pg_event_trigger WHERE evtname = '{name}';") == "0"


def record_of(backup, scratch):
    return json.loads((Path(backup) / f"verify-{scratch}.json").read_text())


# ---------------------------------------------------------------- pre
def pre():
    out = {}
    for db in (MARKER_DB, COLLIDE_DB):
        check(db not in verify_dbs(), f"{db} must not pre-exist in this fresh container")
        token = secrets.token_hex(8)
        psql("postgres", f'CREATE DATABASE "{db}";')
        psql(db, f"CREATE TABLE c2it_marker (v text NOT NULL); INSERT INTO c2it_marker VALUES ('{token}');")
        check(marker(db) == token, f"{db} marker written")
        out[db] = token
    return {"markers": out, "verifyDatabases": verify_dbs()}


# ---------------------------------------------------------------- post
S = {}


def x1_success():
    rc, b, err = ctl("backup")
    check(rc == 0 and b.get("ok") and b.get("dbVersion") == 28, f"backup: {rc} {b} {err}")
    S["backup"] = b["backup"]
    rc, v, err = ctl("verify-backup", S["backup"])
    check(rc == 0, f"verify-backup rc {rc}: {v} {err}")
    check(v["ok"] and v["cleanupOk"] and v["digestMatches"] and v["restoredDbVersion"] == 28 and v["scratchState"] == "dropped", v)
    check(SCRATCH_RX.match(v["scratch"]) and v["scratch"] != COLLIDE_DB, v["scratch"])
    check(record_of(S["backup"], v["scratch"])["scratchState"] == "dropped", "record says dropped")
    check(verify_dbs() == sorted([MARKER_DB, COLLIDE_DB]), verify_dbs())
    return {"scratch": v["scratch"], "verify": {k: v[k] for k in ("ok", "cleanupOk", "scratchState", "restoredDbVersion", "digestMatches")}}


def x2_forced_collision():
    m = controller_module("x2")
    m.secrets = types.SimpleNamespace(token_hex=lambda n: "c2" * n)
    node = m.Node(PROFILE)
    rep = m.verify_backup(node, S["backup"])
    check(rep["scratch"] == COLLIDE_DB, rep.get("scratch"))
    check(rep["scratchState"] == "already existed: not ours, untouched" and not rep["ok"] and rep["cleanupOk"], rep)
    check(marker(COLLIDE_DB) == S["markers"][COLLIDE_DB], "collision marker intact")
    check(verify_dbs() == sorted([MARKER_DB, COLLIDE_DB]), verify_dbs())
    return {"scratchState": rep["scratchState"], "markerIntact": True}


def x3_killed_restore():
    install_trigger("c2it_delay", "PERFORM pg_sleep(20);")
    try:
        prof = profile_copy("profile-x3.json", verify_timeout_seconds=2)
        t0 = time.monotonic()
        rc, v, err = ctl("verify-backup", S["backup"], profile=prof)
        el = round(time.monotonic() - t0, 1)
    finally:
        check(remove_trigger("c2it_delay"), "c2it_delay removed")
    check(rc == 1 and not v["ok"], f"rc {rc} {v}")
    check(any(p.startswith("pg_restore failed") for p in v["problems"]), v["problems"])
    check(v["scratchState"] == "dropped" and v["cleanupOk"], v)
    check(15 <= el < 140, f"elapsed {el}: the lingering backend (20 s sleep) must be waited out before the drop")
    check(verify_backends() == 0 and verify_dbs() == sorted([MARKER_DB, COLLIDE_DB]), (verify_backends(), verify_dbs()))
    return {"elapsedSeconds": el, "scratch": v["scratch"], "problems": v["problems"][:2]}


def x4_query_budget():
    install_trigger("c2it_delay", "PERFORM pg_sleep(30);")
    try:
        prof = profile_copy("profile-x4.json", verify_timeout_seconds=2, verify_query_seconds=6)
        t0 = time.monotonic()
        rc, v, err = ctl("verify-backup", S["backup"], profile=prof)
        el = round(time.monotonic() - t0, 1)
        check(rc == 1 and not v["cleanupOk"] and v["scratchState"].startswith("KEPT"), f"rc {rc} {v}")
        check(el < 20, f"elapsed {el}: the query budget (6 s) must bound the verification")
        scratch = v["scratch"]
        check(SCRATCH_RX.match(scratch) and scratch not in (MARKER_DB, COLLIDE_DB), scratch)
        check(scratch in verify_dbs(), "the KEPT scratch really remains")
        rec = record_of(S["backup"], scratch)
        check(rec["scratch"] == scratch and rec["cleanupOk"] is False and rec["scratchState"].startswith("KEPT"), rec)
        # harness cleanup of the NAMED leftover: wait (bounded) for its backend, then drop exactly it
        for _ in range(90):
            if int(psql("postgres", f"SELECT count(*) FROM pg_stat_activity WHERE datname = '{scratch}';")) == 0:
                break
            time.sleep(1)
        psql("postgres", f'DROP DATABASE "{scratch}";')
        check(scratch not in verify_dbs(), "named leftover dropped by the harness")
    finally:
        check(remove_trigger("c2it_delay"), "c2it_delay removed")
    check(verify_backends() == 0 and verify_dbs() == sorted([MARKER_DB, COLLIDE_DB]), (verify_backends(), verify_dbs()))
    return {"elapsedSeconds": el, "scratch": scratch, "scratchState": v["scratchState"][:80], "harnessDroppedNamedLeftover": True}


def x5_rollback_to_v27():
    rc, r, err = ctl("rollback-c2", "--fence-sha256", sha(FENCE), "--confirm", "rollback-c2", "--cas-writers-stopped", "--acknowledge-cas-downgrade")
    check(rc == 0 and r.get("ok") and r.get("dbVersion") == 27, f"rollback-c2 rc {rc} {r} {err}")
    check(current() == sha(FENCE), current())
    return {"dbVersion": 27, "current": "fence"}


def x6_corrupt_backup_upgrade():
    rc, d0, _ = ctl("digest")
    check(rc == 0 and d0.get("dbVersion") == 27, d0)
    m = controller_module("x6")
    real = m.verify_backup
    flipped = {}

    def corrupt_then_verify(node, b, **k):
        dump = Path(b) / "indexd.pgdump"
        data = bytearray(dump.read_bytes())
        i = len(data) // 2
        data[i] ^= 0xFF
        dump.write_bytes(bytes(data))
        flipped["at"] = i
        return real(node, b, **k)
    m.verify_backup = corrupt_then_verify
    node = m.Node(PROFILE)
    out = io.StringIO()
    with contextlib.redirect_stdout(out):
        try:
            m.cmd_upgrade_c2(node, types.SimpleNamespace(sha256=sha(C2), confirm="upgrade-c2"))
            code = 0
        except SystemExit as e:
            code = e.code
    res = json.loads(out.getvalue().strip().splitlines()[-1])
    check(code == 1 and res["ok"] is False and "at" in flipped, f"code {code} {res}")
    check(any("hash mismatch" in p for p in res["verify"]["problems"]) and "scratch" not in res["verify"], res["verify"])
    check(res["resume"] == {"resumed": True, "release": sha(FENCE), "dbVersion": 27}, res["resume"])
    check(current() == sha(FENCE), "current unchanged")
    rc, rd, _ = ctl("readiness", "--expect-version", "27")
    check(rc == 0 and rd.get("ok"), rd)
    rc, d1, _ = ctl("digest")
    check(rc == 0 and d1["digest"] == d0["digest"], "acknowledged-metadata digest unchanged")
    rc, s, _ = ctl("stop")
    check(rc == 0, f"stop {s}")
    return {"flippedByte": flipped["at"], "resume": res["resume"], "currentUnchanged": True, "digestUnchanged": True}


def x7_refused_restore_upgrade():
    install_trigger("c2it_refuse", "RAISE EXCEPTION 'c2it: injected restore refusal';")
    try:
        rc, res, err = ctl("upgrade-c2", "--sha256", sha(C2), "--confirm", "upgrade-c2")
    finally:
        check(remove_trigger("c2it_refuse"), "c2it_refuse removed")
    check(rc == 1 and res.get("ok") is False, f"rc {rc} {res} {err}")
    v = res["verify"]
    check(not v["ok"] and v["cleanupOk"] and v["scratchState"] == "dropped" and any(p.startswith("pg_restore failed") for p in v["problems"]), v)
    check(res["resume"] == {"resumed": True, "release": sha(FENCE), "dbVersion": 27}, res["resume"])
    check(current() == sha(FENCE), "current unchanged")
    rc, s, _ = ctl("stop")
    check(rc == 0, f"stop {s}")
    return {"resume": res["resume"], "scratchState": v["scratchState"]}


def x8_final():
    check(marker(MARKER_DB) == S["markers"][MARKER_DB] and marker(COLLIDE_DB) == S["markers"][COLLIDE_DB], "markers intact")
    check(verify_dbs() == sorted([MARKER_DB, COLLIDE_DB]) and verify_backends() == 0, (verify_dbs(), verify_backends()))
    check(psql("template1", "SELECT count(*) FROM pg_event_trigger WHERE evtname LIKE 'c2it%';") == "0", "no c2it trigger left")
    check(current() == sha(FENCE), current())
    return {"markersIntact": True, "verifyDatabases": verify_dbs()}


POST = [("X1-verify-success-restore-digest-drop", x1_success), ("X2-forced-scratch-name-collision-untouched", x2_forced_collision),
        ("X3-killed-restore-bounded-no-detached-writer", x3_killed_restore), ("X4-total-query-budget-named-leftover", x4_query_budget),
        ("X5-rollback-c2-to-v27", x5_rollback_to_v27), ("X6-corrupt-backup-upgrade-refused-safe-resume", x6_corrupt_backup_upgrade),
        ("X7-server-refused-restore-upgrade-refused-safe-resume", x7_refused_restore_upgrade), ("X8-final-invariants", x8_final)]


def finalize():
    """every exit path: this module's own triggers removed, indexd stopped through the controller"""
    out = {}
    for t in TRIGGERS:
        try:
            out[t] = "absent" if remove_trigger(t) else "STILL PRESENT"
        except Exception as e:
            out[t] = f"UNKNOWN: {type(e).__name__}: {str(e)[-160:]}"
    rc, s, err = ctl("stop")
    out["indexdStop"] = "stopped" if rc == 0 else f"FAILED rc {rc} {s} {err}"
    out["ok"] = all(v == "absent" for k, v in out.items() if k in TRIGGERS) and rc == 0
    return out


def main(mode):
    res = json.loads(RESULTS.read_text()) if RESULTS.exists() else {}
    if mode == "pre":
        try:
            res["pre"] = {"ok": True, **pre()}
        except Exception as e:
            res["pre"] = {"ok": False, "error": f"{type(e).__name__}: {str(e)[:600]}"}
        RESULTS.write_text(json.dumps(res, indent=1) + "\n")
        print(json.dumps({"mode": "pre", "ok": res["pre"]["ok"]}), flush=True)
        return 0 if res["pre"]["ok"] else 1
    S["markers"] = res["pre"]["markers"]
    checks, ok = [], True
    try:
        for name, fn in POST:
            t0 = time.monotonic()
            try:
                d = fn()
                checks.append({"check": name, "ok": True, "seconds": round(time.monotonic() - t0, 1), "detail": d})
                print(f"PASS {name}: {json.dumps(d)[:300]}", flush=True)
            except Exception as e:
                checks.append({"check": name, "ok": False, "seconds": round(time.monotonic() - t0, 1), "error": f"{type(e).__name__}: {str(e)[:600]}"})
                print(f"FAIL {name}: {type(e).__name__}: {str(e)[:600]}", flush=True)
                ok = False
                break                                   # later checks depend on this one's state
    finally:
        fin = finalize()
    res["post"] = {"checks": checks, "finalize": fin, "passed": ok and fin["ok"] and len(checks) == len(POST)}
    RESULTS.write_text(json.dumps(res, indent=1) + "\n")
    print(json.dumps({"mode": "post", "passed": res["post"]["passed"], "checks": len(checks)}), flush=True)
    return 0 if res["post"]["passed"] else 1


if __name__ == "__main__":
    sys.exit(main(sys.argv[1]))
