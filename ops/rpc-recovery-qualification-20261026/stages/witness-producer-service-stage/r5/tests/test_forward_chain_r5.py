#!/usr/bin/env python3
"""witness-producer-service-stage/r4 forward-chain harness (PREPARED; NOT run by Claude). r2's harness, corrected after root's real run
1603, on the FROZEN r3 producer (by path, sha-checked; never copied) and the FROZEN placement r2 units/proposal (by path).
Needs jobs/tests.sh's own network namespace (unshare -Urn) with 10.0.2.2/32 and 10.0.2.15/32 on lo. The REAL systemd-socket-proxyd,
socket-activated on 10.0.2.15 like the proposed unit, is reached from source 10.0.2.2 like a host-forwarded connection.
1603 findings, corrected here (not by weakening): (1) the 503 was real single-flight admission - setUp's readiness probe through the
proxy opened an upstream producer connection that still held the one slot when the first request arrived; the fixture now waits
until the producer has released it, and a regression asserts exactly that behaviour; (2) the [Install] check matched a comment; the
unit SECTIONS are parsed now."""
import hashlib, json, os, shutil, socket, subprocess, sys, tempfile, threading, time, unittest

HERE = os.path.dirname(os.path.abspath(__file__))
STAGE = os.path.dirname(HERE)
W = os.path.normpath(os.path.join(STAGE, "..", ".."))
R1 = f"{W}/witness-producer-service-stage/r1"
R2 = f"{W}/witness-producer-service-stage/r2"
R3 = f"{W}/witness-producer-service-stage/r3"
R3_PRODUCER_SHA256 = "133eed31a4be91f944447ed9f91e9fb667c91ef2ef18fcc01b2f8811e5c1df0e"
R1_UNIT_SHA256 = "fb5862d4ca3e541addb0501d42040e58ee6f027f38642aac71799b3f28c58bac"
SOCKET_SHA256 = "1f77cfd4c53b0912c8568d5bb9b1dbd0ceb3b85a1bc2aa9dd1104a0c3e566ea1"
SERVICE_SHA256 = "16e19fe2df46c6153c12ba611d83d58eb2f12aeee29ba1e71b06d7846b73ee3f"
PROPOSAL_SHA256 = "a2e4dd2f68b072bf8705a4ea8d8cfbcd81f4cdd4de50aefa6948ff7d486bc8a2"
sys.path.insert(0, f"{STAGE}/producer")              # r5: the r5 producer (r3 + observable completion + joined shutdown)
sys.dont_write_bytecode = True
import witness_producer as P  # noqa: E402  (the frozen r3 module)

BRIDGE = f"{W}/source/ops/rpc-witness-r14-20261026/witness-r2/bridge/witness_rpc_bridge.py"
FAKE = ("#!/usr/bin/python3 -I\nimport json, os, sys\nd = os.path.dirname(os.path.abspath(__file__))\n"
        "open(os.path.join(d, 'ran'), 'a').write('x\\n')\nout = sys.argv[-1]\n"
        "open(out + '.partial', 'wb').write(json.dumps(sys.argv[1:]).encode()); os.rename(out + '.partial', out)\n")
ORIG = P.FETCH_ELF_SHA256


def sha(p):
    with open(p, "rb") as f:
        return hashlib.sha256(f.read()).hexdigest()


def text(p):
    with open(p) as f:
        return f.read()


def sections(unit):
    """the real [Section] headers of a unit file (comments and blank lines ignored)"""
    out = []
    for line in unit.splitlines():
        s = line.strip()
        if s and not s.startswith(("#", ";")) and s.startswith("[") and s.endswith("]"):
            out.append(s[1:-1])
    return out


def code_lines(unit):
    return [l for l in unit.splitlines() if l.strip() and not l.lstrip().startswith(("#", ";"))]


def free_port(host="127.0.0.1"):
    s = socket.socket(); s.bind((host, 0)); p = s.getsockname()[1]; s.close(); return p


def body(track="final"):
    t = {"chainId": 8453, "l1Head": "0x" + "11" * 32, "l1HeadNumber": 1, "agreedL2OutputRoot": "0x" + "22" * 32,
         "claimedL2OutputRoot": "0x" + "33" * 32, "claimedL2BlockNumber": 1030, "rollupConfig": {}, "expectedRollupConfigHash": "0x" + "44" * 32,
         "expectedScheduleId": "x", "intermediateBlockInterval": 30}
    return json.dumps({"format": P.REQUEST_FORMAT, "track": track, "trusted": t, "agreedL2BlockNumber": 1000, "maximumWitnessBytes": 1 << 20}).encode()


def http_post(dst, data, src=None, timeout=20):
    s = socket.socket()
    if src:
        s.bind((src, 0))
    s.settimeout(timeout); s.connect(dst)
    s.sendall(b"POST /witness HTTP/1.1\r\nHost: x\r\nContent-Type: application/json\r\nContent-Length: %d\r\n\r\n" % len(data) + data)
    out = b""
    while True:
        b = s.recv(65536)
        if not b:
            break
        out += b
    s.close()
    head, _, payload = out.partition(b"\r\n\r\n")
    return head.split(b"\r\n")[0], head, payload


class Chain(unittest.TestCase):
    def setUp(self):
        for a in ("10.0.2.2", "10.0.2.15"):                                         # fails loudly outside the job's namespace
            s = socket.socket(); s.bind((a, 0)); s.close()
        self.assertTrue(os.path.isfile(f"{STAGE}/producer/witness_producer.py"))       # r5's producer; its bytes: the stage SHA256SUMS
        self.tmp = tempfile.mkdtemp(prefix="wfc4", dir=os.environ.get("TEST_TMP")); self.addCleanup(shutil.rmtree, self.tmp, True)
        fake = f"{self.tmp}/fetch/witness_fetch"; os.makedirs(os.path.dirname(fake))
        with open(fake, "w") as f:
            f.write(FAKE)
        os.chmod(fake, 0o755)
        P.FETCH_ELF_SHA256 = sha(fake); self.addCleanup(setattr, P, "FETCH_ELF_SHA256", ORIG)
        work = f"{self.tmp}/work"; os.mkdir(work, 0o700)
        self.pport = free_port()
        cfg = {"format": P.CONFIG_FORMAT, "listen": {"host": "127.0.0.1", "port": self.pport}, "fetch": {"path": fake, "sha256": P.FETCH_ELF_SHA256},
               "bridge": {"path": BRIDGE, "sha256": P.BRIDGE_SHA256},
               "endpoints": {"l1Rpc": "http://127.0.0.1:18647", "l1Beacon": "http://127.0.0.1:15052", "l2Rpc": "http://127.0.0.1:18547",
                             "l2Node": "http://127.0.0.1:17545"},
               "maxBlocks": 1800, "maxWitnessBytes": 1 << 20, "fetchTimeoutSec": 20, "fetchMemoryMiB": 1024, "minMemAvailableMiB": 0, "workDir": work}
        cp = f"{self.tmp}/c.json"
        with open(cp, "w") as f:
            json.dump(cfg, f)
        os.chmod(cp, 0o600)
        self.prod = P.Producer(P.load_config(cp), log=lambda d: None)
        self.prod.mem_available_mib = lambda: 1 << 20
        threading.Thread(target=self.prod.serve_forever, daemon=True).start()
        self.addCleanup(lambda: self.assertEqual(self.prod.shutdown(), [], "orphaned producer handler threads"))
        self.fport = free_port("10.0.2.15")
        self.proxy = subprocess.Popen(["/usr/bin/systemd-socket-activate", "-l", f"10.0.2.15:{self.fport}", "/usr/lib/systemd/systemd-socket-proxyd",
                                       "--connections-max=2", f"127.0.0.1:{self.pport}"], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        self.addCleanup(self.proxy.wait); self.addCleanup(self.proxy.kill)
        self.ran = f"{self.tmp}/fetch/ran"
        self.ready_handshake()

    def ready_handshake(self):
        """root 1610: readiness = ONE complete bounded exchange through the real proxy (malformed -> 400, read to EOF) AND the producer
        handler's observed completion. Only connection refusal (the listener not bound yet) is retried; any answer other than 400 fails."""
        end = time.monotonic() + 20
        while True:
            try:
                st, _, _ = http_post(("10.0.2.15", self.fport), b"{}", src="10.0.2.2", timeout=10); break
            except ConnectionRefusedError:
                if time.monotonic() > end:
                    self.fail("systemd-socket-activate did not listen on 10.0.2.15")
                time.sleep(0.05)
        self.assertIn(b" 400 ", st, "readiness handshake through the proxy")
        self.quiet()
        self.base = self.prod.stats["admitted"]

    def quiet(self):
        self.assertTrue(self.prod.wait_quiescent(30), "the producer handler did not complete")

    def test_host_link_peer_reaches_the_loopback_producer_through_the_real_proxy(self):
        st, head, data = http_post(("10.0.2.15", self.fport), body(), src="10.0.2.2")
        self.assertIn(b" 200 ", st); self.assertIn(b"application/octet-stream", head.lower())
        self.assertEqual(json.loads(data)[4:8], ["1000", "1030", "0x" + "11" * 32, "30"])     # the runner's argv mapping
        self.quiet()

    def test_the_producer_is_not_reachable_on_the_private_address_nor_the_forward_on_loopback(self):
        with self.assertRaises(OSError):
            socket.create_connection(("10.0.2.15", self.pport), timeout=2)                # the producer binds 127.0.0.1 only
        with self.assertRaises(OSError):
            socket.create_connection(("127.0.0.1", self.fport), timeout=2)                # the forward listens on 10.0.2.15 only
        self.assertFalse(os.path.exists(self.ran))

    def test_malformed_requests_through_the_forward_never_reach_the_fetcher(self):
        for d in (b"{}", b"not json", body("cold")):
            st, _, _ = http_post(("10.0.2.15", self.fport), d, src="10.0.2.2")
            self.assertIn(b" 400 ", st, d)
            self.quiet()                                                                 # sequential, like the single-flight driver
        self.assertFalse(os.path.exists(self.ran))

    def test_an_idle_forwarded_connection_holds_the_single_slot_then_releases_it(self):
        """1603's 503, asserted as the real behaviour: single flight through the proxy, refused unread, freed on close"""
        idle = socket.socket(); idle.bind(("10.0.2.2", 0)); idle.connect(("10.0.2.15", self.fport))
        self.addCleanup(idle.close)
        self.assertTrue(self.prod.wait_admitted(self.base + 1, 10), "the proxy did not connect the idle client upstream")
        busy = self.prod.stats["busy"]
        t0 = time.monotonic(); st, _, payload = http_post(("10.0.2.15", self.fport), body(), src="10.0.2.2")
        self.assertIn(b" 503 ", st); self.assertIn(b"busy", payload); self.assertLess(time.monotonic() - t0, 2)
        self.assertEqual(self.prod.stats["busy"], busy + 1)                               # refused by admission, before any byte was read
        self.assertFalse(os.path.exists(self.ran))
        idle.close(); self.quiet()                                                       # the idle handler COMPLETED: the slot is free
        st, _, _ = http_post(("10.0.2.15", self.fport), body(), src="10.0.2.2")
        self.assertIn(b" 200 ", st)
        self.quiet()


class Units(unittest.TestCase):
    def test_forward_units_bind_the_private_address_with_the_exact_peer_only(self):
        self.assertEqual((sha(f"{R2}/systemd/enclave-witness-forward.socket"), sha(f"{R2}/systemd/enclave-witness-forward.service")),
                         (SOCKET_SHA256, SERVICE_SHA256))
        so, sv = text(f"{R2}/systemd/enclave-witness-forward.socket"), text(f"{R2}/systemd/enclave-witness-forward.service")
        self.assertEqual(sections(so), ["Unit", "Socket"]); self.assertEqual(sections(sv), ["Unit", "Service"])   # no [Install]: opt-in
        for m in ("ListenStream=10.0.2.15:28747", "FreeBind=yes", "IPAddressDeny=any", "IPAddressAllow=10.0.2.2/32"):
            self.assertIn(m, code_lines(so))
        for m in ("ExecStart=/usr/lib/systemd/systemd-socket-proxyd --connections-max=2 127.0.0.1:18747", "IPAddressDeny=any",
                  "IPAddressAllow=10.0.2.2/32 127.0.0.1/32", "DynamicUser=yes", "NoNewPrivileges=yes", "MemorySwapMax=0"):
            self.assertIn(m, code_lines(sv))
        for t in (so, sv):
            self.assertFalse([l for l in code_lines(t) if "0.0.0.0" in l or "[::]" in l or l.startswith("ListenStream=127.")])

    def test_the_producer_unit_is_r1s_and_consistent_with_loopback_ingress(self):
        self.assertEqual(sha(f"{R1}/systemd/enclave-witness-producer.service.template"), R1_UNIT_SHA256)
        u = text(f"{R1}/systemd/enclave-witness-producer.service.template")
        self.assertIn("IPAddressAllow=localhost", code_lines(u)); self.assertNotIn("Install", sections(u))
        self.assertTrue(os.path.isfile(f"{STAGE}/producer/witness_producer.py"))       # r5's producer; its bytes: the stage SHA256SUMS

    def test_route_proposal_matches_the_live_manifest_and_binds_loopback_on_the_host(self):
        self.assertEqual(sha(f"{R2}/proposal/witness-route.json"), PROPOSAL_SHA256)
        p = json.loads(text(f"{R2}/proposal/witness-route.json"))
        m = json.loads(text("/home/steven/.local/state/enclave-rpc-production/manifest.json"))          # read only
        self.assertEqual(p["host"]["manifestForwardsExisting"], m["ports"]["forwards"])
        used = [f["port"] for f in m["ports"]["forwards"]] + [f["target"] for f in m["ports"]["forwards"]] + [m["ports"]["ssh"]]
        self.assertNotIn(p["rpcVm"]["forward"]["port"], used); self.assertNotIn(p["rpcVm"]["forward"]["target"], used)
        self.assertEqual(p["host"]["hostfwd"], "hostfwd=tcp:127.0.0.1:28747-10.0.2.15:28747")
        url = p["snpGuest"]["hostData"]["platformApi.derivedReader.witnessUrl"]
        self.assertEqual(url, p["snpGuest"]["signedDriverPolicy"]["witness.url"]); self.assertEqual(url, "http://10.0.2.2:28747/witness")


if __name__ == "__main__":
    unittest.main()
