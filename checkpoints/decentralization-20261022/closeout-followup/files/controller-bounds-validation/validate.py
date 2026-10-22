#!/usr/bin/env python3
"""validate.py - ONE bounded REAL-PostgreSQL validation of the controller bounds delta (frozen 1543577f, derived fixture
copy) and of the B2 runner `--foreground` copy's in-container timeout shapes.
- No indexd, no Go, not the eight stages.
- Dummy data only.

Every case has its own unrelated SENTINEL session: a psql `pg_sleep` on the same database, with its own token. The
sentinel must end BY ITSELF with rc 0. After the case, the server log must have no crash line. PID 1, the postmaster
start time and the checkpointer pid must be unchanged. No timeout/psql/pg_dump/sleep process may remain in the
container (no orphan, no zombie).

Cases:
  C1p/C1f SQL through the bounded Node.psql/psql_rc, on the production copy and on the fixture copy:
          - answers and digest;
          - the server sees statement_timeout = t, lock_timeout 30s, application_name replicactl-<RUN_ID>;
          - a running query is observed under exactly that tag;
          - a server-reported error is still psql exit 3 (the restore fix's "definite" class).
  C2      successful cmd_backup (tagged, bounded pg_dump), then the restore fix's verify_backup of it: ok, cleanupOk,
          scratch dropped.
  C3      blocked psql, server-side bound: a harness HOLDER keeps ACCESS EXCLUSIVE on the table. Node.psql(t=4) raises
          within t+4 s; the holder is unaffected.
  C4      container-side KILL path: psql_rc of 12 x pg_sleep(0.8), t=3. statement_timeout never fires, so GNU
          `timeout --foreground` KILLs psql: rc 137 well before the host bound (t+15). The tagged backend is gone within
          5 s.
  C5      bounded pg_dump behind the held lock (dump_timeout_seconds 4):
          - its backend is observed under the exact tag, waiting on a Lock;
          - cmd_backup dies with "pg_dump failed" within 4+4 s;
          - the backup has NO manifest, and verify_backup of it is ok false with nothing created.
  C6a     B2 copy: the runner's exact psql shape (with its PGOPTIONS) answers.
  C6b     B2 copy: the runner's exact pg_dump shape behind the held lock, bound 2 s (before its own 5 s lock wait).
          timeout TERMs pg_dump and reaps it: rc 124.
  C6c     B2 copy: KILL phase under --foreground (a TERM-ignoring single process `sh -c 'trap "" TERM; exec sleep 30'`,
          bound 1 s, -k 5): rc 137 at about 6 s.
  C6d     the ORIGINAL runner 1460169a pg_dump shape behind the held lock: the TERM phase is reaped (rc 124), no crash.
  C6e     NEGATIVE CONTROL, last: the ORIGINAL runner shape (no --foreground) in its KILL phase, with the TERM-ignoring
          process. The crash is EXPECTED: sentinel rc 2, crash lines, and the checkpointer reinitialized. This is G4.

Ownership/cleanup: c2fx.py (storage-enclave-fixture, pin ff1b092c) is used read-only:
- exclusive journal, exclusive stage with marker;
- a run-id-labelled volume/container (--pull never, 127.0.0.1 port, --memory 256m);
- its own queue scope drained, and labelled removal.
Usage: ONE shared-queue job at 768 MiB (the container's 256 MiB is outside it).
  validate.py --plan | --execute <manifest> | --recover <run id>"""
import ast
import contextlib
import hashlib
import importlib.util
import io
import json
import os
import re
import secrets
import signal
import subprocess
import sys
import threading
import time
import traceback
from pathlib import Path

HERE = Path(__file__).resolve().parent
WORK = next(p for p in HERE.parents if p.name == "work")
RUNS = HERE / "runs"
C2FX = WORK / "claude-resumed-20261022/storage-enclave-fixture/fixture/c2fx.py"
PROD = HERE / "frozen/replicactl.r5-production.restorefix.bounds.py"
FIXB = HERE / "derived/replicactl.fixture-r5.restorefix.bounds.py"
B2NEW = HERE / "b2/vm_fresh_backup.foreground.py"
B2OLD = WORK / "claude-resumed-20261022/storage-fresh-backup/runner/vm_fresh_backup.py"
PINS = {str(C2FX): "ff1b092c54135df64b506b1683fb48679f678f21e6ec5d28ef6fb54a66534ad6",
        str(PROD): "1543577f4bdbc1bc94dca950e55ac0ece5eb6a65272622aa90244ef2ba7c0e83",
        str(FIXB): "0a6f56868d481238815f8b8dca41c764790cd38a55030854cedaab047d281a98",
        str(B2NEW): "62f4369029f6f66d1811ce25f9358a326b030913f67e1592df0f367600c67eb4",
        str(B2OLD): "1460169a15b7bc44748d0f8a6891f208ca045cf92de6abdcedc74956c0c5d1c6"}
MAX_SCOPE = 768 * 1024 * 1024
PG_MEM_MIB = 256
DB = "bvsrc"
SENT = 20
CRASH_RX = re.compile(r"terminating any other active server processes|all server processes terminated; reinitializing"
                      r"|was terminated by signal|terminating connection because of crash of another server process|untracked child process")
TERM_IGNORING = "sh -c 'trap \"\" TERM; exec sleep 30'"     # sleep inherits SIG_IGN for TERM: one process that survives TERM


def sha(p):
    return hashlib.sha256(Path(p).read_bytes()).hexdigest()


def load(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    m = importlib.util.module_from_spec(spec)
    sys.modules[name] = m
    spec.loader.exec_module(m)
    return m


def b2_shapes(path):
    """the runner's own literals, read by AST (the runner is never imported or run): psql script, pg_dump script, PGOPTS"""
    t = ast.parse(Path(path).read_text())
    out = {}
    for fn in ast.walk(t):
        if isinstance(fn, ast.FunctionDef) and fn.name in ("psql", "capture"):
            for n in ast.walk(fn):
                if isinstance(n, ast.Assign) and getattr(n.targets[0], "id", None) == "script":
                    out[fn.name] = ast.literal_eval(n.value)
    for n in t.body:
        if isinstance(n, ast.Assign) and getattr(n.targets[0], "id", None) == "PGOPTS":
            out["PGOPTS"] = ast.literal_eval(n.value)
    return out


def pins():
    got = {str(p): sha(p) for p in (C2FX, PROD, FIXB, B2NEW, B2OLD, Path(__file__).resolve())}
    bad = [p for p, h in PINS.items() if got[p] != h]
    new, old = b2_shapes(B2NEW), b2_shapes(B2OLD)
    if not (new.get("capture", "").startswith('exec timeout --foreground -k 5 "$2" pg_dump') and
            new.get("psql", "").startswith("exec timeout --foreground -k 5 20 psql") and
            old.get("capture", "").startswith('exec timeout -k 5 "$2" pg_dump') and new.get("PGOPTS") == old.get("PGOPTS")):
        bad.append("B2 shapes not as expected")
    return got, bad


def manifest(got):
    return hashlib.sha256(json.dumps(got, sort_keys=True).encode()).hexdigest()


class Lab:
    """this job's own container: every call names it explicitly; the harness's own queries are bounded the same way"""

    def __init__(self, run, docker):
        self.run, self.docker, self.c = run, docker, run.container
        self.t0 = time.monotonic()

    def t(self):
        return round(time.monotonic() - self.t0, 2)

    def sh(self, script, *args, timeout=60, env=()):
        e = [x for k in env for x in ("-e", k)]
        return self.docker.run("exec", *e, self.c, "sh", "-c", script, "sh", *args, timeout=timeout)

    def psql(self, db, sql, timeout=30):
        r = subprocess.run(["docker", "exec", "-i", "-e", "PGAPPNAME=bv-harness", self.c, "sh", "-c",
                            'exec timeout --foreground -s KILL "$2" psql -U "${POSTGRES_USER:-postgres}" -d "$1" -X -A -t -q -v ON_ERROR_STOP=1 -f -',
                            "psql", db, str(timeout)], input=sql.encode(), capture_output=True, timeout=timeout + 15)
        if r.returncode != 0:
            raise RuntimeError(f"psql {db}: rc {r.returncode} {r.stderr.decode()[-300:]}")
        return r.stdout.decode().strip()

    def ready(self, seconds=60):
        end = time.monotonic() + seconds
        while time.monotonic() < end:
            try:
                if self.psql("postgres", "SELECT 1;", timeout=10) == "1":
                    return True
            except (RuntimeError, subprocess.TimeoutExpired):
                pass
            time.sleep(0.5)
        return False

    def log_lines(self):
        rc, out, err = self.docker.run("logs", "--timestamps", self.c, timeout=60)
        return (out + err).splitlines() if rc == 0 else [f"<docker logs rc {rc}: {err.strip()[-200:]}>"]

    def tree(self):
        rc, out, _ = self.sh('for d in /proc/[0-9]*; do s=$(cat "$d/stat" 2>/dev/null) || continue; '
                             'a=$(tr "\\0" " " < "$d/cmdline" 2>/dev/null); printf "%s\\t%s\\n" "$s" "$a"; done', timeout=30)
        rows = []
        for line in out.splitlines():
            st, _, argv = line.partition("\t")
            m = re.match(r"^(\d+) \((.*)\) (\S) (\d+) (\d+) (\d+)", st)
            if m:
                rows.append({"pid": int(m[1]), "comm": m[2], "state": m[3], "ppid": int(m[4]), "pgid": int(m[5]), "argv": argv.strip()[:120]})
        return rows

    def leftovers(self):
        """tool processes left in the container (the listing's own sh/cat/tr excluded by name)"""
        return [r for r in self.tree() if r["comm"] in ("timeout", "psql", "pg_dump", "pg_restore", "sleep") or r["state"] == "Z"]

    def ident(self):
        rc, out, _ = self.sh("cat /proc/1/stat", timeout=30)
        f1 = out.split(")", 1)[1].split() if rc == 0 else []
        r = {"pid1Comm": out.split("(", 1)[1].split(")", 1)[0] if rc == 0 else None, "pid1StartTicks": f1[19] if len(f1) > 19 else None}
        try:
            r["postmasterStart"], r["checkpointer"] = self.psql(
                "postgres", "SELECT pg_postmaster_start_time(), (SELECT pid FROM pg_stat_activity WHERE backend_type = 'checkpointer');",
                timeout=20).split("|")
        except (RuntimeError, subprocess.TimeoutExpired, ValueError) as e:
            r["postmasterStart"] = r["checkpointer"] = f"unreadable: {str(e)[-120:]}"
        rc, out, _ = self.docker.run("inspect", "--format", "{{.State.OOMKilled}} {{.State.Status}} {{.RestartCount}}", self.c, timeout=30)
        r["dockerState"] = out.strip()
        return r

    def tagged(self, app, extra=""):
        return self.psql("postgres", f"SELECT coalesce(string_agg(pid || ':' || coalesce(datname, '') || ':' || state || ':' || "
                                     f"coalesce(wait_event_type, ''), ' '), '') FROM pg_stat_activity WHERE application_name = '{app}' {extra};",
                         timeout=20)


class Session:
    """one OWN psql session (holder or sentinel) on this job's container, identified by its own token"""

    def __init__(self, lab, role, sql, seconds):
        self.lab, self.role, self.sql, self.seconds = lab, role, sql, seconds
        self.token = f"bv{role}-{secrets.token_hex(6)}"
        self.p, self.pid, self.ended, self.rc, self.err = None, None, None, None, b""

    def start(self):
        self.p = subprocess.Popen(["docker", "exec", "-e", f"PGAPPNAME={self.token}", self.lab.c, "sh", "-c",
                                   'exec timeout --foreground -s KILL "$3" psql -U "${POSTGRES_USER:-postgres}" -d "$1" -X -A -t -q -v ON_ERROR_STOP=1 -c "$2"',
                                   "psql", DB, self.sql, str(self.seconds + 30)],
                                  stdout=subprocess.DEVNULL, stderr=subprocess.PIPE, stdin=subprocess.DEVNULL)
        threading.Thread(target=self._wait, daemon=True).start()
        end = time.monotonic() + 20
        while time.monotonic() < end:
            out = self.lab.psql("postgres", f"SELECT pid FROM pg_stat_activity WHERE application_name = '{self.token}' "
                                            "AND state = 'active' AND query LIKE '%pg_sleep(%';", timeout=20)
            if out:
                self.pid = int(out.split()[0])
                return self
            if self.p.poll() is not None:
                break
            time.sleep(0.1)
        raise RuntimeError(f"{self.token} never observed active (rc {self.p.poll()})")

    def _wait(self):
        _, self.err = self.p.communicate()
        self.rc, self.ended = self.p.returncode, self.lab.t()

    def active(self):
        return bool(self.lab.psql("postgres", f"SELECT 1 FROM pg_stat_activity WHERE pid = {int(self.pid)} AND "
                                              f"application_name = '{self.token}' AND state = 'active';", timeout=20))

    def join(self, seconds):
        end = time.monotonic() + seconds
        while self.ended is None and time.monotonic() < end:
            time.sleep(0.2)
        return self.ended is not None

    def close(self):
        """end THIS session only: its backend by pid+token, then its client"""
        if self.p is None or self.p.poll() is not None:
            return
        if self.pid:
            try:
                self.lab.psql("postgres", f"SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE pid = {int(self.pid)} "
                                          f"AND application_name = '{self.token}';", timeout=20)
            except (RuntimeError, subprocess.TimeoutExpired):
                pass
        try:
            self.p.wait(20)
        except subprocess.TimeoutExpired:
            self.p.kill()
            self.p.wait(10)

    def report(self):
        return {"token": self.token, "backendPid": self.pid, "endedAt": self.ended, "rc": self.rc, "stderr": self.err.decode(errors="replace")[-400:]}


def holder(lab):
    return Session(lab, "hold", "BEGIN; LOCK TABLE bv_t IN ACCESS EXCLUSIVE MODE; SELECT pg_sleep(60); COMMIT;", 60).start()


def sentinel(lab):
    return Session(lab, "sent", f"SELECT pg_sleep({SENT})", SENT).start()


def case(lab, ev, name, body, want_crash=False):
    """run ONE case between its own sentinel and the crash/orphan witnesses; body(res) fills res and its expectations"""
    res = {"name": name, "wantCrash": want_crash, "expectations": []}
    before = len(lab.log_lines())
    res["identBefore"] = lab.ident()
    s = sentinel(lab)
    res["startedAt"] = lab.t()
    try:
        body(res)
    except Exception as e:
        res["error"] = f"{type(e).__name__}: {str(e)[-400:]}"
        res["traceback"] = traceback.format_exc()[-1500:]
    finally:
        for h in res.pop("_close", []):
            h.close()
    s.join(SENT + 30)
    res["sentinel"] = s.report()
    s.close()
    res["readyAfter"] = lab.ready()
    lines = lab.log_lines()[before:]
    res["crashLines"] = [l for l in lines if CRASH_RX.search(l)][:20]
    res["identAfter"] = lab.ident()
    time.sleep(1)
    res["leftovers"] = lab.leftovers()
    (ev / f"{name}.server.log").write_text("\n".join(lines) + "\n")
    expect(res, "unrelated sentinel rc", 2 if want_crash else 0, res["sentinel"]["rc"])
    expect(res, "crash lines in the server log", want_crash, bool(res["crashLines"]))
    expect(res, "PID 1 (postmaster) start unchanged", True, res["identBefore"]["pid1StartTicks"] == res["identAfter"]["pid1StartTicks"])
    expect(res, "checkpointer reinitialized", want_crash, res["identBefore"]["checkpointer"] != res["identAfter"]["checkpointer"])
    expect(res, "no tool process or zombie left in the container", [], res["leftovers"])
    expect(res, "server answers afterwards", True, res["readyAfter"])
    res["ok"] = "error" not in res and all(e["ok"] for e in res["expectations"])
    return res


def expect(res, what, want, got):
    res["expectations"].append({"what": what, "want": want, "got": got, "ok": want == got})


def quiet(fn, *a):
    """call a controller function that may die(): -> (exit code or None, return value, last stdout JSON or None)"""
    buf = io.StringIO()
    code, val = None, None
    with contextlib.redirect_stdout(buf):
        try:
            val = fn(*a)
        except SystemExit as e:
            code = e.code
    lines = buf.getvalue().strip().splitlines()
    try:
        out = json.loads(lines[-1]) if lines else None
    except ValueError:
        out = {"raw": lines[-1][-300:]}
    return code, val, out


def seed(lab, stage):
    lab.psql(DB, "CREATE TABLE global_settings (db_version int NOT NULL); INSERT INTO global_settings VALUES (28);"
                 "CREATE TABLE bv_t (id int PRIMARY KEY, v text NOT NULL);"
                 "INSERT INTO bv_t SELECT g, md5(g::text) FROM generate_series(1, 3000) g;")
    mig = stage / "migration"
    mig.mkdir(mode=0o700)
    (mig / "digest.sql").write_text("SELECT 'bv_t|' || count(*) || '|' || md5(coalesce(string_agg(id::text || ':' || v, ',' "
                                    "ORDER BY id), '')) FROM bv_t;\n")
    return mig


def profile(run, mig, name, **extra):
    d = run.stage / name
    for sub in ("state", "rel", "backups"):
        (d / sub).mkdir(parents=True, mode=0o700)
    p = {"runner": "process", "pg_container": run.container, "database": DB, "migration_dir": str(mig), "state_dir": str(d / "state"),
         "release_dir": str(d / "rel"), "backup_dir": str(d / "backups"), "verify_timeout_seconds": 60, "verify_query_seconds": 600}
    p.update(extra)
    (d / "profile.json").write_text(json.dumps(p))
    return d / "profile.json", d / "backups"


def verify_dbs(lab):
    return lab.psql("postgres", "SELECT coalesce(string_agg(datname, ','), '') FROM pg_database WHERE datname LIKE 'bvsrc\\_verify%';")


def body_all(run, lab, ev, exps, prod, fixb):
    mig = seed(lab, run.stage)

    def c1(m, label):
        def body(res):
            node = m.Node(profile(run, mig, f"c1{label}")[0])
            tag = "replicactl-" + m.RUN_ID
            expect(res, "SELECT 1", "1", node.psql("SELECT 1;"))
            expect(res, "db_version", 28, node.db_version())
            expect(res, "digest rows", 3000, node.digest()["bv_t"]["rows"])
            expect(res, "server statement_timeout = t", "7s", node.psql("SHOW statement_timeout;", timeout=7))
            expect(res, "server lock_timeout", "30s", node.psql("SHOW lock_timeout;"))
            expect(res, "server application_name = exact run tag", tag, node.psql("SHOW application_name;"))
            rc, _, err = node.psql_rc("SELECT 1/0;", db=DB, timeout=10)
            expect(res, "server-reported error stays psql exit 3", 3, rc)
            box = {}
            th = threading.Thread(target=lambda: box.update(v=node.psql("SELECT pg_sleep(3);", timeout=20)), daemon=True)
            th.start()
            seen, end = "", time.monotonic() + 3
            while not seen and time.monotonic() < end:
                seen = lab.tagged(tag, f"AND datname = '{DB}' AND state = 'active' AND query LIKE 'SELECT pg_sleep(3)%'")
                time.sleep(0.1)
            th.join(30)
            expect(res, "running query observed under the exact tag", True, bool(seen))
            res["observed"] = seen
        exps.append(case(lab, ev, f"C1{label}-sql-tag-options", body))

    c1(prod, "p")
    c1(fixb, "f")

    def c2(res):
        prof, backups = profile(run, mig, "c2")
        node = prod.Node(prof)
        code, b, out = quiet(prod.cmd_backup, node, None, True)
        expect(res, "cmd_backup returned (no die)", None, code)
        man = json.loads((b / "manifest.json").read_text())
        expect(res, "manifest dbVersion", 28, man["dbVersion"])
        expect(res, "dump hash = manifest", man["files"]["indexd.pgdump"]["sha256"], prod.sha256(b / "indexd.pgdump"))
        rep = prod.verify_backup(node, b)
        res["verify"] = {k: rep.get(k) for k in ("ok", "cleanupOk", "scratchState", "problems", "scratch")}
        expect(res, "verify ok + cleanupOk + dropped", [True, True, "dropped"], [rep["ok"], rep["cleanupOk"], rep["scratchState"]])
        expect(res, "no scratch database left", "", verify_dbs(lab))
    exps.append(case(lab, ev, "C2-successful-backup-and-verify", c2))

    def c3(res):
        node = prod.Node(profile(run, mig, "c3")[0])
        h = holder(lab)
        res["_close"] = [h]
        t0 = time.monotonic()
        try:
            node.psql("SELECT count(*) FROM bv_t;", timeout=4)
            raised = None
        except RuntimeError as e:
            raised = str(e)[-200:]
        el = round(time.monotonic() - t0, 2)
        res["elapsed"], res["raised"] = el, raised
        expect(res, "blocked psql raised", True, raised is not None)
        expect(res, "bounded: within t+4 s (host bound is t+15)", True, el < 8)
        expect(res, "holder unaffected (still active)", True, h.active())
        tag, gone, end = "replicactl-" + prod.RUN_ID, None, time.monotonic() + 6
        while time.monotonic() < end:
            gone = lab.tagged(tag)
            if not gone:
                break
            time.sleep(0.2)
        expect(res, "its backend is gone (server-side statement_timeout = t bounds a lock wait)", "", gone)
    exps.append(case(lab, ev, "C3-bounded-blocked-psql", c3))

    def c4(res):
        node = prod.Node(profile(run, mig, "c4")[0])
        tag = "replicactl-" + prod.RUN_ID
        t0 = time.monotonic()
        rc, out, err = node.psql_rc("SELECT pg_sleep(0.8);\n" * 12, db=DB, timeout=3)
        el = round(time.monotonic() - t0, 2)
        res["elapsed"], res["rc"] = el, rc
        expect(res, "psql KILLed in the container: rc 137", 137, rc)
        expect(res, "bounded at about t (not the host t+15)", True, 2.5 < el < 7)
        gone, end = None, time.monotonic() + 5
        while time.monotonic() < end:
            gone = lab.tagged(tag)
            if not gone:
                break
            time.sleep(0.2)
        expect(res, "the killed psql's backend is gone within 5 s", "", gone)
    exps.append(case(lab, ev, "C4-container-kill-path", c4))

    def c5(res):
        prof, backups = profile(run, mig, "c5", dump_timeout_seconds=4)
        node = prod.Node(prof)
        tag = "replicactl-" + prod.RUN_ID
        h = holder(lab)                      # holds 60 s: longer than the 30 s server-side lock bound checked below
        res["_close"] = [h]
        box = {}
        t0 = time.monotonic()
        th = threading.Thread(target=lambda: box.update(r=quiet(prod.cmd_backup, node, None, True)), daemon=True)
        th.start()
        seen, end = "", time.monotonic() + 3.5
        while not seen and time.monotonic() < end:
            seen = lab.tagged(tag, f"AND datname = '{DB}' AND wait_event_type = 'Lock'")
            time.sleep(0.1)
        th.join(30)
        el = round(time.monotonic() - t0, 2)
        code, _, out = box.get("r", (None, None, None))
        res["elapsed"], res["out"], res["observed"] = el, out, seen
        expect(res, "pg_dump observed under the exact tag, waiting on the lock", True, bool(seen))
        expect(res, "cmd_backup died (exit 2) with pg_dump failed", [2, True], [code, bool(out) and str(out.get("error", "")).startswith("pg_dump failed")])
        expect(res, "bounded within 4+4 s (its lock wait would be 30 s)", True, el < 8)
        dirs = [d for d in backups.iterdir() if d.is_dir()]
        expect(res, "one backup dir, WITHOUT manifest", [1, False], [len(dirs), any((d / "manifest.json").exists() for d in dirs)])
        if dirs:
            rep = prod.verify_backup(node, dirs[0])
            res["verify"] = {k: rep.get(k) for k in ("ok", "cleanupOk", "scratchState", "problems")}
            expect(res, "incomplete backup is never verified; nothing created", [False, True, "none"], [rep["ok"], rep["cleanupOk"], rep["scratchState"]])
        expect(res, "no scratch database", "", verify_dbs(lab))
        expect(res, "holder unaffected (still active)", True, h.active())
        gone, end = None, t0 + 40
        while time.monotonic() < end:
            gone = lab.tagged(tag)
            if not gone:
                break
            time.sleep(0.5)
        res["backendGoneAfter"] = round(time.monotonic() - t0, 2)
        expect(res, "the killed pg_dump's lock-waiting backend ends at its server-side bound (--lock-wait-timeout 30 s), holder still holding",
               ["", True], [gone, h.active()])
    exps.append(case(lab, ev, "C5-bounded-pgdump-held-lock", c5))

    new, old = b2_shapes(B2NEW), b2_shapes(B2OLD)

    def c6a(res):
        rc, out, err = lab.docker.run("exec", "-e", "PGOPTIONS=" + new["PGOPTS"], lab.c, "sh", "-c", new["psql"], "psql", DB,
                                      "SELECT db_version FROM global_settings", timeout=40)
        expect(res, "B2 copy psql shape answers", [0, "28"], [rc, out.strip()])
    exps.append(case(lab, ev, "C6a-b2-copy-psql-shape", c6a))

    def dump_shape(script, bound):
        def body(res):
            h = holder(lab)
            res["_close"] = [h]
            t0 = time.monotonic()
            with open(os.devnull, "wb") as dn:
                r = subprocess.run(["docker", "exec", lab.c, "sh", "-c", script, "pg_dump", DB, str(bound)], stdout=dn,
                                   stderr=subprocess.PIPE, timeout=bound + 15)
            el = round(time.monotonic() - t0, 2)
            res["elapsed"], res["rc"], res["stderr"] = el, r.returncode, r.stderr.decode(errors="replace")[-300:]
            expect(res, "timed out by timeout(1): rc 124", 124, r.returncode)
            expect(res, f"bounded at about {bound} s (before the 5 s lock wait)", True, bound - 0.5 < el < bound + 2.5)
            expect(res, "holder unaffected (still active)", True, h.active())
            left, end = None, t0 + 12
            while time.monotonic() < end:
                left = lab.tagged("pg_dump", f"AND datname = '{DB}'")
                if not left:
                    break
                time.sleep(0.2)
            expect(res, "no pg_dump backend left (cancelled on TERM, else its 5 s lock wait)", "", left)
        return body
    exps.append(case(lab, ev, "C6b-b2-copy-pgdump-term-phase", dump_shape(new["capture"], 2)))

    def kill_phase(prefix, want_crash):
        def body(res):
            t0 = time.monotonic()
            rc, out, err = lab.sh(prefix + " " + TERM_IGNORING, "x", "1", timeout=40)    # "$2" = 1 s bound, -k 5
            el = round(time.monotonic() - t0, 2)
            res["elapsed"], res["rc"], res["script"] = el, rc, prefix + " " + TERM_IGNORING
            expect(res, "KILL phase reached at about 1 + 5 s", True, 5 < el < 9)
            if not want_crash:
                expect(res, "the child is KILLed and reaped by timeout: rc 137", 137, rc)
        return body
    new_prefix = new["capture"].split(" pg_dump", 1)[0]
    old_prefix = old["capture"].split(" pg_dump", 1)[0]
    exps.append(case(lab, ev, "C6c-b2-copy-kill-phase-foreground", kill_phase(new_prefix, False)))
    exps.append(case(lab, ev, "C6d-b2-original-pgdump-term-phase", dump_shape(old["capture"], 2)))
    exps.append(case(lab, ev, "C6e-NEGATIVE-b2-original-kill-phase", kill_phase(old_prefix, True), want_crash=True))


def setup(run, lab):
    sec = run.stage / "secrets"
    os.mkdir(sec, 0o700)
    fd = os.open(sec / "postgres.env", os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(fd, "w") as f:
        f.write("POSTGRES_USER=bv\nPOSTGRES_PASSWORD=%s\nPOSTGRES_DB=%s\n" % (os.urandom(24).hex(), DB))
    run.create_volume()
    run.create_container(sec / "postgres.env", PG_MEM_MIB)
    if not run.wait_pg() or not lab.ready():
        raise RuntimeError("PostgreSQL not ready")


def facts(lab):
    rc, out, err = lab.sh('echo "timeoutVersion=$(timeout --version 2>&1 | head -n 1)"; . /etc/os-release; echo "os=$PRETTY_NAME"; '
                          'echo "postgres=$(postgres --version)"; echo "pid1=$(tr "\\0" " " </proc/1/cmdline)"', timeout=30)
    return dict(l.split("=", 1) for l in out.splitlines() if "=" in l)


def main(argv):
    got, bad = pins()
    m = manifest(got)
    if argv in ([], ["--plan"]):
        print(json.dumps({"mode": "plan (no side effects)", "manifest": m, "pins": got, "pinMismatches": bad, "execute": f"--execute {m}"}, indent=1))
        return 0 if not bad else 2
    c2fx = load("c2fx", C2FX)
    docker = c2fx.Docker("docker")
    if argv[:1] == ["--recover"] and len(argv) == 2:
        rep = c2fx.recover(RUNS, argv[1], docker)
        print(json.dumps(rep, indent=1))
        return 0 if rep["certain"] else 3
    if argv != ["--execute", m] or bad:
        print(json.dumps({"ok": False, "error": "usage: --plan | --execute <manifest> | --recover <id>", "manifest": m, "bad": bad}))
        return 2
    try:
        scope = c2fx.queue_scope()
    except (c2fx.Refused, c2fx.Unknown, OSError) as e:
        print(json.dumps({"ok": False, "error": f"must run as ONE shared-queue job: {e}"}))
        return 2
    if scope["memoryMax"] is None or scope["memoryMax"] > MAX_SCOPE:
        print(json.dumps({"ok": False, "error": f"queue allocation must be at most 768 MiB (memory.max {scope['memoryMax']})"}))
        return 2

    def on_signal(signum, _f):
        raise SystemExit(128 + signum)
    for s in (signal.SIGTERM, signal.SIGINT, signal.SIGALRM):
        signal.signal(s, on_signal)
    signal.alarm(900)
    RUNS.mkdir(mode=0o700, exist_ok=True)
    prod, fixb = load("ctl_prod_bounds", PROD), load("ctl_fixture_bounds", FIXB)
    run = c2fx.Run(RUNS, docker, scope=scope)
    result = {"manifest": m, "pins": got, "runId": run.id, "scope": scope.get("rel"), "experiments": []}
    try:
        run.begin()
    except (c2fx.Refused, c2fx.Unknown, OSError) as e:
        result["refused"] = f"{type(e).__name__}: {e}"
        result["cleanup"] = run.cleanup() if run.journal else None
    else:
        ev = RUNS / f"{run.id}.evidence"
        ev.mkdir(mode=0o700)
        lab = Lab(run, docker)
        try:
            setup(run, lab)
            result["facts"] = facts(lab)
            body_all(run, lab, ev, result["experiments"], prod, fixb)
        except BaseException as e:
            result["error"] = f"{type(e).__name__}: {str(e)[-400:]}"
            result["traceback"] = traceback.format_exc()[-2000:]
        finally:
            try:
                (ev / "pg-server.log").write_text("\n".join(lab.log_lines()) + "\n")
            except Exception as e:
                result["serverLog"] = f"not captured: {e}"
            result["cleanup"] = run.cleanup()
    signal.alarm(0)
    exps = result["experiments"]
    result["summary"] = {e["name"]: ("PASS" if e["ok"] else "FAIL") for e in exps}
    result["cleanupCertain"] = bool((result.get("cleanup") or {}).get("certain"))
    result["passed"] = len(exps) == 11 and all(e["ok"] for e in exps) and result["cleanupCertain"] and \
        "error" not in result and "refused" not in result
    out = RUNS / f"{run.id}.result.json"
    out.write_text(json.dumps(result, indent=1, default=str) + "\n")
    print(json.dumps({"result": str(out), "summary": result["summary"], "cleanupCertain": result["cleanupCertain"],
                      "passed": result["passed"], "error": result.get("error")}, indent=1))
    return 0 if result["passed"] else 1


if __name__ == "__main__":
    sys.dont_write_bytecode = True
    sys.exit(main(sys.argv[1:]))
