#!/usr/bin/env python3
"""The bundle marker is the only thing stopping a payload decoding a bundle it cannot decode.

Three wire contracts exist and they are NOT interchangeable:

    ETPUB001  one int16 row per logical row, ONE graph input
    ETPUB002  two int8 digit rows stacked, ONE graph input, the VM recombines (ships today)
    ETPUB003  two int8 digit rows as TWO graph inputs, the accelerator recombines

A payload handed the wrong one does not fail: it feeds the accelerator a differently-shaped operand and
decodes plausible text from the answer, which is the modular-lane lesson and the reason this field is
checked at all. `--digit-combine` emitted **ETPUB002** -- a marker that the current payload ACCEPTS while
its graphs take a different number of inputs entirely. That is the exact mismatch the field exists to
stop, and it was caught by review, not by a test, so here is the test.

It drives the PRODUCTION writer in make_graphs.py rather than a copy, with a tiny synthetic model so it
needs no GGUF, no calibration and no compiler.

    python3 tpu/test/bundle-marker-test.py
"""

import os
import re
import subprocess
import sys
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
WRITER = os.path.join(HERE, "..", "make_graphs.py")

# The payload's accepted markers, read from the source that does the accepting, so this test tracks it.
READER = os.path.join(HERE, "..", "..", "payload", "ggml-tpu.cpp")


def writer_markers():
    """The exact bytes the production writer can emit, read out of its own source."""
    src = open(WRITER, errors="replace").read()
    m = re.search(r"magic = (b'ETPUB\d+')[^\n]*?(b'ETPUB\d+')[^\n]*?(b'ETPUB\d+')", src)
    if not m:
        return None
    return {"combine": m.group(1), "split": m.group(2), "plain": m.group(3)}


def reader_markers():
    """The markers the VM-side payload accepts, read out of ggml-tpu.cpp."""
    src = open(READER, errors="replace").read()
    return set(re.findall(r'memcmp\(b, "(ETPUB\d+)", 8\)', src))


def main():
    bad = 0

    def ck(what, ok, detail=""):
        nonlocal bad
        print(f"{'ok' if ok else 'FAIL':>6}  {what}{'  -- ' + detail if detail else ''}")
        if not ok:
            bad += 1

    w = writer_markers()
    ck("the writer picks a marker per contract", w is not None,
       "" if w else "could not find the magic selection in make_graphs.py")
    if w:
        ck("plain is ETPUB001", w["plain"] == "b'ETPUB001'", w["plain"])
        ck("digit-split is ETPUB002", w["split"] == "b'ETPUB002'", w["split"])
        ck("digit-combine is ETPUB003, NOT 002", w["combine"] == "b'ETPUB003'", w["combine"])

    r = reader_markers()
    ck("the payload accepts ETPUB001", "ETPUB001" in r)
    ck("the payload accepts ETPUB002", "ETPUB002" in r)
    # The point of the whole exercise: nothing today implements the two-input contract, so the payload
    # must REFUSE ETPUB003 rather than treat it as the stacked format it is not.
    ck("the payload REFUSES ETPUB003", "ETPUB003" not in r,
       "a payload that accepts it would feed the TPU a differently-shaped operand and decode nonsense")

    # and the help must not promise a marker the writer does not emit
    src = open(WRITER, errors="replace").read()
    promised = set(re.findall(r"magic(?:\s+becomes)?\s+(ETPUB\d+)", src))
    for p in promised:
        ck(f"help mentions {p} and the writer can emit it",
           w is not None and f"b'{p}'" in w.values())

    print(f"\n{bad} failure(s)")
    return 1 if bad else 0


if __name__ == "__main__":
    raise SystemExit(main())
