#!/usr/bin/env python3
"""PowerShell variables are case-INSENSITIVE ($H and $h are one variable). Report every script in which two spellings
differ only in case: an assignment to one silently replaces the other, which PowerShell's parser never reports.
Single-quoted literals ('' escapes) are skipped ($ is literal inside them). Local, no PowerShell needed.
  ps_case_lint.py scripts.json [more.json ...]   -> exit 1 on any collision
  ps_case_lint.py --text FILE                    -> one script per file"""
import json, re, sys

AUTO = {"_", "null", "true", "false"}


def strip_single_quoted(t): return re.sub(r"'(?:[^']|'')*'", "''", t)


def collisions(text):
    names = {}
    for v in re.findall(r"\$([A-Za-z_][A-Za-z0-9_]*)", strip_single_quoted(text)):
        if v.lower() not in AUTO: names.setdefault(v.lower(), set()).add(v)
    return {k: sorted(v) for k, v in names.items() if len(v) > 1}


def main(a):
    if a[:1] == ["--text"]: scripts = {f: open(f, encoding="utf-8-sig").read() for f in a[1:]}
    else: scripts = {f"{f}:{k}": v for f in a for k, v in json.load(open(f)).items()}
    bad = {k: c for k, s in scripts.items() if (c := collisions(s))}
    print(json.dumps({"scripts": len(scripts), "collisions": bad}, indent=1))
    return 1 if bad else 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
