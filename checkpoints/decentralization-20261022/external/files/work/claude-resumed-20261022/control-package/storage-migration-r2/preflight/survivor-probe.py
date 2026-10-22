#!/usr/bin/env python3
"""Focused check of the 2 evaluator mutants that SURVIVED the (interrupted) mutation run mutants-r2-2.
It is not a mutation campaign: each survivor is patched in memory (no file is modified) and compared with the pinned
evaluator over every combination of the 4 inputs it touches. The question: can either survivor ever produce READY where
the pinned evaluator does not?
  - 4 inputs: disk free, disk total, state du, db size;
  - values per input: 0, 1, the green value, huge, invalid tokens, empty;
  - statuses: ok and failed.
Prints every verdict difference class; exit 0 iff no survivor creates a READY that the pinned evaluator refuses."""
import collections, importlib.util, itertools, json, pathlib, sys
H = pathlib.Path(__file__).resolve().parent
SRC = (H / "evaluate-preflight.py").read_text()
SURVIVORS = {
    "undecidable disk check passes (r1 except: pass)": ('else: unknown.append("backup capacity not decidable', 'else: notes.append("backup capacity not decidable'),
    "zero disk total accepted": ('if g("disk.var_lib_total_bytes") == 0:', 'if False:'),
}
def load(src, name):
    s = importlib.util.spec_from_loader(name, loader=None); m = importlib.util.module_from_spec(s); exec(compile(src, name, "exec"), m.__dict__); return m
_s = importlib.util.spec_from_file_location("t", H / "test_evaluate.py"); T = importlib.util.module_from_spec(_s); _s.loader.exec_module(T)   # fixture builder only
P = load(SRC, "pinned")
VALS = ["0", "1", "29832895", "561190789", str(59 << 30), str(63 << 30), str(1 << 62), "-1", "1.0", "abc", ""]
KEYS = ["disk.var_lib_free_bytes", "disk.var_lib_total_bytes", "state.du_bytes", "db.size_bytes"]
def cap(vals, status): return T.capture(dict(zip(KEYS, vals)), status=status)
rc = 0
for what, (old, new) in SURVIVORS.items():
    assert SRC.count(old) == 1, what
    M = load(SRC.replace(old, new), "mutant")
    diffs, false_ready, n = collections.Counter(), [], 0
    for vals in itertools.product(VALS, repeat=4):
        for failed in (None,) + tuple(KEYS):
            status = {failed: "rc:1"} if failed else {}
            text = cap(vals, status)
            a = P.evaluate(*P.parse(text))["verdict"]; b = M.evaluate(*M.parse(text))["verdict"]; n += 1
            if a != b: diffs[f"{a} -> {b}"] += 1
            if b == "READY_FOR_FRESH_BACKUP" and a != b: false_ready.append(dict(zip(KEYS, vals), failed=failed))
    print(json.dumps({"survivor": what, "inputs": n, "verdictDifferences": dict(diffs), "mutantOnlyReady": len(false_ready), "examples": false_ready[:3]}))
    rc |= bool(false_ready)
sys.exit(rc)
