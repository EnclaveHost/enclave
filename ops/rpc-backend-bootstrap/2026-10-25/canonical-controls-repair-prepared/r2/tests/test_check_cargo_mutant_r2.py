#!/usr/bin/env python3
"""r2 parser controls for jobs/check_cargo_mutant_r2.py (PREPARED; root runs them under the shared 256 MiB queue). Fixtures are
ACTUAL outputs: nff-* from the repaired --no-fail-fast run (mutants-20261026T001203Z: per-target footers + aggregate, with
their recorded cargo .rc), orig-* from the original runner (single footer, no --no-fail-fast). Expected exit: 0 KILLED,
1 NOT KILLED, 3 INVALID; stderr must be empty. A pass proves the PARSER only."""
import hashlib, pathlib, subprocess, sys, tempfile
H = pathlib.Path(__file__).resolve().parents[1]; F = H / "fixtures"; CHK = H / "jobs/check_cargo_mutant_r2.py"
CTL = pathlib.Path("/home/steven/Documents/Codex/2026-10-18/wo/work/rpc-production-final-20261025/verifier-canonical-stage/EXPECTED-CONTROLS.txt")
assert hashlib.sha256(CTL.read_bytes()).hexdigest() == "b0409b8a248cf204683d41a90d97a53102470dcaa0527c54314263ffa5bd3a1d"
assert subprocess.run(["sha256sum", "-c", "--quiet", "FIXTURES.sha256"], cwd=F).returncode == 0, "fixtures changed"
rd = lambda n: (F / n).read_text()
M1, M3, M7, O1 = rd("nff-M1-gate-ignores-require-canonical.out"), rd("nff-M3-gate-no-head-age.out"), rd("nff-M7-cache-no-descendant-drop.out"), rd("orig-M1-gate-ignores-require-canonical.out")
RC = {k: int(rd(f"nff-{k}.rc")) for k in ("M1-gate-ignores-require-canonical", "M3-gate-no-head-age", "M7-cache-no-descendant-drop")}
GATE, NODE, CACHE = "--test canonical_block_gate", "--test node_canonical_methods", "--test block_cache_exact_hash"
N1 = ["gate_true_on_known_noncanonical_refuses_not_canonical", "gate_root_counterexample_retained_descendant_refused", "gate_other_branch_below_head_refused_by_ancestry"]
N3 = ["gate_true_stale_head_refuses_false_passes", "node_stale_head_refuses_true_only"]
N7 = ["multi_height_reorg_drops_stale_descendants", "finalized_conflict_drops_unsafe_branch_and_clears_latest", "block_cache_root_counterexample_refused", "node_root_counterexample_retained_descendant_refused"]
PTG = "error: test failed, to rerun pass `-p helios-core --test canonical_block_gate`"
PTN = "error: test failed, to rerun pass `-p helios-core --test node_canonical_methods`"
AG2 = "error: 2 targets failed:\n    `-p helios-core --test canonical_block_gate`\n    `-p helios-core --test node_canonical_methods`"
fails = 0
def case(name, want, text, rc, bins, names):
    global fails
    with tempfile.NamedTemporaryFile("w", suffix=".out", delete=False) as f: f.write(text); p = f.name
    r = subprocess.run([sys.executable, "-I", str(CHK), "--out", p, "--rc", str(rc), "--controls", str(CTL), "--bins", bins, *names], capture_output=True, text=True)
    pathlib.Path(p).unlink(); ok = r.returncode == want and r.stderr == ""; fails += not ok
    print(("[ok] " if ok else "[FAIL] ") + f"{name}: exit {r.returncode} (want {want}) {(r.stdout.strip().splitlines() or [''])[0][:110]}", flush=True)
# actual outputs with their recorded cargo exit codes
assert RC == {"M1-gate-ignores-require-canonical": 101, "M3-gate-no-head-age": 101, "M7-cache-no-descendant-drop": 101}, RC
case("A1 actual --no-fail-fast M1 (per-target + '1 target failed') KILLED", 0, M1, RC["M1-gate-ignores-require-canonical"], GATE, N1)
case("A2 actual --no-fail-fast M3 (2 per-target + '2 targets failed') KILLED", 0, M3, RC["M3-gate-no-head-age"], f"{GATE} {NODE}", N3)
case("A3 actual --no-fail-fast M7 (3 binaries) KILLED", 0, M7, RC["M7-cache-no-descendant-drop"], f"{CACHE} {GATE} {NODE}", N7)
case("A4 actual ORIGINAL single-footer M1 (no --no-fail-fast) KILLED", 0, O1, 101, GATE, N1)
case("A5 actual M3 judged against one binary only (extra binary ran) INVALID", 3, M3, 101, GATE, N3[:1])
# per-target / aggregate mismatches
case("X1 per-target footer missing (M3 gate)", 3, M3.replace(PTG + "\n", "", 1), 101, f"{GATE} {NODE}", N3)
case("X2 per-target footer duplicated (M3 node)", 3, M3.replace(PTN, PTN + "\n" + PTN, 1), 101, f"{GATE} {NODE}", N3)
case("X3 per-target footer wrong target", 3, M3.replace(PTN, PTG, 1), 101, f"{GATE} {NODE}", N3)
case("X4 aggregate missing with 2 failed binaries", 3, M3.replace(AG2, ""), 101, f"{GATE} {NODE}", N3)
case("X5 aggregate count mismatch (says 3)", 3, M3.replace("error: 2 targets failed:", "error: 3 targets failed:"), 101, f"{GATE} {NODE}", N3)
case("X6 aggregate lists one target only", 3, M3.replace(AG2, "error: 1 target failed:\n    `-p helios-core --test canonical_block_gate`"), 101, f"{GATE} {NODE}", N3)
case("X7 aggregate target order swapped", 3, M3.replace(AG2, "error: 2 targets failed:\n    `-p helios-core --test node_canonical_methods`\n    `-p helios-core --test canonical_block_gate`"), 101, f"{GATE} {NODE}", N3)
case("X8 aggregate duplicated", 3, M3.rstrip("\n") + "\n" + AG2 + "\n", 101, f"{GATE} {NODE}", N3)
case("X9 trailing non-blank line after aggregate", 3, M3.rstrip("\n") + "\nsomething\n", 101, f"{GATE} {NODE}", N3)
case("X10 aggregate before the last per-target footer", 3, M3.replace(PTN + "\n" + AG2, AG2 + "\n" + PTN), 101, f"{GATE} {NODE}", N3)
case("X11 per-target footer for a PASSING binary", 3, M1.replace(PTG, PTG + "\n" + PTN), 101, GATE, N1)
case("X12 arbitrary extra error line", 3, M3.replace(AG2, "error: something else\n" + AG2), 101, f"{GATE} {NODE}", N3)
case("X13 compiler error E-code", 3, M1.replace(PTG, "error[E0599]: no method named `x`\n" + PTG), 101, GATE, N1)
case("X14 error without code (could not compile)", 3, M1.rstrip("\n") + "\nerror: could not compile `helios-core`\n", 101, GATE, N1)
case("X15 non-blank line between summary and per-target footer", 3, M1.replace("\n" + PTG, "\nnoise\n" + PTG, 1), 101, GATE, N1)
case("X16 single footer without aggregate but trailing text", 3, O1.rstrip("\n") + "\nextra\n", 101, GATE, N1)
# exit code / counts / binaries / named tests stay strict
for rc in (0, 1, 2, 124, 137): case(f"R{rc} actual M3 with cargo exit {rc} INVALID", 3, M3, rc, f"{GATE} {NODE}", N3)
case("S1 ignored summary count INVALID", 3, M3.replace("1 failed; 0 ignored", "1 failed; 1 ignored", 1), 101, f"{GATE} {NODE}", N3)
case("S2 filtered summary INVALID", 3, M3.replace("0 measured; 0 filtered out", "0 measured; 2 filtered out", 1), 101, f"{GATE} {NODE}", N3)
case("S3 requested binary missing INVALID", 3, M1, 101, f"{GATE} {NODE}", N1)
def nopanic(t, n):   # only the named test's own thread line loses 'panicked at'
    return "\n".join(l.replace("panicked at", "stopped at") if l.startswith(f"thread '{n}' ") else l for l in t.split("\n"))
assert nopanic(M1, N1[0]) != M1
case("S4 named test panic missing INVALID", 3, nopanic(M1, N1[0]), 101, GATE, N1)
case("S5 named test line missing INVALID", 3, "\n".join(l for l in M1.splitlines() if l != f"test {N1[0]} ... FAILED") + "\n", 101, GATE, N1)
case("S6 named test that passed NOT KILLED", 1, M1, 101, GATE, ["gate_true_on_canonical_block_passes"])
print(f"## r2 parser controls failed={fails}"); sys.exit(1 if fails else 0)
