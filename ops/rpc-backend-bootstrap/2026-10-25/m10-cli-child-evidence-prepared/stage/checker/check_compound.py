#!/usr/bin/env python3
"""check_compound.py --pins P --run2-receipts DIR --run2-logs DIR --supplement DIR --launcher FILE
Fail-closed COMPOUND verdict for M10 run 2. Prints a JSON receipt; exit 0 ONLY if every condition holds.

It never edits or reinterprets the original receipt. run-2.receipt.json must still say pass:false with ignoredTotal 1,
byte-identical to its pin. Compound acceptance is NOT a blanket "ignored tests are fine" rule. It requires ALL of:
  A. run 2 itself: run-2.receipt.json/.out/.rc and all 8 phase logs byte-identical to their pins; the receipt fields exactly
     as pinned (systemd exit 0, '## aggregate rc=0', 8 result lines, ignoredTotal 1, pass false); run-2.out has every
     one of the 8 phase verdict lines + the aggregate line, and names the pinned CLI binary sha256;
  B. the ignored total of 1 is exactly the CLI child: cli.test.out has 45 ok (the pinned names), ONE ignored line equal to
     '<child> ... ignored, <annotation>', and '45 passed; 0 failed; 1 ignored'; every other phase log reports 0 ignored;
  C. the supplement ran the PINNED binary: launcher before/after sha256 of the original path and the executed copy all
     equal the pin; unit exit 0; source sha256 equals the reviewed node.rs pin;
  D. each of the 45 non-ignored cases ran ALONE and passed: 'running 1 test', exactly one test line '<name> ... ok',
     'test result: ok. 1 passed; 0 failed; 0 ignored; 0 measured; <total-1> filtered out', rc 0, no timeout;
  E. the child ran three times (raw_key, key_path, remote_endpoint), each with the original case's env keys and value
     hashes, and passed the same way, with 0 ignored;
  F. the no-env NEGATIVE CONTROL failed EXACTLY by its own assertion: rc 101, 'running 1 test', '<child> ... FAILED',
     '0 passed; 1 failed; 0 ignored', and the panic text 'assertion failed: args.validate_sequencer_key().is_ok()'
     inside node.rs. Any other failure (parse error, crash, timeout, other panic) is INVALID, not a kill;
  G. results.json lists exactly these 49 runs in order, and every saved stdout/stderr matches its recorded sha256.
"""
import argparse, hashlib, json, pathlib, re, sys

ap = argparse.ArgumentParser()
for a in ("--pins", "--run2-receipts", "--run2-logs", "--supplement", "--launcher"): ap.add_argument(a, required=True)
a = ap.parse_args()
P = json.load(open(a.pins)); C = P["cases"]; R2 = P["run2"]
rec_d, log_d, sup = pathlib.Path(a.run2_receipts), pathlib.Path(a.run2_logs), pathlib.Path(a.supplement)
fails = []
sha = lambda b: hashlib.sha256(b).hexdigest()
def need(cond, why):
    if not cond: fails.append(why)
    return cond
def read(p):
    try: return p.read_bytes()
    except OSError: fails.append(f"missing {p}"); return b""

# ---- A: run 2 pinned, its own failure preserved ----------------------------------------------------------------------
for f, want in R2["receipts"].items(): need(sha(read(rec_d / f)) == want, f"run-2 {f} differs from its pin")
for f, want in R2["logs"].items(): need(sha(read(log_d / f)) == want, f"run-2 log {f} differs from its pin")
need(sorted(x.name for x in log_d.glob("*.test.out")) == sorted(R2["logs"]), "run-2 log set differs from the 8 pinned logs")
try: rcpt = json.loads(read(rec_d / "run-2.receipt.json") or b"{}")
except ValueError: rcpt = {}; fails.append("run-2.receipt.json is not JSON")
for k, v in R2["expectedReceipt"].items(): need(rcpt.get(k) == v, f"run-2 receipt {k}={rcpt.get(k)!r}, pinned {v!r}")
out2 = read(rec_d / "run-2.out").decode(errors="replace").splitlines()
for line in R2["phaseLines"]: need(line in out2, f"run-2.out lacks phase line {line!r}")
need(f"## cli: REBUILT {pathlib.Path(P['binary']['path']).name} sha256 {P['binary']['sha256']}" in out2, "run-2.out does not name the pinned CLI binary")

# ---- B: the single ignored test is exactly the annotated CLI child ----------------------------------------------------
cli = read(log_d / "cli.test.out").decode(errors="replace")
need(re.findall(r"^test (\S+) \.\.\. ok$", cli, re.M) == C["nonIgnored"], "cli.test.out ok set/order differs from the pinned 45")
need(re.findall(r"^test (\S+) \.\.\. ignored.*$", cli, re.M) == [C["child"]], "cli.test.out ignored set is not exactly the child")
need(f"test {C['child']} ... ignored, {C['ignoreAnnotation']}" in cli.splitlines(), "child ignore annotation differs")
need(re.findall(r"^test result: ok\. 45 passed; 0 failed; 1 ignored; 0 measured; (\d+) filtered out;", cli, re.M) == [str(C["totalTestsInBinary"] - 46)], "cli result line differs")
ign = 0
for f in R2["logs"]:
    for m in re.finditer(r"^test result: .* (\d+) ignored;", read(log_d / f).decode(errors="replace"), re.M):
        ign += int(m.group(1)); need(f == "cli.test.out" or m.group(1) == "0", f"{f} reports ignored tests")
need(ign == 1, f"total ignored across run-2 logs is {ign}, not 1")

# ---- C: the supplement ran the pinned binary over the reviewed source -------------------------------------------------
try: L = json.loads(read(pathlib.Path(a.launcher)) or b"{}")
except ValueError: L = {}; fails.append("launcher receipt is not JSON")
for k in ("binarySha256Before", "binarySha256After", "executedCopySha256", "executedCopySha256After"):
    need(L.get(k) == P["binary"]["sha256"], f"launcher {k}={L.get(k)!r} is not the pinned binary")
need(L.get("sourceSha256") == P["source"]["sha256"], "launcher source sha256 is not the reviewed node.rs pin")
need(L.get("unitExit") == 0, f"supplement unit exit {L.get('unitExit')!r}")

# ---- D-G: the supplement's own runs ---------------------------------------------------------------------------------
try: res = json.loads(read(sup / "results.json") or b"{}")
except ValueError: res = {}; fails.append("results.json is not JSON")
need(res.get("binarySha256") == P["binary"]["sha256"], "results.json ran another binary")
runs = res.get("runs") or []
want = ([("nonIgnored", n) for n in C["nonIgnored"]] + [("child", C["child"])] * len(C["childEnvCases"]) + [("control", C["child"])])
need([(r.get("kind"), r.get("name")) for r in runs] == want, f"results.json runs differ from the pinned {len(want)} (kind,name) sequence")
FILTERED = C["totalTestsInBinary"] - 1
RES = re.compile(r"^test result: (ok|FAILED)\. (\d+) passed; (\d+) failed; (\d+) ignored; (\d+) measured; (\d+) filtered out; finished in [0-9.]+s$")
CASE_ENV_KEYS = {"raw_key": ["BASE_NODE_P2P_SEQUENCER_KEY"], "key_path": ["BASE_NODE_P2P_SEQUENCER_KEY_PATH"],
                 "remote_endpoint": ["BASE_NODE_P2P_SIGNER_ADDRESS", "BASE_NODE_P2P_SIGNER_ENDPOINT"]}
CASE_ENV_SHA = {"raw_key": {"BASE_NODE_P2P_SEQUENCER_KEY": P["fixtures"]["rawKeySha256"]},
                "key_path": {"BASE_NODE_P2P_SEQUENCER_KEY_PATH": sha(b"/tmp/key.hex")},
                "remote_endpoint": {"BASE_NODE_P2P_SIGNER_ENDPOINT": sha(b"http://localhost:8080"),
                                    "BASE_NODE_P2P_SIGNER_ADDRESS": sha(b"0xAf6E19BE0F9cE7f8afd49a1824851023A8249e8a")}}
SIGNER = {"BASE_NODE_P2P_SEQUENCER_KEY", "BASE_NODE_P2P_SEQUENCER_KEY_PATH", "BASE_NODE_P2P_SIGNER_ENDPOINT", "BASE_NODE_P2P_SIGNER_ADDRESS"}
summary = {"nonIgnoredPassed": 0, "childPassed": 0, "controlKilledByAssertion": False}

def parse(r, expect):  # -> True if this run is exactly one test with the expected status/result
    lab = r.get("label", "?"); so_b, se_b = read(sup / f"{lab}.stdout"), read(sup / f"{lab}.stderr")
    ok = need(sha(so_b) == r.get("stdoutSha256") and sha(se_b) == r.get("stderrSha256"), f"{lab}: saved output differs from its recorded hash")
    ok &= need(r.get("timedOut") is False, f"{lab}: timed out")
    so = so_b.decode(errors="replace"); lines = so.splitlines()
    ok &= need([l for l in lines if re.match(r"^running \d+ tests?$", l)] == ["running 1 test"], f"{lab}: not exactly one test ran (zero-test or multi-test output refused)")
    tl = [l for l in lines if re.match(r"^test \S+ \.\.\. ", l)]
    ok &= need(tl == [f"test {r['name']} ... {'FAILED' if expect == 'fail' else 'ok'}"], f"{lab}: test line {tl!r}")
    rl = [RES.match(l) for l in lines if l.startswith("test result:")]
    good = len(rl) == 1 and rl[0] is not None
    if good:
        st, p_, f_, i_, m_, fo = rl[0].groups()
        good = (st, p_, f_, i_, m_, fo) == (("FAILED", "0", "1", "0", "0", str(FILTERED)) if expect == "fail" else ("ok", "1", "0", "0", "0", str(FILTERED)))
    ok &= need(good, f"{lab}: result line differs (needs exactly 1 {'failed' if expect == 'fail' else 'passed'}, 0 ignored, {FILTERED} filtered out)")
    ok &= need(r.get("rc") == (101 if expect == "fail" else 0), f"{lab}: rc {r.get('rc')!r}")
    return ok, so

for r in runs:
    keys = set(r.get("envKeys") or [])
    if r.get("kind") == "nonIgnored":
        need(not (keys & SIGNER), f"{r.get('label')}: signer variables present"); need(r.get("argv") == ["--exact", r.get("name")], f"{r.get('label')}: argv")
        if parse(r, "pass")[0]: summary["nonIgnoredPassed"] += 1
    elif r.get("kind") == "child":
        case = (r.get("label") or "").removeprefix("child-")
        need(case in CASE_ENV_KEYS and sorted(keys & SIGNER) == CASE_ENV_KEYS[case] and r.get("envValueSha256") == CASE_ENV_SHA[case],
             f"{r.get('label')}: env is not the original case's")
        need(r.get("argv") == ["--exact", C["child"], "--ignored"], f"{r.get('label')}: argv differs from the original wrapper's")
        if parse(r, "pass")[0]: summary["childPassed"] += 1
    elif r.get("kind") == "control":
        need(not (keys & SIGNER) and r.get("argv") == ["--exact", C["child"], "--ignored"], "control: env/argv")
        ok, so = parse(r, "fail")
        exact = ok and f"---- {C['child']} stdout ----" in so and "assertion failed: args.validate_sequencer_key().is_ok()" in so \
            and re.search(r"panicked at crates/consensus/cli/src/node\.rs:\d+:\d+:", so) is not None
        need(exact, "control: did not fail EXACTLY by the child's own assertion in node.rs (any other failure is INVALID)")
        summary["controlKilledByAssertion"] = exact
need(summary["nonIgnoredPassed"] == len(C["nonIgnored"]) == 45, f"non-ignored passed {summary['nonIgnoredPassed']}/45")
need(summary["childPassed"] == 3, f"child passed {summary['childPassed']}/3")

ok = not fails
print(json.dumps({"format": "m10-cli-child-compound/v1", "originalReceiptPass": rcpt.get("pass"), "originalReceiptPreserved": True,
                  "compoundAccepted": ok, "basis": "run-2 pinned (8 phases + aggregate) + supplement (45 alone + child x3 + no-env control)",
                  "summary": summary, "failures": fails}, indent=1))
sys.exit(0 if ok else 1)
