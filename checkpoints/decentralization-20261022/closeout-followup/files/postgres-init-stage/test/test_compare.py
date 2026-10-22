#!/usr/bin/env python3
"""compare.py on synthetic probe outputs: the accepted init and rollback cases, and one mutant per guarded property."""
import subprocess, sys, tempfile, unittest
from pathlib import Path
HERE = Path(__file__).resolve().parents[1]
BEFORE = """unit.sha256=e0a45f510d35181c02800f08a65d1b6da308dbc236ff4b495c11d9ba7d280012
unit.stat=644 root:root
unit.execStartInit=no
pgUnit.ActiveState=active
pgUnit.SubState=running
pgUnit.NeedDaemonReload=no
indexdUnit.ActiveState=inactive
docker.initBinary=docker-init
container.running=yes
container.image=postgres@sha256:74935e72241653ca55e0414067e6d8763aceb8a810eb51b452253ec3dcfc4336
container.imageId=sha256:74935e72241653ca55e0414067e6d8763aceb8a810eb51b452253ec3dcfc4336
container.init=<nil>
container.network=host
container.readOnly=true
container.memory=1073741824 2147483648
container.autoRemove=true
container.mounts=bind:/var/lib/enclave-indexd/postgres->/var/lib/postgresql:rw=true 
container.tmpfs=/tmp=rw,size=64m /var/run/postgresql=rw,size=16m 
container.entrypoint=["docker-entrypoint.sh"]
container.cmd=["postgres","-c","listen_addresses=127.0.0.1"]
container.envNames=GOSU_VERSION LANG PATH PGDATA POSTGRES_DB POSTGRES_PASSWORD 
pid1.comm=postgres
postmaster.pid=1
postmaster.comm=postgres
container.startupLine=database system was shut down at 2026-10-22 07:49:58 UTC
pg.serverVersion=18.6 (Debian 18.6-1.pgdg13+2)
pg.dataDirectory=/var/lib/postgresql/data
pg.systemIdentifier=7563000000000000001
pg.postmasterStart=2026-10-20 01:00:00+00
pg.fsync=on pg.synchronousCommit=on
pg.databases=indexd,postgres,template0,template1
pg.roles=postgres
pg.otherClientSessions=0
db.version=26
digest.accounts=3|aa
digest.slabs=562|bb
digest.contracts=78|cc
digest.rc=0
probe.complete=yes
"""
INIT = {"unit.sha256": "59b60ddd739d3ff5e27317faf794f4c25ce150acff38d2ec1a3de0322afdd183", "unit.execStartInit": "yes",
        "container.init": "true", "pid1.comm": "docker-init", "postmaster.pid": "7", "postmaster.comm": "postgres",
        "pg.postmasterStart": "2026-10-23 01:00:00+00", "wait.ready": "yes"}
ROLL = {"pg.postmasterStart": "2026-10-23 02:00:00+00", "wait.ready": "yes"}


def text(base, **over):
    d = dict(l.split("=", 1) for l in base.splitlines())
    d.update({k.replace("__", "."): v for k, v in over.items()})
    return "\n".join(f"{k}={v}" for k, v in d.items()) + "\n"


def run(before, after, mode):
    with tempfile.TemporaryDirectory() as t:
        Path(t, "b").write_text(before); Path(t, "a").write_text(after)
        return subprocess.run([sys.executable, "-B", str(HERE / "compare.py"), str(Path(t, "b")), str(Path(t, "a")), "--expect", mode],
                              capture_output=True, text=True).returncode


class Compare(unittest.TestCase):
    def test_accepts_init_and_rollback(self):
        self.assertEqual(run(BEFORE, text(BEFORE, **INIT), "init"), 0)
        self.assertEqual(run(BEFORE, text(BEFORE, **ROLL), "rollback"), 0)

    def test_each_guard_rejects(self):
        init_after = text(BEFORE, **INIT)
        mutants = {"pg.systemIdentifier": "1", "digest.slabs": "561|bb", "db.version": "27", "container.mounts": "volume:x->y",
                   "container.image": "postgres:latest", "container.network": "bridge", "container.memory": "0 0",
                   "container.envNames": "PATH", "pid1.comm": "postgres", "container.init": "<nil>",
                   "container.startupLine": "database system was interrupted", "pgUnit.NeedDaemonReload": "yes",
                   "pg.otherClientSessions": "1", "unit.sha256": "e0a45f510d35181c02800f08a65d1b6da308dbc236ff4b495c11d9ba7d280012",
                   "pg.postmasterStart": "2026-10-20 01:00:00+00", "wait.ready": "no", "digest.rc": "1", "indexdUnit.ActiveState": "active"}
        for k, v in mutants.items():
            with self.subTest(k):
                d = dict(l.split("=", 1) for l in init_after.splitlines()); d[k] = v
                self.assertEqual(run(BEFORE, "\n".join(f"{a}={b}" for a, b in d.items()) + "\n", "init"), 1, k)
        self.assertEqual(run(BEFORE, init_after, "rollback"), 1, "an --init state is not a rollback")
        self.assertEqual(run(text(BEFORE, **INIT), init_after, "init"), 1, "BEFORE must be the old-unit state")


if __name__ == "__main__":
    unittest.main(verbosity=2)
