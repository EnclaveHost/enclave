#!/usr/bin/env python3
"""
export-calib.py -- calibrate.py's .npz -> the flat text the C backend reads.

The engine-side backend deliberately does not parse npz, or JSON: it is linked
inside the measured CVM and its input is an operator-supplied file, so the parser
is a few lines of scanf over a format with no nesting rather than a dependency
with a CVE history. Losing nothing matters here -- the file carries two public
constants per site and both are checked against the model at registration.

    site <tensor-name> <act_frac> <n_outliers> [channel ...]

Names are GGUF tensor names, so they match ggml's tensors directly. q/k/v are
calibrated under attn_q and gate/up under ffn_gate, because they share an
activation; the backend resolves that mapping itself.

    python3 export-calib.py model.calib.npz > model.calib
"""
import json
import sys

import numpy as np


def main():
    if len(sys.argv) < 2:
        sys.exit(__doc__.strip())
    z = np.load(sys.argv[1], allow_pickle=False)
    meta = json.loads(bytes(z["__meta__"]).decode())
    out = sys.stdout if len(sys.argv) < 3 else open(sys.argv[2], "w")

    print("# shielded-calib 1", file=out)
    print(f"# from {sys.argv[1]}: {len(meta['act_frac'])} sites, "
          f"reference exponent {meta.get('ref_af')}", file=out)
    for name, af in sorted(meta["act_frac"].items()):
        key = name + "|outliers"
        idx = z[key] if key in z.files else np.zeros(0, dtype=np.int64)
        idx = np.asarray(idx, dtype=np.int64).ravel()
        print(f"site {name} {int(af)} {idx.size}"
              + ("" if idx.size == 0 else " " + " ".join(str(int(i)) for i in idx)),
              file=out)
    if out is not sys.stdout:
        out.close()


if __name__ == "__main__":
    main()
