#!/usr/bin/env python3
"""Fail-closed tests of checker/check_compound.py over SYNTHETIC run-2/supplement files (no binary, no network, no key
material: the raw-key slot uses sha256 of a plain synthetic string). Root runs these (queue 256); Claude did not."""
import copy, hashlib, json, pathlib, subprocess, sys, tempfile, unittest

H = pathlib.Path(__file__).resolve().parents[1]
CHECK = H / "checker" / "check_compound.py"
CHILD = "node::tests::validates_sequencer_key_from_env_child"
NOTE = "spawned by validates_sequencer_key_from_env with isolated process env"
NAMES = [f"node::tests::synthetic_case_{i:02d}" for i in range(45)]
TOTAL, BIN = 142, "base_consensus_cli-d6ae36328af6d7bb"
BINSHA = "ab" * 32
SRCSHA = "cd" * 32
sha = lambda b: hashlib.sha256(b).hexdigest()
SYNTH_RAW = sha(b"synthetic raw_key slot (not a key)")
PHASES = ["## engine OK", "## node OK", "## node-seq OK", "## node-safedb OK", "## node-derivation OK", "## cli OK",
          "## control-engine failed exactly as expected", "## control-node failed exactly as expected", "## aggregate rc=0"]
OK1 = lambda n: f"\nrunning 1 test\ntest {n} ... ok\n\ntest result: ok. 1 passed; 0 failed; 0 ignored; 0 measured; {TOTAL - 1} filtered out; finished in 0.01s\n\n"
CONTROL = (f"\nrunning 1 test\ntest {CHILD} ... FAILED\n\nfailures:\n\n---- {CHILD} stdout ----\n\nthread '{CHILD}' panicked at "
           f"crates/consensus/cli/src/node.rs:970:9:\nassertion failed: args.validate_sequencer_key().is_ok()\nnote: run with `RUST_BACKTRACE=1` "
           f"environment variable to display a backtrace\n\n\nfailures:\n    {CHILD}\n\ntest result: FAILED. 0 passed; 1 failed; 0 ignored; 0 measured; "
           f"{TOTAL - 1} filtered out; finished in 0.01s\n\n")
ENV_SHA = {"raw_key": {"BASE_NODE_P2P_SEQUENCER_KEY": SYNTH_RAW},
           "key_path": {"BASE_NODE_P2P_SEQUENCER_KEY_PATH": sha(b"/tmp/key.hex")},
           "remote_endpoint": {"BASE_NODE_P2P_SIGNER_ENDPOINT": sha(b"http://localhost:8080"),
                               "BASE_NODE_P2P_SIGNER_ADDRESS": sha(b"0xAf6E19BE0F9cE7f8afd49a1824851023A8249e8a")}}
BASEK = ["HOME", "LANG", "PATH"]


def model():
    cli = "\nrunning 46 tests\n" + "".join(f"test {n} ... ok\n" for n in NAMES[:20]) + f"test {CHILD} ... ignored, {NOTE}\n" + \
          "".join(f"test {n} ... ok\n" for n in NAMES[20:]) + f"\ntest result: ok. 45 passed; 0 failed; 1 ignored; 0 measured; {TOTAL - 46} filtered out; finished in 0.03s\n\n"
    logs = {"cli.test.out": cli, **{f: "\nrunning 3 tests\ntest a ... ok\n\ntest result: ok. 3 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.1s\n"
                                    for f in ["engine.test.out", "node.test.out", "node-seq.test.out", "node-safedb.test.out", "node-derivation.test.out"]},
            "control-engine.test.out": "\ntest result: FAILED. 4 passed; 2 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.1s\n",
            "control-node.test.out": "\ntest result: FAILED. 1 passed; 2 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.1s\n"}
    out2 = "## toolchain x\n" + "\n".join(PHASES[:5]) + f"\n## cli: REBUILT {BIN} sha256 {BINSHA}\n" + "\n".join(PHASES[5:]) + "\n"
    receipt = {"attempt": 2, "systemdRunExit": 0, "aggregateLine": "## aggregate rc=0", "testResultLines": 8, "ignoredTotal": 1, "pass": False}
    runs, files = [], {}
    def add(label, kind, name, argv, extra, stdout, rc=0, timed=False):
        files[label] = (stdout.encode(), b"")
        runs.append({"label": label, "kind": kind, "name": name, "argv": argv, "envKeys": sorted(BASEK + list(extra)), "envValueSha256": extra,
                     "rc": rc, "timedOut": timed, "stdoutSha256": sha(stdout.encode()), "stderrSha256": sha(b"")})
    for i, n in enumerate(NAMES, 1): add(f"case-{i:02d}", "nonIgnored", n, ["--exact", n], {}, OK1(n))
    for c in ["raw_key", "key_path", "remote_endpoint"]: add(f"child-{c}", "child", CHILD, ["--exact", CHILD, "--ignored"], dict(ENV_SHA[c]), OK1(CHILD))
    add("control-no-env", "control", CHILD, ["--exact", CHILD, "--ignored"], {}, CONTROL, rc=101)
    launcher = {"unitExit": 0, "binarySha256Before": BINSHA, "binarySha256After": BINSHA, "executedCopySha256": BINSHA,
                "executedCopySha256After": BINSHA, "sourceSha256": SRCSHA}
    return {"logs": logs, "out2": out2, "receipt": receipt, "runs": runs, "files": files, "launcher": launcher, "resultsBinary": BINSHA}


def write(m, d, repin=True, pins_override=None):
    d = pathlib.Path(d); (d / "r").mkdir(); (d / "l").mkdir(); (d / "s").mkdir()
    (d / "r/run-2.out").write_text(m["out2"]); (d / "r/run-2.rc").write_text("0\n"); (d / "r/run-2.receipt.json").write_text(json.dumps(m["receipt"]))
    for f, t in m["logs"].items(): (d / "l" / f).write_text(t)
    for lab, (so, se) in m["files"].items(): (d / "s" / f"{lab}.stdout").write_bytes(so); (d / "s" / f"{lab}.stderr").write_bytes(se)
    (d / "s/results.json").write_text(json.dumps({"binarySha256": m["resultsBinary"], "runs": m["runs"]}))
    (d / "launcher.json").write_text(json.dumps(m["launcher"]))
    h = lambda p: sha(p.read_bytes())
    pins = {"binary": {"path": f"/x/{BIN}", "sha256": BINSHA}, "source": {"sha256": SRCSHA},
            "run2": {"receipts": {f: h(d / "r" / f) for f in ["run-2.out", "run-2.rc", "run-2.receipt.json"]},
                     "logs": {f: h(d / "l" / f) for f in m["logs"]}, "phaseLines": PHASES,
                     "expectedReceipt": {"systemdRunExit": 0, "aggregateLine": "## aggregate rc=0", "testResultLines": 8, "ignoredTotal": 1, "pass": False}},
            "cases": {"child": CHILD, "ignoreAnnotation": NOTE, "nonIgnored": NAMES, "totalTestsInBinary": TOTAL, "childEnvCases": ["raw_key", "key_path", "remote_endpoint"]},
            "fixtures": {"rawKeySha256": SYNTH_RAW}}
    if pins_override: pins_override(pins)
    (d / "pins.json").write_text(json.dumps(pins))
    return d


def check(d):
    p = subprocess.run([sys.executable, "-I", str(CHECK), "--pins", f"{d}/pins.json", "--run2-receipts", f"{d}/r", "--run2-logs", f"{d}/l",
                        "--supplement", f"{d}/s", "--launcher", f"{d}/launcher.json"], capture_output=True, text=True)
    return p.returncode, json.loads(p.stdout)


class Compound(unittest.TestCase):
    def verdict(self, mutate=None, after=None, pins_override=None):
        m = model()
        if mutate: mutate(m)
        with tempfile.TemporaryDirectory() as t:
            d = write(m, t, pins_override=pins_override)
            if after: after(pathlib.Path(d))
            return check(d)

    def refused(self, why, **kw):
        rc, v = self.verdict(**kw)
        self.assertEqual((rc, v["compoundAccepted"]), (1, False), v)
        self.assertTrue(any(why in f for f in v["failures"]), (why, v["failures"]))

    def test_complete_evidence_is_accepted_and_the_original_failure_stays_recorded(self):
        rc, v = self.verdict()
        self.assertEqual((rc, v["compoundAccepted"], v["originalReceiptPass"]), (0, True, False), v)
        self.assertEqual(v["summary"], {"nonIgnoredPassed": 45, "childPassed": 3, "controlKilledByAssertion": True})

    def test_run2_pins_and_its_own_failure_cannot_be_rewritten(self):
        self.refused("run-2 run-2.receipt.json differs", after=lambda d: (d / "r/run-2.receipt.json").write_text('{"pass": true}'))
        self.refused("run-2 receipt pass=True", mutate=lambda m: m["receipt"].update(**{"pass": True}))
        self.refused("run-2 receipt ignoredTotal=0", mutate=lambda m: m["receipt"].update(ignoredTotal=0))
        self.refused("lacks phase line '## node-safedb OK'", mutate=lambda m: m.update(out2=m["out2"].replace("## node-safedb OK\n", "")))
        self.refused("does not name the pinned CLI binary", mutate=lambda m: m.update(out2=m["out2"].replace(BINSHA, "ef" * 32)))
        self.refused("run-2 log set differs", after=lambda d: (d / "l/extra.test.out").write_text("test result: ok. 1 passed; 0 failed; 0 ignored;"))

    def test_the_single_ignored_test_must_be_exactly_the_annotated_child(self):
        self.refused("ignored set is not exactly the child", mutate=lambda m: m["logs"].update({"cli.test.out": m["logs"]["cli.test.out"].replace(f"test {NAMES[3]} ... ok", f"test {NAMES[3]} ... ignored")}))
        self.refused("annotation differs", mutate=lambda m: m["logs"].update({"cli.test.out": m["logs"]["cli.test.out"].replace(NOTE, "flaky")}))
        self.refused("node.test.out reports ignored tests", mutate=lambda m: m["logs"].update({"node.test.out": m["logs"]["node.test.out"].replace("0 ignored", "1 ignored")}))

    def test_the_pinned_binary_and_source_must_be_the_ones_executed(self):
        self.refused("binarySha256After", mutate=lambda m: m["launcher"].update(binarySha256After="00" * 32))
        self.refused("executedCopySha256", mutate=lambda m: m["launcher"].update(executedCopySha256="00" * 32))
        self.refused("source sha256", mutate=lambda m: m["launcher"].update(sourceSha256="00" * 32))
        self.refused("results.json ran another binary", mutate=lambda m: m.update(resultsBinary="00" * 32))
        self.refused("supplement unit exit", mutate=lambda m: m["launcher"].update(unitExit=1))

    def _set_run(self, m, label, stdout=None, **fields):
        r = next(x for x in m["runs"] if x["label"] == label)
        if stdout is not None:
            m["files"][label] = (stdout.encode(), b""); r["stdoutSha256"] = sha(stdout.encode())
        r.update(fields)

    def test_zero_test_multi_test_ignored_and_wrong_name_runs_are_refused(self):
        self.refused("not exactly one test ran", mutate=lambda m: self._set_run(m, "case-07", stdout=f"\nrunning 0 tests\n\ntest result: ok. 0 passed; 0 failed; 0 ignored; 0 measured; {TOTAL} filtered out; finished in 0.00s\n"))
        self.refused("case-08: test line", mutate=lambda m: self._set_run(m, "case-08", stdout=OK1(NAMES[9])))
        self.refused("child-key_path: result line differs", mutate=lambda m: self._set_run(m, "child-key_path",
            stdout=f"\nrunning 1 test\ntest {CHILD} ... ok\n\ntest result: ok. 1 passed; 0 failed; 1 ignored; 0 measured; {TOTAL - 1} filtered out; finished in 0.01s\n"))
        self.refused("case-02: rc", mutate=lambda m: self._set_run(m, "case-02", rc=101))
        self.refused("case-03: timed out", mutate=lambda m: self._set_run(m, "case-03", timedOut=True))
        self.refused("saved output differs from its recorded hash", after=lambda d: (d / "s/case-04.stdout").write_text(OK1(NAMES[3]) + "x"))

    def test_child_runs_need_the_original_case_env_and_argv(self):
        self.refused("child-remote_endpoint: env is not the original case's", mutate=lambda m: self._set_run(m, "child-remote_endpoint",
            envValueSha256={"BASE_NODE_P2P_SIGNER_ENDPOINT": sha(b"http://localhost:8080")}, envKeys=BASEK + ["BASE_NODE_P2P_SIGNER_ENDPOINT"]))
        self.refused("child-raw_key: env is not the original case's", mutate=lambda m: self._set_run(m, "child-raw_key", envValueSha256={"BASE_NODE_P2P_SEQUENCER_KEY": "00" * 32}))
        self.refused("argv differs from the original wrapper's", mutate=lambda m: self._set_run(m, "child-key_path", argv=[CHILD, "--ignored"]))
        self.refused("case-05: signer variables present", mutate=lambda m: self._set_run(m, "case-05", envKeys=BASEK + ["BASE_NODE_P2P_SEQUENCER_KEY"]))
        self.refused("runs differ from the pinned", mutate=lambda m: m["runs"].pop(46))

    def test_the_control_must_fail_exactly_by_its_assertion(self):
        self.refused("control: did not fail EXACTLY", mutate=lambda m: self._set_run(m, "control-no-env",
            stdout=CONTROL.replace("assertion failed: args.validate_sequencer_key().is_ok()", "called `Option::unwrap()` on a `None` value")))
        self.refused("control-no-env: rc", mutate=lambda m: self._set_run(m, "control-no-env", stdout=OK1(CHILD), rc=0))
        self.refused("control-no-env: rc", mutate=lambda m: self._set_run(m, "control-no-env", rc=2))
        self.refused("control: did not fail EXACTLY", mutate=lambda m: self._set_run(m, "control-no-env", stdout=CONTROL.replace("crates/consensus/cli/src/node.rs", "src/other.rs")))


if __name__ == "__main__":
    unittest.main(verbosity=2)
