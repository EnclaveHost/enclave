#!/usr/bin/env python3
"""Strict refusal tests of bundle/runner/check-compound-gate.py (PREPARED; root runs them, e.g. under the shared 256 MiB queue):
  python3 tests/test-compound-gate.py
Inputs: the ACTUAL run-2 receipts/logs (outputs/.../m10-guest-native-2; must equal the pins), a COPY of the reviewed child stage
(finality-stage/m10-cli-child-evidence, MANIFEST f3d45ccb), and a SYNTHETIC supplement (49 runs) built from the child pins. The
compound.json of the positive case is produced by the PINNED child checker itself. A passing positive case proves the gate's
logic only: it is NOT a production compound acceptance (no real supplement has been run)."""
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
    (rec / "cli-child-1.out").write_text("## cli-child supplement attempt 1: unit exit 0; compound checker rc 0\n## compoundAccepted: True\n")
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
    p = subprocess.run(a, capture_output=True, text=True); return p.returncode, (p.stdout.strip().splitlines() or [""])[0]
fails = 0
def case(name, want_ok, mutate=None, **ov):
    global fails
    with tempfile.TemporaryDirectory() as td:
        t = pathlib.Path(td); build(t, mutate); rc, msg = gate(t, **ov)
    ok = (rc == 0) == want_ok; fails += not ok; print(("[ok] " if ok else "[FAIL] ") + f"{name}: gate rc={rc} {msg[:160]}", flush=True)
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
case("N11 cli-child .out lacks compoundAccepted True", False, {"post": lambda t: (t / "receipts/cli-child-1.out").write_text("## compoundAccepted: False\n")})
case("N12 negative control passed instead of failing", False, {"pre": lambda t, st: (st["runs"][-1].update(rc=0, stdoutSha256=sha(OK1(CH).encode())), (t / "sup/control-no-env.stdout").write_text(OK1(CH)))})
case("N13 launcher pin mismatch", False, **{"launcher-sha": "3" * 64})
case("N14 extra run-2 log", False, {"post": lambda t: (t / "logs/extra.test.out").write_text("test result: ok. 1 passed; 0 failed; 0 ignored;\n")})
case("N15 malformed pin argument", False, **{"compound-sha": "not-a-sha"})
case("N16 ignored annotation changed in cli.test.out", False, {"post": edit(lambda t: t / "logs/cli.test.out", lambda s: s.replace("isolated process env", "isolated env"))})
print(f"## compound gate tests failed={fails}"); sys.exit(1 if fails else 0)
