"""The lane bundle's wire-contract marker.

Its own module so a test can import and CALL it without pulling in make_graphs.py's dependencies (gguf,
numpy, the LiteRT schema). The previous test regex-scanned for these string literals instead, and an
audit disabled the payload's matching rejection with `if (false && ...)` while every assertion still
passed.

The three contracts are not interchangeable, and a payload handed the wrong one does not fail -- it feeds
the accelerator a differently-shaped operand and decodes plausible text from the answer.
"""


def bundle_magic(digit_split, digit_combine):
    """ETPUB001 plain, ETPUB002 stacked digits (one input), ETPUB003 split digits (two inputs)."""
    if digit_combine:
        return b'ETPUB003'   # two int8 digit rows as TWO graph inputs; no payload implements it yet
    if digit_split:
        return b'ETPUB002'   # two int8 digit rows stacked, ONE input, the VM recombines
    return b'ETPUB001'       # one int16 row per logical row
