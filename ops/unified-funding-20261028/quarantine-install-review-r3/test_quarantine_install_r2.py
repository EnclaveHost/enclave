"""Unit tests: owned temp filesystem root + FakeHost.

FakeHost is a UNIT-TEST ADAPTER ONLY. It simulates systemd/proc/cgroup/gate/probe answers and proves nothing about the
production host, the live relay, checkpoint coverage or the nonce tail. Its systemd merge/exec model (Environment=, then
EnvironmentFile= overriding it, then `/usr/bin/env NAME=VALUE` overriding both before the runtime is exec'd) follows
documented semantics but is a model, not evidence. Nothing here touches systemd, /proc, sockets or network.
ActualHelperShapes imports the pinned session_gate.py SOURCE and runs its own main() with all Caddy/socket/state IO
replaced in-process; it is skipped if that source is not present.
"""
import contextlib
import fcntl
import importlib.util
import io
import json
import os
import stat
import subprocess
import sys
import tempfile
import unittest
from types import SimpleNamespace

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import quarantine_install_r2 as q  # noqa: E402

NAMES = sorted(["sessions.mjs", "funding-route.mjs", "funding-activation.mjs", "fee-policy.mjs", "funding-abi.mjs"])
PROT = sorted(["api-relay.js", "sessions-abi.mjs", "snp-verify.mjs", "store.js"])
cand = lambda n: ("// candidate %s\n" % n).encode()  # noqa: E731
prot = lambda n: ("// protected %s\n" % n).encode()  # noqa: E731
ORIG = b"// original sessions.mjs\n"
NODE = "/usr/bin/node"
ARGV = (NODE, "/opt/nan-relay/api-relay.js")
API_ENV, SPONSOR_ENV, CLIENTS_ENV = "/etc/nan-relay/api-relay.env", "/etc/nan-relay/host-sponsor.env", "/etc/enclave-rpc/clients.env"
ENVFILES = ((API_ENV, False), (SPONSOR_ENV, True), (CLIENTS_ENV, False))
HELPER_BYTES = b"# unit-test stand-in bytes for the gate helper pin check\n"
WRAPPER_BYTES, NODE_BYTES = b"fake env binary bytes\n", b"fake node runtime bytes\n"
PINS = q.Pins(candidate={n: q.sha(cand(n)) for n in NAMES}, protected={n: q.sha(prot(n)) for n in PROT},
              original_sessions=q.sha(ORIG), gate_helper=q.sha(HELPER_BYTES), exec_argv=ARGV, environment_files=ENVFILES)
SECRET = b"relay-secret-value-never-printed"
OP = "quarantine-r2-test-0001"
GATE_ID = q.GATE_ID_PREFIX + OP
ROUTES1 = q.sha(b"routes-1")
CG = "/system.slice/enclave-api-relay.service"
OLD = {"pid": 228946, "startTicks": 5550001, "bootId": "11111111-2222-3333-4444-555555555555", "controlGroup": CG,
       "invocationId": "a" * 32}
BASE = {k: OLD[k] for k in ("pid", "startTicks", "bootId")}
L = q.Layout()
WATCH = "/var/lib/enclave-maintenance/watch/" + OP
OD = L.ops_root + "/" + OP
JPATH = L.state_dir + "/" + q.JOURNAL
NOW = 1_800_000_000
UNIT = ("[Service]\nEnvironmentFile=%s\nEnvironmentFile=-%s\nEnvironmentFile=%s\nExecStart=%s\n"
        % (API_ENV, SPONSOR_ENV, CLIENTS_ENV, " ".join(ARGV))).encode()
LATE_DROPIN = ("[Service]\nExecStart=\nExecStart=%s\n" % " ".join(ARGV)).encode()
QUARANTINE_OFF = b"SESSIONS_WRITE_QUARANTINE=0\nSESSIONS_FUNDING_INTAKE=1\n"
flags = lambda env: (env[b"SESSIONS_WRITE_QUARANTINE"], env[b"SESSIONS_FUNDING_INTAKE"])  # noqa: E731


class Crash(BaseException):
    """Simulated process death: bypasses every `except Exception` handler."""


class FakeHost:
    def __init__(s, w):
        s.w, s.calls, s.boot = w, [], OLD["bootId"]
        s.loaded = s.read_loaded()
        s.active, s.main, s.inv = True, OLD["pid"], OLD["invocationId"]
        env, exe = s.compose(OLD["invocationId"])
        s.procs = {OLD["pid"]: [OLD["startTicks"], env, CG, exe]}
        s.cgp = {CG: [OLD["pid"]]}
        # gate state rendered in the pinned session_gate.py output shapes, read through the REAL adapter method
        s.routes_sha, s.etag, s.gate_ids, s.gate_phase, s.owned_exact = ROUTES1, '"e1"', [GATE_ID], "gate-verified", True
        s.status_routes_sha = None  # set to simulate a route edit between the inspect and status reads
        s.adapter = q.SystemdHost(q.Layout(gate_helper=w.fs.p(L.gate_helper)), PINS)
        s.adapter._run = s.helper_run
        s.probe = {"writeQuarantine": True, "value": "1", "journal": {"persisted": False}}
        s.start_pid, s.start_ticks_v, s.start_inv, s.extra_env = 300001, 9990001, "b" * 32, b""
        s.on_start = s.on_probe = s.start_error = s.exec_env = None

    def read_loaded(s):  # systemd caches unit + drop-in contents at daemon-reload
        paths = [L.unit_file] + [L.dropin_dir + "/" + n for n in sorted(os.listdir(s.w.fs.p(L.dropin_dir)))]
        return {p: s.w.get(p) for p in paths}

    def merged(s):
        """FAKE model of systemd merging the LOADED unit then drop-ins in name order: later Environment= wins, an empty
        ExecStart=/EnvironmentFile= resets the list."""
        env, files, argv = {}, [], None
        for p in [L.unit_file] + sorted(x for x in s.loaded if x != L.unit_file):
            for line in s.loaded[p].decode().splitlines():
                k, _, v = line.partition("=")
                if k == "Environment":
                    n, _, val = v.strip('"').partition("=")
                    env[n] = val
                elif k == "EnvironmentFile":
                    files = files + [[v.lstrip("-"), v.startswith("-")]] if v else []
                elif k == "ExecStart":
                    argv = v.split() or None
        return env, files, argv

    def compose(s, inv):
        """FAKE exec model: Environment=, then each EnvironmentFile= overriding it, then systemd's per-invocation keys,
        then `/usr/bin/env NAME=VALUE...` overriding all of those immediately before the runtime is exec'd."""
        base, files, argv = s.merged()
        env = dict({"PATH": "/usr/bin"}, **base)
        for path, ignore in files:
            if not os.path.exists(s.w.fs.p(path)):
                assert ignore, path
                continue
            for line in s.w.get(path).decode().splitlines():
                n, _, val = line.partition("=")
                if n:
                    env[n] = val
        env.update(INVOCATION_ID=inv, JOURNAL_STREAM="8:%d" % len(s.calls))
        if argv[0] == q.WRAPPER:
            argv = argv[1:]
            while "=" in argv[0]:
                n, _, val = argv.pop(0).partition("=")
                env[n] = val
        return b"".join(("%s=%s" % kv).encode() + b"\0" for kv in env.items()), argv[0]

    def show(s, unit):
        _, files, argv = s.merged()
        return {"ActiveState": "active" if s.active else "inactive", "SubState": "running" if s.active else "dead",
                "MainPID": s.main if s.active else 0, "ControlGroup": CG if s.active else "", "InvocationID": s.inv,
                "DropInPaths": sorted(p for p in s.loaded if p != L.unit_file), "Result": "success",
                "ExecStart": [{"path": argv[0], "argv": list(argv), "ignoreErrors": False}] if argv else [],
                "EnvironmentFiles": files}

    def cgroup_pids(s, cg):
        return list(s.cgp.get(cg, []))

    def start_ticks(s, pid):
        return s.procs[pid][0] if pid in s.procs else None

    def environ(s, pid):
        return s.procs[pid][1]

    def proc_cgroup(s, pid):
        return s.procs[pid][2]

    def exe(s, pid):
        return s.procs[pid][3]

    def boot_id(s):
        return s.boot

    def daemon_reload(s):
        s.calls.append("daemon-reload")
        s.loaded = s.read_loaded()

    def start(s, unit):
        s.calls.append("start")
        if s.start_error:
            raise s.start_error
        env, exe = s.compose(s.start_inv)
        env += s.extra_env
        s.exec_env = q.parse_env(env)  # what the runtime received at exec, before any of its own code ran
        s.active, s.main, s.inv = True, s.start_pid, s.start_inv
        s.procs[s.start_pid] = [s.start_ticks_v, env, CG, exe]
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

    def helper_run(s, argv, timeout):
        """Renders the pinned session_gate.py `inspect` / `status --op` output shapes from the fake route state."""
        if argv[2:] == ["inspect"]:
            return json.dumps({"routesSha256": s.routes_sha, "etag": s.etag, "gateIds": list(s.gate_ids),
                               "upstreams": []})
        assert argv[2:] == ["status", "--op", OP], argv
        if s.gate_phase is None:  # no owned op state: the helper raises and exits non-zero
            raise subprocess.CalledProcessError(1, argv)
        return json.dumps({"phase": s.gate_phase, "ownedGateExact": s.owned_exact, "gateAbsent": not s.gate_ids,
                           "routesSha256": s.status_routes_sha or s.routes_sha, "matchesBefore": False, "etag": s.etag})

    def gate_status(s, op):
        return s.adapter.gate_status(op)

    def quarantine_probe(s, port):
        s.calls.append("probe")
        if s.on_probe:
            s.on_probe()
        return s.probe


class World:
    def __init__(s, tmp, late=False):
        s.fs = q.FS(tmp, os.getuid())
        for n in PROT:
            s.put(L.relay_dir + "/" + n, prot(n))
        s.put(L.relay_dir + "/sessions.mjs", ORIG)
        for n in NAMES:
            s.put(L.stage_dir + "/" + n, cand(n))
        s.put(L.unit_file, UNIT)
        for i in range(10):
            if late and i == 9:
                s.put(L.dropin_dir + "/zzz-late.conf", LATE_DROPIN)  # sorts AFTER zz-quarantine-r2-*
            else:
                s.put("%s/%02d-orig.conf" % (L.dropin_dir, i), b"[Service]\nEnvironment=ORIG_%d=v%d\n" % (i, i))
        s.put(API_ENV, b"RELAY_PRIVATE_KEY=" + SECRET + b"\nORIG_0=from-environment-file\n", 0o600)
        s.put(CLIENTS_ENV, b"CLIENTS=c1,c2\n", 0o600)  # SPONSOR_ENV stays absent: ignoreErrors=yes
        s.put(q.WRAPPER, WRAPPER_BYTES, 0o755)
        s.put(NODE, NODE_BYTES, 0o755)
        s.put(L.gate_helper, HELPER_BYTES)
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
                  "unitFiles": {p: q.sha(s.get(p)) for p in s.host.read_loaded()},
                  "dropInName": "zz-quarantine-r2-%s.conf" % OP, "lockPath": WATCH + "/activation.lock",
                  "gate": {"hash": ROUTES1, "etag": '"e1"'}, "holdMarker": s.marker, "stopRecord": stop,
                  "checkpointEvidence": ckpt, "preStopSnapshotSha256": pre, "postStopSnapshotSha256": post,
                  "probePort": 8787, "launch": {"wrapperSha256": q.sha(WRAPPER_BYTES), "runtimeSha256": q.sha(NODE_BYTES)}}
        s.put(OD + "/plan.json", q.canon(s.plan), 0o600)
        return q.sha(q.canon(s.plan))


class Base(unittest.TestCase):
    LATE = False

    def setUp(s):
        s.tmp = tempfile.TemporaryDirectory()
        s.w = World(s.tmp.name, late=s.LATE)
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
        s.assertEqual(s.h.gate_ids, [GATE_ID])  # no gate-removal call exists in the installer at all


class Forward(Base):
    def test_happy_path_quarantine_running_writes_not_resumed(s):
        units = {p: s.w.get(p) for p in s.w.plan["unitFiles"]}
        envfiles = {p: s.w.get(p) for p in (API_ENV, CLIENTS_ENV)}
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
        for p, b in list(units.items()) + list(envfiles.items()):
            s.assertEqual(s.w.get(p), b)
        s.assertFalse(os.path.lexists(s.w.fs.p(SPONSOR_ENV)))
        s.assertEqual(s.w.get(L.dropin_dir + "/" + s.w.plan["dropInName"]), q.dropin_bytes(OP, ARGV))
        shown = s.h.show(L.unit)
        s.assertEqual(shown["EnvironmentFiles"], [[p, i] for p, i in ENVFILES])  # original EnvironmentFiles kept
        s.assertEqual(shown["ExecStart"][0]["argv"], list(q.wrapped_argv(ARGV)))
        cpid = f["candidate"]["pid"]
        s.assertEqual(s.h.exe(cpid), NODE)
        s.assertEqual(flags(q.parse_env(s.h.environ(cpid))), (b"1", b"0"))
        s.assertEqual(f["candidateBinding"]["pid"], cpid)
        s.assertEqual(s.w.get(JPATH), s.journal)
        s.assert_original_stopped_hold_retained()
        state = s.w.get(OD + "/install-r2/state.json")
        insp = s.w.inst.inspect(OP)
        for label in ("pre-stop", "post-stop"):
            s.assertNotIn(SECRET, s.w.get("%s/snapshots/%s/MANIFEST.json" % (OD, label)))
        s.assertNotIn(SECRET, q.canon(doc) + state + q.canon(insp))
        s.assertEqual(stat.S_IMODE(os.stat(s.w.fs.p(OD)).st_mode), 0o700)
        for a in ("/snapshots/pre-stop/environ.bin", "/snapshots/pre-stop/files" + API_ENV):
            s.assertEqual(stat.S_IMODE(os.stat(s.w.fs.p(OD + a)).st_mode), 0o600)
        s.assertEqual((insp["phase"], insp["stateSha256"], insp["leftoverTemps"]),
                      (doc["phase"], q.sha(state), []))
        s.refused("op-already-attempted", s.w.inst.apply, OP, s.ps)  # no blind rerun
        s.assertEqual(s.h.calls.count("start"), 1)

    def test_pid_reuse_is_a_different_process(s):
        s.h.procs[OLD["pid"]] = [OLD["startTicks"] + 77, b"UNRELATED=1\0", "/user.slice/other.scope", "/usr/bin/other"]
        s.h.start_pid = OLD["pid"]  # the candidate even receives the old PID number
        doc = s.w.inst.apply(OP, s.ps)
        s.assertEqual(doc["phase"], "quarantine-running-gate-retained")
        s.assertEqual(doc["facts"]["candidate"]["pid"], OLD["pid"])
        s.assertNotEqual(doc["facts"]["candidate"]["startTicks"], OLD["startTicks"])


class PreExecQuarantine(Base):
    def test_fake_model_environment_file_beats_environment_but_not_the_wrapper(s):
        """Why r2's Environment= drop-in was insufficient, shown in the FAKE systemd model only (not production proof)."""
        s.w.put(API_ENV, s.w.get(API_ENV) + QUARANTINE_OFF, 0o600)
        dp = L.dropin_dir + "/zz-model.conf"
        s.w.put(dp, b'[Service]\nEnvironment="SESSIONS_WRITE_QUARANTINE=1"\nEnvironment="SESSIONS_FUNDING_INTAKE=0"\n')
        s.h.loaded = s.h.read_loaded()
        s.assertEqual(flags(q.parse_env(s.h.compose("c" * 32)[0])), (b"0", b"1"))
        s.w.put(dp, q.dropin_bytes(OP, ARGV))
        s.h.loaded = s.h.read_loaded()
        env, exe = s.h.compose("c" * 32)
        s.assertEqual((flags(q.parse_env(env)), exe), ((b"1", b"0"), NODE))

    def test_environment_files_pinned_before_any_start(s):
        cases = {
            "quarantine-off-appended": lambda: s.w.put(API_ENV, s.w.get(API_ENV) + QUARANTINE_OFF, 0o600),
            "mode-changed": lambda: os.chmod(s.w.fs.p(API_ENV), 0o644),
            "ignored-file-appeared": lambda: s.w.put(SPONSOR_ENV, b"SESSIONS_WRITE_QUARANTINE=0\n", 0o600),
            "required-file-removed": lambda: os.unlink(s.w.fs.p(CLIENTS_ENV)),
        }
        for kind, mutate in cases.items():
            with s.subTest(kind=kind):
                s.tearDown()
                s.setUp()
                mutate()
                s.refused("environment-file-drift", s.w.inst.apply, OP, s.ps)
                s.assert_nothing_installed()

    def test_environment_file_swapped_after_last_check_cannot_start_writer_with_quarantine_off(s):
        def hook(phase):
            if phase == "start-unknown":  # after every pre-start check, before systemd reads EnvironmentFiles
                s.w.put(API_ENV, s.w.get(API_ENV) + QUARANTINE_OFF, 0o600)
        s.w.inst.hook = hook
        e = s.refused("environment-file-drift", s.w.inst.apply, OP, s.ps)
        s.assertEqual(flags(s.h.exec_env), (b"1", b"0"))  # in force at exec, before any relay code
        s.assertEqual(e.facts["phase"], "failed-candidate-stopped-original-stopped")
        s.assertEqual(s.h.calls, ["daemon-reload", "start", "stop"])
        s.assert_original_stopped_hold_retained()

    def test_wrapper_and_runtime_are_pinned(s):
        s.w.put(q.WRAPPER, b"other env binary\n", 0o755)
        s.assertEqual(s.refused("launch-binary-drift", s.w.inst.apply, OP, s.ps).facts["name"], "wrapper")
        s.w.put(q.WRAPPER, WRAPPER_BYTES, 0o777)
        s.refused("launch-binary-not-owned", s.w.inst.apply, OP, s.ps)
        s.w.put(q.WRAPPER, WRAPPER_BYTES, 0o755)
        s.w.put(NODE, b"other node runtime\n", 0o755)
        s.assertEqual(s.refused("launch-binary-drift", s.w.inst.apply, OP, s.ps).facts["name"], "runtime")
        s.assert_nothing_installed()


class LateDropinOverride(Base):
    LATE = True

    def test_later_sorting_dropin_resetting_execstart_refused_before_start(s):
        e = s.refused("loaded-launch-config-mismatch", s.w.inst.apply, OP, s.ps)
        s.assertEqual(s.h.calls, ["daemon-reload"])
        s.assertEqual(s.w.inst.inspect(OP)["phase"], "failed-before-start-retained")
        s.assertNotIn("phase", e.facts)
        s.assertFalse(s.h.active)


class PreflightRefusals(Base):
    def test_active_old_writer_and_residual_identity_refused(s):
        s.h.procs[OLD["pid"]] = [OLD["startTicks"], b"X=1\0", CG, NODE]
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

    def test_missing_or_stale_gate_via_helper_shapes(s):
        s.h.routes_sha = q.sha(b"routes-2")
        s.refused("gate-cas-mismatch", s.w.inst.apply, OP, s.ps)
        s.h.routes_sha, s.h.status_routes_sha = ROUTES1, q.sha(b"routes-2")  # inspect and status reads disagree
        s.refused("gate-cas-mismatch", s.w.inst.apply, OP, s.ps)
        s.h.status_routes_sha, s.h.gate_ids, s.h.owned_exact = None, [], False
        s.refused("gate-not-owned", s.w.inst.apply, OP, s.ps)
        s.h.gate_ids, s.h.owned_exact, s.h.gate_phase = [GATE_ID], True, None
        s.refused("gate-helper-failed", s.w.inst.apply, OP, s.ps)
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
        os.unlink(s.w.fs.p(OD + "/snapshots/pre-stop/files" + API_ENV))
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
        s.refused("plan-schema", q.validate_plan, dict(p, gate={"hash": "cfg-h1", "etag": '"e1"'}), OP, PINS, L, NOW)
        s.refused("plan-schema", q.validate_plan, dict(p, launch={"wrapperSha256": "0" * 64}), OP, PINS, L, NOW)
        s.refused("exec-argv-invalid", q.validate_plan, p, OP, q.Pins(PINS.candidate, PINS.protected,
                  PINS.original_sessions, PINS.gate_helper), L, NOW)


class AfterStartFailures(Base):
    def assert_candidate_stopped(s, e):
        s.assertEqual(e.facts["phase"], "failed-candidate-stopped-original-stopped")
        s.assertEqual(s.h.calls.count("stop"), 1)
        s.assertFalse(s.h.active)
        s.assert_original_stopped_hold_retained()

    def assert_retained_manual(s, e, phase, simulated_old_identity=False):
        s.assertEqual(e.facts["phase"], phase)
        s.assertNotIn("stop", s.h.calls)
        s.assertEqual(s.h.calls.count("start"), 1)
        s.assertTrue(s.h.active)  # whatever is running is left alone for manual reconciliation
        s.assertIs(s.w.inst.inspect(OP)["facts"]["manualReconciliationRequired"], True)
        if simulated_old_identity:
            # This negative fixture deliberately resurrects the exact old identity.
            # Prove refusal/no stop and retained barriers, not its contradictory absence.
            s.assertEqual(s.h.procs[OLD["pid"]][0], OLD["startTicks"])
            s.assertEqual(q.sha(s.w.get(s.w.marker["path"])), s.w.marker["sha256"])
            s.assertEqual(s.h.gate_ids, [GATE_ID])
        else:
            s.assert_original_stopped_hold_retained()

    def test_env_drift_stops_only_bound_candidate_original_stays_stopped(s):
        s.h.extra_env = b"SURPRISE_FLAG=1\0"
        e = s.refused("candidate-environment", s.w.inst.apply, OP, s.ps)
        s.assertEqual(s.h.calls, ["daemon-reload", "start", "stop"])
        s.assert_candidate_stopped(e)
        s.assertEqual(s.w.get(JPATH), s.journal)
        s.assertNotIn(SECRET, q.canon(e.facts))

    def test_start_timeout_is_unknown_and_grants_no_stop_authority(s):
        def boom():
            raise subprocess.TimeoutExpired("systemctl", 210)
        s.h.on_start = boom  # a new invocation IS running, with matching INVOCATION_ID and flags
        e = s.refused("candidate-unbound-not-stopped", s.w.inst.apply, OP, s.ps)
        s.assertEqual(e.facts["cause"], "TimeoutExpired")
        s.assert_retained_manual(e, "failed-unknown-retained-manual-reconciliation")

    def test_start_failed_and_nothing_running(s):
        s.h.start_error = subprocess.CalledProcessError(1, ["systemctl", "start"])
        e = s.refused("CalledProcessError", s.w.inst.apply, OP, s.ps)
        s.assertEqual(e.facts["phase"], "failed-candidate-not-running-original-stopped")
        s.assertNotIn("stop", s.h.calls)
        s.assert_original_stopped_hold_retained()

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

    def test_unbound_candidate_identity_is_not_stopped(s):
        for kind in ("reused-invocation", "foreign-cgroup", "old-pid-and-ticks", "exe-not-runtime"):
            with s.subTest(kind=kind):
                s.tearDown()
                s.setUp()
                if kind == "reused-invocation":
                    s.h.start_inv = OLD["invocationId"]
                elif kind == "foreign-cgroup":
                    s.h.on_start = lambda: s.h.procs[s.h.main].__setitem__(2, "/user.slice/x.scope")
                elif kind == "exe-not-runtime":
                    s.h.on_start = lambda: s.h.procs[s.h.main].__setitem__(3, q.WRAPPER)
                else:
                    s.h.start_pid, s.h.start_ticks_v = OLD["pid"], OLD["startTicks"]
                e = s.refused("candidate-unbound-not-stopped", s.w.inst.apply, OP, s.ps)
                s.assert_retained_manual(e, "failed-unknown-retained-manual-reconciliation", simulated_old_identity=(kind == "old-pid-and-ticks"))

    def test_bound_candidate_replaced_before_cleanup_is_not_stopped(s):
        def concurrent_restart():  # same config, NEW invocation: no longer the bound candidate
            s.h.procs.pop(s.h.main)
            env, exe = s.h.compose("c" * 32)
            s.h.procs[300002] = [9990002, env, CG, exe]
            s.h.main, s.h.inv, s.h.cgp[CG] = 300002, "c" * 32, [300002]
        s.h.on_probe = concurrent_restart
        s.h.probe = {"writeQuarantine": False}
        e = s.refused("candidate-unverified-not-stopped", s.w.inst.apply, OP, s.ps)
        s.assert_retained_manual(e, "failed-ambiguous-retained-manual-reconciliation")


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
        s.h.procs[4242], s.h.active, s.h.main, s.h.cgp[CG] = [1, b"", CG, NODE], True, 4242, [4242]
        s.refused("service-not-inactive", s.w.inst.rollback, OP, insp["stateSha256"])
        s.h.procs.pop(4242)
        s.h.active, s.h.main, s.h.cgp[CG] = False, 0, []
        envfiles = {p: s.w.get(p) for p in (API_ENV, CLIENTS_ENV)}
        rb = s.w.inst.rollback(OP, insp["stateSha256"])
        s.assertEqual(rb["phase"], "rolled-back-stopped")
        s.assertIs(rb["facts"]["launchPermitted"], False)
        s.assertEqual(s.w.get(L.relay_dir + "/sessions.mjs"), ORIG)
        for n in NAMES:
            if n != "sessions.mjs":
                s.assertFalse(os.path.lexists(s.w.fs.p(L.relay_dir + "/" + n)))
        s.assertFalse(os.path.lexists(s.w.fs.p(L.dropin_dir + "/" + s.w.plan["dropInName"])))
        s.assertEqual(s.h.show(L.unit)["ExecStart"][0]["argv"], list(ARGV))
        s.assertEqual({p: s.w.get(p) for p in envfiles}, envfiles)
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


class AdapterShapes(unittest.TestCase):
    # ASSUMED systemd `show` text shapes; root must compare with live read-only output before relying on parse_show.
    SHOW = ("MainPID=0\nActiveState=inactive\nSubState=dead\nControlGroup=\nInvocationID=\n"
            "DropInPaths=/etc/systemd/system/enclave-api-relay.service.d/a.conf\nResult=success\n"
            "ExecStart={ path=/usr/bin/env ; argv[]=/usr/bin/env SESSIONS_WRITE_QUARANTINE=1 SESSIONS_FUNDING_INTAKE=0 "
            "/usr/bin/node /opt/nan-relay/api-relay.js ; ignore_errors=no ; start_time=[n/a] ; stop_time=[n/a] ; "
            "pid=0 ; code=(null) ; status=0/0 }\n"
            "EnvironmentFiles=/etc/nan-relay/api-relay.env (ignore_errors=no)\n"
            "EnvironmentFiles=/etc/nan-relay/host-sponsor.env (ignore_errors=yes)\n")

    def refused(s, code, fn, *a):
        with s.assertRaises(q.Refusal) as cm:
            fn(*a)
        s.assertEqual(cm.exception.code, code)

    def test_show_parsing_of_assumed_systemd_shapes(s):
        seen = []
        host = q.SystemdHost(L, PINS)
        host._run = lambda argv, timeout: seen.append(argv) or s.SHOW
        d = host.show(L.unit)
        s.assertIn("ExecStart", seen[0])
        s.assertIn("EnvironmentFiles", seen[0])
        s.assertEqual(d["ExecStart"], [{"path": q.WRAPPER, "argv": list(q.wrapped_argv(ARGV)), "ignoreErrors": False}])
        s.assertEqual(d["EnvironmentFiles"], [[API_ENV, False], [SPONSOR_ENV, True]])
        s.refused("show-unparsed", q.parse_show, s.SHOW.replace("ignore_errors=no ; start", "ignore_errors=? ; start"))
        two = s.SHOW.replace(" }\n", " } ; { path=/x ; argv[]=/x ; ignore_errors=no ; pid=0 }\n", 1)
        s.refused("execstart-not-single", q.Installer(None, None, L, PINS)._launch_config, q.parse_show(two))

    def test_gate_status_reads_routesSha256_and_keeps_both_reads(s):
        with tempfile.TemporaryDirectory() as d:
            path = os.path.join(d, "gate.py")
            with open(path, "wb") as f:
                f.write(HELPER_BYTES)
            host = q.SystemdHost(q.Layout(gate_helper=path), PINS)
            replies = {"inspect": {"routesSha256": ROUTES1, "etag": '"e1"', "gateIds": [GATE_ID], "upstreams": []},
                       "status": {"phase": "gate-verified", "ownedGateExact": True, "gateAbsent": False,
                                  "routesSha256": ROUTES1, "matchesBefore": False, "etag": '"e1"'}}
            host._run = lambda argv, timeout: json.dumps(replies[argv[2]])
            g = host.gate_status(OP)
            s.assertEqual((g["hash"], g["etag"], g["statusHash"], g["statusEtag"], g["gateIds"]),
                          (ROUTES1, '"e1"', ROUTES1, '"e1"', [GATE_ID]))
            replies["inspect"] = {"hash": ROUTES1, "etag": '"e1"'}  # the r2 assumption: no such helper field
            s.refused("gate-helper-shape", host.gate_status, OP)

            def fail(argv, timeout):
                raise subprocess.TimeoutExpired(argv, timeout)
            host._run = fail
            s.refused("gate-helper-failed", host.gate_status, OP)
            with open(path, "ab") as f:
                f.write(b"#")
            s.refused("gate-helper-pin", host.gate_status, OP)


GATE_SOURCE = os.environ.get("SESSION_GATE_SOURCE", "/home/steven/Documents/Codex/2026-10-23/it/work/"
                             "restore-queued-20261028/session-gate-source/session_gate.py")


@unittest.skipUnless(os.path.isfile(GATE_SOURCE), "pinned session_gate.py source not present")
class ActualHelperShapes(unittest.TestCase):
    """Runs the pinned helper's own main(); read_routes/api/secure_dir/load are replaced in-process (no socket/state)."""

    def helper(s):
        spec = importlib.util.spec_from_file_location("session_gate_under_test", GATE_SOURCE)
        m = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(m)
        s.routes = [m.gate_route(OP), {"@id": "unrelated-route"}]
        m.read_routes = lambda: (s.routes, '"etag-1"')
        m.api = lambda method, path, value=None, etag=None: ([], None)
        m.secure_dir = lambda path, create=False: None
        m.load = lambda path: {"phase": "gate-verified", "beforeHash": "0" * 64}
        return m

    def run_main(s, m, args):
        out, saved = io.StringIO(), sys.argv
        sys.argv = ["session_gate.py"] + list(args)
        try:
            with contextlib.redirect_stdout(out):
                m.main()
        finally:
            sys.argv = saved
        return out.getvalue()

    def test_source_matches_production_pin(s):
        with open(GATE_SOURCE, "rb") as f:
            s.assertEqual(q.sha(f.read()), q.PRODUCTION_PINS.gate_helper)

    def test_adapter_and_cas_on_actual_helper_output(s):
        m = s.helper()
        s.assertEqual(m.gate_route(OP)["@id"], GATE_ID)
        with tempfile.TemporaryDirectory() as d:
            path = os.path.join(d, "gate.py")
            with open(path, "wb") as f:
                f.write(HELPER_BYTES)
            host = q.SystemdHost(q.Layout(gate_helper=path), PINS)
            host._run = lambda argv, timeout: s.run_main(m, argv[2:])
            g = host.gate_status(OP)
            want = m.digest(s.routes)
            s.assertEqual((g["hash"], g["etag"], g["statusHash"], g["statusEtag"]), (want, '"etag-1"', want, '"etag-1"'))
            s.assertEqual((g["phase"], g["ownedGateExact"], g["gateAbsent"], g["gateIds"]),
                          ("gate-verified", True, False, [GATE_ID]))
            inst = q.Installer(None, SimpleNamespace(gate_status=lambda op: host.gate_status(op)), L, PINS)
            inst._require_gate(OP, {"gate": {"hash": want, "etag": '"etag-1"'}})
            with s.assertRaises(q.Refusal) as cm:
                inst._require_gate(OP, {"gate": {"hash": "0" * 64, "etag": '"etag-1"'}})
            s.assertEqual(cm.exception.code, "gate-cas-mismatch")
            s.routes[0] = dict(s.routes[0], terminal=False)  # owned route altered: no longer exact
            with s.assertRaises(q.Refusal) as cm:
                inst._require_gate(OP, {"gate": {"hash": m.digest(s.routes), "etag": '"etag-1"'}})
            s.assertEqual(cm.exception.code, "gate-not-owned")


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
        s.assertTrue(q.quarantine_probe_ok({"writeQuarantine": True, "value": "1", "journal": {"persisted": False}}))
        s.assertFalse(q.quarantine_probe_ok({"funding": {"intake": True}}))  # config GET is not activation

    def test_dropin_is_only_an_execstart_wrapper(s):
        d = q.dropin_bytes(OP, ARGV)
        directives = [x for x in d.splitlines() if not x.startswith(b"#")]
        s.assertEqual(directives, [b"[Service]", b"ExecStart=", b"ExecStart=/usr/bin/env SESSIONS_WRITE_QUARANTINE=1 "
                                   b"SESSIONS_FUNDING_INTAKE=0 /usr/bin/node /opt/nan-relay/api-relay.js"])
        for bad in ((NODE, "%h"), (NODE, "$X"), (NODE, "a b"), (NODE, "a;b"), ("node",), ()):
            with s.assertRaises(q.Refusal) as cm:
                q.wrapped_argv(bad)
            s.assertEqual(cm.exception.code, "exec-argv-invalid")
        s.assertEqual(q.PRODUCTION_PINS.exec_argv, ARGV)
        s.assertEqual(len(q.PRODUCTION_PINS.environment_files), 9)
        s.assertEqual([p for p, i in q.PRODUCTION_PINS.environment_files if i], [SPONSOR_ENV])

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
