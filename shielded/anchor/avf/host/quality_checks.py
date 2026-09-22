#!/usr/bin/env python3
"""Task checks for quality-report.py, with SMOKE and CORRECT kept apart.

Why this file exists. The first version of this scoring asked only whether a regex appeared in the reply,
and called the result TASK CORRECTNESS. An audit drove it with three synthetic answers and all three
passed:

    "def reverse_string(s): return s"   -- matches `def\\s+reverse_string\\s*\\(`, and returns the string UNREVERSED
    "Brazil"                            -- matches the country alternation, and names ONE country, not three
    "banana"                            -- matches `\\w+`, and is not a haiku

A regex says a shape is present. It cannot say an answer is right, and calling it correctness turned a
smoke test into a claim about quality. So there are now three verdicts and they never collapse into each
other:

    SMOKE   the shape is there. Never counted as correctness.
    PASS    a semantic check actually ran and the answer satisfied it.
    REVIEW  the task is open-ended; no automatic verdict is possible and a human has to read it.
    FAIL    a semantic check ran and the answer did not satisfy it.

Spec syntax, one per prompt, after a tab in the prompt file:

    contains=<regex>                        SMOKE only
    numeric=<value>                         the reply must contain exactly this number as a standalone token
    distinct=<n>:<a,b,c,...>                at least n DISTINCT members of the list
    sequence=<a,b,c,...>                    these values, in this order, each as a standalone number
    pyfunc=<name>|<in>-><out>|<in>-><out>   extract Python, define <name>, run the cases, all must match
    review=<what a human should check>      REVIEW

`pyfunc` executes text the model wrote, so it runs in a separate interpreter with CPU and address-space
limits and a wall-clock timeout, in a scratch directory, with no arguments and no stdin. That is
containment appropriate to a local eval harness on the operator's own machine, and it is not a sandbox
for hostile code.
"""

import ast
import os
import re
import sys

SMOKE, PASS, FAIL, REVIEW = "SMOKE", "PASS", "FAIL", "REVIEW"



def unescape(s):
    r"""Log lines carry \n and \t as two characters; code will not parse until they are real."""
    return s.replace("\\n", "\n").replace("\\t", "\t").replace('\\"', '"').replace("\\'", "'")


def extract_code(text):
    """The fenced block if there is one; else the whole reply; else the def block inside the prose.

    A model asked for "only the code" often writes a sentence first anyway, and the whole reply then fails
    to parse. Falling back to the first `def` and the lines belonging to it recovers those without
    accepting anything the model did not actually write.
    """
    t = unescape(text)
    fences = re.findall(r"```(?:python|py)?\s*\n?(.*?)(?:```|$)", t, re.S)
    if fences:
        return max(fences, key=len)
    try:
        ast.parse(t)
        return t
    except SyntaxError:
        pass
    lines = t.splitlines()
    for i, ln in enumerate(lines):
        if re.match(r"\s*def\s+\w+\s*\(", ln):
            base = len(ln) - len(ln.lstrip())
            out = [ln]
            for nxt in lines[i + 1:]:
                if nxt.strip() and (len(nxt) - len(nxt.lstrip())) <= base:
                    break
                out.append(nxt)
            return "\n".join(out)
    return t


def _numbers(text):
    return re.findall(r"-?\d+(?:\.\d+)?", text)


def parse_spec(spec):
    spec = (spec or "").strip()
    if not spec:
        return None, ""
    kind, _, payload = spec.partition("=")
    return kind.strip(), payload


def check(spec, text):
    """-> (verdict, detail). Anything unrecognised is an error, not a pass."""
    kind, payload = parse_spec(spec)
    if kind is None:
        return REVIEW, "no check specified"
    t = unescape(text)

    if kind == "contains":
        try:
            hit = re.search(payload, t, re.I) is not None
        except re.error as e:
            return FAIL, "bad regex: %s" % e
        return (SMOKE if hit else FAIL), ("shape present (SMOKE ONLY, not correctness)" if hit
                                          else "pattern not found")

    if kind == "numeric":
        want = payload.strip()
        return (PASS, "found %s" % want) if want in _numbers(t) else (FAIL, "%s not present" % want)

    if kind == "distinct":
        n, _, items = payload.partition(":")
        try:
            n = int(n)
        except ValueError:
            return FAIL, "bad distinct spec"
        found = []
        for it in [x.strip() for x in items.split(",") if x.strip()]:
            if re.search(r"\b%s\b" % re.escape(it), t, re.I) and it.lower() not in [f.lower() for f in found]:
                found.append(it)
        return ((PASS, "%d distinct: %s" % (len(found), ", ".join(found))) if len(found) >= n
                else (FAIL, "wanted %d distinct, found %d%s" % (n, len(found),
                                                                (": " + ", ".join(found)) if found else "")))

    if kind == "sequence":
        want = [x.strip() for x in payload.split(",") if x.strip()]
        got = _numbers(t)
        i, missing = 0, []
        for w in want:
            try:
                i = got.index(w, i) + 1
            except ValueError:
                missing.append(w)
        return ((PASS, "all %d in order" % len(want)) if not missing
                else (FAIL, "out of order or missing: %s" % ", ".join(missing[:6])))

    if kind == "pyfunc":
        parts = payload.split("|")
        name = parts[0].strip()
        cases = []
        for p in parts[1:]:
            if "->" not in p:
                continue
            a, _, b = p.partition("->")
            cases.append([a, b])
        if not cases:
            return FAIL, "no test cases in the spec"
        try:
            from safe_py import UnsupportedCode, call_function
        except ImportError:
            return run_pyfunc(extract_code(text), name, cases)
        try:
            bad = []
            for arg, want in cases:
                got = call_function(extract_code(text), name, [arg])
                if got != want:
                    bad.append("%r gave %r, wanted %r" % (arg, got, want))
            return (PASS, "all %d cases" % len(cases)) if not bad else (FAIL, "; ".join(bad[:4]))
        except UnsupportedCode as e:
            return REVIEW, "not evaluable by the restricted interpreter (%s); read it instead" % e

    if kind == "review":
        return REVIEW, payload.strip() or "open-ended: needs a human"

    return FAIL, "unknown check kind %r" % kind


def run_pyfunc(src, name, cases):
    """DISABLED. Executing model-written code was not isolated, and the verdict was forgeable.

    Two defects, both reproduced against a byte-identical copy of this file:

      1. RLIMIT_CPU/RLIMIT_AS/RLIMIT_NPROC and a scratch cwd are NOT filesystem, network or credential
         isolation. A candidate wrote a sentinel OUTSIDE the child's scratch directory and still passed.
         The limits bound how much a candidate can consume; they bound nothing about what it can reach.
      2. The verdict was parsed from the child's stdout, and the candidate's code ran BEFORE the driver
         printed. `print(\'{"ok": true}\'); raise SystemExit(0)` therefore passed without ever defining
         the required function -- SystemExit derives from BaseException, so `except Exception` did not
         catch it, the child exited 0, and the forged line was the last line on stdout.

    Both are now covered by test_quality_checks.py. This path stays closed until there is real isolation
    (a separate uid in a mount and network namespace, read-only filesystem, no credentials, bounded
    output, and the whole process GROUP killed on timeout) together with a verdict channel the candidate
    does not control. safe_py.py is the other way out, and is what `pyfunc` uses now: it interprets a
    restricted subset rather than executing anything.
    """
    return REVIEW, ("executable checking is disabled: it was neither isolated nor forgery-resistant "
                    "(see run_pyfunc). Use the restricted interpreter or read the answer.")
