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
import json
import os
import re
import subprocess
import sys
import tempfile

SMOKE, PASS, FAIL, REVIEW = "SMOKE", "PASS", "FAIL", "REVIEW"

# The driver that runs inside the bounded child. It defines the candidate code, then calls the function.
_DRIVER = r'''
import json, resource, sys
resource.setrlimit(resource.RLIMIT_CPU, (5, 5))
resource.setrlimit(resource.RLIMIT_AS, (512 << 20, 512 << 20))
resource.setrlimit(resource.RLIMIT_NPROC, (64, 64))
src, name, cases = json.load(open(sys.argv[1]))
ns = {}
try:
    exec(compile(src, "<candidate>", "exec"), ns)
except Exception as e:
    print(json.dumps({"ok": False, "why": "the code did not run: %s: %s" % (type(e).__name__, e)})); sys.exit(0)
fn = ns.get(name)
if not callable(fn):
    print(json.dumps({"ok": False, "why": "no callable named %r was defined" % name})); sys.exit(0)
bad = []
for arg, want in cases:
    try:
        got = fn(arg)
    except Exception as e:
        bad.append("%r raised %s: %s" % (arg, type(e).__name__, e)); continue
    if got != want:
        bad.append("%r gave %r, wanted %r" % (arg, got, want))
print(json.dumps({"ok": not bad, "why": "; ".join(bad[:4])}))
'''


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
        return run_pyfunc(extract_code(text), name, cases)

    if kind == "review":
        return REVIEW, payload.strip() or "open-ended: needs a human"

    return FAIL, "unknown check kind %r" % kind


def run_pyfunc(src, name, cases):
    with tempfile.TemporaryDirectory() as d:
        try:
            ast.parse(src)
        except SyntaxError as e:
            return FAIL, "the reply is not valid Python: %s" % e
        argf = os.path.join(d, "a.json")
        with open(argf, "w") as f:
            json.dump([src, name, cases], f)
        drv = os.path.join(d, "drv.py")
        with open(drv, "w") as f:
            f.write(_DRIVER)
        try:
            r = subprocess.run([sys.executable, drv, argf], capture_output=True, text=True,
                               timeout=20, cwd=d, stdin=subprocess.DEVNULL)
        except subprocess.TimeoutExpired:
            return FAIL, "the code did not finish within 20 s"
        if r.returncode != 0:
            return FAIL, "the checker exited %d: %s" % (r.returncode, (r.stderr or "").strip()[:120])
        try:
            out = json.loads(r.stdout.strip().splitlines()[-1])
        except (ValueError, IndexError):
            return FAIL, "the checker produced no verdict: %s" % (r.stdout or r.stderr)[:120]
        return (PASS, "all %d cases" % len(cases)) if out["ok"] else (FAIL, out["why"])
