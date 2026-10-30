#!/usr/bin/env python3
"""witness-producer-service-stage/r3 offline tests (PREPARED; NOT run by Claude). Loopback only (unshare -Urn, lo up); no node, no
network, no witness produced. Every fetch is a REAL child process launched through the REAL /usr/bin/prlimit by the r3 producer
(a fake fetcher script stands in for witness_fetch; its sha is pinned for the test only). The HTTP framing is the REAL r14 bridge.
Root 1589: the cap must hold WHILE writing (RLIMIT_FSIZE), stderr must be bounded, and nothing may be served or left behind."""
import errno, hashlib, http.client, json, os, shutil, signal, socket, sys, tempfile, threading, time, unittest

HERE = os.path.dirname(os.path.abspath(__file__))
STAGE = os.path.dirname(HERE)
W = os.path.normpath(os.path.join(STAGE, "..", ".."))
sys.path.insert(0, os.path.join(STAGE, "producer"))
sys.dont_write_bytecode = True
import witness_producer as P  # noqa: E402

R1 = f"{W}/witness-producer-service-stage/r1"
R1_PRODUCER_SHA256 = "b61a981d4cd959670ed3fc374b75c5e2ab9a1f5b539d990b313680ae906b5233"
BRIDGE = f"{W}/source/ops/rpc-witness-r14-20261026/witness-r2/bridge/witness_rpc_bridge.py"
ORIG = P.FETCH_ELF_SHA256
CAP = 100_000
FAKE = r'''#!/usr/bin/python3 -I
import json, os, resource, signal, sys, time
d = os.path.dirname(os.path.abspath(__file__))
mode = json.load(open(os.path.join(d, "mode.json")))
out = sys.argv[-1]
rec = {"argv": sys.argv[1:], "fsize": resource.getrlimit(resource.RLIMIT_FSIZE)[0], "core": resource.getrlimit(resource.RLIMIT_CORE)[0]}
def log():
    with open(os.path.join(d, "ran"), "a") as f:
        f.write(json.dumps(rec) + "\n")
log()
if mode.get("sigxfsz_default"):
    signal.signal(signal.SIGXFSZ, signal.SIG_DFL)           # like a Rust binary: SIGXFSZ terminates
if mode.get("configs"):                                     # what the upstream fetcher writes under its cwd
    for sub, n in (("configs/L1", "1.json"), ("configs/L2", "8453.json")):
        os.makedirs(sub, exist_ok=True); open(os.path.join(sub, n), "w").write("{}")
if mode.get("extra"):
    open("extra.bin", "wb").write(b"x")
if mode.get("stderr"):
    for _ in range(mode["stderr"] // 65536):
        sys.stderr.buffer.write(b"e" * 65536)
    sys.stderr.buffer.write(b"MARKER-END"); sys.stderr.flush()
if mode.get("sleep"):
    time.sleep(mode["sleep"])
if mode.get("big"):
    f = open(out + ".partial", "wb", buffering=0)
    try:
        while True:
            f.write(b"x" * 65536)
            rec["size"] = os.fstat(f.fileno()).st_size; log()
            if rec["size"] >= mode["big"]:
                break
    except OSError as e:
        rec["errno"], rec["size"] = e.errno, os.fstat(f.fileno()).st_size; log(); sys.exit(1)
    os.rename(out + ".partial", out); sys.exit(0)
open(out + ".partial", "wb").write(json.dumps(rec).encode()); os.rename(out + ".partial", out)
sys.exit(mode.get("rc", 0))
'''


def sha(p):
    with open(p, "rb") as f:
        return hashlib.sha256(f.read()).hexdigest()


def free_port():
    s = socket.socket(); s.bind(("127.0.0.1", 0)); p = s.getsockname()[1]; s.close(); return p


class Base(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix="wp3", dir=os.environ.get("TEST_TMP")); self.addCleanup(shutil.rmtree, self.tmp, True)
        self.fake = f"{self.tmp}/fetch/witness_fetch"; os.makedirs(os.path.dirname(self.fake))
        with open(self.fake, "w") as f:
            f.write(FAKE)
        os.chmod(self.fake, 0o755); self.mode({})
        P.FETCH_ELF_SHA256 = sha(self.fake); self.addCleanup(setattr, P, "FETCH_ELF_SHA256", ORIG)
        self.work = f"{self.tmp}/work"; os.mkdir(self.work, 0o700)
        self.cfg = {"format": P.CONFIG_FORMAT, "listen": {"host": "127.0.0.1", "port": free_port()},
                    "fetch": {"path": self.fake, "sha256": P.FETCH_ELF_SHA256}, "bridge": {"path": BRIDGE, "sha256": P.BRIDGE_SHA256},
                    "endpoints": {"l1Rpc": "http://127.0.0.1:18647", "l1Beacon": "http://127.0.0.1:15052", "l2Rpc": "http://127.0.0.1:18547",
                                  "l2Node": "http://127.0.0.1:17545"},
                    "maxBlocks": 1800, "maxWitnessBytes": 1 << 20, "fetchTimeoutSec": 30, "fetchMemoryMiB": 1024, "minMemAvailableMiB": 0,
                    "workDir": self.work}
        self.logs = []

    def mode(self, m):
        with open(f"{self.tmp}/fetch/mode.json", "w") as f:
            json.dump(m, f)

    def ran(self):
        p = f"{self.tmp}/fetch/ran"
        return [json.loads(l) for l in open(p)] if os.path.exists(p) else []

    def start(self, **over):
        self.cfg.update(over)
        p = f"{self.tmp}/cfg.json"
        with open(p, "w") as f:
            json.dump(self.cfg, f)
        os.chmod(p, 0o600)
        self.prod = P.Producer(P.load_config(p), log=self.logs.append)
        self.prod.mem_available_mib = lambda: 1 << 20
        threading.Thread(target=self.prod.serve_forever, daemon=True).start()
        self.addCleanup(lambda: self.assertEqual(self.prod.shutdown(), [], "orphaned producer handler threads"))   # r5: workers joined

    def body(self, cap=CAP, **over):
        t = {"chainId": 8453, "l1Head": "0x" + "11" * 32, "l1HeadNumber": 21000000, "agreedL2OutputRoot": "0x" + "22" * 32,
             "claimedL2OutputRoot": "0x" + "33" * 32, "claimedL2BlockNumber": 1030, "rollupConfig": {"l2_chain_id": 8453},
             "expectedRollupConfigHash": "0x" + "44" * 32, "expectedScheduleId": "0x" + "55" * 32, "intermediateBlockInterval": 30}
        r = {"format": P.REQUEST_FORMAT, "track": "final", "trusted": t, "agreedL2BlockNumber": 1000, "maximumWitnessBytes": cap}
        r.update(over)
        return json.dumps(r).encode()

    def post(self, data, timeout=120):
        c = http.client.HTTPConnection("127.0.0.1", self.cfg["listen"]["port"], timeout=timeout)
        try:
            c.request("POST", "/witness", data, {"content-type": "application/json"})
            r = c.getresponse(); res = (r.status, r.getheader("content-type"), r.read())
        finally:
            c.close()
        # root 1610: the client has its last byte BEFORE the server's cleanup/log/slot release; observe the handler's completion
        self.assertTrue(self.prod.wait_quiescent(60), "the producer handler did not complete")
        return res


class OutputBound(Base):
    def test_a_child_writing_past_the_cap_is_refused_at_write_time_nothing_served_nothing_left(self):
        self.start(); self.mode({"big": 4 * CAP})                       # tries to write 4x the cap (EFBIG: Python ignores SIGXFSZ)
        st, ct, data = self.post(self.body())
        self.assertEqual((st, ct), (502, "application/json")); self.assertNotIn(b"xxxx", data)
        last = self.ran()[-1]
        self.assertEqual(last["errno"], errno.EFBIG); self.assertLessEqual(last["size"], CAP)     # the disk never held more than the cap
        self.assertTrue(all(r.get("size", 0) <= CAP for r in self.ran()))
        self.assertEqual(os.listdir(self.work), []); self.assertEqual(self.logs[-1]["leftover"], []); self.assertFalse(self.logs[-1]["served"])

    def test_a_child_killed_by_sigxfsz_is_refused_and_cleaned(self):
        self.start(); self.mode({"big": 4 * CAP, "sigxfsz_default": True})
        st, ct, data = self.post(self.body())
        self.assertEqual(st, 502); self.assertIn(b"file bound", data)
        self.assertEqual(self.logs[-1]["rc"], -signal.SIGXFSZ)
        self.assertTrue(all(r.get("size", 0) <= CAP for r in self.ran()))
        self.assertEqual(os.listdir(self.work), [])

    def test_the_child_runs_with_fsize_equal_to_the_request_cap_and_no_core(self):
        self.start()
        st, ct, data = self.post(self.body(cap=77_777))
        self.assertEqual((st, ct), (200, "application/octet-stream"))
        rec = json.loads(data)
        self.assertEqual((rec["fsize"], rec["core"]), (77_777, 0))
        self.assertEqual(rec["argv"][:8], ["http://127.0.0.1:18647", "http://127.0.0.1:15052", "http://127.0.0.1:18547", "http://127.0.0.1:17545",
                                           "1000", "1030", "0x" + "11" * 32, "30"])
        self.assertTrue(rec["argv"][8].startswith(self.work + "/w-") and rec["argv"][8].endswith("/witness.json"))

    def test_a_witness_of_exactly_the_cap_is_served_one_byte_over_is_not(self):
        self.start(); self.mode({"big": 65536})                         # one 64 KiB write: == cap 65536 is served
        st, ct, data = self.post(self.body(cap=65536))
        self.assertEqual((st, ct), (200, "application/octet-stream")); self.assertEqual(len(data), 65536)
        st, ct, data = self.post(self.body(cap=65535))
        self.assertEqual(st, 502); self.assertEqual(os.listdir(self.work), [])


class Stderr(Base):
    def test_a_50_mb_stderr_flood_is_drained_into_a_bounded_tail_never_a_file(self):
        self.start(); self.mode({"stderr": 50 << 20})
        st, ct, data = self.post(self.body())
        self.assertEqual(st, 200)
        tail = self.logs[-1]["stderrTail"]
        self.assertLessEqual(len(tail), 300); self.assertTrue(tail.endswith("MARKER-END"))
        self.assertEqual(os.listdir(self.work), [])

    def test_a_failing_child_reports_only_the_bounded_tail(self):
        self.start(); self.mode({"stderr": 1 << 20, "rc": 3})
        st, ct, data = self.post(self.body())
        self.assertEqual(st, 502); self.assertIn(b"rc 3", data); self.assertIn(b"MARKER-END", data); self.assertLess(len(data), 1024)


class Cleanup(Base):
    def test_the_upstream_fetchers_config_files_are_removed(self):
        self.start(); self.mode({"configs": True})
        self.assertEqual(self.post(self.body())[0], 200)
        self.assertEqual(os.listdir(self.work), []); self.assertEqual(self.logs[-1]["leftover"], [])

    def test_an_unknown_leftover_is_kept_and_logged_never_deleted(self):
        self.start(); self.mode({"extra": True})
        self.assertEqual(self.post(self.body())[0], 200)
        self.assertEqual(self.logs[-1]["leftover"], ["extra.bin"])
        runs = os.listdir(self.work); self.assertEqual(len(runs), 1)
        self.assertTrue(os.path.exists(os.path.join(self.work, runs[0], "extra.bin")))


class Regressions(Base):
    def test_malformed_requests_never_run_a_child_and_the_deadline_kills_it(self):
        self.start(fetchTimeoutSec=1)
        for d in (self.body(extra=1), self.body(track="cold"), self.body(cap=(1 << 20) + 1), b"not json"):
            self.assertEqual(self.post(d)[0], 400)
        self.assertEqual(self.ran(), [])
        self.mode({"sleep": 60})
        t0 = time.monotonic(); self.assertEqual(self.post(self.body())[0], 504); self.assertLess(time.monotonic() - t0, 10)
        self.assertEqual(os.listdir(self.work), [])

    def test_r1_is_unchanged_and_r3_keeps_its_provenance_pins(self):
        self.assertEqual(sha(f"{R1}/producer/witness_producer.py"), R1_PRODUCER_SHA256)
        r1 = open(f"{R1}/producer/witness_producer.py").read()
        for k in ("FETCH_ELF_SHA256", "FETCH_SOURCE_SHA256", "BRIDGE_SHA256", "REQUEST_FORMAT", "CONFIG_FORMAT"):
            self.assertIn(f'{k} = "{getattr(P, k) if k != "FETCH_ELF_SHA256" else ORIG}"', r1, k)
        self.assertEqual(P.TRUSTED_KEYS[-1], "intermediateBlockInterval")


class Shutdown(Base):
    def test_shutdown_kills_a_running_fetch_joins_its_handler_and_refuses_new_work(self):
        """r5 regression for the real r1/r3 defect: shutdown() only closed the listener (orphaned handler + fetch child)"""
        self.start(fetchTimeoutSec=60); self.mode({"sleep": 60})
        res = {}
        th = threading.Thread(target=lambda: res.update(r=self._raw_post(self.body()))); th.start()
        end = time.monotonic() + 30
        while not self.ran() and time.monotonic() < end:                # the REAL child has started (it logs first)
            time.sleep(0.05)
        self.assertTrue(self.ran(), "the fetch child never started")
        pid = None
        with self.prod.cv:
            pid = next(iter(self.prod.procs), None)
        self.assertIsNotNone(pid)
        t0 = time.monotonic(); self.assertEqual(self.prod.shutdown(), []); self.assertLess(time.monotonic() - t0, 15)
        self.assertFalse(os.path.exists(f"/proc/{pid}") and open(f"/proc/{pid}/stat").read().split()[2] != "Z", "fetch child survived")
        th.join(30); self.assertEqual(res["r"][0], 502)                 # the client got an explicit refusal, never witness bytes
        self.assertTrue(self.prod.wait_quiescent(5)); self.assertEqual(os.listdir(self.work), [])
        with self.assertRaises(OSError):
            socket.create_connection(("127.0.0.1", self.cfg["listen"]["port"]), timeout=2)

    def _raw_post(self, data):
        c = http.client.HTTPConnection("127.0.0.1", self.cfg["listen"]["port"], timeout=120)
        try:
            c.request("POST", "/witness", data, {"content-type": "application/json"})
            r = c.getresponse(); return r.status, r.read()
        finally:
            c.close()


if __name__ == "__main__":
    unittest.main()
