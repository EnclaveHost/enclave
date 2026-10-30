#!/usr/bin/env python3
"""Offline tests: python3 -m unittest -v test_l1_authority (via jobs/test.sh under the shared queue)."""
import hashlib, http.server, json, os, shutil, subprocess, sys, tempfile, threading, time, unittest
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import l1_authority as L

HERE = os.path.dirname(os.path.abspath(__file__))
NOW = 1_792_900_000                                   # fixed clock for the age checks
SLOT_NOW = (NOW - L.MAINNET_GENESIS_TIME) // 12 // 32 * 32


class Env:
    def __init__(self):
        self.root = tempfile.mkdtemp(prefix="l1a-")
        for d in ("data", "home"):
            os.mkdir(os.path.join(self.root, d), 0o700)
        self.bin = os.path.join(self.root, "helios")
        with open(self.bin, "wb") as f:
            f.write(b"#!/bin/false\nnot the real helios\n")
        self.sha = hashlib.sha256(open(self.bin, "rb").read()).hexdigest()
        self.cp = {"format": L.CHECKPOINT_FORMAT, "network": "mainnet", "root": "0x" + "ab" * 32, "slot": SLOT_NOW - 32 * 225,
                   "sources": [{"kind": "own-lighthouse", "ref": "127.0.0.1:5052 finalized", "observedAt": "2026-10-25T00:00:00Z"},
                               {"kind": "checkpoint-sync-provider", "ref": "provider-A (root-reviewed)", "observedAt": "2026-10-25T00:01:00Z"}],
                   "recordedAt": "2026-10-25T00:02:00Z"}
        self.cfg = {"format": L.FORMAT, "network": "mainnet", "binary": {"path": self.bin, "sha256": self.sha},
                    "consensusRpc": "http://127.0.0.1:5052", "executionRpc": "http://127.0.0.1:8545",
                    "listen": {"ip": "127.0.0.1", "port": 8550}, "dataDir": os.path.join(self.root, "data"),
                    "homeDir": os.path.join(self.root, "home"), "checkpointFile": os.path.join(self.root, "checkpoint.json"),
                    "maxCheckpointAgeSec": 604800, "maxFinalizedAgeSec": 1800, "logFilter": "info"}

    def write(self):
        json.dump(self.cp, open(self.cfg["checkpointFile"], "w"))
        p = os.path.join(self.root, "config.json")
        json.dump(self.cfg, open(p, "w"))
        return p

    def load(self):
        return L.load_config(self.write(), now=NOW)


class ConfigTests(unittest.TestCase):
    def setUp(self):
        self.e = Env()

    def tearDown(self):
        shutil.rmtree(self.e.root)

    def refused(self, code):
        with self.assertRaises(L.Refused) as cm:
            self.e.load()
        self.assertEqual(cm.exception.code, code, str(cm.exception))

    def test_good_config_exact_argv_and_replaced_env(self):
        os.environ["CONSENSUS_RPC"] = "https://ethereum.operationsolarstorm.org"   # must not survive into the child env
        os.environ["LOAD_EXTERNAL_FALLBACK"] = "true"
        try:
            argv, env = L.build_exec(self.e.load())
        finally:
            del os.environ["CONSENSUS_RPC"], os.environ["LOAD_EXTERNAL_FALLBACK"]
        self.assertEqual(argv, ["helios", "ethereum", "--network", "mainnet", "--consensus-rpc", "http://127.0.0.1:5052",
                                "--execution-rpc", "http://127.0.0.1:8545", "--checkpoint", "0x" + "ab" * 32,
                                "--data-dir", self.e.cfg["dataDir"], "--rpc-bind-ip", "127.0.0.1", "--rpc-port", "8550",
                                "--strict-checkpoint-age"])
        self.assertEqual(env, {"HOME": self.e.cfg["homeDir"], "RUST_LOG": "info"})
        for banned in ("--fallback", "--load-external-fallback", "--verifiable-api", "-l", "-f", "-v", "--tui"):
            self.assertNotIn(banned, argv)

    def test_non_loopback_or_public_endpoints(self):
        for key, v, code in [("consensusRpc", "https://ethereum.operationsolarstorm.org", "bad-url"),
                             ("consensusRpc", "http://10.0.0.5:5052", "not-loopback"),
                             ("consensusRpc", "http://localhost:5052", "not-loopback"),
                             ("executionRpc", "http://0.0.0.0:8545", "not-loopback"),
                             ("executionRpc", "http://192.168.1.2:8545", "not-loopback"),
                             ("executionRpc", "http://127.0.0.1", "bad-url"),
                             ("executionRpc", "http://u:p@127.0.0.1:8545", "bad-url"),
                             ("consensusRpc", "http://127.0.0.1:5052/eth", "bad-url")]:
            with self.subTest(v=v):
                self.e.cfg[key] = v
                self.refused(code)
                self.e.cfg["consensusRpc"], self.e.cfg["executionRpc"] = "http://127.0.0.1:5052", "http://127.0.0.1:8545"

    def test_listener_must_be_loopback_and_distinct(self):
        self.e.cfg["listen"] = {"ip": "0.0.0.0", "port": 8550}; self.refused("not-loopback")
        self.e.cfg["listen"] = {"ip": "127.0.0.1", "port": 8545}; self.refused("bad-config")
        self.e.cfg["listen"] = {"ip": "127.0.0.1", "port": 80}; self.refused("bad-config")

    def test_unknown_fields_and_fallback_knobs(self):
        for extra in ({"fallback": "https://sync-mainnet.beaconcha.in"}, {"loadExternalFallback": True}, {"verifiableApi": "http://127.0.0.1:1"}):
            with self.subTest(extra=extra):
                cfg = dict(self.e.cfg, **extra); saved = self.e.cfg; self.e.cfg = cfg
                self.refused("unknown-field"); self.e.cfg = saved

    def test_checkpoint_age_and_provenance(self):
        self.e.cp["slot"] = SLOT_NOW - 32 * 225 * 8; self.refused("checkpoint-too-old")       # ~8 days > 7-day config
        self.e.cp["slot"] = SLOT_NOW + 32 * 10; self.refused("checkpoint-future")
        self.e.cp["slot"] = SLOT_NOW - 32 * 225 + 1; self.refused("bad-checkpoint")            # not an epoch boundary
        self.e.cp["slot"] = SLOT_NOW - 32 * 225
        self.e.cp["sources"] = self.e.cp["sources"][:1]; self.refused("weak-provenance")
        self.e.cp["sources"] = [self.e.cp["sources"][0], dict(self.e.cp["sources"][0])]; self.refused("weak-provenance")
        self.e.cp["sources"] = [dict(self.e.cp["sources"][0]), dict(self.e.cp["sources"][0], ref="other own")]; self.refused("weak-provenance")
        self.e.cp["sources"] = [dict(self.e.cp["sources"][0]), {"kind": "a-friend", "ref": "x", "observedAt": "t"}]; self.refused("weak-provenance")

    def test_checkpoint_root_and_cap(self):
        self.e.cp["root"] = "0x" + "AB" * 32; self.refused("bad-checkpoint")
        self.e.cp["root"] = "0x" + "00" * 32; self.refused("bad-checkpoint")
        self.e.cp["root"] = "0x" + "ab" * 32
        self.e.cfg["maxCheckpointAgeSec"] = L.HELIOS_MAX_CHECKPOINT_AGE + 1; self.refused("bad-config")
        self.e.cfg["maxCheckpointAgeSec"] = 604800; self.e.cp["network"] = "sepolia"; self.refused("bad-checkpoint")

    def test_home_toml_and_directory_modes(self):
        os.mkdir(os.path.join(self.e.cfg["homeDir"], ".helios")); self.refused("home-config-present")
        os.rmdir(os.path.join(self.e.cfg["homeDir"], ".helios"))
        os.chmod(self.e.cfg["dataDir"], 0o755); self.refused("bad-path")
        os.chmod(self.e.cfg["dataDir"], 0o700); self.e.cfg["homeDir"] = self.e.cfg["dataDir"]; self.refused("bad-config")
        self.e.cfg["homeDir"] = os.path.join(self.e.root, "home") + "/../home"; self.refused("bad-path")

    def test_binary_pin(self):
        c = self.e.load()
        os.close(L.open_pinned(c["cfg"]["binary"]))
        with open(self.e.bin, "ab") as f:
            f.write(b"x")
        with self.assertRaises(L.Refused) as cm:
            L.open_pinned(c["cfg"]["binary"])
        self.assertEqual(cm.exception.code, "binary-pin")

    def test_cli_check_and_refusal_exit_codes(self):
        p = self.e.write()
        r = subprocess.run([sys.executable, os.path.join(HERE, "l1_authority.py"), "check", p], capture_output=True, text=True, timeout=30)
        # the real clock makes the fixed-NOW checkpoint stale or fresh; only a JSON verdict with a known exit code is accepted
        out = json.loads(r.stdout)
        self.assertIn(r.returncode, (0, 3))
        if r.returncode == 3:
            self.assertIn(out["code"], ("checkpoint-too-old", "checkpoint-future"))
        r = subprocess.run([sys.executable, os.path.join(HERE, "l1_authority.py"), "bogus", p], capture_output=True, text=True, timeout=30)
        self.assertEqual(r.returncode, 2)


class FakeRpc(http.server.BaseHTTPRequestHandler):
    answers = {}
    def log_message(self, *a): pass
    def do_POST(self):
        req = json.loads(self.rfile.read(int(self.headers["content-length"])))
        key = req["method"] + (":" + req["params"][0] if req["params"] else "")
        a = self.answers.get(key, {"error": {"code": -32000, "message": "no"}})
        body = a(req) if callable(a) else dict({"jsonrpc": "2.0", "id": req["id"]}, **a)
        b = json.dumps(body).encode()
        self.send_response(200); self.send_header("content-length", str(len(b))); self.end_headers(); self.wfile.write(b)


class StatusTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.srv = http.server.HTTPServer(("127.0.0.1", 0), FakeRpc)
        threading.Thread(target=cls.srv.serve_forever, daemon=True).start()

    @classmethod
    def tearDownClass(cls):
        cls.srv.shutdown()

    def setUp(self):
        self.e = Env()
        self.e.cfg["listen"] = {"ip": "127.0.0.1", "port": self.srv.server_address[1]}
        self.c = self.e.load()
        blk = lambda n, t: {"number": hex(n), "hash": "0x" + f"{n:064x}", "timestamp": hex(t)}
        FakeRpc.answers = {"eth_chainId": {"result": "0x1"}, "eth_getBlockByNumber:finalized": {"result": blk(100, NOW - 800)},
                           "eth_getBlockByNumber:latest": {"result": blk(164, NOW - 6)}}
        self.blk = blk

    def tearDown(self):
        shutil.rmtree(self.e.root)

    def code(self, c):
        with self.assertRaises(L.Refused) as cm:
            L.status(self.c, now=NOW)
        self.assertEqual(cm.exception.code, c, str(cm.exception))

    def test_fresh(self):
        s = L.status(self.c, now=NOW)
        self.assertEqual(s["verdict"], "fresh-finalized")
        self.assertEqual(s["finalized"]["ageSec"], 800)
        self.assertIn("NOT finalized", s["latestBasis"])

    def test_stale_finality(self):
        FakeRpc.answers["eth_getBlockByNumber:finalized"] = {"result": self.blk(100, NOW - 1801)}; self.code("stale-finality")

    def test_no_finalized_yet(self):
        FakeRpc.answers["eth_getBlockByNumber:finalized"] = {"error": {"code": -32001, "message": "out of sync"}}; self.code("not-ready")
        FakeRpc.answers["eth_getBlockByNumber:finalized"] = {"result": None}; self.code("not-ready")

    def test_wrong_chain_and_incoherence(self):
        FakeRpc.answers["eth_chainId"] = {"result": "0x2105"}; self.code("wrong-chain")
        FakeRpc.answers["eth_chainId"] = {"result": "0x1"}
        FakeRpc.answers["eth_getBlockByNumber:finalized"] = {"result": self.blk(200, NOW - 10)}; self.code("incoherent")

    def test_envelope(self):
        FakeRpc.answers["eth_chainId"] = lambda req: {"jsonrpc": "2.0", "id": req["id"] + 1, "result": "0x1"}; self.code("bad-answer")
        FakeRpc.answers["eth_chainId"] = lambda req: {"jsonrpc": "1.0", "id": req["id"], "result": "0x1"}; self.code("bad-answer")
        FakeRpc.answers["eth_chainId"] = lambda req: {"jsonrpc": "2.0", "id": req["id"], "result": "0x1", "error": {}}; self.code("bad-answer")
        FakeRpc.answers["eth_chainId"] = {"result": "0x01"}; self.code("bad-answer")
        FakeRpc.answers["eth_chainId"] = {"result": "0x1"}
        FakeRpc.answers["eth_getBlockByNumber:finalized"] = {"result": dict(self.blk(100, NOW - 10), hash="0x12")}; self.code("bad-answer")


if __name__ == "__main__":
    unittest.main()
