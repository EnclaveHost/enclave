#!/usr/bin/env python3
"""test_ownership.py - LOCAL, MOCKED resource-ownership tests for the storage-enclave-fixture runner. No PostgreSQL, no docker
daemon (test/fake_docker.py only), no indexd.
- A copy of /usr/bin/bash running a sleep loop stands in for indexd ("fake indexd"), so /proc identity, pidfds and real
  signals are exercised on throwaway processes this test itself starts.
- ScopeDrain and Runner use the REAL scope of the shared-queue job this test runs in (run them only through
  work/claude-test-queue.py; outside a queue scope they SKIP, never drain).
- The "unrelated" process lives in its OWN transient systemd-run scope, so it is truly outside this job's scope.
- Every process a test starts is stopped by that test. Nothing outside the test's temp directories and its own processes is
  touched.
  python3 -u test/test_ownership.py -v"""
import importlib.util
import json
import os
import shutil
import signal
import subprocess
import sys
import tempfile
import time
import unittest
from pathlib import Path
from unittest.mock import patch

sys.dont_write_bytecode = True
HERE = Path(__file__).resolve().parent
PKG = HERE.parent
WO = next(p for p in PKG.parents if p.name == "work").parent
sys.path.insert(0, str(PKG / "fixture"))
import c2fx  # noqa: E402

FAKE = HERE / "fake_docker.py"
CTL = PKG / "controller" / "replicactl.py"
ROOT_RACE = WO / "work/root-c2-fixture-review-20261022/stage-race.py"
LOOP = "trap 'exit 0' TERM; while :; do sleep 0.2; done\n"
DEAF = "trap '' TERM; while :; do sleep 0.2; done\n"


def in_queue_scope():
    try:
        c2fx.queue_scope()
        return True, ""
    except (c2fx.Refused, c2fx.Unknown, OSError) as e:
        return False, str(e)


def load_runner():
    sp = importlib.util.spec_from_file_location("runner", PKG / "fixture" / "run-c2-fixture.py")
    m = importlib.util.module_from_spec(sp)
    sp.loader.exec_module(m)
    return m


class Fake:
    """an isolated fake docker: state + call log in a temp dir"""
    def __init__(self, d, fault=""):
        self.d = Path(d)
        self.state, self.log = self.d / "docker-state.json", self.d / "docker-log.jsonl"
        self.set_fault(fault)

    def set_fault(self, fault):
        os.environ.update(FAKEDOCKER_STATE=str(self.state), FAKEDOCKER_LOG=str(self.log), FAKEDOCKER_FAULT=fault)

    def st(self):
        return json.loads(self.state.read_text()) if self.state.exists() else {"containers": {}, "volumes": {}}

    def put(self, kind, name, labels):
        s = self.st()
        s["containers" if kind == "container" else "volumes"][name] = {"labels": labels, **({"volume": None} if kind == "container" else {})}
        self.state.write_text(json.dumps(s))

    def calls(self):
        return [json.loads(l) for l in self.log.read_text().splitlines()] if self.log.exists() else []


class _FakeDocker(c2fx.Docker):
    """the real c2fx.Docker driving fake_docker.py (via python3), optionally with a short timeout for lost responses"""
    def __init__(self, clamp=None):
        super().__init__(str(FAKE))
        self.clamp = clamp

    def run(self, *args, timeout=None, input=None):
        t = min(timeout or self.timeout, self.clamp) if self.clamp else timeout
        try:
            r = subprocess.run([sys.executable, str(FAKE), *args], capture_output=True, text=True, timeout=t or 120)
            return r.returncode, r.stdout, r.stderr
        except subprocess.TimeoutExpired:
            return None, "", "timeout"


def fake_scope(d):
    """a MOCK scope (an empty directory): for the docker/stage tests only; the drainage itself is tested on the real scope"""
    d = Path(d) / "run-p1-i1.scope"
    d.mkdir(exist_ok=True)
    return {"cgroup": str(d), "rel": "/mock/run-p1-i1.scope", "ino": os.stat(d).st_ino, "exempt": [], "memoryMax": 1}


def fake_indexd(stage, script=LOOP, via_controller=True, sha="ab" * 32):
    """install a bash copy as <stage>/node/releases/<sha>/indexd and start it (through the REAL controller by default)"""
    rel = stage / "node" / "releases"
    (rel / sha).mkdir(parents=True, exist_ok=True)
    shutil.copy("/usr/bin/bash", rel / sha / "indexd")
    if not (rel / "current").exists():
        (rel / "current").symlink_to(sha)
    state = stage / "node" / "state"
    state.mkdir(parents=True, exist_ok=True)
    prof = stage / "profile.json"
    prof.write_text(json.dumps({"runner": "process", "state_dir": str(state), "config_file": str(stage / "none.yml"),
                                "release_dir": str(rel), "gomemlimit": "64MiB"}))
    if via_controller:
        r = subprocess.run([sys.executable, str(CTL), "--profile", str(prof), "start"], input=script, capture_output=True, text=True, timeout=30)
        assert r.returncode == 0, r.stdout + r.stderr
        return int((state / "indexd.pid").read_text().split()[0]), prof
    p = subprocess.Popen([str(rel / sha / "indexd")], stdin=subprocess.PIPE, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                         start_new_session=True, text=True)
    p.stdin.write(script)
    p.stdin.close()
    return p, prof


def alive(pid):
    return c2fx.Proc().start(pid) is not None


def kill_hard(pid):
    try:
        os.kill(pid, signal.SIGKILL)   # test cleanup of a process THIS test started
    except ProcessLookupError:
        pass


def wait_for(fn, seconds=10):
    end = time.time() + seconds
    while time.time() < end:
        v = fn()
        if v:
            return v
        time.sleep(0.05)
    return fn()


OK_SCOPE, WHY = in_queue_scope()


def scope_extras():
    """members of this job's scope that are not on its ancestor chain (the test's own leftovers), [] outside a queue scope"""
    if not OK_SCOPE:
        return []
    try:
        c2fx.queue_scope()
        return []
    except c2fx.Refused as e:
        return [str(e)]


def unrelated_process(test):
    """a harmless process in its OWN transient systemd-run scope (outside this job's scope); returns (Popen, start, boot)"""
    p = subprocess.Popen(["systemd-run", "--user", "--scope", "--quiet", "-p", "MemoryMax=32M", "sleep", "120"],
                         stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    test.started.append(p)
    mine = c2fx.Proc().cgroup("self")
    test.assertTrue(wait_for(lambda: c2fx.Proc().cgroup(p.pid) not in (None, mine) and Path(f"/proc/{p.pid}/exe").resolve().name == "sleep", 10),
                    "precondition: the unrelated process is in another scope")
    return p, c2fx.Proc().start(p.pid), c2fx.Proc().boot_id()


class Base(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp(prefix="c2fx-t-"))
        self.runs = self.tmp / "runs"
        self.fake = Fake(self.tmp)
        self.started = []

    def tearDown(self):
        for x in self.started:
            pid = x.pid if hasattr(x, "pid") else x
            if alive(pid):
                kill_hard(pid)
            if hasattr(x, "wait"):
                x.wait(5)
        shutil.rmtree(self.tmp, ignore_errors=True)
        # a killed fake indexd (bash) leaves its current `sleep 0.2` child for up to 0.2 s: wait (bounded) until this job's
        # scope holds only its ancestor chain again; a real leak fails the test
        left = wait_for(lambda: not scope_extras(), 5)
        self.assertTrue(left, f"leftover processes in the job scope after the test: {scope_extras()}")

    def run_(self, clamp=None, scope="mock", **kw):
        if scope == "real" and not OK_SCOPE:
            self.skipTest(f"needs a shared-queue job scope: {WHY}")
        sc = fake_scope(self.tmp) if scope == "mock" else c2fx.queue_scope() if scope == "real" else scope
        r = c2fx.Run(self.runs, _FakeDocker(clamp), scope=sc, **kw)
        r.term_wait, r.kill_wait = 3, 3
        return r

    def mutating(self):
        return [c for c in self.fake.calls() if c[:1] in (["run"], ["rm"]) or c[:2] in (["volume", "create"], ["volume", "rm"])]


# ===================================================================== A. collisions: refuse before touching
class Collisions(Base):
    def test_preexisting_container_name_refused_before_any_create_and_never_removed(self):
        r = self.run_(run_id="0123456789abcdef")
        self.fake.put("container", r.container, {"someone": "else"})
        with self.assertRaises(c2fx.Refused):
            r.begin()
        self.assertFalse(r.stage.exists())
        rep = r.cleanup()
        self.assertEqual(self.mutating(), [], "no create/remove call at all")
        self.assertIn(r.container, self.fake.st()["containers"])
        self.assertEqual((rep["container"], rep["volume"]), ("never intended", "never intended"))

    def test_preexisting_volume_refused_and_kept(self):
        r = self.run_(run_id="1123456789abcdef")
        self.fake.put("volume", r.volume, {c2fx.LABEL: "1123456789abcdef"})   # even with OUR label: pre-existing = not ours
        with self.assertRaises(c2fx.Refused):
            r.begin()
        r.cleanup()
        self.assertEqual(self.mutating(), [])
        self.assertIn(r.volume, self.fake.st()["volumes"])

    def test_preexisting_stage_refused_and_untouched(self):
        r = self.run_(run_id="2123456789abcdef")
        self.runs.mkdir(mode=0o700)
        r.stage.mkdir()
        (r.stage / "other-run-file").write_text("keep")
        with self.assertRaises(c2fx.Refused):
            r.begin()
        rep = r.cleanup()
        self.assertEqual((r.stage / "other-run-file").read_text(), "keep")
        self.assertNotIn("stage", rep)

    def test_existing_journal_refused(self):
        r = self.run_(run_id="3123456789abcdef")
        self.runs.mkdir(mode=0o700)
        (self.runs / "3123456789abcdef.journal.jsonl").write_text("{}\n")
        with self.assertRaises(c2fx.Refused):
            r.begin()
        self.assertEqual((self.runs / "3123456789abcdef.journal.jsonl").read_text(), "{}\n")

    def test_volume_create_returning_a_foreign_volume_is_not_adopted_and_not_removed(self):
        r = self.run_()
        r.begin()
        self.fake.put("volume", r.volume, {})        # created by someone else between our check and our create
        with self.assertRaises(c2fx.Refused):
            r.create_volume()
        rep = r.cleanup()
        self.assertIn(r.volume, self.fake.st()["volumes"], "docker's idempotent create must not make it ours")
        self.assertTrue(rep["volume"].startswith("PRESERVED"))
        self.assertFalse(rep["certain"])
        self.assertTrue(r.stage.exists(), "uncertain: stage kept for recovery")

    def test_two_concurrent_runs_never_touch_each_other(self):
        a, b = self.run_(), self.run_()
        for r in (a, b):
            r.begin(); r.create_volume(); (r.stage / "pg.env").write_text("x"); r.create_container(r.stage / "pg.env")
        rb = b.cleanup()
        self.assertTrue(rb["certain"], rb)
        st = self.fake.st()
        self.assertIn(a.container, st["containers"]); self.assertIn(a.volume, st["volumes"]); self.assertTrue(a.stage.exists())
        self.assertNotIn(b.container, st["containers"]); self.assertFalse(b.stage.exists())
        self.assertTrue(a.cleanup()["certain"])
        self.assertEqual(self.fake.st(), {"containers": {}, "volumes": {}})

    def test_container_is_loopback_ephemeral_capped_offline(self):
        r = self.run_()
        r.begin(); r.create_volume(); (r.stage / "pg.env").write_text("x")
        self.assertEqual(r.create_container(r.stage / "pg.env"), 55999)
        args = self.fake.st()["containers"][r.container]["args"]
        for flag in (["--pull", "never"], ["-p", "127.0.0.1::5432"], ["--memory", "256m"], ["--memory-swap", "256m"], ["--read-only"]):
            i = args.index(flag[0]); self.assertEqual(args[i:i + len(flag)], flag)
        self.assertIn(c2fx.IMAGE, args)
        self.assertNotIn("0.0.0.0", " ".join(args))
        r.cleanup()

    def test_negative_control_old_script_trap_precedes_refusal_and_uses_fixed_names(self):
        old = (PKG / "ref/old-package/fixture/run-c2-fixture.sh").read_text()
        self.assertLess(old.index("trap cleanup EXIT"), old.index("stale secrets dir: refusing"), "the reviewed defect")
        self.assertIn('rm -rf "$here/secrets" "$here/node" "$here/seed-tree"', old)
        pg = (PKG / "ref/old-package/fixture/pg-fixture.sh").read_text()
        self.assertIn("name=enclave-c2-fixture-pg vol=enclave-c2-fixture-pgdata", pg)
        new = (PKG / "fixture/run-c2-fixture.py").read_text() + (PKG / "fixture/c2fx.py").read_text()
        self.assertNotIn("enclave-c2-fixture-pg ", new.replace("\n", " "))


# ===================================================================== A2. stage ownership (root review R1)
class StageOwnership(Base):
    def test_root_counterexample_mkdir_race_is_never_deleted(self):
        """root's stage-race.py, in-process: mkdir creates the directory 'for another run' and reports EEXIST"""
        r = self.run_(run_id="stage-collision-proof")
        original = os.mkdir
        def race(path, *a, **kw):
            if Path(path) == r.stage:
                original(path, *a, **kw)
                (r.stage / "other-run.txt").write_text("belongs to another run")
                raise FileExistsError("simulated race after existence check")
            return original(path, *a, **kw)
        with patch("os.mkdir", race):
            with self.assertRaises(FileExistsError):
                r.begin()
        rep = r.cleanup()
        self.assertEqual((r.stage / "other-run.txt").read_text(), "belongs to another run")
        self.assertEqual(rep["stage"], "not ours (our mkdir failed): untouched")
        self.assertEqual([x["event"] for x in r.journal.records() if x.get("resource") == "stage"], ["intent", "create-failed"])

    def test_root_stage_race_script_itself_passes(self):
        """root's own script, byte-exact copy run from a temp dir (its json result is written there, never in root's dir)"""
        self.assertTrue(ROOT_RACE.exists())
        cp = self.tmp / "stage-race.py"
        shutil.copyfile(ROOT_RACE, cp)
        r = subprocess.run([sys.executable, "-B", str(cp)], cwd=str(WO), capture_output=True, text=True, timeout=120)
        self.assertEqual(r.returncode, 0, r.stdout + r.stderr)
        out = json.loads((self.tmp / "stage-race.json").read_text())
        self.assertFalse(out["bugReproduced"])
        self.assertEqual(out["cleanup"]["stage"], "not ours (our mkdir failed): untouched")

    def test_lost_creation_confirmation_preserves_unknown_stage(self):
        r = self.run_()
        orig = c2fx.Journal.add
        def add(j, **rec):
            if rec.get("event") == "created" and rec.get("resource") == "stage":
                raise OSError("journal write lost")
            return orig(j, **rec)
        with patch.object(c2fx.Journal, "add", add):
            with self.assertRaises(OSError):
                r.begin()
        self.assertTrue(r.stage.is_dir())
        rep = r.cleanup()
        self.assertTrue(r.stage.is_dir(), "never deleted without a confirmed creation")
        self.assertTrue(rep["stage"].startswith("UNKNOWN: intent without a confirmed creation")); self.assertFalse(rep["certain"])

    def test_runner_killed_right_after_mkdir_then_recover_preserves(self):
        """a REAL lost confirmation: the process creating the stage is SIGKILLed between mkdir and its journal record"""
        code = (f"import os, sys, signal; sys.dont_write_bytecode=True; sys.path.insert(0, {str(PKG / 'fixture')!r}); sys.path.insert(0, {str(HERE)!r})\n"
                "import c2fx, test_ownership as t\n"
                "from pathlib import Path\n"
                "r = c2fx.Run(Path(sys.argv[1]), t._FakeDocker(), run_id='lostconfirm00001', scope=t.fake_scope(sys.argv[2]))\n"
                "real = os.mkdir\n"
                "def mk(p, *a, **k):\n"
                "    real(p, *a, **k)\n"
                "    if Path(p) == r.stage: os.kill(os.getpid(), signal.SIGKILL)\n"
                "os.mkdir = mk\n"
                "r.begin()\n")
        p = subprocess.run([sys.executable, "-c", code, str(self.runs), str(self.tmp)], capture_output=True, text=True, timeout=60)
        self.assertEqual(p.returncode, -signal.SIGKILL, p.stderr)
        stage = self.runs / "lostconfirm00001"
        self.assertTrue(stage.is_dir())
        (stage / "precious").write_text("x")
        rep = c2fx.recover(self.runs, "lostconfirm00001", _FakeDocker())
        self.assertFalse(rep["certain"]); self.assertTrue(rep["stage"].startswith("UNKNOWN"))
        self.assertEqual((stage / "precious").read_text(), "x")

    def test_replacement_directory_at_the_same_path_is_never_deleted(self):
        r = self.run_(); r.begin()
        marker = (r.stage / c2fx.MARKER).read_text()
        os.rename(r.stage, self.tmp / "our-original")              # ours moved away (or deleted) ...
        r.stage.mkdir()                                             # ... and another directory appears at the path,
        (r.stage / "other-run.txt").write_text("not ours")
        (r.stage / c2fx.MARKER).write_text(marker)                 # even with a copied marker
        rep = r.cleanup()
        self.assertTrue(rep["stage"].startswith("PRESERVED")); self.assertFalse(rep["certain"])
        self.assertEqual((r.stage / "other-run.txt").read_text(), "not ours")
        self.assertTrue((self.tmp / "our-original").is_dir())

    def test_same_inode_with_a_foreign_marker_is_preserved(self):
        r = self.run_(); r.begin()
        (r.stage / c2fx.MARKER).write_text(f"{r.id} {'0' * 32}\n")
        rep = r.cleanup()
        self.assertTrue(rep["stage"].startswith("PRESERVED")); self.assertTrue(r.stage.is_dir())

    def test_symlink_at_the_stage_path_is_preserved_with_its_target(self):
        r = self.run_(); r.begin()
        os.rename(r.stage, self.tmp / "moved")
        target = self.tmp / "elsewhere"; target.mkdir(); (target / "f").write_text("keep")
        os.symlink(target, r.stage)
        rep = r.cleanup()
        self.assertTrue(rep["stage"].startswith("PRESERVED")); self.assertEqual((target / "f").read_text(), "keep")

    def test_swap_between_check_and_rename_is_restored_not_deleted(self):
        r = self.run_(); r.begin()
        os.rename(r.stage, self.tmp / "moved")
        r.stage.mkdir(); (r.stage / "other-run.txt").write_text("not ours")
        real = r.stage_is_ours
        calls = []
        def first_lies(path, rec):
            calls.append(path)
            return True if len(calls) == 1 else real(path, rec)   # the swap lands after the first check
        r.stage_is_ours = first_lies
        rec = r.stage_record()[1]
        msg, ok = r.remove_stage(rec)
        self.assertFalse(ok); self.assertTrue(msg.startswith("PRESERVED: replaced during removal"), msg)
        self.assertEqual((r.stage / "other-run.txt").read_text(), "not ours")

    def test_normal_created_stage_is_removed(self):
        r = self.run_(); r.begin()
        (r.stage / "secrets").mkdir(); (r.stage / "secrets" / "x").write_text("disposable")
        rep = r.cleanup()
        self.assertEqual(rep["stage"], "removed"); self.assertTrue(rep["certain"]); self.assertFalse(r.stage.exists())
        self.assertFalse((self.runs / f".{r.id}.removing").exists())


# ===================================================================== B. lost responses
class LostResponses(Base):
    def test_lost_volume_create_response_adopted_by_label_then_removed(self):
        r = self.run_(); r.begin()
        self.fake.set_fault("lose-volume-create")
        r.create_volume()                                   # rc 1, but it exists WITH our label: ours
        self.fake.set_fault("")
        rep = r.cleanup()
        self.assertEqual(rep["volume"], "removed"); self.assertTrue(rep["certain"])

    def test_lost_container_run_response_adopted_by_label_then_removed(self):
        r = self.run_(); r.begin(); r.create_volume(); (r.stage / "pg.env").write_text("x")
        self.fake.set_fault("lose-run")
        r.create_container(r.stage / "pg.env")
        self.fake.set_fault("")
        rep = r.cleanup()
        self.assertEqual((rep["container"], rep["volume"]), ("removed", "removed")); self.assertTrue(rep["certain"])

    def test_timed_out_run_is_a_lost_response_and_still_cleaned(self):
        r = self.run_(clamp=1); r.begin(); r.create_volume(); (r.stage / "pg.env").write_text("x")
        self.fake.set_fault("slow-run")
        r.create_container(r.stage / "pg.env")             # our timeout fired; the daemon created it anyway
        self.fake.set_fault("")
        recs = [x for x in r.journal.records() if x.get("resource") == "container"]
        self.assertEqual([x["event"] for x in recs[:2]], ["intent", "created"]); self.assertIsNone(recs[1]["rc"])
        self.assertTrue(r.cleanup()["certain"])
        self.assertEqual(self.fake.st(), {"containers": {}, "volumes": {}})

    def test_failed_run_after_intent_cleanup_only_inspects(self):
        r = self.run_(); r.begin(); r.create_volume(); (r.stage / "pg.env").write_text("x")
        self.fake.put("container", r.container, {})        # name taken (race): run answers 125 Conflict
        with self.assertRaises(c2fx.Refused):
            r.create_container(r.stage / "pg.env")
        rep = r.cleanup()
        self.assertIn(r.container, self.fake.st()["containers"], "the other container is preserved")
        self.assertTrue(rep["container"].startswith("PRESERVED")); self.assertFalse(rep["certain"])
        self.assertEqual(rep["volume"], "kept: container not confirmed removed")

    def test_lost_rm_response_confirmed_by_reinspect(self):
        r = self.run_(); r.begin(); r.create_volume(); (r.stage / "pg.env").write_text("x"); r.create_container(r.stage / "pg.env")
        self.fake.set_fault("lose-rm")
        rep = r.cleanup()
        self.assertEqual(rep["container"], "removed"); self.assertTrue(rep["certain"])

    def test_rm_failure_is_uncertain_keeps_volume_and_stage(self):
        r = self.run_(); r.begin(); r.create_volume(); (r.stage / "pg.env").write_text("x"); r.create_container(r.stage / "pg.env")
        self.fake.set_fault("rm-fails")
        rep = r.cleanup()
        self.assertFalse(rep["certain"]); self.assertTrue(rep["container"].startswith("UNKNOWN"))
        self.assertIn(r.volume, self.fake.st()["volumes"]); self.assertTrue(r.stage.exists())

    def test_inspect_error_is_unknown_never_clean(self):
        r = self.run_(); r.begin(); r.create_volume()
        self.fake.set_fault("inspect-error")
        rep = r.cleanup()
        self.assertFalse(rep["certain"]); self.assertTrue(rep["volume"].startswith("UNKNOWN")); self.assertTrue(r.stage.exists())

    def test_non_loopback_port_refused_and_container_still_cleaned(self):
        r = self.run_(); r.begin(); r.create_volume(); (r.stage / "pg.env").write_text("x")
        self.fake.set_fault("port-public")
        with self.assertRaises(c2fx.Refused):
            r.create_container(r.stage / "pg.env")
        self.fake.set_fault("")
        self.assertTrue(r.cleanup()["certain"])
        self.assertEqual(self.fake.st(), {"containers": {}, "volumes": {}})


# ===================================================================== C. indexd identity / unknown child exit
class ProcessIdentity(Base):
    def test_controller_pidfile_is_identity_and_stop_uses_it(self):
        r = self.run_(scope="real"); r.begin()
        pid, prof = fake_indexd(r.stage); self.started.append(pid)
        pf = r.stage / "node/state/indexd.pid"
        parts = pf.read_text().split()
        self.assertEqual(len(parts), 3); self.assertEqual(oct(pf.stat().st_mode & 0o777), "0o600")
        self.assertEqual(parts[1], c2fx.Proc().start(pid)); self.assertEqual(parts[2], c2fx.Proc().boot_id())
        out = subprocess.run([sys.executable, str(CTL), "--profile", str(prof), "stop"], capture_output=True, text=True, timeout=60)
        self.assertEqual(out.returncode, 0, out.stdout)
        self.assertFalse(alive(pid)); self.assertFalse(pf.exists())

    def test_controller_start_refuses_a_second_indexd(self):
        r = self.run_(scope="real"); r.begin()
        pid, prof = fake_indexd(r.stage); self.started.append(pid)
        out = subprocess.run([sys.executable, str(CTL), "--profile", str(prof), "start"], input=LOOP, capture_output=True, text=True, timeout=30)
        self.assertNotEqual(out.returncode, 0); self.assertIn("already running", out.stderr)
        self.assertEqual(int((r.stage / "node/state/indexd.pid").read_text().split()[0]), pid)

    def test_controller_unparseable_pidfile_is_an_error_not_stopped(self):
        r = self.run_(scope="real"); r.begin()
        pid, prof = fake_indexd(r.stage); self.started.append(pid)
        (r.stage / "node/state/indexd.pid").write_text(f"{pid}\n")   # legacy pid-only form: no identity
        out = subprocess.run([sys.executable, str(CTL), "--profile", str(prof), "stop"], capture_output=True, text=True, timeout=30)
        self.assertNotEqual(out.returncode, 0); self.assertIn("identity unknown", out.stderr)
        self.assertTrue(alive(pid), "never signalled on an unverified pid")
        rep = r.cleanup(pid_files=[r.stage / "node/state/indexd.pid"])
        self.assertFalse(rep["certain"]); self.assertTrue(r.stage.exists())

    def test_reused_pid_is_never_signalled_by_controller_or_cleanup(self):
        r = self.run_(scope="real"); r.begin()
        pid, prof = fake_indexd(r.stage); self.started.append(pid)
        pf = r.stage / "node/state/indexd.pid"
        _, start, boot = pf.read_text().split()
        time.sleep(0.05)                                  # starttime has clock-tick (10 ms) granularity: a REAL reuse
        other = unrelated_process(self)[0]                # can never share pid AND tick; and it lives OUTSIDE this job's
        wait_for(lambda: c2fx.Proc().start(other.pid) not in (None, start), 1)   # scope (inside, the drain would own it)
        self.assertNotEqual(c2fx.Proc().start(other.pid), start, "precondition: a different process start")
        pf.write_text(f"{other.pid} {start} {boot}\n")   # same recorded identity, pid now another process (= reuse)
        out = subprocess.run([sys.executable, str(CTL), "--profile", str(prof), "stop"], capture_output=True, text=True, timeout=30)
        self.assertEqual(out.returncode, 0)
        self.assertIsNone(other.poll(), "the unrelated process is untouched by the controller")
        pf.write_text(f"{other.pid} {start} {boot}\n")
        rep = r.cleanup(pid_files=[pf])
        self.assertIsNone(other.poll(), "and by the cleanup")
        self.assertEqual(rep["indexdPidFiles"][0]["outcome"], "exited (pid reused by another process: not signalled)")
        kill_hard(pid)

    def test_unknown_child_exit_is_confirmed_and_stage_removed(self):
        r = self.run_(scope="real"); r.begin()
        pid, _ = fake_indexd(r.stage)
        kill_hard(pid)                                   # indexd died on its own; nobody told the runner
        wait_for(lambda: not alive(pid), 5)
        rep = r.cleanup(pid_files=[r.stage / "node/state/indexd.pid"])
        self.assertTrue(rep["certain"], rep); self.assertEqual(rep["indexdPidFiles"][0]["outcome"], "exited")
        self.assertFalse(r.stage.exists())

    def test_running_indexd_is_stopped_before_the_stage_is_deleted(self):
        r = self.run_(scope="real"); r.begin()
        pid, _ = fake_indexd(r.stage); self.started.append(pid)
        rep = r.cleanup(pid_files=[r.stage / "node/state/indexd.pid"])
        self.assertTrue(rep["certain"], rep); self.assertFalse(alive(pid)); self.assertFalse(r.stage.exists())

    def test_term_ignored_escalates_to_kill_through_pidfd(self):
        r = self.run_(scope="real"); r.begin()
        pid, _ = fake_indexd(r.stage, script=DEAF); self.started.append(pid)
        t0 = time.time()
        rep = r.cleanup(pid_files=[r.stage / "node/state/indexd.pid"])
        self.assertTrue(rep["certain"], rep); self.assertFalse(alive(pid)); self.assertGreaterEqual(time.time() - t0, 2.5)

    def test_proc_read_error_is_unknown_and_preserves_stage(self):
        class Blind(c2fx.Proc):
            def start(self, pid):
                raise c2fx.Unknown("EACCES")
        r = self.run_(); r.begin()
        pid, _ = fake_indexd(r.stage); self.started.append(pid)
        r.proc = Blind()
        rep = r.cleanup(pid_files=[r.stage / "node/state/indexd.pid"])
        self.assertFalse(rep["certain"]); self.assertTrue(rep["indexdPidFiles"].startswith("UNKNOWN")); self.assertTrue(r.stage.exists())
        self.assertTrue(any(x.get("event") == "cleanup" and not x["report"]["certain"] for x in r.journal.records()))

    def test_exit_never_observed_is_unknown(self):
        class Stuck(c2fx.Proc):
            def pidfd_wait(self, fd, seconds):
                return False
            def pidfd_signal(self, fd, sig):
                pass                                     # the signal is "lost": the process keeps running
        r = self.run_(scope="real"); r.begin()
        pid, _ = fake_indexd(r.stage); self.started.append(pid)
        r.proc = Stuck()
        rep = r.cleanup(pid_files=[r.stage / "node/state/indexd.pid"])
        self.assertFalse(rep["certain"]); self.assertTrue(r.stage.exists()); self.assertTrue(alive(pid))

    def test_no_scope_means_drainage_unknown(self):
        r = self.run_(scope=None); r.begin()
        rep = r.cleanup()
        self.assertFalse(rep["certain"]); self.assertTrue(rep["scope"].startswith("UNKNOWN: no scope")); self.assertTrue(r.stage.exists())

    def test_zombie_counts_as_exited(self):
        p = subprocess.Popen(["true"]); self.started.append(p)
        time.sleep(0.3)                                   # exited, not yet reaped
        self.assertIsNone(c2fx.Proc().start(p.pid))
        p.wait()


# ===================================================================== C2. scope validation (no real processes signalled)
class ScopeValidation(unittest.TestCase):
    class P(c2fx.Proc):
        def __init__(self, cg, chain, guard_cmd=b"/usr/bin/node\0/x/enclave/test/helpers/memory-guard.mjs\0"):
            self.cg, self.chain, self.guard_cmd = cg, chain, guard_cmd
        def cgroup(self, pid):
            return self.cg
        def ppid(self, pid):
            return self.chain.get(pid)
        def start(self, pid):
            return "1"
        def cmdline(self, pid):
            return self.guard_cmd.split(b"\0")

    def test_outside_a_queue_scope_is_refused(self):
        with self.assertRaises(c2fx.Refused):
            c2fx.queue_scope(self.P("/user.slice/user-1000.slice/session-2.scope", {}))

    def test_a_scope_whose_main_process_is_not_the_memory_guard_is_refused(self):
        rel = "/user.slice/x/run-p4242-i1.scope"
        with self.assertRaises(c2fx.Refused):
            c2fx.queue_scope(self.P(rel, {os.getpid(): 4242}, guard_cmd=b"/usr/bin/bash\0"))

    def test_the_guard_must_be_an_ancestor(self):
        rel = "/user.slice/x/run-p4242-i1.scope"
        with self.assertRaises(c2fx.Refused):
            c2fx.queue_scope(self.P(rel, {os.getpid(): 1}))


# ===================================================================== D. REAL scope drainage (root review R2)
@unittest.skipUnless(OK_SCOPE, f"needs a shared-queue job scope: {WHY}")
class ScopeDrain(Base):
    def unrelated(self):
        return unrelated_process(self)[0]

    def test_grandchildren_writing_in_the_stage_after_their_parent_exited_are_drained_first(self):
        r = self.run_(scope=c2fx.queue_scope()); r.begin()
        bystander = self.unrelated()
        # parent sh exits at once; its grandchildren (bash and python: executables OUTSIDE the stage) keep writing in it
        sh = subprocess.Popen(["sh", "-c", '( while :; do echo x >> "$1/held.log"; sleep 0.05; done ) & echo $! > "$1/gc.pid"; '
                               'cd "$1" && python3 -c "import time\nf=open(\'py.hold\',\'a\')\nwhile True:\n f.write(\'y\'); f.flush(); time.sleep(0.05)" '
                               '> /dev/null 2>&1 & echo $! > "$1/py.pid"; exit 0', "_", str(r.stage)])
        r.children.append(sh)
        self.assertEqual(sh.wait(10), 0)
        gc = int(wait_for(lambda: (r.stage / "gc.pid").read_text().strip() if (r.stage / "gc.pid").exists() else None))
        py = int(wait_for(lambda: (r.stage / "py.pid").read_text().strip() if (r.stage / "py.pid").exists() and (r.stage / "py.pid").read_text().strip() else None))
        self.started += [gc, py]
        for pid in (gc, py):
            self.assertTrue(alive(pid))
            self.assertFalse(os.path.realpath(f"/proc/{pid}/exe").startswith(str(r.stage)), "exe OUTSIDE the stage: the old exe filter missed this")
            self.assertEqual(c2fx.Proc().cgroup(pid), r.scope["rel"])
        size = wait_for(lambda: (r.stage / "held.log").exists() and (r.stage / "held.log").stat().st_size > 20 and (r.stage / "py.hold").exists())
        self.assertTrue(size, "precondition: the grandchildren really write in the stage")
        rep = r.cleanup()
        self.assertTrue(rep["certain"], rep); self.assertEqual(rep["scope"]["scope"], "drained")
        self.assertFalse(alive(gc)); self.assertFalse(alive(py)); self.assertFalse(r.stage.exists())
        self.assertIn(gc, rep["scope"]["rounds"][0]["members"]); self.assertIn(py, rep["scope"]["rounds"][0]["members"])
        self.assertIsNone(bystander.poll(), "the unrelated process survives")
        for pid, s in r.scope["exempt"]:
            self.assertEqual(c2fx.Proc().start(pid), s, f"ancestor {pid} (guard/timeout/runner) never signalled")

    def test_child_timeout_kills_only_the_parent_and_the_cleanup_drains_the_rest(self):
        """the runner's child() on a timeout stops only its direct child (e.g. the go command); a descendant survives that
        and keeps the stage busy until the scope drain"""
        m = load_runner()
        r = self.run_(scope=c2fx.queue_scope()); r.begin()
        bystander = self.unrelated()
        log = self.tmp / "child.log"
        rc = m.child(r, ["sh", "-c", f'( exec sleep 60 ) & echo $! > {r.stage}/desc.pid; sleep 60'], log, timeout=1)
        self.assertIsNone(rc, "timed out")
        desc = int((r.stage / "desc.pid").read_text())
        self.started.append(desc)
        self.assertTrue(alive(desc), "precondition: the descendant outlived its killed parent")
        rep = r.cleanup()
        self.assertTrue(rep["certain"], rep); self.assertFalse(alive(desc)); self.assertFalse(r.stage.exists())
        self.assertIsNone(bystander.poll())

    def test_undrainable_scope_is_unknown_and_the_stage_is_preserved(self):
        class Stuck(c2fx.Proc):
            def pidfd_signal(self, fd, sig):
                pass
            def pidfd_wait(self, fd, seconds):
                return False
        r = self.run_(scope=c2fx.queue_scope()); r.begin()
        p = subprocess.Popen(["sleep", "60"], cwd=str(r.stage)); self.started.append(p)
        r.proc = Stuck()
        rep = r.cleanup()
        self.assertFalse(rep["certain"]); self.assertTrue(rep["scope"].startswith("UNKNOWN: scope not drained"))
        self.assertTrue(r.stage.exists()); self.assertIsNone(p.poll())

    def test_a_replaced_scope_is_never_touched(self):
        sc = dict(c2fx.queue_scope()); sc["ino"] = sc["ino"] + 1           # the recorded scope "was removed and recreated"
        r = self.run_(scope=sc); r.begin()
        p = subprocess.Popen(["sleep", "60"]); self.started.append(p)      # a member of the CURRENT cgroup with that name
        rep = r.cleanup()
        self.assertIn("another cgroup", rep["scope"]["scope"]); self.assertIsNone(p.poll())


# ===================================================================== D2. pid files never signal (root review r3)
@unittest.skipUnless(OK_SCOPE, f"needs a shared-queue job scope: {WHY}")
class PidFileSafety(Base):
    def plant(self, stage, pid, start, boot):
        st = stage / "node" / "state"
        st.mkdir(parents=True, exist_ok=True)
        (st / "indexd.pid").write_text(f"{pid} {start} {boot}\n")
        return st / "indexd.pid"

    def test_replacement_stage_with_a_real_unrelated_identity_is_not_inspected(self):
        r = self.run_(scope="real"); r.begin()
        other, start, boot = unrelated_process(self)
        os.rename(r.stage, self.tmp / "ours-moved")
        r.stage.mkdir()
        pf = self.plant(r.stage, other.pid, start, boot)              # the exact LIVE identity of an unrelated process
        rep = r.cleanup(pid_files=[pf])
        self.assertEqual(rep["indexdPidFiles"], "not inspected: the stage is not confirmed ours")
        self.assertIsNone(other.poll(), "the unrelated process survives"); self.assertEqual(c2fx.Proc().start(other.pid), start)
        self.assertTrue(rep["stage"].startswith("PRESERVED")); self.assertFalse(rep["certain"]); self.assertTrue(pf.exists())

    def test_replacement_stage_naming_the_cleaners_own_identity_is_not_inspected(self):
        r = self.run_(scope="real"); r.begin()
        os.rename(r.stage, self.tmp / "ours-moved"); r.stage.mkdir()
        pf = self.plant(r.stage, os.getpid(), c2fx.Proc().start(os.getpid()), c2fx.Proc().boot_id())
        rep = r.cleanup(pid_files=[pf])
        self.assertEqual(rep["indexdPidFiles"], "not inspected: the stage is not confirmed ours"); self.assertFalse(rep["certain"])

    def test_own_stage_pid_file_naming_a_live_process_outside_the_scope_is_uncertain_not_signalled(self):
        r = self.run_(scope="real"); r.begin()
        other, start, boot = unrelated_process(self)
        pf = self.plant(r.stage, other.pid, start, boot)
        rep = r.cleanup(pid_files=[pf])
        e = rep["indexdPidFiles"][0]
        self.assertTrue(e["outcome"].startswith("UNCERTAIN: a live process outside this run's scope"), e); self.assertTrue(e["uncertain"])
        self.assertIsNone(other.poll()); self.assertEqual(c2fx.Proc().start(other.pid), start)
        self.assertFalse(rep["certain"]); self.assertTrue(rep["stage"].startswith("KEPT for recovery"))

    def test_own_stage_stale_reused_and_old_boot_pid_files_are_not_signalled_and_clean(self):
        r = self.run_(scope="real"); r.begin()
        dead = subprocess.Popen(["true"]); dead.wait()
        other, start, boot = unrelated_process(self)
        pf1 = self.plant(r.stage, dead.pid, "1", boot)                                       # stale: no live process (or reused)
        pf2 = r.stage / "node/state/indexd.reused.pid"; pf2.write_text(f"{other.pid} {int(start) - 1} {boot}\n")   # same pid, other start
        pf3 = r.stage / "node/state/indexd.oldboot.pid"; pf3.write_text(f"{other.pid} {start} 00000000-0000-0000-0000-000000000000\n")
        rep = r.cleanup(pid_files=[pf1, pf2, pf3])
        outs = [e["outcome"] for e in rep["indexdPidFiles"]]
        self.assertEqual(outs[1:], ["exited (pid reused by another process: not signalled)", "exited (other boot)"])
        self.assertIn(outs[0], ("exited", "exited (pid reused by another process: not signalled)"))
        self.assertIsNone(other.poll(), "never signalled"); self.assertTrue(rep["certain"], rep); self.assertFalse(r.stage.exists())

    def test_pid_files_naming_ancestors_are_uncertain_and_never_signalled(self):
        r = self.run_(scope="real"); r.begin()
        guard_pid, guard_start = r.scope["exempt"][-1]
        boot = c2fx.Proc().boot_id()
        pf1 = self.plant(r.stage, os.getpid(), c2fx.Proc().start(os.getpid()), boot)           # the cleaner itself
        pf2 = r.stage / "node/state/guard.pid"; pf2.write_text(f"{guard_pid} {guard_start} {boot}\n")   # the queue's memory guard
        rep = r.cleanup(pid_files=[pf1, pf2])
        self.assertEqual(len(rep["indexdPidFiles"]), 2)
        for e in rep["indexdPidFiles"]:
            self.assertTrue(e["outcome"].startswith("UNCERTAIN: names an ancestor"), e)
        self.assertEqual(c2fx.Proc().start(guard_pid), guard_start, "the guard is untouched")
        self.assertFalse(rep["certain"]); self.assertTrue(r.stage.exists())

    def test_controller_refuses_a_pid_file_naming_an_ancestor_or_an_outside_process(self):
        r = self.run_(scope="real"); r.begin()
        pid, prof = fake_indexd(r.stage); self.started.append(pid)
        pf = r.stage / "node/state/indexd.pid"
        boot = c2fx.Proc().boot_id()
        other, ostart, _ = unrelated_process(self)
        for victim, vstart in ((os.getpid(), c2fx.Proc().start(os.getpid())), (other.pid, ostart)):
            pf.write_text(f"{victim} {vstart} {boot}\n")
            out = subprocess.run([sys.executable, str(CTL), "--profile", str(prof), "stop"], capture_output=True, text=True, timeout=30)
            self.assertNotEqual(out.returncode, 0); self.assertIn("refusing to signal", out.stderr)
            self.assertEqual(c2fx.Proc().start(victim), vstart, "never signalled")
        self.assertIsNone(other.poll())
        kill_hard(pid)

    def test_legitimate_own_indexd_and_orphan_are_drained_and_the_stage_removed(self):
        r = self.run_(scope="real"); r.begin()
        pid, _ = fake_indexd(r.stage); self.started.append(pid)                 # identity pid file, in scope
        orphan, _ = fake_indexd(r.stage, via_controller=False, sha="cd" * 32)   # lost start response: no pid file
        self.started.append(orphan)
        rep = r.cleanup(pid_files=[r.stage / "node/state/indexd.pid"])
        self.assertTrue(rep["certain"], rep)
        self.assertEqual(rep["indexdPidFiles"][0]["outcome"], "exited (drained)")
        self.assertIn(pid, rep["scope"]["rounds"][0]["members"]); self.assertIn(orphan.pid, rep["scope"]["rounds"][0]["members"])
        self.assertFalse(alive(pid)); orphan.wait(5); self.assertFalse(r.stage.exists())


# ===================================================================== E. the runner: signals, uncertainty, recovery
DRIVER = r'''
import importlib.util, json, os, sys, time
from pathlib import Path
sys.dont_write_bytecode = True
sp = importlib.util.spec_from_file_location("runner", sys.argv[1]); m = importlib.util.module_from_spec(sp); sp.loader.exec_module(m)
sys.path.insert(0, sys.argv[2]); import test_ownership as t
m.RUNS = Path(sys.argv[3]) / "runs"           # runs/ under the test's temp dir; the scope is this job's REAL scope
mode = sys.argv[4]
orig_init = m.c2fx.Run.__init__
def init(self, *a, **k):
    orig_init(self, *a, **k); self.term_wait, self.kill_wait = 3, 3
m.c2fx.Run.__init__ = init
m.c2fx.Docker = lambda cli, timeout=120: t._FakeDocker()
def work(run, log, env0):
    run.create_volume(); (run.stage / "pg.env").write_text("x"); run.create_container(run.stage / "pg.env")
    pid, _ = t.fake_indexd(run.stage)
    (run.stage / "c2-fixture-results.json").write_text('{"passed": true}')
    import subprocess
    gc = subprocess.Popen(["sh", "-c", f'( while :; do echo z >> {run.stage}/gc.log; sleep 0.1; done ) & echo $!; exit 0'], stdout=subprocess.PIPE, text=True)
    g = int(gc.stdout.readline()); gc.wait()
    print(json.dumps({"runId": run.id, "indexd": pid, "grandchild": g}), flush=True)
    if mode == "pass":
        subprocess.run([sys.executable, str(t.CTL), "--profile", str(run.stage / "profile.json"), "stop"], check=True, capture_output=True)
        return 0
    time.sleep(120)                             # interrupted here
m.work = work
got, bad, inv = m.pins()
sys.exit(m.main(["--execute", m.manifest(got)]))
'''


@unittest.skipUnless(OK_SCOPE, f"needs a shared-queue job scope: {WHY}")
class Runner(Base):
    def driver(self, mode, fault=""):
        (self.tmp / "driver.py").write_text(DRIVER)
        env = dict(os.environ, FAKEDOCKER_FAULT=fault)
        p = subprocess.Popen([sys.executable, "-u", str(self.tmp / "driver.py"), str(PKG / "fixture/run-c2-fixture.py"), str(HERE), str(self.tmp), mode],
                             stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, env=env)
        self.addCleanup(p.stderr.close); self.addCleanup(p.stdout.close)
        return p

    def first_line(self, p):
        line = p.stdout.readline()
        self.assertTrue(line, p.stderr.read() if p.poll() is not None else "no output")
        info = json.loads(line)
        self.started += [info["indexd"], info["grandchild"]]
        return info

    def test_sigterm_runs_the_cleanup_and_never_passes(self):
        p = self.driver("hang")
        info = self.first_line(p)
        p.send_signal(signal.SIGTERM)
        p.wait(90)
        self.assertEqual(p.returncode, 1, p.stderr.read())
        res = json.loads((self.runs / f"{info['runId']}.result.json").read_text())
        self.assertFalse(res["passed"]); self.assertTrue(res["outcome"].startswith("interrupted")); self.assertTrue(res["cleanup"]["certain"], res)
        self.assertFalse(alive(info["indexd"])); self.assertFalse(alive(info["grandchild"]))
        self.assertEqual(self.fake.st(), {"containers": {}, "volumes": {}})
        self.assertFalse((self.runs / info["runId"]).exists())
        self.assertTrue((self.runs / f"{info['runId']}.c2-fixture-results.json").exists(), "results kept outside the stage")

    def test_stages_pass_but_uncertain_cleanup_is_exit_3_not_pass(self):
        p = self.driver("pass", fault="rm-fails")
        info = self.first_line(p)
        p.wait(90)
        self.assertEqual(p.returncode, 3, p.stderr.read())
        res = json.loads((self.runs / f"{info['runId']}.result.json").read_text())
        self.assertFalse(res["passed"]); self.assertEqual(res["stagesRc"], 0); self.assertFalse(res["cleanup"]["certain"])
        self.assertTrue((self.runs / info["runId"]).exists(), "stage kept for recovery")
        self.fake.set_fault("")
        rec = c2fx.recover(self.runs, info["runId"], _FakeDocker())
        self.assertTrue(rec["certain"], rec); self.assertFalse((self.runs / info["runId"]).exists())

    def test_sigkill_then_recover_drains_the_recorded_scope(self):
        p = self.driver("hang")
        info = self.first_line(p)
        p.kill(); p.wait(10)
        self.assertTrue(alive(info["indexd"]) and alive(info["grandchild"]), "detached workload outlives a SIGKILLed runner")
        self.assertTrue((self.runs / info["runId"]).exists())
        rec = c2fx.recover(self.runs, info["runId"], _FakeDocker())
        self.assertTrue(rec["certain"], rec); self.assertFalse(alive(info["indexd"])); self.assertFalse(alive(info["grandchild"]))
        self.assertEqual(self.fake.st(), {"containers": {}, "volumes": {}}); self.assertFalse((self.runs / info["runId"]).exists())


class RunnerOffline(Base):
    def test_plan_has_no_side_effects_and_all_pins_match(self):
        env = dict(os.environ, C2FX_DOCKER="/nonexistent/docker")
        r = subprocess.run([sys.executable, str(PKG / "fixture/run-c2-fixture.py"), "--plan"], capture_output=True, text=True, timeout=300, env=env)
        out = json.loads(r.stdout)
        self.assertEqual(r.returncode, 0, out); self.assertEqual(out["pinMismatches"], []); self.assertTrue(out["fenceTreeInventory"][0])
        self.assertFalse((PKG / "runs").exists(), "plan creates nothing")

    def test_execute_with_wrong_manifest_refuses_and_creates_nothing(self):
        env = dict(os.environ, C2FX_DOCKER="/nonexistent/docker")
        r = subprocess.run([sys.executable, str(PKG / "fixture/run-c2-fixture.py"), "--execute", "0" * 64], capture_output=True, text=True, timeout=300, env=env)
        self.assertEqual(r.returncode, 2); self.assertFalse((PKG / "runs").exists())


if __name__ == "__main__":
    unittest.main()
