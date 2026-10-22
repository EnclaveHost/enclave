#!/usr/bin/env python3
"""CORRECTED ADJUDICATION (pure, local, read-only) of ONE native acl-fixture v2 receipt. Never runs anything remote or native.

Why it exists: the v2 fixture (21d2bcf1) computes the 'inherited' term with
    -not @($ih.leftovers).Count
but Left() returns NO pipeline output when there is no temp left. That empty output is stored as $null, and in PowerShell
@($null).Count is 1. So the term is false even when nothing is left behind. The raw receipt's verdict is therefore false
and is PRESERVED as-is. This script re-decides the SAME v2 criteria from the captured observations, with strict typing:
  - a missing or ill-typed field is UNKNOWN, and it is never a pass;
  - leftovers count as empty only when the key is PRESENT with a value of null, {} or [];
  - Left() emits only file-name strings. {} is what the native Windows PowerShell 5.1 receipt shows for t2's empty
    hashtable-literal value; locally pwsh 7.4 writes null there. Neither is a name.
It also re-derives each SDDL relation from the strings themselves, not only from the fixture's booleans.
The exact-SDDL comparison inside ProtectedTemp/CasWrite is not touched. That refusal is the expected native evidence.

usage: adjudicate.py RESULT.json ATTEMPT.json [--out DERIVED.json]     exit 0 = corrected verdict PASS, 3 = FAIL/UNKNOWN"""
import hashlib, json, pathlib, re, sys

FIXTURE = "21d2bcf1705c4b49536882f29151ef74b7cf0417e09740d4fad397274e154b3c"     # the v2 fixture root ran (driver 611609b1)
FUNCS = "38dc1a39d90576d94e5e903079db8c4e00742499f9819995e703d5d4a699b618"
HELPER = "e369c5e204f4d0fe9c6277a7237d7f0ddae6beea6a1bfe935825481b34c6ac45"
NODE = "b3094d0b49f9ad602262a9921551737bb97637c05dd357a06ae98188d7290aa3"
STAGE_RE = re.compile(r"^C:\\ProgramData\\Enclave\\staging\\native-acl-[0-9a-f]{12}$")
REFUSAL = "the temp file does not carry the config ACL"
POSITIVE = ("copied-config-acl", "protected-explicit", "ai-parent")
FLAG_TOKENS = ("NO_ACCESS_CONTROL", "AI", "AR", "P")

class Unknown(Exception):
    pass

def get(o, *path):
    for k in path:
        if not isinstance(o, dict) or k not in o: raise Unknown("missing " + ".".join(path))
        o = o[k]
    return o

def is_true(o, *path):
    v = get(o, *path)
    if not isinstance(v, bool): raise Unknown(".".join(path) + " is not a boolean")
    return v

def no_leftovers(o, *path):
    """True: Left() produced no name (null / {} / []). False: at least one name. Missing or other shapes: UNKNOWN."""
    v = get(o, *path)
    if v is None or v == {} or v == []: return True
    if isinstance(v, str) or (isinstance(v, list) and v and all(isinstance(x, str) for x in v)): return False
    raise Unknown(".".join(path) + f" has an unexpected shape {type(v).__name__}")

def dacl(sddl, where):
    """split an SDDL into (owner+group prefix, DACL flag tokens, ACE list); anything unparsable is UNKNOWN"""
    if not isinstance(sddl, str): raise Unknown(where + " is not a string")
    m = re.fullmatch(r"(O:[^:]*?G:[^:]*?)D:([A-Z_]*)((?:\([^()]*\))+)(S:.*)?", sddl)
    if not m: raise Unknown(where + " is not a parsable SDDL with a DACL")
    flags, rest = [], m.group(2)
    while rest:
        t = next((t for t in FLAG_TOKENS if rest.startswith(t)), None)
        if not t: raise Unknown(where + " has unknown DACL flags " + m.group(2))
        flags.append(t); rest = rest[len(t):]
    return m.group(1), frozenset(flags), re.findall(r"\([^()]*\)", m.group(3))

def positive_case(c, name, checks):
    if "error" in c: checks.append((f"{name}: no error", False, c.get("error"))); return
    rederived = (get(c, "t1", "lengthAtReturn") == 0 and is_true(c, "t1", "sddlEqual") and get(c, "t1", "nodeRc") == 0 and is_true(c, "t1", "sddlEqualAfterNodeWrite")
                 and is_true(c, "t1", "gone") and is_true(c, "t2", "aclKept") and is_true(c, "t2", "afterIsNew") and is_true(c, "t2", "bytesExact")
                 and is_true(c, "t2", "sddlEqual") and no_leftovers(c, "t2", "leftovers") and is_true(c, "t3", "threw") and is_true(c, "t3", "unchanged")
                 and no_leftovers(c, "t3", "leftovers") and is_true(c, "t4", "threw") and is_true(c, "t4", "unchanged") and is_true(c, "t4", "sddlEqual")
                 and no_leftovers(c, "t4", "leftovers") and no_leftovers(c, "t5", "leftovers"))
    checks.append((f"{name}: every T1-T4 check (+ no T5 leftover), re-derived", rederived, None))
    checks.append((f"{name}: the fixture's own pass", is_true(c, "pass"), None))
    t, p = get(c, "probe", "targetSddl"), get(c, "probe", "tempAfterSetAcl")
    checks.append((f"{name}: probe temp == target exactly (recomputed from the SDDL strings)", t == p and is_true(c, "probe", "exactEqual"), None))
    checks.append((f"{name}: probe gone", is_true(c, "probe", "probeGone"), None))
    if name == "ai-parent":                                   # the diagnosis: a target created under an AI parent carries AI itself
        checks.append(("ai-parent: the target's DACL carries AI", "AI" in dacl(get(c, "target", "sddl"), "ai-parent.target.sddl")[1], None))

def inherited_case(c, checks):
    checks.append(("inherited: refused with exactly the ProtectedTemp error", get(c, "error") == REFUSAL, get(c, "error")))
    checks.append(("inherited: the fixture's case pass is false (fail closed)", is_true(c, "pass") is False, None))
    t, p = get(c, "probe", "targetSddl"), get(c, "probe", "tempAfterSetAcl")
    (tp, tf, ta), (pp, pf, pa) = dacl(t, "inherited.probe.targetSddl"), dacl(p, "inherited.probe.tempAfterSetAcl")
    checks.append(("inherited: exactEqual is a real false, and the strings do differ", is_true(c, "probe", "exactEqual") is False and t != p, None))
    checks.append(("inherited: same owner/group and the SAME ordered ACEs", tp == pp and ta == pa, None))
    checks.append(("inherited: target DACL lacks AI and the temp's flags are exactly the target's + AI", "AI" not in tf and pf == tf | {"AI"}, f"{sorted(tf)} -> {sorted(pf)}"))
    checks.append(("inherited: equalExceptAiFlag true (agrees with the recomputation)", is_true(c, "probe", "equalExceptAiFlag"), None))
    checks.append(("inherited: probe gone", is_true(c, "probe", "probeGone"), None))
    checks.append(("inherited: no temp left (leftovers key present; Left produced no name)", no_leftovers(c, "leftovers"), get(c, "leftovers")))

def adjudicate(res, att):
    checks = []
    def step(label, fn):
        try: fn()
        except Unknown as e: checks.append((label, None, str(e)))
    step("receipt kind/pins", lambda: checks.extend([
        ("result receipt", get(res, "what") == "result", None), ("attempt receipt", get(att, "what") == "attempt", None),
        ("same stage + fixture in attempt and result", get(att, "stage") == get(res, "stage") and get(att, "fixture") == get(res, "fixture"), None),
        ("stage path shape", bool(STAGE_RE.match(get(res, "stage"))), None),
        ("fixture pinned 21d2bcf1 (driver pin and staged sha)", get(res, "fixture") == FIXTURE and get(res, "verify", "sha") == FIXTURE, None),
        ("functions/helper/node pins inside the fixture output", (get(res, "fixture_result", "functionsSha"), get(res, "fixture_result", "helperSha"), get(res, "fixture_result", "node")) == (FUNCS, HELPER, NODE), None),
        ("stage created protected, no foreign rule", get(res, "mkdir", "decision") == "created" and is_true(res, "mkdir", "protected") and get(res, "mkdir", "foreignRules") == 0, None)]))
    for n in POSITIVE: step(n, lambda n=n: positive_case(get(res, "fixture_result", "cases", n), n, checks))
    step("inherited", lambda: inherited_case(get(res, "fixture_result", "cases", "inherited"), checks))
    def cleanup():
        before, after = get(res, "parentBefore", "sddl"), get(res, "cleanup", "parentSddl")
        checks.append(("cleanup: stage removed by ownership marker, gone, not a reparse point", is_true(res, "cleanup", "gone") and is_true(res, "cleanup", "owned") and is_true(res, "cleanup", "reparse") is False, None))
        checks.append(("cleanup: staging parent SDDL unchanged (recomputed)", isinstance(before, str) and bool(before) and before == after and is_true(res, "parentUnchanged"), None))
    step("cleanup", cleanup)
    # the raw values, preserved, and the bug reproduced: PowerShell's @($null).Count == 1 makes the original term false
    raw = {}
    try:
        ih = get(res, "fixture_result", "cases", "inherited"); lv = get(ih, "leftovers")
        ps_count = 1 if lv is None else (0 if lv in ({}, []) else (len(lv) if isinstance(lv, list) else 1))   # PowerShell: @(scalar or $null).Count = 1
        orig = (ih.get("error") == REFUSAL and not ih.get("probe", {}).get("exactEqual") and bool(ih.get("probe", {}).get("equalExceptAiFlag"))
                and bool(ih.get("probe", {}).get("probeGone")) and not ps_count)
        raw = {"verdict": get(res, "verdict"), "fixturePass": get(res, "fixture_result", "pass"), "inheritedExpectedRefusal": get(ih, "expectedRefusal"),
               "originalExpressionUnderPowerShellSemantics": orig, "reproducesRawExpectedRefusal": orig == get(ih, "expectedRefusal")}
    except Unknown as e: raw = {"error": str(e)}
    unknown = [c for c in checks if c[1] is None]; failed = [c for c in checks if c[1] is False]
    verdict = "PASS" if checks and not unknown and not failed else ("UNKNOWN" if unknown and not failed else "FAIL")
    return {"verdict": verdict, "checks": [{"check": a, "ok": b, **({"detail": d} if d is not None else {})} for a, b, d in checks], "raw": raw}

def main(argv):
    out = None
    if "--out" in argv: i = argv.index("--out"); out = pathlib.Path(argv[i + 1]); argv = argv[:i] + argv[i + 2:]
    rp, ap = map(pathlib.Path, argv[:2]); rb, ab = rp.read_bytes(), ap.read_bytes()
    a = adjudicate(json.loads(rb), json.loads(ab))
    rec = {"what": "CORRECTED ADJUDICATION (derived; NOT a native result)",
           "label": "Pure local re-decision of the v2 criteria from the captured native observations. The raw receipt is preserved unchanged and its verdict stays false.",
           "rawResult": {"path": str(rp), "sha256": hashlib.sha256(rb).hexdigest()}, "rawAttempt": {"path": str(ap), "sha256": hashlib.sha256(ab).hexdigest()},
           "rawVerdictPreserved": a["raw"], "defect": "v2 fixture 21d2bcf1 line 91: -not @($ih.leftovers).Count with leftovers = $null (Left produced no output) -> @($null).Count = 1 -> false",
           "correctedVerdict": a["verdict"], "checks": a["checks"], "adjudicator": hashlib.sha256(pathlib.Path(__file__).read_bytes()).hexdigest()}
    text = json.dumps(rec, indent=1) + "\n"
    if out:
        with open(out, "x") as fh: fh.write(text)
    print(text, end="")
    return 0 if a["verdict"] == "PASS" else 3

if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
