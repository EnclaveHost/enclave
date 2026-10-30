#!/usr/bin/env python3
"""Strict refusal tests of bundle/runner/check-compound-gate.py (PREPARED; root runs them, e.g. under the shared 256 MiB queue):
  python3 tests/test-compound-gate.py
Inputs: the ACTUAL run-2 receipts/logs (outputs/.../m10-guest-native-2; must equal the pins), a COPY of the reviewed child stage
(finality-stage/m10-cli-child-evidence, MANIFEST f3d45ccb), and a SYNTHETIC supplement (49 runs) built from the child pins. The
compound.json of the positive case is produced by the PINNED child checker itself. A passing positive case proves the gate's
logic only. The R-cases run the gate on ROOT'S ACTUAL collected evidence (published copy: m10-cli-child-evidence-prepared/{stage,
run2-evidence,actual/supplement-1}), so no assumed output format can mask a mismatch (v3; v2 checked the wrong file)."""
# Root review: a negative case needs an explicit rc=1 refusal with no stderr; a crash, timeout or import error is INVALID.
import hashlib, json, pathlib, shutil, subprocess, sys, tempfile
W = pathlib.Path("/home/steven/Documents/Codex/2026-10-18/wo/work/rpc-production-final-20261025")
GATE = pathlib.Path(__file__).resolve().parents[1] / "bundle/runner/check-compound-gate.py"
CHILD_STAGE = W / "finality-stage/m10-cli-child-evidence"
RUN2 = pathlib.Path("/home/steven/Documents/Codex/2026-10-18/wo/outputs/rpc-production-final-20261025/m10-guest-native-2")
sha = lambda b: hashlib.sha256(b).hexdigest()
P = json.loads((CHILD_STAGE / "pins/pins.json").read_text()); C = P["cases"]; TOTAL = C["totalTestsInBinary"]
OK1 = lambda n: f"\nrunning 1 test\ntest {n} ... ok\n\ntest result: ok. 1 passed; 0 failed; 0 ignored; 0 measured; {TOTAL - 1} filtered out; finished in 0.01s\n\n"
CH = C["child"]
CONTROL = (f"\nrunning 1 test\ntest {CH} ... FAILED\n\nfailures:\n\n---- {CH} stdout ----\n\nthread '{CH}' panicked at crates/consensus/cli/src/node.rs:970:9:\n"
           f"assertion failed: args.validate_sequencer_key().is_ok()\n\n\nfailures:\n    {CH}\n\ntest result: FAILED. 0 passed; 1 failed; 0 ignored; 0 measured; {TOTAL - 1} filtered out; finished in 0.01s\n\n")
ENV = {"raw_key": {"BASE_NODE_P2P_SEQUENCER_KEY": P["fixtures"]["rawKeySha256"]}, "key_path": {"BASE_NODE_P2P_SEQUENCER_KEY_PATH": sha(b"/tmp/key.hex")},
       "remote_endpoint": {"BASE_NODE_P2P_SIGNER_ENDPOINT": sha(b"http://localhost:8080"), "BASE_NODE_P2P_SIGNER_ADDRESS": sha(b"0xAf6E19BE0F9cE7f8afd49a1824851023A8249e8a")}}
BASEK = ["HOME", "LANG", "PATH"]
def build(t, mutate=None):
    rec, logs, sup, cs = t / "receipts", t / "logs", t / "sup", t / "child"
    shutil.copytree(CHILD_STAGE, cs, ignore=shutil.ignore_patterns("logs", "__pycache__")); rec.mkdir(); logs.mkdir(); sup.mkdir()
    for f in ("run-2.receipt.json", "run-2.out", "run-2.rc"): shutil.copy(RUN2 / f, rec / f)
    for f in P["run2"]["logs"]: shutil.copy(RUN2 / f, logs / f)
    runs = []
    def add(label, kind, name, argv, env, out, rc=0):
        (sup / f"{label}.stdout").write_text(out); (sup / f"{label}.stderr").write_text("")
        runs.append({"label": label, "kind": kind, "name": name, "argv": argv, "envKeys": sorted(BASEK + list(env)), "envValueSha256": env,
                     "rc": rc, "timedOut": False, "stdoutSha256": sha(out.encode()), "stderrSha256": sha(b"")})
    for i, n in enumerate(C["nonIgnored"], 1): add(f"case-{i:02d}", "nonIgnored", n, ["--exact", n], {}, OK1(n))
    for c in C["childEnvCases"]: add(f"child-{c}", "child", CH, ["--exact", CH, "--ignored"], dict(ENV[c]), OK1(CH))
    add("control-no-env", "control", CH, ["--exact", CH, "--ignored"], {}, CONTROL, rc=101)
    st = {"runs": runs, "launcher": {"format": "m10-cli-child-supplement-launcher/v1", "attempt": 1, "unitExit": 0, "binarySha256Before": P["binary"]["sha256"],
          "binarySha256After": P["binary"]["sha256"], "executedCopySha256": P["binary"]["sha256"], "executedCopySha256After": P["binary"]["sha256"], "sourceSha256": P["source"]["sha256"]}}
    if mutate and mutate.get("pre"): mutate["pre"](t, st)
    (sup / "results.json").write_text(json.dumps({"binarySha256": P["binary"]["sha256"], "runs": st["runs"]}))
    (rec / "cli-child-1.launcher.json").write_text(json.dumps(st["launcher"]))
    p = subprocess.run([sys.executable, "-I", str(cs / "checker/check_compound.py"), "--pins", str(cs / "pins/pins.json"), "--run2-receipts", str(rec),
                        "--run2-logs", str(logs), "--supplement", str(sup), "--launcher", str(rec / "cli-child-1.launcher.json")], capture_output=True)
    (rec / "cli-child-1.compound.json").write_bytes(p.stdout)
    (rec / "cli-child-1.out").write_text("recorded 49 runs\n")   # the ACTUAL unit output format (cli_child_cases.py)
    if mutate and mutate.get("post"): mutate["post"](t)
    return p.returncode
def manifest(d):
    fs = sorted(x for x in d.rglob("*") if x.is_file())
    return sha("".join(f"{sha(x.read_bytes())}  {x.relative_to(d)}\n" for x in fs).encode())
def gate(t, **ov):
    rec, sup = t / "receipts", t / "sup"
    pins = {"compound-sha": sha((rec / "cli-child-1.compound.json").read_bytes()) if (rec / "cli-child-1.compound.json").exists() else "0" * 64,
            "launcher-sha": sha((rec / "cli-child-1.launcher.json").read_bytes()), "child-out-sha": sha((rec / "cli-child-1.out").read_bytes()),
            "supplement-manifest-sha": manifest(sup) if sup.exists() else "0" * 64, "attempt": "1"}
    pins.update(ov)
    a = [sys.executable, "-I", str(GATE), "--child-stage", str(t / "child"), "--receipts", str(rec), "--run2-logs", str(t / "logs"), "--supplement", str(sup)]
    for k, v in pins.items(): a += [f"--{k}", v]
    p = subprocess.run(a, capture_output=True, text=True); return p.returncode, (p.stdout.strip().splitlines() or [""])[0], p.stderr
fails = 0
def case(name, want_ok, mutate=None, **ov):
    global fails
    with tempfile.TemporaryDirectory() as td:
        t = pathlib.Path(td); build(t, mutate); rc, msg, stderr = gate(t, **ov)
    ok = (rc == 0) if want_ok else (rc == 1 and msg.startswith("[REFUSE]") and not stderr.strip()); fails += not ok; print(("[ok] " if ok else "[FAIL] ") + f"{name}: gate rc={rc} {msg[:160]}" + (f" stderr={stderr[-500:]}" if stderr else ""), flush=True)
def edit(path, f): return lambda t: path(t).write_text(f(path(t).read_text()))
for f, h in {**P["run2"]["receipts"], **P["run2"]["logs"]}.items():
    if sha((RUN2 / f).read_bytes()) != h: print(f"[FAIL] actual run-2 fixture {f} differs from its pin"); sys.exit(1)
case("P1 actual run 2 (pass:false kept) + synthetic complete supplement, checker re-run accepted", True)
case("N1 compound.json absent", False, {"post": lambda t: (t / "receipts/cli-child-1.compound.json").unlink()})
case("N2 compound pin mismatch", False, **{"compound-sha": "1" * 64})
case("N3 supplement missing a run, forged compoundAccepted:true", False, {"pre": lambda t, st: (st["runs"].pop(10), (t / f"sup/{'case-11'}.stdout").unlink(), (t / "sup/case-11.stderr").unlink()),
     "post": lambda t: (t / "receipts/cli-child-1.compound.json").write_text(json.dumps({"compoundAccepted": True, "failures": []}))})
case("N4 compound.json boolean/summary edited after a valid run", False, {"post": edit(lambda t: t / "receipts/cli-child-1.compound.json", lambda s: s.replace('"controlKilledByAssertion": true', '"controlKilledByAssertion": true ')) })
case("N5 original receipt forged to pass:true", False, {"post": edit(lambda t: t / "receipts/run-2.receipt.json", lambda s: s.replace('"pass": false', '"pass": true'))})
case("N6 a second ignored test in a phase log", False, {"post": edit(lambda t: t / "logs/node.test.out", lambda s: s + "test node::x ... ignored\n")})
case("N7 child checker modified", False, {"post": edit(lambda t: t / "child/checker/check_compound.py", lambda s: s + "\n# changed\n")})
case("N8 child checker tests modified", False, {"post": edit(lambda t: t / "child/tests/test_check_compound.py", lambda s: s + "\n# changed\n")})
case("N9 unlisted file in the child stage", False, {"post": lambda t: (t / "child/checker/extra.py").write_text("x")})
case("N10 supplement manifest pin mismatch", False, **{"supplement-manifest-sha": "2" * 64})
case("N11 unit .out count corrupted (48)", False, {"post": lambda t: (t / "receipts/cli-child-1.out").write_text("recorded 48 runs\n")})
case("N17 unit .out replaced by the host launch log (the v2 mistake)", False, {"post": lambda t: (t / "receipts/cli-child-1.out").write_text("## cli-child supplement attempt 1: unit exit 0; compound checker rc 0\n## compoundAccepted: True\n")})
case("N18 unit .out with an extra line", False, {"post": lambda t: (t / "receipts/cli-child-1.out").write_text("recorded 49 runs\nextra\n")})
case("N12 negative control passed instead of failing", False, {"pre": lambda t, st: (st["runs"][-1].update(rc=0, stdoutSha256=sha(OK1(CH).encode())), (t / "sup/control-no-env.stdout").write_text(OK1(CH)))})
case("N13 launcher pin mismatch", False, **{"launcher-sha": "3" * 64})
case("N14 extra run-2 log", False, {"post": lambda t: (t / "logs/extra.test.out").write_text("test result: ok. 1 passed; 0 failed; 0 ignored;\n")})
case("N15 malformed pin argument", False, **{"compound-sha": "not-a-sha"})
case("N16 ignored annotation changed in cli.test.out", False, {"post": edit(lambda t: t / "logs/cli.test.out", lambda s: s.replace("isolated process env", "isolated env"))})
# ---- R: ROOT'S ACTUAL collected evidence (root-2339 supplement attempt 1; published copy) -------------------------------------
PUB = W / "source/ops/rpc-backend-bootstrap/2026-10-25/m10-cli-child-evidence-prepared"
ACT = {"compound-sha": "79a0beb95ca3058853615e41d83d948f5d875cf1ea5dbc8b511ac9cb15a2ab14", "launcher-sha": "09621f4e6e423ce96898f97c089a10883618f29607d079a4385f28f5dcb98b7c",
       "child-out-sha": "356466e824768aa415709b1680251c60f91d464ebf97a0c20f4fd97acb4a1dd3", "supplement-manifest-sha": "cf75de6890747d4a9224e84c8267628b6f2178348510687f2b4b2c2bec0e8175", "attempt": "1"}
def build_actual(t, post=None):
    rec, logs = t / "receipts", t / "logs"; rec.mkdir(); logs.mkdir()
    shutil.copytree(PUB / "stage", t / "child"); shutil.copytree(PUB / "actual/supplement-1/out", t / "sup")
    for f in ("run-2.receipt.json", "run-2.out", "run-2.rc"): shutil.copy(PUB / "run2-evidence" / f, rec / f)
    for f in P["run2"]["logs"]: shutil.copy(PUB / "run2-evidence" / f, logs / f)
    for f in ("cli-child-1.compound.json", "cli-child-1.launcher.json", "cli-child-1.out"): shutil.copy(PUB / "actual/supplement-1" / f, rec / f)
    if post: post(t)
def actual(name, want_ok, post=None, repin=False):
    global fails
    with tempfile.TemporaryDirectory() as td:
        t = pathlib.Path(td); build_actual(t, post)
        ov = dict(ACT)
        if repin: ov.update({"compound-sha": sha((t / "receipts/cli-child-1.compound.json").read_bytes()), "child-out-sha": sha((t / "receipts/cli-child-1.out").read_bytes()),
                             "supplement-manifest-sha": manifest(t / "sup")})
        a = [sys.executable, "-I", str(GATE), "--child-stage", str(t / "child"), "--receipts", str(t / "receipts"), "--run2-logs", str(t / "logs"), "--supplement", str(t / "sup")]
        for k, v in ov.items(): a += [f"--{k}", v]
        p = subprocess.run(a, capture_output=True, text=True); rc, msg, stderr = p.returncode, (p.stdout.strip().splitlines() or [""])[0], p.stderr
    ok = (rc == 0) if want_ok else (rc == 1 and msg.startswith("[REFUSE]") and not stderr.strip()); fails += not ok; print(("[ok] " if ok else "[FAIL] ") + f"{name}: gate rc={rc} {msg[:160]}" + (f" stderr={stderr[-500:]}" if stderr else ""), flush=True)
actual("R1 ACTUAL collected evidence with its actual pins is accepted (checker re-run on real files)", True)
actual("R2 actual evidence, one supplement stdout byte changed (re-pinned)", False, post=lambda t: (t / "sup/case-07.stdout").write_bytes((t / "sup/case-07.stdout").read_bytes().replace(b"ok", b"oK", 1)), repin=True)
actual("R3 actual evidence, unit .out replaced by the host launch.out (re-pinned)", False, post=lambda t: shutil.copy(PUB / "actual/supplement-1/launch.out", t / "receipts/cli-child-1.out"), repin=True)
actual("R4 actual evidence, compound.json reformatted (re-pinned)", False, post=lambda t: (t / "receipts/cli-child-1.compound.json").write_text(json.dumps(json.loads((t / "receipts/cli-child-1.compound.json").read_text()))), repin=True)
actual("R5 actual evidence with the original run-2 receipt flipped to pass:true", False, post=edit(lambda t: t / "receipts/run-2.receipt.json", lambda s: s.replace('"pass": false', '"pass": true')))
print(f"## compound gate tests failed={fails}"); sys.exit(1 if fails else 0)
