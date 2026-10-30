# v2 -> v3: compound gate actual-output fix

## Root's finding (before any run)

v2 required the line `## compoundAccepted: True` in `receipts/cli-child-N.out`. On the guest that file is the supplement UNIT's output, written by the pinned `cli_child_cases.py`, and it is exactly `recorded 49 runs\n`. The `## compoundAccepted:` line is printed by the launcher to the HOST's `launch.out`. So v2 checked the wrong file, and its synthetic fixture invented the wrong content: it would have REFUSED the actual passing evidence.

## The fix (v3)

- **What changed:** the gate now requires `cli-child-N.out` to be exactly `recorded 49 runs\n`.
- **What is unchanged:** every other check, including the re-run of the pinned checker, the byte-equality with `compound.json`, the original run-2 pins, the only-the-child-ignored rule, and the supplement manifest of 99 files.
- **Tests:** the synthetic fixture uses the actual unit output. The new negatives are a count of 48, the host launch log in place of the unit output, and an extra line. Real-evidence cases R1–R5 run the gate on root's ACTUAL collected files.

## Gate diff (v2 `bce57917` -> v3 `1fba89d7`)
```diff
@@ -13,7 +13,9 @@
   4. cli-child-<N>.{compound.json,launcher.json,out} equal the root-supplied pins; the supplement output dir equals its pinned
      manifest (results.json + 49 runs x stdout/stderr = 99 files, nothing else);
   5. RE-RUNNING the pinned checker on those files exits 0 with compoundAccepted true, no failures, originalReceiptPass false,
-     summary 45/3/true, and its output is byte-identical to the stored compound.json; the launcher's .out reports it.
+     summary 45/3/true, and its output is byte-identical to the stored compound.json;
+  6. cli-child-<N>.out (the supplement UNIT's stdout/stderr, written by the pinned cli_child_cases.py) is EXACTLY
+     'recorded 49 runs\n' (the actual, observed format). The '## compoundAccepted:' line belongs to the host launch log, not here.
 Prints the accepted evidence pins as JSON (exit 0) or one reason per line (exit 1)."""
 import argparse, hashlib, json, pathlib, re, subprocess, sys
 CHILD_MANIFEST = "f3d45ccbcb9fce94cd87957baacbc879b37395c3682006aa73671e1560f79708"
@@ -101,8 +103,7 @@
     need(v.get("compoundAccepted") is True and v.get("failures") == [] and v.get("originalReceiptPass") is False, f"re-run checker verdict {v.get('compoundAccepted')!r} {v.get('failures', [])[:3]}")
     need(v.get("summary") == {"nonIgnoredPassed": 45, "childPassed": 3, "controlKilledByAssertion": True}, f"re-run summary {v.get('summary')}")
     need(p.stdout == comp_b, "stored compound.json is not byte-identical to the re-run checker output")
-    cl = cout.decode(errors="replace").splitlines()
-    need("## compoundAccepted: True" in cl and not any(l.startswith("## REASON:") for l in cl), "cli-child .out does not report compoundAccepted True cleanly")
+    need(cout == b"recorded 49 runs\n", f"cli-child .out (unit output) is not exactly 'recorded 49 runs': {cout[:60]!r}")
 if fails:
     for f in fails: print(f"[REFUSE] {f}")
     sys.exit(1)
```
