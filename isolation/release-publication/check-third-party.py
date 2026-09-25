#!/usr/bin/env python3
"""check-third-party.py -- does a new domain release carry EXACTLY the third-party bytes of a release whose inventory,
notices and corresponding source are already prepared? If it does, those materials apply to it unchanged, and only
Enclave's own files need a note.

    check-third-party.py <new release dir> --expect <new id> <reference release dir> --reference-id <id>

Both releases are verified against their ids first (release-manifest.py's rules: canonical release.json, every file
listed and matching, nothing unlisted). Then every file is compared. The files built from THIS repository may differ
(template/init, template/front, template/rt/runtime.json); any other difference -- the firmware, the kernel, a module,
wasmtime, a library, or a file added or removed -- fails, because the prepared notices would not cover it. The kernel
command line and the measurement parameters must match too: they are not third-party, but a change there is a
different kind of release and should be reviewed as one.

What this does NOT cover: third-party code statically linked INTO those own files. template/init carries a libc (glibc's
libc.a before aa6c985c, musl's from then on) and GCC runtime objects; template/front carries the Go standard library and
runtime. A SAME here says nothing about them; they are inventoried separately (the release's INVENTORY.md: link map,
go version -m).
"""
import argparse, hashlib, json, os, subprocess, sys

OWN = {"template/init", "template/front", "template/rt/runtime.json"}
ap = argparse.ArgumentParser()
ap.add_argument("new"); ap.add_argument("--expect", required=True)
ap.add_argument("reference"); ap.add_argument("--reference-id", required=True)
a = ap.parse_args()
here = os.path.dirname(os.path.abspath(__file__))
rm = os.path.join(here, "..", "m4", "release-manifest.py")

def verified(d, rid):
    r = subprocess.run([sys.executable, rm, "verify", d, "--expect", rid], capture_output=True, text=True)
    if r.returncode != 0: sys.exit(f"REFUSED: {d} does not verify as {rid}: {r.stdout}{r.stderr}")
    return json.load(open(os.path.join(d, "release.json")))

n, o = verified(a.new, a.expect), verified(a.reference, a.reference_id)
bad = []
for k in ("cmdline", "dirs", "format", "measure"):
    if n[k] != o[k]: bad.append(f"{k}: {o[k]!r} -> {n[k]!r}")
own = []
for f in sorted(set(n["files"]) | set(o["files"])):
    x, y = o["files"].get(f), n["files"].get(f)
    if x == y: continue
    line = f"{f}: {(x or {}).get('sha256', 'absent')[:16]} -> {(y or {}).get('sha256', 'absent')[:16]}"
    (own if f in OWN and x and y else bad).append(line)
print(f"new {a.expect[:16]}… against reference {a.reference_id[:16]}…: {len(n['files'])} files")
for l in own: print("  own code (expected to differ):", l)
if bad:
    for l in bad: print("  THIRD-PARTY OR RELEASE-SHAPE DIFFERENCE:", l)
    sys.exit("DIFFERENT: the prepared third-party materials do not cover this release as they stand")
print("SAME third-party bytes: every file other than Enclave's own is byte-identical, and so are the cmdline and measure parameters")
