"""Offline tests for safe_manager_switch.py.

Everything systemd/proc/pidfd-related goes through FakeHost. The only real processes are the
watchdog tests' own `sleep` child and watchdog. Nothing reads production state except the two
read-only fixtures in this directory (manager-argv-before.json, adopt-current-preflight.out).
"""
import hashlib
import json
import os
import signal
import stat
import subprocess
import sys
import tempfile
import time
import unittest
from pathlib import Path
from unittest import mock

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
import safe_manager_switch as S  # noqa: E402

REAL_ARGV = json.loads((HERE / "manager-argv-before.json").read_text())
REAL_DROPINS = [
    "70-protected-ports.conf", "80-shield-inference.conf", "90-tuna-egress.conf", "95-public-web.conf",
    "97-codegen.conf", "98-artifact-gateway.conf", "99-app-egress.conf", "zz-memory-budget64.conf",
    "zzz-eyesoff-vision.conf", "zzzz-pad-spill.conf", "zzzzz-custody.conf",
    "zzzzzzz-recovery-pad-location.conf", "zzzzzz-zimage.conf",
]
MPID, CONTROL, GUESTQ = 1000, 2000, 3000


def stat_line(pid, state, start):
    return f"{pid} (a) (b) {state} " + " ".join(["0"] * 18 + [str(start)] + ["0"] * 5)


def exec_show(argv):
    return f"{{ path={argv[0]} ; argv[]={' '.join(argv)} ; ignore_errors=no ; start_time=[n/a] ; pid=0 }}"


class FakeWatchdog:
    def __init__(self, fd, limit):
        self.fd, self.limit, self.released = fd, limit, False

    def release(self):
        self.released = True
        return "released sigcont=sent"


class FakeHost:
    def __init__(self, cfg, argv, env):
        self.cfg, self.base_argv, self.uid = cfg, argv, os.geteuid()
        self.procs = {
            MPID: {"argv": argv, "start": 111, "state": "S", "env": env, "adopts": True},
            CONTROL: {"argv": ["/usr/bin/qemu-system-x86_64", "-name", "guest=cx0"], "start": 222, "state": "S"},
            GUESTQ: {"argv": ["/usr/bin/qemu-system-x86_64", "-name", f"guest={cfg.guest}"], "start": 333, "state": "S"},
        }
        self.mpid, self.next_pid, self.clock = MPID, 5000, 0.0
        self.need_reload, self.props, self.history = "no", {}, "x ADOPT OK old\n"
        self.adopt = {"current": (0, f"log\nADOPT OK {cfg.guest}\n"), "candidate": (0, f"ADOPT OK {cfg.guest}\n")}
        self.new_adopts, self.down = True, False
        self.calls, self.signals, self.watchdogs, self.restarts = [], [], [], 0
        self.on = {}  # systemctl verb -> list of one-shot hooks
        self.on_pidfd_open = None
        self.loaded = self._scan()

    def _scan(self):
        names = sorted(n for n in os.listdir(self.cfg.dropin_dir) if n.endswith(".conf"))
        argv = self.base_argv
        for n in names:
            for line in (self.cfg.dropin_dir / n).read_text().splitlines():
                if line.startswith("ExecStart=") and line != "ExecStart=":
                    argv = S.systemd_split(line[len("ExecStart="):])
        return names, argv

    def run(self, argv, timeout, env=None):
        self.calls.append(argv)
        if argv[:2] == ["systemctl", "--user"]:
            verb = argv[2]
            hooks = self.on.get(verb)
            if hooks:
                r = hooks.pop(0)(self)
                if r is not None:
                    return r
            if verb == "show":
                names, ex = self.loaded
                vals = {"MainPID": str(self.mpid), "ActiveState": "active", "SubState": "running",
                        "NeedDaemonReload": self.need_reload, "ExecStart": exec_show(ex),
                        "DropInPaths": " ".join(str(self.cfg.dropin_dir / n) for n in names)}
                return 0, "".join(f"{p}={self.props.get(p, vals.get(p, 'v-' + p))}\n" for p in argv[5::2])
            if verb == "daemon-reload":
                self.loaded = self._scan()
                return 0, ""
            if verb == "restart":
                self.restarts += 1
                old = self.procs.pop(self.mpid)
                self.mpid, self.next_pid = self.next_pid, self.next_pid + 1
                argv2 = self.loaded[1]
                env = old["env"].replace(b"INVOCATION_ID=abc", b"INVOCATION_ID=def")
                self.procs[self.mpid] = {"argv": argv2, "start": 999, "state": "S", "env": env,
                                         "adopts": self.new_adopts if argv2 != self.base_argv else True}
                return 0, ""
            raise AssertionError(argv)
        if argv[0] == "journalctl":
            if "-g" in argv:
                return 0, self.history
            pid = int(next(a for a in argv if a.startswith("_PID="))[5:])
            p = self.procs.get(pid)
            return 0, (f"2026/10/28 adopted 1 guest(s) a previous guestd left, each verified again as the same guest: [{self.cfg.guest}]\n" if p and p["adopts"] else "starting\n")
        if argv[-1] == "-adopt-check":
            assert env is not None and env.get("GUESTD_ENABLE") == "1" and "INVOCATION_ID" not in env
            return self.adopt["current" if argv[:-1] == self.base_argv else "candidate"]
        raise AssertionError(argv)

    def proc_read(self, pid, name):
        p = self.procs.get(pid)
        if p is None:
            raise FileNotFoundError(pid)
        if name == "cmdline":
            return b"\0".join(os.fsencode(a) for a in p["argv"]) + b"\0"
        if name == "stat":
            return stat_line(pid, p["state"], p["start"]).encode()
        if name == "status":
            return f"Name:\tx\nUid:\t{self.uid}\t{self.uid}\t{self.uid}\t{self.uid}\n".encode()
        if name == "environ":
            return p["env"]
        raise AssertionError(name)

    def proc_exe(self, pid):
        return self.procs[pid]["argv"][0]

    def sha256_path(self, path):
        return "e" * 64

    def pidfd_open(self, pid):
        if pid not in self.procs:
            raise ProcessLookupError(pid)
        if self.on_pidfd_open:
            self.on_pidfd_open(self, pid)
        return pid + 10 ** 6

    def pidfd_signal(self, fd, sig):
        pid = fd - 10 ** 6
        if pid not in self.procs:
            raise ProcessLookupError(pid)
        if sig:
            self.signals.append((pid, sig))
            self.procs[pid]["state"] = "T" if sig == signal.SIGSTOP else "S"

    def close_fd(self, fd):
        pass

    def connect(self, host, port, timeout):
        if self.down:
            raise ConnectionRefusedError

    def sleep(self, s):
        self.clock += s

    def monotonic(self):
        return self.clock

    def euid(self):
        return self.uid

    def spawn_watchdog(self, fd, limit):
        w = FakeWatchdog(fd, limit)
        self.watchdogs.append(w)
        return w


class Fixture(unittest.TestCase):
    def adopt_entries(self, old_entry):
        return [old_entry]  # the running argv already maps the old release

    def setUp(self):
        self._td = tempfile.TemporaryDirectory()
        r = self.root = Path(self._td.name).resolve()
        ids = {}
        for k in ("old", "new"):
            (r / f"release-{k}/template/rt").mkdir(parents=True)
            (r / f"release-{k}/template/rt/runtime.json").write_text('{"name":"fixture"}\n')
            (r / f"release-{k}/release.json").write_bytes(f'{{"{k}":1}}'.encode())
            ids[k] = hashlib.sha256(f'{{"{k}":1}}'.encode()).hexdigest()
        old_t, new_t = str(r / "release-old/template"), str(r / "release-new/template")
        self.old_entry = f"{ids['old']}={old_t}/rt/runtime.json"
        self.argv = ["/opt/bin/guestd", "-listen", "127.0.0.1:8095", "-data-listen", "127.0.0.1:8096",
                     "-adopt-runtimes", ",".join(self.adopt_entries(self.old_entry)), "-shield-template", old_t,
                     "-shield-release", ids["old"], "-shield-profile", "model=z,template=/t,release=y,preemptible=1",
                     "-preempt-below-mib", "18432"]
        (r / "argv.json").write_text(json.dumps(self.argv))
        dd = r / "dropins"
        dd.mkdir()
        (dd / "80-shield-inference.conf").write_text("[Service]\nEnvironment=A=1\n")
        (dd / "zzzz-pad-spill.conf").write_text("[Service]\nExecStart=\nExecStart=" + S.render_exec(self.argv) + "\n")
        (dd / "zzzzzzz-recovery-pad-location.conf").write_text("[Service]\nEnvironment=SHIELDED_PAD_BANK_DIR=x\n")
        inst = r / "guestd-root/g1"
        inst.mkdir(parents=True)
        for n in S.preserve_names("g1"):
            (inst / n).write_bytes(n.encode() * 3)
        (r / "padstore").mkdir()
        with open(r / "padstore/pad.img", "wb") as f:
            f.truncate(1 << 20)  # sparse
        (r / "pads").mkdir()
        os.symlink(r / "padstore/pad.img", r / "pads/g1.padbank")
        self.env = f"SHIELDED_PAD_BANK_DIR={r / 'pads'}\0INVOCATION_ID=abc\0HOME=/h\0".encode()
        self.cfg = S.Config(expect_argv=r / "argv.json", dropin_dir=dd, dropin_name="zzzzzzzz-loader.conf",
                            old_template=old_t, old_release=ids["old"], new_template=new_t, new_release=ids["new"],
                            guest="g1", instance_dir=inst, control_pid=CONTROL, guest_qemu_pid=GUESTQ,
                            recovery_dir=r / "rec")
        self.candidate, self.changes = S.mutate_argv(self.argv, self.cfg)
        self.host = FakeHost(self.cfg, self.argv, self.env)
        self.log = []

    def tearDown(self):
        self._td.cleanup()

    def plan(self):
        plan, ctx = S.preflight(self.cfg, self.host)
        ctx.close()
        return json.loads(json.dumps(plan))

    def execute(self, plan=None):
        return S.execute(self.cfg, self.host, plan if plan is not None else self.plan(), self.log.append)

    @property
    def dropin(self):
        return self.cfg.dropin_dir / self.cfg.dropin_name

    def assert_resumed(self):
        self.assertEqual(self.host.signals[0], (CONTROL, signal.SIGSTOP))
        self.assertEqual(self.host.signals[-1], (CONTROL, signal.SIGCONT))
        self.assertTrue(self.host.watchdogs and self.host.watchdogs[-1].released)
        self.assertFalse([s for s in self.host.signals if s[0] != CONTROL])  # guest QEMU never signalled

    def assert_untouched(self):
        self.assertFalse(self.dropin.exists())
        self.assertEqual(self.host.signals, [])
        self.assertEqual(self.host.restarts, 0)


RT = REAL_ARGV.index("-adopt-runtimes") + 1
OLD_ENTRY = f"{S.OLD_RELEASE}={S.OLD_TEMPLATE}/rt/runtime.json"
NEW_ENTRY = f"{S.NEW_RELEASE}={S.NEW_TEMPLATE}/rt/runtime.json"


def with_adopt(value):
    argv = list(REAL_ARGV)
    argv[RT] = value
    return argv


class PureLogic(unittest.TestCase):
    def test_mutation_on_captured_argv_appends_only_old_adoption(self):
        self.assertNotIn(S.OLD_RELEASE + "=", REAL_ARGV[RT])  # the production capture lacks it
        self.assertNotIn(S.NEW_RELEASE + "=", REAL_ARGV[RT])
        cand, ch = S.mutate_argv(REAL_ARGV, S.Config())
        diff = [i for i, (a, b) in enumerate(zip(REAL_ARGV, cand)) if a != b]
        t, r = REAL_ARGV.index("-shield-template") + 1, REAL_ARGV.index("-shield-release") + 1
        self.assertEqual(len(cand), len(REAL_ARGV))
        self.assertEqual(diff, [RT, t, r])
        self.assertEqual([cand[t], cand[r]], [S.NEW_TEMPLATE, S.NEW_RELEASE])
        self.assertEqual(cand[RT], REAL_ARGV[RT] + "," + OLD_ENTRY)  # prior entries byte-identical, in order
        self.assertEqual(S.parse_adopt_runtimes(cand[RT])[:-1], S.parse_adopt_runtimes(REAL_ARGV[RT]))
        self.assertEqual(S.parse_adopt_runtimes(cand[RT])[-1], (S.OLD_RELEASE, S.OLD_TEMPLATE + "/rt/runtime.json"))
        self.assertEqual([c for i, c in enumerate(cand) if i not in diff], [a for i, a in enumerate(REAL_ARGV) if i not in diff])
        self.assertEqual([(c["index"], c["flag"]) for c in ch],
                         [(t, "-shield-template"), (r, "-shield-release"), (RT, "-adopt-runtimes")])
        self.assertEqual(ch[2], {"index": RT, "flag": "-adopt-runtimes", "appended": OLD_ENTRY,
                                 "kept_entries": len(REAL_ARGV[RT].split(","))})
        self.assertEqual(S.systemd_split(S.render_exec(cand)), cand)

    def test_mutation_keeps_present_old_adoption(self):
        entries = REAL_ARGV[RT].split(",")
        argv = with_adopt(",".join(entries[:3] + [OLD_ENTRY] + entries[3:]))
        cand, ch = S.mutate_argv(argv, S.Config())
        self.assertEqual(cand[RT], argv[RT])
        self.assertEqual([c["flag"] for c in ch], ["-shield-template", "-shield-release"])
        self.assertEqual([i for i, (a, b) in enumerate(zip(argv, cand)) if a != b], [c["index"] for c in ch])

    def test_mutation_keeps_matching_new_mapping_and_does_not_add_one(self):
        argv = with_adopt(REAL_ARGV[RT] + "," + NEW_ENTRY)
        cand, _ = S.mutate_argv(argv, S.Config())
        self.assertEqual(cand[RT], argv[RT] + "," + OLD_ENTRY)
        cand, _ = S.mutate_argv(REAL_ARGV, S.Config())
        self.assertNotIn(S.NEW_RELEASE + "=", cand[RT])

    def test_mutation_refuses_bad_adoption_mapping(self):
        cfg = S.Config()
        first = REAL_ARGV[RT].split(",")[0]
        a = RT - 1
        cases = {
            "old-conflict": REAL_ARGV[RT] + f",{S.OLD_RELEASE}=/home/steven/enclave-prod/release-x/template/rt/runtime.json",
            "old-to-new-template": REAL_ARGV[RT] + f",{S.OLD_RELEASE}={S.NEW_TEMPLATE}/rt/runtime.json",
            "new-conflict": REAL_ARGV[RT] + f",{S.NEW_RELEASE}={S.OLD_TEMPLATE}/rt/runtime.json",
            "old-duplicate": REAL_ARGV[RT] + "," + OLD_ENTRY + "," + OLD_ENTRY,
            "other-duplicate": REAL_ARGV[RT] + "," + first,
            "other-key-twice": REAL_ARGV[RT] + "," + first.split("=")[0] + "=/other/rt/runtime.json",
            "trailing-comma": REAL_ARGV[RT] + ",",
            "empty-entry": REAL_ARGV[RT].replace(",", ",,", 1),
            "empty": "",
            "no-equals": REAL_ARGV[RT] + "," + S.OLD_RELEASE,
            "upper-hex": REAL_ARGV[RT] + "," + OLD_ENTRY.upper(),
            "short-hash": REAL_ARGV[RT] + "," + OLD_ENTRY[1:],
            "relative-path": REAL_ARGV[RT] + f",{'a' * 64}=rt/runtime.json",
            "space-in-path": REAL_ARGV[RT] + f",{'a' * 64}=/x y/runtime.json",
        }
        for name, value in cases.items():
            with self.subTest(name), self.assertRaises(S.Refuse):
                S.mutate_argv(with_adopt(value), cfg)
        flags = {
            "missing": REAL_ARGV[:a] + REAL_ARGV[a + 2:],
            "duplicate-flag": REAL_ARGV + ["-adopt-runtimes", OLD_ENTRY],
            "duplicate-same": REAL_ARGV + ["-adopt-runtimes", REAL_ARGV[RT]],
            "eq-form": REAL_ARGV + ["-adopt-runtimes=" + OLD_ENTRY],
            "double-dash": REAL_ARGV + ["--adopt-runtimes", OLD_ENTRY],
            "only-eq-form": REAL_ARGV[:a] + ["-adopt-runtimes=" + REAL_ARGV[RT]] + REAL_ARGV[a + 2:],
            "trailing": REAL_ARGV[:a] + REAL_ARGV[a + 2:] + ["-adopt-runtimes"],
        }
        for name, argv in flags.items():
            with self.subTest(name), self.assertRaises(S.Refuse):
                S.mutate_argv(argv, cfg)

    def test_mutation_refuses_unexpected(self):
        cfg = S.Config()
        t = REAL_ARGV.index("-shield-template")
        cases = {
            "missing": REAL_ARGV[:t] + REAL_ARGV[t + 2:],
            "duplicate": REAL_ARGV + ["-shield-template", S.OLD_TEMPLATE],
            "eq-form": REAL_ARGV + ["-shield-template=/x"],
            "double-dash": REAL_ARGV + ["--shield-release", S.OLD_RELEASE],
            "wrong-old": REAL_ARGV[:t + 1] + ["/other"] + REAL_ARGV[t + 2:],
            "trailing": REAL_ARGV[:t] + REAL_ARGV[t + 2:] + ["-shield-template"],
        }
        for name, argv in cases.items():
            with self.subTest(name), self.assertRaises(S.Refuse):
                S.mutate_argv(argv, cfg)

    def test_quoting_round_trips(self):
        tricky = ["a b", 'x"y', "p%q", "$HOME", "${X}", "$$", "b\\s", "it's", "a=b,c", "@/x", "é", "-", "%%n", "\\\""]
        line = S.render_exec(["/bin/x"] + tricky)
        self.assertEqual(S.systemd_split(line), ["/bin/x"] + tricky)
        self.assertEqual(S.systemd_split(S.render_exec(REAL_ARGV)), REAL_ARGV)
        self.assertNotRegex(line.replace("%%", ""), "%")
        self.assertNotRegex(line.replace("$$", ""), r"\$")

    def test_quoting_refuses(self):
        for a in ["", ";", "a\nb", "a\rb", "\x7f", "t\tab"]:
            with self.subTest(a=a), self.assertRaises(S.Refuse):
                S.render_exec(["/bin/x", a])
        for exe in ["guestd", "/a b/x", "-/bin/x", "@/bin/x", '/bin/"x']:
            with self.subTest(exe=exe), self.assertRaises(S.Refuse):
                S.render_exec([exe])
        for bad in ['"a', "%n", '"$X"', "a\\b"]:
            with self.subTest(bad=bad), self.assertRaises(ValueError):
                S.systemd_split(bad)

    def test_dropin_order(self):
        with self.assertRaises(S.Refuse) as e:
            S.check_dropin_name("zz-loader-cache-20261028.conf", set(REAL_DROPINS))
        self.assertIn("zz-memory-budget64.conf", str(e.exception))
        S.check_dropin_name("zzzzzzzz-loader-cache-20261028.conf", set(REAL_DROPINS))
        for bad in ["zzzzzzz-recovery-pad-location.conf", "../zzzzzzzz.conf", "zzzzzzzz.txt", ".zzzzzzzz.conf", "zzzzzzzz x.conf"]:
            with self.subTest(bad=bad), self.assertRaises(S.Refuse):
                S.check_dropin_name(bad, set(REAL_DROPINS))
        with self.assertRaises(S.Refuse):  # a non-.conf entry sorting later also refuses
            S.check_dropin_name("zzzzzzzz-a.conf", set(REAL_DROPINS) | {"zzzzzzzz-b.bak"})

    def test_parse_stat_and_environ(self):
        self.assertEqual(S.parse_stat(stat_line(7, "T", 42)), ("T", 42))
        env = S.parse_environ(b"A=1\0INVOCATION_ID=x\0B=x=y\0")
        self.assertEqual(env["B"], "x=y")
        self.assertEqual(S.env_diff(env, {**env, "INVOCATION_ID": "z", "JOURNAL_STREAM": "1"}), [])
        self.assertEqual(S.env_diff(env, {**env, "A": "2", "C": ""}), ["A", "C"])

    def test_adopt_verdict(self):
        lines = (HERE / "adopt-current-preflight.out").read_text().splitlines()
        self.assertEqual(S.adopt_verdict(lines), ({"gdb55af9c1"}, []))
        ok, bad = S.adopt_verdict(["ADOPT OK a", "ADOPT FAIL b: x"])
        self.assertEqual((ok, len(bad)), ({"a"}, 1))

    def test_source_never_signals_by_pid_or_stops_guests(self):
        src = (HERE / "safe_manager_switch.py").read_text()
        for bad in ["os.kill(", "shell=True", '"stop"', "pair.key", "kill -"]:
            self.assertNotIn(bad, src)


class Preflight(Fixture):
    def test_plan_is_json_stable_and_reviewable(self):
        plan, ctx = S.preflight(self.cfg, self.host)
        ctx.close()
        self.assertEqual(json.loads(json.dumps(plan)), plan)
        self.assertEqual(plan["dropin"]["existing"], ["80-shield-inference.conf", "zzzz-pad-spill.conf",
                                                      "zzzzzzz-recovery-pad-location.conf"])
        self.assertEqual(plan["preserve"]["pad"]["symlink_target"], str(self.root / "padstore/pad.img"))
        self.assertEqual(ctx.candidate, self.candidate)
        self.assertEqual(plan["adopt_env_added"], ["GUESTD_ENABLE"])
        self.assert_untouched()

    def refuse(self, msg=None):
        with self.assertRaises(S.Refuse) as e:
            S.preflight(self.cfg, self.host)
        if msg:
            self.assertIn(msg, str(e.exception))
        self.assert_untouched()

    def test_running_argv_mismatch(self):
        self.host.procs[MPID]["argv"] = self.argv + ["-x"]
        self.refuse("argv differs")

    def test_pending_unit_changes(self):
        self.host.need_reload = "yes"
        self.refuse("NeedDaemonReload")

    def test_unit_execstart_not_running_argv(self):
        self.host.loaded = (self.host.loaded[0], self.argv + ["-y"])
        self.refuse("ExecStart differs")

    def test_default_dropin_name_sorts_too_early(self):
        self.cfg.dropin_name = "zz-loader-cache-20261028.conf"
        self.refuse("would not be applied last")

    def test_new_release_hash(self):
        self.cfg.new_release = "0" * 64
        self.refuse("does not hash")

    def test_present_old_adoption_is_not_changed(self):
        plan = self.plan()
        self.assertEqual([c["flag"] for c in plan["changes"]], ["-shield-template", "-shield-release"])
        self.assertEqual(self.candidate[self.argv.index("-adopt-runtimes") + 1], self.old_entry)
        self.assertIn("# -adopt-runtimes unchanged (already maps the old release)\n",
                      S.render_dropin(self.candidate, self.changes, self.cfg))

    def test_old_runtime_profile_missing(self):
        (self.root / "release-old/template/rt/runtime.json").unlink()
        self.refuse("rt/runtime.json is not a regular file")

    def test_old_runtime_profile_symlink(self):
        rt = self.root / "release-old/template/rt/runtime.json"
        (self.root / "elsewhere.json").write_text("{}\n")
        rt.unlink()
        os.symlink(self.root / "elsewhere.json", rt)
        self.refuse("rt/runtime.json is not a regular file")

    def test_old_runtime_profile_directory(self):
        rt = self.root / "release-old/template/rt/runtime.json"
        rt.unlink()
        rt.mkdir()
        self.refuse("rt/runtime.json is not a regular file")

    def test_control_not_qemu_or_already_stopped(self):
        self.host.procs[CONTROL]["argv"] = ["/usr/bin/sleep", "9"]
        self.refuse("not QEMU")
        self.host.procs[CONTROL]["argv"] = ["/usr/bin/qemu-system-x86_64"]
        self.host.procs[CONTROL]["state"] = "T"
        self.refuse("already stopped")

    def test_guest_qemu_must_name_guest(self):
        self.host.procs[GUESTQ]["argv"] = ["/usr/bin/qemu-system-x86_64", "-name", "other"]
        self.refuse("does not name guest")

    def test_wrong_user(self):
        self.host.uid += 1  # proc status reports the new uid too, so make euid differ
        self.host.euid = lambda: os.geteuid() + 7
        self.refuse("uid")

    def test_recovery_dir_exists(self):
        self.cfg.recovery_dir.mkdir()
        self.refuse("already exists")

    def test_pidfd_identity_race(self):
        plan, ctx = S.preflight(self.cfg, self.host)

        def reuse(h, pid):
            h.procs[pid]["start"] += 1  # PID reused between read and pidfd_open
        self.host.on_pidfd_open = reuse
        with self.assertRaises(S.Refuse):
            S.open_pidfd(self.host, ctx.control)


class Execute(Fixture):
    def test_success(self):
        pid = self.execute()
        self.assertEqual(self.dropin.read_text(), S.render_dropin(self.candidate, self.changes, self.cfg))
        self.assertEqual(stat.S_IMODE(self.dropin.stat().st_mode), 0o644)
        self.assertEqual(self.host.procs[pid]["argv"], self.candidate)
        self.assertEqual(self.host.restarts, 1)
        self.assert_resumed()
        self.assertEqual(len(self.host.signals), 2)
        rec = self.cfg.recovery_dir
        self.assertEqual(stat.S_IMODE(rec.stat().st_mode), 0o700)
        inst = self.cfg.instance_dir
        self.assertEqual((rec / "guest.cpio.gz").stat().st_ino, (inst / "guest.cpio.gz").stat().st_ino)
        self.assertNotEqual((rec / "instance.json").stat().st_ino, (inst / "instance.json").stat().st_ino)
        self.assertEqual((rec / "instance.json").read_bytes(), (inst / "instance.json").read_bytes())
        self.assertEqual((rec / "pad.target").stat().st_ino, (self.root / "padstore/pad.img").stat().st_ino)
        self.assertEqual(os.readlink(rec / "pad.symlink"), str(self.root / "padstore/pad.img"))
        m = json.loads((rec / "recovery.json").read_text())
        self.assertTrue(m["adopt_candidate"]["ok"])
        self.assertEqual(json.loads((rec / "manager-argv.json").read_text()), self.argv)

    def test_reviewed_plan_mismatch(self):
        plan = self.plan()
        plan["control_qemu"]["start"] += 1
        with self.assertRaises(S.Refuse):
            self.execute(plan)
        self.assert_untouched()
        self.assertFalse(self.cfg.recovery_dir.exists())

    def test_candidate_adopt_check_fails(self):
        self.host.adopt["candidate"] = (1, "ADOPT FAIL g1: runtime\n")
        with self.assertRaises(S.Refuse):
            self.execute()
        self.assert_untouched()
        self.assertFalse(self.cfg.recovery_dir.exists())

    def test_adopt_check_must_be_current_only_guest(self):
        self.host.adopt["current"] = (0, "ADOPT OK g1\nADOPT OK g2\n")
        with self.assertRaises(S.Refuse):
            self.execute()
        self.assert_untouched()

    def test_systemd_preexec_race_waits_for_exact_argv(self):
        original = self.host.proc_read
        seen = []
        def transient(pid, name):
            if name == 'cmdline' and self.host.restarts and pid == self.host.mpid and not seen:
                seen.append(True)
                return b'(sd-executor)\0'
            return original(pid, name)
        with mock.patch.object(self.host, 'proc_read', side_effect=transient):
            self.execute()
        self.assertTrue(seen)
        self.assertEqual(self.host.restarts, 1)
        self.assert_resumed()

    def test_no_adopt_history_uses_fresh_checks(self):
        self.host.history = ""
        self.execute()
        self.assertEqual(self.host.restarts, 1)
        self.assert_resumed()

    def test_new_manager_never_adopts_rolls_back_and_restarts_original(self):
        self.host.new_adopts = False
        with self.assertRaises(S.SwitchFailed):
            self.execute()
        self.assertFalse(self.dropin.exists())
        self.assertEqual(self.host.restarts, 2)
        self.assertEqual(self.host.procs[self.host.mpid]["argv"], self.argv)
        self.assert_resumed()

    def test_reload_check_failure_rolls_back_without_restart(self):
        def env_changed(h):
            h.props["Environment"] = "changed"
        self.host.on["daemon-reload"] = [env_changed]
        with self.assertRaises(S.SwitchFailed):
            self.execute()
        self.assertFalse(self.dropin.exists())
        self.assertEqual((self.host.restarts, self.host.mpid), (0, MPID))
        self.assert_resumed()

    def test_interrupt_during_restart_rolls_back(self):
        def interrupt(h):
            raise KeyboardInterrupt
        self.host.on["restart"] = [interrupt]
        with self.assertRaises(S.SwitchFailed):
            self.execute()
        self.assertFalse(self.dropin.exists())
        self.assertEqual(self.host.procs[self.host.mpid]["argv"], self.argv)
        self.assert_resumed()

    def test_foreign_dropin_is_not_removed(self):
        def tamper(h):
            tmp = h.cfg.dropin_dir / "tmp"
            tmp.write_text("[Service]\n")
            os.replace(tmp, h.cfg.dropin_dir / h.cfg.dropin_name)
            return 1, ""
        self.host.on["daemon-reload"] = [tamper]
        with self.assertRaises(S.RollbackIncomplete):
            self.execute()
        self.assertTrue(self.dropin.exists())
        self.assert_resumed()

    def test_control_dies_during_hold(self):
        def die(h):
            del h.procs[CONTROL]
        self.host.on["daemon-reload"] = [die]
        with self.assertRaises(S.SwitchFailed):
            self.execute()
        self.assertFalse(self.dropin.exists())
        self.assertTrue(self.host.watchdogs[-1].released)

    def test_manager_env_change_after_restart_rolls_back(self):
        orig = self.host.run

        def run(argv, timeout, env=None):
            r = orig(argv, timeout, env)
            if argv[2:3] == ["restart"] and self.host.restarts == 1:
                self.host.procs[self.host.mpid]["env"] += b"NEW=1\0"
            return r
        self.host.run = run
        with self.assertRaises(S.SwitchFailed):
            self.execute()
        self.assertEqual(self.host.procs[self.host.mpid]["argv"], self.argv)
        self.assert_resumed()

    def test_hold_is_bounded(self):
        self.host.down = True  # never accepts: forward path must give up within FORWARD_BUDGET
        with self.assertRaises(S.RollbackIncomplete):  # rollback's own wait also fails while down
            self.execute()
        self.assertLessEqual(self.host.clock, S.DRAIN + S.FORWARD_BUDGET + 30 + 1)
        self.assertFalse(self.dropin.exists())
        self.assert_resumed()


class AbsentOldAdoption(Fixture):
    """Like the production capture: -adopt-runtimes maps other releases but not the old one."""
    OTHERS = [f"{'a' * 64}=/p/release-a/template/rt/runtime.json", f"{'b' * 64}=/p/release-a/template/rt/runtime.json"]

    def adopt_entries(self, old_entry):
        return list(self.OTHERS)

    def test_plan_and_dropin_record_the_append(self):
        plan = self.plan()
        rt = self.argv.index("-adopt-runtimes") + 1
        self.assertEqual(plan["changes"][2], {"index": rt, "flag": "-adopt-runtimes", "appended": self.old_entry,
                                              "kept_entries": 2})
        self.assertEqual(self.candidate[rt], ",".join(self.OTHERS + [self.old_entry]))
        self.assertEqual([i for i, (a, b) in enumerate(zip(self.argv, self.candidate)) if a != b],
                         sorted(c["index"] for c in plan["changes"]))
        text = S.render_dropin(self.candidate, self.changes, self.cfg)
        self.assertIn(f"# -adopt-runtimes: all 2 prior entries unchanged, appended {self.old_entry}\n", text)
        self.assertEqual(S.systemd_split(text.splitlines()[-1][len("ExecStart="):]), self.candidate)
        self.assert_untouched()

    def test_missing_old_runtime_profile_refuses_before_anything(self):
        (self.root / "release-old/template/rt/runtime.json").unlink()
        with self.assertRaises(S.Refuse):
            self.execute()
        self.assert_untouched()
        self.assertFalse(self.cfg.recovery_dir.exists())
        self.assertFalse([c for c in self.host.calls if c[-1] == "-adopt-check"])

    def test_success_switches_with_appended_mapping(self):
        pid = self.execute()
        self.assertEqual(self.host.procs[pid]["argv"], self.candidate)
        checks = [c[:-1] for c in self.host.calls if c[-1] == "-adopt-check"]
        self.assertEqual(checks, [self.argv, self.candidate])  # candidate checked with the appended mapping
        rec = self.cfg.recovery_dir
        self.assertEqual(json.loads((rec / "candidate-argv.json").read_text()), self.candidate)
        self.assertEqual(self.dropin.read_text(), S.render_dropin(self.candidate, self.changes, self.cfg))
        self.assert_resumed()

    def test_candidate_adopt_check_fails(self):
        self.host.adopt["candidate"] = (1, "ADOPT FAIL g1: no runtime for release\n")
        with self.assertRaises(S.Refuse):
            self.execute()
        self.assert_untouched()
        self.assertFalse(self.cfg.recovery_dir.exists())

    def test_rollback_restores_original_mapping(self):
        self.host.new_adopts = False
        with self.assertRaises(S.SwitchFailed):
            self.execute()
        self.assertFalse(self.dropin.exists())
        self.assertEqual(self.host.procs[self.host.mpid]["argv"], self.argv)
        self.assertEqual(self.host.loaded[1], self.argv)
        self.assert_resumed()


class Preservation(Fixture):
    def test_hardlink_refuses_other_inode(self):
        src = self.cfg.instance_dir / "guest.cpio.gz"
        st = src.stat()
        with self.assertRaises(S.Refuse):
            S.hardlink_stable(src, self.root / "x", st.st_dev, st.st_ino + 1)
        self.assertFalse((self.root / "x").exists())

    def test_copy_cap(self):
        with mock.patch.object(S, "COPY_CAP", 2), self.assertRaises(S.Refuse):
            S.copy_hashed(self.cfg.instance_dir / "doc.json", self.root / "y", False)

    def test_copy_bounded_chunks(self):
        with mock.patch.object(S, "CHUNK", 3):
            r = S.copy_hashed(self.cfg.instance_dir / "doc.json", self.root / "z", False)
        self.assertEqual(r["sha256"], hashlib.sha256((self.cfg.instance_dir / "doc.json").read_bytes()).hexdigest())


class Cli(unittest.TestCase):
    def test_usage(self):
        for argv in (["--execute"], ["--reviewed-plan", "p"], ["--exec"], ["--bogus"],
                     ["--execute", "--reviewed-plan", "p"],
                     ["--execute", "--reviewed-plan", "p", "--recovery-dir", "r", "--adopt-check"]):
            with self.subTest(argv=argv), mock.patch("sys.stderr"):
                self.assertEqual(S.main(argv, host=object()), 2)


def proc_state(pid):
    return S.parse_stat(Path(f"/proc/{pid}/stat").read_text())[0]


def wait_state(pid, want, timeout=5):
    end = time.monotonic() + timeout
    while time.monotonic() < end:
        if (proc_state(pid) in "Tt") == want:
            return True
        time.sleep(0.02)
    return False


@unittest.skipUnless(hasattr(os, "pidfd_open") and sys.platform == "linux", "needs Linux pidfd")
class RealWatchdog(unittest.TestCase):
    """Uses a private `sleep` child only."""

    def setUp(self):
        self.child = subprocess.Popen(["sleep", "30"])
        self.fd = os.pidfd_open(self.child.pid)
        signal.pidfd_send_signal(self.fd, signal.SIGSTOP)
        self.assertTrue(wait_state(self.child.pid, True))

    def tearDown(self):
        self.child.kill()
        self.child.wait()
        os.close(self.fd)

    def test_deadline(self):
        wd = S.Watchdog.arm(self.fd, 0.3)
        self.assertTrue(wait_state(self.child.pid, False))
        self.assertEqual(wd.release(), "deadline sigcont=sent")

    def test_parent_gone(self):
        wd = S.Watchdog.arm(self.fd, 30)
        os.close(wd.wfd)  # what the kernel does when the parent dies
        self.assertTrue(wait_state(self.child.pid, False))
        wd.proc.wait(5)
        self.assertIn(b"parent-gone", wd.proc.stdout.read())
        wd.proc.stdout.close()

    def test_release(self):
        wd = S.Watchdog.arm(self.fd, 30)
        self.assertEqual(wd.release(), "released sigcont=sent")
        self.assertTrue(wait_state(self.child.pid, False))


if __name__ == "__main__":
    unittest.main()

class RootBootAdoption(unittest.TestCase):
    def test_real_startup_summary(self):
        self.assertEqual(S.boot_adopt_verdict(['adopted 1 guest(s) a previous guestd left, each verified again as the same guest: [gdb55af9c1]']), ({'gdb55af9c1'}, []))
    def test_dropped_guest_is_failure(self):
        self.assertTrue(S.boot_adopt_verdict(['not adopted, ended: gdb55af9c1'])[1])
    def test_wrong_count_rejected(self):
        self.assertTrue(S.boot_adopt_verdict(['adopted 2 guest(s) a previous guestd left, each verified again as the same guest: [gdb55af9c1]'])[1])

class RootLivePad(unittest.TestCase):
    def test_live_pad_mtime_may_change_but_inode_must_match(self):
        with tempfile.TemporaryDirectory() as tmp:
            src=Path(tmp)/'pad'; dst=Path(tmp)/'kept';src.write_bytes(b'pad')
            st=src.stat(); original=S.os.link
            def link_and_touch(a,b,**kw):
                original(a,b,**kw)
                os.utime(a,ns=(st.st_atime_ns,st.st_mtime_ns+1000000))
            with mock.patch.object(S.os,'link',side_effect=link_and_touch):
                r=S.hardlink_stable(src,dst,st.st_dev,st.st_ino,live=True)
            self.assertTrue(r['live_inode_retained']);self.assertFalse(r['content_snapshot'])
            self.assertEqual(src.stat().st_ino,dst.stat().st_ino)
