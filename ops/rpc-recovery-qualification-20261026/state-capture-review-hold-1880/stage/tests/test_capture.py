#!/usr/bin/env python3
"""state-fixture-capture-stage/r1 tests/test_capture.py (PREPARED by Claude 1877; NOT run by Claude). 12 PURE unit tests of capture.py.
They never call capture.run() (the only spawning entry), never spawn, mount, build or write a receipt; they read only the frozen
r11 / acceptance r1 source + the pinned acceptance test receipt (pin cross-checks). Every capture/receipt below is SYNTHETIC: a parser
test input, never a fixture receipt and never qualification of the compiled fixtures."""
import ast, copy, hashlib, importlib.util, unittest
from pathlib import Path

STAGE = Path(__file__).resolve().parent.parent
SPEC = importlib.util.spec_from_file_location("capture", STAGE / "capture.py")
C = importlib.util.module_from_spec(SPEC); SPEC.loader.exec_module(C)
A = C.load_pinned("acceptance", "acceptance_r1_test")                 # pure module, loaded from its pinned bytes
BD = C.BUILD_BASE + "/run-20261101T000000Z-123/out"
HB, HM, HR = "1" * 64, "2" * 64, "3" * 64
BUILD = {"mode": "build", "verified": True, "finalRc": 0, "stageSums": C.PINS["r11Sums"][1],
         "guard": {"outDir": BD, "binaries": {"base-state-readonly": {"sha256": HB}, "mk_fixture": {"sha256": HM}}}}
POS = ("".join(f"case {l}: PASS\n" for l in A.POSITIVE_LABELS) + "## runs=26 failed=0\n## outputs /x/runs/positive-a\n"
       "## bsro-r11-positive rc=0\n").encode()
CAP = {"rc": 0, "kept": len(POS), "total": len(POS), "abandoned": False, "sinkError": None, "pid": 4242}
CLEAN = {"tmpLeft": [], "mountsLeft": [], "groupAlive": False}


def exp(kind="positive"):
    return C.expected_identities(kind, BUILD, HR, A)


def receipt(kind="positive"):
    e = exp(kind)
    return {"format": C.RECEIPT_FORMAT, "kind": kind, "pass": True, "synthetic": False, "authenticatedBy": "capture", "reasons": [],
            "pins": {n: v[1] for n, v in C.PINS.items()}, "wrapperSums": "4" * 64, "buildOutDir": BD,
            "buildReceipt": {"path": "/x/receipt.json", "sha256": HR}, "identitiesBefore": dict(e), "identitiesAfter": dict(e),
            "completionFingerprint": "5" * 64, "spawn": {"argv": ["/usr/bin/timeout"], "pid": 4242},
            "capture": {"path": BD + "/fixture-captures/x/capture.txt", "sha256": "6" * 64, "rc": 0, "keptBytes": 1, "totalBytes": 1,
                        "truncated": False, "abandoned": False, "sinkError": None, "timedOut": False},
            "check": {"outputValid": True}, "cleanup": dict(CLEAN), "verifyBinariesAfter": True, "startedUtc": "x", "seconds": 1}


class Pure(unittest.TestCase):
    def test_01_pins_match_the_frozen_sources(self):
        for name, (path, want) in C.PINS.items():
            self.assertEqual(hashlib.sha256(Path(path).read_bytes()).hexdigest(), want, name)
        listed = C.parse_sums(Path(C.PINS["r11Sums"][0]).read_text())
        self.assertEqual(listed["jobs/positive.sh"], A.R11_POSITIVE_SH_SHA256)
        self.assertEqual(listed["jobs/fixtures.sh"], A.R11_FIXTURES_SH_SHA256)
        self.assertEqual(listed["jobs/bsro_gate.py"], C.PINS["r11Gate"][1])
        self.assertEqual(C.parse_sums(Path(C.PINS["accSums"][0]).read_text())["acceptance.py"], C.PINS["acceptance"][1])
        self.assertEqual(A.R11_STAGE_SUMS_SHA256, C.PINS["r11Sums"][1])
        self.assertIn(f'BASE = "{C.BUILD_BASE}"', Path(C.PINS["r11Gate"][0]).read_text())
        for f in ("def run_capture(", "def verify_binaries(", "def qualified(", "def live_completion(", "def no_live_sessions(",
                  "def root_floor_ok(", "def maps_inside(", "def propagation_private(", "def group_alive(", "def write_new(", "def file_sha("):
            self.assertIn(f, Path(C.PINS["r11Gate"][0]).read_text(), f)

    def test_02_parse_sums_is_strict(self):
        self.assertEqual(C.parse_sums("a" * 64 + "  x/y.py\n"), {"x/y.py": "a" * 64})
        for t in ("a" * 64 + "  x\n" + "b" * 64 + "  x\n", "a" * 64 + " x\n", "a" * 64 + "  /abs\n", "a" * 64 + "  a/../b\n",
                  "A" * 64 + "  x\n", "a" * 64 + "  x", "", "\n", b"x"):
            with self.assertRaises(C.Refused, msg=repr(t)[:40]):
                C.parse_sums(t)

    def test_03_lane_512_and_host_floor(self):
        self.assertTrue(C.lane512_ok(str(512 << 20) + "\n", 16384 + 768))
        for mm, av in ((str(4096 << 20), 99999), ("max", 99999), (str(512 << 20), 16384 + 767), (str(512 << 20), True), (None, 99999)):
            with self.assertRaises(C.Refused, msg=(mm, av)):
                C.lane512_ok(mm, av)

    def test_04_no_ipv4_routes(self):
        hdr = "Iface\tDestination\tGateway\n"
        self.assertTrue(C.no_ipv4_routes(hdr))
        with self.assertRaises(C.Refused):
            C.no_ipv4_routes(hdr + "eth0\t00000000\t0100A8C0\n")

    def test_05_leftover_detection(self):
        self.assertEqual(C.tmp_leftovers(["a", "bsro-r11-pos-1", "bsro-r11-fix-2"], "bsro-r11-pos-"), ["bsro-r11-pos-1"])
        mi = ("36 35 0:31 / / rw - ext4 /dev/x rw\n"
              "90 36 0:44 / /tmp/bsro-r11-pos-20261101T000000Z-7/v1-pass ro,relatime - tmpfs tmpfs rw\n")
        self.assertEqual(C.mount_leftovers(mi, "bsro-r11-pos-"), ["/tmp/bsro-r11-pos-20261101T000000Z-7/v1-pass"])
        self.assertEqual(C.mount_leftovers(mi, "bsro-r11-fix-"), [])

    def test_06_build_out_dir_shape(self):
        self.assertEqual(C.out_dir_ok(BD), BD)
        for bd in (BD + "/", "/tmp/out", C.BUILD_BASE + "/run-x/out", C.BUILD_BASE + "/run-20261101T000000Z-1/out/../out",
                   "/home/steven/out", None):
            with self.assertRaises(C.Refused, msg=bd):
                C.out_dir_ok(bd)

    def test_07_exactly_the_verified_build_receipt(self):
        s = C.PINS["r11Sums"][1]
        self.assertEqual(len(C.matching_build_receipts([("build-1", HR, BUILD)], s, BD)), 1)
        for mut in (dict(verified=1), dict(verified=False), dict(finalRc=10), dict(finalRc=False), dict(stageSums="0" * 64),
                    dict(mode="preflight"), dict(guard={"outDir": BD + "x"})):
            r = dict(copy.deepcopy(BUILD), **mut)
            self.assertEqual(C.matching_build_receipts([("build-1", HR, r)], s, BD), [], mut)
        self.assertEqual(len(C.matching_build_receipts([("build-1", HR, BUILD), ("build-2", HR, BUILD)], s, BD)), 2)  # run() needs ==1
        self.assertEqual(exp(), {"stageSums": s, "scriptSha256": A.R11_POSITIVE_SH_SHA256, "helperSha256": HB, "mkFixtureSha256": HM,
                                 "buildReceiptSha256": HR})
        self.assertEqual(exp("fixtures")["scriptSha256"], A.R11_FIXTURES_SH_SHA256)

    def test_08_decide_requires_everything(self):
        e = exp()
        chk = {"outputValid": True}
        self.assertEqual(C.decide(CAP, False, chk, e, e, e, CLEAN, True), (True, []))
        other = dict(e, helperSha256="9" * 64)
        cases = [(dict(CAP, rc=None), False, chk, e, e, CLEAN, True), (dict(CAP, abandoned=True), False, chk, e, e, CLEAN, True),
                 (dict(CAP, sinkError="write: EIO"), False, chk, e, e, CLEAN, True), (dict(CAP, total=CAP["kept"] + 1), False, chk, e, e, CLEAN, True),
                 (CAP, True, chk, e, e, CLEAN, True), (CAP, None, chk, e, e, CLEAN, True), (CAP, False, chk, e, other, CLEAN, True),
                 (CAP, False, chk, other, other, CLEAN, True), (CAP, False, chk, e, e, dict(CLEAN, tmpLeft=["bsro-r11-pos-1"]), True),
                 (CAP, False, chk, e, e, dict(CLEAN, mountsLeft=["/tmp/bsro-r11-pos-1/x"]), True),
                 (CAP, False, chk, e, e, dict(CLEAN, groupAlive=True), True), (CAP, False, chk, e, e, None, True),
                 (CAP, False, chk, e, e, CLEAN, False), (CAP, False, {"outputValid": False, "reasons": ["x"]}, e, e, CLEAN, True),
                 (CAP, False, None, e, e, CLEAN, True), (None, False, chk, e, e, CLEAN, True)]
        for i, (cap, to, ck, b, a, cl, va) in enumerate(cases):
            self.assertFalse(C.decide(cap, to, ck, b, a, e, cl, va)[0], i)

    def test_09_decide_with_the_pinned_acceptance_check_on_synthetic_output(self):
        e = exp()
        ok = A.check_fixture_capture("positive", POS, 0, False, False, e, e)
        self.assertTrue(C.decide(CAP, False, ok, e, e, e, CLEAN, True)[0])
        self.assertIs(ok["authenticated"], False)                       # a synthetic capture authenticates nothing
        bad = A.check_fixture_capture("positive", POS.replace(b"failed=0", b"failed=1"), 0, False, False, e, e)
        self.assertFalse(C.decide(CAP, False, bad, e, e, e, CLEAN, True)[0])
        to = A.check_fixture_capture("positive", POS, 124, True, False, e, e)
        self.assertFalse(C.decide(dict(CAP, rc=124), True, to, e, e, e, CLEAN, True)[0])

    def test_10_receipt_errors_for_consumers(self):
        e = exp()
        self.assertEqual(C.receipt_errors(receipt(), "positive", e), [])
        muts = [("synthetic", True), ("pass", False), ("authenticatedBy", "summary"), ("reasons", ["x"]), ("kind", "fixtures"),
                ("format", "x"), ("verifyBinariesAfter", 1), ("identitiesAfter", dict(e, helperSha256="9" * 64)),
                ("pins", {}), ("check", {"outputValid": 1}), ("cleanup", dict(CLEAN, groupAlive=0)), ("spawn", {"argv": []})]
        for k, v in muts:
            r = receipt(); r[k] = v
            self.assertTrue(C.receipt_errors(r, "positive", e), k)
        for k, v in (("truncated", True), ("timedOut", True), ("rc", 1), ("rc", False), ("abandoned", None), ("sinkError", "x")):
            r = receipt(); r["capture"][k] = v
            self.assertTrue(C.receipt_errors(r, "positive", e), k)
        r = receipt(); del r["seconds"]
        self.assertTrue(C.receipt_errors(r, "positive", e))
        r = receipt(); r["extra"] = 1
        self.assertTrue(C.receipt_errors(r, "positive", e))

    def test_11_spawning_and_writing_confined_to_run(self):
        tree = ast.parse((STAGE / "capture.py").read_text())
        users = {}
        for fn in [n for n in tree.body if isinstance(n, ast.FunctionDef)]:
            for n in ast.walk(fn):
                if isinstance(n, ast.Attribute) and n.attr in ("run_capture", "write_new", "mkdir"):
                    users.setdefault(n.attr, set()).add(fn.name)
                if isinstance(n, ast.Name) and n.id in ("exec", "run"):
                    users.setdefault(n.id, set()).add(fn.name)
        self.assertEqual(users, {"run_capture": {"run"}, "write_new": {"run"}, "mkdir": {"run"}, "exec": {"load_pinned"}, "run": {"main"}})
        imports = {a.name for n in ast.walk(tree) if isinstance(n, ast.Import) for a in n.names}
        self.assertNotIn("subprocess", imports); self.assertNotIn("shutil", imports)

    def test_12_run_sh_invocation(self):
        t = (STAGE / "jobs" / "run.sh").read_text()
        for s in ('sha256sum -c --quiet SHA256SUMS', 'unshare -Urnm env -i PATH=/usr/bin:/bin LC_ALL=C python3 -I -B "$S/capture.py" run',
                  '--uid "$U" --gid "$G"', "/vm/enclave-volumes/rpc-recovery-validation-build/run-*/out", "positive|fixtures) ;;"):
            self.assertIn(s, t, s)
        self.assertNotIn("--fixture", t)


if __name__ == "__main__":
    unittest.main()
