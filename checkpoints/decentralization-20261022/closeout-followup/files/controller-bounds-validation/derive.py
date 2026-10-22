#!/usr/bin/env python3
"""derive.py - derive the FIXTURE controller copy with exactly the frozen bounds delta, then prove equivalence.
- Inputs: frozen/ (read-only copies with pinned hashes).
- Output: derived/replicactl.fixture-r5.restorefix.bounds.py (written only if every check passes).
Checks:
  E1 every input matches its pin;
  E2 the frozen production patch applied to the production restore fix reproduces the frozen bounds copy byte-for-byte;
  E3 the same patch applied (GNU patch, no reject) to the fixture restore fix (4e0a76a0, root's r3 integration
     controller) yields a copy whose delta has the SAME hunks: identical removed/added lines, in the same order;
  E4 the pre-existing fixture-vs-production difference is untouched: the difference of the two bounded files equals
     the difference of the two restore-fix files, after the identical delta is removed (line multiset comparison);
  E5 the derived copy compiles."""
import difflib
import hashlib
import json
import py_compile
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

HERE = Path(__file__).resolve().parent
F = HERE / "frozen"
PINS = {"replicactl.r5-production.restorefix.fd097a2a.py": "fd097a2a2f480e0d0aded033effb2f7992b8852f43e2f3f072bff1056fef4452",
        "replicactl.r5-production.restorefix.bounds.py": "1543577f4bdbc1bc94dca950e55ac0ece5eb6a65272622aa90244ef2ba7c0e83",
        "CONTROLLER-BOUNDS-PROPOSAL.patch": "561af966e550b138a1fd31d19d7255090799531279e7b8e59fd022928f2db00d",
        "replicactl.fixture-r5.restorefix.4e0a76a0.py": "4e0a76a039bbc126df0d23855106f95e5dd9ea424cce7973cc65f34538b337a3"}
OUT = HERE / "derived/replicactl.fixture-r5.restorefix.bounds.py"
sha = lambda p: hashlib.sha256(Path(p).read_bytes()).hexdigest()


def apply(src, patch):
    with tempfile.TemporaryDirectory(dir=HERE) as t:
        f = Path(t) / "f.py"
        shutil.copyfile(src, f)
        r = subprocess.run(["patch", "--no-backup-if-mismatch", "-r", "-", str(f)], stdin=open(patch), capture_output=True, text=True)
        return r.returncode, r.stdout + r.stderr, f.read_text() if r.returncode == 0 else None


def hunks(a, b):
    """[(removed lines, added lines)] of each change block, without positions"""
    out = []
    for tag, i1, i2, j1, j2 in difflib.SequenceMatcher(None, a, b, autojunk=False).get_opcodes():
        if tag != "equal":
            out.append((a[i1:i2], b[j1:j2]))
    return out


def main():
    res = {"pins": {n: sha(F / n) for n in PINS}}
    res["E1"] = all(res["pins"][n] == h for n, h in PINS.items())
    rc, log, prod = apply(F / "replicactl.r5-production.restorefix.fd097a2a.py", F / "CONTROLLER-BOUNDS-PROPOSAL.patch")
    res["E2"] = rc == 0 and prod == (F / "replicactl.r5-production.restorefix.bounds.py").read_text()
    rc, log, fix = apply(F / "replicactl.fixture-r5.restorefix.4e0a76a0.py", F / "CONTROLLER-BOUNDS-PROPOSAL.patch")
    res["patchLog"] = log.strip().splitlines()
    pa = (F / "replicactl.r5-production.restorefix.fd097a2a.py").read_text().splitlines()
    pb = (F / "replicactl.r5-production.restorefix.bounds.py").read_text().splitlines()
    fa = (F / "replicactl.fixture-r5.restorefix.4e0a76a0.py").read_text().splitlines()
    if rc == 0:
        fb = fix.splitlines()
        hp, hf = hunks(pa, pb), hunks(fa, fb)
        res["hunks"] = {"production": len(hp), "fixture": len(hf),
                        "changedLines": sum(len(r) + len(a) for r, a in hp)}
        res["E3"] = hp == hf
        from collections import Counter
        res["E4"] = (Counter(fb) - Counter(pb)) == (Counter(fa) - Counter(pa)) and (Counter(pb) - Counter(fb)) == (Counter(pa) - Counter(fa))
    else:
        res["E3"] = res["E4"] = False
    if res["E1"] and res["E2"] and res["E3"] and res["E4"]:
        tmp = OUT.with_suffix(".tmp")
        tmp.write_text(fix)
        py_compile.compile(str(tmp), cfile=str(HERE / "derived/.compile-check.pyc"), doraise=True)
        (HERE / "derived/.compile-check.pyc").unlink()
        tmp.replace(OUT)
        res["E5"] = True
        res["derived"] = {str(OUT.relative_to(HERE)): sha(OUT)}
    else:
        res["E5"] = False
    res["ok"] = all(res[k] for k in ("E1", "E2", "E3", "E4", "E5"))
    print(json.dumps(res, indent=1))
    return 0 if res["ok"] else 1


if __name__ == "__main__":
    sys.exit(main())
