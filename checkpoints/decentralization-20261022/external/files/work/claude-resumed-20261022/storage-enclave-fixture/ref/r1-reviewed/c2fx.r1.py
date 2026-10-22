"""c2fx: resource OWNERSHIP for one C2 fixture run (storage-enclave-fixture). Replaces the cleanup half of the old
run-c2-fixture.sh/pg-fixture.sh, whose EXIT trap was installed before the stale-secrets refusal and then stopped/deleted
FIXED names (node/, secrets/, seed-tree/, container enclave-c2-fixture-pg, volume enclave-c2-fixture-pgdata), so a
collision could destroy another run.

Rules (each is tested in test/test_ownership.py):
- Every run has a fresh random run id. Its journal runs/<id>.journal.jsonl is created EXCLUSIVELY first (O_EXCL, fsync'd,
  never deleted, no secret in it). Every resource gets an "intent" record BEFORE it is created and a result record after.
- The stage runs/<id>/ is created with an exclusive mkdir (0700). A pre-existing path is refused and never touched.
- Docker names carry the run id, and every object carries the label org.enclave.c2fixture.run=<id>. A name that already
  exists is refused BEFORE anything is created. After a create (also after a lost/timed-out response) the object is ours
  only if it exists WITH our label. `docker volume create` silently returns an existing volume: the label check catches that.
- Cleanup acts only on what the journal says this run intended, and only on an object that still carries our label.
  An object without our label is preserved and reported.
- indexd: the stage is deleted only after OUR indexd is confirmed exited:
  * the controller's identity pid file (pid, starttime, boot id) is checked;
  * our own queue scope's cgroup.procs is checked: only processes of this allocation's scope (not a host-wide scan) whose
    /proc/<pid>/exe lies inside the stage are ours. A lost `start` response leaves such a process without a pid file.
  Signals go only through a pidfd whose identity was re-verified after binding. Any read error other than "no such process"
  is UNKNOWN.
- Anything uncertain: the stage (with its 0600 disposable secrets), the journal and the container/volume names stay, the
  result says CLEANUP_UNCERTAIN, and the exit code is non-zero. Never PASS.
"""
import errno
import json
import os
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


class Unknown(Exception):
    """a state that cannot be confirmed: never treated as clean"""


class Refused(Exception):
    """a precondition failed before anything of this run was created or touched"""


# ---------------------------------------------------------------- /proc (injectable for tests)
class Proc:
    root = "/proc"

    def start(self, pid):
        """starttime of a live non-zombie pid, None if gone or a zombie; Unknown on any other error"""
        try:
            raw = Path(f"{self.root}/{pid}/stat").read_bytes()
        except (FileNotFoundError, ProcessLookupError):
            return None
        except OSError as e:
            raise Unknown(f"/proc/{pid}/stat: {type(e).__name__} {e.errno}")
        rest = raw[raw.rindex(b")") + 2:].split()
        return None if rest[0] in (b"Z", b"X") else rest[19].decode()

    def exe(self, pid):
        """the executable path of pid, None if gone; Unknown if unreadable"""
        try:
            return os.readlink(f"{self.root}/{pid}/exe")
        except (FileNotFoundError, ProcessLookupError):
            return None
        except OSError as e:
            if e.errno == errno.ENOENT:
                return None
            raise Unknown(f"/proc/{pid}/exe: {type(e).__name__} {e.errno}")

    def boot_id(self):
        return Path(BOOT_ID_FILE).read_text().strip()

    def pidfd_open(self, pid):
        return os.pidfd_open(pid)

    def pidfd_signal(self, fd, sig):
        signal.pidfd_send_signal(fd, sig)

    def pidfd_wait(self, fd, seconds):
        po = select.poll()
        po.register(fd, select.POLLIN)
        return bool(po.poll(int(seconds * 1000)))


def own_cgroup():
    """this process's cgroup v2 directory and its memory.max (the queue's systemd-run scope)"""
    line = Path("/proc/self/cgroup").read_text().strip()
    rel = line.split("::", 1)[1]
    d = Path("/sys/fs/cgroup" + rel)
    mm = (d / "memory.max").read_text().strip()
    return str(d), (None if mm == "max" else int(mm))


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
    def __init__(self, runs_dir, docker, proc=None, run_id=None, cgroup=None):
        self.runs = Path(runs_dir)
        self.docker, self.proc = docker, proc or Proc()
        self.id = run_id or secrets.token_hex(8)
        self.stage = self.runs / self.id
        self.container = f"enclave-c2fx-{self.id}-pg"
        self.volume = f"enclave-c2fx-{self.id}-pgdata"
        self.cgroup = cgroup
        self.children = []          # Popen handles of this runner's own direct children
        self.journal = None
        self.term_wait, self.kill_wait = 60, 10   # seconds for our indexd to exit after SIGTERM, then after SIGKILL

    # ---- creation -------------------------------------------------------------------------------------------
    def begin(self):
        """journal first (exclusive), then refuse pre-existing names, then the exclusive stage"""
        self.runs.mkdir(mode=0o700, exist_ok=True)
        st = os.lstat(self.runs)
        if not stat.S_ISDIR(st.st_mode) or st.st_uid != os.getuid() or stat.S_IMODE(st.st_mode) & 0o022:
            raise Refused(f"{self.runs} is not a private directory of this user")
        try:
            self.journal = Journal(self.runs / f"{self.id}.journal.jsonl", create=True)
        except FileExistsError:
            raise Refused(f"journal for run {self.id} already exists")
        self.journal.add(event="run", runId=self.id, stage=str(self.stage), container=self.container, volume=self.volume,
                         cgroup=self.cgroup, bootId=self.proc.boot_id(), runnerPid=os.getpid(), runnerStart=self.proc.start(os.getpid()))
        for kind, name in (("container", self.container), ("volume", self.volume)):
            if self.docker.labels(kind, name) is not None:
                self.journal.add(event="refused", reason=f"{kind} {name} already exists")
                raise Refused(f"{kind} {name} already exists: not touched")
        if os.path.lexists(self.stage):
            self.journal.add(event="refused", reason="stage exists")
            raise Refused(f"stage {self.stage} already exists: not touched")
        self.journal.add(event="intent", resource="stage", name=str(self.stage))
        os.mkdir(self.stage, 0o700)          # exclusive: FileExistsError if someone raced us (then never deleted)
        self.journal.add(event="created", resource="stage", name=str(self.stage))

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

    # ---- cleanup --------------------------------------------------------------------------------------------
    def _terminate(self, pid, exe_prefix=None, start=None):
        """stop one process we identified: bind a pidfd, re-verify (starttime and/or exe inside the stage), TERM, then
        KILL. -> 'exited' | 'not-ours' ; raises Unknown"""
        def same():
            s = self.proc.start(pid)
            if s is None:
                return None
            if start is not None and s != start:
                return False
            if exe_prefix is not None:
                e = self.proc.exe(pid)
                if e is None:
                    return None
                if not e.startswith(exe_prefix):
                    return False
            return True
        v = same()
        if v is None:
            return "exited"
        if v is False:
            return "not-ours"
        try:
            fd = self.proc.pidfd_open(pid)
        except ProcessLookupError:
            return "exited"
        try:
            v = same()                       # through the bound pidfd from here on
            if v is None:
                return "exited"
            if v is False:
                return "not-ours"
            for sig, wait in ((signal.SIGTERM, self.term_wait), (signal.SIGKILL, self.kill_wait)):
                try:
                    self.proc.pidfd_signal(fd, sig)
                except ProcessLookupError:
                    return "exited"
                if self.proc.pidfd_wait(fd, wait):
                    return "exited"
            raise Unknown(f"pid {pid} still running after SIGKILL")
        finally:
            os.close(fd)

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

    def confirm_indexd_exited(self, pid_files):
        """our indexd: the identity pid files, then this run's own scope cgroup. -> report; raises Unknown"""
        rep = {"pidFiles": [], "cgroup": []}
        boot = self.proc.boot_id()
        for pf in pid_files:
            pf = Path(pf)
            if not os.path.lexists(pf):
                continue
            parts = pf.read_text().split()
            if len(parts) != 3 or not parts[0].isdigit():
                raise Unknown(f"unrecognized pid file {pf}")
            pid, start, b = int(parts[0]), parts[1], parts[2]
            if b != boot:
                rep["pidFiles"].append({"pid": pid, "outcome": "exited (other boot)"})
                continue
            rep["pidFiles"].append({"pid": pid, "outcome": self._terminate(pid, start=start)})
        if self.cgroup:
            procs = Path(self.cgroup) / "cgroup.procs"
            if os.path.exists(self.cgroup):
                try:
                    pids = [int(x) for x in procs.read_text().split()]
                except FileNotFoundError:
                    pids = []                 # the scope is gone: every process in it has exited
                except OSError as e:
                    raise Unknown(f"{procs}: {type(e).__name__}")
                prefix = str(self.stage) + "/"
                for pid in pids:
                    if pid == os.getpid():
                        continue
                    e = self.proc.exe(pid)
                    if e is not None and e.startswith(prefix):
                        rep["cgroup"].append({"pid": pid, "exe": e[len(prefix):], "outcome": self._terminate(pid, exe_prefix=prefix)})
        return rep

    def cleanup(self, pid_files=(), keep=()):
        """-> {"certain": bool, ...}. Acts only on what the journal says THIS run intended. keep: files in the stage to
        copy next to the journal first (results)."""
        rep, certain = {"runId": self.id}, True
        recs = self.journal.records()
        intended = {r["resource"] for r in recs if r.get("event") == "intent"}
        try:
            rep["children"] = self.stop_children()
        except Unknown as e:
            rep["children"], certain = f"UNKNOWN: {e}", False
        try:
            rep["indexd"] = self.confirm_indexd_exited(pid_files)
            indexd_ok = True
        except (Unknown, OSError) as e:
            rep["indexd"], indexd_ok, certain = f"UNKNOWN: {e}", False, False
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
        for k in keep:
            src = self.stage / k
            if src.is_file() and not src.is_symlink():
                shutil.copyfile(src, self.runs / f"{self.id}.{src.name}")
        if "stage" in intended:
            st = os.lstat(self.stage) if os.path.lexists(self.stage) else None
            if st is None:
                rep["stage"] = "absent"
            elif not stat.S_ISDIR(st.st_mode) or st.st_uid != os.getuid():
                rep["stage"], certain = "PRESERVED: not our directory", False
            elif not (certain and indexd_ok):
                rep["stage"] = f"KEPT for recovery: {self.stage}"
            else:
                shutil.rmtree(self.stage)
                rep["stage"] = "removed" if not os.path.lexists(self.stage) else "UNKNOWN: still present"
                certain = certain and not os.path.lexists(self.stage)
        rep["certain"] = certain
        self.journal.add(event="cleanup", report=rep)
        return rep


def recover(runs_dir, run_id, docker, proc=None):
    """re-run the cleanup of an interrupted run from its journal (e.g. after the runner was SIGKILLed)"""
    j = Journal(Path(runs_dir) / f"{run_id}.journal.jsonl", create=False)
    first = j.records()[0]
    assert first["event"] == "run" and first["runId"] == run_id
    r = Run(runs_dir, docker, proc, run_id=run_id, cgroup=first.get("cgroup"))
    r.journal = j
    pid_files = [r.stage / "node" / "state" / "indexd.pid"]
    return r.cleanup(pid_files=pid_files)
