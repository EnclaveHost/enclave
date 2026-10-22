#!/usr/bin/env python3
"""restore-timeout-diagnosis: ONE bounded MINI reproduction of the X3b failure of integration run a7e53855b0f9f535
(holder pg_sleep(40) ended rc 2 when the r5 restore bound of 20 s fired). Not the 8 stages, no indexd, no Go.

Hypothesis under test (each experiment states its expected outcome BEFORE it runs; a mismatch is a FAIL):
  the pinned postgres:18.6 image runs the postmaster as PID 1 of its container (no --init). GNU `timeout -s KILL`
  without --foreground KILLs its own process group, itself included, so the KILLed child is orphaned to the
  postmaster. The postmaster reaps it as an "untracked child process" killed by signal 9, treats that as a crashed
  backend, ends EVERY session (unrelated ones too) and reinitializes. That is what ended the holder.

Experiments (sequential, in this job's own labelled container; all evidence is kept next to the journal):
  E0a  r5 timeout shape, no database work:  sh -c 'timeout -s KILL 2 sleep 30'           expect: crash, sentinel rc 2
  E0b  fixed shape:                          sh -c 'exec timeout --foreground -s KILL 2 sleep 30'   expect: no crash
  E1   the UNCHANGED r5 controller's verify_backup (2ab98b4d, loaded read-only), X3b injection: restore bound 20 s,
       barrier (waits for the holder, then pg_sleep 30), holder pg_sleep(40), unrelated sentinel pg_sleep(60)
       expect: crash; holder and sentinel end rc 2 at ~20 s; scratch dropped right after the restart
  E2   the FIXED copy (fix/replicactl.fixture-r5.restorefix.py = r5 + fix/apply_restorefix.py), the same injection
       expect: no crash; the restore backend lingers to the barrier's end; holder ends BY ITSELF rc 0 at >= 35 s;
       the controller drops only after the holder ended; sentinel rc 0; PID 1, checkpointer, OOM counters unchanged
  E4a  r1's X3 / r2's X3a injection (every scratch DDL sleeps 20 s, restore bound 2 s) on the UNCHANGED r5 controller
       expect: crash, so the scratch is dropped within 10 s (r1 read this as "the backend ends promptly")
  E4b  the same on the FIXED copy           expect: no crash; the killed restore's backend lingers ~20 s and is waited out
  E3   a SECOND container of this job with docker --init (tini is PID 1), the E0a shape   expect: no crash
  Barrier (E1/E2): the restore's first DDL polls with pg_stat_clear_snapshot() (pg_stat_activity is otherwise one
  snapshot per transaction, so a holder that attaches later is never seen) and logs "holder seen"/"released".
Recorded: timeout/sh/OS/PostgreSQL flavor, in-container process tree (pid/ppid/pgid/sid) during each kill, the full
server log, PID 1 identity, postmaster start time, checkpointer pid, the container cgroup's memory.events/peak and
docker's OOMKilled, holder/sentinel rc AND stderr.

Ownership/cleanup: c2fx.py (storage-enclave-fixture, pin ff1b092c) used read-only: exclusive journal, exclusive stage
with marker, run-id-labelled volume/container (--pull never, 127.0.0.1 port, --memory 256m), own queue scope drained,
labelled removal. Usage (ONE shared-queue job at 768 MiB; the container's 256 MiB is outside it):
  repro.py --plan | --execute <manifest> | --recover <run id>
"""
import hashlib
import importlib.util
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

DIAG = Path(__file__).resolve().parent
WORK = DIAG.parents[1]
RUNS = DIAG / "runs"
C2FX = WORK / "claude-resumed-20261022/storage-enclave-fixture/fixture/c2fx.py"
R5 = WORK / "claude-resumed-20261022/control-package/storage-migration-r5/integration/replicactl.fixture-r5.py"
FIXED = DIAG / "fix/replicactl.fixture-r5.restorefix.py"
APPLY = DIAG / "fix/apply_restorefix.py"
PINS = {str(C2FX): "ff1b092c54135df64b506b1683fb48679f678f21e6ec5d28ef6fb54a66534ad6",
        str(R5): "2ab98b4d359fd0f3dcd34458ddfdf61a32b0dfb66652328418e453d4bc679151"}
MAX_SCOPE = 768 * 1024 * 1024
PG_MEM_MIB = 256
DB = "diagsrc"
RESTORE_BOUND, BARRIER_SLEEP, HOLDER_SLEEP, SENTINEL_SLEEP = 20, 30, 40, 60
CRASH_RX = re.compile(r"terminating any other active server processes|all server processes terminated; reinitializing"
                      r"|was terminated by signal|terminating connection because of crash of another server process")


def sha(p):
    return hashlib.sha256(Path(p).read_bytes()).hexdigest()


def load(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    m = importlib.util.module_from_spec(spec)
    sys.modules[name] = m
    spec.loader.exec_module(m)
    return m


def pins():
    got = {str(p): sha(p) for p in (C2FX, R5, FIXED, APPLY, Path(__file__).resolve())}
    bad = [p for p, h in PINS.items() if got[p] != h]
    apply = load("apply_restorefix", APPLY)
    if apply.apply(R5.read_text()) != FIXED.read_text():
        bad.append(f"{FIXED} is not exactly apply_restorefix(r5)")
    return got, bad


def manifest(got):
    return hashlib.sha256(json.dumps(got, sort_keys=True).encode()).hexdigest()


class Lab:
    """this job's own container: every call names it explicitly; nothing else is touched"""

    def __init__(self, run, docker):
        self.run, self.docker, self.c = run, docker, run.container
        self.t0 = time.monotonic()

    def t(self):
        return round(time.monotonic() - self.t0, 2)

    def sh(self, script, *args, timeout=60, env=()):
        e = [x for k in env for x in ("-e", k)]
        rc, out, err = self.docker.run("exec", *e, self.c, "sh", "-c", script, "sh", *args, timeout=timeout)
        return rc, out, err

    def psql(self, db, sql, timeout=60):
        r = subprocess.run(["docker", "exec", "-i", self.c, "sh", "-c",
                            'psql -U "${POSTGRES_USER:-postgres}" -d "$1" -X -A -t -q -v ON_ERROR_STOP=1 -f -', "psql", db],
                           input=sql.encode(), capture_output=True, timeout=timeout)
        if r.returncode != 0:
            raise RuntimeError(f"psql {db}: rc {r.returncode} {r.stderr.decode()[-300:]}")
        return r.stdout.decode().strip()

    def ready(self, seconds=60):
        """the server answers a query again (after a crash-restart it is briefly in recovery)"""
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
        """in-container processes: pid, comm, state, ppid, pgid, sid, argv (the listing's own sh/cat appear too)"""
        rc, out, _ = self.sh('for d in /proc/[0-9]*; do s=$(cat "$d/stat" 2>/dev/null) || continue; '
                             'a=$(tr "\\0" " " < "$d/cmdline" 2>/dev/null); printf "%s\\t%s\\n" "$s" "$a"; done', timeout=30)
        rows = []
        for line in out.splitlines():
            st, _, argv = line.partition("\t")
            m = re.match(r"^(\d+) \((.*)\) (\S) (\d+) (\d+) (\d+)", st)
            if m:
                rows.append({"pid": int(m[1]), "comm": m[2], "state": m[3], "ppid": int(m[4]), "pgid": int(m[5]),
                             "sid": int(m[6]), "argv": argv.strip()[:160]})
        return rows

    def cgroup_dir(self):
        rc, out, _ = self.docker.run("inspect", "--format", "{{.State.Pid}}", self.c, timeout=30)
        pid = int(out.strip())
        rel = Path(f"/proc/{pid}/cgroup").read_text().strip().split("::", 1)[1]
        return Path("/sys/fs/cgroup" + rel)

    def ident(self):
        """PostgreSQL process identity/uptime: PID 1 (starttime, comm), postmaster start time, auxiliary pids, the
        container cgroup's OOM counters and peak, docker's OOMKilled"""
        rc, out, _ = self.sh("cat /proc/1/stat", timeout=30)
        f1 = out.split(")", 1)[1].split() if rc == 0 else []
        r = {"pid1Comm": out.split("(", 1)[1].split(")", 1)[0] if rc == 0 else None,
             "pid1StartTicks": f1[19] if len(f1) > 19 else None}
        try:
            row = self.psql("postgres", "SELECT pg_postmaster_start_time(), (SELECT string_agg(backend_type || '=' || pid, ',' "
                                        "ORDER BY backend_type) FROM pg_stat_activity WHERE backend_type IN "
                                        "('checkpointer','background writer','walwriter'));", timeout=20)
            r["postmasterStart"], r["auxPids"] = row.split("|")
        except (RuntimeError, subprocess.TimeoutExpired) as e:
            r["postmasterStart"] = r["auxPids"] = f"unreadable: {str(e)[-120:]}"
        try:
            cg = self.cgroup_dir()
            r["memoryEvents"] = dict(l.split() for l in (cg / "memory.events").read_text().splitlines())
            for k in ("memory.peak", "memory.current", "memory.max"):
                if (cg / k).exists():
                    r[k] = (cg / k).read_text().strip()
        except (OSError, ValueError, IndexError) as e:
            r["memoryEvents"] = f"unreadable: {e}"
        rc, out, _ = self.docker.run("inspect", "--format", "{{.State.OOMKilled}} {{.State.Status}} {{.RestartCount}}", self.c, timeout=30)
        r["dockerState"] = out.strip()
        return r


class Session:
    """one OWN psql session (docker exec client = a child of this job, inside its scope), stderr KEPT in a file"""

    def __init__(self, lab, role, db, seconds, ev_dir):
        self.lab, self.role, self.db, self.seconds = lab, role, db, seconds
        self.token = f"diag{role}-{secrets.token_hex(6)}"
        self.errf = ev_dir / f"{self.token}.stderr"
        self.p, self.pid, self.started, self.ended, self.rc = None, None, None, None, None

    def start(self):
        self.started = self.lab.t()
        with open(self.errf, "wb") as ef:
            self.p = subprocess.Popen(["docker", "exec", "-e", f"PGAPPNAME={self.token}", self.lab.c, "sh", "-c",
                                       'psql -U "${POSTGRES_USER:-postgres}" -d "$1" -X -A -t -q -v ON_ERROR_STOP=1 -c "SELECT pg_sleep($2)"',
                                       "psql", self.db, str(self.seconds)], stdout=subprocess.DEVNULL, stderr=ef, stdin=subprocess.DEVNULL)
        threading.Thread(target=self._wait, daemon=True).start()

    def _wait(self):
        self.rc = self.p.wait()
        self.ended = self.lab.t()

    def observe(self, seconds=20):
        end = time.monotonic() + seconds
        while time.monotonic() < end:
            out = self.lab.psql("postgres", f"SELECT pid FROM pg_stat_activity WHERE datname = '{self.db}' AND application_name = "
                                            f"'{self.token}' AND state = 'active' AND query LIKE 'SELECT pg_sleep(%';", timeout=20)
            if out:
                self.pid = int(out.split()[0])
                return self.lab.t()
            if self.p.poll() is not None:
                break
            time.sleep(0.1)
        raise RuntimeError(f"{self.token} never observed active (rc {self.p.poll()})")

    def join(self, seconds):
        end = time.monotonic() + seconds
        while self.ended is None and time.monotonic() < end:
            time.sleep(0.2)
        return self.ended is not None

    def close(self):
        """end THIS session only (own container): its backend by pid+token, then its client"""
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
        err = self.errf.read_text(errors="replace") if self.errf.exists() else ""
        return {"token": self.token, "db": self.db, "sleep": self.seconds, "backendPid": self.pid, "startedAt": self.started,
                "endedAt": self.ended, "rc": self.rc, "stderr": err[-800:]}


def crash_lines(lines):
    return [l for l in lines if CRASH_RX.search(l) or "untracked child process" in l]


def expect(res, key, want, got):
    res.setdefault("expectations", []).append({"what": key, "want": want, "got": got, "ok": want == got})


# ------------------------------------------------------------------ experiments
def mechanism(lab, ev, name, script, want_crash):
    """a timeout shape on a plain `sleep`: no database work at all; an unrelated sentinel session is the witness"""
    res = {"name": name, "script": script, "wantCrash": want_crash}
    before_log = len(lab.log_lines())
    res["identBefore"] = lab.ident()
    s = Session(lab, "sent", DB, 10, ev)
    s.start()
    s.observe()
    box = {}
    th = threading.Thread(target=lambda: box.update(r=lab.sh(script, timeout=60)), daemon=True)
    t_start = lab.t()
    th.start()
    time.sleep(1.0)
    res["treeDuring"] = [r for r in lab.tree() if r["comm"] in ("sh", "timeout", "sleep", "tini", "docker-init") or r["pid"] == 1]
    th.join(70)
    rc, out, err = box.get("r", (None, "", "thread did not finish"))
    res["command"] = {"rc": rc, "stdout": out[-200:], "stderr": err[-300:], "startedAt": t_start, "endedAt": lab.t()}
    s.join(25)
    res["sentinel"] = s.report()
    s.close()
    res["readyAfter"] = lab.ready()
    lines = lab.log_lines()
    res["serverLogDelta"] = lines[before_log:][-60:]
    res["crashLines"] = crash_lines(lines[before_log:])
    res["identAfter"] = lab.ident()
    crashed = bool(res["crashLines"])
    expect(res, "crash (server log)", want_crash, crashed)
    expect(res, "unrelated sentinel rc", 2 if want_crash else 0, res["sentinel"]["rc"])
    expect(res, "PID 1 starttime unchanged (the postmaster itself survives)", True,
           res["identBefore"]["pid1StartTicks"] == res["identAfter"]["pid1StartTicks"])
    expect(res, "checkpointer pid changed (reinitialized)", want_crash, res["identBefore"]["auxPids"] != res["identAfter"]["auxPids"])
    res["ok"] = all(e["ok"] for e in res["expectations"])
    return res


BARRIER = r"""
CREATE FUNCTION public.diag_barrier() RETURNS event_trigger LANGUAGE plpgsql AS $f$
DECLARE i int := 0;
BEGIN
  IF current_database() NOT LIKE 'diagsrc\_verify\_%' THEN RETURN; END IF;
  LOOP
    PERFORM pg_stat_clear_snapshot();       -- pg_stat_activity is otherwise ONE snapshot per transaction
    EXIT WHEN EXISTS (SELECT 1 FROM pg_stat_activity WHERE datname = current_database()
                      AND application_name LIKE 'diaghold-%' AND state = 'active');
    i := i + 1;
    IF i > 600 THEN RAISE EXCEPTION 'diag barrier: no holder within 60 s'; END IF;
    PERFORM pg_sleep(0.1);
  END LOOP;
  RAISE LOG 'diag barrier: holder seen after % polls', i;
  PERFORM pg_sleep(@SLEEP@);
  RAISE LOG 'diag barrier: released';
END $f$;
CREATE EVENT TRIGGER diag_barrier ON ddl_command_start EXECUTE FUNCTION public.diag_barrier();
"""
UNBARRIER = "DROP EVENT TRIGGER IF EXISTS diag_barrier; DROP FUNCTION IF EXISTS public.diag_barrier();"


def make_backup(lab, ctl, node, dest):
    """a backup directory exactly as cmd_backup lays it out (dump + manifest), of the small fixture database"""
    dest.mkdir(mode=0o700)
    with open(dest / "indexd.pgdump", "wb") as f:
        r = subprocess.run(["docker", "exec", lab.c, "sh", "-c",
                            'pg_dump -U "${POSTGRES_USER:-postgres}" --format=custom --no-owner --no-acl "$1"', "pg_dump", DB],
                           stdout=f, stderr=subprocess.PIPE, timeout=60)
    if r.returncode != 0:
        raise RuntimeError("pg_dump failed: " + r.stderr.decode()[-300:])
    files = {"indexd.pgdump": {"sha256": ctl.sha256(dest / "indexd.pgdump"), "bytes": (dest / "indexd.pgdump").stat().st_size}}
    m = {"takenAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()), "dbVersion": node.db_version(), "digest": node.digest(),
         "binarySha256": None, "files": files}
    (dest / "manifest.json").write_text(json.dumps(m, indent=2) + "\n")
    return m


def verification(lab, ev, name, ctl, profile, backup, want_crash):
    """X3b, minimized: the real controller verify_backup against a held scratch database"""
    res = {"name": name, "controller": ctl.__file__, "controllerSha256": sha(ctl.__file__), "wantCrash": want_crash,
           "restoreBound": RESTORE_BOUND, "barrierSleep": BARRIER_SLEEP, "holderSleep": HOLDER_SLEEP}
    node = ctl.Node(profile)
    before_log = len(lab.log_lines())
    res["identBefore"] = lab.ident()
    lab.psql("template1", BARRIER.replace("@SLEEP@", str(int(BARRIER_SLEEP))))
    sent = Session(lab, "sent", DB, SENTINEL_SLEEP, ev)
    hold = None
    try:
        sent.start()
        sent.observe()
        before = {f.name for f in backup.glob("verify-*.json")}
        box = {}
        t_v = lab.t()

        def run_verify():
            box["rep"] = ctl.verify_backup(node, backup)
            box["end"] = lab.t()
        th = threading.Thread(target=run_verify, daemon=True)
        th.start()
        scratch, end = None, time.monotonic() + 30
        while scratch is None and time.monotonic() < end:
            for f in backup.glob("verify-*.json"):
                if f.name not in before:
                    try:
                        rec = json.loads(f.read_text())
                    except (json.JSONDecodeError, OSError):
                        continue
                    if rec.get("scratchState") not in (None, "none", "intent (CREATE not yet sent)"):
                        scratch = rec.get("scratch")
            time.sleep(0.05)
        if not scratch:
            raise RuntimeError("the controller's record never showed the created scratch")
        res["scratch"] = scratch
        hold = Session(lab, "hold", scratch, HOLDER_SLEEP, ev)
        hold.start()
        res["holderObservedAt"] = hold.observe() - t_v
        time.sleep(4)
        res["treeDuringRestore"] = [r for r in lab.tree() if r["comm"] in ("sh", "timeout", "pg_restore") or r["pid"] == 1]
        res["restoreBackends"] = lab.psql("postgres", f"SELECT string_agg(pid || ':' || coalesce(application_name,'') || ':' || state, ' ') "
                                                      f"FROM pg_stat_activity WHERE datname = '{scratch}';")
        th.join(RESTORE_BOUND + 60 + 120 + 120)
        res["controllerReport"] = box.get("rep", "verify_backup did not return within its bounds")
        res["controllerSeconds"] = round(box["end"] - t_v, 2) if "end" in box else None
        hold.join(HOLDER_SLEEP + 15)
        sent.join(SENTINEL_SLEEP + 15)
    finally:
        try:
            lab.psql("template1", UNBARRIER)
        except (RuntimeError, subprocess.TimeoutExpired) as e:
            res["unbarrier"] = f"failed: {e} (the container is removed in cleanup)"
        for s in (hold, sent):
            if s is not None:
                s.close()
    res["holder"], res["sentinel"] = hold.report(), sent.report()
    for s in (res["holder"], res["sentinel"]):
        for k in ("startedAt", "endedAt"):
            s[k] = round(s[k] - t_v, 2) if s[k] is not None else None
    res["readyAfter"] = lab.ready()
    lines = lab.log_lines()
    res["serverLogDelta"] = lines[before_log:][-80:]
    res["crashLines"] = crash_lines(lines[before_log:])
    res["identAfter"] = lab.ident()
    left = lab.psql("postgres", r"SELECT count(*) FROM pg_database WHERE datname LIKE 'diagsrc\_verify\_%';")
    res["scratchLeft"] = int(left)
    rep = res["controllerReport"] if isinstance(res["controllerReport"], dict) else {}
    crashed = bool(res["crashLines"])
    expect(res, "crash (server log)", want_crash, crashed)
    expect(res, "the barrier saw the holder (server log)", True, any("diag barrier: holder seen" in l for l in lines[before_log:]))
    expect(res, "the barrier never timed out", False, any("diag barrier: no holder" in l for l in lines[before_log:]))
    expect(res, "holder observed active before the restore bound", True, res["holderObservedAt"] < RESTORE_BOUND)
    expect(res, "verify ok", False, rep.get("ok"))
    expect(res, "pg_restore failed reported", True, any("pg_restore failed" in p for p in rep.get("problems", [])))
    expect(res, "scratchState", "dropped", rep.get("scratchState"))
    expect(res, "cleanupOk", True, rep.get("cleanupOk"))
    expect(res, "no scratch left", 0, res["scratchLeft"])
    expect(res, "unrelated sentinel rc", 2 if want_crash else 0, res["sentinel"]["rc"])
    expect(res, "holder rc", 2 if want_crash else 0, res["holder"]["rc"])
    he = res["holder"]["endedAt"]
    if want_crash:
        expect(res, "holder ended at the restore bound (< 35 s)", True, he is not None and he < 35)
    else:
        expect(res, "holder ended BY ITSELF at >= 35 s", True, he is not None and he >= 35)
        expect(res, "controller ended at or after the holder's end", True,
                res["controllerSeconds"] is not None and he is not None and res["controllerSeconds"] >= he)
    expect(res, "PID 1 starttime unchanged", True, res["identBefore"]["pid1StartTicks"] == res["identAfter"]["pid1StartTicks"])
    expect(res, "checkpointer pid changed (reinitialized)", want_crash, res["identBefore"]["auxPids"] != res["identAfter"]["auxPids"])
    ob, oa = res["identBefore"].get("memoryEvents"), res["identAfter"].get("memoryEvents")
    expect(res, "no OOM kill in the container cgroup", True,
           isinstance(ob, dict) and isinstance(oa, dict) and ob.get("oom_kill") == oa.get("oom_kill") == "0")
    res["ok"] = all(e["ok"] for e in res["expectations"])
    return res


DELAY = r"""
CREATE FUNCTION public.diag_delay() RETURNS event_trigger LANGUAGE plpgsql AS $f$
BEGIN
  IF current_database() LIKE 'diagsrc\_verify\_%' THEN PERFORM pg_sleep(20); END IF;
END $f$;
CREATE EVENT TRIGGER diag_delay ON ddl_command_start EXECUTE FUNCTION public.diag_delay();
"""
UNDELAY = "DROP EVENT TRIGGER IF EXISTS diag_delay; DROP FUNCTION IF EXISTS public.diag_delay();"


def delay_check(lab, ev, name, ctl, profile, backup, want_crash):
    """r1's X3 / r2's X3a injection: every scratch DDL sleeps 20 s, restore bound 2 s, no holder. r1 read the ~3.5 s
    result as 'PostgreSQL ends the killed restore's backend promptly'."""
    res = {"name": name, "controller": ctl.__file__, "wantCrash": want_crash, "restoreBound": 2, "triggerSleep": 20}
    node = ctl.Node(profile)
    before_log = len(lab.log_lines())
    res["identBefore"] = lab.ident()
    lab.psql("template1", DELAY)
    sent = Session(lab, "sent", DB, 30, ev)
    try:
        sent.start()
        sent.observe()
        t_v = lab.t()
        rep = ctl.verify_backup(node, backup)
        res["controllerSeconds"] = round(lab.t() - t_v, 2)
        res["controllerReport"] = rep
        sent.join(45)
    finally:
        try:
            lab.psql("template1", UNDELAY)
        except (RuntimeError, subprocess.TimeoutExpired) as e:
            res["undelay"] = f"failed: {e} (the container is removed in cleanup)"
        sent.close()
    res["sentinel"] = sent.report()
    res["readyAfter"] = lab.ready()
    lines = lab.log_lines()
    res["serverLogDelta"] = lines[before_log:][-60:]
    res["crashLines"] = crash_lines(lines[before_log:])
    res["identAfter"] = lab.ident()
    res["scratchLeft"] = int(lab.psql("postgres", r"SELECT count(*) FROM pg_database WHERE datname LIKE 'diagsrc\_verify\_%';"))
    expect(res, "crash (server log)", want_crash, bool(res["crashLines"]))
    expect(res, "verify ok", False, rep.get("ok"))
    expect(res, "pg_restore failed reported", True, any("pg_restore failed" in p for p in rep.get("problems", [])))
    expect(res, "scratchState", "dropped", rep.get("scratchState"))
    expect(res, "cleanupOk", True, rep.get("cleanupOk"))
    expect(res, "no scratch left", 0, res["scratchLeft"])
    expect(res, "unrelated sentinel rc", 2 if want_crash else 0, res["sentinel"]["rc"])
    if want_crash:
        expect(res, "prompt end (< 10 s) only because of the crash", True, res["controllerSeconds"] < 10)
    else:
        expect(res, "the killed restore's backend lingers to its trigger's end and is waited out (15 s <= t < 60 s)", True,
               15 <= res["controllerSeconds"] < 60)
    res["ok"] = all(e["ok"] for e in res["expectations"])
    return res


def facts(lab):
    rc, out, err = lab.sh('echo "timeout=$(command -v timeout) -> $(readlink -f "$(command -v timeout)")"; '
                          'echo "timeoutVersion=$(timeout --version 2>&1 | head -n 1)"; '
                          'echo "sh=$(readlink -f /bin/sh)"; . /etc/os-release; echo "os=$PRETTY_NAME"; '
                          'echo "postgres=$(postgres --version)"; echo "busybox=$(command -v busybox || echo absent)"; '
                          'echo "pid1=$(tr "\\0" " " </proc/1/cmdline)"', timeout=30)
    f = dict(l.split("=", 1) for l in out.splitlines() if "=" in l)
    f["clientConnectionCheckInterval"] = lab.psql("postgres", "SHOW client_connection_check_interval;")
    f["serverVersion"] = lab.psql("postgres", "SHOW server_version;")
    return f


def seed(lab, stage):
    lab.psql(DB, "CREATE TABLE global_settings (db_version int NOT NULL); INSERT INTO global_settings VALUES (28);"
                 "CREATE TABLE diag_t (id int PRIMARY KEY, v text NOT NULL);"
                 "INSERT INTO diag_t SELECT g, md5(g::text) FROM generate_series(1, 2000) g;")
    mig = stage / "migration"
    mig.mkdir(mode=0o700)
    (mig / "digest.sql").write_text("SELECT 'diag_t|' || count(*) || '|' || md5(coalesce(string_agg(id::text || ':' || v, ',' "
                                    "ORDER BY id), '')) FROM diag_t;\n")             # the controller's name|rows|md5 lines
    return mig


def container_run(c2fx, docker, scope, init):
    """one c2fx-owned Run; with init=True the container gets docker --init (the only difference)"""
    class InitRun(c2fx.Run):
        def create_container(self, env_file, mem_mib=256):
            self.journal.add(event="intent", resource="container", name=self.container)
            rc, out, err = self.docker.run(
                "run", "-d", "--init", "--pull", "never", "--name", self.container, "--label", f"{c2fx.LABEL}={self.id}",
                "-p", "127.0.0.1::5432", "--read-only", "--memory", f"{mem_mib}m", "--memory-swap", f"{mem_mib}m",
                "--pids-limit", "256", "--cpus", "1",
                "--env-file", str(env_file), "--mount", f"type=volume,source={self.volume},target=/var/lib/postgresql",
                "--tmpfs", "/var/run/postgresql:rw,size=16m", "--tmpfs", "/tmp:rw,size=64m",
                c2fx.IMAGE, "postgres", "-c", "listen_addresses=*", "-c", "shared_buffers=128MB", "-c", "max_connections=50", timeout=120)
            ours = self._ours("container", self.container)
            self.journal.add(event="created" if ours else "not-ours", resource="container", name=self.container, rc=rc)
            if not ours:
                raise c2fx.Refused(f"container {self.container}: not created with our label (rc {rc} {err.strip()[-160:]})")
            rc, out, err = self.docker.run("port", self.container, "5432/tcp", timeout=30)
            host, _, port = (out.strip().splitlines() or [""])[0].rpartition(":")
            if rc != 0 or host != "127.0.0.1" or not port.isdigit():
                raise c2fx.Refused(f"container port is not loopback-only: rc {rc}")
            return int(port)
    return (InitRun if init else c2fx.Run)(RUNS, docker, scope=scope)


def setup(run, lab):
    st = run.stage
    sec = st / "secrets"
    os.mkdir(sec, 0o700)
    fd = os.open(sec / "postgres.env", os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(fd, "w") as f:
        f.write("POSTGRES_USER=diag\nPOSTGRES_PASSWORD=%s\nPOSTGRES_DB=%s\n" % (os.urandom(24).hex(), DB))
    run.create_volume()
    run.create_container(sec / "postgres.env", PG_MEM_MIB)
    if not run.wait_pg() or not lab.ready():
        raise RuntimeError("PostgreSQL not ready")


def one_container(c2fx, docker, scope, init, body):
    run = container_run(c2fx, docker, scope, init)
    out = {"runId": run.id, "init": init}
    try:
        run.begin()
    except (c2fx.Refused, c2fx.Unknown, OSError) as e:
        out["refused"] = f"{type(e).__name__}: {e}"
        out["cleanup"] = run.cleanup() if run.journal else None
        return out
    ev = RUNS / f"{run.id}.evidence"
    ev.mkdir(mode=0o700)
    lab = Lab(run, docker)
    try:
        setup(run, lab)
        out["facts"] = facts(lab)
        out["experiments"] = []
        body(run, lab, ev, out["experiments"])                 # appends each finished experiment (kept on a later error)
    except BaseException as e:            # SystemExit from the signal handler too: always reach cleanup
        out["error"] = f"{type(e).__name__}: {str(e)[-400:]}"
        out["traceback"] = traceback.format_exc()[-2000:]
    finally:
        try:
            lines = lab.log_lines()
            (ev / "pg-server.log").write_text("\n".join(lines) + "\n")
            out["serverLogLines"] = len(lines)
        except Exception as e:
            out["serverLog"] = f"not captured: {e}"
        try:
            out["identFinal"] = lab.ident()
        except Exception as e:
            out["identFinal"] = f"unreadable: {e}"
        out["cleanup"] = run.cleanup()
    return out


def main(argv):
    got, bad = pins()
    m = manifest(got)
    if argv in ([], ["--plan"]):
        print(json.dumps({"mode": "plan (no side effects)", "manifest": m, "pins": got, "pinMismatches": bad,
                          "execute": f"--execute {m}"}, indent=1))
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
    signal.signal(signal.SIGTERM, on_signal)
    signal.signal(signal.SIGINT, on_signal)
    signal.signal(signal.SIGALRM, on_signal)
    signal.alarm(900)                                         # the whole job, both containers
    r5, fixed = load("replicactl_r5", R5), load("replicactl_restorefix", FIXED)

    def body_main(run, lab, ev, exps):
        exps.append(mechanism(lab, ev, "E0a-r5-shape-timeout-KILL-on-sleep", "timeout -s KILL 2 sleep 30", True))
        exps.append(mechanism(lab, ev, "E0b-fixed-shape-exec-timeout-foreground", "exec timeout --foreground -s KILL 2 sleep 30", False))
        mig = seed(lab, run.stage)
        for name, ctl, want in (("E1-r5-controller-verify-backup-X3b-injection", r5, True),
                                ("E2-fixed-controller-verify-backup-X3b-injection", fixed, False)):
            prof = run.stage / f"profile-{name[:2]}.json"
            prof.write_text(json.dumps({"pg_container": run.container, "database": DB, "migration_dir": str(mig),
                                        "verify_timeout_seconds": RESTORE_BOUND, "verify_query_seconds": 600}))
            b = run.stage / f"backup-{name[:2]}"
            make_backup(lab, ctl, ctl.Node(prof), b)
            exps.append(verification(lab, ev, name, ctl, prof, b, want))
            for f in sorted(b.glob("verify-*.json")):          # the controller's own records, kept as evidence
                (ev / f"{name[:2]}.{f.name}").write_text(f.read_text())
        for name, ctl, want in (("E4a-r5-controller-r1-X3-injection", r5, True),
                                ("E4b-fixed-controller-r1-X3-injection", fixed, False)):
            prof = run.stage / f"profile-{name[:3]}.json"
            prof.write_text(json.dumps({"pg_container": run.container, "database": DB, "migration_dir": str(mig),
                                        "verify_timeout_seconds": 2, "verify_query_seconds": 600}))
            b = run.stage / f"backup-{name[:3]}"
            make_backup(lab, ctl, ctl.Node(prof), b)
            exps.append(delay_check(lab, ev, name, ctl, prof, b, want))

    def body_init(run, lab, ev, exps):
        exps.append(mechanism(lab, ev, "E3-r5-shape-under-docker-init", "timeout -s KILL 2 sleep 30", False))

    result = {"manifest": m, "pins": got, "scope": scope.get("rel"), "containers": []}
    try:
        result["containers"].append(one_container(c2fx, docker, scope, False, body_main))
        if not str(result["containers"][0].get("error", "")).startswith("SystemExit"):   # interrupted: no second container
            result["containers"].append(one_container(c2fx, docker, scope, True, body_init))
    finally:
        signal.alarm(0)
    exps = [e for c in result["containers"] for e in c.get("experiments", [])]
    result["summary"] = {e["name"]: ("PASS" if e["ok"] else "FAIL") for e in exps}
    result["cleanupCertain"] = all(c.get("cleanup", {}).get("certain") for c in result["containers"])
    result["passed"] = len(exps) == 7 and all(e["ok"] for e in exps) and result["cleanupCertain"] and \
        not any("error" in c or "refused" in c for c in result["containers"])
    out = RUNS / f"{result['containers'][0]['runId']}.result.json"
    out.write_text(json.dumps(result, indent=1) + "\n")
    print(json.dumps({"result": str(out), "summary": result["summary"], "cleanupCertain": result["cleanupCertain"],
                      "passed": result["passed"]}, indent=1))
    return 0 if result["passed"] else 1


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
