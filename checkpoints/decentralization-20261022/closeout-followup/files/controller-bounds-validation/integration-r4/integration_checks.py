#!/usr/bin/env python3
"""integration_checks.py - REAL-PostgreSQL checks of the storage-migration-r5 rev2 verifier and pre-switch verification,
run by run-integration.py inside the derived eight-stage C2 fixture run.
- Same disposable, labelled, --pull never PostgreSQL container as the stages; loopback only.
- The same node, and the r5 fixture-controller candidate (replicactl.fixture-r5.py 2ab98b4d).
- Dummy data only (the fixture's own seed).

  integration_checks.py pre     BEFORE stage 1: create the two databases that must never be touched
  integration_checks.py post    AFTER the 8 stages (indexd stopped, db v28): X1..X8 below

Revision 3 (restore-timeout-diagnosis, after root run a7e53855b0f9f535 X3b):
- r1's "prompt cancellation" (X3, 3.5 s) and r2's X3b holder rc 2 were ONE controller defect. r5's `timeout -s KILL`
  (GNU, no --foreground) KILLs its own process group, timeout included, so the KILLed pg_restore was orphaned to the
  postmaster (PID 1 of the container). The postmaster reaped an "untracked child process" killed by signal 9, ended
  EVERY session and reinitialized. The controller under test is now the restore fix (`exec timeout --foreground`), so
  the killed restore's own backend really lingers:
  - X3a requires again what r1 required: that lingering backend is waited out (15 s <= elapsed < 60 s);
  - the barrier polls with pg_stat_clear_snapshot() (pg_stat_activity is otherwise ONE snapshot per transaction, so a
    holder attaching after the first poll was never seen) and releases after a BOUNDED sleep (X3b 25 s, X4 20 s)
    instead of 600 s: the restore still cannot finish before its bound, and its backend ends before the holder's;
  - the server must never reinitialize: pg_postmaster_start_time + checkpointer pid are recorded in "pre" and must be
    unchanged after the 8 stages (X1) and after X3a, X3b, X4 and X8; an UNRELATED witness session on database
    "postgres" (started in X3a) must survive to X8; X8 also requires no crash line in the server log;
  - holder/witness stderr goes to a file and into every failure message (r2 lost it); finalize writes the server log
    to <stage>/pg-server.log, kept by run-integration r3.
Deterministic timing (revision 2, after root run e370da8a42b29695; superseded where revision 3 says so):
- r1 assumed the restore's own backend would linger in pg_sleep after pg_restore was KILLed. PostgreSQL cancelled it
  promptly (X3, 3.5 s), so that path is now its own positive check (X3a) with no minimum-time claim.
- X3b and X4 use a SEPARATELY HELD connection: this harness's own Holder, a `psql -c "SELECT pg_sleep(n)"` on the scratch
  database, identified by application_name c2it-holder-<random> and its backend pid. It is independent of pg_restore.
- An explicit BARRIER makes the holder attach BEFORE the restore can proceed: the template1 event trigger c2it_barrier
  (copied into every scratch database) blocks the restore's first DDL until that exact holder is connected, then sleeps
  600 s. So the restore cannot finish before its bound.
- GATE: the holder must be OBSERVED active on the scratch database (pg_stat_activity: pid, application_name, state,
  query) before the check continues; otherwise the check FAILS. No skipped or conditional pass.
- Every trigger lives only in THIS run's container's template1, only for one check: removed in `finally`, verified
  absent, and removed again by finalize. Every holder is closed by pid+token in finalize.

Checks (each asserts exact outcomes; there is no either-pass-or-fail branch):
  X1 successful verify-backup: ok, cleanupOk, scratchState "dropped", digest and v28 match, record "dropped", and no
     *_verify* database except the two pre-created ones
  X2 forced scratch-name collision (in-process: the pinned controller module, token_hex fixed to the pre-created name):
     "already existed: not ours, untouched", marker row intact, no DROP of it
  X3a killed restore, its own lingering backend waited out (verify_timeout_seconds 2, trigger pg_sleep 20 s): exit 1,
      "pg_restore failed", "dropped", cleanupOk, 15 s <= elapsed < 60 s, 0 backends on *_verify*, only the markers
      left, the server not reinitialized (r3)
  X3b held connection waited out:
      - restore bound 20 s, holder 40 s, barrier; holder observed active before 20 s;
      - exit 1, "pg_restore failed";
      - the holder ENDED BY ITSELF (rc 0) at >= 35 s, and the controller ended at or after that, then "dropped",
        cleanupOk true; 0 backends, only the markers left
  X4 total query budget with the held connection:
      - restore bound 6 s, verify_query_seconds 12, holder 60 s, barrier; holder observed active before 6 s;
      - exit 1 within 30 s; cleanupOk false; scratchState "KEPT ..."; the holder STILL attached at that moment;
      - the scratch exists and is named in <backup>/verify-<scratch>.json with cleanupOk false;
      - then this harness closes ITS holder and drops exactly that validated, named scratch
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
Every exit path removes this module's own triggers (c2it_delay / c2it_refuse / c2it_barrier only), closes its own
holders (pid + token) and stops indexd through the controller.
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
TRIGGERS = ("c2it_delay", "c2it_refuse", "c2it_barrier")


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


CRASH_RX = re.compile(r"untracked child process|was terminated by signal|terminating any other active server processes"
                      r"|all server processes terminated; reinitializing|terminating connection because of crash")


def server_identity():
    """the server's process generation (r3): postmaster start time + checkpointer pid. A crash-restart (the r5 defect)
    replaces the checkpointer while the postmaster, PID 1, stays."""
    return psql("postgres", "SELECT pg_postmaster_start_time() || '|' || (SELECT pid FROM pg_stat_activity WHERE backend_type = 'checkpointer');")


def server_log():
    """this run's own container's server log (read-only)"""
    r = subprocess.run(["docker", "logs", "--timestamps", PG], capture_output=True, text=True, timeout=60)
    return r.stdout + r.stderr


def crash_lines(log):
    return [l for l in log.splitlines() if CRASH_RX.search(l)]


def same_server(witness=True):
    """r3: no crash-restart since "pre", and (from X3a on) the unrelated witness session is still attached"""
    now = server_identity()
    check(now == S["ident"], f"the server reinitialized: {S['ident']} -> {now}; crash lines {crash_lines(server_log())[-4:]}")
    if witness:
        w = S["witness"]
        check(w.p.poll() is None and w.attached(), f"unrelated witness session ended: rc {w.p.poll()} stderr {w.stderr()!r}")


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

class Holder:
    """this harness's OWN, separately held PostgreSQL connection on a scratch database (revision 2). It is independent of
    pg_restore, so a killed restore cannot take it down.
    - Identity: application_name c2it-holder-<random token>; backend pid recorded when first observed.
    - Process: `docker exec -e PGAPPNAME=<token> <this run's container> psql -d <scratch> -c "SELECT pg_sleep(<n>)"`, a
      child of this harness (inside the job's own scope).
    - It is only ever terminated by pid AND token (pg_terminate_backend), and is always stopped in `close()`."""

    def __init__(self, seconds, prefix="c2it-holder-"):
        check(prefix in ("c2it-holder-", "c2it-witness-"), prefix)
        self.token = prefix + secrets.token_hex(6)
        self.seconds, self.p, self.pid, self.ended_at = seconds, None, None, None
        self.errf = STAGE / f"{self.token}.stderr"           # r3: kept (r2 piped it and never read it)

    def start(self, scratch):
        check(SCRATCH_RX.match(scratch) or (scratch == "postgres" and self.token.startswith("c2it-witness-")), scratch)
        with open(self.errf, "xb") as ef:
            self.p = subprocess.Popen(["docker", "exec", "-e", f"PGAPPNAME={self.token}", PG, "sh", "-c",
                                       'psql -U "${POSTGRES_USER:-postgres}" -d "$1" -X -A -t -q -v ON_ERROR_STOP=1 -c "SELECT pg_sleep($2)"',
                                       "psql", scratch, str(self.seconds)], stdout=subprocess.DEVNULL, stderr=ef)

    def stderr(self):
        try:
            return self.errf.read_text(errors="replace")[-600:]
        except OSError:
            return ""

    def observe(self, scratch, seconds=30):
        """GATE: the holder must be seen ACTIVE on that database (pid, application_name, state, query). Raises otherwise."""
        end = time.monotonic() + seconds
        while time.monotonic() < end:
            out = psql("postgres", f"SELECT pid FROM pg_stat_activity WHERE datname = '{scratch}' AND application_name = '{self.token}' "
                                   "AND state = 'active' AND query LIKE 'SELECT pg_sleep(%';")
            if out:
                self.pid = int(out.split()[0])
                return self.pid
            check(self.p.poll() is None, f"holder exited early rc {self.p.returncode}")
            time.sleep(0.1)
        raise Fail(f"holder {self.token} never observed active on {scratch}")

    def attached(self):
        return int(psql("postgres", f"SELECT count(*) FROM pg_stat_activity WHERE application_name = '{self.token}';")) > 0

    def close(self):
        """stop THIS holder only: its backend by pid+token, then its docker exec client"""
        if self.p is None:
            return "never started"
        ident = f"pid = {int(self.pid)} AND " if self.pid else ""          # pid + token once observed; token alone before that
        psql("postgres", f"SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE {ident}application_name = '{self.token}';")
        try:
            self.p.wait(30)
        except subprocess.TimeoutExpired:
            self.p.kill()
            self.p.wait(10)
        check(not self.attached(), f"holder {self.token} still attached")
        return "closed"


def new_record_scratch(backup, before, proc, seconds=30):
    """the scratch database the running verification just CREATED: a NEW verify-<scratch>.json in the backup directory
    whose state is past 'created (ours)'. That is written after OUR CREATE answered success and before pg_restore."""
    end = time.monotonic() + seconds
    while time.monotonic() < end:
        for f in sorted(Path(backup).glob("verify-indexd_verify_*.json")):
            if f.name in before:
                continue
            try:
                rec = json.loads(f.read_text())
            except (json.JSONDecodeError, OSError):
                continue
            if rec.get("scratchState") not in (None, "none", "intent (CREATE not yet sent)"):
                return rec["scratch"]
        check(proc.poll() is None, f"verification ended before its scratch was created (rc {proc.returncode})")
        time.sleep(0.05)
    raise Fail("no new scratch record appeared")


BARRIER = """DECLARE t0 timestamptz := clock_timestamp();
BEGIN
  LOOP
    PERFORM pg_stat_clear_snapshot();
    EXIT WHEN EXISTS (SELECT 1 FROM pg_stat_activity WHERE datname = current_database() AND application_name = '{tok}'
                      AND pid <> pg_backend_pid());
    IF clock_timestamp() - t0 > interval '60 seconds' THEN RAISE EXCEPTION 'c2it: holder never attached'; END IF;
    PERFORM pg_sleep(0.1);
  END LOOP;
  RAISE LOG 'c2it: barrier saw {tok}';
  PERFORM pg_sleep({sleep});
  RAISE LOG 'c2it: barrier released {tok}';
END"""


def install_barrier(token, sleep):
    """template1 event trigger c2it_barrier: in every scratch database copied from template1, the restore's FIRST DDL
    blocks until THIS harness's holder (exact token) is connected to that database, then sleeps `sleep` s (r3: bounded,
    longer than the restore bound and shorter than the holder). So the restore can never finish before its bound, and
    the holder is attached BEFORE the restore can proceed: an explicit barrier, not a timing assumption. Each poll
    clears the activity snapshot (r3)."""
    check(re.fullmatch(r"c2it-holder-[0-9a-f]{12}", token), token)
    check(isinstance(sleep, int) and 0 < sleep <= 60, sleep)
    psql("template1", "CREATE FUNCTION c2it_barrier() RETURNS event_trigger LANGUAGE plpgsql AS $f$ " + BARRIER.format(tok=token, sleep=sleep) + " $f$;")
    psql("template1", "CREATE EVENT TRIGGER c2it_barrier ON ddl_command_start EXECUTE FUNCTION c2it_barrier();")
    check(psql("template1", "SELECT count(*) FROM pg_event_trigger WHERE evtname = 'c2it_barrier';") == "1", "c2it_barrier installed")


def verify_with_holder(prof, holder_seconds, barrier_seconds):
    """run `verify-backup` (the real CLI, profile `prof`) while THIS harness holds its own connection on the scratch:
    install the barrier, start the CLI, learn the scratch from its record, attach the holder, GATE on observing it active,
    then follow the CLI and the holder to their ends. -> facts (times relative to the CLI start)."""
    h = Holder(holder_seconds)
    before = {f.name for f in Path(S["backup"]).glob("verify-indexd_verify_*.json")}
    install_barrier(h.token, barrier_seconds)
    cli = None
    try:
        t0 = time.monotonic()
        cli = subprocess.Popen([sys.executable, "-B", str(CONTROLLER), "--profile", str(prof), "verify-backup", S["backup"]],
                               stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
        scratch = new_record_scratch(S["backup"], before, cli)
        h.start(scratch)
        pid = h.observe(scratch)
        observed_at = round(time.monotonic() - t0, 1)
        holder_end = None
        while cli.poll() is None:
            if holder_end is None and h.p.poll() is not None:
                holder_end = round(time.monotonic() - t0, 1)
            check(time.monotonic() - t0 < 300, "verification did not end within 300 s")
            time.sleep(0.1)
        cli_end = round(time.monotonic() - t0, 1)
        if holder_end is None and h.p.poll() is not None:
            holder_end = cli_end
        out, err = cli.communicate()
        v = json.loads(out.strip().splitlines()[-1])
        return {"rc": cli.returncode, "v": v, "scratch": scratch, "holder": h, "holderPid": pid, "observedAt": observed_at,
                "holderEnd": holder_end, "holderRc": h.p.returncode, "cliEnd": cli_end, "holderAttachedAtCliEnd": h.p.poll() is None and h.attached(),
                "holderStderr": h.stderr()}
    finally:
        if cli is not None and cli.poll() is None:
            cli.kill()
            cli.wait(10)
        check(remove_trigger("c2it_barrier"), "c2it_barrier removed")
        S.setdefault("holders", []).append(h)


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
    return {"markers": out, "verifyDatabases": verify_dbs(), "serverIdentity": server_identity()}


# ---------------------------------------------------------------- post
S = {}


def x1_success():
    same_server(witness=False)                                  # r3: not reinitialized since "pre" (the 8 stages)
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


def x3a_killed_restore_backend_waited_out():
    """r3: the restore is KILLed at its 2 s bound while its OWN backend sleeps in the trigger (20 s). r1/r2 saw that
    backend end at once only because the r5 bound crash-restarted the server. With the restore fix it lingers, and
    the controller must wait it out before the DROP: r1's original requirement. An UNRELATED witness session (database
    "postgres", 900 s) starts here and must survive to X8."""
    S["witness"] = w = Holder(900, prefix="c2it-witness-")
    S.setdefault("holders", []).append(w)
    w.start("postgres")
    w.observe("postgres")
    install_trigger("c2it_delay", "PERFORM pg_sleep(20);")
    try:
        prof = profile_copy("profile-x3a.json", verify_timeout_seconds=2)
        t0 = time.monotonic()
        rc, v, err = ctl("verify-backup", S["backup"], profile=prof)
        el = round(time.monotonic() - t0, 1)
    finally:
        check(remove_trigger("c2it_delay"), "c2it_delay removed")
    check(rc == 1 and not v["ok"], f"rc {rc} {v}")
    check(any(p.startswith("pg_restore failed") for p in v["problems"]), v["problems"])
    check(v["scratchState"] == "dropped" and v["cleanupOk"], v)
    check(15 <= el < 60, f"elapsed {el}: the killed restore's lingering backend waited out (15 <= t < 60)")
    check(verify_backends() == 0 and verify_dbs() == sorted([MARKER_DB, COLLIDE_DB]), (verify_backends(), verify_dbs()))
    same_server()
    return {"elapsedSeconds": el, "scratch": v["scratch"], "problems": v["problems"][:2], "witness": w.token}


def x3b_held_connection_waited_out():
    """a SEPARATELY HELD connection (this harness's own holder, 40 s) is attached to the scratch BEFORE the restore can
    proceed (barrier) and is observed ACTIVE (gate). The restore is KILLed at 20 s. The controller must WAIT for the
    holder's own natural end before its DROP."""
    prof = profile_copy("profile-x3b.json", verify_timeout_seconds=20)
    f = verify_with_holder(prof, holder_seconds=40, barrier_seconds=25)
    v = f["v"]
    check(f["holderPid"] and f["observedAt"] < 20, f"holder observed active before the restore bound: {f['observedAt']}")
    check(f["rc"] == 1 and not v["ok"] and any(p.startswith("pg_restore failed") for p in v["problems"]), f"rc {f['rc']} {v}")
    check(f["holderRc"] == 0 and f["holderEnd"] is not None,
          f"holder ended by itself (pg_sleep completed): rc {f['holderRc']} stderr {f['holderStderr']!r}")
    check(f["cliEnd"] >= f["holderEnd"] >= 35, f"the controller ended at {f['cliEnd']} s, after the holder's end at {f['holderEnd']} s")
    check(v["scratchState"] == "dropped" and v["cleanupOk"] and v["scratch"] == f["scratch"], v)
    check(verify_backends() == 0 and verify_dbs() == sorted([MARKER_DB, COLLIDE_DB]), (verify_backends(), verify_dbs()))
    same_server()
    return {k: f[k] for k in ("scratch", "holderPid", "observedAt", "holderEnd", "cliEnd")}


def x4_query_budget():
    """the same held connection (60 s) with a SHORT total query budget (verify_query_seconds 12, restore bound 6 s): the
    controller must give up within the budget, report the scratch KEPT and named, cleanupOk false, while the holder is
    still attached. Then this harness closes ITS holder and drops exactly that named scratch."""
    prof = profile_copy("profile-x4.json", verify_timeout_seconds=6, verify_query_seconds=12)
    f = verify_with_holder(prof, holder_seconds=60, barrier_seconds=20)
    v, scratch, h = f["v"], f["scratch"], f["holder"]
    check(f["holderPid"] and f["observedAt"] < 6, f"holder observed active before the restore bound: {f['observedAt']}")
    check(f["rc"] == 1 and not v["cleanupOk"] and v["scratchState"].startswith("KEPT") and v["scratch"] == scratch, f"rc {f['rc']} {v}")
    check(f["cliEnd"] < 30, f"elapsed {f['cliEnd']}: the query budget must bound the verification")
    check(f["holderAttachedAtCliEnd"], "the holder was still attached when the controller gave up")
    check(scratch in verify_dbs(), "the KEPT scratch really remains")
    rec = record_of(S["backup"], scratch)
    check(rec["scratch"] == scratch and rec["cleanupOk"] is False and rec["scratchState"].startswith("KEPT"), rec)
    check(h.close() == "closed", "own holder closed")
    check(SCRATCH_RX.match(scratch) and scratch not in (MARKER_DB, COLLIDE_DB), scratch)
    for _ in range(60):
        if int(psql("postgres", f"SELECT count(*) FROM pg_stat_activity WHERE datname = '{scratch}';")) == 0:
            break
        time.sleep(1)
    check(int(psql("postgres", f"SELECT count(*) FROM pg_stat_activity WHERE datname = '{scratch}';")) == 0,
          "the restore's own backend ended by itself (barrier released) before the harness drop")
    psql("postgres", f'DROP DATABASE "{scratch}";')
    check(scratch not in verify_dbs(), "named leftover dropped by the harness")
    check(verify_backends() == 0 and verify_dbs() == sorted([MARKER_DB, COLLIDE_DB]), (verify_backends(), verify_dbs()))
    same_server()
    return {k: f[k] for k in ("scratch", "holderPid", "observedAt", "cliEnd")} | {"scratchState": v["scratchState"][:80], "harnessDroppedNamedLeftover": True}


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
    same_server()
    check(not crash_lines(server_log()), f"the server log shows a crash-restart: {crash_lines(server_log())[:4]}")
    check(S["witness"].close() == "closed", "own witness closed")
    return {"markersIntact": True, "verifyDatabases": verify_dbs(), "serverIdentity": S["ident"], "witnessSurvived": True}


POST = [("X1-verify-success-restore-digest-drop", x1_success), ("X2-forced-scratch-name-collision-untouched", x2_forced_collision),
        ("X3a-killed-restore-lingering-backend-waited-out-before-drop", x3a_killed_restore_backend_waited_out),
        ("X3b-separately-held-connection-waited-out-before-drop", x3b_held_connection_waited_out),
        ("X4-total-query-budget-held-connection-named-kept", x4_query_budget),
        ("X5-rollback-c2-to-v27", x5_rollback_to_v27), ("X6-corrupt-backup-upgrade-refused-safe-resume", x6_corrupt_backup_upgrade),
        ("X7-server-refused-restore-upgrade-refused-safe-resume", x7_refused_restore_upgrade), ("X8-final-invariants", x8_final)]


def finalize():
    """every exit path: this module's own triggers removed, indexd stopped through the controller"""
    out = {}
    for h in S.get("holders", []):                      # this harness's own holders: closed on every path
        try:
            out[h.token] = h.close()
        except Exception as e:
            out[h.token] = f"UNKNOWN: {type(e).__name__}: {str(e)[-160:]}"
    for t in TRIGGERS:
        try:
            out[t] = "absent" if remove_trigger(t) else "STILL PRESENT"
        except Exception as e:
            out[t] = f"UNKNOWN: {type(e).__name__}: {str(e)[-160:]}"
    rc, s, err = ctl("stop")
    out["indexdStop"] = "stopped" if rc == 0 else f"FAILED rc {rc} {s} {err}"
    out["sessionStderr"] = {h.token: h.stderr() for h in S.get("holders", []) if h.stderr()}
    try:
        log = server_log()
        fd = os.open(STAGE / "pg-server.log", os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        with os.fdopen(fd, "w") as f:
            f.write(log)
        out["serverLog"] = {"kept": "pg-server.log", "crashLines": crash_lines(log)[:6]}
    except Exception as e:
        out["serverLog"] = f"not kept: {type(e).__name__}: {str(e)[-160:]}"
    out["ok"] = all(v == "absent" for k, v in out.items() if k in TRIGGERS) and rc == 0 and \
        all(v in ("closed", "never started") for k, v in out.items() if k.startswith(("c2it-holder-", "c2it-witness-")))
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
    S["ident"] = res["pre"]["serverIdentity"]
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
