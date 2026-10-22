"""c2fx: resource OWNERSHIP for one C2 fixture run (storage-enclave-fixture). Replaces the cleanup half of the old
run-c2-fixture.sh/pg-fixture.sh, whose EXIT trap was installed before the stale-secrets refusal and then stopped/deleted
FIXED names (node/, secrets/, seed-tree/, container enclave-c2-fixture-pg, volume enclave-c2-fixture-pgdata), so a
collision could destroy another run.

Rules (each is tested in test/test_ownership.py):
- Every run has a fresh random run id. Its journal runs/<id>.journal.jsonl is created EXCLUSIVELY first (O_EXCL, fsync'd,
  never deleted, no secret in it). Every resource gets an "intent" record BEFORE it is created and a result record after.
- STAGE runs/<id>/ (root review R1): an intent NEVER confirms ownership. The stage is ours only if ALL of these hold:
  * the journal holds a "created" record, written only after OUR mkdir returned success (a FileExistsError, or any
    failure, records "create-failed" and the path is never touched);
  * the record has the stage's device and inode, taken right after that mkdir;
  * the record has a random token, written into an O_EXCL marker file .c2fx-owner inside the new (empty) stage.
  Cleanup deletes only a directory that still has that device/inode AND that marker content. It renames the stage to a
  private name first, verifies the renamed directory again, and only then removes it. A replacement directory at the same
  path (another run's, or one with a copied marker) is PRESERVED. A lost confirmation (an intent without "created",
  e.g. the runner was killed right after mkdir) leaves the stage UNKNOWN and preserved.
- Docker names carry the run id, and every object carries the label org.enclave.c2fixture.run=<id>. A name that already
  exists is refused BEFORE anything is created. After a create (also after a lost/timed-out response) the object is ours
  only if it exists WITH our label. `docker volume create` silently returns an existing volume: the label check catches that.
  Cleanup acts only on what the journal says this run intended, and only on an object that still carries our label.
- PROCESSES (root review R2): files are deleted only after this run's OWN kernel scope is DRAINED. The scope is the
  shared queue's per-job systemd-run scope run-p<G>-i<n>.scope (work/claude-test-queue.py runs
  `systemd-run --user --scope ... node memory-guard.mjs -- <command>`):
  * G is the memory guard;
  * the guard spawns the command (this runner, or a `timeout` wrapper);
  * everything the runner starts stays in the scope, including reparented orphans (e.g. indexd, go tool children,
    grandchildren).
  At start the runner records its exact ANCESTOR CHAIN inside the scope (pid + starttime, up to the guard G). Every
  scope member must be on that chain then. At cleanup every member NOT on that chain is workload of this run, whatever
  its executable:
  * signalled only through a pidfd whose identity (starttime) AND scope membership were re-verified after binding;
  * SIGTERM, then SIGKILL, re-queried for a bounded number of rounds;
  * ancestors (guard, timeout, runner) are never signalled;
  * nothing outside the scope is ever read or signalled: no host-wide process scan, no name patterns.
  A scope that is gone, or replaced by a new cgroup with another inode, cannot hold this run's processes any more
  (a cgroup with members cannot be removed). The controller's identity pid file is also checked.
- Anything uncertain:
  * the stage (with its 0600 disposable secrets), the journal and the container/volume names stay;
  * the result says the cleanup is uncertain, and the exit code is non-zero. Never PASS.
"""
import errno
import json
import os
import re
import secrets
import select
import shutil
import signal
import stat
import subprocess
import time
from pathlib import Path

LABEL = "org.enclave.c2fixture.run"
IMAGE = "postgres@sha256:74935e72241653ca55e0414067e6d8763aceb8a810eb51b452253ec3dcfc4336"
BOOT_ID_FILE = "/proc/sys/kernel/random/boot_id"
MARKER = ".c2fx-owner"
SCOPE_RX = re.compile(r"^run-p(\d+)-i\d+\.scope$")
DRAIN_ROUNDS = 5


class Unknown(Exception):
    """a state that cannot be confirmed: never treated as clean"""


class Refused(Exception):
    """a precondition failed before anything of this run was created or touched"""


# ---------------------------------------------------------------- /proc (injectable for tests)
class Proc:
    root = "/proc"

    def _stat(self, pid):
        try:
            raw = Path(f"{self.root}/{pid}/stat").read_bytes()
        except (FileNotFoundError, ProcessLookupError):
            return None
        except OSError as e:
            raise Unknown(f"/proc/{pid}/stat: {type(e).__name__} {e.errno}")
        return raw[raw.rindex(b")") + 2:].split()   # fields 3.. (comm may hold spaces/parentheses)

    def start(self, pid):
        """starttime of a live non-zombie pid, None if gone or a zombie; Unknown on any other error"""
        f = self._stat(pid)
        return None if f is None or f[0] in (b"Z", b"X") else f[19].decode()

    def ppid(self, pid):
        f = self._stat(pid)
        return None if f is None else int(f[1])

    def cgroup(self, pid):
        """the cgroup v2 path of pid ("/user.slice/..."), None if gone; Unknown if unreadable"""
        try:
            line = Path(f"{self.root}/{pid}/cgroup").read_text().strip()
        except (FileNotFoundError, ProcessLookupError):
            return None
        except OSError as e:
            raise Unknown(f"/proc/{pid}/cgroup: {type(e).__name__} {e.errno}")
        return line.split("::", 1)[1] if "::" in line else None

    def cmdline(self, pid):
        try:
            return Path(f"{self.root}/{pid}/cmdline").read_bytes().split(b"\0")
        except (FileNotFoundError, ProcessLookupError):
            return None

    def boot_id(self):
        return Path(BOOT_ID_FILE).read_text().strip()

    def pidfd_open(self, pid):
        return os.pidfd_open(pid)

    def pidfd_signal(self, fd, sig):
        signal.pidfd_send_signal(fd, sig)

    def pidfd_wait(self, fd, seconds):
        po = select.poll()
        po.register(fd, select.POLLIN)
        return bool(po.poll(int(max(seconds, 0) * 1000)))


def read_procs(cgroup_dir):
    """members of a cgroup; [] if the cgroup is gone; Unknown on any other error"""
    try:
        return [int(x) for x in (Path(cgroup_dir) / "cgroup.procs").read_text().split()]
    except FileNotFoundError:
        return []
    except OSError as e:
        raise Unknown(f"{cgroup_dir}/cgroup.procs: {type(e).__name__}")


def queue_scope(proc=None):
    """this process's shared-queue scope: the cgroup dir, its inode, memory.max and the exact ancestor chain inside it.
    Refused unless:
    - we are inside a run-p<G>-i<n>.scope;
    - our ancestors stay in it up to G;
    - G is the queue's memory guard;
    - every member of the scope is on that chain (nothing else runs in it yet)."""
    proc = proc or Proc()
    rel = proc.cgroup("self")
    if rel is None:
        raise Refused("no cgroup")
    d = Path("/sys/fs/cgroup" + rel)
    m = SCOPE_RX.match(d.name)
    if not m:
        raise Refused(f"not inside a shared-queue scope: {rel}")
    guard = int(m.group(1))
    chain, pid = [], os.getpid()
    while True:
        if proc.cgroup(pid) != rel:
            raise Refused(f"ancestor {pid} is outside the scope before the guard")
        chain.append([pid, proc.start(pid)])
        if pid == guard:
            break
        pid = proc.ppid(pid)
        if pid is None or pid <= 1:
            raise Refused("the guard is not an ancestor")
    cmd = proc.cmdline(guard) or []
    if not any(c.endswith(b"memory-guard.mjs") for c in cmd):
        raise Refused(f"scope main process {guard} is not the queue's memory guard")
    exempt = {(p, s) for p, s in chain}
    extra = [p for p in read_procs(d) if proc.start(p) is not None and (p, proc.start(p)) not in exempt]
    if extra:
        raise Refused(f"the scope already holds non-ancestor processes {extra}")
    mm = (d / "memory.max").read_text().strip()
    return {"cgroup": str(d), "rel": rel, "ino": os.stat(d).st_ino, "exempt": chain, "memoryMax": None if mm == "max" else int(mm)}


# ---------------------------------------------------------------- journal
class Journal:
    def __init__(self, path, create):
        self.path = Path(path)
        if create:
            fd = os.open(self.path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_APPEND, 0o600)
            os.close(fd)
            dfd = os.open(self.path.parent, os.O_RDONLY)
            os.fsync(dfd)
            os.close(dfd)

    def add(self, **rec):
        rec["at"] = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
        with open(self.path, "a") as f:
            f.write(json.dumps(rec, sort_keys=True) + "\n")
            f.flush()
            os.fsync(f.fileno())

    def records(self):
        return [json.loads(l) for l in self.path.read_text().splitlines() if l.strip()]


# ---------------------------------------------------------------- docker (injectable CLI path for tests)
class Docker:
    def __init__(self, cli="docker", timeout=120):
        self.cli, self.timeout = cli, timeout

    def run(self, *args, timeout=None, input=None):
        """-> (rc, stdout, stderr); a timeout is rc None (a LOST response: the daemon may still have acted)"""
        try:
            r = subprocess.run([self.cli, *args], capture_output=True, text=True, timeout=timeout or self.timeout, input=input)
            return r.returncode, r.stdout, r.stderr
        except subprocess.TimeoutExpired:
            return None, "", "timeout"

    def labels(self, kind, name):
        """{labels} of an existing container/volume, None if it does not exist; Unknown if docker cannot tell"""
        fmt = "{{json .Config.Labels}}" if kind == "container" else "{{json .Labels}}"
        rc, out, err = self.run(kind, "inspect", "--format", fmt, name, timeout=30)
        if rc == 0:
            return json.loads(out.strip() or "null") or {}
        if rc is not None and ("No such" in err or "no such" in err):
            return None
        raise Unknown(f"docker {kind} inspect {name}: rc {rc} {err.strip()[-160:]}")


# ---------------------------------------------------------------- one run
class Run:
    def __init__(self, runs_dir, docker, proc=None, run_id=None, scope=None):
        self.runs = Path(runs_dir)
        self.docker, self.proc = docker, proc or Proc()
        self.id = run_id or secrets.token_hex(8)
        self.stage = self.runs / self.id
        self.container = f"enclave-c2fx-{self.id}-pg"
        self.volume = f"enclave-c2fx-{self.id}-pgdata"
        self.scope = scope          # queue_scope() of the runner (None: drainage cannot be proven -> UNKNOWN)
        self.children = []          # Popen handles of this runner's own direct children
        self.journal = None
        self.term_wait, self.kill_wait = 60, 10   # seconds for workload to exit after SIGTERM, then after SIGKILL

    # ---- creation -------------------------------------------------------------------------------------------
    def begin(self):
        """journal first (exclusive), then refuse pre-existing names, then the exclusive, recorded stage"""
        self.runs.mkdir(mode=0o700, exist_ok=True)
        st = os.lstat(self.runs)
        if not stat.S_ISDIR(st.st_mode) or st.st_uid != os.getuid() or stat.S_IMODE(st.st_mode) & 0o022:
            raise Refused(f"{self.runs} is not a private directory of this user")
        try:
            self.journal = Journal(self.runs / f"{self.id}.journal.jsonl", create=True)
        except FileExistsError:
            raise Refused(f"journal for run {self.id} already exists")
        self.journal.add(event="run", runId=self.id, stage=str(self.stage), container=self.container, volume=self.volume,
                         scope=self.scope, bootId=self.proc.boot_id(), runnerPid=os.getpid(), runnerStart=self.proc.start(os.getpid()))
        for kind, name in (("container", self.container), ("volume", self.volume)):
            if self.docker.labels(kind, name) is not None:
                self.journal.add(event="refused", reason=f"{kind} {name} already exists")
                raise Refused(f"{kind} {name} already exists: not touched")
        if os.path.lexists(self.stage):
            self.journal.add(event="refused", reason="stage exists")
            raise Refused(f"stage {self.stage} already exists: not touched")
        self.journal.add(event="intent", resource="stage", name=str(self.stage))
        try:
            os.mkdir(self.stage, 0o700)
        except OSError as e:
            # NOT ours: whoever made it (a race between the check and mkdir) owns it; nothing here will touch it
            self.journal.add(event="create-failed", resource="stage", name=str(self.stage), error=f"{type(e).__name__}: {e}")
            raise                                # the original error (FileExistsError for a race); the stage is not ours
        st = os.lstat(self.stage)
        token = secrets.token_hex(16)
        try:
            if not stat.S_ISDIR(st.st_mode) or st.st_uid != os.getuid() or os.listdir(self.stage):
                raise OSError("the new stage is not an empty directory of ours")
            fd = os.open(self.stage / MARKER, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
            with os.fdopen(fd, "w") as f:
                f.write(f"{self.id} {token}\n")
                f.flush()
                os.fsync(f.fileno())
        except OSError as e:
            self.journal.add(event="create-unconfirmed", resource="stage", name=str(self.stage), error=f"{type(e).__name__}: {e}")
            raise Refused(f"stage {self.stage}: ownership not confirmed ({e}): preserved")
        self.journal.add(event="created", resource="stage", name=str(self.stage), dev=st.st_dev, ino=st.st_ino, token=token)

    def _ours(self, kind, name, settle=3):
        """after a create (answered or not): is the object there WITH our label? polls briefly for a lost response"""
        for i in range(settle):
            lab = self.docker.labels(kind, name)
            if lab is not None:
                return lab.get(LABEL) == self.id
            time.sleep(1 if i < settle - 1 else 0)
        return False

    def create_volume(self):
        self.journal.add(event="intent", resource="volume", name=self.volume)
        rc, _, err = self.docker.run("volume", "create", "--label", f"{LABEL}={self.id}", self.volume, timeout=60)
        ours = self._ours("volume", self.volume)
        self.journal.add(event="created" if ours else "not-ours", resource="volume", name=self.volume, rc=rc)
        if not ours:
            raise Refused(f"volume {self.volume}: not created with our label (rc {rc} {err.strip()[-120:]})")

    def create_container(self, env_file, mem_mib=256):
        """the disposable PostgreSQL: the old pg-fixture.sh flags, plus our name/label, --pull never (no download), an
        EPHEMERAL host port on 127.0.0.1 only, and its own memory/pid/cpu caps (outside the queue's scope)"""
        self.journal.add(event="intent", resource="container", name=self.container)
        rc, out, err = self.docker.run(
            "run", "-d", "--pull", "never", "--name", self.container, "--label", f"{LABEL}={self.id}",
            "-p", "127.0.0.1::5432", "--read-only", "--memory", f"{mem_mib}m", "--memory-swap", f"{mem_mib}m",
            "--pids-limit", "256", "--cpus", "1",
            "--env-file", str(env_file), "--mount", f"type=volume,source={self.volume},target=/var/lib/postgresql",
            "--tmpfs", "/var/run/postgresql:rw,size=16m", "--tmpfs", "/tmp:rw,size=64m",
            IMAGE, "postgres", "-c", "listen_addresses=*", "-c", "shared_buffers=128MB", "-c", "max_connections=50", timeout=120)
        ours = self._ours("container", self.container)
        self.journal.add(event="created" if ours else "not-ours", resource="container", name=self.container, rc=rc)
        if not ours:
            raise Refused(f"container {self.container}: not created with our label (rc {rc} {err.strip()[-160:]})")
        rc, out, err = self.docker.run("port", self.container, "5432/tcp", timeout=30)
        hp = (out.strip().splitlines() or [""])[0]
        host, _, port = hp.rpartition(":")
        if rc != 0 or host != "127.0.0.1" or not port.isdigit():
            raise Refused(f"container port is not loopback-only: {hp!r} rc {rc}")
        self.journal.add(event="port", resource="container", hostPort=int(port))
        return int(port)

    def wait_pg(self, seconds=60):
        for _ in range(seconds):
            rc, _, _ = self.docker.run("exec", self.container, "pg_isready", "-q", "-h", "127.0.0.1", timeout=15)
            if rc == 0:
                return True
            time.sleep(1)
        return False

    # ---- stage ownership --------------------------------------------------------------------------------------
    def stage_record(self):
        recs = [r for r in self.journal.records() if r.get("resource") == "stage"]
        created = [r for r in recs if r["event"] == "created"]
        return recs, (created[-1] if created else None)

    def stage_is_ours(self, path, rec):
        """the directory at path is the one OUR mkdir created: same device+inode as recorded, our uid, and our marker"""
        try:
            st = os.lstat(path)
        except FileNotFoundError:
            return None
        if not stat.S_ISDIR(st.st_mode) or st.st_uid != os.getuid() or (st.st_dev, st.st_ino) != (rec["dev"], rec["ino"]):
            return False
        try:
            fd = os.open(Path(path) / MARKER, os.O_RDONLY | os.O_NOFOLLOW)
        except OSError:
            return False
        with os.fdopen(fd) as f:
            ok = stat.S_ISREG(os.fstat(f.fileno()).st_mode) and f.read() == f"{self.id} {rec['token']}\n"
        return ok

    def remove_stage(self, rec):
        """-> (report, certain). Rename to a private name, re-verify the renamed directory, then remove it."""
        v = self.stage_is_ours(self.stage, rec)
        if v is None:
            return "absent", True
        if v is False:
            return "PRESERVED: the directory at the stage path is not the one this run created", False
        trash = self.runs / f".{self.id}.removing"
        if os.path.lexists(trash):
            return f"UNKNOWN: {trash} exists; stage kept", False
        os.rename(self.stage, trash)
        if self.stage_is_ours(trash, rec) is not True:      # swapped between the check and the rename: put it back
            try:
                if not os.path.lexists(self.stage):
                    os.rename(trash, self.stage)
                    return "PRESERVED: replaced during removal (restored)", False
            except OSError:
                pass
            return f"UNKNOWN: a directory that is not ours was moved to {trash}; nothing deleted", False
        shutil.rmtree(trash)
        gone = not os.path.lexists(trash)
        return ("removed" if gone else f"UNKNOWN: {trash} still present"), gone

    # ---- processes ----------------------------------------------------------------------------------------------
    def _bind(self, pid, verify):
        """a pidfd for pid whose identity still verifies AFTER binding, or None (gone / no longer ours)"""
        if verify() is not True:
            return None
        try:
            fd = self.proc.pidfd_open(pid)
        except ProcessLookupError:
            return None
        if verify() is not True:
            os.close(fd)
            return None
        return fd

    def _stop_fds(self, fds):
        """SIGTERM every bound process, wait, SIGKILL the rest, wait. -> pids still running"""
        left = dict(fds)
        for sig, wait in ((signal.SIGTERM, self.term_wait), (signal.SIGKILL, self.kill_wait)):
            for pid, fd in list(left.items()):
                try:
                    self.proc.pidfd_signal(fd, sig)
                except ProcessLookupError:
                    os.close(fd); del left[pid]
            end = time.monotonic() + wait
            for pid, fd in list(left.items()):
                if self.proc.pidfd_wait(fd, end - time.monotonic()):
                    os.close(fd); del left[pid]
            if not left:
                break
        for fd in left.values():
            os.close(fd)
        return sorted(left)

    def stop_children(self):
        out = []
        for p in self.children:
            if p.poll() is None:
                p.terminate()
                try:
                    p.wait(30)
                except subprocess.TimeoutExpired:
                    p.kill()
                    try:
                        p.wait(10)
                    except subprocess.TimeoutExpired:
                        raise Unknown(f"own child {p.pid} did not exit after SIGKILL")
            out.append({"pid": p.pid, "rc": p.returncode})
        return out

    def check_pid_files(self, pid_files):
        """the controller's identity pid files (pid, starttime, boot): stop that exact indexd if it still runs"""
        out, boot = [], self.proc.boot_id()
        for pf in pid_files:
            pf = Path(pf)
            if not os.path.lexists(pf):
                continue
            parts = pf.read_text().split()
            if len(parts) != 3 or not parts[0].isdigit():
                raise Unknown(f"unrecognized pid file {pf}")
            pid, start, b = int(parts[0]), parts[1], parts[2]
            if b != boot:
                out.append({"pid": pid, "outcome": "exited (other boot)"})
                continue
            cur = self.proc.start(pid)
            if cur is None or cur != start:
                out.append({"pid": pid, "outcome": "exited" if cur is None else "not-ours"})
                continue
            fd = self._bind(pid, lambda: True if self.proc.start(pid) == start else (None if self.proc.start(pid) is None else False))
            if fd is None:
                out.append({"pid": pid, "outcome": "exited"})
                continue
            left = self._stop_fds({pid: fd})
            if left:
                raise Unknown(f"indexd {pid} still running after SIGKILL")
            out.append({"pid": pid, "outcome": "exited"})
        return out

    def own_ancestry(self):
        """(pid, starttime) of this process and every ancestor: never signalled, wherever the cleanup runs from"""
        out, pid = set(), os.getpid()
        while pid and pid > 1:
            s = self.proc.start(pid)
            if s is None:
                break
            out.add((pid, s))
            pid = self.proc.ppid(pid)
        return out

    def drain_scope(self):
        """stop every member of OUR scope that is not on the recorded ancestor chain; bounded re-query until none is left.
        -> report; raises Unknown when drainage cannot be proven"""
        sc = self.scope
        if not sc:
            raise Unknown("no scope recorded: drainage cannot be proven")
        d = Path(sc["cgroup"])
        try:
            ino = os.stat(d).st_ino
        except FileNotFoundError:
            return {"scope": "gone (no member can remain)", "rounds": []}
        if ino != sc["ino"]:
            return {"scope": "gone (the name now belongs to another cgroup, not touched)", "rounds": []}
        exempt = {(p, s) for p, s in sc["exempt"]} | self.own_ancestry()
        rounds = []
        for _ in range(DRAIN_ROUNDS):
            work = {}
            for pid in read_procs(d):
                s = self.proc.start(pid)
                if s is not None and (pid, s) not in exempt:
                    work[pid] = s
            if not work:
                return {"scope": "drained", "rounds": rounds}
            fds = {}
            for pid, s in work.items():
                def verify(pid=pid, s=s):
                    cur = self.proc.start(pid)
                    if cur is None:
                        return None
                    return cur == s and self.proc.cgroup(pid) == sc["rel"]
                fd = self._bind(pid, verify)
                if fd is not None:
                    fds[pid] = fd
            left = self._stop_fds(fds)
            rounds.append({"members": sorted(work), "stillRunning": left})
        raise Unknown(f"scope not drained after {DRAIN_ROUNDS} rounds: {rounds[-1]}")

    # ---- cleanup --------------------------------------------------------------------------------------------
    def cleanup(self, pid_files=(), keep=()):
        """-> {"certain": bool, ...}. Acts only on what the journal says THIS run created. keep: files in the stage to
        copy next to the journal first (results), only from a verified own stage."""
        rep, certain = {"runId": self.id}, True
        recs = self.journal.records()
        intended = {r["resource"] for r in recs if r.get("event") == "intent"}
        try:
            rep["children"] = self.stop_children()
        except Unknown as e:
            rep["children"], certain = f"UNKNOWN: {e}", False
        procs_ok = True
        try:
            rep["indexdPidFiles"] = self.check_pid_files(pid_files)
        except (Unknown, OSError) as e:
            rep["indexdPidFiles"], procs_ok = f"UNKNOWN: {e}", False
        try:
            rep["scope"] = self.drain_scope()
        except (Unknown, OSError) as e:
            rep["scope"], procs_ok = f"UNKNOWN: {e}", False
        certain = certain and procs_ok
        container_gone = True
        for kind, name in (("container", self.container), ("volume", self.volume)):
            if kind not in intended:
                rep[kind] = "never intended"
                continue
            if kind == "volume" and not container_gone:
                rep[kind], certain = "kept: container not confirmed removed", False
                continue
            try:
                lab = self.docker.labels(kind, name)
                if lab is None:
                    rep[kind] = "absent"
                elif lab.get(LABEL) != self.id:
                    rep[kind], certain = "PRESERVED: exists without our label (not ours)", False
                else:
                    self.docker.run(*((["rm", "-f", name]) if kind == "container" else (["volume", "rm", name])), timeout=120)
                    # whatever the answer (or a lost one): re-inspect
                    lab = self.docker.labels(kind, name)
                    rep[kind] = "removed" if lab is None else "UNKNOWN: still exists after remove"
                    certain = certain and lab is None
            except Unknown as e:
                rep[kind], certain = f"UNKNOWN: {e}", False
            if kind == "container":
                container_gone = rep[kind] in ("absent", "removed", "never intended")
        if "stage" in intended:
            srecs, created = self.stage_record()
            if created is None:
                failed = any(r["event"] == "create-failed" for r in srecs)
                if failed:
                    rep["stage"] = "not ours (our mkdir failed): untouched"
                else:
                    rep["stage"], certain = "UNKNOWN: intent without a confirmed creation: preserved", False
            else:
                own = self.stage_is_ours(self.stage, created)
                if own:
                    for k in keep:
                        src = self.stage / k
                        if src.is_file() and not src.is_symlink():
                            shutil.copyfile(src, self.runs / f"{self.id}.{src.name}")
                if own is None:
                    rep["stage"] = "absent"
                elif own is False:
                    rep["stage"], certain = "PRESERVED: the directory at the stage path is not the one this run created", False
                elif not (certain and procs_ok):
                    rep["stage"] = f"KEPT for recovery: {self.stage}"
                else:
                    rep["stage"], ok = self.remove_stage(created)
                    certain = certain and ok
        rep["certain"] = certain
        self.journal.add(event="cleanup", report=rep)
        return rep


def recover(runs_dir, run_id, docker, proc=None):
    """re-run the cleanup of an interrupted run from its journal (e.g. after the runner was SIGKILLed). The recorded
    scope is drained with its recorded ancestor identities exempt (a dead ancestor matches no live process)."""
    j = Journal(Path(runs_dir) / f"{run_id}.journal.jsonl", create=False)
    first = j.records()[0]
    if first.get("event") != "run" or first.get("runId") != run_id:
        raise Unknown("journal does not start with this run's record")
    r = Run(runs_dir, docker, proc, run_id=run_id, scope=first.get("scope"))
    r.journal = j
    return r.cleanup(pid_files=[r.stage / "node" / "state" / "indexd.pid"])
