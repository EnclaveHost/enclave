#!/usr/bin/env python3
"""derive_integration_r4.py - build integration-r4/ (ROOT runs it once) from FROZEN inputs by exact replacements.
Inputs:
- restore-timeout-diagnosis/r3: run-integration.py a0ec6e8c and integration_checks.py 538c28d4 (refined barrier);
- derived/replicactl.fixture-r5.restorefix.bounds.py 0a6f5686.
r4 differs from that r3 harness ONLY in:
- the controller pin (the bounded fixture copy, placed next to the harness as replicactl.fixture.py);
- its docstring lines.
integration_checks.py is copied byte-identical. Nothing is run here; root's r3 receipt (controller-integration-r3, run
a4cdf02552931ec3) is not touched."""
import hashlib
import shutil
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
R3 = HERE.parent / "restore-timeout-diagnosis/r3"
OUT = HERE / "integration-r4"
SRC = {R3 / "run-integration.py": "a0ec6e8cea1afd827a4fd9ca5744c54de12d7ff629b925a29815c175d8ac105b",
       R3 / "integration_checks.py": "538c28d43f1bab992c4dc87f3d3f25524bc86bd91e6a8ac492d7ab1b58415cbf",
       HERE / "derived/replicactl.fixture-r5.restorefix.bounds.py": "0a6f56868d481238815f8b8dca41c764790cd38a55030854cedaab047d281a98"}
sha = lambda p: hashlib.sha256(Path(p).read_bytes()).hexdigest()
REPL = [
    ('''"""ROOT ONLY. ONE derived, isolated integration run of the storage-migration-r5 rev2 controller WITH the restore-timeout
fix (restore-timeout-diagnosis/fix/replicactl.fixture-r5.restorefix.py = 2ab98b4d + fix/apply_restorefix.py) on REAL
PostgreSQL. r3 (PROPOSED): only that controller pin and the kept server log (pg-server.log) differ from r2.''',
     '''"""ROOT ONLY. ONE derived, isolated integration run of the storage-migration-r5 rev2 controller WITH the restore-timeout
fix AND the controller bounds delta (controller-bounds-validation/derived/replicactl.fixture-r5.restorefix.bounds.py =
restore fix 4e0a76a0 + frozen CONTROLLER-BOUNDS-PROPOSAL.patch 561af966, equivalence-checked by derive.py) on REAL
PostgreSQL. r4: only that controller pin differs from restore-timeout-diagnosis/r3 (a0ec6e8c, refined barrier).'''),
    ('''CONTROLLER = W / "resume-after-checkpoint-20261022/restore-timeout-diagnosis/fix/replicactl.fixture-r5.restorefix.py"
CONTROLLER_SHA = "4e0a76a039bbc126df0d23855106f95e5dd9ea424cce7973cc65f34538b337a3"''',
     '''CONTROLLER = HERE / "replicactl.fixture.py"
CONTROLLER_SHA = "0a6f56868d481238815f8b8dca41c764790cd38a55030854cedaab047d281a98"'''),
]


def main():
    bad = [str(p) for p, h in SRC.items() if sha(p) != h]
    if bad:
        print("pin mismatch:", bad)
        return 2
    if OUT.exists():
        print(f"{OUT} exists: refusing to overwrite")
        return 2
    text = (R3 / "run-integration.py").read_text()
    for a, b in REPL:
        assert text.count(a) == 1, a[:60]
        text = text.replace(a, b)
    OUT.mkdir()
    (OUT / "run-integration.py").write_text(text)
    shutil.copyfile(R3 / "integration_checks.py", OUT / "integration_checks.py")
    shutil.copyfile(HERE / "derived/replicactl.fixture-r5.restorefix.bounds.py", OUT / "replicactl.fixture.py")
    for f in sorted(OUT.iterdir()):
        print(sha(f), f.name)
    return 0


if __name__ == "__main__":
    sys.exit(main())
