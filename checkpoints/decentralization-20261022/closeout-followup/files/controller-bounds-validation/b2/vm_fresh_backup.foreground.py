#!/usr/bin/env python3
"""Fresh, quiesced, COUPLED backup of the live indexd on the 'enclave-storage' VM (Phase B2). ROOT ONLY.

The existing pattern (work/storage-vm/capture-target.sh, recovery-20261019) made generic and state-aware:
  stop indexd -> pg_dump (PostgreSQL keeps running) + consensus.db + binary + indexd.yml + GeoIP + counts -> resume.
  - Unique run: a new directory <PARENT>/<run-id> created exclusively (never a fixed legacy directory, never reused);
    every file is created O_EXCL 0600; an O_EXCL ownership marker with a random token and the directory's dev/inode
    are recorded, and only a confirmed own directory is ever cleaned.
  - State-aware: the unit is stopped ONLY if it was active/running before, and started again ONLY in that case. A unit
    that was inactive is never started. Any other prior state (failed, activating, deactivating, reloading, unknown) is
    refused before anything changes. A running unit whose start condition (ALLOW_LIVE_START) is absent is refused too
    (its resume could never succeed).
  - Resume runs in `finally`, also on SIGTERM/SIGINT/SIGHUP, and is verified (ActiveState=active, SubState=running,
    MainPID>0) - it is never assumed. A failed resume is reported as such (exit 4), never as success.
  - Deadlines: every command has a timeout; the stopped window has its own budget (--quiesce-budget); copies check it
    per chunk; pg_dump also runs under `timeout --foreground` INSIDE the container (it signals and reaps the tool only:
    nothing is ever orphaned to the postmaster, PID 1 of the container).
  - Nothing secret is printed or logged: indexd.yml is copied as bytes (sha256 + size only), never parsed or echoed;
    command stderr is reduced to a sanitized first line without file contents; no password, seed or row is read.
  - Coupling: after the capture the unit must still be stopped with no indexd process, or the backup is marked
    coupled=false and the run fails (another actor started the writer).
Outputs (KEY=VALUE on stdout, the last line fb.outcome=...), and in <PARENT>:
  <run-id>.journal.jsonl  append-only phase journal (fsync'd)     <run-id>.receipt.json  final receipt (public metadata)
  <run-id>/  indexd.pgdump consensus.db indexd indexd.yml GeoLite2-City.mmdb counts.json manifest.json .owner

Modes:
  capture   --run-id R --confirm fresh-backup --expect-db-version 26 --expect-binary-sha256 H --expect-geoip-sha256 H
  status    --run-id R                       (read-only: journal + receipt + current unit state; after a lost transport)
  remove    --run-id R --token T --confirm remove-plaintext   (after root verified the off-host encrypted copy)
Exit: 0 complete (resumed, or left inactive as found) | 3 failed, prior state restored | 4 PRIOR STATE NOT RESTORED or
UNKNOWN (root must act) | 5 refused before any change | 6 status/remove problem.
"""
import argparse, fcntl, hashlib, json, os, re, secrets, signal, stat, subprocess, sys, time

ROOT = os.environ.get("FB_ROOT", "")            # tests only (a user-namespace fixture); production: unset (printed)
UNIT, PG, DB, SVC_USER = "enclave-indexd", "enclave-indexd-postgres", "indexd", "enclave-indexd"
P = lambda p: ROOT + p
PARENT = P("/var/lib/enclave-indexd/fresh-backup")
LOCK = P("/run/enclave-indexd-snapshot.lock")             # the existing snapshot lock (capture-target.sh)
STATE = P("/var/lib/enclave-indexd/state")
SOURCES = {                                                 # archive name -> live path
    "consensus.db": P("/var/lib/enclave-indexd/state/consensus.db"),
    "indexd": P("/opt/enclave-indexd/indexd"),
    "indexd.yml": P("/etc/enclave-indexd/indexd.yml"),
    "GeoLite2-City.mmdb": P("/var/lib/enclave-indexd/state/GeoLite2-City.mmdb"),
}
ALLOW = P("/etc/enclave-indexd/ALLOW_LIVE_START")
MEMBERS = ["indexd.pgdump", "consensus.db", "indexd", "indexd.yml", "GeoLite2-City.mmdb", "counts.json"]
OWN_NAMES = set(MEMBERS) | {"manifest.json", ".owner"}
RUN_RE = re.compile(r"^[0-9]{8}T[0-9]{6}Z-[0-9a-f]{8}$")
PGOPTS = "-c default_transaction_read_only=on -c statement_timeout=10000 -c lock_timeout=2000 -c idle_in_transaction_session_timeout=10000"
CHUNK = 1 << 20


class Refused(Exception):
    pass


class Deadline(Exception):
    pass


def emit(k, v):
    """stdout is informational; the journal and receipt are authoritative. A lost reader (EPIPE after a dropped transport)
    must never interrupt the capture or the resume."""
    try:
        print(f"{k}={v}", flush=True)
    except (OSError, ValueError):
        try:                                            # point stdout at /dev/null so the exit code is not masked
            nul = os.open(os.devnull, os.O_WRONLY); os.dup2(nul, 1); os.close(nul)
            sys.stdout = open(os.devnull, "w")
        except OSError:
            pass


def clean_err(b):
    """First stderr line, sanitized; never more than 160 printable characters."""
    line = (b or b"").decode("utf-8", "replace").strip().splitlines()[:1]
    return re.sub(r"[^ -~]", "?", line[0])[:160] if line else ""


def run(args, timeout, input=None, stdout=subprocess.PIPE):
    try:
        r = subprocess.run(args, input=input, stdout=stdout, stderr=subprocess.PIPE, timeout=timeout)
        return r.returncode, (r.stdout if stdout == subprocess.PIPE else b""), r.stderr
    except subprocess.TimeoutExpired as e:
        return "timeout", b"", e.stderr or b""


def unit_state():
    rc, out, err = run(["systemctl", "show", UNIT, "-p", "ActiveState", "-p", "SubState", "-p", "MainPID", "-p", "UnitFileState"], 20)
    if rc != 0:
        return {"error": f"rc:{rc} {clean_err(err)}"}
    s = dict(l.split("=", 1) for l in out.decode().splitlines() if "=" in l)
    return {k: s.get(k, "") for k in ("ActiveState", "SubState", "MainPID", "UnitFileState")}


def writer_process():
    rc, _, _ = run(["pgrep", "-u", SVC_USER, "-x", "indexd"], 10)
    return {0: True, 1: False}.get(rc, "unknown")


def psql(sql, timeout=30):
    script = 'exec timeout --foreground -k 5 20 psql -U "${POSTGRES_USER:-postgres}" -d "$1" -X -A -t -q -v ON_ERROR_STOP=1 -c "$2"'
    rc, out, err = run(["docker", "exec", "-e", "PGOPTIONS=" + PGOPTS, PG, "sh", "-c", script, "psql", DB, sql], timeout)
    if rc != 0:
        raise RuntimeError(f"psql rc:{rc} {clean_err(err)}")
    return out.decode().strip()


def sha256_file(path, deadline=None):
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for c in iter(lambda: f.read(CHUNK), b""):
            h.update(c)
            if deadline and time.monotonic() > deadline:
                raise Deadline("hash past the quiesce budget")
    return h.hexdigest()


class Run:
    def __init__(self, a):
        self.a, self.run_id = a, a.run_id
        self.dir = os.path.join(PARENT, self.run_id)
        self.journal_path = os.path.join(PARENT, self.run_id + ".journal.jsonl")
        self.receipt_path = os.path.join(PARENT, self.run_id + ".receipt.json")
        self.created, self.dev_ino, self.token = [], None, None
        self.was_active, self.stopped_by_us, self.resumed = None, False, None
        self.journal_fd = None

    def j(self, phase, **kw):
        rec = {"t": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()), "phase": phase, **kw}
        if self.journal_fd is not None:
            os.write(self.journal_fd, (json.dumps(rec, sort_keys=True) + "\n").encode())
            os.fsync(self.journal_fd)
        emit("fb.phase", phase + ("" if not kw else " " + json.dumps(kw, sort_keys=True)))

    # ---- exclusive, confirmed-ownership storage ----
    def parent_ok(self):
        try:
            st = os.lstat(PARENT)
        except FileNotFoundError:
            os.mkdir(PARENT, 0o700)
            st = os.lstat(PARENT)
        if not stat.S_ISDIR(st.st_mode) or st.st_uid != 0 or stat.S_IMODE(st.st_mode) != 0o700:
            raise Refused("backup parent is not a root-owned 0700 directory (or is a symlink)")

    def excl(self, name, mode=0o600):
        fd = os.open(os.path.join(self.dir, name), os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, mode)
        self.created.append(name)
        return fd

    def make_dir(self):
        os.mkdir(self.dir, 0o700)                      # FileExistsError -> refused by the caller: never reuse
        st = os.lstat(self.dir)
        self.dev_ino = (st.st_dev, st.st_ino)
        self.token = secrets.token_hex(16)
        fd = self.excl(".owner")
        os.write(fd, (self.run_id + " " + self.token + "\n").encode()); os.fsync(fd); os.close(fd)

    def confirmed_own(self, path):
        """The directory at `path` is the one this run created: same dev/inode, marker token, only own names."""
        st = os.lstat(path)
        if not stat.S_ISDIR(st.st_mode) or (st.st_dev, st.st_ino) != tuple(self.dev_ino):
            return False, "directory identity changed"
        try:
            with open(os.path.join(path, ".owner"), "rb") as f:
                if f.read().decode().split() != [self.run_id, self.token]:
                    return False, "ownership marker differs"
        except OSError:
            return False, "ownership marker unreadable"
        extra = set(os.listdir(path)) - OWN_NAMES
        return (not extra), ("foreign entries present: " + ",".join(sorted(extra))[:120] if extra else "")

    def discard(self, why):
        """Remove this run's partial plaintext - only after confirmed ownership; otherwise preserve it (UNKNOWN)."""
        hidden = os.path.join(PARENT, f".discard-{self.run_id}-{self.token}")
        try:
            os.rename(self.dir, hidden)                # private name first, then re-verify identity
            ok, detail = self.confirmed_own(hidden)
            if not ok:
                self.j("discard-preserved", reason=detail, path=hidden)
                return "preserved:" + detail
            for n in os.listdir(hidden):
                os.unlink(os.path.join(hidden, n))
            os.rmdir(hidden)
            self.j("discarded", why=why)
            return "removed"
        except OSError as e:
            self.j("discard-preserved", reason=type(e).__name__)
            return "preserved:" + type(e).__name__

    # ---- the service ----
    def stop(self):
        self.j("stopping")
        self.stopped_by_us = True                       # from here on a resume is owed, whatever the stop returned
        rc, _, err = run(["systemctl", "stop", UNIT], 200)
        s = unit_state()
        if rc != 0 or s.get("ActiveState") != "inactive" or s.get("MainPID") != "0" or writer_process() is not False:
            raise RuntimeError(f"stop not confirmed (rc:{rc} {clean_err(err)}; state {s.get('ActiveState')}/{s.get('MainPID')})")
        self.j("stopped")

    def resume(self):
        if not self.stopped_by_us:
            s = unit_state()
            self.j("left-as-found", active=s.get("ActiveState"))
            self.resumed = s.get("ActiveState") == ("active" if self.was_active else "inactive")
            return
        self.j("starting")
        rc, _, err = run(["systemctl", "start", UNIT], 150)
        for _ in range(60):
            s = unit_state()
            if s.get("ActiveState") == "active" and s.get("SubState") == "running" and s.get("MainPID", "0") not in ("", "0"):
                self.resumed = True
                self.j("resumed", mainpid_present=True)
                return
            if s.get("ActiveState") in ("failed", "inactive") and rc != "timeout":
                break
            time.sleep(1)
        self.resumed = False
        self.j("RESUME-FAILED", start_rc=str(rc), err=clean_err(err), state=unit_state().get("ActiveState"))

    # ---- capture ----
    def capture(self, deadline):
        a = self.a
        dump_fd = self.excl("indexd.pgdump")
        try:
            script = ('exec timeout --foreground -k 5 "$2" pg_dump -U "${POSTGRES_USER:-postgres}" --format=custom --no-owner --no-acl '
                      '--lock-wait-timeout=5000 "$1"')
            left = max(1, int(deadline - time.monotonic()))
            rc, _, err = run(["docker", "exec", PG, "sh", "-c", script, "pg_dump", DB, str(min(a.dump_timeout, left))],
                             min(a.dump_timeout, left) + 15, stdout=dump_fd)
        finally:
            os.close(dump_fd)
        if rc != 0:
            raise RuntimeError(f"pg_dump rc:{rc} {clean_err(err)}")
        with open(os.path.join(self.dir, "indexd.pgdump"), "rb") as f:
            if f.read(5) != b"PGDMP":
                raise RuntimeError("pg_dump output is not a custom-format archive")
        self.j("dumped")
        for name, src in SOURCES.items():
            fd = self.excl(name)
            try:
                with open(src, "rb") as s:             # follows a binary symlink: the bytes that run are what is kept
                    for c in iter(lambda: s.read(CHUNK), b""):
                        os.write(fd, c)
                        if time.monotonic() > deadline:
                            raise Deadline(f"copy of {name} past the quiesce budget")
                os.fsync(fd)
            finally:
                os.close(fd)
            self.j("copied", file=name)
        counts = {}
        for t in ("objects", "slabs", "contracts", "accounts"):
            counts[t] = int(psql(f"SELECT count(*) FROM {t}"))
        counts["dbVersion"] = int(psql("SELECT db_version FROM global_settings"))
        fd = self.excl("counts.json"); os.write(fd, (json.dumps(counts, sort_keys=True) + "\n").encode()); os.fsync(fd); os.close(fd)
        if counts["dbVersion"] != a.expect_db_version:
            raise RuntimeError(f"db_version changed to {counts['dbVersion']}")
        if time.monotonic() > deadline:
            raise Deadline("capture finished past the quiesce budget")
        return counts


def capture_main(a):
    r = Run(a)
    t0 = time.monotonic()
    outcome, code, backup_ok, coupled, counts, files, pre = "refused", 5, False, None, None, {}, None
    lockfd = os.open(LOCK, os.O_RDWR | os.O_CREAT, 0o600)
    try:
        fcntl.flock(lockfd, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except OSError:
        emit("fb.outcome", "refused:another snapshot/backup holds the lock"); return 5

    def on_signal(sig, _frame):
        raise KeyboardInterrupt(f"signal {sig}")
    for s in (signal.SIGTERM, signal.SIGINT, signal.SIGHUP):
        signal.signal(s, on_signal)

    try:
        # ---------- read-only preflight (nothing changes; any failure here = refused) ----------
        if os.geteuid() != 0:
            raise Refused("must run as root")
        if not RUN_RE.match(a.run_id):
            raise Refused("run id must be <UTC yyyymmddThhmmssZ>-<8 hex>")
        r.parent_ok()
        if any(os.path.lexists(p) for p in (r.dir, r.journal_path, r.receipt_path)):
            raise Refused("run id already used (directory, journal or receipt exists)")
        r.journal_fd = os.open(r.journal_path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_APPEND | os.O_NOFOLLOW, 0o600)
        pre = unit_state()
        r.j("prestate", **{k: v for k, v in pre.items() if k != "error"}, error=pre.get("error", ""))
        if "error" in pre:
            raise Refused("unit state unreadable")
        if pre["ActiveState"] == "active" and pre["SubState"] == "running" and pre["MainPID"] not in ("", "0"):
            r.was_active = True
            if not os.path.exists(ALLOW):
                raise Refused("unit runs but ALLOW_LIVE_START is absent: a restart would not start it")
        elif pre["ActiveState"] == "inactive" and pre["MainPID"] == "0":
            r.was_active = False
            if writer_process() is not False:
                raise Refused("unit inactive but an indexd process exists (or pgrep failed)")
        else:
            raise Refused(f"unit state {pre['ActiveState']}/{pre['SubState']} is neither running nor cleanly inactive")
        rc, out, err = run(["docker", "inspect", "-f", "{{.State.Running}}", PG], 20)
        if rc != 0 or out.decode().strip() != "true":
            raise Refused("PostgreSQL container is not running")
        rc, _, _ = run(["docker", "exec", PG, "sh", "-c", "command -v timeout >/dev/null && timeout --foreground 5 true"], 20)
        if rc != 0:
            raise Refused("no `timeout` with --foreground inside the PostgreSQL container: pg_dump could not be bounded")
        v = int(psql("SELECT db_version FROM global_settings"))
        if v != a.expect_db_version:
            raise Refused(f"db_version {v} != expected {a.expect_db_version}")
        if sha256_file(SOURCES["indexd"]) != a.expect_binary_sha256:
            raise Refused("deployed binary sha256 differs from the reviewed preflight value")
        if sha256_file(SOURCES["GeoLite2-City.mmdb"]) != a.expect_geoip_sha256:
            raise Refused("GeoIP sha256 differs from the profile value")
        need = 2 * sum(os.stat(p).st_size for p in SOURCES.values()) + int(psql("SELECT pg_database_size(current_database())")) * 2 + (1 << 30)
        free = os.statvfs(PARENT); free = free.f_bavail * free.f_frsize
        if free < need:
            raise Refused(f"free {free} < needed {need} bytes")
        r.j("preflight-ok", was_active=r.was_active, free_bytes=free, need_bytes=need, db_version=v)
        try:
            r.make_dir()
        except FileExistsError:
            raise Refused("run directory appeared concurrently")
        emit("fb.token", r.token)
        r.j("created", dev_ino=list(r.dev_ino))

        # ---------- quiesce (only if it was running), capture, verify coupling ----------
        outcome, code = "failed", 3
        q0 = q_end = time.monotonic()
        binary_symlink = os.path.islink(SOURCES["indexd"])
        try:
            if r.was_active:
                r.stop()
            counts = r.capture(time.monotonic() + a.quiesce_budget)   # the budget runs from the confirmed stop
            s = unit_state()
            coupled = s.get("ActiveState") == "inactive" and s.get("MainPID") == "0" and writer_process() is False
            r.j("coupling", coupled=coupled)
            if not coupled:
                raise RuntimeError("the writer was started by another actor during the capture: not a coupled backup")
            backup_ok = True
        except (Exception, KeyboardInterrupt) as e:
            r.j("capture-failed", error=type(e).__name__ + ": " + str(e)[:200])
        finally:
            q_end = time.monotonic()
            for sg in (signal.SIGTERM, signal.SIGINT, signal.SIGHUP):
                signal.signal(sg, signal.SIG_IGN)          # the resume is never cut short by a further signal
            try:
                r.resume()
            except (Exception, KeyboardInterrupt) as e:     # a second signal or a crash inside resume
                r.resumed = None
                r.j("RESUME-UNKNOWN", error=type(e).__name__)
        quiesced_s = round(q_end - q0, 3) if r.was_active else 0.0
        if backup_ok:
            for n in MEMBERS:
                pth = os.path.join(r.dir, n)
                files[n] = {"sha256": sha256_file(pth), "bytes": os.path.getsize(pth)}
            manifest = {"capturedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()), "runId": a.run_id,
                        "source": "minipc / enclave-storage", "quiesced": bool(r.was_active), "coupled": True,
                        "writerWasActive": r.was_active, "sourceResumed": r.resumed, "stoppedSeconds": quiesced_s,
                        "dbVersion": counts["dbVersion"], "counts": {k: counts[k] for k in ("objects", "slabs", "contracts", "accounts")},
                        "binarySha256": files["indexd"]["sha256"], "binaryPathWasSymlink": binary_symlink,
                        "geoipSha256": files["GeoLite2-City.mmdb"]["sha256"],
                        "files": files, "containsConfigSecrets": True, "plaintextLocation": "VM " + r.dir[len(ROOT):]}
            fd = r.excl("manifest.json"); os.write(fd, (json.dumps(manifest, indent=2, sort_keys=True) + "\n").encode()); os.fsync(fd); os.close(fd)
            ok, detail = r.confirmed_own(r.dir)
            if not ok:
                backup_ok = False
                r.j("ownership-unconfirmed", detail=detail)
        if r.resumed is True:
            outcome, code = ("complete", 0) if backup_ok else ("failed:state-restored", 3)
        else:
            outcome, code = ("UNRESTORED" if r.resumed is False else "UNKNOWN") + (":backup-complete" if backup_ok else ":backup-failed"), 4
        if not backup_ok and r.dev_ino:
            emit("fb.partial", r.discard(outcome))
    except Refused as e:
        outcome, code = "refused:" + str(e), 5
        if r.journal_fd is not None:
            r.j("refused", reason=str(e))
    except (Exception, KeyboardInterrupt) as e:
        err = type(e).__name__ + ": " + str(e)[:160]
        if not r.stopped_by_us:                            # nothing was changed: refused
            outcome, code = "refused:" + err, 5
        elif r.resumed is True:                            # e.g. a manifest/hash error after a verified resume
            outcome, code, backup_ok = "failed:state-restored:" + err, 3, False
        else:
            outcome, code, backup_ok = "UNKNOWN:" + err, 4, False
        if r.journal_fd is not None:
            r.j("error", error=outcome)
        if r.dev_ino and not backup_ok and r.token and os.path.lexists(r.dir):
            emit("fb.partial", r.discard(outcome))
    finally:
        for s in (signal.SIGTERM, signal.SIGINT, signal.SIGHUP):
            signal.signal(s, signal.SIG_IGN)               # the receipt is written whatever arrives now
        if r.journal_fd is not None:
            receipt = {"runId": a.run_id, "outcome": outcome, "exit": code, "token": r.token, "writerWasActive": r.was_active,
                       "stoppedByRun": r.stopped_by_us, "sourceResumed": r.resumed, "backupComplete": backup_ok, "coupled": coupled,
                       "files": files, "counts": counts, "preState": pre, "elapsedSeconds": round(time.monotonic() - t0, 3),
                       "directory": r.dir[len(ROOT):] if backup_ok else None, "root": ROOT or "/"}
            try:
                fd = os.open(r.receipt_path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
                os.write(fd, (json.dumps(receipt, indent=2, sort_keys=True) + "\n").encode()); os.fsync(fd); os.close(fd)
            except OSError as e:
                outcome += ";receipt-not-written:" + type(e).__name__
            os.close(r.journal_fd)
        emit("fb.root", ROOT or "/")
        emit("fb.outcome", outcome)
    return code


def status_main(a):
    """Read-only: what happened to a run whose transport was lost, and the unit's state NOW."""
    if not RUN_RE.match(a.run_id):
        emit("fb.status", "bad run id"); return 6
    jp, rp = os.path.join(PARENT, a.run_id + ".journal.jsonl"), os.path.join(PARENT, a.run_id + ".receipt.json")
    phases = []
    if os.path.exists(jp):
        with open(jp) as f:
            phases = [json.loads(l)["phase"] for l in f if l.strip()]
    emit("fb.status.journal_phases", ",".join(phases) or "(none)")
    if os.path.exists(rp):
        r = json.load(open(rp))
        for k in ("outcome", "exit", "sourceResumed", "backupComplete", "coupled", "stoppedByRun", "writerWasActive"):
            emit("fb.status." + k, r.get(k))
    else:
        emit("fb.status.receipt", "absent (run still in progress, killed, or never started)")
    s = unit_state()
    emit("fb.status.unit_now", f"{s.get('ActiveState')}/{s.get('SubState')} mainpid_nonzero={s.get('MainPID') not in ('', '0', None)}")
    emit("fb.status.writer_process_now", writer_process())
    return 0


def remove_main(a):
    """Remove the plaintext run directory after root verified the off-host encrypted copy; confirmed ownership only."""
    rp = os.path.join(PARENT, a.run_id + ".receipt.json")
    if not RUN_RE.match(a.run_id) or not os.path.exists(rp):
        emit("fb.remove", "refused: unknown run"); return 6
    rec = json.load(open(rp))
    if rec.get("token") != a.token or rec.get("outcome") != "complete":
        emit("fb.remove", "refused: token mismatch or run not complete"); return 6
    r = Run(a); r.token = a.token
    st = os.lstat(r.dir); r.dev_ino = (st.st_dev, st.st_ino)
    jdev = None
    with open(os.path.join(PARENT, a.run_id + ".journal.jsonl")) as f:
        for l in f:
            e = json.loads(l)
            if e["phase"] == "created":
                jdev = tuple(e["dev_ino"])
    if jdev != r.dev_ino:
        emit("fb.remove", "refused: directory identity differs from the journal"); return 6
    r.journal_fd = os.open(os.path.join(PARENT, a.run_id + ".journal.jsonl"), os.O_WRONLY | os.O_APPEND | os.O_NOFOLLOW)
    res = r.discard("plaintext removed after verified off-host copy")
    os.close(r.journal_fd)
    emit("fb.remove", res)
    return 0 if res == "removed" else 6


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("mode", choices=["capture", "status", "remove"])
    ap.add_argument("--run-id", required=True)
    ap.add_argument("--confirm", default="")
    ap.add_argument("--token", default="")
    ap.add_argument("--expect-db-version", type=int, default=26)
    ap.add_argument("--expect-binary-sha256", default="")
    ap.add_argument("--expect-geoip-sha256", default="")
    ap.add_argument("--quiesce-budget", type=int, default=600)
    ap.add_argument("--dump-timeout", type=int, default=300)
    a = ap.parse_args()
    if a.mode == "status":
        return status_main(a)
    if a.mode == "remove":
        if a.confirm != "remove-plaintext":
            emit("fb.remove", "refused: pass --confirm remove-plaintext"); return 6
        return remove_main(a)
    if a.confirm != "fresh-backup":
        emit("fb.outcome", "refused:pass --confirm fresh-backup"); return 5
    if not (re.fullmatch(r"[0-9a-f]{64}", a.expect_binary_sha256) and re.fullmatch(r"[0-9a-f]{64}", a.expect_geoip_sha256)):
        emit("fb.outcome", "refused:expected binary and GeoIP sha256 are required"); return 5
    if not (5 <= a.quiesce_budget <= 1800 and 2 <= a.dump_timeout <= 900):
        emit("fb.outcome", "refused:budget out of range"); return 5
    return capture_main(a)


if __name__ == "__main__":
    sys.exit(main())
