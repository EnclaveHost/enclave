#!/usr/bin/env python3
"""witness-placement r2 offline harness (PREPARED; NOT run by Claude). Needs jobs/tests.sh's own network namespace (unshare -Urn)
with 10.0.2.2/32 and 10.0.2.15/32 on lo. The FROZEN r1 producer (by path, sha-checked; never copied) behind the REAL
systemd-socket-proxyd, socket-activated on 10.0.2.15 exactly like the proposed unit, reached from source 10.0.2.2 like a
host-forwarded connection. It proves the RPC-VM-side chain only: QEMU slirp in both VMs, the SNP guest's view of 10.0.2.2 and
systemd's IPAddressAllow enforcement are measured remaining. A fake fetcher stands in for witness_fetch (its sha pinned for the
test only)."""
import hashlib, json, os, shutil, socket, subprocess, sys, tempfile, threading, time, unittest

HERE = os.path.dirname(os.path.abspath(__file__))
STAGE = os.path.dirname(HERE)
W = os.path.normpath(os.path.join(STAGE, "..", ".."))
R1 = f"{W}/witness-producer-service-stage/r1"
R1_PRODUCER_SHA256 = "b61a981d4cd959670ed3fc374b75c5e2ab9a1f5b539d990b313680ae906b5233"
R1_UNIT_SHA256 = "fb5862d4ca3e541addb0501d42040e58ee6f027f38642aac71799b3f28c58bac"
sys.path.insert(0, f"{R1}/producer")
sys.dont_write_bytecode = True
import witness_producer as P  # noqa: E402  (the frozen r1 module)

BRIDGE = f"{W}/source/ops/rpc-witness-r14-20261026/witness-r2/bridge/witness_rpc_bridge.py"
FAKE = ("#!/usr/bin/python3 -I\nimport json, os, sys\nd = os.path.dirname(os.path.abspath(__file__))\n"
        "open(os.path.join(d, 'ran'), 'a').write('x\\n')\nout = sys.argv[-1]\n"
        "open(out + '.partial', 'wb').write(json.dumps(sys.argv[1:]).encode()); os.rename(out + '.partial', out)\n")
ORIG = P.FETCH_ELF_SHA256


def sha(p):
    with open(p, "rb") as f:
        return hashlib.sha256(f.read()).hexdigest()


def free_port(host="127.0.0.1"):
    s = socket.socket(); s.bind((host, 0)); p = s.getsockname()[1]; s.close(); return p


def body(track=b"final"):
    t = {"chainId": 8453, "l1Head": "0x" + "11" * 32, "l1HeadNumber": 1, "agreedL2OutputRoot": "0x" + "22" * 32,
         "claimedL2OutputRoot": "0x" + "33" * 32, "claimedL2BlockNumber": 1030, "rollupConfig": {}, "expectedRollupConfigHash": "0x" + "44" * 32,
         "expectedScheduleId": "x", "intermediateBlockInterval": 30}
    return json.dumps({"format": P.REQUEST_FORMAT, "track": track.decode(), "trusted": t, "agreedL2BlockNumber": 1000,
                       "maximumWitnessBytes": 1 << 20}).encode()


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
        self.assertEqual(sha(f"{R1}/producer/witness_producer.py"), R1_PRODUCER_SHA256)
        self.tmp = tempfile.mkdtemp(prefix="wfc", dir=os.environ.get("TEST_TMP")); self.addCleanup(shutil.rmtree, self.tmp, True)
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
        threading.Thread(target=self.prod.serve_forever, daemon=True).start(); self.addCleanup(self.prod.shutdown)
        self.fport = free_port("10.0.2.15")
        self.proxy = subprocess.Popen(["/usr/bin/systemd-socket-activate", "-l", f"10.0.2.15:{self.fport}", "/usr/lib/systemd/systemd-socket-proxyd",
                                       "--connections-max=2", f"127.0.0.1:{self.pport}"], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        self.addCleanup(self.proxy.wait); self.addCleanup(self.proxy.kill)
        for _ in range(100):
            try:
                socket.create_connection(("10.0.2.15", self.fport), timeout=0.2).close(); break
            except OSError:
                time.sleep(0.05)
        else:
            self.fail("systemd-socket-activate did not listen on 10.0.2.15")
        self.ran = f"{self.tmp}/fetch/ran"

    def test_host_link_peer_reaches_the_loopback_producer_through_the_real_proxy(self):
        st, head, data = http_post(("10.0.2.15", self.fport), body(), src="10.0.2.2")
        self.assertIn(b" 200 ", st); self.assertIn(b"application/octet-stream", head.lower())
        self.assertEqual(json.loads(data)[4:8], ["1000", "1030", "0x" + "11" * 32, "30"])     # the runner's argv mapping

    def test_the_producer_is_not_reachable_on_the_private_address_nor_the_forward_on_loopback(self):
        with self.assertRaises(OSError):
            socket.create_connection(("10.0.2.15", self.pport), timeout=2)                # the producer binds 127.0.0.1 only
        with self.assertRaises(OSError):
            socket.create_connection(("127.0.0.1", self.fport), timeout=2)                # the forward listens on 10.0.2.15 only
        self.assertFalse(os.path.exists(self.ran))

    def test_malformed_requests_through_the_forward_never_reach_the_fetcher(self):
        for d in (b"{}", b"not json", body(b"cold")):
            st, _, _ = http_post(("10.0.2.15", self.fport), d, src="10.0.2.2")
            self.assertIn(b" 400 ", st, d)
        self.assertFalse(os.path.exists(self.ran))


class Units(unittest.TestCase):
    def test_forward_units_bind_the_private_address_with_the_exact_peer_only(self):
        so = open(f"{STAGE}/systemd/enclave-witness-forward.socket").read()
        sv = open(f"{STAGE}/systemd/enclave-witness-forward.service").read()
        for m in ("ListenStream=10.0.2.15:28747", "FreeBind=yes", "IPAddressDeny=any", "IPAddressAllow=10.0.2.2/32"):
            self.assertIn(m, so)
        for m in ("ExecStart=/usr/lib/systemd/systemd-socket-proxyd --connections-max=2 127.0.0.1:18747", "IPAddressDeny=any",
                  "IPAddressAllow=10.0.2.2/32 127.0.0.1/32", "DynamicUser=yes", "NoNewPrivileges=yes", "MemorySwapMax=0"):
            self.assertIn(m, sv)
        for t in (so, sv):
            self.assertNotIn("0.0.0.0", t); self.assertNotIn("[::]", t); self.assertNotIn("[Install]", t)

    def test_the_r1_producer_and_unit_are_unchanged_and_consistent_with_loopback_ingress(self):
        self.assertEqual(sha(f"{R1}/producer/witness_producer.py"), R1_PRODUCER_SHA256)
        self.assertEqual(sha(f"{R1}/systemd/enclave-witness-producer.service.template"), R1_UNIT_SHA256)
        u = open(f"{R1}/systemd/enclave-witness-producer.service.template").read()
        self.assertIn("IPAddressAllow=localhost", u)              # ingress = the local proxy; egress = the loopback nodes/bridges

    def test_route_proposal_matches_the_live_manifest_and_binds_loopback_on_the_host(self):
        p = json.load(open(f"{STAGE}/proposal/witness-route.json"))
        m = json.load(open("/home/steven/.local/state/enclave-rpc-production/manifest.json"))          # read only
        self.assertEqual(p["host"]["manifestForwardsExisting"], m["ports"]["forwards"])
        used = [f["port"] for f in m["ports"]["forwards"]] + [f["target"] for f in m["ports"]["forwards"]] + [m["ports"]["ssh"]]
        self.assertNotIn(p["rpcVm"]["forward"]["port"], used); self.assertNotIn(p["rpcVm"]["forward"]["target"], used)
        self.assertEqual(p["host"]["hostfwd"], "hostfwd=tcp:127.0.0.1:28747-10.0.2.15:28747")
        url = p["snpGuest"]["hostData"]["platformApi.derivedReader.witnessUrl"]
        self.assertEqual(url, p["snpGuest"]["signedDriverPolicy"]["witness.url"]); self.assertEqual(url, "http://10.0.2.2:28747/witness")


if __name__ == "__main__":
    unittest.main()
