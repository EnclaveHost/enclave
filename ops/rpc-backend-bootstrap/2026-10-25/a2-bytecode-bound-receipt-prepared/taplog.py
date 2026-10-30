#!/usr/bin/env python3
"""Strict classifier for `node --test --test-reporter=tap` output (a1-original-game mutant harness).

  taplog.py baseline LOG RC                 -> exit 0 only if rc 0, tests>0, pass==tests, fail/cancelled/skipped/todo == 0
  taplog.py killed   LOG RC BASELINE_TESTS  -> exit 0 only if the mutant is GENUINELY killed:
        rc != 0 and rc != 124 (timeout), the SAME number of tests ran as the baseline (the file loaded and every test
        executed), >= 1 failing test with `code: 'ERR_ASSERTION'` and failureType testCodeFailure, and no sign of a
        syntax/import/timeout/cancel failure (SyntaxError, ERR_MODULE_NOT_FOUND, ReferenceError, testTimeoutFailure,
        cancelledByParent, cancelled > 0).
Prints one JSON line with the counts and the verdict; never guesses on unparsable logs (exit 2)."""
import json, re, sys

BAD_MARKERS = ("SyntaxError", "ERR_MODULE_NOT_FOUND", "ReferenceError", "testTimeoutFailure", "cancelledByParent",
               "Cannot find module", "ERR_IMPORT", "is not a function")


def parse(text):
    counts = {}
    for k in ("tests", "suites", "pass", "fail", "cancelled", "skipped", "todo"):
        m = re.findall(rf"^# {k} (\d+)$", text, re.M)
        if len(m) != 1:
            raise ValueError(f"summary line '# {k}' missing or repeated ({len(m)})")
        counts[k] = int(m[0])
    # failing top-level tests and their YAML diagnostic blocks
    failures = []
    for m in re.finditer(r"^not ok \d+ - (.+?)\n  ---\n(.*?)\n  \.\.\.", text, re.M | re.S):
        diag = m.group(2)
        ft = re.search(r"failureType: '(\w+)'", diag)
        failures.append({"name": m.group(1).strip(), "failureType": ft.group(1) if ft else None,
                         "assertion": "code: 'ERR_ASSERTION'" in diag})
    return counts, failures


def main(argv):
    mode, log, rc = argv[1], argv[2], int(argv[3])
    text = open(log, encoding="utf-8", errors="replace").read()
    try:
        counts, failures = parse(text)
    except ValueError as e:
        print(json.dumps({"verdict": "unparsable", "error": str(e), "rc": rc})); return 2
    bad = [m for m in BAD_MARKERS if m in text]
    out = {"rc": rc, **counts, "failing": failures, "badMarkers": bad}
    if mode == "baseline":
        ok = (rc == 0 and counts["tests"] > 0 and counts["pass"] == counts["tests"] and counts["fail"] == 0
              and counts["cancelled"] == 0 and counts["skipped"] == 0 and counts["todo"] == 0 and not bad)
        out["verdict"] = "baseline-clean" if ok else "baseline-NOT-clean"
    elif mode == "killed":
        base = int(argv[4])
        genuine = [f for f in failures if f["assertion"] and f["failureType"] == "testCodeFailure"]
        ok = (rc not in (0, 124) and counts["tests"] == base and counts["cancelled"] == 0 and counts["skipped"] == 0
              and counts["todo"] == 0 and counts["fail"] >= 1 and len(genuine) >= 1 and len(genuine) == counts["fail"] and not bad)
        out["genuineAssertionFailures"] = len(genuine)
        out["verdict"] = "killed" if ok else ("survived" if rc == 0 else "invalid-kill")
    else:
        print(json.dumps({"verdict": "usage"})); return 2
    print(json.dumps(out, sort_keys=True))
    return 0 if out["verdict"] in ("baseline-clean", "killed") else 1


if __name__ == "__main__":
    sys.exit(main(sys.argv))
