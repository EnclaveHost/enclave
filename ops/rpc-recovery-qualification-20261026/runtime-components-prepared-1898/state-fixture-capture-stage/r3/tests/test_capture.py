#!/usr/bin/env python3
"""state-fixture-capture-stage/r3 tests/test_capture.py (PREPARED by Claude 1879/1889; NOT run by Claude). 18 unit tests.
Pure checks of capture.py (never its spawning path: run()/precheck() are only called with argument shapes refused before any read),
static + early-refusal checks of the frozen r12 fixture scripts (test 13 executes them ONLY with arguments that are refused before any
write), the job scripts, and r3's binding (pinned acceptance r3 + its actual receipt, exact outputs line, evidence manifest, /vm and
read-only path sets). r3 (root 1886): the source inspection strips shell comments QUOTE-AWARE (test 15 regression). No mount, build,
toolchain, network or data. Every capture/receipt here is SYNTHETIC: never a fixture receipt, never compiled-fixture qualification."""
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


A = C.load_pinned(*C.ACCEPTANCE["module"], "acceptance_r3_pinned")
WORK = BD + "/fixture-captures/positive-20261101T000000Z-77/work"
FORBIDDEN = ("/tmp", "$S/runs", "${1:-", "${2:-", "${1:?", "${2:?", "mktemp", "TMPDIR")


def code_lines(path):
    return [l for l in Path(path).read_text().splitlines() if l.strip() and not l.lstrip().startswith("#")]


def shell_code(text):
    """r3 (root 1886): the executable shell text - a `#` starts a comment only OUTSIDE quotes and at a word start (so `$#`, `${#x}`,
    `${v#p}` and quoted `#` stay code); here-document bodies are kept VERBATIM (data/another language: conservatively still inspected).
    Known limit: double quotes nested inside "$( ... )" are tracked as plain toggles (errs toward keeping text, except a ` #` inside
    such a nested inner string; the frozen r12 scripts have none - test 11 would still see every other line)."""
    out, q, here = [], None, None
    for line in text.split("\n"):
        if here is not None:
            if line == here:
                here = None
            else:
                out.append(line)
            continue
        buf, j = [], 0
        while j < len(line):
            c = line[j]
            if q == "'":
                buf.append(c); q = None if c == "'" else q; j += 1; continue
            if c == "\\" and j + 1 < len(line):
                buf.append(line[j:j + 2]); j += 2; continue
            if q == '"':
                buf.append(c); q = None if c == '"' else q; j += 1; continue
            if c in "'\"":
                q = c; buf.append(c); j += 1; continue
            if c == "#" and (j == 0 or line[j - 1] in " \t;&|()"):
                break
            buf.append(c); j += 1
        code = "".join(buf).rstrip()
        if q is None:
            m = re.search(r"<<-?\s*(['\"]?)([A-Za-z_][A-Za-z0-9_]*)\1", code)
            if m:
                here = m.group(2)
        if code.strip():
            out.append(code)
    return out


def forbidden_hits(lines):
    body = "\n".join(lines)
    return [b for b in FORBIDDEN if b in body]


def receipt(kind="positive"):
    e = C.expected_identities(kind, BUILD, HR)
    return {"format": C.RECEIPT_FORMAT, "kind": kind, "pass": True, "synthetic": False, "authenticatedBy": "capture", "reasons": [],
            "roPaths": ["/home/steven", "/tmp", "/dev/shm"], "vmBinding": {"majmin": C.VM_MAJMIN, "uuid": C.VM_UUID},
            "outputsLine": {"want": WORK + "/out", "errors": []},
            "evidence": {"errors": [], "manifest": [{"name": "binaries.sha256", "size": 1, "sha256": "7" * 64}]},
            "pins": {n: v[1] for n, v in C.PINS.items()}, "acceptance": {n: v[1] for n, v in C.ACCEPTANCE.items()},
            "wrapperSums": "4" * 64, "buildOutDir": BD,
            "runDir": WORK[:-len("/work")], "workDir": WORK,
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
        # r3: acceptance r3 + root's actual 46-test receipt, rehashed from the files
        for name, (path, want) in C.ACCEPTANCE.items():
            self.assertEqual(hashlib.sha256(Path(path).read_bytes()).hexdigest(), want, name)
        alisted = C.parse_sums(Path(C.ACCEPTANCE["sums"][0]).read_text())
        self.assertEqual(alisted["acceptance.py"], C.ACCEPTANCE["module"][1])
        self.assertEqual((A.R12_STAGE_SUMS_SHA256, A.R12_POSITIVE_SH_SHA256, A.R12_FIXTURES_SH_SHA256),
                         (C.PINS["r12Sums"][1], C.PINS["r12Positive"][1], C.PINS["r12Fixtures"][1]))
        self.assertEqual((len(A.POSITIVE_LABELS), len(A.NEGATIVE_CASES)), (26, 6))

    def test_02_parser_bound_and_bad_arguments_refuse_before_any_read(self):
        self.assertIs(C.parser_binding(), C.ACCEPTANCE)
        for call in (lambda: C.run("positive", "/nonexistent", 1, 1), lambda: C.precheck("fixtures", "/nonexistent"),
                     lambda: C.run("other", BD, 1, 1)):
            with self.assertRaises(C.Refused):
                call()
        self.assertEqual(C.main(["precheck", "positive", "/tmp/out"]), 3)
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
        self.assertEqual(C.receipt_errors(receipt(), "positive", e), [])                        # synthetic: a predicate test only
        for k, v in (("synthetic", True), ("pass", False), ("authenticatedBy", "summary"), ("reasons", ["x"]), ("kind", "fixtures"),
                     ("pins", {}), ("verifyBinariesAfter", 1), ("identitiesAfter", dict(e, helperSha256="9" * 64)),
                     ("cleanup", dict(CLEAN, treesLeft=True)), ("spawn", {"argv": []}), ("check", {"outputValid": 1}),
                     ("acceptance", {"sums": "a" * 64}), ("roPaths", ["/tmp"]), ("vmBinding", {"majmin": "8:1", "uuid": C.VM_UUID}),
                     ("outputsLine", {"want": "/vm/x/out", "errors": []}), ("outputsLine", {"want": WORK + "/out", "errors": ["x"]}),
                     ("evidence", {"errors": [], "manifest": []}), ("evidence", {"errors": ["x"], "manifest": [{"name": "a", "size": 1, "sha256": "7" * 64}]})):
            r = receipt(); r[k] = v
            self.assertGreaterEqual(len(C.receipt_errors(r, "positive", e)), 1, k)
        r = receipt(); r["capture"]["truncated"] = True
        self.assertGreaterEqual(len(C.receipt_errors(r, "positive", e)), 1)
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
        order = [ji.index(s) for s in ('[ "$(sha256sum < "$R12/jobs/ns.sh"', 'source "$R12/jobs/ns.sh"', 'RO="/home/steven /tmp"',
                                       'for d in /var/tmp /dev/shm "/run/user/$OUID"; do', 'ns_harden $RO ||',
                                       'exec env -i PATH=/usr/bin:/bin LC_ALL=C python3 -I -B "$S/capture.py" run')]
        self.assertEqual(order, sorted(order))
        self.assertEqual(tuple(x.split("/{")[0] for x in C.EXTRA_RO), ("/var/tmp", "/dev/shm", "/run/user"))   # inner.sh == ro_paths
        self.assertNotIn("mount ", ji.replace("ns_harden", "")); self.assertNotIn("--fixture", jr + ji)

    def test_11_r12_scripts_have_no_default_and_no_tmp_or_stage_writes(self):
        for name in ("positive.sh", "fixtures.sh"):
            lines = shell_code((R12 / "jobs" / name).read_text()); body = "\n".join(lines)          # r3: quote-aware comments
            self.assertEqual(lines[0], "set -uo pipefail"); self.assertEqual(lines[1], "export PATH=/usr/bin:/bin")
            self.assertTrue(lines[2].startswith("[ $# = 2 ] ||"), name)                         # validated before anything else
            self.assertEqual(forbidden_hits(lines), [], name)
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

    def test_15_quote_aware_comments_and_executable_tmp_still_rejected(self):
        src = "\n".join(["#!/bin/bash", "set -uo pipefail",
                         "T=$WORK/trees; O=$WORK/out                       # r12: both NEW (no /tmp, no stage runs/)",
                         "[ $# = 2 ] || exit 9; echo ${#T} ${T#x}  # $# and ${#} are not comments",
                         "x='# /tmp in single quotes is data, kept'", 'echo "a # b" # trailing /tmp comment',
                         "cat <<'PY'", "# /tmp inside a here-document body is kept", "PY", "echo done"])
        code = shell_code(src)
        for keep in ("set -uo pipefail", "T=$WORK/trees; O=$WORK/out", "[ $# = 2 ] || exit 9; echo ${#T} ${T#x}",
                     "x='# /tmp in single quotes is data, kept'", 'echo "a # b"', "cat <<'PY'",
                     "# /tmp inside a here-document body is kept", "echo done"):
            self.assertIn(keep, code, keep)
        self.assertFalse([l for l in code if "comment" in l and "/tmp" in l and "kept" not in l], code)
        self.assertEqual(forbidden_hits(shell_code("\n".join(src.split("\n")[:4]))), [])      # the 1886 false positive is gone
        self.assertEqual(forbidden_hits(code), ["/tmp"])                                       # quoted / here-doc /tmp still seen
        for bad in ("O=/tmp/out", "mkdir -p /tmp/x   # a comment", 'echo x > "/tmp/y"', "T=${TMPDIR:-/tmp}", "cd /tmp#x",
                    'x="$(echo "/tmp")"', "T=$WORK/t; O=/tmp/out # no /tmp", "D=$(mktemp -d)", 'S=1; cp a "$S/runs/x"',
                    "W=${2:-/vm/w}", "O=\\#/tmp", "a=1;/tmp/x"):
            self.assertTrue(forbidden_hits(shell_code(bad)), bad)                               # executable use is REJECTED

    def test_16_outputs_line_exact_beyond_the_parser(self):
        e = C.expected_identities("positive", BUILD, HR)
        body = [f"case {l}: PASS" for l in A.POSITIVE_LABELS] + ["## runs=26 failed=0"]
        cap = lambda out: ("\n".join(body + [f"## outputs {out}", "## bsro-r12-positive rc=0"]) + "\n").encode()
        good = cap(WORK + "/out")
        self.assertIs(A.check_fixture_capture("positive", good, 0, False, False, e, e)["outputValid"], True)
        self.assertEqual(C.outputs_line_errors("positive", good, WORK), [])
        for other in ("/vm/other/out", WORK + "/out/", WORK + "/trees", WORK, BD + "/fixture-captures/positive-x/work/out"):
            self.assertIs(A.check_fixture_capture("positive", cap(other), 0, False, False, e, e)["outputValid"], True, other)  # parser: any abs
            self.assertTrue(C.outputs_line_errors("positive", cap(other), WORK), other)                                     # capture: exact
        two = ("\n".join(body + [f"## outputs {WORK}/out", f"## outputs {WORK}/out", "## bsro-r12-positive rc=0"]) + "\n").encode()
        self.assertTrue(C.outputs_line_errors("positive", two, WORK))
        self.assertTrue(C.outputs_line_errors("positive", b"\xff", WORK))
        self.assertTrue(C.outputs_line_errors("fixtures", b"## outputs /vm/x\n", WORK))
        self.assertEqual(C.outputs_line_errors("fixtures", b"## fixtures failed=0\n", WORK), [])

    def test_17_evidence_manifest_bounded_and_exact(self):
        e = C.expected_identities("positive", BUILD, HR)
        btxt = f"{HB}  {BD}/base-state-readonly\n{HM}  {BD}/mk_fixture\n"
        with tempfile.TemporaryDirectory() as td:
            out = os.path.join(td, "out"); os.mkdir(out)
            req, opt = C.expected_evidence_names("fixtures", A)
            for n in req:
                Path(out, n).write_text("x")
            man = C.evidence_manifest(out)
            self.assertEqual(C.evidence_errors("fixtures", man, req, opt, None, BD, e), [])
            self.assertEqual(man[0]["sha256"], hashlib.sha256(b"x").hexdigest())
            Path(out, "extra.txt").write_text("y")
            self.assertTrue(C.evidence_errors("fixtures", C.evidence_manifest(out), req, opt, None, BD, e))
            os.unlink(os.path.join(out, "extra.txt")); os.unlink(os.path.join(out, sorted(req)[0]))
            self.assertTrue(C.evidence_errors("fixtures", C.evidence_manifest(out), req, opt, None, BD, e))
            Path(out, sorted(req)[0]).write_text("x")
            for make in (lambda p: os.symlink("/etc/hostname", p), lambda p: os.mkdir(p), lambda p: os.link(os.path.join(out, sorted(req)[1]), p),
                         lambda p: Path(p).write_bytes(b"z" * (C.EVIDENCE_FILE_CAP + 1))):
                p = os.path.join(out, "bad")
                make(p)
                with self.assertRaises(C.Refused):
                    C.evidence_manifest(out)
                (os.rmdir if os.path.isdir(p) and not os.path.islink(p) else os.unlink)(p)
            preq, popt = C.expected_evidence_names("positive", A)
            self.assertEqual(len(preq), 1 + 3 * 26); self.assertEqual(len(popt), 26)
            pm = [{"name": n, "size": 0, "sha256": "0" * 64} for n in sorted(preq)]
            self.assertEqual(C.evidence_errors("positive", pm, preq, popt, btxt, BD, e), [])
            self.assertEqual(C.evidence_errors("positive", pm + [{"name": "v1-pass.result.json", "size": 0, "sha256": "0" * 64}], preq, popt, btxt, BD, e), [])
            for bt in (btxt.replace(HB, "9" * 64), btxt[:-1], btxt + btxt, None):
                self.assertTrue(C.evidence_errors("positive", pm, preq, popt, bt, BD, e), bt)

    def test_18_vm_binding_ro_paths_and_acceptance_receipt(self):
        vm = os.makedev(253, 1)
        mi = "36 1 253:0 / / rw - ext4 /dev/mapper/root rw\n100 36 253:1 / /vm rw,relatime - ext4 /dev/mapper/vm rw\n"
        self.assertEqual(C.vm_binding(BD, vm, mi, vm)["source"], "/dev/mapper/vm")
        for args in ((BD, os.makedev(253, 0), mi, vm), (BD, vm, mi, os.makedev(253, 0)), (BD, vm, mi.replace("253:1", "253:7"), vm),
                     (BD, vm, mi + "101 100 0:50 / /vm/enclave-volumes rw - tmpfs tmpfs rw\n", vm), (BD, vm, "", vm),
                     (BD, vm, mi.replace("ext4 /dev/mapper/vm", "fuse.x /dev/fuse"), vm)):
            with self.assertRaises(C.Refused):
                C.vm_binding(*args)
        self.assertEqual(C.ro_paths(1000, exists=lambda p: True, islink=lambda p: False),
                         ["/home/steven", "/tmp", "/var/tmp", "/dev/shm", "/run/user/1000"])
        self.assertEqual(C.ro_paths(1000, exists=lambda p: False, islink=lambda p: False), ["/home/steven", "/tmp"])
        with self.assertRaises(C.Refused):
            C.ro_paths(1000, exists=lambda p: True, islink=lambda p: p == "/dev/shm")
        raw = Path(C.ACCEPTANCE["tests"][0]).read_bytes()
        t = __import__("json").loads(raw)
        self.assertTrue(C.acceptance_receipt_ok(t, C.ACCEPTANCE["sums"][1]))                   # root's ACTUAL receipt (pinned bytes)
        for mut in (dict(format="state-acceptance-test-receipt/r2"), dict(expected=45), dict(ran=["45"]), dict(ran=["46", "46"]), dict(rc=1),
                    dict(pass_=None), dict(stageSums="0" * 64), dict(checks=dict(t["checks"], rc0=False)), dict(checks=dict(t["checks"], extra=True))):
            m = copy.deepcopy(t); m.update({("pass" if k == "pass_" else k): v for k, v in mut.items()})
            with self.assertRaises(C.Refused, msg=mut):
                C.acceptance_receipt_ok(m, C.ACCEPTANCE["sums"][1])


if __name__ == "__main__":
    unittest.main()
