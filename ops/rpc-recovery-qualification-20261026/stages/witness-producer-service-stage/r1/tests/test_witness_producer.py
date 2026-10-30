#!/usr/bin/env python3
"""witness-producer-service-stage/r1 offline tests (PREPARED; NOT run by Claude). Loopback sockets only (run under unshare -Urn with lo up);
no node, no network, no witness is produced. The HTTP framing is the REAL qualified r14 bridge module (sha-pinned); the fetch runs through
the REAL /usr/bin/prlimit launcher, with a FAKE fetcher that records its argv (its sha is pinned for the test only). The REAL pinned
witness_fetch ELF (combined-r1 build) is executed offline only for its argument refusals, which happen before any connection."""
import hashlib, http.client, json, os, shutil, socket, subprocess, sys, tempfile, threading, time, unittest

HERE = os.path.dirname(os.path.abspath(__file__))
STAGE = os.path.dirname(HERE)
W = os.path.normpath(os.path.join(STAGE, "..", ".."))
sys.path.insert(0, os.path.join(STAGE, "producer"))
sys.dont_write_bytecode = True
import witness_producer as P  # noqa: E402

BRIDGE = f"{W}/source/ops/rpc-witness-r14-20261026/witness-r2/bridge/witness_rpc_bridge.py"
COMBINED = f"{W}/derivation-client-stage/combined-r1"
REAL_FETCH = f"{COMBINED}/build/deps-43698236e9186750/target/debug/examples/witness_fetch"
ORIG_FETCH_SHA = P.FETCH_ELF_SHA256
FAKE = r'''#!/usr/bin/python3 -I
import json, os, sys, time
d = os.path.dirname(os.path.abspath(__file__))
mode = json.load(open(os.path.join(d, "mode.json")))
with open(os.path.join(d, "ran"), "a") as f:
    f.write(json.dumps({"argv": sys.argv[1:], "pid": os.getpid(), "env": sorted(os.environ)}) + "\n")
out = sys.argv[-1]
if mode.get("sleep"):
    time.sleep(mode["sleep"])
if mode.get("bytes") is not None:
    data = json.dumps(sys.argv[1:]).encode() if mode["bytes"] == "ARGV" else mode["bytes"].encode()
    open(out + ".partial", "wb").write(data); os.rename(out + ".partial", out)
sys.exit(mode.get("rc", 0))
'''
EP = {"l1Rpc": "http://127.0.0.1:18647", "l1Beacon": "http://127.0.0.1:15052", "l2Rpc": "http://127.0.0.1:18547", "l2Node": "http://127.0.0.1:17545"}


def sha(p):
    with open(p, "rb") as f:
        return hashlib.sha256(f.read()).hexdigest()


def free_port():
    s = socket.socket(); s.bind(("127.0.0.1", 0)); p = s.getsockname()[1]; s.close(); return p


class Base(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix="wp", dir=os.environ.get("TEST_TMP")); self.addCleanup(shutil.rmtree, self.tmp, True)
        self.fake = f"{self.tmp}/fetch/witness_fetch"; os.makedirs(os.path.dirname(self.fake))
        with open(self.fake, "w") as f:
            f.write(FAKE)
        os.chmod(self.fake, 0o755); self.mode({"bytes": "ARGV"})
        P.FETCH_ELF_SHA256 = sha(self.fake); self.addCleanup(setattr, P, "FETCH_ELF_SHA256", ORIG_FETCH_SHA)
        self.work = f"{self.tmp}/work"; os.mkdir(self.work, 0o700)
        self.cfg = {"format": P.CONFIG_FORMAT, "listen": {"host": "127.0.0.1", "port": free_port()},
                    "fetch": {"path": self.fake, "sha256": P.FETCH_ELF_SHA256}, "bridge": {"path": BRIDGE, "sha256": P.BRIDGE_SHA256},
                    "endpoints": dict(EP), "maxBlocks": 1800, "maxWitnessBytes": 1 << 20, "fetchTimeoutSec": 20, "fetchMemoryMiB": 1024,
                    "minMemAvailableMiB": 1024, "workDir": self.work}
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
        th = threading.Thread(target=self.prod.serve_forever, daemon=True); th.start()
        self.addCleanup(self.prod.shutdown)
        return self.prod

    def body(self, trusted=None, **over):
        t = {"chainId": 8453, "l1Head": "0x" + "11" * 32, "l1HeadNumber": 21000000, "agreedL2OutputRoot": "0x" + "22" * 32,
             "claimedL2OutputRoot": "0x" + "33" * 32, "claimedL2BlockNumber": 1030, "rollupConfig": {"l2_chain_id": 8453},
             "expectedRollupConfigHash": "0x" + "44" * 32, "expectedScheduleId": "0x" + "55" * 32, "intermediateBlockInterval": 30}
        t.update(trusted or {})
        r = {"format": P.REQUEST_FORMAT, "track": "final", "trusted": t, "agreedL2BlockNumber": 1000, "maximumWitnessBytes": 1 << 20}
        r.update(over)
        return json.dumps(r).encode()                        # the driver transport's JSON.stringify order

    def post(self, data, timeout=60):
        c = http.client.HTTPConnection("127.0.0.1", self.cfg["listen"]["port"], timeout=timeout)
        try:
            c.request("POST", "/witness", data, {"content-type": "application/json"})
            r = c.getresponse(); return r.status, r.getheader("content-type"), r.getheader("content-length"), r.read()
        finally:
            c.close()

    def raw(self, data, timeout=10):
        s = socket.create_connection(("127.0.0.1", self.cfg["listen"]["port"]), timeout=timeout); s.sendall(data)
        out = b""
        while True:
            b = s.recv(65536)
            if not b:
                break
            out += b
        s.close(); return out

    def alive_fakes(self):
        n = []
        for pid in filter(str.isdigit, os.listdir("/proc")):
            try:
                if self.fake.encode() in open(f"/proc/{pid}/cmdline", "rb").read():
                    n.append(pid)
            except OSError:
                pass
        return n


class Serve(Base):
    def test_serves_exactly_the_fetchers_bytes_with_the_runners_argv_mapping(self):
        self.start()
        st, ct, cl, data = self.post(self.body())
        self.assertEqual((st, ct, int(cl)), (200, "application/octet-stream", len(data)))
        argv = json.loads(data)                                    # the fake fetcher's output = its own argv
        self.assertEqual(argv[:8], [EP["l1Rpc"], EP["l1Beacon"], EP["l2Rpc"], EP["l2Node"], "1000", "1030", "0x" + "11" * 32, "30"])
        self.assertTrue(argv[8].startswith(self.work + "/w-") and argv[8].endswith("/witness.json"))
        self.assertEqual([k for k in self.ran()[0]["env"] if k != "LC_CTYPE"], ["PATH"])  # only PATH (LC_CTYPE: python's own coercion)
        self.assertEqual(os.listdir(self.work), [])                                     # no witness kept: no cache
        log = self.logs[-1]
        self.assertEqual((log["served"], log["bytes"], log["witnessSha256"], log["rc"]), (True, len(data), hashlib.sha256(data).hexdigest(), 0))
        self.assertEqual(log["requestSha256"], hashlib.sha256(self.body()).hexdigest())
        st2, *_ = self.post(self.body(track="provisional", agreedL2BlockNumber=1029, trusted={"intermediateBlockInterval": 1}))
        self.assertEqual(st2, 200)

    def test_malformed_requests_never_reach_the_fetcher(self):
        self.start()
        b = json.loads(self.body())
        t = b["trusted"]
        swapped = dict(reversed(list(t.items())))
        bad = [self.body(extra=1), json.dumps({k: v for k, v in b.items() if k != "track"}).encode(), self.body(format="enclave-derived-witness-request/v2"),
               self.body(track="cold"), json.dumps({**b, "trusted": swapped}).encode(), json.dumps({**b, "trusted": {k: v for k, v in t.items() if k != "rollupConfig"}}).encode(),
               self.body(trusted={"chainId": 1}), self.body(trusted={"chainId": True}), self.body(trusted={"l1Head": "0x" + "AB" * 32}),
               self.body(agreedL2BlockNumber=1030), self.body(trusted={"intermediateBlockInterval": 7}),
               self.body(agreedL2BlockNumber=0, trusted={"claimedL2BlockNumber": 1830}), self.body(maximumWitnessBytes=(1 << 20) + 1),
               self.body(agreedL2BlockNumber=True), self.body(agreedL2BlockNumber=-30), self.body(trusted={"intermediateBlockInterval": 0}),
               b"not json", b"[1, 2]", "ÿ".encode("latin-1")]
        for d in bad:
            st, ct, _, out = self.post(d)
            self.assertEqual((st, ct), (400, "application/json"), d[:120])
        port = self.cfg["listen"]["port"]
        for d, code in ((b"GET /witness HTTP/1.1\r\nHost: x\r\n\r\n", b" 405 "), (b"POST /witness HTTP/1.1\r\nHost: x\r\n\r\n", b" 411 "),
                        (b"POST /w HTTP/1.1\r\nContent-Length: 2000000\r\n\r\n", b" 413 "),
                        (b"POST /w HTTP/1.1\r\nTransfer-Encoding: chunked\r\n\r\n", b" 411 ")):
            self.assertIn(code, self.raw(d).split(b"\r\n")[0], d)
        self.assertEqual(self.ran(), [])
        self.assertEqual(port, self.prod.address[1])

    def test_failed_or_out_of_bounds_output_is_never_served(self):
        self.start()
        for mode, req, needle in (({"bytes": "partial-but-failed", "rc": 1}, self.body(), b"rc 1"),
                                  ({"bytes": "x" * 100}, self.body(maximumWitnessBytes=10), b"outside 1..10"),
                                  ({"bytes": ""}, self.body(), b"outside"), ({"bytes": None}, self.body(), b"no witness output")):
            self.mode(mode)
            st, ct, _, out = self.post(req)
            self.assertEqual((st, ct), (502, "application/json"), mode); self.assertIn(needle, out)
            self.assertEqual(os.listdir(self.work), [])
        self.assertFalse([l for l in self.logs if l.get("served")])


class Bounds(Base):
    def test_deadline_kills_the_fetcher_process_group(self):
        self.start(fetchTimeoutSec=1); self.mode({"sleep": 60, "bytes": "late"})
        t0 = time.monotonic(); st, ct, _, out = self.post(self.body())
        self.assertEqual(st, 504); self.assertLess(time.monotonic() - t0, 10)
        self.assertEqual(self.alive_fakes(), []); self.assertEqual(os.listdir(self.work), [])

    def test_client_disconnect_kills_the_fetch(self):
        self.start(); self.mode({"sleep": 60, "bytes": "late"})
        b = self.body(); s = socket.create_connection(("127.0.0.1", self.cfg["listen"]["port"]))
        s.sendall(b"POST /w HTTP/1.1\r\nContent-Type: application/json\r\nContent-Length: %d\r\n\r\n" % len(b) + b)
        for _ in range(50):
            if self.ran():
                break
            time.sleep(0.1)
        s.close(); time.sleep(2)
        self.assertEqual(self.alive_fakes(), []); self.assertFalse(self.logs[-1]["served"]); self.assertLess(self.logs[-1]["rc"], 0)

    def test_single_flight_second_connection_refused_unread(self):
        self.start(); self.mode({"sleep": 3, "bytes": "ARGV"})
        res = {}
        th = threading.Thread(target=lambda: res.update(first=self.post(self.body()))); th.start()
        for _ in range(50):
            if self.ran():
                break
            time.sleep(0.1)
        t0 = time.monotonic(); second = self.raw(b"")
        self.assertIn(b" 503 ", second.split(b"\r\n")[0]); self.assertLess(time.monotonic() - t0, 2)
        th.join(30); self.assertEqual(res["first"][0], 200)
        self.assertEqual(len(self.ran()), 1)
        self.assertEqual(self.post(self.body())[0], 200)

    def test_memory_floor_refuses_before_any_fetch(self):
        self.start()
        self.prod.mem_available_mib = lambda: 1023
        self.assertEqual(self.post(self.body())[0], 503)
        self.prod.mem_available_mib = lambda: (_ for _ in ()).throw(OSError("unreadable"))
        self.assertEqual(self.post(self.body())[0], 503)                                  # unreadable = below the floor
        self.assertEqual(self.ran(), [])

    def test_a_replaced_fetcher_is_refused(self):
        self.start()
        os.rename(self.fake, self.fake + ".old"); shutil.copy2(self.fake + ".old", self.fake)   # same bytes, another inode
        self.assertEqual(self.post(self.body())[0], 500); self.assertEqual(self.ran(), [])


class Config(Base):
    def cfg_file(self, c):
        p = f"{self.tmp}/c.json"
        with open(p, "w") as f:
            json.dump(c, f)
        os.chmod(p, 0o600); return p

    def test_pins_loopback_and_shape_refusals(self):
        P.load_config(self.cfg_file(self.cfg))
        for mut in (lambda c: c["endpoints"].update(l1Rpc="http://8.8.8.8:8545"), lambda c: c["endpoints"].update(l2Rpc="https://127.0.0.1:18547"),
                    lambda c: c["endpoints"].update(l2Node="http://127.0.0.1:17545/path"), lambda c: c["endpoints"].update(l1Beacon=EP["l1Rpc"]),
                    lambda c: c["endpoints"].update(l1Beacon="http://localhost:15052"), lambda c: c["listen"].update(host="0.0.0.0"),
                    lambda c: c["fetch"].update(sha256="0" * 64), lambda c: c["bridge"].update(sha256="0" * 64), lambda c: c.update(extra=1),
                    lambda c: c.update(maxBlocks=1801), lambda c: c.update(maxWitnessBytes=(256 << 20) + 1), lambda c: c.pop("minMemAvailableMiB")):
            c = json.loads(json.dumps(self.cfg)); mut(c)
            with self.assertRaises(P.Invalid):
                P.load_config(self.cfg_file(c))
        os.symlink(self.cfg_file(self.cfg), f"{self.tmp}/link.json")
        with self.assertRaises(OSError):
            P.load_config(f"{self.tmp}/link.json")                                         # O_NOFOLLOW
        P.FETCH_ELF_SHA256 = ORIG_FETCH_SHA
        with self.assertRaises(P.Invalid):
            P.Producer(P.load_config(self.cfg_file({**self.cfg, "fetch": {"path": self.fake, "sha256": ORIG_FETCH_SHA}})))   # fake != the pinned ELF
        P.FETCH_ELF_SHA256 = sha(self.fake)
        bad = f"{self.tmp}/bridge.py"; shutil.copy(BRIDGE, bad)
        with open(bad, "a") as f:
            f.write("\n# changed\n")
        with self.assertRaises(P.Invalid):
            P.load_bridge(bad)
        os.chmod(self.work, 0o755)
        with self.assertRaises(P.Invalid):
            P.Producer(P.load_config(self.cfg_file(self.cfg)))


class Provenance(unittest.TestCase):
    def test_the_real_pinned_fetcher_refuses_bad_arguments_before_any_connection(self):
        self.assertEqual(sha(REAL_FETCH), ORIG_FETCH_SHA)                                  # the existing root build, unchanged
        tmp = tempfile.mkdtemp(dir=os.environ.get("TEST_TMP")); self.addCleanup(shutil.rmtree, tmp, True)
        out = f"{tmp}/w.json"; ok = [EP["l1Rpc"], EP["l1Beacon"], EP["l2Rpc"], EP["l2Node"]]
        for argv, needle in (([], "usage"), (["http://8.8.8.8:8545"] + ok[1:] + ["1000", "1030", "0x" + "11" * 32, "30", out], "only http://127.0.0.1"),
                             (ok + ["1030", "1000", "0x" + "11" * 32, "30", out], "must be above"),
                             (ok + ["1000", "1030", "0x" + "11" * 32, "7", out], "multiple of the intermediate interval"),
                             (ok + ["1000", "1030", "0x" + "11" * 32, "30", tmp], "never overwritten")):
            r = subprocess.run([REAL_FETCH, *argv], capture_output=True, text=True, timeout=120, env={"PATH": "/usr/bin:/bin"})
            self.assertNotEqual(r.returncode, 0, argv); self.assertIn(needle, r.stderr + r.stdout, argv)
        self.assertFalse(os.path.exists(out))

    def test_pins_equal_the_existing_receipts(self):
        rec = open(f"{COMBINED}/logs/run-20261026T095816Z-1438579/binaries.sha256").read()
        self.assertIn(f"{ORIG_FETCH_SHA}  <combined-r1 build copy>/target/debug/examples/witness_fetch", rec)
        self.assertEqual(json.load(open(f"{W}/logs/root-combined-elf-1035.json"))["witness_fetch"]["sha256"], ORIG_FETCH_SHA)
        for p in (f"{COMBINED}/src/zk-witness/examples/witness_fetch.rs", f"{W}/derivation-witness-stage/overlay/zk-witness/examples/witness_fetch.rs"):
            self.assertEqual(sha(p), P.FETCH_SOURCE_SHA256)
        self.assertEqual(sha(BRIDGE), P.BRIDGE_SHA256)
        self.assertIn(f"{P.BRIDGE_SHA256}  ./bridge/witness_rpc_bridge.py", open(os.path.dirname(os.path.dirname(BRIDGE)) + "/SHA256SUMS").read())

    def test_unit_template_is_opt_in_unprivileged_loopback_only(self):
        u = open(f"{STAGE}/systemd/enclave-witness-producer.service.template").read()
        for must in ("User=rpcwitness", "IPAddressDeny=any", "IPAddressAllow=localhost", "MemorySwapMax=0", "NoNewPrivileges=yes",
                     "ProtectSystem=strict", "PrivateTmp=yes", "MemoryMax=@MEMORY_MAX@",
                     "ExecStart=/usr/bin/python3 -I -B /opt/enclave-rpc/witness/witness_producer.py serve --config /etc/enclave-rpc/witness-producer.json"):
            self.assertIn(must, u)
        self.assertNotIn("WantedBy", u)                                                   # opt-in: never pulled in by a target
        with self.assertRaises(P.Invalid):                                                # the template's REQUIRED values refuse as shipped
            c = json.load(open(f"{STAGE}/config/witness-producer.template.json"))
            tmp = tempfile.mkdtemp(dir=os.environ.get("TEST_TMP")); self.addCleanup(shutil.rmtree, tmp, True)
            with open(f"{tmp}/c.json", "w") as f:
                json.dump(c, f)
            os.chmod(f"{tmp}/c.json", 0o600); P.load_config(f"{tmp}/c.json")


if __name__ == "__main__":
    unittest.main()
