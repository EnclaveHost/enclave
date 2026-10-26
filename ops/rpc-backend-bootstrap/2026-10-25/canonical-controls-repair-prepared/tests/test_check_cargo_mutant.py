#!/usr/bin/env python3
"""Parser controls for jobs/check_cargo_mutant.py (PREPARED; root runs them under the shared 256 MiB queue). Uses the ACTUAL
outputs of root-canonical-mutants-0006 (fixtures/actual-*.out, copied byte-exact; FIXTURES.sha256) plus synthetic variants.
Expected exit: 0 KILLED, 1 NOT KILLED, 3 INVALID. A pass proves the PARSER; no mutant verdict is claimed from it."""
import hashlib, pathlib, subprocess, sys, tempfile
H = pathlib.Path(__file__).resolve().parents[1]; F = H / "fixtures"; CHK = H / "jobs/check_cargo_mutant.py"
CTL = pathlib.Path("/home/steven/Documents/Codex/2026-10-18/wo/work/rpc-production-final-20261025/verifier-canonical-stage/EXPECTED-CONTROLS.txt")
assert hashlib.sha256(CTL.read_bytes()).hexdigest() == "b0409b8a248cf204683d41a90d97a53102470dcaa0527c54314263ffa5bd3a1d", "EXPECTED-CONTROLS changed"
assert subprocess.run(["sha256sum", "-c", "--quiet", "FIXTURES.sha256"], cwd=F).returncode == 0, "fixtures changed"
M1 = (F / "actual-M1-gate-ignores-require-canonical.out").read_text(); M3 = (F / "actual-M3-gate-no-head-age.out").read_text()
M4 = (F / "actual-M4-cache-stale-index.out").read_text(); I1 = (F / "actual-I1-cache-filter-only-removed.out").read_text()
I2 = (F / "actual-I2-cache-unindex-only-removed.out").read_text()
GATE, NODE, CACHE = "--test canonical_block_gate", "--test node_canonical_methods", "--test block_cache_exact_hash"
N_M1 = ["gate_true_on_known_noncanonical_refuses_not_canonical", "gate_root_counterexample_retained_descendant_refused", "gate_other_branch_below_head_refused_by_ancestry"]
N_M3 = ["gate_true_stale_head_refuses_false_passes", "node_stale_head_refuses_true_only"]
N_M4 = ["reorg_a_to_b_unindexes_a", "aba_resolves_only_the_current_block", "multi_height_reorg_drops_stale_descendants"]
FOOT1 = "error: test failed, to rerun pass `-p helios-core --test canonical_block_gate`"
NODE_SEC = ("     Running tests/node_canonical_methods.rs (/x/target/debug/deps/node_canonical_methods-0)\n\nrunning 2 tests\n"
            "test node_stale_head_refuses_true_only ... FAILED\ntest node_unknown_hash_refused_for_every_method ... ok\n\nfailures:\n\n"
            "---- node_stale_head_refuses_true_only stdout ----\n\nthread 'node_stale_head_refuses_true_only' (1) panicked at core/tests/node_canonical_methods.rs:9:5:\nassertion failed\n\n"
            "failures:\n    node_stale_head_refuses_true_only\n\ntest result: FAILED. 1 passed; 1 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.01s\n\n")
def gate_only(t): return t[:t.index(FOOT1)]          # the M1/M3 gate section without its footer
fails = 0
def case(name, want, text, rc, bins, names):
    global fails
    with tempfile.NamedTemporaryFile("w", suffix=".out", delete=False) as f: f.write(text); p = f.name
    r = subprocess.run([sys.executable, "-I", str(CHK), "--out", p, "--rc", str(rc), "--controls", str(CTL), "--bins", bins, *names], capture_output=True, text=True)
    pathlib.Path(p).unlink(); ok = r.returncode == want and r.stderr == ""; fails += not ok
    print(("[ok] " if ok else "[FAIL] ") + f"{name}: exit {r.returncode} (want {want}) {r.stdout.strip().splitlines()[0][:110] if r.stdout.strip() else ''}", flush=True)
# ACTUAL outputs
case("A1 actual M1 (single binary, ordinary footer) is KILLED", 0, M1, 101, GATE, N_M1)
case("A2 actual M4 is KILLED", 0, M4, 101, CACHE, N_M4)
case("A3 actual M3 (no --no-fail-fast: node binary never ran) is INVALID", 3, M3, 101, f"{GATE} {NODE}", N_M3)
case("A4 actual I1 (all ok, exit 0) is NOT KILLED", 1, I1, 0, CACHE, ["reorg_a_to_b_unindexes_a"])
case("A5 actual I2 (named test ok, others failed) is NOT KILLED", 1, I2, 101, CACHE, ["reorg_a_to_b_unindexes_a"])
# exact cargo exit handling
for rc in (124, 137, 143, 1, 2): case(f"E{rc} actual M1 with cargo exit {rc} is INVALID", 3, M1, rc, GATE, N_M1)
case("E0 actual M1 content but exit 0 is INVALID", 3, M1, 0, GATE, N_M1)
case("E101 actual I1 (nothing failed) with exit 101 is INVALID", 3, I1, 101, CACHE, ["reorg_a_to_b_unindexes_a"])
# compiler / arbitrary errors
case("C1 compiler error E-code is INVALID", 3, M1.replace(FOOT1, "error[E0425]: cannot find value `x` in this scope\n" + FOOT1), 101, GATE, N_M1)
case("C2 error without code (could not compile) is INVALID", 3, M1 + "error: could not compile `helios-core` (test \"x\") due to 1 previous error\n", 101, GATE, N_M1)
case("C3 arbitrary footer is INVALID", 3, M1.replace(FOOT1, "error: test failed, something else"), 101, GATE, N_M1)
case("C4 footer naming another target is INVALID", 3, M1.replace(FOOT1, "error: test failed, to rerun pass `-p helios-core --test node_canonical_methods`"), 101, GATE, N_M1)
case("C5 missing footer with exit 101 is INVALID", 3, M1.replace(FOOT1, ""), 101, GATE, N_M1)
# --no-fail-fast footers (cargo 1.96 strings: '1 target failed:' / ' targets failed:')
case("F1 '1 target failed:' footer is KILLED", 0, gate_only(M1) + "error: 1 target failed:\n    `-p helios-core --test canonical_block_gate`\n", 101, GATE, N_M1)
two = gate_only(M3) + NODE_SEC + "error: 2 targets failed:\n    `-p helios-core --test canonical_block_gate`\n    `-p helios-core --test node_canonical_methods`\n"
case("F2 two binaries, '2 targets failed:' footer is KILLED", 0, two, 101, f"{GATE} {NODE}", N_M3)
case("F3 '2 targets failed' listing only one is INVALID", 3, two.replace("    `-p helios-core --test node_canonical_methods`\n", ""), 101, f"{GATE} {NODE}", N_M3)
case("F4 trailing text after the footer list is INVALID", 3, two + "extra\n", 101, f"{GATE} {NODE}", N_M3)
# panic / test / ignored / filtered / binary refusals
nm = N_M1[0]
case("P1 a named test FAILED without its panic is INVALID", 3, M1.replace(f"thread '{nm}'", "thread 'x'").replace(f"thread 'x' (257405) panicked at", "thread 'x' (257405) stopped at"), 101, GATE, N_M1)
case("P2 a named test missing is INVALID", 3, "\n".join(l for l in M1.splitlines() if l != f"test {nm} ... FAILED") + "\n", 101, GATE, N_M1)
case("P3 an ignored test is INVALID", 3, M1.replace("test gate_never_uses_height_lookup ... ok", "test gate_never_uses_height_lookup ... ignored"), 101, GATE, N_M1)
case("P4 a filtered summary is INVALID", 3, M1.replace("0 measured; 0 filtered out", "0 measured; 3 filtered out"), 101, GATE, N_M1)
case("P5 an ignored summary count is INVALID", 3, M1.replace("7 failed; 0 ignored", "7 failed; 1 ignored"), 101, GATE, N_M1)
case("B1 a requested binary missing is INVALID", 3, M1, 101, f"{GATE} {NODE}", N_M1)
case("B2 a binary ran twice is INVALID", 3, gate_only(M1) + gate_only(M1) + FOOT1 + "\n", 101, GATE, N_M1)
case("B3 a name whose binary was not requested is INVALID", 3, M1, 101, GATE, N_M1 + ["node_stale_head_refuses_true_only"])
case("B4 a name not in EXPECTED-CONTROLS is INVALID", 3, M1, 101, GATE, N_M1 + ["no_such_test"])
case("B5 a named test that passed in a failing run is NOT KILLED", 1, M1, 101, GATE, ["gate_true_on_canonical_block_passes"])
print(f"## parser controls failed={fails}"); sys.exit(1 if fails else 0)
