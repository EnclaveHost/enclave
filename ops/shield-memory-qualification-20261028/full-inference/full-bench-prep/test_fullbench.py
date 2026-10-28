#!/usr/bin/env python3
"""Offline fixtures for fullbench.py. No VM, unit, GPU or process is started;
the release is a temp tree and the host (clock, systemd, /proc, cgroups,
nvidia-smi, children) is faked."""

import copy
import hashlib
import json
import os
import subprocess
import tempfile
import unittest

import fullbench as F

GiB, MiB = 1 << 30, 1 << 20
U0, U1 = "GPU-11111111-2222-3333-4444-555555555555", "GPU-66666666-7777-8888-9999-000000000000"
CLIENT_OK = ("evidence: x\nVERDICT attested reason=\"ok\"\nRESULT app_status=200\nRESULT app_body="
             + json.dumps(json.dumps({"tokens": [1, 2], "tokens_fnv1a64": "00", "decode_ms": 10}))
             + "\nRESULT app_on_pinned_key=1\n").encode()
CLIENT_REJECT = ("RESULT runtime_selftest=\"exec_pages=allowed wx=clean maps=4 runtime=0 root=4 scope=all-processes\"\n"
                 "VERDICT reject reason=\"REJECT: the runtime self-test covered NO runtime process (runtime=0)\"\n"
                 "RESULT gate=closed\nRESULT app_requests_sent=0\n").encode()
# lines of full-smoke-fw-r1/serial-0-A.log, in their real order (the front's lines interleave with init's)
SERIAL_BOOT = ("\x1b[2J\x1b[001;001H\n"
               "DOM snp=1 vcpus=16 memMiB=56030 boot_ms=7294\n"
               "MODEL verified bytes=17559178144 sha256=" + "3f" * 32 + " copy_verify_ms=29223\n"
               "DOM runtime selftest exec_pages=allowed wx=at-each-attestation\n"
               "DOM app config: none\n").encode()
SECCOMP_LINE = ("DOM seccomp: app filter installed (sha256 " + "d4" * 32 + ", 71 rules)\n").encode()
STARTED_LINE = b"DOM started app=216 front=210 at_ms=36643\n"
SERVING_LINE = ("DOM serving vsock=443 spki_sha256=" + "ae" * 32 + " ready_ms=36675\n").encode()
SERIAL_READY = SERIAL_BOOT + SECCOMP_LINE + STARTED_LINE + SERVING_LINE
SNAP = {"kind": "guestd-commitments/1", "seq": 1, "instance": "0123456789abcdef",
        "pool": {"budgetMemMiB": 98304, "allocatedMemMiB": 6912, "guests": 1, "floorMiB": 18432,
                 "memAvailableMiB": 84081, "pendingMiB": 1551, "unreadUnits": 0},
        "inference": {"cards": 2, "cardBudgetBytes": 33285996544, "cardAllocatedBytes": 4327179550,
                      "cardFreeBytes": 28958816994, "shareBoundedMemory": True, "modelFloorsMiB": {"qwen": 73728}},
        "held": [{"idSha256": "aaaaaaaaaaaaaaaa", "status": "running", "memMiB": 6912, "cpuPct": 800,
                  "gpuCardBytes": 4327179550}]}


def plan_fixture(**over):
    p = {"run_id": "00112233aabbccdd", "guest_mib": 51200, "qemu": {"path": "/usr/bin/qemu-system-x86_64"},
         "pins": {"firmware": "/rel/firmware.fd", "kernel": "/rel/kernel", "runtime": "/rel/template/rt/runtime.json"},
         "cmdline": "console=ttyS0 rdinit=/init loglevel=3", "ring_dir": "/dev/shm/fullbench-00112233aabbccdd",
         "bank_dir": "/srv/bench", "allowed_cpus": "16-31", "runtime_max_sec": 3600, "out": "/srv/run",
         "workers": {"path": "/opt/w/shielded-worker", "vram_gb": 30, "ports": [19601, 19602], "memory_max_mib": 2048,
                     "gpu_uuids": [U0, U1]},
         "trust": {"vcek": "/t/vcek.der", "min_tcb": "/t/tcb.json", "amd_chain": None},
         "node": "/usr/bin/node", "client": "/pgi/client.mjs", "fwd": "/pgi/fwd", "app_sha": "a" * 64,
         "workload": {"rounds": 1, "per_request_timeout_s": 5,
                      "steps": [{"name": "fixture", "concurrency": 1, "query": {"steps": 8}}]},
         "memory": {"mode": "strict"}, "pending_extra_bytes": 0, "production_guests": [], "guestd": None, "gpu": None,
         "poll_sec": 5, "arm_wall_max_sec": 4500, "bank_gib": 1}
    p.update(over)
    arm = {"arm": "A", "seq": 0, "image": "/srv/stage/img-A.cpio.gz", "cid": 200123,
           "bank": "/srv/bench/fullbench-00112233aabbccdd-0-A.padbank", "serial_log": "/srv/run/serial-0-A.log",
           "unit": "fullbench-00112233aabbccdd-a0.service", "measurement": "b" * 96}
    return p, arm


def snapshot_plan(gpu=False):
    p, arm = plan_fixture()
    p["guestd"] = {"url": "http://127.0.0.1:7070", "key_file": "/k/pair.key", "client": "/pgi/control-client.mjs",
                   "client_sha256": "c" * 64, "probe": "/h/probe.mjs", "probe_sha256": "d" * 64, "snapshot": copy.deepcopy(SNAP)}
    p["memory"] = {"mode": "snapshot", "helper_cap_mib": 512, "extra_headroom_mib": 1024,
                   "other_units": [{"name": "control", "cgroup": "/user.slice/control.service", "budget_mib": 4864},
                                   {"name": "custodian", "cgroup": "/user.slice/custodian.service", "budget_mib": 3840}]}
    if gpu:
        p["workers"]["vram_gb"] = 16
        card = lambda pid: {"allowed": [{"pid": pid, "start": "777", "required": True, "used_mib_max": 4500},  # noqa: E731
                                        {"pid": 355837, "start": "888", "required": False, "used_mib_max": 64}],
                            "unlisted_mib_max": 64}
        p["gpu"] = {"mode": "shared", "context_headroom_mib": 1024, "cards": {U0: card(5685), U1: card(5683)}}
    return p, arm


def qemu_of(p, arm):
    u = F.unit_argv(p, arm)
    return u[u.index("--") + 1:]


class FakeProc:
    def __init__(self, host, argv, exits=True, unkillable=False):
        self.host, self.argv, self.pid = host, argv, host.next_pid()
        self.alive, self.returncode, self.exits, self.unkillable, self.killed = True, None, exits, unkillable, False

    def poll(self):
        if self.alive and self.exits:
            self.alive, self.returncode = False, 0
        return None if self.alive else self.returncode

    def kill(self):
        self.killed = True
        if not self.unkillable:
            self.alive, self.returncode = False, -9

    def wait(self, timeout=None):
        if self.poll() is None:
            raise subprocess.TimeoutExpired(self.argv, timeout)
        return self.returncode


class FakeHost:
    def __init__(self, p=None):
        self.p = p
        self.t, self.calls, self.units, self.files, self.dirs = 0.0, [], {}, {}, set()
        self.pids, self.procs_of, self.qemu, self.stuck, self.children = {}, {}, [], set(), []
        self.avail, self._pid, self.on_tick, self.run_timeout = 200 * GiB, 1000, None, set()
        self.smi_apps, self.smi_gpu = "", f"{U0}, 10, 32768\n{U1}, 10, 32768\n"
        self.fwd_out, self.client_exits, self.foreign_exec = b"FWD listening 127.0.0.1:40001 cid=200123\n", True, False
        self.serial, self.client_out = SERIAL_READY, CLIENT_OK   # what the guest unit writes to its -serial file

    def next_pid(self):
        self._pid += 1
        return self._pid

    # clock
    def now(self):
        return self.t

    def wall(self):
        return 1e9 + self.t

    def sleep(self, s):
        self.t += s
        if self.on_tick:
            self.on_tick(self)

    # commands
    def run(self, argv, timeout=60):
        self.calls.append(argv)
        if argv[:3] == ["systemctl", "--user", "show"]:
            u = self.units.get(argv[3])
            return 0, ("LoadState=not-found\n" if u is None else "".join(f"{k}={v}\n" for k, v in u.items())), ""
        if argv[:3] == ["systemctl", "--user", "stop"]:
            u = self.units[argv[3]]
            if argv[3] in self.stuck:
                u["ActiveState"] = "inactive"   # unit says stopped, but a process survives in the cgroup
                return 0, "", ""
            self.pids.pop(int(u["MainPID"]), None)
            self.procs_of[u["ControlGroup"]] = []
            del self.units[argv[3]]             # transient unit is collected
            return 0, "", ""
        if argv[0] == "systemd-run":
            unit, binary = argv[argv.index("--unit") + 1], argv[argv.index("--") + 1]
            pid, cg = self.next_pid(), "/user.slice/user-1000.slice/user@1000.service/app.slice/" + unit
            exe = "/somewhere/else" if self.foreign_exec else binary
            self.units[unit] = {"LoadState": "loaded", "ActiveState": "active", "InvocationID": "inv-" + unit,
                                "MainPID": str(pid), "ControlGroup": cg, "ExecStart": f"{{ path={exe} ; argv[]={exe} ; }}"}
            self.pids[pid], self.procs_of[cg] = str(5000 + pid), [pid]
            mm = [x for x in argv if x.startswith("--property=MemoryMax=")][0].split("=")[-1]
            self.files[f"/sys/fs/cgroup{cg}/memory.max"] = str(int(mm[:-1]) * MiB).encode()
            self.files[f"/sys/fs/cgroup{cg}/memory.swap.max"] = b"0"
            if "-serial" in argv and self.serial is not None:
                self.files[argv[argv.index("-serial") + 1][len("file:"):]] = self.serial
            if unit in self.run_timeout:
                raise subprocess.TimeoutExpired(argv, timeout)
            return 0, "", ""
        if argv[0] == "nvidia-smi":
            return 0, (self.smi_apps if "--query-compute-apps=gpu_uuid,pid,used_memory" in argv else self.smi_gpu), ""
        return 0, "", ""

    def popen(self, argv, out_path):
        assert out_path not in self.files
        if argv[0] == self.p["fwd"]:
            self.files[out_path], pr = self.fwd_out, FakeProc(self, argv, exits=False)
        else:
            self.files[out_path], pr = self.client_out, FakeProc(self, argv, exits=self.client_exits)
        self.children.append(pr)
        return pr

    # filesystem / proc
    def read(self, path):
        if path == "/proc/meminfo":
            return f"MemTotal: {512 * GiB // 1024} kB\nMemAvailable: {self.avail // 1024} kB\n"
        if path not in self.files:
            raise FileNotFoundError(path)
        return self.files[path].decode()

    def read_head(self, path, cap):
        return self.files[path][:cap + 1]

    def read_tail(self, path, cap):
        return self.files[path][-cap:]

    def pid_start(self, pid):
        return self.pids.get(pid)

    def cgroup_procs(self, cg):
        return self.procs_of.get(cg)

    def guests(self, exclude_pid=None):
        return [g for g in self.qemu if g["pid"] != exclude_pid]

    def exists(self, path):
        return path in self.files or path in self.dirs

    def mkdir(self, path, mode):
        self.dirs.add(path)

    def make_sparse(self, path, size):
        assert path not in self.files
        self.files[path] = b""

    def unlink(self, path):
        del self.files[path]

    def rmdir(self, path):
        self.dirs.remove(path)


class RunArmBase(unittest.TestCase):
    def setUp(self):
        self._pre = F.preflight
        F.preflight = lambda host, p, arm=None, live=False, h=None: []   # preflight is covered by the plan path

    def tearDown(self):
        F.preflight = self._pre

    def started_units(self, host):
        return [c[c.index("--unit") + 1] for c in host.calls if c[0] == "systemd-run"]


# ---------------------------------------------------------------- resources

class Resources(unittest.TestCase):
    def test_formula_matches_full_md(self):
        need = F.required_available(51200, 1, 0)
        self.assertEqual(need, 13 * GiB + (51200 + 768) * MiB + 2 * MiB + 18 * GiB)
        self.assertGreater(F.required_available(51200, 1024, 0), 83 * GiB)  # 2 x 1 GiB workers do not fit at 83 GiB

    def test_floor_never_lowered(self):
        with self.assertRaises(ValueError):
            F.required_available(51199, 1024, 0)
        with self.assertRaises(ValueError):
            F.required_available(51200, 1024, -1)

    def test_reclaimable_cache_excluded(self):
        stat = "anon 1\nactive_file 1073741824\ninactive_file 1073741824\nshmem 5\n"
        self.assertEqual(F.held_mib(str(8 * GiB), stat), 6144)
        self.assertEqual(F.held_mib(str(8 * GiB + MiB - 1), stat), 6144)   # rounded DOWN
        h = FakeHost()
        h.files["/sys/fs/cgroup/u.service/memory.current"] = str(8 * GiB).encode()
        h.files["/sys/fs/cgroup/u.service/memory.stat"] = stat.encode()
        self.assertEqual(F.remaining_mib(h, "/u.service", 6912), (768, 6144))

    def test_missing_cgroup_data_reserves_full(self):
        h = FakeHost()
        self.assertEqual(F.remaining_mib(h, "/gone.service", 6912), (6912, None))
        self.assertEqual(F.remaining_mib(h, None, 6912), (6912, None))
        h.files["/sys/fs/cgroup/u.service/memory.current"] = str(GiB).encode()
        h.files["/sys/fs/cgroup/u.service/memory.stat"] = b"active_file 0\n"   # inactive_file missing
        self.assertEqual(F.remaining_mib(h, "/u.service", 6912), (6912, None))

    def test_snapshot_formula_and_extra_headroom(self):
        p, _ = snapshot_plan()
        host = FakeHost(p)
        h = {"owned": {}, "guestd_pending_mib": 1551}
        need = F.need_bytes(host, p, h)
        bench = 51200 + 768 + 2 * 2048
        self.assertEqual(need, 18 * GiB + (1551 + 4864 + 3840 + bench + 512 + 1024) * MiB)
        host.avail = need - 1
        self.assertLess(F.available(host), need)
        p2 = copy.deepcopy(p)
        p2["memory"]["extra_headroom_mib"] = 4096
        self.assertEqual(F.need_bytes(host, p2, h) - need, 3072 * MiB)
        r = {"kind": "fullbench-reservations/1", "guestd": dict(p["guestd"]),
             "memory": {"other_units": p["memory"]["other_units"], "helper_cap_mib": 512, "extra_headroom_mib": 0}}
        with self.assertRaises(ValueError):
            F.validate_reservations(r, [U0, U1])     # headroom below 512 MiB refused

    def test_unbounded_unit_over_budget_refused(self):
        p, _ = snapshot_plan()
        host = FakeHost(p)
        host.files["/sys/fs/cgroup/user.slice/control.service/memory.current"] = str(5 * GiB).encode()
        host.files["/sys/fs/cgroup/user.slice/control.service/memory.stat"] = b"active_file 0\ninactive_file 0\n"
        with self.assertRaises(ValueError):
            F.need_bytes(host, p, {"owned": {}, "guestd_pending_mib": 0})

    def test_snapshot_floor_off_refused(self):
        s = copy.deepcopy(SNAP)
        s["pool"]["floorMiB"] = 0
        with self.assertRaises(ValueError):
            F.check_snapshot(s)
        with self.assertRaises(ValueError):
            F.check_snapshot({"kind": "guestd-commitments-error/1", "error": "key-file"})


# ---------------------------------------------------------------- production changes

class Production(unittest.TestCase):
    def guard_host(self, p, lines):
        host = FakeHost(p)
        host.files["/srv/run/g.jsonl"] = b"".join(json.dumps(x).encode() + b"\n" for x in lines)
        h = {"owned": {}, "wall_deadline": 1e9, "probe_out": "/srv/run/g.jsonl", "probe_seen_at": 0,
             "guestd_pending_mib": 1551, "samples": []}
        return host, h

    def test_reviewed_snapshot_passes(self):
        p, _ = snapshot_plan()
        host, h = self.guard_host(p, [SNAP])
        self.assertIsNone(F.guard(host, p, h))

    def test_new_held_guest_before_qemu_yields(self):
        p, _ = snapshot_plan()
        s2 = copy.deepcopy(SNAP)
        s2["seq"] = 2
        s2["held"].append({"idSha256": "bbbbbbbbbbbbbbbb", "status": "starting", "memMiB": 64281 + 768, "cpuPct": 1600,
                           "gpuCardBytes": 0})
        s2["pool"]["pendingMiB"] += 64281 + 768
        s2["pool"]["allocatedMemMiB"] += 64281 + 768
        s2["pool"]["guests"] += 1
        host, h = self.guard_host(p, [SNAP, s2])
        self.assertEqual(host.guests(), [])              # no QEMU yet: only guestd knows
        why = F.guard(host, p, h)
        self.assertIn("held/starting guests changed", why)

    def test_stale_probe_yields(self):
        p, _ = snapshot_plan()
        host, h = self.guard_host(p, [SNAP])
        self.assertIsNone(F.guard(host, p, h))
        host.t = 3 * p["poll_sec"] + F.PROBE_TIMEOUT + 1
        self.assertIn("stale", F.guard(host, p, h))

    def test_gpu_allocation_change_detected(self):
        s2 = copy.deepcopy(SNAP)
        s2["inference"]["cardAllocatedBytes"] += GiB
        self.assertIn("guestd GPU cardAllocatedBytes changed", F.snapshot_changes(SNAP, s2))


# ---------------------------------------------------------------- GPU policy

class Gpu(unittest.TestCase):
    def test_strict_default_refuses_any_process(self):
        p, _ = plan_fixture()
        host = FakeHost(p)
        host.smi_apps = f"{U0}, 4242, 300\n"
        host.smi_gpu = f"{U0}, 30000, 32768\n{U1}, 10, 32768\n"
        probs = F.gpu_problems(host, p, preflight=True)
        self.assertTrue(any("compute processes" in x for x in probs))
        self.assertFalse(any(U1 in x for x in probs))

    def shared_host(self, p):
        host = FakeHost(p)
        host.pids.update({5685: "777", 5683: "777", 355837: "888"})
        host.smi_apps = f"{U0}, 5685, 4400\n{U1}, 5683, 4400\n"
        host.smi_gpu = f"{U0}, 4436, 32768\n{U1}, 4436, 32768\n"
        return host

    def test_shared_reviewed_inventory_passes(self):
        p, _ = snapshot_plan(gpu=True)
        self.assertEqual(F.gpu_problems(self.shared_host(p), p, preflight=True), [])

    def test_unknown_process_refused(self):
        p, _ = snapshot_plan(gpu=True)
        host = self.shared_host(p)
        host.smi_apps += f"{U0}, 999, 100\n"
        self.assertTrue(any("unknown compute process 999" in x for x in F.gpu_problems(host, p)))

    def test_restarted_production_worker_refused(self):
        p, _ = snapshot_plan(gpu=True)
        host = self.shared_host(p)
        host.pids[5685] = "999999"
        self.assertTrue(any("start time differs" in x for x in F.gpu_problems(host, p)))

    def test_budget_growth_refused(self):
        p, _ = snapshot_plan(gpu=True)
        host = self.shared_host(p)
        host.smi_apps = f"{U0}, 5685, 4600\n{U1}, 5683, 4400\n"
        self.assertTrue(any("reviewed max 4500" in x for x in F.gpu_problems(host, p)))
        host = self.shared_host(p)
        host.smi_gpu = f"{U0}, 9000, 32768\n{U1}, 4436, 32768\n"   # memory not attributed to any listed process
        self.assertTrue(any("unknown VRAM growth" in x for x in F.gpu_problems(host, p)))

    def test_insufficient_device_vram_refused(self):
        p, _ = snapshot_plan(gpu=True)
        host = self.shared_host(p)
        host.smi_gpu = f"{U0}, 4436, 24576\n{U1}, 4436, 32768\n"
        self.assertTrue(any(U0 in x and "total 24576" in x for x in F.gpu_problems(host, p)))

    def test_bench_workers_excluded_by_owned_cgroup(self):
        p, _ = snapshot_plan(gpu=True)
        host = self.shared_host(p)
        host.smi_apps += f"{U0}, 4242, 16000\n"
        host.smi_gpu = f"{U0}, 20436, 32768\n{U1}, 4436, 32768\n"
        self.assertEqual(F.gpu_problems(host, p, owned_pids=frozenset({4242})), [])


# ---------------------------------------------------------------- argv

class Argv(unittest.TestCase):
    def test_planned_argv_passes(self):
        p, arm = plan_fixture()
        self.assertEqual(F.qemu_violations(qemu_of(p, arm), p, arm), [])

    def test_control_sockets_and_pause_refused(self):
        p, arm = plan_fixture()
        q = qemu_of(p, arm)
        for extra in (["-qmp", "unix:/tmp/x,server=on"], ["-S"], ["-chardev", "socket,id=c"], ["-netdev", "user,id=n"]):
            self.assertTrue(F.qemu_violations(q + extra, p, arm), extra)

    def test_host_data_production_ring_and_cid_refused(self):
        p, arm = plan_fixture()
        q = qemu_of(p, arm)
        bad = [x.replace("kernel-hashes=on", "kernel-hashes=on,host-data=AAAA") for x in q]
        self.assertTrue(F.qemu_violations(bad, p, arm))
        bad = [x.replace(p["ring_dir"], "/dev/shm/enclave-shielded-shm") for x in q]
        self.assertTrue(F.qemu_violations(bad, p, arm))
        arm2 = dict(arm, cid=150000)
        self.assertTrue(F.qemu_violations(qemu_of(p, arm2), p, arm2))

    def test_unit_and_worker_limits(self):
        p, arm = plan_fixture()
        u = F.unit_argv(p, arm)
        for want in ("--user", "--property=MemoryMax=51968M", "--property=MemorySwapMax=0", "--property=CPUQuota=1600%",
                     "--property=AllowedCPUs=16-31", "--property=KillMode=control-group"):
            self.assertIn(want, u)
        w = F.worker_argv(p, 1)
        self.assertIn("--property=PrivateNetwork=yes", w)
        self.assertIn("--setenv=CUDA_VISIBLE_DEVICES=" + U1, w)
        self.assertEqual(w[w.index("--host") + 1], "127.0.0.1")
        self.assertEqual(w[-1], p["ring_dir"] + "/card-1")
        self.assertTrue(F.owned_unit(p, F.worker_unit(p, 0)))

    def test_client_is_trusted_mode(self):
        p, arm = plan_fixture()
        c = F.client_argv(p, arm, 40000, "/?steps=8")
        self.assertNotIn("--lab-unsigned", c)
        self.assertNotIn("--t0-diagnostic", c)
        self.assertIn("--no-kds", c)
        self.assertEqual(c[c.index("--measurement") + 1], "b" * 96)

    def test_probe_argv_is_loopback_and_bounded(self):
        p, _ = snapshot_plan()
        p["arm_wall_max_sec"] = 4500
        a = F.probe_argv(p, every=5)
        self.assertEqual(a[a.index("--url") + 1], "http://127.0.0.1:7070")
        self.assertEqual(a[a.index("--max-sec") + 1], "4500")
        r = {"kind": "fullbench-reservations/1", "guestd": dict(p["guestd"], url="http://10.0.0.5:7070"),
             "memory": {"other_units": p["memory"]["other_units"], "helper_cap_mib": 512, "extra_headroom_mib": 1024}}
        with self.assertRaises(ValueError):
            F.validate_reservations(r, [U0, U1])


class Workload(unittest.TestCase):
    def test_repo_workload_valid(self):
        w = F.load_workload(os.path.join(F.HERE, "workload.json"))
        self.assertEqual([s["name"] for s in w["steps"]], ["fixture", "ttft", "fill", "sessions16"])

    def test_probe_path(self):
        self.assertEqual(F.probe_path({"steps": 64, "seed": "3000+i", "prompt": 256}, 5), "/?prompt=256&seed=3005&steps=64")
        with self.assertRaises(ValueError):
            F.probe_path({"seed": "x"}, 0)

    def test_parse_client(self):
        out = CLIENT_OK.decode()
        self.assertTrue(F.parse_client(out)["ok"])
        self.assertFalse(F.parse_client(out.replace("attested", "unauthenticated"))["ok"])
        self.assertFalse(F.parse_client(out.replace("pinned_key=1", "pinned_key=0"))["ok"])


# ---------------------------------------------------------------- ownership

class Ownership(unittest.TestCase):
    def test_stop_refuses_foreign_units(self):
        p, _ = plan_fixture()
        h = FakeHost(p)
        for foreign in ("m2-qwen-123.service", "guestd.service", "fullbench-ffff-a0.service"):
            with self.assertRaises(ValueError):
                F.stop_owned(h, p, {"unit": foreign, "binary": "/x", "invocation": "i"})
        self.assertEqual(h.calls, [])

    def test_changed_invocation_not_touched(self):
        p, _ = plan_fixture()
        host = FakeHost(p)
        host.run(F.worker_argv(p, 0))
        unit = F.worker_unit(p, 0)
        rec = dict(F.unit_identity(F.show(host, unit), unit), unit=unit, binary=p["workers"]["path"])
        host.units[unit]["InvocationID"] = "someone-else"
        errs = F.stop_owned(host, p, rec)
        self.assertTrue(any("InvocationID changed" in e for e in errs))
        self.assertFalse(any(c[:3] == ["systemctl", "--user", "stop"] for c in host.calls))

    def test_unit_present_before_create_is_not_ours(self):
        p, _ = plan_fixture()
        host = FakeHost(p)
        host.units[F.worker_unit(p, 0)] = {"LoadState": "loaded", "ActiveState": "active", "InvocationID": "x"}
        h = {"owned": {}}
        with self.assertRaises(F.Stop):
            F.start_unit(host, p, h, "w0", F.worker_argv(p, 0), p["workers"]["path"])
        self.assertEqual(h["owned"], {})
        self.assertFalse(any(c[0] == "systemd-run" for c in host.calls))

    def test_ambiguous_timeout_claimed_only_with_proof(self):
        p, _ = plan_fixture()
        host = FakeHost(p)
        host.run_timeout.add(F.worker_unit(p, 0))
        h = {"owned": {}}
        with self.assertRaises(F.Stop):
            F.start_unit(host, p, h, "w0", F.worker_argv(p, 0), p["workers"]["path"])
        self.assertTrue(h["owned"]["w0"]["invocation"])        # proven ours: identity captured, so cleanup stops it
        self.assertEqual(F.stop_owned(host, p, h["owned"]["w0"]), [])
        host2 = FakeHost(p)
        host2.run_timeout.add(F.worker_unit(p, 1))
        host2.foreign_exec = True
        h2 = {"owned": {}}
        with self.assertRaises(F.Stop):
            F.start_unit(host2, p, h2, "w1", F.worker_argv(p, 1), p["workers"]["path"])
        self.assertIsNone(h2["owned"]["w1"])                    # not provable: never touched


class Arms(RunArmBase):
    def test_success_then_clean(self):
        p, arm = plan_fixture()
        host = FakeHost(p)
        h = F.run_arm(host, p, arm, 1e12)
        self.assertEqual((h["outcome"], h["cleanup"]), ("success", "clean"))
        self.assertTrue(F.arm_ok(h))
        self.assertFalse(host.exists(p["ring_dir"]) or host.exists(arm["bank"]))
        self.assertTrue(all(not c.alive for c in host.children))

    def test_cleanup_failure_after_success_fails_receipt(self):
        p, arm = plan_fixture()
        host = FakeHost(p)
        host.stuck.add(F.worker_unit(p, 0))
        h = F.run_arm(host, p, arm, 1e12)
        self.assertEqual((h["outcome"], h["workload_outcome"], h["cleanup"]), ("cleanup_failed", "success", "failed"))
        self.assertFalse(F.arm_ok(h))
        self.assertTrue(host.exists(p["ring_dir"] + "/card-0"))    # a worker may still map it: kept

    def test_startup_watchdog_yields_before_guest(self):
        p, arm = plan_fixture()
        host = FakeHost(p)

        def production_starts(hst):
            if hst.t >= 3:
                hst.qemu = [{"pid": 777, "start": "1", "ram_bytes": 64281 * MiB, "cgroup": "0::/x"}]
        host.on_tick = production_starts
        h = F.run_arm(host, p, arm, 1e12)
        self.assertTrue(h["outcome"].startswith("stopped:production_guests_changed"), h["outcome"])
        self.assertNotIn(arm["unit"], self.started_units(host))
        self.assertEqual(h["cleanup"], "clean")

    def test_fwd_first_line_bounded(self):
        p, arm = plan_fixture()
        host = FakeHost(p)
        host.fwd_out = b""
        h = F.run_arm(host, p, arm, 1e12)
        self.assertEqual(h["outcome"], "stopped:timeout:fwd_first_line")
        self.assertEqual(h["cleanup"], "clean")

    def test_request_timeout_kills_clients(self):
        p, arm = plan_fixture()
        host = FakeHost(p)
        host.client_exits = False
        h = F.run_arm(host, p, arm, 1e12)
        self.assertEqual(h["outcome"], "stopped:request_timeout")
        clients = [c for c in host.children if c.argv[1] == p["client"]]
        self.assertTrue(clients and all(c.killed and not c.alive for c in clients))
        self.assertEqual(h["cleanup"], "clean")

    def test_total_wall_deadline(self):
        p, arm = plan_fixture()
        host = FakeHost(p)
        h = F.run_arm(host, p, arm, 5)
        self.assertEqual(h["outcome"], "stopped:wall_deadline")
        self.assertEqual(h["cleanup"], "clean")


# ---------------------------------------------------------------- startup readiness (STARTUP-READINESS.md)

class StartupReadiness(RunArmBase):
    def clients(self, host, p):
        return [c for c in host.children if c.argv[1] == p["client"]]

    def test_real_serial_order_parses(self):
        m = F.startup_markers(SERIAL_READY.decode())
        self.assertEqual((m["app_pid"], m["front_pid"], m["started_at_ms"], m["serving_ready_ms"]), (216, 210, 36643, 36675))
        self.assertFalse(m["serving_seen_before_started"])
        self.assertIsNone(F.startup_markers(SERIAL_READY.decode()[:-1]))           # a partial last line is not read
        self.assertIsNone(F.startup_markers((SERIAL_BOOT + SECCOMP_LINE + STARTED_LINE).decode()))   # not serving yet
        self.assertIsNone(F.startup_markers((SERIAL_BOOT + SERVING_LINE).decode()))   # serving alone: app not started
        either = F.startup_markers((SERIAL_BOOT + SECCOMP_LINE + SERVING_LINE + STARTED_LINE).decode())
        self.assertTrue(either["serving_seen_before_started"])                   # the front's goroutine may print first

    def test_no_request_before_markers(self):
        p, arm = plan_fixture()
        host = FakeHost(p)
        host.serial = SERIAL_BOOT
        log, boot, at_popen = arm["serial_log"], {}, []

        def guest_progresses(hst):           # the app starts 20 s after the guest, the front says serving 5 s later
            if log not in hst.files:
                return
            boot.setdefault("t", hst.t)
            if hst.t - boot["t"] >= 20 and STARTED_LINE not in hst.files[log]:
                hst.files[log] += SECCOMP_LINE + STARTED_LINE
            elif hst.t - boot["t"] >= 25 and SERVING_LINE not in hst.files[log]:
                hst.files[log] += SERVING_LINE
        host.on_tick = guest_progresses
        real_popen = host.popen

        def popen(argv, out):
            if argv[1] == p["client"]:
                at_popen.append(host.files.get(log, b""))   # the serial as it stood when the client was started
            return real_popen(argv, out)
        host.popen = popen
        h = F.run_arm(host, p, arm, 1e12)
        self.assertEqual((h["outcome"], h["cleanup"]), ("success", "clean"))
        self.assertEqual(len(at_popen), 1)
        self.assertTrue(STARTED_LINE in at_popen[0] and SERVING_LINE in at_popen[0])
        r = h["startup_readiness"]
        self.assertEqual((r["app_pid"], r["front_pid"]), (216, 210))
        self.assertIn("untrusted", r["signal"])
        self.assertGreater(r["waited_s"], 0)

    def test_missing_markers_time_out_without_request(self):
        p, arm = plan_fixture()
        host = FakeHost(p)
        host.serial = SERIAL_BOOT + SECCOMP_LINE          # boot and filter, but never started/serving
        h = F.run_arm(host, p, arm, 1e12)
        self.assertEqual(h["outcome"], "stopped:timeout:startup_readiness")
        self.assertEqual(self.clients(host, p), [])
        self.assertEqual(h["requests"], [])
        self.assertEqual(h["cleanup"], "clean")

    def test_missing_serial_file_times_out(self):
        p, arm = plan_fixture()
        host = FakeHost(p)
        host.serial = None
        h = F.run_arm(host, p, arm, 1e12)
        self.assertEqual(h["outcome"], "stopped:timeout:startup_readiness")
        self.assertEqual(self.clients(host, p), [])

    def test_guest_error_fails_closed(self):
        p, arm = plan_fixture()
        for tail in (b"DOM ERROR the front release failed: the app is not started\n",
                     SECCOMP_LINE + STARTED_LINE + b"DOM ERROR app exited status=1\nDOM end\n" + SERVING_LINE,
                     b"DOM end\n"):
            host = FakeHost(p)
            host.serial = SERIAL_BOOT + tail
            h = F.run_arm(host, p, arm, 1e12)
            self.assertTrue(h["outcome"].startswith("stopped:guest_startup_error: DOM "), h["outcome"])
            self.assertEqual(self.clients(host, p), [])
            self.assertTrue(h["serial_dom_errors"])
            self.assertEqual(h["cleanup"], "clean")

    def test_marker_order_and_shape_fail_closed(self):
        p, arm = plan_fixture()
        for serial, why in ((SERIAL_BOOT + STARTED_LINE + SECCOMP_LINE + SERVING_LINE, "stopped:startup_marker_order"),
                            (SERIAL_READY + STARTED_LINE, "stopped:startup_marker_duplicate"),
                            (SERIAL_BOOT + SECCOMP_LINE + b"DOM started app=210 front=210 at_ms=1\n" + SERVING_LINE,
                             "stopped:startup_marker_malformed")):
            host = FakeHost(p)
            host.serial = serial
            h = F.run_arm(host, p, arm, 1e12)
            self.assertTrue(h["outcome"].startswith(why), h["outcome"])
            self.assertEqual(self.clients(host, p), [])

    def test_full_watchdog_runs_during_wait(self):
        p, arm = plan_fixture()
        host = FakeHost(p)
        host.serial = SERIAL_BOOT

        def production_starts(hst):
            if arm["unit"] in hst.units and hst.t >= 60:
                hst.qemu = [{"pid": 777, "start": "1", "ram_bytes": 64281 * MiB, "cgroup": "0::/x"}]
        host.on_tick = production_starts
        h = F.run_arm(host, p, arm, 1e12)
        self.assertTrue(h["outcome"].startswith("stopped:production_guests_changed"), h["outcome"])
        self.assertEqual(self.clients(host, p), [])
        self.assertEqual(h["cleanup"], "clean")

    def test_reject_after_ready_is_not_retried(self):
        p, arm = plan_fixture()
        host = FakeHost(p)
        host.client_out = CLIENT_REJECT
        h = F.run_arm(host, p, arm, 1e12)
        self.assertEqual(h["outcome"], "request_failed")
        self.assertEqual(len(self.clients(host, p)), 1)                       # one attempt; the verdict stands
        self.assertEqual(h["requests"][0]["results"][0]["verdict"], "reject")
        self.assertFalse(F.arm_ok(h))


# ---------------------------------------------------------------- stage

class Stage(unittest.TestCase):
    def setUp(self):
        self.d = tempfile.mkdtemp()
        self.rel = os.path.join(self.d, "rel")
        files = {"template/init": b"init", "template/shieldmodel": b"prod-loader", "template/rt/runtime.json": b"{}",
                 "kernel": b"k", "firmware.fd": b"f"}
        meta = {}
        for rp, data in files.items():
            path = os.path.join(self.rel, rp)
            os.makedirs(os.path.dirname(path), exist_ok=True)
            with open(path, "wb") as f:
                f.write(data)
            meta[rp] = {"sha256": hashlib.sha256(data).hexdigest(), "size": len(data)}
        with open(os.path.join(self.rel, "release.json"), "w") as f:
            json.dump({"cmdline": "console=ttyS0 rdinit=/init loglevel=3", "dirs": ["template", "template/rt", "template/tmp"],
                       "files": meta}, f)
        self.cand = os.path.join(self.d, "cand")
        with open(self.cand, "wb") as f:
            f.write(b"candidate-loader")
        self._elf = F.B.check_static_elf_amd64
        F.B.check_static_elf_amd64 = lambda path: None   # fixture bytes are not ELF

    def tearDown(self):
        F.B.check_static_elf_amd64 = self._elf

    def test_arms_differ_only_in_loader_and_marker(self):
        m = F.stage(self.rel, self.cand, os.path.join(self.d, "out"))
        a, b, a1 = m["arms"]["A"], m["arms"]["B"], m["arms"]["A1"]
        self.assertEqual({k for k in set(a) | set(b) if a.get(k) != b.get(k)}, {"shieldmodel", F.DROP_MARKER})
        self.assertEqual({k for k in set(a) | set(a1) if a.get(k) != a1.get(k)}, {"shieldmodel"})
        with open(os.path.join(self.d, "out", "B", F.DROP_MARKER), "rb") as f:
            self.assertEqual(f.read(), b"1\n")
        self.assertTrue(os.path.isdir(os.path.join(self.d, "out", "A", "tmp")))

    def test_tampered_release_refused(self):
        with open(os.path.join(self.rel, "template/init"), "wb") as f:
            f.write(b"evil")
        with self.assertRaises(ValueError):
            F.stage(self.rel, self.cand, os.path.join(self.d, "out2"))

    def test_extra_template_file_refused(self):
        with open(os.path.join(self.rel, "template/extra"), "wb") as f:
            f.write(b"x")
        with self.assertRaises(ValueError):
            F.stage(self.rel, self.cand, os.path.join(self.d, "out3"))


if __name__ == "__main__":
    unittest.main()
