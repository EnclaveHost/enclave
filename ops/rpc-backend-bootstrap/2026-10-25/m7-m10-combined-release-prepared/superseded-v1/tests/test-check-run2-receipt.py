#!/usr/bin/env python3
"""Deterministic refusal tests of bundle/runner/check-run2-receipt.py on SYNTHETIC fixtures (PREPARED; root runs them, e.g.
under the shared 256 MiB queue). The positive fixture is synthetic: it proves the gate's logic, NOT that run 2 passed."""
import hashlib, json, subprocess, sys, tempfile
from pathlib import Path
G = Path(__file__).resolve().parent.parent / "bundle/runner/check-run2-receipt.py"
SET_E = "precondition_refuses_replayed_snapshot_labels_above_n precondition_refuses_wrong_number_wrong_hash_and_rpc_claimed_hash"
SET_N = "a_failing_reset_is_fatal real_redb_wipe_removes_snapshot_entries_persistently"
def good_out():
    h = lambda c: c * 64
    return "\n".join([
        "## toolchain rustc 1.96.0 (ac68faa20 2026-05-25) | cargo 1.96.0 (30a34c682 2026-05-25)",
        "## GUEST run 2 /srv/m10-guest-validation/runs/run-2: repair stage /srv/m10-guest-validation/stage-import-recovery, OLD stage /srv/m10-guest-validation/stage, ...",
        "## GUEST: reused cargo home satisfies every locked dependency offline: 1535 registry + 110 git; fsck True",
        f"## engine: REBUILT base_consensus_engine-x sha256 {h('a')}", "## engine OK",
        f"## node: REBUILT base_consensus_node-x sha256 {h('b')}", "## node OK", "## node-seq OK", "## node-safedb OK", "## node-derivation OK",
        f"## cli: REBUILT base_consensus_cli-x sha256 {h('c')}", "## cli OK",
        f"## control-engine: REBUILT base_consensus_engine-x sha256 {h('d')}", f"## control-engine rc=101 failing: {SET_E} ", "## control-engine failed exactly as expected",
        f"## control-node: REBUILT base_consensus_node-x sha256 {h('e')}", f"## control-node rc=101 failing: {SET_N} ", "## control-node failed exactly as expected",
        "## aggregate rc=0", "[disk-guard] exit=0 childExit=0 minFreeMiB=17000", "[memory-guard] exit=0 peakTreeRssMiB=5000 minHostAvailableMiB=48000"]) + "\n"
def receipt(out, **kw):
    r = {"attempt": 2, "systemdRunExit": 0, "unit": "Result=success", "stageManifestSha256": "1864c8526dd9487d5a07a12d311f8d887214fe85eed66eb9d9d8535e126b6d29",
         "outSha256": hashlib.sha256(out.encode()).hexdigest(), "aggregateLine": "## aggregate rc=0", "testResultLines": 8, "ignoredTotal": 0,
         "guardLines": ["[disk-guard] exit=0 childExit=0 minFreeMiB=17000", "[memory-guard] exit=0 peakTreeRssMiB=5000 minHostAvailableMiB=48000"], "pass": True}
    r.update(kw); return r
def run(d, out, rec, rc="0\n", pin=None, missing=None):
    files = {"r": d / "run-2.receipt.json", "o": d / "run-2.out", "c": d / "run-2.rc"}
    files["r"].write_text(rec if isinstance(rec, str) else json.dumps(rec)); files["o"].write_text(out); files["c"].write_text(rc)
    pins = [hashlib.sha256(files[k].read_bytes()).hexdigest() for k in "roc"]
    if pin: pins[pin[0]] = pin[1]
    if missing: files[missing].unlink()
    p = subprocess.run([sys.executable, "-I", str(G), str(files["r"]), str(files["o"]), str(files["c"]), *pins], capture_output=True, text=True)
    return p.returncode, (p.stdout + p.stderr).strip().splitlines()[-1] if (p.stdout + p.stderr).strip() else ""
fails = 0
def case(name, want_ok, got):
    global fails
    ok = (got[0] == 0) == want_ok; fails += not ok
    print(("[ok] " if ok else "[FAIL] ") + f"{name}: rc={got[0]} {got[1][:150]}")
with tempfile.TemporaryDirectory() as td:
    d = Path(td); o = good_out()
    case("valid synthetic receipt accepted", True, run(d, o, receipt(o)))
    case("missing receipt file", False, run(d, o, receipt(o), missing="r"))
    case("pin mismatch", False, run(d, o, receipt(o), pin=(1, "0" * 64)))
    case("malformed JSON", False, run(d, o, "{not json"))
    case("rc nonzero", False, run(d, o, receipt(o), rc="1\n"))
    case("attempt 1", False, run(d, o, receipt(o, attempt=1)))
    case("pass false", False, run(d, o, receipt(o, **{"pass": False})))
    case("Result=success but systemdRunExit 1", False, run(d, o, receipt(o, systemdRunExit=1)))
    case("ignored test", False, run(d, o, receipt(o, ignoredTotal=1)))
    case("only 7 test result lines", False, run(d, o, receipt(o, testResultLines=7)))
    case("wrong repair manifest", False, run(d, o, receipt(o, stageManifestSha256="f" * 64)))
    case("receipt bound to another out", False, run(d, o, receipt(o, outSha256="e" * 64)))
    case("guard not exit=0", False, run(d, o, receipt(o, guardLines=["[memory-guard] exit=99 STOPPED"])))
    b = o.replace("## node-safedb OK\n", ""); case("phase missing", False, run(d, b, receipt(b)))
    b = o.replace("## control-node failed exactly as expected\n", ""); case("control not exact", False, run(d, b, receipt(b)))
    b = o.replace(SET_N, "a_failing_reset_is_fatal"); case("control failing set differs", False, run(d, b, receipt(b)))
    b = o.replace("## aggregate rc=0", "## INVALID: x\n## aggregate rc=0"); case("INVALID line", False, run(d, b, receipt(b)))
    b = o.replace("sha256 " + "e" * 64, "sha256 " + "b" * 64); case("control binary == patched", False, run(d, b, receipt(b)))
    b = o.replace("## cli: REBUILT", "## cli: FRESH"); case("a build not REBUILT", False, run(d, b, receipt(b)))
print(f"## gate tests failed={fails}"); sys.exit(1 if fails else 0)
