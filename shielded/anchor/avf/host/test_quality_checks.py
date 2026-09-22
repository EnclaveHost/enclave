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
COUNTRY_SET = ("exactset=3:Brazil,Argentina,Peru,Chile,Colombia,Bolivia,Ecuador,Uruguay,Paraguay,"
               "Venezuela,Guyana,Suriname")

# (name, spec, reply, verdict that must NOT come back, verdicts that are acceptable)
FALSE_POSITIVES = [
    # "A safe builtin" is not the same thing as "a consumer a list can stand in for". Both of these
    # were PASS when the predicate was SAFE_BUILTINS: len() has no meaning on a generator (Python
    # raises TypeError, the list answers 2), and an EMPTY generator is truthy where an empty list is
    # falsy, so bool() flips. The contracts below are the ones the MATERIALISED answer satisfies.
    ("len() of a generator, which Python refuses", "pyfunc=f|aa->2",
     "def f(s):\n    return len(1 for c in s)", PASS, {REVIEW, FAIL}),
    ("an empty generator is truthy, an empty list is not", "pyfunc=f|aa->False",
     "def f(s):\n    return str(bool(c for c in s if False))", PASS, {REVIEW, FAIL}),
    ("reversed() of a generator, which Python refuses", "pyfunc=f|aa->['a', 'a']",
     "def f(s):\n    return list(reversed(c for c in s))", PASS, {REVIEW, FAIL}),
    # A generator is a ONE-SHOT lazy iterator. Materialising one as a list makes it reusable, and that
    # was a reproducible false PASS: real Python exhausts g in the first sum, so this returns 2, but
    # the interpreter returned 4 and the spec "aa->4" was scored correct. Immediate consumption is
    # still evaluated (see the true positives); anything that could consume twice is REVIEW.
    ("a reused generator, which Python exhausts", "pyfunc=f|aa->4",
     "def f(s):\n    g = (1 for c in s)\n    return sum(g) + sum(g)", PASS, {REVIEW, FAIL}),
    ("a generator handed to a function that consumes it twice", "pyfunc=f|aa->4",
     "def g(it):\n    return sum(it) + sum(it)\ndef f(s):\n    return g(1 for c in s)", PASS, {REVIEW, FAIL}),
    ("a genexp counter that counts the WRONG thing", "pyfunc=count_vowels|hello->2|xyz->0|aeiou->5",
     "def count_vowels(s):\n    return sum(1 for c in s)", PASS, {FAIL}),
    ("a genexp counter that always returns zero", "pyfunc=count_vowels|hello->2|xyz->0|aeiou->5",
     "def count_vowels(s):\n    return sum(0 for c in s)", PASS, {FAIL}),
    ("identity function passed as a reverser", "pyfunc=" + REV,
     "def reverse_string(s): return s", PASS, {FAIL}),
    ("one country offered as three", COUNTRY_SET, "Brazil", PASS, {FAIL}),
    ("a fruit offered as a haiku", "review=three lines, 5-7-5, about rain", "banana", PASS, {REVIEW}),
    ("regex shape with no semantics", r"contains=def\s+reverse_string\s*\(",
     "def reverse_string(s): return s", PASS, {SMOKE}),
    ("primes listed out of order", PRIMES, "3, 2, 5, 7, 11, 13, 17, 19, 23, 29", PASS, {FAIL}),
    ("primes truncated", PRIMES, "2, 3, 5, 7, 11", PASS, {FAIL}),
    ("the same country three times", COUNTRY_SET, "Brazil, Brazil and Brazil", PASS, {FAIL}),
    ("code that does not parse", "pyfunc=" + REV, "def reverse_string(s) return s[::-1", PASS,
     {FAIL, REVIEW}),
    ("the right answer to a different question", "numeric=391", "17 times 23 is hard to say", PASS, {FAIL}),
    # A CORRECT prose answer also fails a strict numeric contract ("17 times 23 is 391" carries 17 and 23
    # as well). That is the deliberate price of killing the negation defeat, and it is why the prompts now
    # say "Reply with only the number" and why a task that cannot demand a bare answer is review=.
    ("correct prose under a strict numeric contract", "numeric=391", "17 times 23 is 391.", PASS, {FAIL}),
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
    # --- second audit round: the interpreter ---------------------------------------------------------
    # A rebound local must SHADOW the module-level def. Real Python raises TypeError here; the
    # interpreter called the nested def anyway because dispatch consulted the function table first.
    ("a local rebound over a nested def", "pyfunc=" + REV,
     "def reverse_string(s):\n    def rev(x): return x[::-1]\n    rev = 0\n    return rev(s)\n",
     PASS, {REVIEW, FAIL}),
    # The limit was checked on the return value of a MUTATING method, which is None, so the list grew
    # to 120000 past a 100000 bound. Every resource check now runs BEFORE the work.
    ("a list grown past the bound by extend", "pyfunc=f|x->y",
     "def f(s):\n    a = [0] * 60000\n    a.extend(a)\n    return len(a)\n", PASS, {REVIEW, FAIL}),
    ("repetition with the operands reversed", "pyfunc=f|x->y",
     "def f(s):\n    return 60000 * [0, 1]\n", PASS, {REVIEW, FAIL}),
    ("growth through join", "pyfunc=f|x->y",
     "def f(s):\n    return ('x' * 1000).join(['y' * 1000] * 200)\n", PASS, {REVIEW, FAIL}),
    ("growth through replace", "pyfunc=f|x->y",
     "def f(s):\n    return ('a' * 50000).replace('a', 'bbbb')\n", PASS, {REVIEW, FAIL}),
    ("integer growth", "pyfunc=f|x->y",
     "def f(s):\n    x = 10 ** 60\n    for i in range(40):\n        x = x * x\n    return x\n",
     PASS, {REVIEW, FAIL}),
    # --- second audit round: presence masquerading as correctness ------------------------------------
    ("a keyword in a sentence that asserts something else", "distinct=1:Rayleigh",
     "Rayleigh invented blue paint.", PASS, {SMOKE}),
    ("the right word inside a denial", "exact=Paris",
     "Paris is not the capital of France; London is.", PASS, {FAIL}),
    ("the right number inside a denial", "numeric=391",
     "391 is wrong; the answer is 400.", PASS, {FAIL}),
    ("a list that denies its own members", "exactset=3:Brazil,Argentina,Peru,Chile",
     "Brazil is not in South America; Peru and Chile are.", PASS, {FAIL}),
    ("a sequence with extra numbers after it", "sequence=2,3,5",
     "2, 3, 5 are wrong, try 7", PASS, {FAIL}),
    # --- third audit round: a strict contract must match the WHOLE reply -----------------------------
    # Both of these carry exactly the right numbers and deny them. Checking only the extracted numbers
    # cannot see the denial, so the contract now requires the reply to be bare.
    ("the right number, denied", "numeric=391", "The answer is not 391.", PASS, {FAIL}),
    ("the right sequence, denied", "sequence=2,3,5", "The numbers 2,3,5 are not primes.", PASS, {FAIL}),
    ("a negated bare-looking answer", "numeric=100", "not 100", PASS, {FAIL}),
    # Augmented assignment skipped the pre-check the plain operator had, so `x *= x` in a loop reached a
    # 131073-bit integer past a 65536-bit bound.
    ("integer growth through augmented assignment", "pyfunc=f|x->y",
     "def f(z):\n    x = 2 ** 64\n    for i in range(11):\n        x *= x\n    return x\n",
     PASS, {REVIEW, FAIL}),
]

TRUE_POSITIVES = [
    ("a real reverser", "pyfunc=" + REV, "def reverse_string(s):\\n    return s[::-1]", PASS),
    ("a real reverser in a fenced block", "pyfunc=" + REV,
     "Here you go:\\n```python\\ndef reverse_string(s):\\n    return s[::-1]\\n```\\nThat slices it.", PASS),
    ("a loop-based reverser", "pyfunc=" + REV,
     "def reverse_string(s):\\n    out = ''\\n    for c in s:\\n        out = c + out\\n    return out", PASS),
    # A generator expression is how a model most naturally writes a counting function. Before it was
    # supported, a CORRECT answer came back REVIEW, which is not correctness -- so every lane's task
    # score was understated by the same amount and a real difference could hide inside it.
    ("a counter written with sum(genexp)", "pyfunc=count_vowels|hello->2|xyz->0|aeiou->5",
     "def count_vowels(s):\n    return sum(1 for c in s if c in 'aeiou')", PASS),
    ("a counter written with a list comprehension", "pyfunc=count_vowels|hello->2|xyz->0|aeiou->5",
     "def count_vowels(s):\n    return len([c for c in s if c in 'aeiou'])", PASS),
    ("a counter written with an explicit loop", "pyfunc=count_vowels|hello->2|xyz->0|aeiou->5",
     "def count_vowels(s):\n    n = 0\n    for c in s:\n        if c in 'aeiou':\n            n = n + 1\n    return n", PASS),
    # The conservative half of the same repair: with the CORRECT contract (Python gives 2), the
    # interpreter still declines rather than guessing. Understating is allowed; inventing is not.
    ("a reused generator under its correct contract", "pyfunc=f|aa->2",
     "def f(s):\n    g = (1 for c in s)\n    return sum(g) + sum(g)", REVIEW),
    # The positive controls for the allowlist: every consumer kept on it must still evaluate.
    ("sum(genexp), the immediate positive control", "pyfunc=f|aa->2|abc->3|->0",
     "def f(s):\n    return sum(1 for c in s)", PASS),
    ("any(genexp)", "pyfunc=f|aa->True|xy->False",
     "def f(s):\n    return str(any(c == 'a' for c in s))", PASS),
    ("str.join(genexp)", "pyfunc=f|aa->aa|->",
     "def f(s):\n    return ''.join(c for c in s)", PASS),
    ("three real countries", COUNTRY_SET, "Brazil, Argentina and Peru", PASS),
    ("ten primes in order", PRIMES, "2, 3, 5, 7, 11, 13, 17, 19, 23, 29", PASS),
    # An import that is never USED is never evaluated either -- module-level statements are not run at
    # all -- so the function is genuinely correct and PASS is the honest verdict. A function that USES
    # the import is above, in the cases that must not pass.
    ("an unused import beside a correct function", "pyfunc=" + REV,
     "import os\ndef reverse_string(s):\n    return s[::-1]", PASS),
    ("a nested helper that is actually called", "pyfunc=" + REV,
     "def reverse_string(s):\n    def rev(x):\n        return x[::-1]\n    return rev(s)\n", PASS),
    ("a bare exact answer", "exact=Paris", "Paris.", PASS),
    ("a bare exact answer in bold", "exact=Paris", "**Paris**", PASS),
    ("a bare number", "numeric=391", "391", PASS),
    ("three bare countries", "exactset=3:Brazil,Argentina,Peru,Chile", "Brazil, Argentina, Peru", PASS),
    ("a bare sequence", "sequence=2,3,5", "2, 3, 5", PASS),
    ("a bare sequence joined with and", "sequence=2,3,5", "2, 3 and 5", PASS),
    ("a bare number in bold with a period", "numeric=391", "**391.**", PASS),
    ("modest integer growth still runs", "pyfunc=f|x->256",
     "def f(z):\n    x = 2\n    for i in range(3):\n        x *= x\n    return str(x)\n", PASS),
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
