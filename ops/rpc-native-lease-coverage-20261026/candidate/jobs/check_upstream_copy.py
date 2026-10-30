#!/usr/bin/env python3
"""derivation-lease-coverage-stage: the v3 harness's copies of upstream 5476069f code must be VERBATIM except for inserted lines that
end in `// v3-capture` (exactly EXPECTED_CAPTURE_LINES of them). Upstream is read from the pinned codeload tarball (9784e20a), never a
working tree. Usage: check_upstream_copy.py <base-5476069f.tar.gz> <derivation_harness_lease_v3.rs>   exit 0 ok, 1 differs."""
import hashlib, sys, tarfile

TARBALL_SHA256 = "9784e20a3cfeac555d96e8d1f15526d5264f0e6d8885b951c6f1220355038012"
CAPTURE = "// v3-capture"
EXPECTED_CAPTURE_LINES = 3
REGIONS = [  # (upstream file, upstream first line, upstream last line, harness BEGIN marker prefix, harness END marker)
    ("crates/proof/zk/utils/src/client.rs", "#[allow(clippy::result_large_err)]", "}",
     "// BEGIN upstream 5476069f crates/proof/zk/utils/src/client.rs advance_to_target", "// END upstream advance_to_target"),
    ("crates/proof/zk/utils/src/witness/executor.rs", "        // Install custom crypto provider for KZG point evaluation precompile",
     "        Ok((boot_clone, derived_l2_block_number, intermediate_roots))",
     "    // BEGIN upstream 5476069f crates/proof/zk/utils/src/witness/executor.rs WitnessExecutor::run body", "    // END upstream WitnessExecutor::run body"),
]


def upstream_region(text, first, last):
    lines = text.split("\n")
    starts = [i for i, l in enumerate(lines) if l == first]
    if len(starts) != 1:
        raise ValueError(f"upstream start line found {len(starts)} times: {first!r}")
    for j in range(starts[0] + 1, len(lines)):
        if lines[j] == last:
            return lines[starts[0]:j + 1]
    raise ValueError(f"upstream end line not found after {first!r}")


def harness_region(lines, begin, end):
    b = [i for i, l in enumerate(lines) if l.startswith(begin)]
    e = [i for i, l in enumerate(lines) if l == end]
    if len(b) != 1 or len(e) != 1 or e[0] <= b[0]:
        raise ValueError(f"harness region markers missing or repeated: {begin!r}")
    return lines[b[0] + 1:e[0]]


def check(tar_path, harness_text):
    raw = open(tar_path, "rb").read()
    if hashlib.sha256(raw).hexdigest() != TARBALL_SHA256:
        return ["tarball is not the pinned 9784e20a"]
    errors, captures = [], 0
    hl = harness_text.split("\n")
    with tarfile.open(tar_path, "r:gz") as tf:
        top = tf.getnames()[0].split("/")[0]
        for path, first, last, begin, end in REGIONS:
            up = upstream_region(tf.extractfile(f"{top}/{path}").read().decode(), first, last)
            mine = harness_region(hl, begin, end)
            captures += sum(1 for l in mine if l.rstrip().endswith(CAPTURE))
            kept = [l for l in mine if not l.rstrip().endswith(CAPTURE)]
            if kept != up:
                for k, (a, b) in enumerate(zip(kept, up)):
                    if a != b:
                        errors.append(f"{path}: line {k + 1} differs from upstream: {a!r} != {b!r}")
                        break
                else:
                    errors.append(f"{path}: {len(kept)} kept lines vs {len(up)} upstream lines")
    # a capture marker anywhere else would hide an edit outside the copied regions from nobody, but keep the count exact
    total = sum(1 for l in hl if l.rstrip().endswith(CAPTURE))
    if captures != EXPECTED_CAPTURE_LINES or total != EXPECTED_CAPTURE_LINES:
        errors.append(f"{total} `{CAPTURE}` lines ({captures} inside the copied regions); exactly {EXPECTED_CAPTURE_LINES} expected")
    return errors


if __name__ == "__main__":
    if len(sys.argv) != 3:
        print(__doc__); sys.exit(2)
    errs = check(sys.argv[1], open(sys.argv[2], encoding="utf-8").read())
    for e in errs:
        print("UPSTREAM-COPY:", e)
    print("upstream copy: OK (verbatim + %d capture insertions)" % EXPECTED_CAPTURE_LINES if not errs else "upstream copy: DIFFERS")
    sys.exit(1 if errs else 0)
