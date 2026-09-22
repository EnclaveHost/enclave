#!/usr/bin/env python3
"""Markers, checked by RUNNING both sides -- the writer's decision and the payload's rejection.

Three wire contracts exist and they are not interchangeable:

    ETPUB001  one int16 row per logical row, ONE graph input
    ETPUB002  two int8 digit rows stacked, ONE graph input, the VM recombines (ships today)
    ETPUB003  two int8 digit rows as TWO graph inputs, the accelerator recombines

A payload handed the wrong one does not fail: it feeds the accelerator a differently-shaped operand and
decodes plausible text from the answer. `--digit-combine` emitted ETPUB002 -- a marker the current
payload ACCEPTS -- which is exactly that mismatch.

**The previous version of this file was not a test.** It regex-scanned the writer and the reader for
string literals. An audit disabled the payload's rejection with `if (false && !bundle_ds && ...)`, which
removes the protection entirely, and every assertion here still passed. So it now:

  * calls the production writer's `bundle_magic()` for all four flag combinations, and
  * compiles and calls the payload's own `bundle_classify()` from payload/bundlemagic.h on the bytes the
    writer produced.

Inverting or removing either decision makes this fail. It needs no GGUF, no calibration, no compiler and
no device.

    python3 tpu/test/bundle-marker-test.py
"""

import ctypes
import os
import subprocess
import sys
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, ".."))

PLAIN, DIGIT_SPLIT, REJECT = 0, 1, 2
NAMES = {PLAIN: "PLAIN", DIGIT_SPLIT: "DIGIT_SPLIT", REJECT: "REJECT"}


def load_classifier():
    """Compile payload/bundlemagic.h into a shared object and return its bundle_classify."""
    src = os.path.join(tempfile.mkdtemp(), "shim.c")
    with open(src, "w") as f:
        f.write('#include "bundlemagic.h"\n'
                'int classify(const void *p) { return (int)bundle_classify(p); }\n')
    so = src.replace(".c", ".so")
    r = subprocess.run(["cc", "-shared", "-fPIC", "-O1", f"-I{os.path.join(HERE, '..', '..', 'payload')}",
                        src, "-o", so], capture_output=True, text=True)
    if r.returncode != 0:
        print("could not build the classifier shim:\n" + r.stderr[:400])
        return None
    lib = ctypes.CDLL(so)
    lib.classify.argtypes = [ctypes.c_char_p]
    lib.classify.restype = ctypes.c_int
    return lib.classify


def main():
    bad = 0

    def ck(what, ok, detail=""):
        nonlocal bad
        print(f"{'ok' if ok else 'FAIL':>6}  {what}{'  -- ' + detail if detail else ''}")
        if not ok:
            bad += 1

    try:
        from bundle_magic import bundle_magic         # noqa: E402  the PRODUCTION decision
    except Exception as e:  # noqa: BLE001
        print(f"could not import the writer: {e}")
        return 1
    # and make_graphs must actually USE it, or this tests a function nothing calls
    mg = open(os.path.join(HERE, "..", "make_graphs.py"), errors="replace").read()
    ck("make_graphs.py writes the bundle using bundle_magic()",
       "bundle_magic(A.digit_split, A.digit_combine)" in mg,
       "structural, and the only part of this test that is not executed")

    classify = load_classifier()
    if classify is None:
        return 1

    # (digit_split, digit_combine) -> the marker the writer must emit, and how the payload must treat it
    cases = [
        ((False, False), b"ETPUB001", PLAIN),
        ((True, False), b"ETPUB002", DIGIT_SPLIT),
        ((True, True), b"ETPUB003", REJECT),
        ((False, True), b"ETPUB003", REJECT),   # combine implies split; the marker must not fall back to 002
    ]
    for (split, combine), want_magic, want_kind in cases:
        got = bundle_magic(split, combine)
        ck(f"writer(split={split!s:5} combine={combine!s:5}) emits {want_magic.decode()}",
           got == want_magic, got.decode())
        kind = classify(got)
        ck(f"  payload classifies {got.decode()} as {NAMES[want_kind]}",
           kind == want_kind, NAMES.get(kind, kind))

    # the whole point: a bundle the payload cannot decode must be REFUSED, not silently accepted
    ck("ETPUB003 is REFUSED by the payload", classify(b"ETPUB003") == REJECT,
       "accepting it would feed the accelerator a differently-shaped operand")
    for junk in (b"ETPUB000", b"ETPUB004", b"\0" * 8, b"ETPUB00", b"XXXXXXXX"):
        ck(f"  unknown marker {junk[:8]!r} is REFUSED", classify(junk.ljust(8, b"\0")) == REJECT)

    print(f"\n{bad} failure(s)")
    return 1 if bad else 0


if __name__ == "__main__":
    raise SystemExit(main())
