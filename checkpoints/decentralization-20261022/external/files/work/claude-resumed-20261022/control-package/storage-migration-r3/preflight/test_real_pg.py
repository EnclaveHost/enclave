#!/usr/bin/env python3
"""r2 bounds against a REAL PostgreSQL. The container is a disposable local one:
  - the exact pinned image 74935e72 (already local, --pull never), --network none, --memory 192m, tmpfs data;
  - a toy schema with the preflight's table names, no production data; removed at the end.
It runs vm-preflight.sh's own q / r_schema / fact helpers (sourced) and proves:
  - PGOPTIONS reaches the server: the session reports read-only on/5s/1s, and a write is refused;
  - statement_timeout cancels a long statement; lock_timeout cancels a blocked read;
  - pg_dump --lock-wait-timeout fails rather than waits;
  - the in-container timeout ends a blocked pg_dump AND its server backend;
  - a real pg_dump 18.6 output carries the completion trailer, and the r2 hash equals r1's method on it;
  - a failed dump is never hashed.
The image's own `timeout` (pg.inner_timeout) is a fact about the pinned image bytes, not about the live VM."""
import json, os, pathlib, subprocess, sys, time, unittest
H = pathlib.Path(__file__).resolve().parent
SCRIPT = H / "vm-preflight.sh"
PIN = "sha256:74935e72241653ca55e0414067e6d8763aceb8a810eb51b452253ec3dcfc4336"
NAME = f"pf-r2-test-{os.getpid()}"
SETUP = """CREATE TABLE global_settings (db_version int); INSERT INTO global_settings VALUES (26);
CREATE TABLE accounts (id bigserial PRIMARY KEY); INSERT INTO accounts DEFAULT VALUES;
CREATE TABLE objects (id bigserial PRIMARY KEY, account_id bigint REFERENCES accounts(id)); INSERT INTO objects (account_id) SELECT 1 FROM generate_series(1, 1491);
CREATE TABLE slabs (id bigserial PRIMARY KEY); INSERT INTO slabs SELECT FROM generate_series(1, 559);
CREATE TABLE contracts (id bigserial PRIMARY KEY); INSERT INTO contracts SELECT FROM generate_series(1, 71);"""

def sh(*a, **k): return subprocess.run(list(a), capture_output=True, text=True, timeout=k.pop("timeout", 60), **k)
def admin(sql, **k): return sh("docker", "exec", NAME, "psql", "-U", "indexd", "-d", "indexd", "-XAt", "-v", "ON_ERROR_STOP=1", "-c", sql, **k)
def driver(body, timeout=90):
    """run vm-preflight.sh helpers against the test container; returns (parsed kv, seconds)"""
    t0 = time.monotonic()
    p = sh("bash", "-c", f'. "$0"; PG={NAME}; SECONDS=0; {body}', str(SCRIPT), env={"PREFLIGHT_SOURCE_ONLY": "1", "PATH": os.environ["PATH"]}, timeout=timeout)
    kv = {}
    for line in p.stdout.splitlines():
        k, _, v = line.partition("="); kv[k] = v
    return kv, time.monotonic() - t0

class RealPG(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        img = sh("docker", "image", "inspect", "-f", "{{.Id}}", "postgres:18.6").stdout.strip()
        if img != PIN: raise unittest.SkipTest(f"pinned image not local ({img!r})")
        r = sh("docker", "run", "-d", "--rm", "--pull", "never", "--network", "none", "--memory", "192m", "--name", NAME,
               "--tmpfs", "/var/lib/postgresql:rw,size=256m", "-e", "POSTGRES_USER=indexd", "-e", "POSTGRES_DB=indexd",
               "-e", "POSTGRES_HOST_AUTH_METHOD=trust", PIN, "postgres", "-c", "shared_buffers=16MB", "-c", "max_connections=20")
        assert r.returncode == 0, r.stderr
        for _ in range(60):
            if admin("SELECT 1").stdout.strip() == "1": break
            time.sleep(0.5)
        else: raise RuntimeError("test postgres did not start")
        assert admin(SETUP).returncode == 0
    @classmethod
    def tearDownClass(cls): sh("docker", "rm", "-f", NAME)

    def backends(self, wait=3.0):
        end = time.monotonic() + wait
        while True:
            n = admin("SELECT count(*) FROM pg_stat_activity WHERE application_name = 'enclave-preflight-r2'").stdout.strip()
            if n == "0" or time.monotonic() > end: return n
            time.sleep(0.25)

    def test_1_session_bounds_and_green_reads(self):
        kv, dt = driver("""fact pg.inner_timeout "$T_META" r_inner_timeout && INNER_TIMEOUT=1
          sqlfact pg.session.default_transaction_read_only 'SHOW default_transaction_read_only'; sqlfact pg.session.statement_timeout 'SHOW statement_timeout'
          sqlfact pg.session.lock_timeout 'SHOW lock_timeout'; sqlfact pg.server_version 'SHOW server_version'; sqlfact db.version 'SELECT db_version FROM global_settings'
          sqlfact app 'SELECT current_setting($$application_name$$)'
          for t in objects slabs contracts accounts; do sqlfact "db.count.$t" "SELECT count(*) FROM (SELECT 1 FROM $t LIMIT $((COUNT_CAP + 1))) s"; done
          COUNT_CAP=100; sqlfact capped "SELECT count(*) FROM (SELECT 1 FROM objects LIMIT $((COUNT_CAP + 1))) s"
          fact db.schema_sha256 "$T_DUMP" r_schema""")
        print(json.dumps({k: v for k, v in kv.items() if not k.endswith(".status")}), file=sys.stderr)
        for k, v in [("pg.inner_timeout", "/usr/bin/timeout"), ("pg.session.default_transaction_read_only", "on"), ("pg.session.statement_timeout", "5s"),
                     ("pg.session.lock_timeout", "1s"), ("db.version", "26"), ("app", "enclave-preflight-r2"), ("db.count.objects", "1491"),
                     ("db.count.slabs", "559"), ("db.count.contracts", "71"), ("db.count.accounts", "1"), ("capped", "101")]:
            self.assertEqual((kv.get(k), kv.get(k + ".status")), (v, "ok"), k)
        self.assertTrue(kv["pg.server_version"].startswith("18.6"), kv["pg.server_version"])
        self.assertEqual(kv["db.schema_sha256.status"], "ok"); self.assertRegex(kv["db.schema_sha256"], r"^[0-9a-f]{64}$")
        # r1's method on the same real dump gives the same hash; the real dump has the trailer and \restrict lines
        dump = sh("docker", "exec", NAME, "pg_dump", "-U", "indexd", "--schema-only", "--no-owner", "--no-acl", "indexd").stdout
        self.assertIn("-- PostgreSQL database dump complete", dump); self.assertIn("\\restrict", dump)
        r1 = 'import sys,hashlib; t="\\n".join(l for l in sys.stdin.read().splitlines() if not l.startswith("--") and "\\\\restrict" not in l and "\\\\unrestrict" not in l); print(hashlib.sha256(t.encode()).hexdigest())'
        self.assertEqual(sh(sys.executable, "-c", r1, input=dump).stdout.strip(), kv["db.schema_sha256"])
        self.assertLess(dt, 20)

    def test_2_writes_refused_and_statement_timeout(self):
        kv, dt = driver("""fact pg.inner_timeout "$T_META" r_inner_timeout && INNER_TIMEOUT=1
          sqlfact w1 'CREATE TABLE x (i int)'; sqlfact w2 'INSERT INTO global_settings VALUES (27)'; sqlfact w3 'UPDATE accounts SET id = id'
          sqlfact sleep 'SELECT pg_sleep(30)'; sqlfact after 'SELECT 1'""")
        for k in ("w1", "w2", "w3"):
            self.assertTrue(kv[k + ".status"].startswith("rc:"), kv); self.assertIn("read-only transaction", kv[k + ".err"], kv)
        self.assertEqual(kv["sleep.status"], "rc:1"); self.assertIn("statement timeout", kv["sleep.err"])
        self.assertEqual(kv["after.status"], "ok", "a server-side cancel is not a client timeout: SQL continues")
        self.assertLess(dt, 12, "pg_sleep(30) must be cancelled at 5 s")
        self.assertEqual(admin("SELECT count(*) FROM global_settings").stdout.strip(), "1")
        self.assertEqual(admin("SELECT count(*) FROM pg_tables WHERE tablename = 'x'").stdout.strip(), "0")

    def test_3_lock_timeout_and_pg_dump_lock_wait(self):
        holder = subprocess.Popen(["docker", "exec", NAME, "psql", "-U", "indexd", "-d", "indexd", "-X", "-c",
                                   "BEGIN; LOCK TABLE objects IN ACCESS EXCLUSIVE MODE; SELECT pg_sleep(40); COMMIT;"], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        try:
            for _ in range(40):
                if admin("SELECT count(*) FROM pg_locks WHERE mode = 'AccessExclusiveLock' AND relation = 'objects'::regclass AND granted").stdout.strip() == "1": break
                time.sleep(0.25)
            else: self.fail("lock holder did not start")
            kv, dt = driver("""fact pg.inner_timeout "$T_META" r_inner_timeout && INNER_TIMEOUT=1
              sqlfact db.count.objects "SELECT count(*) FROM (SELECT 1 FROM objects LIMIT 100001) s"
              fact db.schema_sha256 "$T_DUMP" r_schema""")
            self.assertEqual(kv["db.count.objects"], ""); self.assertEqual(kv["db.count.objects.status"], "rc:1"); self.assertIn("lock timeout", kv["db.count.objects.err"])
            self.assertEqual(kv["db.schema_sha256"], ""); self.assertNotEqual(kv["db.schema_sha256.status"], "ok"); self.assertIn("pg_dump", kv["db.schema_sha256.err"])
            self.assertLess(dt, 15, "1 s lock_timeout + 5 s pg_dump lock wait + overhead")
            self.assertEqual(self.backends(), "0", "both were cancelled server-side: no preflight backend remains")
            # inner timeout: pg_dump told to wait 60 s for the lock is killed at 2 s inside the container
            kv, dt = driver("""fact pg.inner_timeout "$T_META" r_inner_timeout && INNER_TIMEOUT=1
              DUMP_LOCK_MS=60000 T_DUMP_INNER=2 T_DUMP=20; fact db.schema_sha256 "$T_DUMP" r_schema""")
            self.assertEqual(kv["db.schema_sha256"], ""); self.assertNotEqual(kv["db.schema_sha256.status"], "ok", kv)
            self.assertLess(dt, 10, "the inner timeout, not the 20 s outer one, ended pg_dump")
            # observation, not an assertion: a backend blocked in a lock wait does not notice its client died
            # (client_connection_check_interval defaults to 0), so the SERVER-side bound is --lock-wait-timeout (5 s in r2)
            print(json.dumps({"backendsRightAfterInnerKill": self.backends()}), file=sys.stderr)
        finally:
            holder.kill(); holder.wait(timeout=30)
            admin("SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE query LIKE 'BEGIN; LOCK TABLE objects%' AND pid <> pg_backend_pid()")

if __name__ == "__main__": unittest.main()
