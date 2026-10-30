"""Fixture tests for the bench harness. No process, unit, VM, device or
model is touched: the host is a fake, and storage/sysfs are temp trees."""

import argparse
import gzip
import json
import os
import stat
import struct
import tempfile
import types
import unittest
import zlib
from unittest import mock
from urllib.parse import quote_plus

import benchlib as B
import build_initramfs
import run_snp_ab as R

GiB = B.GiB


def fake_elf(path, interp=False):
    hdr = struct.pack("<16sHHIQQQIHHHHHH", b"\x7fELF\x02\x01\x01" + b"\0" * 9,
                      2, 62, 1, 0, 64, 0, 0, 64, 56, 1, 0, 0, 0)
    ph = struct.pack("<I", 3 if interp else 1) + b"\0" * 52
    with open(path, "wb") as f:
        f.write(hdr + ph + path.encode())  # distinct bytes per fixture


def rec(seq, kind, **kv):
    body = f"BENCH seq={seq} t_ns={seq * 1000} kind={kind}" + "".join(
        f" {quote_plus(k)}={quote_plus(str(v))}" for k, v in kv.items())
    return f"{body} crc={zlib.crc32(body.encode()):08x}\r\n"


MODEL_LINE = (f"MODEL verified bytes={B.MODEL_SIZE} sha256={B.MODEL_SHA256} copy_verify_ms=30000"
              f" source_dontneed_advised_bytes={B.MODEL_SIZE} source_dontneed_failures=0")


def guest_log(arm="A", status="ok", poweroff=True, tamper=None):
    kinds = [("preflight", {"arm": arm, "block": "vda", "vda_ro": "1"})]
    for phase in ("before", "after"):
        if phase == "after":
            kinds.append(("child-stdout", {"n": "1", "line": MODEL_LINE if arm == "B" else MODEL_LINE.split(" source")[0]}))
        kinds += [("meminfo", {"phase": phase, "status": "ok", "unit": "kB", "m.MemFree": "1"}),
                  ("cgroup", {"phase": phase, "scope": "child", "memory.current": "0",
                              "memory.peak": "34359738368" if phase == "after" else "0"}),
                  ("cgroupfile", {"phase": phase, "scope": "child", "file": "memory.stat", "status": "ok", "s.file": "1"})]
    kinds.append(("result", {"status": status, "reason": "loaded", "arm": arm,
                             "digest_verified": "true" if status == "ok" else "false",
                             "model_bytes": str(B.MODEL_SIZE), "model_sha256": B.MODEL_SHA256}))
    if poweroff:
        kinds.append(("poweroff", {}))
    lines = [rec(i, k, **kv) for i, (k, kv) in enumerate(kinds, start=1)]
    if tamper:
        lines = tamper(lines)
    return ("[    0.0] Linux version\r\n" + "".join(lines)).encode()


class SerialParser(unittest.TestCase):
    def test_complete_log(self):
        records, complete, problems = B.parse_serial(guest_log("B"))
        g = B.guest_report(records, complete, problems)
        self.assertTrue(complete, problems)
        self.assertEqual((g["arm"], g["status"], g["digest_verified"], g["metrics_available"]), ("B", "ok", True, True))
        self.assertEqual(g["loader_stdout"], [MODEL_LINE])

    def test_torn_and_noisy_lines(self):
        noisy = guest_log(tamper=lambda ls: ["[  12.3] virtio noise " + ls[0]] + ls[1:])
        self.assertTrue(B.parse_serial(noisy)[1])
        for name, t in {
            "crc": lambda ls: [ls[0].replace("arm=A", "arm=B")] + ls[1:],
            "torn": lambda ls: [ls[0][:30] + "[ 1.0] oops\r\n"] + ls[1:],
            "gap": lambda ls: ls[:2] + ls[3:],
            "dup-result": lambda ls: ls[:-1] + [rec(len(ls), "result", status="ok"), rec(len(ls) + 1, "poweroff")],
        }.items():
            records, complete, problems = B.parse_serial(guest_log(tamper=t))
            self.assertFalse(complete, name)
            self.assertFalse(B.guest_report(records, complete, problems)["digest_verified"], name)
        self.assertFalse(B.parse_serial(guest_log(poweroff=False))[1])
        self.assertFalse(B.parse_serial(b"")[1])


class Classification(unittest.TestCase):
    ok_host = {"result": "success", "exec_main_code": "1", "exec_main_status": "0"}

    def g(self, **kw):
        g = B.guest_report(*B.parse_serial(guest_log(kw.pop("arm", "A"))))
        g.update(kw)
        return g

    def test_outcomes(self):
        cases = [
            ({}, {}, "success"),
            ({"watchdog_stop": "low_host_memory"}, {}, "killed_low_host_memory"),
            ({"watchdog_stop": "host_deadline"}, {}, "killed_host_deadline"),
            ({"result": "timeout"}, {}, "unit_timeout"),
            ({"exec_main_status": "1", "result": "exit-code"}, {}, "qemu_failed"),
            ({"limits_error": "x"}, {}, "limits_not_enforced"),
            ({"identity_error": "x"}, {}, "identity_changed"),
            ({"preflight_error": ["usb"]}, {}, "preflight_refused"),
            ({"helper_error": "boom"}, {}, "helper_error"),
            ({}, {"complete": False}, "serial_incomplete"),
            ({}, {"arm": "B"}, "arm_mismatch"),
            ({}, {"status": "error"}, "guest_error"),
            ({}, {"digest_verified": False}, "digest_not_verified"),
            ({}, {"metrics_available": False}, "metrics_unavailable"),
            ({"model_identity_changed": True}, {}, "model_identity_changed"),
            ({"cleanup_error": "x"}, {}, "cleanup_failed"),
        ]
        for host_kw, guest_kw, want in cases:
            self.assertEqual(B.classify_arm("A", {**self.ok_host, **host_kw}, self.g(**guest_kw)), want, want)


class ResourceFloor(unittest.TestCase):
    def test_required(self):
        self.assertEqual(B.required_available(1551 * B.MiB), 68 * GiB + 1551 * B.MiB)
        self.assertEqual(B.required_available(4 * GiB), 72 * GiB)
        with self.assertRaises(ValueError):
            B.required_available(1550 * B.MiB)


class ArgvSafety(unittest.TestCase):
    q = B.qemu_argv("/usr/bin/qemu-system-x86_64", "EPYC-v4", B.RELEASE + "/kernel", B.RELEASE + "/firmware.fd",
                    "/b/arm-A.initramfs.cpio.gz", B.MODEL_PATH, "/p/serial-A.log")
    unit = "shield-snp-ab-" + "0" * 32 + "-A.service"

    def test_generated_argv_is_clean(self):
        self.assertEqual(R.qemu_violations(self.q, "/b/arm-A.initramfs.cpio.gz"), [])
        self.assertEqual(R.unit_violations(B.systemd_run_argv(self.unit, self.q), self.unit), [])

    def test_violations_detected(self):
        def bad(f):
            return R.qemu_violations(f(list(self.q)), "/b/arm-A.initramfs.cpio.gz")
        swap = lambda old, new: (lambda q: [new if a == old else a for a in q])
        drive = self.q[self.q.index("-drive") + 1]
        for name, f in {
            "extra-disk": lambda q: q + ["-drive", "file=/x,if=virtio"],
            "netdev": lambda q: q + ["-netdev", "user,id=n"],
            "qmp": lambda q: q + ["-qmp", "unix:/tmp/q,server"],
            "chardev": lambda q: q + ["-chardev", "socket,id=c"],
            "writable": swap(drive, drive.replace("readonly=on", "readonly=off")),
            "cached": swap(drive, drive.replace("cache=none", "cache=writeback")),
            "monitor": swap("none", "stdio"),
            "nic": lambda q: q[:q.index("-nic")] + q[q.index("-nic") + 2:],
            "ram": swap("48G", "64G"),
            "no-hashes": lambda q: [a.replace("kernel-hashes=on", "kernel-hashes=off") for a in q],
            "no-share": lambda q: [a.replace("share=true", "share=false") for a in q],
        }.items():
            self.assertTrue(bad(f), name)
        with self.assertRaises(ValueError):
            B.qemu_argv("/q", "EPYC-v4", "/k", "/f", "/i,file=/etc/shadow", B.MODEL_PATH, "/s")
        with self.assertRaises(ValueError):
            B.systemd_run_argv("guestd.service", self.q)
        argv = B.systemd_run_argv(self.unit, self.q)
        self.assertTrue(R.unit_violations([a for a in argv if "MemoryMax" not in a], self.unit))


class StaticElf(unittest.TestCase):
    def test_static_only(self):
        with tempfile.TemporaryDirectory() as d:
            fake_elf(os.path.join(d, "s"))
            fake_elf(os.path.join(d, "dyn"), interp=True)
            B.check_static_elf_amd64(os.path.join(d, "s"))
            with self.assertRaises(ValueError):
                B.check_static_elf_amd64(os.path.join(d, "dyn"))
            with open(os.path.join(d, "txt"), "w") as f:
                f.write("#!/bin/sh\n")
            with self.assertRaises(ValueError):
                B.check_static_elf_amd64(os.path.join(d, "txt"))


class Builder(unittest.TestCase):
    def setUp(self):
        self.d = tempfile.mkdtemp()
        p = lambda n: os.path.join(self.d, n)
        fake_elf(p("init"))
        fake_elf(p("shieldmodel"))
        for n in ("kernel", "firmware.fd"):
            with open(p(n), "wb") as f:
                f.write(n.encode())
        os.mkdir(p("src"))
        self.args = lambda out: argparse.Namespace(init=p("init"), loader=p("shieldmodel"), init_source=p("src"),
                                                   loader_source=p("src"), kernel=p("kernel"),
                                                   firmware=p("firmware.fd"), out=p(out))
        self.pins = mock.patch.multiple(B, KERNEL_SHA256=B.sha256_file(p("kernel")),
                                        FIRMWARE_SHA256=B.sha256_file(p("firmware.fd")))

    def test_archives(self):
        with self.pins:
            m1 = build_initramfs.build(self.args("out1"))
            m2 = build_initramfs.build(self.args("out2"))
            with self.assertRaises(FileExistsError):
                build_initramfs.build(self.args("out1"))
        for arm in B.ARMS:
            self.assertEqual(m1["arms"][arm]["sha256"], m2["arms"][arm]["sha256"], "not deterministic")
        raw = {}
        for arm in B.ARMS:
            with open(m1["arms"][arm]["initramfs"], "rb") as f:
                gz = f.read()
            self.assertEqual(gz[4:8], b"\0\0\0\0")  # gzip mtime
            raw[arm] = {e[0]: e for e in B.parse_newc(gzip.decompress(gz))}
        a, b = raw["A"], raw["B"]
        self.assertEqual(set(b) - set(a), {B.DROP_MARKER})
        self.assertTrue(all(a[k] == b[k] for k in a))
        console = a["dev/console"]
        self.assertTrue(stat.S_ISCHR(console[1]) and console[3] == (5, 1))
        self.assertIn(B.RECLAIM_MARKER, a)
        self.assertTrue(stat.S_ISDIR(a[B.MODEL_DIR_IN_GUEST][1]))
        self.assertFalse(any(k.endswith(".gguf") for k in a), "model must never be copied")
        self.assertFalse(any(k != B.MODEL_DIR_IN_GUEST and k.startswith("models/q") for k in a))
        self.assertEqual(oct(os.stat(m1["arms"]["A"]["initramfs"]).st_mode & 0o777), "0o444")

    def test_wrong_pin_refused_before_output(self):
        with self.assertRaises(ValueError):
            build_initramfs.build(self.args("out"))
        self.assertFalse(os.path.exists(os.path.join(self.d, "out")))


class Storage(unittest.TestCase):
    def setUp(self):
        self.root = os.path.realpath(tempfile.mkdtemp())
        self.sys = os.path.join(self.root, "sys")
        mk = lambda rel, files=(): self._mk(rel, files)
        self.nvme_p = mk("devices/pci0000:00/0000:00:01.0/nvme/nvme0/nvme0n1/nvme0n1p2", ["partition"])
        self.usb_p = mk("devices/pci0000:00/0000:00:14.0/usb2/2-1/host0/block/sda/sda1", ["partition"])
        self.dm = mk("devices/virtual/block/dm-0")
        os.makedirs(os.path.join(self.dm, "slaves"))
        os.symlink(self.usb_p, os.path.join(self.dm, "slaves", "sda1"))
        os.makedirs(os.path.join(self.sys, "dev/block"))
        for devno, target in (("259:2", self.nvme_p), ("8:1", self.usb_p), ("254:0", self.dm)):
            os.symlink(target, os.path.join(self.sys, "dev/block", devno))
        self.mountinfo = os.path.join(self.root, "mountinfo")
        with open(self.mountinfo, "w") as f:
            f.write("36 1 0:40 / /home rw shared:1 - btrfs /dev/nvme0n1p2 rw\n"
                    "37 1 0:41 / /tmp rw - tmpfs tmpfs rw\n")

    def _mk(self, rel, files):
        p = os.path.join(self.sys, rel)
        os.makedirs(p)
        for f in files:
            open(os.path.join(p, f), "w").close()
        return p

    def check(self, dev, extra=None):
        def stat_fn(path):
            if extra and path in extra:
                return extra[path]
            return types.SimpleNamespace(st_dev=dev, st_mode=stat.S_IFREG | 0o644)
        return B.storage_check("/x", self.sys, self.mountinfo, stat_fn)

    def test_storage(self):
        chain = self.check(os.makedev(259, 2))
        self.assertEqual(chain[1], os.path.dirname(self.nvme_p))
        for dev in (os.makedev(8, 1), os.makedev(254, 0), os.makedev(0, 41), os.makedev(9, 9)):
            with self.assertRaises(ValueError):
                self.check(dev)
        blk = {"/dev/nvme0n1p2": types.SimpleNamespace(st_mode=stat.S_IFBLK, st_rdev=os.makedev(259, 2))}
        self.assertTrue(self.check(os.makedev(0, 40), blk))


class FakeHost:
    """Simulates exactly one owned user unit. Fails the test on any command
    other than systemd-run/systemctl for the planned unit."""

    def __init__(self, out, avail=(100 * GiB,), exit_after=3, status="0", flip_at=None,
                 limits=None, storage_bad=(), log=None):
        self.out, self.avail, self.exit_after, self.status = out, list(avail), exit_after, status
        self.flip_at, self.storage_bad, self.calls, self.kills = flip_at, storage_bad, [], []
        self.limits = limits or {"memory.max": str(50 * GiB), "memory.swap.max": "0", "cpu.max": "200000 100000"}
        self.log, self.tick, self.unit, self.state, self.files = log, 0, None, None, {}

    def guests(self, exclude_pid=None):
        return []

    def run(self, argv, timeout=60):
        self.calls.append(list(argv))
        if argv[0] == "systemd-run":
            self.unit, self.state = argv[argv.index("--unit") + 1], "running"
            self.files[os.path.join(self.out, "serial-%s.log" % self.unit[-9])] = self.log or guest_log(self.unit[-9])
            return 0, "", ""
        assert argv[:2] == ["systemctl", "--user"] and argv[3] == self.unit or argv[2] == "show", argv
        if argv[2] == "show":
            return 0, self.props(argv[3]), ""
        if argv[2] in ("stop", "reset-failed"):
            self.state = "gone"
            return 0, "", ""
        raise AssertionError(argv)

    def props(self, unit):
        if unit != self.unit or self.state in (None, "gone"):
            return "LoadState=not-found\nActiveState=inactive\nSubState=dead\nInvocationID=\nMainPID=0\n"
        inv = "inv2" if self.flip_at is not None and self.tick >= self.flip_at else "inv1"
        base = f"LoadState=loaded\nInvocationID={inv}\nControlGroup=/user.slice/app.slice/{unit}\n"
        if self.state == "running":
            return base + "ActiveState=active\nSubState=running\nMainPID=4242\nResult=success\n"
        if self.status == "0":
            return base + "ActiveState=active\nSubState=exited\nMainPID=0\nResult=success\nExecMainCode=1\nExecMainStatus=0\n"
        return base + f"ActiveState=failed\nSubState=failed\nMainPID=0\nResult=exit-code\nExecMainCode=1\nExecMainStatus={self.status}\n"

    def read(self, path):
        if path == "/proc/meminfo":
            return "MemTotal: 134217728 kB\nMemAvailable: %d kB\n" % (self.avail[min(self.tick, len(self.avail) - 1)] // 1024)
        if path == "/proc/4242/stat" and self.state == "running":
            return "4242 (qemu-system-x86) S " + " ".join(str(i) for i in range(30))
        if path.startswith(R.CGROUP_FS) and self.state == "running":
            name = os.path.basename(path)
            return self.limits.get(name) or {"memory.current": "1000", "memory.peak": "2000",
                                             "memory.stat": "anon 10\nfile 20\n"}[name]
        if path in self.files:
            return self.files[path]
        raise FileNotFoundError(path)

    def read_bytes(self, path):
        if path in self.files:
            return self.files[path]
        with open(path, "rb") as f:
            return f.read()

    def exists(self, path):
        return path in self.files or os.path.lexists(path)

    def stat(self, path):
        assert path == B.MODEL_PATH, path
        return types.SimpleNamespace(st_mode=stat.S_IFREG | 0o644, st_dev=1, st_ino=2, st_size=B.MODEL_SIZE,
                                     st_mtime_ns=3, st_ctime_ns=4)

    def sha256(self, path):
        return {B.RELEASE + "/kernel": B.KERNEL_SHA256, B.RELEASE + "/firmware.fd": B.FIRMWARE_SHA256}.get(path, "f" * 64)

    def readlink(self, path):
        return "/usr/bin/qemu-system-x86_64"

    def access_rw(self, path):
        return True

    def euid(self):
        return 1000

    def kill(self, pid, sig):
        self.kills.append(pid)

    def storage_check(self, path):
        if path in self.storage_bad:
            raise ValueError("USB-attached storage")
        return ["/sys/devices/pci0000:00/nvme"]

    def now(self):
        return float(self.tick)

    def wall(self):
        return 1.0e9 + self.tick

    def sleep(self, s):
        self.tick += 1
        if self.state == "running" and self.tick >= self.exit_after:
            self.state = "exited"


def make_plan(host, out):
    manifest = {"inputs": {"kernel": {"path": B.RELEASE + "/kernel"}, "firmware": {"path": B.RELEASE + "/firmware.fd"},
                           "init": {"sha256": "1" * 64}, "loader": {"sha256": "2" * 64}},
                "sources": {}, "arms": {a: {"initramfs": f"/b/arm-{a}.initramfs.cpio.gz", "sha256": "f" * 64}
                                        for a in B.ARMS}}
    host.files["/b/build-manifest.json"] = json.dumps(manifest)
    args = argparse.Namespace(out=out, build_dir="/b", qemu="/usr/bin/qemu-system-x86_64", cpu_model="EPYC-v4",
                              pending_production_ram_mib=1551, order="AB")
    return R.make_plan(host, args)


class RunHelper(unittest.TestCase):
    def setUp(self):
        self.out = os.path.join(tempfile.mkdtemp(), "run")

    def go(self, **kw):
        host = FakeHost(self.out, **kw)
        plan, digest = make_plan(host, self.out)
        rc = R.execute(host, argparse.Namespace(plan=os.path.join(self.out, "plan.json"), approve_plan_sha256=digest,
                                                execute=True, coordinated_slot="slot-1"))
        with open(os.path.join(self.out, "receipt.json")) as f:
            receipt = json.load(f)
        for c in host.calls:  # only the planned units are ever touched
            self.assertTrue(c[0] == "systemd-run" or c[3] in {a["unit"] for a in plan["arms"]}, c)
        return rc, receipt, host

    def test_success_both_arms(self):
        rc, receipt, host = self.go()
        self.assertEqual(rc, 0)
        self.assertTrue(receipt["success"])
        for a in receipt["arms"]:
            self.assertEqual((a["outcome"], a["guest_poweroff"], a["digest_verified"], a["metrics_available"]),
                             ("success", True, True, True))
            self.assertEqual(a["host"]["cleanup"], "clean")
        self.assertIn("configured only", receipt["snp_claim"])

    def test_low_memory_kill_is_never_success(self):
        rc, receipt, host = self.go(avail=(100 * GiB, 100 * GiB, 10 * GiB), exit_after=99)
        a = receipt["arms"][0]
        self.assertEqual((rc, a["outcome"], a["digest_verified"], a["guest_poweroff"]),
                         (1, "killed_low_host_memory", False, False))
        self.assertEqual(receipt["arms"][1]["outcome"], "not_run")
        self.assertIn(["systemctl", "--user", "stop", a["host"]["unit"]], host.calls)

    def test_identity_change_refuses_to_stop(self):
        rc, receipt, host = self.go(flip_at=1, exit_after=99)
        a = receipt["arms"][0]
        self.assertEqual(a["outcome"], "identity_changed")
        self.assertFalse(any(c[2] == "stop" for c in host.calls if c[0] == "systemctl"))

    def test_limits_not_enforced(self):
        rc, receipt, _ = self.go(limits={"memory.max": "max", "memory.swap.max": "max", "cpu.max": "max 100000"})
        self.assertEqual(receipt["arms"][0]["outcome"], "limits_not_enforced")

    def test_qemu_failure_and_guest_error(self):
        self.assertEqual(self.go(status="1")[1]["arms"][0]["outcome"], "qemu_failed")
        self.setUp()
        self.assertEqual(self.go(log=guest_log("A", status="error"))[1]["arms"][0]["outcome"], "guest_error")

    def test_preflight_usb_refused_without_start(self):
        rc, receipt, host = self.go(storage_bad=(B.MODEL_PATH,))
        self.assertEqual(receipt["arms"][0]["outcome"], "preflight_refused")
        self.assertFalse(any(c[0] == "systemd-run" for c in host.calls))

    def test_low_ram_refused_before_boot(self):
        rc, receipt, host = self.go(avail=(60 * GiB,))
        self.assertEqual(receipt["arms"][0]["outcome"], "preflight_refused")
        self.assertFalse(any(c[0] == "systemd-run" for c in host.calls))

    def test_plan_gates(self):
        host = FakeHost(self.out)
        plan, digest = make_plan(host, self.out)
        with self.assertRaises(FileExistsError):
            make_plan(host, self.out)
        ns = lambda **kw: argparse.Namespace(**{"plan": os.path.join(self.out, "plan.json"),
                                                "approve_plan_sha256": digest, "execute": True,
                                                "coordinated_slot": "s", **kw})
        with self.assertRaises(ValueError):
            R.execute(host, ns(approve_plan_sha256="0" * 64))
        with self.assertRaises(ValueError):
            R.execute(host, ns(coordinated_slot=None))
        self.assertEqual(R.execute(host, ns(execute=False)), 0)
        self.assertFalse(any(c[0] == "systemd-run" for c in host.calls), "dry run started a unit")
        with self.assertRaises(ValueError):
            make_plan(FakeHost(B.RELEASE + "/bench"), B.RELEASE + "/bench")
        open(os.path.join(self.out, "receipt.json"), "w").close()
        with self.assertRaises(ValueError):
            R.execute(host, ns())


if __name__ == "__main__":
    unittest.main()
