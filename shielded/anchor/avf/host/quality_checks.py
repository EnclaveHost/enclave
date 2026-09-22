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

    exact=<value>                           the WHOLE reply, normalised, must equal this
    exactset=<n>:<a,b,c,...>                the whole reply must be exactly n distinct members of the list
    contains=<regex>                        SMOKE only
    distinct=<n>:<...>                      SMOKE only -- presence, which a negation defeats
    numeric=<value>                         the reply must contain exactly this number as a standalone token
    distinct=<n>:<a,b,c,...>                at least n DISTINCT members of the list
    sequence=<a,b,c,...>                    these values, in this order, each as a standalone number
    pyfunc=<name>|<in>-><out>|<in>-><out>   extract Python, define <name>, run the cases, all must match
    review=<what a human should check>      REVIEW

**Presence is not correctness.** An audit showed `distinct=1:Rayleigh` passing "Rayleigh invented blue
paint", `distinct=1:Paris` passing "Paris is not the capital of France; London is", and `numeric=391`
passing "391 is wrong; the answer is 400". A keyword appearing in a sentence says nothing about what the
sentence asserts, and no amount of regex fixes that. So `distinct` and `contains` are SMOKE and can never
be correctness; `numeric` now requires the reply to contain that number and NO OTHER; and tasks that can
be answered in a bare form use `exact`/`exactset`, which compare the whole normalised reply. A task that
cannot be pinned to a bare answer -- an explanation, a poem -- is `review`, for a human.

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


def _normalise(s):
    """Lower-case, strip markdown emphasis, surrounding quotes and trailing punctuation."""
    s = s.strip().strip("*_`\"'")
    s = re.sub(r"[.!?,;:]+$", "", s.strip())
    return " ".join(s.lower().split())


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
        got = _numbers(t)
        uniq = sorted(set(got))
        if want not in uniq:
            return FAIL, "%s not present (found %s)" % (want, ", ".join(uniq) or "no number")
        if len(uniq) > 1:
            # "391 is wrong; the answer is 400" contains 391 and still asserts something else
            return FAIL, "the reply contains other numbers too (%s), so its claim is ambiguous" % ", ".join(uniq)
        return PASS, "the only number in the reply is %s" % want

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
        if len(found) < n:
            return FAIL, "wanted %d distinct, found %d%s" % (n, len(found),
                                                             (": " + ", ".join(found)) if found else "")
        return SMOKE, ("%d present (%s) -- PRESENCE ONLY, not correctness: a negation defeats it"
                       % (len(found), ", ".join(found)))

    if kind == "sequence":
        want = [x.strip() for x in payload.split(",") if x.strip()]
        got = _numbers(t)
        if got == want:
            return PASS, "exactly the %d expected numbers, in order" % len(want)
        return FAIL, "expected exactly %s, got %s" % (", ".join(want), ", ".join(got) or "no number")

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

    if kind == "exact":
        want = payload.strip()
        got = _normalise(t)
        return ((PASS, "the reply is exactly %r" % want) if got == _normalise(want)
                else (FAIL, "the whole reply had to be %r; it was %r" % (want, t.strip()[:80])))

    if kind == "exactset":
        n, _, items = payload.partition(":")
        try:
            n = int(n)
        except ValueError:
            return FAIL, "bad exactset spec"
        allowed = {_normalise(x) for x in items.split(",") if x.strip()}
        parts = [_normalise(x) for x in re.split(r"[,\n;]| and ", t) if _normalise(x)]
        if len(parts) != n:
            return FAIL, "expected exactly %d items, the reply had %d (%s)" % (n, len(parts),
                                                                               ", ".join(parts[:6]))
        if len(set(parts)) != n:
            return FAIL, "the %d items are not distinct: %s" % (n, ", ".join(parts))
        bad = [x for x in parts if x not in allowed]
        return (PASS, "%d distinct and all valid" % n) if not bad else (FAIL, "not valid: %s" % ", ".join(bad))

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
