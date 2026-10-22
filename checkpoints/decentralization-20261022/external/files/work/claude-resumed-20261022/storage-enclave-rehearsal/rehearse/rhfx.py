"""rhfx: resource ownership for one C2 production-capture REHEARSAL run (storage-enclave-rehearsal).

It REUSES the reviewed storage-enclave-fixture ownership module (fixture/c2fx.py, pinned below), imported read-only and
not copied. That module covers:
- the journal;
- the exclusive stage (inode + O_EXCL marker);
- labelled docker objects;
- PID files that never signal;
- the drain of the job's own queue scope, minus its exact ancestor chain;
- the never-PASS-on-uncertainty result.

The rehearsal differs from the fixture in two places only, both added here as a subclass:
- the PostgreSQL container: `--network none`, reached ONLY through its unix socket, bind-mounted from the stage (the
  fixture publishes 127.0.0.1:<ephemeral> instead);
- store-level tool containers: `docker run --rm`, sharing ONLY PostgreSQL's empty network namespace. Each has its own
  name enclave-c2fx-<id>-tool-<n>, carries the run label, and is journaled (intent before, outcome after).
  - After every run, answered or not, the name is re-inspected: absent means gone; still present WITH our label means
    it is removed and inspected again; anything else is UNKNOWN.
  - Cleanup repeats that for every journaled tool intent BEFORE c2fx's cleanup (PostgreSQL container, volume, stage).
    An unresolved tool container makes the run uncertain.
"""
import hashlib
import importlib.util
import os
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
WORK = next(p for p in HERE.parents if p.name == "work")
C2FX_PATH = WORK / "claude-resumed-20261022/storage-enclave-fixture/fixture/c2fx.py"
C2FX_SHA = "ff1b092c54135df64b506b1683fb48679f678f21e6ec5d28ef6fb54a66534ad6"     # root-accepted r3 (fixture run 32418fa137c5c05c)


def _load_c2fx():
    h = hashlib.sha256(C2FX_PATH.read_bytes()).hexdigest()
    if h != C2FX_SHA:
        raise RuntimeError(f"c2fx.py differs from the reviewed pin ({h})")
    sys.dont_write_bytecode = True
    sp = importlib.util.spec_from_file_location("c2fx", C2FX_PATH)
    m = importlib.util.module_from_spec(sp)
    sys.modules["c2fx"] = m
    sp.loader.exec_module(m)
    return m


c2fx = _load_c2fx()


class RehearsalRun(c2fx.Run):
    def __init__(self, *a, **k):
        super().__init__(*a, **k)
        self.tools = 0
        self._tools_unresolved = []

    def create_pg(self, env_file, sock, mem_mib=256):
        """the disposable PostgreSQL of the old rehearsal (same image, flags and socket), now with our name and label,
        --pull never (no download) and pid/cpu caps; NO network at all (--network none)"""
        self.journal.add(event="intent", resource="container", name=self.container)
        rc, out, err = self.docker.run(
            "run", "-d", "--pull", "never", "--name", self.container, "--label", f"{c2fx.LABEL}={self.id}",
            "--network", "none", "--memory", f"{mem_mib}m", "--memory-swap", f"{mem_mib}m", "--pids-limit", "256", "--cpus", "1",
            "--read-only", "--env-file", str(env_file), "--mount", f"type=volume,source={self.volume},target=/var/lib/postgresql",
            "--mount", f"type=bind,source={sock},target=/sock", "--tmpfs", "/var/run/postgresql:rw,size=16m", "--tmpfs", "/tmp:rw,size=64m",
            c2fx.IMAGE, "postgres", "-c", "listen_addresses=127.0.0.1", "-c", "unix_socket_directories=/var/run/postgresql,/sock",
            "-c", "shared_buffers=64MB", "-c", "max_connections=40", timeout=120)
        ours = self._ours("container", self.container)
        self.journal.add(event="created" if ours else "not-ours", resource="container", name=self.container, rc=rc)
        if not ours:
            raise c2fx.Refused(f"container {self.container}: not created with our label (rc {rc} {err.strip()[-160:]})")

    def _tool_gone(self, name):
        """-> True once the tool container is confirmed absent (removing it if it is still there WITH our label)"""
        lab = self.docker.labels("container", name)
        if lab is None:
            return True
        if lab.get(c2fx.LABEL) != self.id:
            return False                                  # not ours: never removed
        self.docker.run("rm", "-f", name, timeout=120)
        return self.docker.labels("container", name) is None

    def run_tool(self, binary, step, env_file, uid, gid, mem_mib=256, timeout=900):
        """one store-level tool step in its own labelled container sharing ONLY PostgreSQL's (empty) network namespace.
        -> (rc or None for a lost response, stdout, stderr). The container is confirmed gone before returning."""
        self.tools += 1
        name = f"{self.container}-tool-{self.tools}"
        self.journal.add(event="intent", resource="tool", name=name)
        rc, out, err = self.docker.run(
            "run", "--rm", "--pull", "never", "--name", name, "--label", f"{c2fx.LABEL}={self.id}",
            "--network", f"container:{self.container}", "--memory", f"{mem_mib}m", "--memory-swap", f"{mem_mib}m",
            "--pids-limit", "64", "--cpus", "1", "--read-only", "--user", f"{uid}:{gid}", "--env-file", str(env_file),
            "--mount", f"type=bind,source={binary},target=/tool,readonly=true", "--entrypoint", "/tool", c2fx.IMAGE, step, timeout=timeout)
        try:
            gone = self._tool_gone(name)
        except c2fx.Unknown:
            gone = False
        self.journal.add(event="tool-gone" if gone else "tool-uncertain", resource="tool", name=name, rc=rc)
        if not gone:
            raise c2fx.Unknown(f"tool container {name} not confirmed gone")
        return rc, out, err

    def cleanup_tools(self):
        recs = self.journal.records()
        names = [r["name"] for r in recs if r.get("resource") == "tool" and r.get("event") == "intent"]
        out, certain = {}, True
        for n in names:
            try:
                lab = self.docker.labels("container", n)
                if lab is None:
                    out[n] = "absent"
                elif lab.get(c2fx.LABEL) != self.id:
                    out[n], certain = "PRESERVED: exists without our label (not ours)", False
                else:
                    ok = self._tool_gone(n)
                    out[n] = "removed" if ok else "UNKNOWN: still exists after remove"
                    certain = certain and ok
            except c2fx.Unknown as e:
                out[n], certain = f"UNKNOWN: {e}", False
        return {"containers": out, "certain": certain}

    def stop_children(self):
        """c2fx calls this first in its cleanup: an unresolved tool container is raised HERE as Unknown, so c2fx's own
        rules mark the cleanup uncertain and KEEP the stage for recovery (c2fx itself is not modified)"""
        out = super().stop_children()
        if self._tools_unresolved:
            raise c2fx.Unknown(f"tool container(s) not confirmed gone: {self._tools_unresolved}")
        return out

    def cleanup(self, pid_files=(), keep=()):
        """tool containers first (they share PostgreSQL's namespace), then the reviewed c2fx cleanup; uncertain if either is"""
        tools = self.cleanup_tools()
        self.journal.add(event="cleanup-tools", report=tools)
        self._tools_unresolved = [n for n, v in tools["containers"].items() if v not in ("absent", "removed")]
        rep = super().cleanup(pid_files=pid_files, keep=keep)
        rep["toolContainers"] = tools
        rep["certain"] = rep["certain"] and tools["certain"]
        return rep


def recover(runs_dir, run_id, docker):
    """--recover: the reviewed c2fx recovery, with this run's tool containers resolved first"""
    j = c2fx.Journal(Path(runs_dir) / f"{run_id}.journal.jsonl", create=False)
    first = j.records()[0]
    if first.get("event") != "run" or first.get("runId") != run_id:
        raise c2fx.Unknown("journal does not start with this run's record")
    r = RehearsalRun(runs_dir, docker, run_id=run_id, scope=first.get("scope"))
    r.journal = j
    return r.cleanup(pid_files=[r.stage / "state" / "indexd.pid"])
