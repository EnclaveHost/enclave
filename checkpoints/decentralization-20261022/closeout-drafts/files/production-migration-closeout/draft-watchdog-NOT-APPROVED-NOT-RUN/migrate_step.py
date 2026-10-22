#!/usr/bin/env python3
"""migrate_step.py - ROOT ONLY. A bounded wrapper around the UNCHANGED storage-migration-r5 controller (replicactl.py rev2,
sha256 3e8a8c3f...) for ONE Phase C step on the live primary. It runs ON the VM as root, inside a transient systemd unit, so a
dropped SSH session cannot kill it (production-migration-closeout/PRODUCTION-RECIPE.md has the exact commands).

  migrate_step.py precheck --profile P --step S              read-only; READY or REFUSED (nothing changed)
  migrate_step.py run      --profile P --step S --confirm S  the step, then its post-checks or a proven recovery
  migrate_step.py recover  --profile P --step S [--apply]    re-evaluate an interrupted step (decision only without --apply)
  migrate_step.py drop-scratch --profile P --backup DIR --name N --confirm drop-scratch
                                                             drop ONE named, recorded, unused scratch database

Steps:
- upgrade-27: 2d7a637e (v26) -> fence-enclave c67ffa4d (v27);
- upgrade-28: c67ffa4d (v27) -> c2-enclave 2c0e5b06 (v28);
- rollback-27: 2c0e5b06 (v28) -> c67ffa4d (v27). Add --acknowledge-cas-downgrade only if precheck reports enrolled accounts;
  that is root's decision;
- rollback-26: c67ffa4d (v27) -> 2d7a637e (v26).

What this wrapper adds around the controller (which it never modifies):
H1 pg_dump/psql inside the container are UNBOUNDED in the controller (cmd_backup, Node.psql). A host-side timeout of the
   controller would kill only the docker CLI; the process exec'd inside the container would keep running. While the
   controller runs, a WATCHDOG therefore reads pg_stat_activity every 5 s and pg_terminate_backend()s a CONTROLLER-ERA tool
   session (pg_dump / psql / pg_restore) that is older than its bound. Terminating the backend ends the exec'd tool inside
   the container (its connection is gone).
   A controller-era session:
   - has application_name pg_dump, psql or pg_restore;
   - started at or after this run's T0 (database clock);
   - is not one of the baseline pids at T0;
   - is not this wrapper's own, tagged sessions.
   precheck REQUIRES zero such tool sessions at T0. There is no exact client tag: the controller's docker exec sets none.
   The residual: an operator psql started DURING the window could match. The recipe forbids that.
H2 stop/start/status waits: the whole controller run has a DEADLINE.
   - On expiry: SIGTERM, then SIGKILL, to its own process group (start_new_session; docker CLI children included).
   - Then a final sweep terminates every remaining controller-era tool session, and zero must remain.
   - The transient unit (KillMode=mixed, RuntimeMaxSec) bounds the wrapper itself.
H3 a wrong schema or durability setting makes the controller exit AFTER stopping indexd, without resuming.
   - precheck checks both BEFORE anything stops: db_version, fsync, synchronous_commit, the release, the installed target
     and the migration files.
   - After ANY failure, the recovery below runs.
H4 QueryBudget starts before the restore (restore time is charged to verify_query_seconds). precheck REQUIRES
   verify_query_seconds >= verify_timeout_seconds + 600, so at least 600 s always remain after the slowest allowed restore.

RECOVERY (after a failed, killed or interrupted controller; also `recover --apply`). It proves release and schema before any
start, and never runs a binary whose schema version differs from the database's:
- read `current` (symlink target), db_version (bounded, tagged), and the unit state;
- current is a pinned release whose version == db_version:
  - unit active/running: CONSISTENT (no action);
  - unit inactive: START it, then readiness at that version;
- versions differ AND the unit is inactive, with no writer: switch to THIS step's from/to release whose version == db_version
  (hash-verified), and only that.
  - This covers: an upgrade switched but did not migrate (reverted to the unchanged source); a rollback's down-SQL applied
    but not switched (the rollback completed).
  - current and db_version are re-read immediately before the start; any change aborts.
- anything else is RECOVERY_REQUIRED, with no action. That includes: unreadable state, an unknown release, a unit in
  transition, and a writer running on a mismatched schema.
- A scratch database the controller kept or preserved is NEVER dropped automatically; it is reported by name (drop-scratch).

Exit:
- 0: the step completed and its post-checks passed;
- 1: the step did NOT complete and the unchanged source runs again, verified;
- 3: RECOVERY_REQUIRED (state reported, nothing guessed);
- 4: the step completed but a post-check failed (running; root decides);
- 5: precheck REFUSED (nothing changed);
- 2: usage.
Never prints a secret: the admin password stays in its 0600 file and is read only by the controller."""
import argparse
import fcntl
import hashlib
import json
import os
import re
import secrets
import signal
import subprocess
import sys
import time
from pathlib import Path

TEST_ROOT = os.environ.get("MS_TEST_ROOT")           # tests only; systemd-run gives production a clean environment
P = (lambda p: Path(TEST_ROOT + p)) if TEST_ROOT else Path
CONTROLLER_SHA = os.environ.get("MS_TEST_CONTROLLER_SHA") if TEST_ROOT else "3e8a8c3fde252d80a46e0e445b114fb7a61fcd1fd247dcedc2144f41b2431f63"
ORIG, FENCE, C2 = ("2d7a637e843500f7bd1864d76e1fa310e3163e57adc5d8c19e43598e827de5dc",
                   "c67ffa4d76e54209dbc2a019e1447e79e1cbe7c54d9566b9bd1b491229da9568",
                   "2c0e5b0607740aae8441112c5e341702ef880d772b00c3335cd14ef2ddba23d7")
PRODUCTION_RELEASES = (ORIG, FENCE, C2)
if TEST_ROOT and os.environ.get("MS_TEST_RELEASES"):          # tests only: fake binaries (a real sha cannot be fabricated)
    ORIG, FENCE, C2 = json.loads(os.environ["MS_TEST_RELEASES"])
RELEASES = {ORIG: 26, FENCE: 27, C2: 28}
MIGRATIONS = {"digest.sql": "7f4b137f7049753df1cc414e89e0fa2da563b84c290cf533d8d2f11765104247",
              "down-27-to-26.sql": "2127a7e2fb9f4ccb7d3e9944a913a51fd9eaf8275119a5d683843930e227485c",
              "down-28-to-27.sql": "629f186e28a7f48a36e9bd9ac94139e6a3d24c40784fc26c6190075d212cc873",
              "up-26-to-27.sql": "8d66b19b542b9b81146250418a5e1521c2fc1fbd7ea687c6ffe20e21d59029e5",   # audit copy (the binary applies its own)
              "up-27-to-28.sql": "1043b6452c0279258214ee3527d80d9d2962fea7f3202505acb02b81fc35a225"}
STEPS = {
    "upgrade-27": {"from": ORIG, "to": FENCE, "cmd": ["upgrade", "--sha256", FENCE, "--confirm", "upgrade"]},
    "upgrade-28": {"from": FENCE, "to": C2, "cmd": ["upgrade-c2", "--sha256", C2, "--confirm", "upgrade-c2"]},
    "rollback-27": {"from": C2, "to": FENCE, "cmd": ["rollback-c2", "--fence-sha256", FENCE, "--confirm", "rollback-c2", "--cas-writers-stopped"]},
    "rollback-26": {"from": FENCE, "to": ORIG, "cmd": ["rollback", "--stock-sha256", ORIG, "--confirm", "rollback", "--fenced-writers-stopped"]},
}
LOCK = P("/run/enclave-indexd-snapshot.lock")       # the same lock the fresh-backup runner (1460169a) takes
STATE = P("/var/lib/enclave-indexd/migrate-step")
TOOL_APPS = ("pg_dump", "psql", "pg_restore")
BOUNDS = json.loads(os.environ["MS_TEST_BOUNDS"]) if TEST_ROOT and os.environ.get("MS_TEST_BOUNDS") else \
    {"pg_dump": 600, "psql": 300, "restoreSlack": 60, "deadline": 2700, "watchEvery": 5, "readiness": 600, "sweep": 60,
     "stop": 190, "copy": 60, "startReady": 120, "checks": 120, "h4Margin": 600, "vtMin": 60}
PGOPTS_RO = "-c default_transaction_read_only=on -c statement_timeout=20000 -c lock_timeout=2000"
SCRATCH_RX = re.compile(r"^[a-z0-9_]{1,30}_verify_[0-9a-f]{16}$")


def sha(p):
    h = hashlib.sha256()
    with open(p, "rb") as f:
        for c in iter(lambda: f.read(1 << 20), b""):
            h.update(c)
    return h.hexdigest()


def run(args, timeout, input=None, env=None):
    try:
        r = subprocess.run(args, input=input, capture_output=True, timeout=timeout, env=env)
        return r.returncode, r.stdout.decode(errors="replace"), r.stderr.decode(errors="replace")
    except subprocess.TimeoutExpired:
        return "timeout", "", "timeout"


class Ctx:
    def __init__(self, a):
        self.a = a
        self.prof_path = Path(a.profile)
        self.p = json.loads(self.prof_path.read_text())
        self.rid = time.strftime("%Y%m%dT%H%M%SZ", time.gmtime()) + "-" + secrets.token_hex(4)
        self.tag = f"migrate-step-{self.rid}"
        self.step = STEPS.get(getattr(a, "step", None) or "", None)
        self.journal = None

    # ---- bounded, tagged reads (the wrapper's own sessions: application_name = self.tag) ----
    def psql(self, sql, db=None, write=False, inner=20, outer=40):
        opts = "-c statement_timeout=20000 -c lock_timeout=2000" if write else PGOPTS_RO
        script = 'exec timeout -k 5 "$3" psql -U "${POSTGRES_USER:-postgres}" -d "$1" -X -A -t -q -v ON_ERROR_STOP=1 -c "$2"'
        rc, out, err = run(["docker", "exec", "-e", f"PGAPPNAME={self.tag}", "-e", "PGOPTIONS=" + opts, self.p["pg_container"], "sh", "-c",
                            script, "psql", db or self.p["database"], sql, str(inner)], outer)
        if rc != 0:
            raise RuntimeError(f"psql rc {rc}: {err.strip()[-200:]}")
        return out.strip()

    def db_version(self):
        return int(self.psql("SELECT db_version FROM global_settings;"))

    def now_db(self):
        return self.psql("SELECT to_char(clock_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD\"T\"HH24:MI:SS.US\"Z\"');")

    def tool_sessions(self, since=None, exclude=()):
        """client backends of the tools the controller exec's (pg_dump / psql / pg_restore), never this wrapper's own"""
        where = f"backend_type = 'client backend' AND application_name IN ('pg_dump','psql','pg_restore') AND application_name <> '{self.tag}'"
        if since:
            where += f" AND backend_start >= '{since}'::timestamptz"
        out = self.psql("SELECT pid || '|' || application_name || '|' || coalesce(datname,'') || '|' || "
                        "to_char(backend_start AT TIME ZONE 'UTC', 'YYYY-MM-DD\"T\"HH24:MI:SS.US\"Z\"') || '|' || "
                        f"floor(extract(epoch FROM clock_timestamp() - backend_start))::int FROM pg_stat_activity WHERE {where};", db="postgres")
        rows = []
        for l in out.splitlines():
            pid, app, dbn, start, age = l.split("|")
            if int(pid) not in exclude:
                rows.append({"pid": int(pid), "app": app, "db": dbn, "start": start, "age": int(age)})
        return rows

    def terminate(self, s):
        """terminate ONE controller-era tool session, re-identified in the same statement by pid + app + backend_start"""
        out = self.psql(f"SELECT count(pg_terminate_backend(pid)) FROM pg_stat_activity WHERE pid = {int(s['pid'])} AND "
                        f"application_name = '{s['app']}' AND backend_start = '{s['start']}'::timestamptz;", db="postgres")
        self.log(event="terminated", session=s, matched=out)
        return out == "1"

    # ---- unit and files ----
    def unit(self):
        rc, out, err = run(["systemctl", "show", self.p["unit"], "-p", "ActiveState", "-p", "SubState", "-p", "MainPID"], 20)
        if rc != 0:
            return {"error": f"rc {rc} {err.strip()[-120:]}"}
        s = dict(l.split("=", 1) for l in out.splitlines() if "=" in l)
        return {k: s.get(k, "") for k in ("ActiveState", "SubState", "MainPID")}

    def writer(self):
        rc, _, _ = run(["pgrep", "-u", "enclave-indexd", "-x", "indexd"], 10)
        return {0: True, 1: False}.get(rc, "unknown")

    def current(self):
        cur = Path(self.p["release_dir"]) / "current"
        return os.readlink(cur) if cur.is_symlink() else None

    def release_ok(self, h):
        f = Path(self.p["release_dir"]) / h / "indexd"
        return f.is_file() and not f.is_symlink() and sha(f) == h

    def log(self, **rec):
        rec["at"] = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
        if self.journal:
            with open(self.journal, "a") as f:
                f.write(json.dumps(rec, sort_keys=True) + "\n")
                f.flush()
                os.fsync(f.fileno())

    def controller(self, *args, timeout):
        """one bounded controller call (readiness / digest) -> (rc, last JSON line or {})"""
        rc, out, err = run([sys.executable, "-B", str(self.a.controller), "--profile", str(self.prof_path), *args], timeout)
        try:
            return rc, json.loads(out.strip().splitlines()[-1])
        except Exception:
            return rc, {"raw": out[-200:], "stderr": err[-200:]}


# ---------------------------------------------------------------- precheck (read-only)
def precheck(c, step_name, check_lock=True):
    st, fails, facts = STEPS[step_name], [], {}
    p = c.p
    facts["testRoot"] = TEST_ROOT or "none"
    if not Path(c.a.controller).is_file() or sha(c.a.controller) != CONTROLLER_SHA:
        fails.append(f"controller is not the pinned r5 rev2 ({CONTROLLER_SHA[:8]})")
    if p.get("runner") != "systemd" or not p.get("unit"):
        fails.append("profile runner must be systemd with a unit")
    if not Path(p.get("allow_file", "/nonexistent")).exists():
        fails.append("allow_file absent (the unit's ConditionPathExists guard)")
    for k, mode in (("admin_password_file", 0o600), ("backup_dir", 0o700)):
        v = str(p.get(k, ""))
        if v.startswith("ROOT_DECIDES") or not Path(v).exists():
            fails.append(f"{k} not filled or absent")
        elif (os.stat(v).st_mode & 0o777) != mode or os.stat(v).st_uid != (os.getuid() if TEST_ROOT else 0):
            fails.append(f"{k} must be root-owned mode {oct(mode)}")
    vt, vq = p.get("verify_timeout_seconds"), p.get("verify_query_seconds")
    if not (isinstance(vt, int) and isinstance(vq, int) and BOUNDS["vtMin"] <= vt <= 3600 and vq >= vt + BOUNDS["h4Margin"]):
        fails.append(f"profile needs verify_timeout_seconds ({BOUNDS['vtMin']}..3600) and verify_query_seconds >= verify_timeout_seconds + {BOUNDS['h4Margin']} (H4)")
    elif BOUNDS["stop"] + BOUNDS["pg_dump"] + BOUNDS["copy"] + vq + BOUNDS["startReady"] + BOUNDS["checks"] > BOUNDS["deadline"]:
        fails.append(f"stop + pg_dump + copy + verify {vq} + start/ready + checks exceeds the controller deadline {BOUNDS['deadline']}")
    if not re.fullmatch(r"http://127\.0\.0\.1:\d+", str(p.get("app_url", ""))):
        fails.append("app_url must be the loopback application API (http://127.0.0.1:<port>), not a public name through the fronts")
    mig = Path(p.get("migration_dir", "/nonexistent"))
    for n, h in MIGRATIONS.items():
        f = mig / n
        if not f.is_file() or sha(f) != h:
            fails.append(f"migration {n} differs from its pin")
    cur = c.current()
    facts["current"] = cur
    if cur != st["from"]:
        fails.append(f"current release {cur} is not this step's source {st['from'][:8]}")
    for h in (st["from"], st["to"]):
        if not c.release_ok(h):
            fails.append(f"release {h[:8]} not installed or hash mismatch")
    u = c.unit()
    facts["unit"] = u
    if u.get("ActiveState") != "active" or u.get("SubState") != "running" or u.get("MainPID") in ("", "0"):
        fails.append(f"unit not active/running: {u}")
    try:
        v = c.db_version()
        facts["dbVersion"] = v
        if v != RELEASES[st["from"]]:
            fails.append(f"db_version {v} != {RELEASES[st['from']]} expected for the source release")
        dur = c.psql("SHOW fsync;"), c.psql("SHOW synchronous_commit;")
        facts["durability"] = dur
        if dur[0] != "on" or dur[1] not in ("on", "local", "remote_apply"):
            fails.append(f"durability fsync/synchronous_commit = {dur}")
        tools = c.tool_sessions()
        facts["toolSessions"] = tools
        if tools:
            fails.append(f"pg_dump/psql/pg_restore sessions already present: {[(t['pid'], t['app']) for t in tools]} (no operator sessions during the window)")
        left = c.psql(r"SELECT string_agg(datname, ',') FROM pg_database WHERE datname ~ '_verify_[0-9a-f]{16}$';", db="postgres")
        facts["scratchDatabases"] = left.split(",") if left else []
        if v >= 27:
            facts["accounts"] = dict(zip(("fenced", "enrolled"), map(int, c.psql(
                "SELECT count(*) FILTER (WHERE fence IS NOT NULL) || '|' || " + ("count(*) FILTER (WHERE cas_mode)" if v >= 28 else "0") + " FROM accounts;").split("|"))))
            if step_name == "rollback-27" and facts["accounts"]["enrolled"] and not getattr(c.a, "acknowledge_cas_downgrade", False):
                fails.append(f"{facts['accounts']['enrolled']} account(s) enrolled in CAS: rollback-27 needs --acknowledge-cas-downgrade (root decision; all their writers stopped)")
            if step_name == "rollback-26" and facts["accounts"]["fenced"]:
                fails.append(f"{facts['accounts']['fenced']} fenced account(s): rollback-26 requires every fenced writer stopped (controller flag --fenced-writers-stopped is passed)")
        need = int(c.psql("SELECT pg_database_size(current_database());")) * 2 + 2 * sum(
            f.stat().st_size for f in Path(p["state_dir"]).glob("*") if f.is_file()) + (1 << 30)
        free = os.statvfs(p["backup_dir"]).f_bavail * os.statvfs(p["backup_dir"]).f_frsize
        facts["diskNeedBytes"], facts["diskFreeBytes"] = need, free
        if free < need:
            fails.append(f"backup_dir free {free} < needed {need}")
    except Exception as e:
        fails.append(f"database facts unreadable: {type(e).__name__}: {str(e)[-200:]}")
    if check_lock:
        try:
            fd = os.open(LOCK, os.O_RDWR | os.O_CREAT, 0o600)
            try:
                fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
                fcntl.flock(fd, fcntl.LOCK_UN)
            finally:
                os.close(fd)
        except BlockingIOError:
            fails.append("the snapshot lock is held (a fresh backup or another step runs)")
    return {"step": step_name, "ready": not fails, "failures": fails, "facts": facts}


# ---------------------------------------------------------------- recovery decision (pure) and action
def decide(cur, db, unit, writer, step):
    """-> (action, release, reason). Starts ONLY a pinned release whose schema version equals db_version."""
    if cur is None or cur not in RELEASES:
        return "RECOVERY_REQUIRED", None, f"current release {cur} is not a pinned release"
    if not isinstance(db, int):
        return "RECOVERY_REQUIRED", None, "db_version unreadable"
    if "error" in unit or unit.get("ActiveState") in ("activating", "deactivating", "reloading"):
        return "RECOVERY_REQUIRED", None, f"unit state not settled: {unit}"
    running = unit.get("ActiveState") == "active" or writer is not False
    if RELEASES[cur] == db:
        if unit.get("ActiveState") == "active" and unit.get("SubState") == "running":
            return "CONSISTENT", cur, "running release matches the schema"
        if running:
            return "RECOVERY_REQUIRED", None, f"unit {unit} / writer {writer}: active but not running, or a writer outside the unit"
        return "START", cur, f"release {cur[:8]} matches db_version {db}; unit not running"
    if running:
        return "RECOVERY_REQUIRED", None, f"release {cur[:8]} (v{RELEASES[cur]}) differs from db_version {db} while a writer may run"
    match = [r for r in (step["from"], step["to"]) if RELEASES[r] == db]
    if match:
        return "SWITCH_THEN_START", match[0], f"db_version {db}: only release {match[0][:8]} of this step matches"
    return "RECOVERY_REQUIRED", None, f"no release of this step matches db_version {db}"


def switch_current(c, h):
    rel = Path(c.p["release_dir"])
    tmp = rel / f".current.{c.rid}.tmp"
    os.symlink(h, tmp)                                   # exclusive: fails if the name exists
    os.replace(tmp, rel / "current")


def recover(c, step, apply):
    try:
        db = c.db_version()
    except Exception as e:
        db = f"unreadable: {type(e).__name__}"
    cur, unit, writer = c.current(), c.unit(), c.writer()
    action, rel, why = decide(cur, db, unit, writer, step)
    rep = {"current": cur, "dbVersion": db, "unit": unit, "writer": writer, "decision": action, "release": rel, "reason": why}
    c.log(event="recovery-decision", **rep)
    if not apply or action in ("CONSISTENT", "RECOVERY_REQUIRED"):
        return rep
    if action == "SWITCH_THEN_START":
        if not c.release_ok(rel):
            rep.update(decision="RECOVERY_REQUIRED", reason=f"release {rel[:8]} not installed or hash mismatch")
            return rep
        switch_current(c, rel)
        c.log(event="switched", release=rel)
    # proof immediately before the start: the release and the schema still match
    try:
        db2 = c.db_version()
    except Exception as e:
        db2 = None
    if c.current() != rel or db2 != RELEASES[rel] or c.writer() is not False:
        rep.update(decision="RECOVERY_REQUIRED", reason=f"state changed before start: current {c.current()} db {db2}")
        return rep
    rc, _, err = run(["systemctl", "start", c.p["unit"]], 120)
    c.log(event="started", rc=rc, release=rel)
    rep["started"] = rc == 0
    rep["readiness"] = readiness(c, RELEASES[rel])
    if not rep["readiness"].get("ok"):
        rep.update(decision="RECOVERY_REQUIRED", reason="started but not ready: " + json.dumps(rep["readiness"])[:200])
    return rep


def readiness(c, version):
    end, last = time.monotonic() + BOUNDS["readiness"], {}
    while time.monotonic() < end:
        rc, last = c.controller("readiness", "--expect-version", str(version), timeout=60)
        u = c.unit()
        if rc == 0 and last.get("ok") and u.get("ActiveState") == "active" and u.get("SubState") == "running":
            return {"ok": True, "dbVersion": last.get("dbVersion"), "unit": u}
        time.sleep(min(5, max(0, end - time.monotonic())))
    return {"ok": False, "last": last}


# ---------------------------------------------------------------- post-checks (after the controller reported success)
def postcheck(c, step, out):
    to, v = step["to"], RELEASES[step["to"]]
    r = {"current": c.current(), "unit": c.unit(), "writer": c.writer()}
    r["readiness"] = readiness(c, v)
    try:
        r["dbVersion"] = c.db_version()
        facts = c.psql("SELECT (SELECT count(*) FROM information_schema.columns WHERE table_name='accounts' AND column_name IN "
                       "('fence','fence_receipt','event_seq','seq_enabled','fence_pending')) || '|' || (SELECT count(*) FROM "
                       "information_schema.columns WHERE table_name='accounts' AND column_name IN ('last_op','last_op_digest','cas_mode'))"
                       " || '|' || (SELECT count(*) FROM pg_constraint WHERE NOT convalidated) || '|' || (SELECT count(*) FROM pg_index WHERE NOT indisvalid);")
        r["schema"] = dict(zip(("fenceColumns", "c2Columns", "invalidConstraints", "invalidIndexes"), map(int, facts.split("|"))))
    except Exception as e:
        r["dbError"] = f"{type(e).__name__}: {str(e)[-200:]}"
    want_schema = {26: (0, 0), 27: (5, 0), 28: (5, 3)}[v]
    backup = out.get("backup") or out.get("preRollbackBackup")
    r["backup"] = backup
    rc, d = c.controller("digest", timeout=120)
    try:
        man = json.loads((Path(backup) / "manifest.json").read_text())
        r["digestEqualsBackup"] = rc == 0 and d.get("digest") == man["digest"]
    except Exception as e:
        r["digestEqualsBackup"] = False
        r["digestError"] = f"{type(e).__name__}: {e}"
    rec = sorted(Path(backup).glob("verify-*.json")) if backup and step["cmd"][0].startswith("upgrade") else []
    r["verifyRecords"] = [json.loads(f.read_text()).get("scratchState") for f in rec]
    checks = {
        "current": r["current"] == to,
        "unitRunning": r["unit"].get("ActiveState") == "active" and r["unit"].get("SubState") == "running",
        "ready": r["readiness"].get("ok") is True,
        "dbVersion": r.get("dbVersion") == v,
        "schema": "schema" in r and (r["schema"]["fenceColumns"], r["schema"]["c2Columns"]) == want_schema
        and r["schema"]["invalidConstraints"] == 0 and r["schema"]["invalidIndexes"] == 0,
        "digestEqualsBackup": r["digestEqualsBackup"],
        "controllerOk": out.get("ok") is True,
    }
    if step["cmd"][0].startswith("upgrade"):
        checks["verifiedScratchDropped"] = r["verifyRecords"] == ["dropped"]
        checks["backupVerified"] = out.get("backupVerified") is True
    r["checks"] = checks
    r["ok"] = all(checks.values())
    return r


# ---------------------------------------------------------------- run
def cmd_run(c, a):
    step = STEPS[a.step]
    STATE.mkdir(mode=0o700, parents=True, exist_ok=True)
    c.journal = STATE / f"{c.rid}.journal.jsonl"
    os.close(os.open(c.journal, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600))
    lockfd = os.open(LOCK, os.O_RDWR | os.O_CREAT, 0o600)
    try:
        fcntl.flock(lockfd, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except BlockingIOError:
        print(json.dumps({"exit": 5, "refused": "snapshot lock held"}))
        return 5
    pre = precheck(c, a.step, check_lock=False)      # this run holds the lock now
    c.log(event="precheck", **pre)
    if not pre["ready"]:
        print(json.dumps({"exit": 5, "runId": c.rid, "precheck": pre}))
        return 5
    t0 = c.now_db()
    baseline = {s["pid"] for s in c.tool_sessions()}
    c.log(event="t0", t0=t0, baseline=sorted(baseline))
    stop_now = {"flag": False}
    signal.signal(signal.SIGTERM, lambda *_: stop_now.update(flag=True))
    signal.signal(signal.SIGHUP, lambda *_: stop_now.update(flag=True))
    log = open(STATE / f"{c.rid}.controller.log", "ab")
    cmd = list(step["cmd"]) + (["--acknowledge-cas-downgrade"] if a.step == "rollback-27" and a.acknowledge_cas_downgrade else [])
    proc = subprocess.Popen([sys.executable, "-B", str(a.controller), "--profile", str(c.prof_path), *cmd],
                            stdout=subprocess.PIPE, stderr=log, start_new_session=True, env={"PATH": os.environ.get("PATH", "/usr/sbin:/usr/bin:/sbin:/bin")})
    c.log(event="controller-started", pid=proc.pid, cmd=cmd)
    deadline, killed, watched = time.monotonic() + BOUNDS["deadline"], None, []
    restore_bound = int(c.p["verify_timeout_seconds"]) + BOUNDS["restoreSlack"]
    lim = {"pg_dump": BOUNDS["pg_dump"], "psql": BOUNDS["psql"], "pg_restore": restore_bound}
    out_buf = []
    os.set_blocking(proc.stdout.fileno(), False)
    while proc.poll() is None:
        chunk = proc.stdout.read()               # non-blocking: None when nothing is buffered
        if chunk:
            out_buf.append(chunk)
        if time.monotonic() > deadline or stop_now["flag"]:
            killed = "deadline" if not stop_now["flag"] else "signal"
            break
        try:
            for s in c.tool_sessions(since=t0, exclude=baseline):        # H1 watchdog
                if s["age"] > lim[s["app"]]:
                    watched.append({"session": s, "terminated": c.terminate(s)})
        except Exception as e:
            c.log(event="watchdog-read-failed", error=str(e)[-200:])
        time.sleep(BOUNDS["watchEvery"])
    if killed:
        for sig, wait in ((signal.SIGTERM, 15), (signal.SIGKILL, 10)):
            try:
                os.killpg(proc.pid, sig)
            except ProcessLookupError:
                break
            try:
                proc.wait(wait)
                break
            except subprocess.TimeoutExpired:
                continue
        c.log(event="controller-killed", reason=killed, rc=proc.returncode)
    rest = proc.stdout.read() if proc.stdout else b""
    out_text = b"".join(out_buf + ([rest] if rest else [])).decode(errors="replace")
    rc = proc.returncode
    # final sweep: every controller-era tool session left now is an orphan of this run (its client is gone or done)
    sweep, end = [], time.monotonic() + BOUNDS["sweep"]
    while True:
        try:
            left = c.tool_sessions(since=t0, exclude=baseline)
        except Exception as e:
            sweep.append({"error": str(e)[-160:]})
            left = None
            break
        if not left or time.monotonic() > end:
            break
        for s in left:
            sweep.append({"session": s, "terminated": c.terminate(s)})
        time.sleep(1)
    try:
        out = json.loads(out_text.strip().splitlines()[-1]) if out_text.strip() else {}
    except Exception:
        out = {"raw": out_text[-300:]}
    res = {"runId": c.rid, "step": a.step, "controllerRc": rc, "controllerKilled": killed, "controllerOut": out,
           "watchdog": watched, "sweep": sweep, "toolSessionsLeft": left}
    if left:
        res.update(outcome="RECOVERY_REQUIRED", exit=3, reason="controller-era database tool sessions remain")
    elif rc == 0 and out.get("ok") is True and not killed:
        res["postcheck"] = postcheck(c, step, out)
        res.update(outcome="STEP_DONE_VERIFIED" if res["postcheck"]["ok"] else "STEP_DONE_POSTCHECK_FAILED",
                   exit=0 if res["postcheck"]["ok"] else 4)
    else:
        rec = recover(c, step, apply=True)
        res["recovery"] = rec
        if rec["decision"] in ("CONSISTENT", "START", "SWITCH_THEN_START") and (rec["decision"] == "CONSISTENT" or (rec.get("readiness") or {}).get("ok")):
            final = c.current()
            if final == step["from"]:
                res.update(outcome="STEP_NOT_DONE_SOURCE_RESUMED", exit=1)
            elif final == step["to"]:
                res["postcheck"] = postcheck(c, step, out) if (out.get("backup") or out.get("preRollbackBackup")) else None
                res.update(outcome="STEP_DONE_AFTER_RECOVERY", exit=0 if res["postcheck"] and res["postcheck"]["ok"] else 4)
            else:
                res.update(outcome="RECOVERY_REQUIRED", exit=3)
        else:
            res.update(outcome="RECOVERY_REQUIRED", exit=3)
        res["scratchKept"] = kept_scratch(out)
    c.log(event="result", **{k: res[k] for k in ("outcome", "exit")})
    (STATE / f"{c.rid}.result.json").write_text(json.dumps(res, indent=1) + "\n")
    print(json.dumps({k: res.get(k) for k in ("runId", "step", "outcome", "exit", "controllerRc", "controllerKilled")}))
    return res["exit"]


def kept_scratch(out):
    v = out.get("verify") if isinstance(out, dict) else None
    if isinstance(v, dict) and v.get("scratch") and not v.get("cleanupOk", True):
        return [{"scratch": v["scratch"], "state": v.get("scratchState"), "backup": out.get("backup")}]
    return []


def cmd_drop_scratch(c, a):
    n, b = a.name, Path(a.backup)
    if a.confirm != "drop-scratch" or not SCRATCH_RX.match(n) or not n.startswith(re.sub(r"[^a-z0-9_]", "_", c.p["database"].lower())[:30] + "_verify_"):
        print(json.dumps({"ok": False, "error": "refused: name/confirm"}))
        return 5
    rec = b / f"verify-{n}.json"
    if not rec.is_file() or json.loads(rec.read_text()).get("scratch") != n or json.loads(rec.read_text()).get("cleanupOk") is not False:
        print(json.dumps({"ok": False, "error": "refused: no verification record naming it as left by this controller"}))
        return 5
    for _ in range(2):
        if c.psql(f"SELECT count(*) FROM pg_stat_activity WHERE datname = '{n}';", db="postgres") != "0":
            print(json.dumps({"ok": False, "error": "refused: a backend is connected to it"}))
            return 5
        time.sleep(2)
    if c.psql(f"SELECT count(*) FROM pg_database WHERE datname = '{n}';", db="postgres") != "1":
        print(json.dumps({"ok": False, "error": "refused: no such database"}))
        return 5
    c.psql(f'DROP DATABASE "{n}";', db="postgres", write=True)
    gone = c.psql(f"SELECT count(*) FROM pg_database WHERE datname = '{n}';", db="postgres") == "0"
    print(json.dumps({"ok": gone, "dropped": n}))
    return 0 if gone else 3


def main(argv):
    ap = argparse.ArgumentParser()
    ap.add_argument("cmd", choices=["precheck", "run", "recover", "drop-scratch"])
    ap.add_argument("--profile", required=True)
    ap.add_argument("--controller", default="/root/indexd-migration/replicactl.py")
    ap.add_argument("--step", choices=sorted(STEPS))
    ap.add_argument("--confirm")
    ap.add_argument("--apply", action="store_true")
    ap.add_argument("--acknowledge-cas-downgrade", action="store_true")
    ap.add_argument("--backup")
    ap.add_argument("--name")
    a = ap.parse_args(argv)
    print(f"ms.testRoot={TEST_ROOT or 'none'}", file=sys.stderr)
    c = Ctx(a)
    if a.cmd == "drop-scratch":
        return cmd_drop_scratch(c, a)
    if not a.step:
        print(json.dumps({"error": "--step required"}))
        return 2
    if a.cmd == "precheck":
        r = precheck(c, a.step)
        print(json.dumps(r, indent=1))
        return 0 if r["ready"] else 5
    if a.cmd == "recover":
        STATE.mkdir(mode=0o700, parents=True, exist_ok=True)
        c.journal = STATE / f"{c.rid}.recover.jsonl"
        r = recover(c, STEPS[a.step], a.apply)
        print(json.dumps(r, indent=1))
        return 0 if r["decision"] in ("CONSISTENT",) or (a.apply and (r.get("readiness") or {}).get("ok")) else 3
    if a.confirm != a.step:
        print(json.dumps({"error": f"refusing: pass --confirm {a.step}"}))
        return 2
    return cmd_run(c, a)


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
