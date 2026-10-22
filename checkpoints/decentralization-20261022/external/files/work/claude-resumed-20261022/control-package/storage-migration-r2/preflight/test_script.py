#!/usr/bin/env python3
"""r2 vm-preflight.sh tests. Nothing touches a real VM, unit, container or path:
  - PATH stubs replace test, sha256sum, stat, ls, du, df, systemctl, docker and curl;
  - the script runs as EUID 0 inside an unprivileged user namespace (`unshare -r`), which grants no privilege on the host;
  - the stubs log every docker invocation, so the test checks that SQL carries PGOPTIONS and the inner timeout.
Timeout cases shrink T_* by sourcing the script (PREFLIGHT_SOURCE_ONLY=1) and then calling its unchanged main()."""
import hashlib, importlib.util, os, pathlib, re, shutil, subprocess, sys, tempfile, time, unittest
H = pathlib.Path(__file__).resolve().parent
SCRIPT = H / "vm-preflight.sh"
s = importlib.util.spec_from_file_location("ev2", H / "evaluate-preflight.py"); E = importlib.util.module_from_spec(s); s.loader.exec_module(E)
DUMP = "--\n-- PostgreSQL database dump\n--\n\\restrict abc\nSET statement_timeout = 0;\nCREATE TABLE public.objects (id bigint);\n\\unrestrict abc\n--\n-- PostgreSQL database dump complete\n--\n\n"
STUB = r'''#!/bin/bash
# stub: $0 name decides; MODE from $STUB_MODE; docker calls logged
n=$(basename "$0"); M=" $STUB_MODE "; L=$STUB_DIR/calls.log
has() { [[ $M == *" $1 "* ]]; }
case $n in
test) case "$1 $2" in
        "-L /opt/enclave-indexd/indexd"|"-d /opt/enclave-indexd/releases"|"-d /etc/systemd/system/enclave-indexd.service.d") exit 1;;
        "-e /etc/enclave-indexd/ALLOW_LIVE_START") has noallow && exit 1; exit 0;;
        "-e /var/lib/enclave-indexd/state/consensus.db") has noconsensus && exit 1; exit 0;;
        -e*) exit 0;; esac; exit 2;;
sha256sum) case $2 in
        /opt/enclave-indexd/indexd) echo "2d7a637e843500f7bd1864d76e1fa310e3163e57adc5d8c19e43598e827de5dc  $2";;
        */GeoLite2-City.mmdb) echo "18bf1695e85007dc1525e88bddd26d4f45b85550899bda8f8d1ebc1e804fc933  $2";;
        *) if [ -f "$2" ]; then /usr/bin/sha256sum -- "$2"; else echo "$(printf %s "$2" | /usr/bin/sha256sum | cut -c1-64)  $2"; fi;; esac;;
stat) case $4 in */indexd.yml) echo "600 enclave-indexd:enclave-indexd 980";; */consensus.db) echo 536870912;; *) exit 1;; esac;;
ls) exit 0;;
du) has hangdu && { trap '' TERM; sleep 1000; }; printf '561190789\t%s\n' "$3";;
df) has baddf && { printf 'Filesystem 1-blocks Used Available Capacity Mounted\n/dev/sda1 abc 1 abc 1%% /\n'; exit 0; }
    printf 'Filesystem 1-blocks Used Available Capacity Mounted on\n/dev/sda1 67645734912 4294967296 63350767616 7%% /\n';;
systemctl) case $4 in
        ExecStart) echo "{ path=/opt/enclave-indexd/indexd ; argv[]=/opt/enclave-indexd/indexd -instant ; ignore_errors=no ; start_time=[n/a] ; stop_time=[n/a] ; pid=0 ; code=(null) ; status=0/0 }";;
        ActiveState) echo active;; ExecMainStartTimestamp) echo "Mon 2026-10-19 15:30:00 UTC";; esac;;
curl) echo -n 404;;
docker)
  printf '%s\0' "$@" >> "$L"; printf '\n' >> "$L"
  has hangdocker && { trap '' TERM; sleep 1000; }
  [ "$1" = inspect ] && { case $3 in
        '{{.Image}}') echo sha256:74935e722416b3b2bd8e2fd1b4d6b8a3b1d5ef87a8d7b1f1a8b1c1d1e1f1a1b1;;
        '{{.Config.Image}}') echo postgres@sha256:74935e72241653ca55e0414067e6d8763aceb8a810eb51b452253ec3dcfc4336;;
        '{{.State.Running}}') echo true;; esac; exit 0; }
  [ "$1" = exec ] || exit 2
  shift; opts=; [ "$1" = -i ] && shift; while [ "$1" = -e ]; do opts="$opts $2"; shift 2; done; shift   # drop container name
  cmd=$3
  case $cmd in 'command -v timeout') has noinner && exit 1; echo /usr/bin/timeout; exit 0;; esac
  [[ $opts =~ PGOPTIONS=-c\ default_transaction_read_only=on\ -c\ statement_timeout=(5000|30000)\ -c\ lock_timeout=1000\ -c\ idle_in_transaction_session_timeout=(5000|30000) ]] || { echo "stub: PGOPTIONS missing" >&2; exit 99; }
  if [[ $cmd == *"-f -"* ]]; then
    [[ $opts == *statement_timeout=30000* && $cmd == "exec timeout -k 2 \"\$1\" psql"* ]] || exit 97
    grep -c '^SELECT ' > /dev/null      # consume the digest.sql on stdin
    has baddigest && { echo "objects|1491|not-an-md5"; exit 0; }
    for t in db_version accounts objects object_slabs object_events slabs slab_sectors account_slabs sharing_keys shared_objects blocked_objects contracts hosts; do
      [ $t = db_version ] && echo "db_version|26|" || { has shortdigest && [ $t = hosts ] && continue; echo "$t|5|0123456789abcdef0123456789abcdef"; }
    done; exit 0
  fi
  if [[ $cmd == *pg_dump* ]]; then
    has hangdump && { trap '' TERM; sleep 1000; }
    has emptydump && exit 0
    has faildump && { printf -- '--\n-- PostgreSQL database dump\n--\nCREATE TABLE x' ; echo 'pg_dump: error: query failed: lock timeout' >&2; exit 1; }
    has truncdump && { printf -- '--\n-- PostgreSQL database dump\n--\nCREATE TABLE public.objects (id bigint);\n'; exit 0; }
    printf %s "$DUMP"; exit 0
  fi
  sql=${@: -1}
  has hangsql && [[ $sql == "SHOW server_version" ]] && { trap '' TERM; sleep 1000; }
  case $sql in
    'SHOW default_transaction_read_only') echo on;; 'SHOW statement_timeout') echo 5s;; 'SHOW lock_timeout') echo 1s;;
    'SHOW server_version') echo "18.6 (Debian 18.6-1.pgdg13+1)";; 'SHOW fsync') echo on;; 'SHOW synchronous_commit') echo on;;
    'SELECT db_version FROM global_settings') has tworows && echo 26; echo 26;;
    'SELECT pg_database_size(current_database())') echo 29832895;;
    *'FROM objects LIMIT 100001'*) echo 1491;; *'FROM slabs LIMIT'*) echo 559;; *'FROM contracts LIMIT'*) echo 71;; *'FROM accounts LIMIT'*) echo 1;;
    *information_schema.tables*) echo 33;; *convalidated*|*indisvalid*|*information_schema.columns*) echo 0;;
    *) echo "stub: unexpected SQL $sql" >&2; exit 98;; esac;;
esac
'''
STUBS = ["test", "sha256sum", "stat", "ls", "du", "df", "systemctl", "docker", "curl"]

class Script(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.d = pathlib.Path(tempfile.mkdtemp(prefix="pf-r2-")); (cls.d / "bin").mkdir()
        for n in STUBS:
            p = cls.d / "bin" / n; p.write_text(STUB); p.chmod(0o755)
    @classmethod
    def tearDownClass(cls): shutil.rmtree(cls.d)
    def run_pf(self, mode="", shrink=None, userns=True, timeout=120, argv=None):
        log = self.d / "calls.log"
        if log.exists(): log.unlink()
        env = {"PATH": f"{self.d}/bin:/usr/bin:/bin", "STUB_MODE": mode, "STUB_DIR": str(self.d), "DUMP": DUMP}
        if argv is not None: pass
        elif shrink is None: argv = ["bash", str(SCRIPT)]
        else:
            env["PREFLIGHT_SOURCE_ONLY"] = "1"
            argv = ["bash", "-c", f'. "$0"; {shrink}; SECONDS=0; main', str(SCRIPT)]
        if userns: argv = ["unshare", "-r"] + argv
        t0 = time.monotonic(); p = subprocess.run(argv, env=env, capture_output=True, timeout=timeout, text=True)
        calls = [c.split("\0")[:-1] for c in log.read_text().split("\n") if c] if log.exists() else []
        return p, E.parse(p.stdout), time.monotonic() - t0, calls

    def test_static_every_external_command_bounded(self):
        src = SCRIPT.read_text()
        body = src[src.index("# readers"):src.index("main() {")]
        code = "\n".join(l for l in body.splitlines() if not l.lstrip().startswith("#"))
        hits = re.findall(r"(?:^|[|;&(]|\bthen|\belse|\{)\s*(docker|systemctl|sha256sum|stat|ls|du|df|curl|python3|test|psql|pg_dump)\b", code, re.M)
        self.assertEqual(hits, [], "an external command runs without T (timeout -k)")
        self.assertNotIn("2>/dev/null", src, "r2 must not silence stderr")
        self.assertNotRegex(src, r"\b(start|stop|restart|reload|kill|enable|disable|mask)\b\s+\"?\$?\{?UNIT", "no unit actions")
        for w in ("INSERT", "UPDATE ", "DELETE", "DROP", "ALTER", "TRUNCATE", "COPY ", "md5(", "string_agg", "digest.sql", "/dev/stdin", "-f -"):
            self.assertNotIn(w, src, w)

    def test_hasher_matches_r1_method_and_refuses_bad_dumps(self):
        hasher = subprocess.run(["bash", "-c", '. "$0"; printf %s "$HASHER"', str(SCRIPT)], env={"PREFLIGHT_SOURCE_ONLY": "1", "PATH": "/usr/bin:/bin"}, capture_output=True, text=True).stdout
        r1 = 'import sys,hashlib; t="\\n".join(l for l in sys.stdin.read().splitlines() if not l.startswith("--") and "\\\\restrict" not in l and "\\\\unrestrict" not in l); print(hashlib.sha256(t.encode()).hexdigest())'
        h = lambda code, data: subprocess.run([sys.executable, "-c", code], input=data, capture_output=True, text=True)
        a, b = h(hasher, DUMP), h(r1, DUMP)
        self.assertEqual(a.returncode, 0); self.assertEqual(a.stdout, b.stdout)
        self.assertEqual(a.stdout.strip(), hashlib.sha256(b"SET statement_timeout = 0;\nCREATE TABLE public.objects (id bigint);\n").hexdigest())
        self.assertEqual(h(r1, "").stdout.strip(), hashlib.sha256(b"").hexdigest(), "r1 hashed an empty dump (root's finding)")
        for bad in ["", "\n", DUMP.replace("dump complete", "dump"), "--\n-- PostgreSQL database dump complete\n--\n"]:
            r = h(hasher, bad); self.assertNotEqual(r.returncode, 0, bad); self.assertEqual(r.stdout, "")

    def test_green_run(self):
        p, (kv, errs), dt, calls = self.run_pf()
        self.assertEqual(p.returncode, 0, p.stderr); self.assertEqual(errs, [], p.stdout)
        r = E.evaluate(kv, errs)
        # the stub dump is not the production schema: exactly that one pin blocks, nothing is unknown
        self.assertEqual(r["verdict"], "BLOCKED", r); self.assertEqual(len(r["blockers"]), 1, r); self.assertIn("db.schema_sha256", r["blockers"][0]); self.assertEqual(r["unknown"], [], r)
        self.assertEqual(kv["db.schema_sha256"], hashlib.sha256(b"SET statement_timeout = 0;\nCREATE TABLE public.objects (id bigint);\n").hexdigest())
        # schema pin swapped for the stub dump's hash -> READY: the script's output shape is what the evaluator consumes
        E2 = dict(E.EXPECT); E.EXPECT["db.schema_sha256"] = kv["db.schema_sha256"]
        try: self.assertEqual(E.evaluate(kv, errs)["verdict"], "READY_FOR_FRESH_BACKUP")
        finally: E.EXPECT.clear(); E.EXPECT.update(E2)
        sql = [c for c in calls if c[0] == "exec" and "PGOPTIONS" in " ".join(c)]
        self.assertEqual(len(sql), 17, calls)   # 16 single-statement psql sessions + 1 pg_dump
        for c in sql:
            self.assertTrue(any(x.startswith("PGOPTIONS=-c default_transaction_read_only=on -c statement_timeout=5000 -c lock_timeout=1000") for x in c), c)
            self.assertIn("exec timeout -k 2 ", c[c.index("sh") + 2], c)
        self.assertNotIn("-i", [x for c in calls for x in c[:2]], "nothing is fed to the container on stdin")
        self.assertLess(dt, 30)

    def test_not_root_refuses(self):
        p, (kv, errs), _, calls = self.run_pf(userns=False)
        self.assertEqual(p.returncode, 2); self.assertEqual(kv.get("preflight.error"), "not-root"); self.assertEqual(calls, [])
        self.assertEqual(E.evaluate(kv, errs)["verdict"], "UNKNOWN")

    def test_dump_failures_never_hash(self):
        for mode, st in [("emptydump", "rc:1"), ("faildump", "rc:1"), ("truncdump", "rc:1")]:
            with self.subTest(mode=mode):
                p, (kv, errs), _, _ = self.run_pf(mode)
                self.assertEqual(kv["db.schema_sha256"], ""); self.assertEqual(kv["db.schema_sha256.status"], st)
                # the first stderr line is kept: pg_dump's own error, or the hasher's refusal when pg_dump "succeeded"
                self.assertIn("pg_dump: error" if mode == "faildump" else "nothing hashed", kv.get("db.schema_sha256.err", ""), kv)
                r = E.evaluate(kv, errs); self.assertEqual(r["verdict"], "UNKNOWN", r)

    def test_no_inner_timeout_skips_pg_dump_only(self):
        p, (kv, errs), _, calls = self.run_pf("noinner")
        self.assertEqual(kv["pg.inner_timeout.status"], "rc:1"); self.assertEqual(kv["db.schema_sha256.status"], "skipped:no-inner-timeout")
        self.assertEqual(kv["db.version"], "26")    # psql is still bounded server-side by statement_timeout
        self.assertFalse(any("pg_dump" in " ".join(c) for c in calls))
        self.assertTrue(all("exec psql" in c[c.index("sh") + 2] for c in calls if "PGOPTIONS" in " ".join(c)))
        self.assertEqual(E.evaluate(kv, errs)["verdict"], "UNKNOWN")

    def test_hung_docker_is_killed_and_sql_short_circuits(self):
        # stubs ignore SIGTERM: only timeout's -k SIGKILL ends them; after the first SQL timeout no more SQL is sent
        p, (kv, errs), dt, calls = self.run_pf("hangdocker", shrink="T_META=1 T_SQL=1 T_DUMP=1 KILL=1")
        self.assertEqual(errs, [], p.stdout)
        for k in ("pg.container_image", "pg.running", "pg.inner_timeout", "pg.session.default_transaction_read_only"):
            self.assertEqual(kv[f"{k}.status"], "timeout", k); self.assertEqual(kv[k], "")
        self.assertEqual(kv["pg.server_version.status"], "skipped:sql-degraded"); self.assertEqual(kv["db.schema_sha256.status"], "skipped:sql-degraded")
        self.assertEqual(sum(1 for c in calls if "PGOPTIONS" in " ".join(c)), 1, calls)
        self.assertLess(dt, 4 * 2 + 2 + 10, "4 docker facts x (T+KILL) + 1 SQL x (T+KILL) + slack")
        self.assertEqual(E.evaluate(kv, errs)["verdict"], "UNKNOWN")

    def test_hung_sql_and_dump(self):
        p, (kv, errs), _, _ = self.run_pf("hangsql", shrink="T_SQL=1 KILL=1")
        self.assertEqual(kv["pg.server_version.status"], "timeout"); self.assertEqual(kv["pg.fsync.status"], "skipped:sql-degraded")
        self.assertEqual(kv["pg.session.lock_timeout.status"], "ok")
        p, (kv, errs), _, _ = self.run_pf("hangdump", shrink="T_DUMP=1 KILL=1")
        self.assertIn(kv["db.schema_sha256.status"], ("timeout", "rc:1")); self.assertEqual(kv["db.schema_sha256"], "")
        self.assertEqual(E.evaluate(kv, errs)["verdict"], "UNKNOWN")

    def test_walltime_budget(self):
        p, (kv, errs), dt, _ = self.run_pf("hangdu", shrink="T_META=1 T_HASH=1 T_SQL=1 T_DUMP=1 T_DU=2 KILL=1 BUDGET=4")
        self.assertEqual(kv["state.du_bytes.status"], "timeout")
        skipped = [k for k in kv if k.endswith(".status") and kv[k] == "skipped:walltime-budget"]
        self.assertIn("app.fence_status.status", skipped); self.assertIn("db.version.status", skipped)
        self.assertEqual(kv["preflight.complete"], "yes"); self.assertLess(dt, 4 + 3)
        self.assertEqual(E.evaluate(kv, errs)["verdict"], "UNKNOWN")

    def test_malformed_reads(self):
        p, (kv, errs), _, _ = self.run_pf("tworows baddf noconsensus noallow")
        self.assertEqual(kv["db.version.status"], "malformed:multiline"); self.assertEqual(kv["db.version"], "")
        self.assertEqual(kv["disk.var_lib_free_bytes"], "abc")      # status ok: the value is the evaluator's to reject
        self.assertEqual(kv["state.consensus_bytes"], "absent"); self.assertEqual(kv["allow_live_start"], "absent")
        r = E.evaluate(kv, errs); self.assertEqual(r["verdict"], "BLOCKED", r)
        self.assertTrue(any("disk.var_lib_free_bytes = 'abc'" in u for u in r["unknown"]), r)
        self.assertTrue(any("consensus.db absent" in b for b in r["blockers"]), r)

    DIGEST_SQL = H.parent.parent / "storage-migration" / "controller-profile" / "migration" / "digest.sql"   # r1, read-only
    def digest(self, *args, mode="", userns=True):
        p, _, _, calls = self.run_pf(mode, userns=userns, argv=["bash", str(H / "vm-digest-optin.sh"), *args])
        kv = dict(l.partition("=")[::2] for l in p.stdout.splitlines())
        return p, kv, E.evaluate_digest(p.stdout), calls
    def test_digest_optin(self):
        ok = ["--full-data-digest", "--max-db-bytes", "100000000", str(self.DIGEST_SQL)]
        p, kv, r, calls = self.digest(*ok)
        self.assertEqual((p.returncode, r["verdict"]), (0, "COMPLETE"), (p.stdout, p.stderr, r)); self.assertEqual(kv["digest.objects"], "5|0123456789abcdef0123456789abcdef")
        self.assertTrue(any("-i" in c and "statement_timeout=30000" in " ".join(c) for c in calls), calls)
        for args, mode, want in [(ok[:3], "", "usage"), (["--full-data-digest", "--max-db-bytes", "-1", ok[3]], "", "usage"), (["--max-db-bytes", "1", "--full-data-digest", ok[3]], "", "usage"),
                                 (ok[:3] + [str(SCRIPT)], "", "refused:digest-sql-not-pinned"), (ok[:2] + ["1000", ok[3]], "", "refused:db-size-above-max"),
                                 (ok, "noinner", "refused:no-inner-timeout"), (ok, "baddigest", "malformed:line"), (ok, "shortdigest", "malformed:12-lines")]:
            with self.subTest(args=args[:3], mode=mode):
                p, kv, r, calls = self.digest(*args, mode=mode)
                self.assertNotEqual(p.returncode, 0); self.assertEqual(r["verdict"], "UNKNOWN")
                self.assertIn(want, kv.get("digest.status", "") + kv.get("digest.error", ""), p.stdout)
                self.assertFalse([k for k in kv if k.startswith("digest.") and "|" in kv[k]], "no digest rows on refusal")
                if want != "malformed:line" and want != "malformed:12-lines": self.assertFalse(any("-i" in c for c in calls), "the data digest never ran")
        p, kv, r, calls = self.digest(*ok, userns=False)
        self.assertEqual(kv.get("digest.error"), "not-root"); self.assertEqual(calls, [])

if __name__ == "__main__": unittest.main()
