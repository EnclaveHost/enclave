#!/usr/bin/env python3
"""CORRECTED-ASSERTION REPLAY on run l1's RETAINED evidence (no backend, no wasm, no test rerun). Loads ONLY fence_gen,
gen_matches and gen16 from interop16.py (fix-7) and applies them to l1's recorded /healthz ballot and indexd fence values,
plus negatives. runs/l1/results.json is read, never written; l1's original exit 1 / 32 PASS 1 FAIL stays as it was.
  replay_gen_l1.py <interop16.py> <runs/l1/results.json> <out.json (new)>     exit 0 = every expectation holds"""
import ast, hashlib, json, os, re, sys
src_path, res_path, out = sys.argv[1:4]
src = open(src_path).read()
want_fns = {"fence_gen", "gen_matches", "gen16"}
mod = ast.Module(body=[n for n in ast.parse(src).body if isinstance(n, ast.FunctionDef) and n.name in want_fns]
                 + [n for n in ast.parse(src).body if isinstance(n, ast.Assign) and any(getattr(t, "id", "") in ("GEN_LEASE16", "GEN_SHIFT") or
                    (isinstance(t, ast.Tuple) and any(getattr(e, "id", "") in ("GEN_LEASE16", "GEN_SHIFT") for e in t.elts)) for t in n.targets)], type_ignores=[])
g = {"re": re}
exec(compile(mod, "interop16-functions", "exec"), g)
assert want_fns <= set(g), "functions missing from interop16.py"
fence_gen, gen_matches, gen16 = g["fence_gen"], g["gen_matches"], g["gen16"]
d = json.load(open(res_path))
C1, C2 = (52515800, 3), (52520000, 0)
G1, G2 = gen16(*C1), gen16(*C2)
ballot1 = d["healthzClaim1"]["writerFence"]["ballot"]["gen"]
db = d["db"]
cases = []


def case(name, got, expect):
    cases.append({"name": name, "got": got, "expect": expect, "ok": got == expect})


# positives: every retained l1 generation value under the corrected assertion
case("healthz claim-1 ballot gen (unpadded) == lease16 gen 1", gen_matches(ballot1, G1), True)
for k, G in (("afterEnrollment", G1), ("afterRestart", G1), ("afterClaim2", G2), ("beforeStale", G2), ("afterStale", G2), ("beforeOld", G2), ("afterOld", G2)):
    case(f"indexd fence generation {k} ({db[k]['fenceGeneration']}) == expected", gen_matches(db[k]["fenceGeneration"], G), True)
case("healthz ballot == indexd installed fence prefix (same integer, different padding)",
     fence_gen(ballot1) is not None and fence_gen(ballot1) == fence_gen(db["afterEnrollment"]["fenceGeneration"]) and ballot1 != db["afterEnrollment"]["fenceGeneration"], True)
case("generation rule: G1 == 0x10032153d80003, G2 == 0x10032164400000", (G1, G2) == (0x10032153d80003, 0x10032164400000), True)
# negatives: wrong generation
case("claim-1 ballot vs claim-2 generation", gen_matches(ballot1, G2), False)
case("claim-2 DB fence vs claim-1 generation", gen_matches(db["afterClaim2"]["fenceGeneration"], G1), False)
case("off by one", gen_matches(ballot1, G1 + 1), False)
case("other log index (52515800/4)", gen_matches(ballot1, gen16(52515800, 4)), False)
case("lease17-ranked generation for the same claim bits", gen_matches(ballot1, (17 << 48) | (52515800 << 16) | 3), False)
case("want not an int ('0x10032153d80003' string)", gen_matches(ballot1, "0x10032153d80003"), False)
# negatives: malformed shapes (each must be refused, never coerced)
for bad in ["10032153d80003", "0x", "0xZZ", "0x" + "1" * 17, "0x8000000000000000", " 0x10032153d80003", "0x10032153d80003 ",
            "-0x1", "0x1_0", "0X10032153d80003", "0x+1", "", None, G1, True, 1.5, ["0x1"]]:
    case(f"malformed {bad!r:.40} refused", fence_gen(bad), None)
case("max allowed 0x7fffffffffffffff parses", fence_gen("0x7fffffffffffffff"), (1 << 63) - 1)
ok = all(c["ok"] for c in cases)
res = {"kind": "corrected-assertion replay on retained l1 evidence (NOT a test rerun; l1 original stays exit 1, 32 PASS / 1 FAIL)",
       "interop16Sha256": hashlib.sha256(src.encode()).hexdigest(), "l1ResultsSha256": hashlib.sha256(open(res_path, "rb").read()).hexdigest(),
       "l1Original": {"passed": d["passed"], "failed": d["failed"], "failedChecks": [c["name"] for c in d["checks"] if not c["ok"]]},
       "cases": cases, "positives": sum(1 for c in cases if c["expect"] is True), "negatives": sum(1 for c in cases if c["expect"] in (False, None)),
       "allExpectationsHold": ok}
fd = os.open(out, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o644)
os.write(fd, (json.dumps(res, indent=1, default=str) + "\n").encode()); os.close(fd)
print(json.dumps({"cases": len(cases), "failedCases": [c["name"] for c in cases if not c["ok"]], "allExpectationsHold": ok}))
sys.exit(0 if ok else 1)
