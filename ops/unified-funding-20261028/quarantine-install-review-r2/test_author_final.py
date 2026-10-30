"""Unit tests: owned temp filesystem root + FakeHost.

FakeHost is a UNIT-TEST ADAPTER ONLY. It simulates systemd/proc/cgroup/gate/probe answers and proves nothing about the
production host, the live relay, checkpoint coverage or the nonce tail. Nothing here touches systemd, /proc or network.
"""
import fcntl
import io
import json
import os
import re
import stat
import subprocess
import sys
import tempfile
import unittest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import quarantine_install_r2 as q  # noqa: E402

NAMES = sorted(["sessions.mjs", "funding-route.mjs", "funding-activation.mjs", "fee-policy.mjs", "funding-abi.mjs"])
PROT = sorted(["api-relay.js", "sessions-abi.mjs", "snp-verify.mjs", "store.js"])
cand = lambda n: ("// candidate %s\n" % n).encode()  # noqa: E731
prot = lambda n: ("// protected %s\n" % n).encode()  # noqa: E731
ORIG = b"// original sessions.mjs\n"
PINS = q.Pins(candidate={n: q.sha(cand(n)) for n in NAMES}, protected={n: q.sha(prot(n)) for n in PROT},
              original_sessions=q.sha(ORIG), gate_helper="0" * 64)
SECRET = b"relay-secret-value-never-printed"
OP = "quarantine-r2-test-0001"
CG = "/system.slice/enclave-api-relay.service"
OLD = {"pid": 228946, "startTicks": 5550001, "bootId": "11111111-2222-3333-4444-555555555555", "controlGroup": CG,
       "invocationId": "a" * 32}
BASE = {k: OLD[k] for k in ("pid", "startTicks", "bootId")}
L = q.Layout()
WATCH = "/var/lib/enclave-maintenance/watch/" + OP
OD = L.ops_root + "/" + OP
JPATH = L.state_dir + "/" + q.JOURNAL
NOW = 1_800_000_000


class Crash(BaseException):
    """Simulated process death: bypasses every `except Exception` handler."""


class FakeHost:
    def __init__(s, w):
        s.w, s.calls, s.boot = w, [], OLD["bootId"]
        s.loaded = s.dropins()
        s.active, s.main, s.inv = True, OLD["pid"], OLD["invocationId"]
        s.procs = {OLD["pid"]: [OLD["startTicks"], s.compose(OLD["invocationId"]), CG]}
        s.cgp = {CG: [OLD["pid"]]}
        s.gate = {"phase": "gate-verified", "ownedGateExact": True, "hash": "cfg-h1", "etag": '"e1"'}
        s.probe = {"writeQuarantine": True, "value": "1", "journal": {"persisted": False}}
        s.start_pid, s.start_ticks_v, s.start_inv, s.extra_env, s.on_start = 300001, 9990001, "b" * 32, b"", None

    def dropins(s):
        return sorted(L.dropin_dir + "/" + n for n in os.listdir(s.w.fs.p(L.dropin_dir)))

    def compose(s, inv):  # environment systemd would build from the LOADED unit + drop-ins
        parts = [b"PATH=/usr/bin", b"RELAY_PRIVATE_KEY=" + SECRET]
        for p in s.loaded:
            for line in s.w.get(p).splitlines():
                m = re.match(rb'^Environment="?([A-Z0-9_]+)=([^"]*)"?$', line)
                if m:
                    parts.append(m.group(1) + b"=" + m.group(2))
        parts += [b"INVOCATION_ID=" + inv.encode(), b"JOURNAL_STREAM=8:%d" % len(s.calls)]
        return b"\0".join(parts) + b"\0"

    def show(s, unit):
        return {"ActiveState": "active" if s.active else "inactive", "SubState": "running" if s.active else "dead",
                "MainPID": s.main if s.active else 0, "ControlGroup": CG if s.active else "", "InvocationID": s.inv,
                "DropInPaths": list(s.loaded), "Result": "success"}

    def cgroup_pids(s, cg):
        return list(s.cgp.get(cg, []))

    def start_ticks(s, pid):
        return s.procs[pid][0] if pid in s.procs else None

    def environ(s, pid):
        return s.procs[pid][1]

    def proc_cgroup(s, pid):
        return s.procs[pid][2]

    def boot_id(s):
        return s.boot

    def daemon_reload(s):
        s.calls.append("daemon-reload")
        s.loaded = s.dropins()

    def start(s, unit):
        s.calls.append("start")
        s.active, s.main, s.inv = True, s.start_pid, s.start_inv
        s.procs[s.start_pid] = [s.start_ticks_v, s.compose(s.start_inv) + s.extra_env, CG]
        s.cgp[CG] = [s.start_pid]
        if s.on_start:
            s.on_start()

    def stop(s, unit):
        s.calls.append("stop")
        s.procs.pop(s.main, None)
        s.active, s.main, s.cgp[CG] = False, 0, []

    def independent_stop_of_original(s):
        """Fixture for the SEPARATE root stop step. The installer itself never stops the original."""
        s.procs.pop(OLD["pid"])
        s.active, s.main, s.cgp[CG] = False, 0, []

    def gate_status(s, op):
        return dict(s.gate) if s.gate else {"phase": "absent", "ownedGateExact": False}

    def quarantine_probe(s, port):
        s.calls.append("probe")
        return s.probe


class World:
    def __init__(s, tmp):
        s.fs = q.FS(tmp, os.getuid())
        for n in PROT:
            s.put(L.relay_dir + "/" + n, prot(n))
        s.put(L.relay_dir + "/sessions.mjs", ORIG)
        for n in NAMES:
            s.put(L.stage_dir + "/" + n, cand(n))
        s.put(L.unit_file, b"[Service]\nExecStart=/usr/bin/node /opt/nan-relay/api-relay.js\n")
        for i in range(10):
            s.put("%s/%02d-orig.conf" % (L.dropin_dir, i), b"[Service]\nEnvironment=ORIG_%d=v%d\n" % (i, i))
        s.put(JPATH, b'{"txs":[{"nonce":7,"status":"mined"}]}')
        s.put(L.state_dir + "/" + q.INDEX, b'{"sessions":{}}')
        s.put(L.state_dir + "/owner-control/controls.json", b'{"owner":"retained"}')
        os.makedirs(s.fs.p(L.ops_root))
        os.chmod(s.fs.p(L.ops_root), 0o700)
        s.put(WATCH + "/activation.lock", b"", 0o600)
        s.host = FakeHost(s)
        s.inst = q.Installer(s.fs, s.host, L, PINS, clock=lambda: NOW)

    def put(s, a, data, mode=0o644):
        os.makedirs(os.path.dirname(s.fs.p(a)), exist_ok=True)
        if os.path.lexists(s.fs.p(a)):
            os.unlink(s.fs.p(a))
        with open(s.fs.p(a), "wb") as f:
            f.write(data)
        os.chmod(s.fs.p(a), mode)

    def get(s, a):
        with open(s.fs.p(a), "rb") as f:
            return f.read()

    def evidence(s, a, doc):
        s.put(a, q.canon(doc), 0o600)
        return {"path": a, "sha256": q.sha(q.canon(doc))}

    def prepare(s):
        pre = s.inst.snapshot(OP, "pre-stop", OLD["pid"], OLD["startTicks"])["manifestSha256"]
        s.marker = s.evidence(WATCH + "/activation-started.json",
                              {"op": OP, "phase": "financial-hold", "baseline": BASE, "preStopSnapshotSha256": pre})
        s.host.independent_stop_of_original()
        stop = s.evidence(OD + "/stop-record.json", {"op": OP, "baseline": BASE, "observedMainPid": 0})
        ckpt = s.evidence(OD + "/checkpoint-evidence.json", {"op": OP, "baseline": BASE, "qualified": False})
        post = s.inst.snapshot(OP, "post-stop", stop_record_sha256=stop["sha256"])["manifestSha256"]
        s.plan = {"schema": q.PLAN_SCHEMA, "op": OP, "issuedAtUnix": NOW - 60, "expiresAtUnix": NOW + 3600,
                  "oldIdentity": dict(OLD),
                  "baselineTargets": {n: PINS.original_sessions if n == "sessions.mjs" else "absent" for n in NAMES},
                  "unitFiles": {p: q.sha(s.get(p)) for p in [L.unit_file] + s.host.dropins()},
                  "dropInName": "zz-quarantine-r2-%s.conf" % OP, "lockPath": WATCH + "/activation.lock",
                  "gate": {"hash": "cfg-h1", "etag": '"e1"'}, "holdMarker": s.marker, "stopRecord": stop,
                  "checkpointEvidence": ckpt, "preStopSnapshotSha256": pre, "postStopSnapshotSha256": post,
                  "probePort": 8787}
        s.put(OD + "/plan.json", q.canon(s.plan), 0o600)
        return q.sha(q.canon(s.plan))


class Base(unittest.TestCase):
    def setUp(s):
        s.tmp = tempfile.TemporaryDirectory()
        s.w = World(s.tmp.name)
        s.h = s.w.host
        s.ps = s.w.prepare()
        s.journal = s.w.get(JPATH)

    def tearDown(s):
        s.tmp.cleanup()

    def refused(s, code, fn, *a):
        with s.assertRaises(q.Refusal) as cm:
            fn(*a)
        s.assertEqual(cm.exception.code, code)
        return cm.exception

    def assert_nothing_installed(s):
        s.assertEqual(s.h.calls, [])
        s.assertFalse(os.path.lexists(s.w.fs.p(OD + "/install-r2")))
        s.assertEqual(s.w.get(L.relay_dir + "/sessions.mjs"), ORIG)

    def assert_original_stopped_hold_retained(s):
        s.assertLessEqual(s.h.calls.count("start"), 1)
        s.assertNotIn(OLD["pid"], [p for p, v in s.h.procs.items() if v[0] == OLD["startTicks"]])
        s.assertEqual(q.sha(s.w.get(s.w.marker["path"])), s.w.marker["sha256"])
        s.assertIsNotNone(s.h.gate)  # no gate-removal call exists in the installer at all


class Forward(Base):
    def test_happy_path_quarantine_running_writes_not_resumed(s):
        units = {p: s.w.get(p) for p in s.w.plan["unitFiles"]}
        doc = s.w.inst.apply(OP, s.ps)
        f = doc["facts"]
        s.assertEqual(doc["phase"], "quarantine-running-gate-retained")
        for k in ("writesResumed", "intakeEnabled", "originalStarted", "coverageEvaluated",
                  "fundingConfigTreatedAsActivation", "launchOfOriginalPermitted"):
            s.assertIs(f[k], False, k)
        s.assertEqual(s.h.calls, ["daemon-reload", "start", "probe"])
        for n in NAMES:
            s.assertEqual(s.w.get(L.relay_dir + "/" + n), cand(n))
        for n in PROT:
            s.assertEqual(s.w.get(L.relay_dir + "/" + n), prot(n))
        for p, b in units.items():
            s.assertEqual(s.w.get(p), b)
        s.assertEqual(s.w.get(L.dropin_dir + "/" + s.w.plan["dropInName"]), q.dropin_bytes(OP))
        env = q.parse_env(s.h.environ(f["candidate"]["pid"]))
        s.assertEqual((env[b"SESSIONS_WRITE_QUARANTINE"], env[b"SESSIONS_FUNDING_INTAKE"]), (b"1", b"0"))
        s.assertEqual(s.w.get(JPATH), s.journal)
        s.assert_original_stopped_hold_retained()
        state = s.w.get(OD + "/install-r2/state.json")
        s.assertNotIn(SECRET, q.canon(doc) + state)
        s.assertEqual(stat.S_IMODE(os.stat(s.w.fs.p(OD)).st_mode), 0o700)
        s.assertEqual(stat.S_IMODE(os.stat(s.w.fs.p(OD + "/snapshots/pre-stop/environ.bin")).st_mode), 0o600)
        insp = s.w.inst.inspect(OP)
        s.assertEqual((insp["phase"], insp["stateSha256"], insp["leftoverTemps"]),
                      (doc["phase"], q.sha(state), []))
        s.refused("op-already-attempted", s.w.inst.apply, OP, s.ps)  # no blind rerun
        s.assertEqual(s.h.calls.count("start"), 1)

    def test_pid_reuse_is_a_different_process(s):
        s.h.procs[OLD["pid"]] = [OLD["startTicks"] + 77, b"UNRELATED=1\0", "/user.slice/other.scope"]
        s.h.start_pid = OLD["pid"]  # the candidate even receives the old PID number
        doc = s.w.inst.apply(OP, s.ps)
        s.assertEqual(doc["phase"], "quarantine-running-gate-retained")
        s.assertEqual(doc["facts"]["candidate"]["pid"], OLD["pid"])
        s.assertNotEqual(doc["facts"]["candidate"]["startTicks"], OLD["startTicks"])


class PreflightRefusals(Base):
    def test_active_old_writer_and_residual_identity_refused(s):
        s.h.procs[OLD["pid"]] = [OLD["startTicks"], b"X=1\0", CG]
        s.h.active, s.h.main, s.h.cgp[CG] = True, OLD["pid"], [OLD["pid"]]
        s.refused("service-not-inactive", s.w.inst.apply, OP, s.ps)
        s.h.active, s.h.main = False, 0
        s.refused("cgroup-not-empty", s.w.inst.apply, OP, s.ps)
        s.h.cgp[CG] = []
        s.refused("old-writer-identity-present", s.w.inst.apply, OP, s.ps)
        s.assert_nothing_installed()

    def test_source_drift(s):
        s.w.put(L.relay_dir + "/store.js", b"// drifted\n")
        s.refused("protected-drift", s.w.inst.apply, OP, s.ps)
        s.w.put(L.relay_dir + "/store.js", prot("store.js"))
        s.w.put(L.relay_dir + "/sessions.mjs", ORIG + b"//x\n")
        s.refused("source-drift", s.w.inst.apply, OP, s.ps)
        s.w.put(L.relay_dir + "/sessions.mjs", ORIG)
        s.w.put(L.stage_dir + "/fee-policy.mjs", b"// tampered stage\n")
        s.refused("stage-pin-mismatch", s.w.inst.apply, OP, s.ps)
        s.w.put(L.stage_dir + "/fee-policy.mjs", cand("fee-policy.mjs"))
        os.unlink(s.w.fs.p(L.stage_dir + "/funding-abi.mjs"))
        os.symlink(s.w.fs.p(L.relay_dir + "/api-relay.js"), s.w.fs.p(L.stage_dir + "/funding-abi.mjs"))
        s.refused("symlink-in-path", s.w.inst.apply, OP, s.ps)
        s.assert_nothing_installed()

    def test_dropin_drift(s):
        s.w.put(L.dropin_dir + "/99-new.conf", b"[Service]\n")
        s.refused("dropin-drift", s.w.inst.apply, OP, s.ps)
        os.unlink(s.w.fs.p(L.dropin_dir + "/99-new.conf"))
        s.w.put(L.dropin_dir + "/03-orig.conf", b"[Service]\nEnvironment=ORIG_3=changed\n")
        s.refused("unit-or-dropin-drift", s.w.inst.apply, OP, s.ps)
        s.assert_nothing_installed()

    def test_missing_or_stale_gate(s):
        s.h.gate["hash"] = "cfg-h2"
        s.refused("gate-cas-mismatch", s.w.inst.apply, OP, s.ps)
        s.h.gate = None
        s.refused("gate-not-owned", s.w.inst.apply, OP, s.ps)
        s.assert_nothing_installed()

    def test_missing_or_tampered_marker(s):
        s.w.put(s.w.marker["path"], q.canon({"op": "other-op-00000", "phase": "financial-hold"}), 0o600)
        s.refused("hold-marker-hash-mismatch", s.w.inst.apply, OP, s.ps)
        os.unlink(s.w.fs.p(s.w.marker["path"]))
        s.refused("hold-marker-missing", s.w.inst.apply, OP, s.ps)
        s.assert_nothing_installed()

    def test_missing_snapshots(s):
        # pre-stop is loaded before post-stop: damage post first, then the pre-stop pieces.
        post = OD + "/snapshots/post-stop/MANIFEST.json"
        post_bytes = s.w.get(post)
        os.unlink(s.w.fs.p(post))
        s.refused("snapshot-missing", s.w.inst.apply, OP, s.ps)
        s.w.put(post, post_bytes, 0o600)
        env = OD + "/snapshots/pre-stop/environ.bin"
        env_bytes = s.w.get(env)
        os.unlink(s.w.fs.p(env))
        s.refused("snapshot-environ-missing", s.w.inst.apply, OP, s.ps)
        s.w.put(env, env_bytes, 0o600)
        os.unlink(s.w.fs.p(OD + "/snapshots/pre-stop/files" + L.relay_dir + "/store.js"))
        s.refused("snapshot-copy-missing", s.w.inst.apply, OP, s.ps)
        s.assert_nothing_installed()

    def test_journal_changed_after_stop_refused(s):
        s.w.put(JPATH, b'{"txs":[{"nonce":8,"status":"sending"}]}')
        s.refused("financial-state-changed-after-stop", s.w.inst.apply, OP, s.ps)
        s.assert_nothing_installed()

    def test_lock_held_elsewhere_and_plan_pin(s):
        s.refused("plan-hash-mismatch", s.w.inst.apply, OP, "0" * 64)
        fd = os.open(s.w.fs.p(WATCH + "/activation.lock"), os.O_RDWR)
        try:
            fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
            s.refused("lock-not-acquired", s.w.inst.apply, OP, s.ps)
        finally:
            os.close(fd)
        s.assert_nothing_installed()

    def test_plan_schema_is_strict(s):
        p = json.loads(q.canon(s.w.plan))
        q.validate_plan(p, OP, PINS, L, NOW)
        s.refused("plan-schema", q.validate_plan, dict(p, coverageVerified=True), OP, PINS, L, NOW)
        closed = "funding-activation-r1-20261028"
        s.refused("op-invalid", q.validate_plan, dict(p, op=closed), closed, PINS, L, NOW)
        s.refused("plan-not-fresh", q.validate_plan, p, OP, PINS, L, p["expiresAtUnix"])
        bt = dict(p["baselineTargets"], **{"sessions.mjs": PINS.candidate["sessions.mjs"]})
        s.refused("baseline-not-original-sessions", q.validate_plan, dict(p, baselineTargets=bt), OP, PINS, L, NOW)


class AfterStartFailures(Base):
    def assert_candidate_stopped(s, e):
        s.assertEqual(e.facts["phase"], "failed-candidate-stopped-original-stopped")
        s.assertEqual(s.h.calls.count("stop"), 1)
        s.assertFalse(s.h.active)
        s.assert_original_stopped_hold_retained()

    def test_env_drift_stops_only_candidate_original_stays_stopped(s):
        s.h.extra_env = b"SURPRISE_FLAG=1\0"
        e = s.refused("candidate-environment", s.w.inst.apply, OP, s.ps)
        s.assertEqual(s.h.calls, ["daemon-reload", "start", "stop"])
        s.assert_candidate_stopped(e)
        s.assertEqual(s.w.get(JPATH), s.journal)
        s.assertNotIn(SECRET, q.canon(e.facts))

    def test_start_timeout_is_unknown_then_verified_candidate_stopped(s):
        def boom():
            raise subprocess.TimeoutExpired("systemctl", 210)
        s.h.on_start = boom
        s.assert_candidate_stopped(s.refused("TimeoutExpired", s.w.inst.apply, OP, s.ps))

    def test_quarantine_must_be_immutable_on(s):
        s.h.probe = {"writeQuarantine": True, "value": "invalid", "journal": {"persisted": False}}
        s.assert_candidate_stopped(s.refused("quarantine-not-immutable-on", s.w.inst.apply, OP, s.ps))

    def test_journal_written_after_start_is_preserved_not_restored(s):
        changed = b'{"txs":[{"nonce":7,"status":"mined"},{"nonce":8,"status":"sending"}]}'
        s.h.on_start = lambda: s.w.put(JPATH, changed)
        s.assert_candidate_stopped(s.refused("relayer-journal-changed", s.w.inst.apply, OP, s.ps))
        rb = s.w.inst.rollback(OP, s.w.inst.inspect(OP)["stateSha256"])
        s.assertEqual(rb["phase"], "rolled-back-stopped")
        s.assertEqual(s.w.get(JPATH), changed)  # current journal kept; never overwritten by a snapshot

    def test_wrong_candidate_identity_is_not_stopped(s):
        for kind in ("reused-invocation", "foreign-cgroup", "old-pid-and-ticks"):
            with s.subTest(kind=kind):
                s.tearDown()
                s.setUp()
                if kind == "reused-invocation":
                    s.h.start_inv = OLD["invocationId"]
                elif kind == "foreign-cgroup":
                    s.h.on_start = lambda: s.h.procs[s.h.main].__setitem__(2, "/user.slice/x.scope")
                else:
                    s.h.start_pid, s.h.start_ticks_v = OLD["pid"], OLD["startTicks"]
                e = s.refused("candidate-unverified-not-stopped", s.w.inst.apply, OP, s.ps)
                s.assertEqual(e.facts["phase"], "failed-ambiguous-retained")
                s.assertNotIn("stop", s.h.calls)
                s.assertEqual(s.h.calls.count("start"), 1)


class CrashAndRollback(Base):
    def test_crash_after_dropin_then_explicit_rollback(s):
        def hook(phase):
            if phase == "dropin-written":
                raise Crash()
        s.w.inst.hook = hook
        with s.assertRaises(Crash):
            s.w.inst.apply(OP, s.ps)
        s.w.inst.hook = None
        insp = s.w.inst.inspect(OP)
        s.assertEqual((insp["phase"], s.h.calls), ("dropin-written", []))
        s.refused("op-already-attempted", s.w.inst.apply, OP, s.ps)
        s.refused("state-cas-mismatch", s.w.inst.rollback, OP, "0" * 64)
        s.h.procs[4242], s.h.active, s.h.main, s.h.cgp[CG] = [1, b"", CG], True, 4242, [4242]
        s.refused("service-not-inactive", s.w.inst.rollback, OP, insp["stateSha256"])
        s.h.procs.pop(4242)
        s.h.active, s.h.main, s.h.cgp[CG] = False, 0, []
        rb = s.w.inst.rollback(OP, insp["stateSha256"])
        s.assertEqual(rb["phase"], "rolled-back-stopped")
        s.assertIs(rb["facts"]["launchPermitted"], False)
        s.assertEqual(s.w.get(L.relay_dir + "/sessions.mjs"), ORIG)
        for n in NAMES:
            if n != "sessions.mjs":
                s.assertFalse(os.path.lexists(s.w.fs.p(L.relay_dir + "/" + n)))
        s.assertFalse(os.path.lexists(s.w.fs.p(L.dropin_dir + "/" + s.w.plan["dropInName"])))
        s.assertEqual(s.h.calls, ["daemon-reload"])  # never start
        s.assertEqual(s.w.get(JPATH), s.journal)
        s.assert_original_stopped_hold_retained()

    def test_crash_mid_sources_then_rollback_by_cas(s):
        seen = []

        def hook(phase):
            seen.append(phase)
            if seen.count("sources-installing") == 2:
                raise Crash()
        s.w.inst.hook = hook
        with s.assertRaises(Crash):
            s.w.inst.apply(OP, s.ps)
        s.w.inst.hook = None
        insp = s.w.inst.inspect(OP)
        s.assertEqual(insp["facts"]["installed"], ["fee-policy.mjs"])
        rb = s.w.inst.rollback(OP, insp["stateSha256"])
        s.assertEqual(rb["facts"]["restored"], ["fee-policy.mjs"])
        s.assertNotIn("start", s.h.calls)

    def test_interrupted_temp_is_retained_and_refuses(s):
        tmp = L.relay_dir + "/.sessions.mjs.qr2.tmp"
        s.w.put(tmp, b"partial")
        s.refused("interrupted-temp-retained", s.w.inst.apply, OP, s.ps)
        s.assertEqual(s.w.get(tmp), b"partial")
        insp = s.w.inst.inspect(OP)
        s.assertEqual(insp["phase"], "failed-before-start-retained")
        s.assertIn(tmp, insp["leftoverTemps"])
        s.assertEqual(s.h.calls, [])
        s.assertEqual(s.w.get(L.relay_dir + "/sessions.mjs"), ORIG)


class Pure(unittest.TestCase):
    def test_env_rules_and_intake_off(s):
        inv = "b" * 32
        orig = b"A=1\0INVOCATION_ID=" + b"a" * 32 + b"\0"
        ok = b"A=1\0INVOCATION_ID=" + inv.encode() + b"\0SESSIONS_WRITE_QUARANTINE=1\0SESSIONS_FUNDING_INTAKE=0\0"
        added = dict(q.DROPIN_ENV)
        s.assertEqual(q.env_problems(orig, ok, added, inv), [])
        s.assertIn("added-key-value", q.env_problems(orig, ok.replace(b"INTAKE=0", b"INTAKE=1"), added, inv))
        s.assertIn("values-differ:1", q.env_problems(orig, ok.replace(b"A=1", b"A=2"), added, inv))
        s.assertIn("original-has-added-key",
                   q.env_problems(orig + b"SESSIONS_FUNDING_INTAKE=1\0", ok, added, inv))
        with s.assertRaises(q.Refusal):
            q.parse_env(b"A=1\0A=2\0")
        d = q.dropin_bytes(OP)
        s.assertEqual(d.count(b"Environment="), 2)
        for bad in (b"SESSIONS_FUNDING_MANIFEST", b"FEE_POLICY", b"OWNER_CONTROLS"):
            s.assertNotIn(bad, d)
        s.assertTrue(q.quarantine_probe_ok({"writeQuarantine": True, "value": "1", "journal": {"persisted": False}}))
        s.assertFalse(q.quarantine_probe_ok({"funding": {"intake": True}}))  # config GET is not activation

    def test_cli_root_policy(s):
        with tempfile.TemporaryDirectory() as t:
            buf = io.StringIO()
            s.assertEqual(q.main(["--root", t, "inspect", "--op", OP], out=buf), 2)
            s.assertEqual(json.loads(buf.getvalue())["refusal"], "non-default-root-is-library-only")
        buf = io.StringIO()
        s.assertEqual(q.main(["--root", "/", "apply", "--op", OP, "--plan-sha256", "0" * 64], out=buf), 2)
        s.assertIn(json.loads(buf.getvalue())["refusal"], ("default-root-needs-root-uid", "default-root-needs-apply"))


if __name__ == "__main__":
    unittest.main()
