#!/usr/bin/env python3
"""Check copies against PINS.json. Exit 0 = every checked file matches, 1 = a mismatch or a missing file, 2 = usage.
  verify_pins.py --work <dir containing work/>        every pinned path, as recorded
  verify_pins.py --key <pin key> --file <staged copy>   one copy root staged elsewhere (e.g. on the host)"""
import argparse, hashlib, json, os, sys

PINS = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "PINS.json")


def sha(path):
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def main(argv):
    ap = argparse.ArgumentParser()
    ap.add_argument("--work"); ap.add_argument("--key"); ap.add_argument("--file")
    o = ap.parse_args(argv)
    with open(PINS) as f:
        files = json.load(f)["files"]
    if o.key or o.file:
        if not (o.key and o.file) or o.work or o.key not in files:
            print("usage: --key <one of PINS.json files> --file <path>", file=sys.stderr); return 2
        checks = [(o.key, o.file)]
    elif o.work:
        checks = [(k, os.path.join(o.work, v["path"])) for k, v in files.items()]
    else:
        print(__doc__, file=sys.stderr); return 2
    bad = 0
    for key, path in checks:
        want = files[key]["sha256"]
        got = sha(path) if os.path.isfile(path) else None
        ok = got == want
        bad += not ok
        print(f"{'OK  ' if ok else 'FAIL'} {key} {got or 'MISSING'} {path}")
    return 1 if bad else 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
