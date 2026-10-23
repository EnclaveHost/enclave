"""tools/cutover.py against REAL captures (tests/fixtures/README.md says which are real and which derived)."""
import copy, datetime, json, os, pathlib, re, sys, tempfile, unittest

HERE = os.path.dirname(os.path.abspath(__file__))
FX = os.path.join(HERE, "fixtures")
sys.path.insert(0, os.path.join(HERE, "..", "tools"))
import cutover as C  # noqa: E402

R0 = "http://127.0.0.1:39953"                       # run l1's indexer (the fixture's "existing primary")
NEW = [{"name": "store-a", "indexer": "https://storage-a.example.org"}, {"name": "store-b", "indexer": "https://storage-b.example.net:8443/api/"},
       {"name": "store-c", "indexer": "https://storage-c.example.com"}]
fx = lambda n: os.path.join(FX, n)
txt = lambda n: pathlib.Path(fx(n)).read_text()
load = lambda n: json.loads(txt(n))
NOW = datetime.datetime(2026, 10, 23, 6, 0, tzinfo=datetime.timezone.utc)


def inputs(primary=None, new=None, ref="$SIA_APP_KEY"):
    j = {"appKeyRef": ref, "primary": primary or {"name": "r0", "indexer": R0}, "new": NEW if new is None else new}
    f = tempfile.NamedTemporaryFile("w", suffix=".json", delete=False)
    json.dump(j, f); f.close()
    return f.name


class Replicas(unittest.TestCase):
    def test_stages_and_quorum(self):
        inp = C.load_inputs(inputs())
        t1, t2, t4a, t4b = (C.stage_replicas(inp, s) for s in ("t1", "t2", "t4a", "t4b"))
        self.assertEqual([r["name"] for r in t1], ["r0"]); self.assertEqual(C.write_quorum(t1), (1, 1))
        self.assertEqual([r["name"] for r in t2], ["r0", "store-a", "store-b", "store-c"]); self.assertEqual(C.write_quorum(t2), (4, 3))
        self.assertEqual([(r["name"], r.get("retiring", False)) for r in t4a], [("r0", True), ("store-a", False), ("store-b", False), ("store-c", False)])
        self.assertEqual(C.write_quorum(t4a), (3, 2), "the final set: W = 2 of N = 3")
        self.assertEqual([r["name"] for r in t4b], ["store-a", "store-b", "store-c"]); self.assertEqual(C.write_quorum(t4b), (3, 2))
        two = C.load_inputs(inputs(new=NEW[:2]))
        self.assertEqual(C.write_quorum(C.stage_replicas(two, "t2")), (3, 2), "interim 1 -> 3 keeps the primary a member")
        for st in ("t4a", "t4b"):
            with self.assertRaises(C.Refused) as cm:
                C.stage_replicas(two, st)
            self.assertIn("no write fault tolerance", str(cm.exception))
        self.assertTrue(all(r["appKey"] == "$SIA_APP_KEY" for r in t2), "the app key only by reference")
        self.assertEqual(t2[2]["indexer"], "https://storage-b.example.net:8443/api", "canonical: trailing slash dropped")
        self.assertEqual(C.canonical("HTTPS://Storage-A.Example.org.:443/")[0], "https://storage-a.example.org")

    def test_cli_prints_the_secret(self):
        import subprocess
        p = subprocess.run([sys.executable, "-B", os.path.join(HERE, "..", "tools", "cutover.py"), "replicas", "--stage", "t2", "--inputs", inputs()],
                           capture_output=True, text=True)
        self.assertEqual(p.returncode, 0, p.stderr)
        self.assertEqual(len(json.loads(p.stdout)), 4, "stdout is the secret value alone")
        self.assertEqual(json.loads(p.stderr), {"stage": "t2", "members": 4, "writeQuorum": 3})
        p = subprocess.run([sys.executable, "-B", os.path.join(HERE, "..", "tools", "cutover.py"), "replicas", "--stage", "t2",
                            "--inputs", inputs(new=[NEW[0], {"name": "x", "indexer": "https://sia.enclave.host"}])], capture_output=True, text=True)
        self.assertEqual(p.returncode, 1); self.assertEqual(json.loads(p.stdout)["verdict"], "REFUSED")

    def test_refusals(self):
        bad = [
            (dict(new=[{"name": "a", "indexer": "https://sia.enclave.host"}, NEW[1]]), "non-DigitalOcean ingress"),
            (dict(new=[{"name": "a", "indexer": "https://134.199.235.187"}, NEW[1]]), "non-DigitalOcean ingress"),
            (dict(new=[{"name": "a", "indexer": "http://storage-a.example.org"}, NEW[1]]), "https only"),
            (dict(new=[NEW[0], {"name": "b", "indexer": "https://STORAGE-A.example.org/"}]), "listed twice"),
            (dict(new=[{"name": "r0", "indexer": "https://x.example.org"}, NEW[1]]), "distinct"),
            (dict(new=[NEW[0], {"name": "store-a", "indexer": "https://c.example.org"}]), "distinct"),
            (dict(new=[NEW[0]]), "2 to 8 new replicas"),
            (dict(new=[NEW[0], {**NEW[1], "appKey": "00" * 32}]), "exactly {name, indexer}"),
            (dict(ref="11" * 32), "never the key itself"),
            (dict(new=[NEW[0], {"name": "b", "indexer": "https://u:p@b.example.org"}]), "without credentials"),
        ]
        for kw, msg in bad:
            with self.assertRaises(C.Refused, msg=kw) as cm:
                C.load_inputs(inputs(**kw))
            self.assertIn(msg, str(cm.exception))
        with self.assertRaises(C.Refused):
            C.stage_replicas(C.load_inputs(inputs()), "t3")


class Preflight(unittest.TestCase):
    """the REAL captures can never be GO (the positive path, with an authenticated v28 backup, is in
    backup/test/test_backup_provenance.py: runner -> pull_encrypt -> verify v2, no field edited)"""
    LIVE = {"objects": 1491, "accounts": 1}

    def test_the_real_pre_migration_state_is_no_go(self):
        r = C.t1_preflight(txt("vm-state-v26-real.out"), load("backup-receipt-v26-real.json"), NOW, "2026-10-22T19:10:00Z", self.LIVE)
        self.assertEqual(r["verdict"], "NO-GO")
        for want in ("current = 'NONE'", "dbVersion = '26'", "casEnrolledAccounts = None"):
            self.assertTrue(any(x.startswith(want) for x in r["reasons"]), (want, r["reasons"]))

    def test_the_real_v26_backup_receipt_is_not_a_pre_enrollment_backup(self):
        r = C.t1_preflight(txt("vm-state-v28-from-postcheck2.out"), load("backup-receipt-v26-real.json"), NOW, "2026-10-22T19:10:00Z", self.LIVE)
        self.assertEqual(r["verdict"], "NO-GO")
        for want in ("format None", "manifestBoundToRun is not true", "captureTimeAuthenticated is not true", "AFTER the v28 migration",
                     "is not the running release", "capturedAt None"):
            self.assertTrue(any(want in x for x in r["reasons"]), (want, r["reasons"]))


def barrier_state(text, **over):
    """the v28 vm-state.v2.sh lines behind the PROCESS barrier (R2-R3): start guard absent, indexd stopped, no session"""
    kv = {"unit.ActiveState": "inactive", "unit.SubState": "dead", "unit.MainPID": "0", "writerPids": "", "allowLiveStart": "absent", **over}
    lines = [l for l in text.splitlines() if l.split("=", 1)[0] not in kv]
    return "\n".join(lines + [f"{k}={v}" for k, v in kv.items()]) + "\n"


def barrier_out(**over):
    """a db-barrier.sh (db-barrier.v1) output behind the full barrier, never enrolled, after a graceful stop; `over` replaces
    a line, or drops it when the value is None (the order is the script's: pre, db, post)"""
    unit = {"ActiveState": "inactive", "SubState": "dead", "MainPID": "0", "Result": "success", "ExecMainCode": "1", "ExecMainStatus": "0",
            "InvocationID": "5f" * 16, "NRestarts": "0"}
    proc = lambda ph: {**{f"{ph}.unit.{k}": v for k, v in unit.items()}, f"{ph}.writerPids": "", f"{ph}.allowLiveStart": "absent"}
    kv = {"barrierScript": "db-barrier.v1", **proc("pre"), "db.lock": "granted", "db.lockWaitMs": "3", "db.otherBackends": "0",
          "db.otherBackendsDetail": "", "db.preparedXacts": "0", "db.dbVersion": "28", "db.fencedAccounts": "0", "db.casEnrolledAccounts": "0",
          "db.barrier": "complete", "db.exit": "0", **proc("post")}
    kv.update(over)
    return "".join(f"{k}={v}\n" for k, v in kv.items() if v is not None)


def git_module(commit, name):
    """tools/cutover.py exactly as committed at `commit` (the negative controls)"""
    import subprocess, importlib.util
    src = subprocess.run(["git", "-C", os.path.join(HERE, "..", ".."), "show", f"{commit}:package/tools/cutover.py"], capture_output=True, check=True).stdout
    with tempfile.NamedTemporaryFile("wb", suffix=".py", delete=False) as f:
        f.write(src)
    spec = importlib.util.spec_from_file_location(name, f.name); m = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)
    os.unlink(f.name)
    return m


# root's synthetic process-only snapshot (root-pg-drain-review 555dc752 probe.py), read while a COMMIT was still pending
ROOT_STATE = ("dbVersion=28\nunit.ActiveState=inactive\nunit.MainPID=0\nwriterPids=\nallowLiveStart=absent\nfencedAccounts=0\n"
              "casEnrolledAccounts=0\ncontrollerSessions=\ntoolSessions=\n")


class Rollback(unittest.TestCase):
    def test_original_6fd7a929_decides_from_an_unquiesced_zero_count(self):
        old = git_module("6fd7a9299c53121142ab59d8ff9a7406c1f2b845", "cutover_6fd7")
        running = txt("vm-state-v28-from-postcheck2.out")                       # indexd RUNNING, start guard unknown
        self.assertEqual(old.rollback_decision(running)["decision"], "LEGACY_REDEPLOY_SAFE", "the counterexample: observation alone authorized it")
        self.assertEqual(C.rollback_decision(running)["decision"], "UNKNOWN")
        self.assertEqual(C.rollback_decision(running, True)["decision"], "UNKNOWN", "an attestation without the barrier authorizes nothing")

    def test_fbaecfce_process_only_barrier_is_roots_counterexample(self):
        old = git_module("fbaecfced41da552a9e138082ecd0bd821c9e0f8", "cutover_fbae")
        for state in (ROOT_STATE, ROOT_STATE.replace("ActiveState=inactive", "ActiveState=failed"),
                      barrier_state(txt("vm-state-v28-from-postcheck2.out"))):
            self.assertEqual(old.rollback_decision(state, True)["decision"], "LEGACY_REDEPLOY_SAFE", "fbaecfce trusted the process barrier")
            for att in (False, True):
                d = C.rollback_decision(state, att)
                self.assertEqual((d["decision"], d["missing"]), ("UNKNOWN", ["databaseBarrier"]), state)
                self.assertTrue(any("db-barrier.sh" in x for x in d["steps"]))

    def test_legacy_redeploy_only_from_the_complete_database_barrier_with_the_attestation(self):
        d = C.rollback_decision(barrier_out(), True)
        self.assertEqual(d["decision"], "LEGACY_REDEPLOY_SAFE", d)
        self.assertTrue(any("C2 instance" in x for x in d["notEstablished"]))
        self.assertEqual(d["seen"]["stopKind"], "exited-0")
        self.assertEqual(C.rollback_decision(barrier_out(), False)["missing"], ["c2ActivationDisabledAttested"])

    def test_every_barrier_element_is_required(self):
        cases = {"pre.allowLiveStart": "present", "post.allowLiveStart": "present", "pre.unit.ActiveState": "active",
                 "post.unit.ActiveState": "activating", "post.unit.MainPID": "4242", "pre.writerPids": "4242", "post.writerPids": "4242 ",
                 "post.unit.InvocationID": "6e" * 16, "pre.unit.InvocationID": None, "post.unit.NRestarts": "1",
                 "db.lock": None, "db.otherBackends": "1", "db.preparedXacts": "1", "db.preparedXacts ": None, "db.barrier": None,
                 "db.exit": "3", "db.dbVersion": None, "db.casEnrolledAccounts": None, "db.fencedAccounts": "UNREADABLE",
                 "barrierScript": "db-barrier.v0"}
        for k, v in cases.items():
            d = C.rollback_decision(barrier_out(**{k.strip(): v}), True)
            self.assertEqual(d["decision"], "UNKNOWN", (k, v)); self.assertTrue(d["missing"], k); self.assertTrue(d["steps"], k)

    def test_a_failed_unit_or_an_exit_status_is_never_the_proof(self):
        killed = {f"{ph}.unit.{k}": v for ph in ("pre", "post") for k, v in
                  (("ActiveState", "failed"), ("SubState", "failed"), ("Result", "signal"), ("ExecMainCode", "2"), ("ExecMainStatus", "9"))}
        d = C.rollback_decision(barrier_out(**killed), True)
        self.assertEqual((d["decision"], d["seen"]["stopKind"]), ("LEGACY_REDEPLOY_SAFE", "abnormal"),
                         "after a KILL the database barrier, not the process, establishes the drain")
        graceful = barrier_state(txt("vm-state-v28-from-postcheck2.out"), **{"unit.Result": "success", "unit.ExecMainCode": "1", "unit.ExecMainStatus": "0"})
        self.assertEqual(C.rollback_decision(graceful, True)["missing"], ["databaseBarrier"], "an exit 0 without the database barrier proves nothing")
        self.assertEqual(C.stop_kind(C.parse_kv(barrier_out(**{"post.unit.ExecMainStatus": "2", "post.unit.Result": "exit-code"}))), "abnormal")

    def test_any_enrolment_is_forward_only_whatever_the_barrier(self):
        v28 = txt("vm-state-v28-from-postcheck2.out")
        for text in (v28.replace("casEnrolledAccounts=0", "casEnrolledAccounts=1"), v28.replace("fencedAccounts=0", "fencedAccounts=1"),
                     barrier_state(v28.replace("casEnrolledAccounts=0", "casEnrolledAccounts=1")),
                     barrier_out(**{"db.casEnrolledAccounts": "1", "db.fencedAccounts": "1"}),
                     barrier_out(**{"db.casEnrolledAccounts": "1", "db.fencedAccounts": "1", "db.otherBackends": "1", "post.allowLiveStart": "present"})):
            for att in (False, True):
                d = C.rollback_decision(text, att)
                self.assertEqual(d["decision"], "FORWARD_ONLY"); self.assertIn("NOT a routine rollback", d["do"])

    def test_unreadable_is_unknown(self):
        v28 = txt("vm-state-v28-from-postcheck2.out")
        for text in (txt("vm-state-v26-real.out"), barrier_state(v28).replace("casEnrolledAccounts=0\n", ""),
                     barrier_out(**{"db.casEnrolledAccounts": "UNREADABLE"}), barrier_out(**{"db.dbVersion": "27"}), ""):
            self.assertEqual(C.rollback_decision(text, True)["decision"], "UNKNOWN")

    def test_db_barrier_script(self):
        """the script root runs (package/primary/db-barrier.sh): lock BEFORE the session check BEFORE the counts, one transaction
        that is rolled back, every wait bounded, labelled NOT read-only, and nothing that ends a session or changes a setting"""
        s = pathlib.Path(HERE, "..", "primary", "db-barrier.sh").read_text()
        sql = s[s.index("<<'SQL'"):s.index("\nSQL\n")]
        order = ["BEGIN ISOLATION LEVEL READ COMMITTED;", "LOCK TABLE accounts IN EXCLUSIVE MODE;", "'lock=granted'", "FROM pg_stat_activity",
                 "FROM pg_prepared_xacts", "FROM global_settings", "WHERE fence IS NOT NULL", "WHERE cas_mode", "'barrier=complete'", "ROLLBACK;"]
        pos = [sql.index(x) for x in order]
        self.assertEqual(pos, sorted(pos), "the lock, then the sessions, then the counts, then ROLLBACK")
        self.assertEqual(sql.count("BEGIN"), 1)
        for bad in ("COMMIT", "pg_terminate_backend", "pg_cancel_backend", "ALTER", "INSERT", "UPDATE", "DELETE", "TRUNCATE", "SET SESSION", "pg_reload_conf"):
            self.assertIsNone(re.search(r"\b" + bad + r"\b", sql.upper()), bad)
        self.assertIn("NOT READ-ONLY", s)
        self.assertNotIn("default_transaction_read_only", s)
        for bound in ("lock_timeout=30000", "statement_timeout=35000", "transaction_timeout=60000", "idle_in_transaction_session_timeout=10000",
                      "client_connection_check_interval=1000", "timeout --foreground -s KILL 75", "timeout 90 docker exec"):
            self.assertIn(bound, s)
        self.assertLess(s.index("proc pre"), s.index("docker exec -i"))
        self.assertTrue(s.rstrip().endswith("proc post"), "the process barrier is read again AFTER the database step")
        self.assertIn('echo "barrierScript=' + C.BARRIER_SCRIPT + '"', s)


class DatabaseDrainCaptures(unittest.TestCase):
    """the REAL outputs of the actual scripts in fixture run d3 (tests/fixtures/README.md): actual indexd 2c0e5b06 and controller
    1543577f on a private PostgreSQL 18.6"""

    def test_d1_commit_after_the_kill_negative_control_and_the_barrier(self):
        old = git_module("fbaecfced41da552a9e138082ecd0bd821c9e0f8", "cutover_fbae_d1")
        vm = txt("d3-D1-vmstate.txt")                    # read while the killed indexd's COMMIT was still pending
        self.assertIn("unit.ActiveState=failed", vm); self.assertIn("casEnrolledAccounts=0", vm)
        self.assertEqual(old.rollback_decision(vm, True)["decision"], "LEGACY_REDEPLOY_SAFE", "fbaecfce on the actual indexd window")
        self.assertEqual(C.rollback_decision(vm, True)["missing"], ["databaseBarrier"])
        d = C.rollback_decision(txt("d3-D1-barrier.txt"), True)
        self.assertEqual(d["decision"], "FORWARD_ONLY")
        kv = C.parse_kv(txt("d3-D1-barrier.txt"))
        self.assertGreaterEqual(int(kv["db.lockWaitMs"]), 1000, "the lock waited for the pending COMMIT")
        self.assertEqual(C.stop_kind(kv), "abnormal")

    def test_never_enrolled_safe_only_with_the_attestation(self):
        out = txt("d3-N-barrier.txt")
        self.assertEqual(C.rollback_decision(out, False)["missing"], ["c2ActivationDisabledAttested"])
        d = C.rollback_decision(out, True)
        self.assertEqual((d["decision"], d["seen"]["stopKind"]), ("LEGACY_REDEPLOY_SAFE", "exited-0"))
        self.assertEqual(C.rollback_decision(txt("d3-N-vmstate.txt"), True)["missing"], ["databaseBarrier"], "vm-state alone is never enough")

    def test_failed_and_interrupted_barriers_are_unknown(self):
        self.assertEqual(C.rollback_decision(txt("d3-F1-barrier.txt"), True)["missing"], ["db.noOtherSession"])
        d = C.rollback_decision(txt("d3-F2-barrier.txt"), True)
        self.assertEqual(d["decision"], "UNKNOWN"); self.assertIn("db.lockGranted", d["missing"]); self.assertIn("lock timeout", d["seen"]["dbMessage"])
        d = C.rollback_decision(txt("d3-F3-barrier-interrupted.txt"), True)
        self.assertEqual(d["decision"], "UNKNOWN"); self.assertIn("db.complete", d["missing"])

    def test_enrolled_before_or_during_the_stop_is_forward_only(self):
        for n in ("d3-B-barrier.txt", "d3-D2-barrier.txt", "d3-D3-barrier.txt"):
            self.assertEqual(C.rollback_decision(txt(n), True)["decision"], "FORWARD_ONLY", n)


class VerifyT1(unittest.TestCase):
    def setUp(self):
        self.hz, self.fact = load("l1-healthz-claim1.json"), load("l1-fact-claim1.json")
        self.row, self.inp = txt("l1-account-row.txt"), C.load_inputs(inputs())

    def test_the_real_first_fenced_boot_passes(self):
        r = C.verify("t1", self.hz, self.fact, self.inp, self.row)
        self.assertEqual(r["verdict"], "PASS", r["reasons"])
        self.assertEqual((r["epoch"], r["writeQuorum"], r["members"]), (1, 1, 1))

    def test_failures(self):
        def fails(why, hz=None, fact=None, row="same", stage="t1"):
            r = C.verify(stage, hz or self.hz, fact or self.fact, self.inp, self.row if row == "same" else row)
            self.assertEqual(r["verdict"], "FAIL", why)
            return r
        fails("another claim of the same deployment", fact={**self.fact, "claimBlock": 52520000, "claimLogIndex": 0})
        fails("another deployment", fact={**self.fact, "deployment": "0x" + "ab" * 32})
        fails("the account not enrolled", row=self.row.replace("|t|t|", "|f|t|"))
        fails("no account row", row=None)
        h = copy.deepcopy(self.hz); h["writerFence"]["superseded"] = "a later claim"; fails("superseded", hz=h)
        h = copy.deepcopy(self.hz); h["writerFence"]["c2"]["noCloneAssumed"] = True; fails("a clone assumption", hz=h)
        h = copy.deepcopy(self.hz); h["writeQuorum"] = 2; fails("a writeQuorum that is not the majority", hz=h)
        h = copy.deepcopy(self.hz); h["replicas"][0]["membership"]["phase"] = "migrating"; fails("not yet stable", hz=h)
        h = copy.deepcopy(self.hz); h["replicas"][0]["behind"] = 3; fails("a member behind", hz=h)
        h = copy.deepcopy(self.hz); h["ready"] = False; fails("not ready", hz=h)
        fails("the t2 expectation on the t1 state", stage="t2", row=None)
        with self.assertRaises(C.Refused):
            C.verify("t1", self.hz, {**self.fact, "source": "lease17"}, self.inp, self.row)


class Pins(unittest.TestCase):
    """every pinned file, as it lies in this workspace, and a tampered staged copy"""
    TOOL = os.path.join(HERE, "..", "tools", "verify_pins.py")
    WORK = os.path.abspath(os.path.join(HERE, "..", "..", "..", "..", ".."))       # the directory that contains work/

    def run_tool(self, *args):
        import subprocess
        return subprocess.run([sys.executable, "-B", self.TOOL, *args], capture_output=True, text=True)

    def test_every_pin_matches_the_workspace(self):
        p = self.run_tool("--work", self.WORK)
        self.assertEqual(p.returncode, 0, p.stdout + p.stderr)
        self.assertGreaterEqual(p.stdout.count("OK  "), 19)

    def test_a_tampered_copy_fails(self):
        pins = json.loads(pathlib.Path(HERE, "..", "PINS.json").read_text())
        src = os.path.join(self.WORK, pins["files"]["client.catalogConfig.c2"]["path"])
        with tempfile.TemporaryDirectory() as d:
            good, bad = os.path.join(d, "good.json"), os.path.join(d, "bad.json")
            body = pathlib.Path(src).read_bytes()
            pathlib.Path(good).write_bytes(body); pathlib.Path(bad).write_bytes(body.replace(b'"egress":"public-web"', b'"egress":"public-webx"'))
            self.assertEqual(self.run_tool("--key", "client.catalogConfig.c2", "--file", good).returncode, 0)
            self.assertEqual(self.run_tool("--key", "client.catalogConfig.c2", "--file", bad).returncode, 1)
            self.assertEqual(self.run_tool("--key", "client.catalogConfig.prepared-REFUSED", "--file", good).returncode, 1, "the corrected config is not the refused one")
            self.assertEqual(self.run_tool("--key", "nope", "--file", good).returncode, 2)


class VerifyStaged(unittest.TestCase):
    """the REAL /healthz of rehearsal run m3 at each stage (FIXTURE backend: three loopback indexers)"""
    def setUp(self):
        self.hz, self.fact = load("m3-healthz.json"), load("m3-fact.json")
        ix = load("m3-indexers.json")
        self.inp = C.load_inputs(inputs(primary={"name": "r0", "indexer": ix[0]}, new=[{"name": "r1", "indexer": ix[1]}, {"name": "r2", "indexer": ix[2]}]), fixture_loopback=True)

    def test_each_stage_passes_and_no_stage_passes_as_another(self):
        for stage, label in (("t1", "T1"), ("t2", "T2"), ("t4a", "T4-retiring"), ("t4b", "T4-final")):
            row = txt("m3-account-row.txt") if stage == "t1" else None
            r = C.verify(stage, self.hz[label], self.fact, self.inp, row, min_final_members=2)    # fixture scale: 2 new replicas
            self.assertEqual(r["verdict"], "PASS", (stage, r["reasons"]))
        for stage, label in (("t2", "T1"), ("t4a", "T2"), ("t4b", "T4-retiring"), ("t2", "T4-final")):
            self.assertEqual(C.verify(stage, self.hz[label], self.fact, self.inp, None, min_final_members=2)["verdict"], "FAIL", (stage, label))


if __name__ == "__main__":
    unittest.main(verbosity=2)
