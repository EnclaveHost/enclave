#!/usr/bin/env python3
"""check_kv.py FILE EXPECT... : check KEY=VALUE lines (vm-state.sh, pg-init-probe.sh, small remote probes).
EXPECT is key=value (equal), key~regex (re.fullmatch), or key? (print only). Exit 0 only if every check holds.
vm-state.sh prints `fsync=on synchronous_commit=on` on one line: both pairs are read."""
import re
import sys


def load(path):
    d = {}
    for line in open(path, errors="replace"):
        k, sep, v = line.rstrip("\n").partition("=")
        if not sep:
            continue
        if k == "fsync" and " synchronous_commit=" in v:
            v, _, sc = v.partition(" synchronous_commit=")
            d["synchronous_commit"] = sc
        d[k] = v.strip()
    return d


def main(argv):
    if len(argv) < 2:
        print(__doc__)
        return 2
    d, bad = load(argv[0]), 0
    for e in argv[1:]:
        if e.endswith("?"):
            print(f"  info {e[:-1]} = {d.get(e[:-1])!r}")
            continue
        m = re.fullmatch(r"([A-Za-z0-9_.]+)(=|~)(.*)", e)
        k, op, want = m.groups()
        got = d.get(k)
        ok = got is not None and (got == want if op == "=" else re.fullmatch(want, got) is not None)
        bad += not ok
        print(f"  {'ok  ' if ok else 'FAIL'} {k} {op} {want!r}   (got {got!r})")
    return 1 if bad else 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
