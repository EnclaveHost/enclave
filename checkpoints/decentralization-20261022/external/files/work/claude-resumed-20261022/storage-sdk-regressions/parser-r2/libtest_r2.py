#!/usr/bin/env python3
"""parser-r2: strict parser for the Rust libtest HUMAN-READABLE output of a SERIAL run (--test-threads=1), with or
without --nocapture. It is a separate, offline post-processor. The pinned original runner (sdk_regression_runner.py
8138486d) and the live run are not modified.

Why r2 is needed: with --nocapture the test's own output continues the header line and the outcome comes later, alone
on a line. The r1 parser only accepted `test NAME ... ok` on one line, so it reported every case as missing:
    test real_fencing::real_c2_... ... [sia-s3] writer fencing: ...
    [sia-s3] ...more output...
    ok

Strict rules (any violation -> the group cannot PASS):
  - exactly one `running N test(s)` line before the first header, and N == the number of expected cases;
  - header `test NAME ... REST`:
    - REST exactly `ok` / `FAILED` / `ignored` (or `ignored, <reason>`): an inline outcome;
    - otherwise the test is OPEN and REST is its first output line;
  - while a test is open, a line that is exactly an outcome token (after removing trailing whitespace) CLOSES it;
  - a new header while a test is open -> `unclosed`; end of input or the summary while open -> `unclosed`;
  - an outcome token while no test is open -> `stray terminal`;
  - each expected name appears exactly once (duplicates, missing and unexpected names are errors), and every expected
    case must be `ok` for a pass;
  - exactly one summary `test result: ok|FAILED. P passed; F failed; I ignored; M measured; X filtered out; ...`:
    - P/F/I must equal the per-case tallies;
    - ok iff F == 0;
    - no header after it;
  - when F > 0, the final `failures:` name list must equal the FAILED set. With F == 0, any `failures:` block is an error;
  - other text outside an open test (for example `test X has been running for over 60 seconds`) is reported as a warning.

Known limits of parsing human-readable output (fail-closed, but stated):
  - A test that prints a line that is exactly `ok`/`FAILED`/`ignored` closes itself early. The real outcome then becomes
    a stray terminal and the group fails; it can only produce a false FAIL, never a false PASS, because the summary
    counts must also agree.
  - An outcome glued to unterminated output (`...textok`) is not seen as an outcome. The test stays open: unclosed, or a
    summary mismatch, so FAIL.
  - Parallel runs (--test-threads>1) interleave output and are NOT supported; the runner always used --test-threads=1.
  - The text format is libtest's, not a stable machine format. The JSON formatter (`-Z unstable-options --format json`)
    is nightly-only and was not used by the existing driver build.
"""
import re

HEADER = re.compile(r"^test (\S+) \.\.\. (.*)$")
OUTCOME = re.compile(r"^(ok|FAILED|ignored(?:, .*)?)$")
RUNNING = re.compile(r"^running (\d+) tests?$")
SUMMARY = re.compile(r"^test result: (ok|FAILED)\. (\d+) passed; (\d+) failed; (\d+) ignored; (\d+) measured; (\d+) filtered out; finished in \S+$")
FAIL_NAME = re.compile(r"^    (\S+)$")


def outcome_of(token):
    return "ignored" if token.startswith("ignored") else token


def parse(text, expected):
    """-> dict(ok: bool, errors: [...], warnings: [...], cases: {name: outcome|missing}, summary: (...) | None)"""
    errors, warnings = [], []
    outcomes = {}                       # name -> [outcome, ...]
    running = []; summary = []; open_name = None; after_summary = False
    in_failures = False; failure_lists = []; current_list = None
    lines = text.split("\n")
    if lines and lines[-1] == "": lines.pop()
    for i, raw in enumerate(lines, 1):
        line = raw.rstrip()
        h = HEADER.match(raw)
        if open_name is not None:
            if h:
                errors.append(f"line {i}: header for {h.group(1)} while {open_name} is still open (unclosed)")
                outcomes.setdefault(open_name, []).append("unclosed"); open_name = None
            elif OUTCOME.match(line):
                outcomes.setdefault(open_name, []).append(outcome_of(line)); open_name = None; continue
            elif SUMMARY.match(line):
                errors.append(f"line {i}: summary while {open_name} is still open (unclosed)")
                outcomes.setdefault(open_name, []).append("unclosed"); open_name = None
            else:
                continue                # the open test's own output
        m = RUNNING.match(line)
        if m:
            if outcomes or summary: errors.append(f"line {i}: `running` after tests started")
            running.append(int(m.group(1))); continue
        if h:
            if after_summary: errors.append(f"line {i}: test header after the summary")
            if not running: errors.append(f"line {i}: test header before any `running N tests` line")
            name, rest = h.group(1), h.group(2).rstrip()
            if OUTCOME.match(rest): outcomes.setdefault(name, []).append(outcome_of(rest))
            else: open_name = name
            in_failures = False; continue
        s = SUMMARY.match(line)
        if s:
            summary.append((s.group(1), int(s.group(2)), int(s.group(3)), int(s.group(4)))); after_summary = True; in_failures = False; continue
        if OUTCOME.match(line):
            errors.append(f"line {i}: stray terminal {line!r} outside any open test"); continue
        if line == "failures:":
            in_failures = True; current_list = []; failure_lists.append(current_list); continue
        if in_failures:
            f = FAIL_NAME.match(raw)
            if f and current_list is not None: current_list.append(f.group(1)); continue
            if line.startswith("---- ") and line.endswith(" stdout ----"):
                current_list = None; continue          # a captured-stdout block (not used with --nocapture)
            if line == "" or current_list is None: continue
        if line == "": continue
        warnings.append(f"line {i}: text outside any test: {line[:120]!r}")
    if open_name is not None:
        errors.append(f"end of output while {open_name} is still open (unclosed)"); outcomes.setdefault(open_name, []).append("unclosed")
    if len(running) != 1: errors.append(f"{len(running)} `running N tests` lines (need exactly 1)")
    elif running[0] != len(expected): errors.append(f"running {running[0]} tests, {len(expected)} expected")
    for name, outs in outcomes.items():
        if len(outs) > 1: errors.append(f"{name} reported {len(outs)} times: {outs}")
    unexpected = sorted(set(outcomes) - set(expected))
    if unexpected: errors.append(f"unexpected tests: {unexpected}")
    cases = {c: (outcomes[c][0] if c in outcomes and len(outcomes[c]) == 1 else ("missing" if c not in outcomes else "duplicate")) for c in expected}
    missing = [c for c, v in cases.items() if v == "missing"]
    if missing: errors.append(f"missing cases: {missing}")
    all_outs = [o for outs in outcomes.values() for o in outs]
    tally = (all_outs.count("ok"), all_outs.count("FAILED"), all_outs.count("ignored"))
    failed_set = sorted(n for n, outs in outcomes.items() if "FAILED" in outs)
    if len(summary) != 1: errors.append(f"{len(summary)} `test result:` lines (need exactly 1)")
    else:
        st, p, f, ig = summary[0]
        if (p, f, ig) != tally: errors.append(f"summary says {p} passed / {f} failed / {ig} ignored, the per-case lines say {tally}")
        if (st == "ok") != (f == 0): errors.append(f"summary status {st} with {f} failed")
    if failed_set:
        if not failure_lists or sorted(failure_lists[-1]) != failed_set:
            errors.append(f"failures list {failure_lists[-1] if failure_lists else None} != FAILED cases {failed_set}")
    elif failure_lists:
        errors.append("a `failures:` section with no FAILED case")
    ok = not errors and all(v == "ok" for v in cases.values())
    return {"ok": ok, "errors": errors, "warnings": warnings[:20], "cases": cases, "tally": {"ok": tally[0], "FAILED": tally[1], "ignored": tally[2]},
            "summary": list(summary[0]) if len(summary) == 1 else None, "failed": failed_set}
