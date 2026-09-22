#!/usr/bin/env python3
"""Regression test for quality_checks.py, built from answers that FOOLED the previous scoring.

Every case in FALSE_POSITIVES was reported TASK CORRECTNESS PASS by the regex-only version. Each must now
come back FAIL (or, for an open-ended task, REVIEW -- never PASS). TRUE_POSITIVES guard the other side, so
the fix cannot be "fail everything".

    python3 host/test_quality_checks.py        # exit 0 = all hold
"""

import os
import sys

sys.path.insert(0, __file__.rsplit("/", 1)[0])
from quality_checks import FAIL, PASS, REVIEW, SMOKE, check  # noqa: E402

REV = "reverse_string|abc->cba|racecar->racecar|ab cd->dc ba|->|x->x"
# A path the checker must never create. The audit's candidate wrote one like it and still passed.
SENTINEL = "/tmp/quality-checker-escape-sentinel"
COUNTRIES = ("distinct=3:Brazil,Argentina,Peru,Chile,Colombia,Bolivia,Ecuador,Uruguay,Paraguay,"
             "Venezuela,Guyana,Suriname")
PRIMES = "sequence=2,3,5,7,11,13,17,19,23,29"

# (name, spec, reply, verdict that must NOT come back, verdicts that are acceptable)
FALSE_POSITIVES = [
    ("identity function passed as a reverser", "pyfunc=" + REV,
     "def reverse_string(s): return s", PASS, {FAIL}),
    ("one country offered as three", COUNTRIES, "Brazil", PASS, {FAIL}),
    ("a fruit offered as a haiku", "review=three lines, 5-7-5, about rain", "banana", PASS, {REVIEW}),
    ("regex shape with no semantics", r"contains=def\s+reverse_string\s*\(",
     "def reverse_string(s): return s", PASS, {SMOKE}),
    ("primes listed out of order", PRIMES, "3, 2, 5, 7, 11, 13, 17, 19, 23, 29", PASS, {FAIL}),
    ("primes truncated", PRIMES, "2, 3, 5, 7, 11", PASS, {FAIL}),
    ("the same country three times", COUNTRIES, "Brazil, Brazil and Brazil", PASS, {FAIL}),
    ("code that does not parse", "pyfunc=" + REV, "def reverse_string(s) return s[::-1", PASS,
     {FAIL, REVIEW}),
    ("the right answer to a different question", "numeric=391", "17 times 23 is hard to say", PASS, {FAIL}),
    ("a function under the wrong name", "pyfunc=" + REV,
     "def rev(s): return s[::-1]", PASS, {FAIL, REVIEW}),
    ("an infinite loop", "pyfunc=" + REV,
     "def reverse_string(s):\\n    while True: pass", PASS, {FAIL, REVIEW}),
    ("an unknown check kind is not a pass", "wibble=3", "anything", PASS, {FAIL}),
    # --- the two defects found by audit against a byte-identical copy of quality_checks.py ---
    # (sha256 ffe61e3ac1fd50e7a8db4d60888aa2a088901da5329914e21a3b30a9c498a743). Both passed then.
    ("a candidate that reaches OUTSIDE the scratch directory", "pyfunc=" + REV,
     "def reverse_string(s):\n    open(%r, 'w').write('audit sentinel')\n    return s[::-1]" % SENTINEL,
     PASS, {REVIEW, FAIL}),
    ("a candidate that FORGES the verdict on stdout", "pyfunc=" + REV,
     'print(\'{"ok": true, "why": "forged"}\')\nraise SystemExit(0)', PASS, {REVIEW, FAIL}),
    ("a forged verdict alongside a wrong function", "pyfunc=" + REV,
     'print(\'{"ok": true, "why": "forged"}\')\ndef reverse_string(s):\n    return s\n',
     PASS, {REVIEW, FAIL}),
    ("a function that USES an import", "pyfunc=" + REV,
     "import os\ndef reverse_string(s):\n    return os.popen('echo ' + s).read()", PASS, {REVIEW, FAIL}),
    ("reading a credential file", "pyfunc=" + REV,
     "def reverse_string(s):\n    return open('/etc/passwd').read()", PASS, {REVIEW, FAIL}),
    ("allocating without bound", "pyfunc=" + REV,
     "def reverse_string(s):\n    return 'a' * (10 ** 9)", PASS, {REVIEW, FAIL}),
]

TRUE_POSITIVES = [
    ("a real reverser", "pyfunc=" + REV, "def reverse_string(s):\\n    return s[::-1]", PASS),
    ("a real reverser in a fenced block", "pyfunc=" + REV,
     "Here you go:\\n```python\\ndef reverse_string(s):\\n    return s[::-1]\\n```\\nThat slices it.", PASS),
    ("a loop-based reverser", "pyfunc=" + REV,
     "def reverse_string(s):\\n    out = ''\\n    for c in s:\\n        out = c + out\\n    return out", PASS),
    ("three real countries", COUNTRIES, "Brazil, Argentina and Peru", PASS),
    ("ten primes in order", PRIMES, "2, 3, 5, 7, 11, 13, 17, 19, 23, 29", PASS),
    ("the right number", "numeric=391", "17 times 23 is 391.", PASS),
    # An import that is never USED is never evaluated either -- module-level statements are not run at
    # all -- so the function is genuinely correct and PASS is the honest verdict. A function that USES
    # the import is above, in the cases that must not pass.
    ("an unused import beside a correct function", "pyfunc=" + REV,
     "import os\ndef reverse_string(s):\n    return s[::-1]", PASS),
]


def main():
    bad = 0
    if os.path.exists(SENTINEL):
        os.unlink(SENTINEL)
    print(f"{'verdict':>8}  {'expected':>18}  case")
    for name, spec, reply, forbidden, allowed in FALSE_POSITIVES:
        v, why = check(spec, reply)
        ok = v != forbidden and v in allowed
        bad += 0 if ok else 1
        print(f"{v:>8}  {'not ' + forbidden:>18}  {name}{'' if ok else '   <-- REGRESSION: ' + why}")
    for name, spec, reply, want in TRUE_POSITIVES:
        v, why = check(spec, reply)
        ok = v == want
        bad += 0 if ok else 1
        print(f"{v:>8}  {want:>18}  {name}{'' if ok else '   <-- REGRESSION: ' + why}")
    # The verdict is only half of it: the checker must also have had NO effect on this machine.
    escaped = os.path.exists(SENTINEL)
    if escaped:
        bad += 1
        print(f"\n   <-- REGRESSION: the checker created {SENTINEL}; it executed candidate code")
        os.unlink(SENTINEL)
    else:
        print(f"\nno side effect: {SENTINEL} was not created")
    print(f"{len(FALSE_POSITIVES)} known false positives + {len(TRUE_POSITIVES)} true positives, "
          f"{bad} failures")
    return 1 if bad else 0


if __name__ == "__main__":
    raise SystemExit(main())
