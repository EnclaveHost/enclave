#!/usr/bin/env python3
"""state-fixture-capture-stage/r2 tests/test_capture.py (PREPARED by Claude 1879; NOT run by Claude). 14 unit tests.
Pure checks of capture.py (never its spawning path: run()/precheck() are only called to prove they REFUSE FIRST while the parser
binding is pending), static + early-refusal checks of the frozen r12 fixture scripts (test 13 executes them ONLY with arguments that
are refused before any write: nonexistent /vm paths or forbidden shapes), and the job scripts. No mount, build, toolchain, network or
data. Every capture/receipt here is SYNTHETIC: never a fixture receipt, never qualification."""
import ast, copy, hashlib, importlib.util, os, re, subprocess, tempfile, unittest
from pathlib import Path

STAGE = Path(__file__).resolve().parent.parent
SPEC = importlib.util.spec_from_file_location("capture", STAGE / "capture.py")
C = importlib.util.module_from_spec(SPEC); SPEC.loader.exec_module(C)
R12 = Path(C.R12)
BD = C.BUILD_BASE + "/run-20261101T000000Z-123/out"
HB, HM, HR = "1" * 64, "2" * 64, "3" * 64
BUILD = {"mode": "build", "verified": True, "finalRc": 0, "stageSums": C.PINS["r12Sums"][1],
         "guard": {"outDir": BD, "binaries": {"base-state-readonly": {"sha256": HB}, "mk_fixture": {"sha256": HM}}}}
CAP = {"rc": 0, "kept": 10, "total": 10, "abandoned": False, "sinkError": None, "pid": 4242}
CLEAN = {"mountsLeft": [], "treesLeft": False, "evidenceKept": True, "groupAlive": False, "roStillOk": True, "stageRunsUnchanged": True}


def code_lines(path):
    return [l for l in Path(path).read_text().splitlines() if l.strip() and not l.lstrip().startswith("#")]


def receipt(kind="positive"):
    e = C.expected_identities(kind, BUILD, HR)
    return {"format": C.RECEIPT_FORMAT, "kind": kind, "pass": True, "synthetic": False, "authenticatedBy": "capture", "reasons": [],
            "pins": {n: v[1] for n, v in C.PINS.items()}, "acceptance": {"sums": "a" * 64}, "wrapperSums": "4" * 64, "buildOutDir": BD,
            "runDir": BD + "/fixture-captures/x", "workDir": BD + "/fixture-captures/x/work",
            "buildReceipt": {"path": "/x/receipt.json", "sha256": HR}, "identitiesBefore": dict(e), "identitiesAfter": dict(e),
            "completionFingerprint": "5" * 64, "spawn": {"argv": ["/usr/bin/timeout"], "pid": 4242},
            "capture": {"path": "/x/capture.txt", "sha256": "6" * 64, "rc": 0, "keptBytes": 1, "totalBytes": 1, "truncated": False,
                        "abandoned": False, "sinkError": None, "timedOut": False},
            "check": {"outputValid": True}, "cleanup": dict(CLEAN), "verifyBinariesAfter": True, "startedUtc": "x", "seconds": 1}


class Capture(unittest.TestCase):
    def test_01_pins_match_frozen_r12(self):
        for name, (path, want) in C.PINS.items():
            self.assertEqual(hashlib.sha256(Path(path).read_bytes()).hexdigest(), want, name)
        listed = C.parse_sums((R12 / "SHA256SUMS").read_text())
        for n, rel in (("r12Gate", "jobs/bsro_gate.py"), ("r12Ns", "jobs/ns.sh"), ("r12Positive", "jobs/positive.sh"),
                       ("r12Fixtures", "jobs/fixtures.sh")):
            self.assertEqual(listed[rel], C.PINS[n][1], n)
        g = (R12 / "jobs/bsro_gate.py").read_text()
        self.assertIn(f'BASE = "{C.BUILD_BASE}"', g); self.assertIn('RO_ROOTS = ("/home/steven", "/tmp")', g)
        for f in ("def run_capture(", "def verify_binaries(", "def qualified(", "def live_completion(", "def no_live_sessions(",
                  "def root_floor_ok(", "def maps_inside(", "def ns_checks(", "def ro_tree_ok(", "def group_alive(", "def write_new("):
            self.assertIn(f, g, f)

    def test_02_parser_binding_pending_refuses_first(self):
        self.assertIsNone(C.ACCEPTANCE)
        with self.assertRaisesRegex(C.Refused, "PARSER BINDING PENDING"):
            C.parser_binding()
        for call in (lambda: C.run("positive", "/nonexistent", 1, 1), lambda: C.precheck("fixtures", "/nonexistent")):
            with self.assertRaisesRegex(C.Refused, "PARSER BINDING PENDING"):
                call()
        self.assertEqual(C.main(["precheck", "positive", BD]), 3)
        self.assertTrue(C.receipt_errors(receipt(), "positive", C.expected_identities("positive", BUILD, HR)))  # never passes while pending
        tree = ast.parse((STAGE / "capture.py").read_text())
        for fn in (n for n in tree.body if isinstance(n, ast.FunctionDef) and n.name in ("run", "precheck", "gates")):
            first = fn.body[1] if isinstance(fn.body[0], ast.Expr) and isinstance(fn.body[0].value, ast.Constant) else fn.body[0]
            self.assertIn("parser_binding", ast.dump(first), fn.name)

    def test_03_parse_sums_strict(self):
        self.assertEqual(C.parse_sums("a" * 64 + "  x/y.py\n"), {"x/y.py": "a" * 64})
        for t in ("a" * 64 + "  x\n" + "b" * 64 + "  x\n", "a" * 64 + " x\n", "a" * 64 + "  /abs\n", "a" * 64 + "  a/../b\n",
                  "A" * 64 + "  x\n", "a" * 64 + "  x", "", b"x"):
            with self.assertRaises(C.Refused):
                C.parse_sums(t)

    def test_04_lane_routes_mounts(self):
        self.assertTrue(C.lane512_ok(str(512 << 20), 16384 + 768))
        for mm, av in ((str(4096 << 20), 99999), (str(512 << 20), 16384 + 767), (str(512 << 20), True)):
            with self.assertRaises(C.Refused):
                C.lane512_ok(mm, av)
        with self.assertRaises(C.Refused):
            C.no_ipv4_routes("Iface\tDestination\neth0\t0\n")
        mi = "36 35 0:31 / / rw - ext4 /dev/x rw\n90 36 0:44 / " + BD + "/fixture-captures/p/work/trees/v1-pass ro - ext4 /dev/y rw\n"
        self.assertEqual(C.mounts_under(mi, BD + "/fixture-captures/p"), [BD + "/fixture-captures/p/work/trees/v1-pass"])
        self.assertEqual(C.mounts_under(mi, BD + "/fixture-captures/q"), [])
        self.assertEqual(C.mounts_under(mi, BD + "/fixture-captures/p/work/tree"), [])           # a prefix is not a parent

    def test_05_run_paths_match_the_r12_script_contract(self):
        rd, work, arg = C.run_paths(BD, "positive", 1793000000, 77)
        self.assertTrue(rd.startswith(BD + "/fixture-captures/positive-")); self.assertEqual(work, rd + "/work"); self.assertEqual(arg, BD)
        self.assertRegex(work[len(BD + "/fixture-captures/"):], r"^[A-Za-z0-9_-]+/work$")      # the r12 scripts' WORK rule
        self.assertEqual(C.run_paths(BD, "fixtures", 1793000000, 77)[2], BD + "/base-state-readonly")
        for bad in ((BD + "/", "positive", 1, 1), ("/tmp/out", "positive", 1, 1), (BD, "other", 1, 1), (BD, "positive", 1, 0),
                    (BD, "positive", 1, True)):
            with self.assertRaises(C.Refused, msg=bad):
                C.run_paths(*bad)

    def test_06_exactly_the_verified_r12_build_receipt(self):
        s = C.PINS["r12Sums"][1]
        self.assertEqual(len(C.matching_build_receipts([("build-1", HR, BUILD)], s, BD)), 1)
        for mut in (dict(verified=1), dict(finalRc=10), dict(finalRc=False), dict(stageSums="0" * 64), dict(mode="preflight"),
                    dict(guard={"outDir": BD + "x"})):
            self.assertEqual(C.matching_build_receipts([("b", HR, dict(copy.deepcopy(BUILD), **mut))], s, BD), [], mut)
        e = C.expected_identities("fixtures", BUILD, HR)
        self.assertEqual((e["stageSums"], e["scriptSha256"], e["helperSha256"]), (s, C.PINS["r12Fixtures"][1], HB))

    def test_07_decide_requires_complete_confinement(self):
        e = C.expected_identities("positive", BUILD, HR)
        ok = {"outputValid": True}
        self.assertEqual(C.decide(CAP, False, ok, e, e, e, CLEAN, True), (True, []))
        for k, v in (("mountsLeft", ["/x"]), ("treesLeft", True), ("evidenceKept", False), ("groupAlive", True), ("roStillOk", False),
                     ("stageRunsUnchanged", False), ("treesLeft", None), ("evidenceKept", 1)):
            self.assertFalse(C.decide(CAP, False, ok, e, e, e, dict(CLEAN, **{k: v}), True)[0], k)
        other = dict(e, scriptSha256="9" * 64)
        for args in ((dict(CAP, abandoned=True), False), (dict(CAP, sinkError="EIO"), False), (dict(CAP, total=11), False),
                     (dict(CAP, rc=None), False), (CAP, True), (CAP, None)):
            self.assertFalse(C.decide(args[0], args[1], ok, e, e, e, CLEAN, True)[0], args)
        self.assertFalse(C.decide(CAP, False, ok, e, other, e, CLEAN, True)[0])
        self.assertFalse(C.decide(CAP, False, ok, other, other, e, CLEAN, True)[0])
        self.assertFalse(C.decide(CAP, False, {"outputValid": False}, e, e, e, CLEAN, True)[0])
        self.assertFalse(C.decide(CAP, False, ok, e, e, e, CLEAN, False)[0])
        self.assertFalse(C.decide(CAP, False, ok, e, e, e, None, True)[0])

    def test_08_receipt_errors(self):
        e = C.expected_identities("positive", BUILD, HR)
        base = C.receipt_errors(receipt(), "positive", e)
        self.assertEqual(base, ["no pinned r12-aware parser (PARSER BINDING PENDING) or a different parser"])   # the only error while pending
        for k, v in (("synthetic", True), ("pass", False), ("authenticatedBy", "summary"), ("reasons", ["x"]), ("kind", "fixtures"),
                     ("pins", {}), ("verifyBinariesAfter", 1), ("identitiesAfter", dict(e, helperSha256="9" * 64)),
                     ("cleanup", dict(CLEAN, treesLeft=True)), ("spawn", {"argv": []}), ("check", {"outputValid": 1})):
            r = receipt(); r[k] = v
            self.assertGreater(len(C.receipt_errors(r, "positive", e)), 1, k)
        r = receipt(); r["capture"]["truncated"] = True
        self.assertGreater(len(C.receipt_errors(r, "positive", e)), 1)
        r = receipt(); del r["workDir"]
        self.assertEqual(C.receipt_errors(r, "positive", e), ["receipt keys are not exact"])

    def test_09_spawn_write_mount_confined(self):
        tree = ast.parse((STAGE / "capture.py").read_text())
        users = {}
        for fn in (n for n in tree.body if isinstance(n, ast.FunctionDef)):
            for n in ast.walk(fn):
                if isinstance(n, ast.Attribute) and n.attr in ("run_capture", "write_new", "mkdir", "ns_checks", "maps_inside"):
                    users.setdefault(n.attr, set()).add(fn.name)
                if isinstance(n, ast.Name) and n.id == "exec":
                    users.setdefault("exec", set()).add(fn.name)
        self.assertEqual(users, {"run_capture": {"run"}, "write_new": {"run"}, "mkdir": {"run"}, "ns_checks": {"run"},
                                 "maps_inside": {"run"}, "exec": {"load_pinned"}})
        imports = {a.name for n in ast.walk(tree) if isinstance(n, ast.Import) for a in n.names}
        self.assertFalse(imports & {"subprocess", "shutil", "tempfile"})
        src = (STAGE / "capture.py").read_text()
        self.assertNotIn('"/tmp/', src.replace('RO_PATHS = ("/home/steven", "/tmp")', ""))

    def test_10_job_scripts_order_and_pins(self):
        run = code_lines(STAGE / "jobs/run.sh"); inner = code_lines(STAGE / "jobs/inner.sh")
        jr = "\n".join(run); ji = "\n".join(inner)
        self.assertLess(jr.index("capture.py\" precheck"), jr.index("unshare -Urnm bash \"$S/jobs/inner.sh\""))
        self.assertIn("sha256sum -c --quiet SHA256SUMS", jr)
        self.assertIn(f"R12SUMS={C.PINS['r12Sums'][1]}", ji); self.assertIn(f"R12NS={C.PINS['r12Ns'][1]}", ji)
        order = [ji.index(s) for s in ('[ "$(sha256sum < "$R12/jobs/ns.sh"', 'source "$R12/jobs/ns.sh"', "ns_harden /home/steven /tmp",
                                       'exec env -i PATH=/usr/bin:/bin LC_ALL=C python3 -I -B "$S/capture.py" run')]
        self.assertEqual(order, sorted(order))
        self.assertNotIn("mount ", ji.replace("ns_harden", "")); self.assertNotIn("--fixture", jr + ji)

    def test_11_r12_scripts_have_no_default_and_no_tmp_or_stage_writes(self):
        for name in ("positive.sh", "fixtures.sh"):
            lines = code_lines(R12 / "jobs" / name); body = "\n".join(lines)
            self.assertEqual(lines[0], "set -uo pipefail"); self.assertEqual(lines[1], "export PATH=/usr/bin:/bin")
            self.assertTrue(lines[2].startswith("[ $# = 2 ] ||"), name)                         # validated before anything else
            for bad in ("/tmp", "$S/runs", "${1:-", "${2:-", "${1:?", "${2:?", "mktemp", "TMPDIR"):
                self.assertNotIn(bad, body, (name, bad))
            for target in re.findall(r'(?<![0-9&])>\s*"([^"]+)"', body):
                self.assertTrue(target.startswith(("$O/", "$T/")), (name, target))               # every redirect under WORK
            for l in lines:
                if re.search(r"\bmkdir\b", l):
                    self.assertTrue(all(a.startswith(('"$WORK"', '"$T', '"$O"')) for a in re.findall(r'"\$[A-Z]+[^"]*"', l.split("mkdir", 1)[1].split("||")[0])), l)
                if re.search(r"\brm -rf\b", l):
                    self.assertIn('rm -rf -- "$T"', l, l)
            self.assertIn('T=$WORK/trees; O=$WORK/out', body)

    def test_12_r12_cleanup_scoped_and_evidence_kept(self):
        p = "\n".join(code_lines(R12 / "jobs/positive.sh"))
        self.assertIn('for d in "$T"/*/; do mountpoint -q "$d" && umount "$d"; done', p)
        self.assertLess(p.index("findmnt -rn -o TARGET"), p.index('rm -rf -- "$T"'))           # never remove while a mount remains
        self.assertNotIn('rm -rf -- "$O"', p); self.assertNotIn('rm -rf -- "$WORK"', p)
        f = "\n".join(code_lines(R12 / "jobs/fixtures.sh"))
        self.assertIn('> "$O/$n.out"', f); self.assertNotIn('rm -rf -- "$O"', f); self.assertNotIn(".*.out", f)

    def test_13_r12_scripts_refuse_bad_arguments_before_any_write(self):
        env = {"PATH": "/usr/bin:/bin"}
        with tempfile.TemporaryDirectory() as td:
            before = sorted(os.listdir(td))
            pos = [[], [BD], [BD, BD + "/fixture-captures/x/work", "extra"], ["/tmp/out", "/tmp/out/fixture-captures/x/work"],
                   [BD, "/tmp/work"], [BD, td + "/work"], [BD, BD + "/fixture-captures/../work"], [BD, BD + "/fixture-captures/x/y/work"],
                   [BD, "fixture-captures/x/work"], [BD, BD + "/fixture-captures/x/work"]]   # last: shape ok, BD does not exist
            fx = [[], [BD + "/base-state-readonly"], ["/tmp/base-state-readonly", "/tmp/w"],
                  [BD + "/mk_fixture", BD + "/fixture-captures/x/work"], [BD + "/base-state-readonly", td + "/work"],
                  [BD + "/base-state-readonly", BD + "/fixture-captures/x/work"]]
            for script, cases in (("positive.sh", pos), ("fixtures.sh", fx)):
                for args in cases:
                    p = subprocess.run(["/usr/bin/bash", str(R12 / "jobs" / script), *args], env=env, capture_output=True, text=True,
                                       timeout=30, cwd=td)
                    self.assertEqual(p.returncode, 9, (script, args, p.stdout, p.stderr))
            self.assertEqual(sorted(os.listdir(td)), before)                                     # nothing was created

    def test_14_ns_reuse_is_the_reviewed_hardening(self):
        ns = (R12 / "jobs/ns.sh").read_text()
        self.assertIn("mount --make-rprivate / ||", ns); self.assertIn('mount --rbind -o ro=recursive "$d" "$d"', ns)
        self.assertIn("ns_harden /home/steven /tmp", (R12 / "jobs/build.sh").read_text())        # the same call the build uses
        self.assertEqual(C.RO_PATHS, ("/home/steven", "/tmp"))


if __name__ == "__main__":
    unittest.main()
