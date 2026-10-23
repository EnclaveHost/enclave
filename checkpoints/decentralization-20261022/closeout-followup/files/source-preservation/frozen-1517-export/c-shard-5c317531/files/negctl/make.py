#!/usr/bin/env python3
"""make.py: the NEGATIVE CONTROL vendor tree negctl/sia-sdk-rs. It is the working vendor tree, except download.rs is the
BASELINE download.rs (commit 5c9717f, the exact source of 00e9cde0) with this tree's `mod shard_topology` tests appended
inside its test module, unchanged. So the same tests run against the old recovery code."""
import pathlib, shutil, subprocess
here = pathlib.Path(__file__).resolve().parent
root = here.parent
vendor = root / "sia-s3/vendor/sia-sdk-rs"
out = here / "sia-sdk-rs"
shutil.rmtree(out, ignore_errors=True)
shutil.copytree(vendor, out)
rel = "sia-s3/vendor/sia-sdk-rs/sia_storage/src/download.rs"
base = subprocess.run(["git", "-C", str(root), "show", f"5c9717f:{rel}"], capture_output=True, text=True, check=True).stdout
cur = (vendor / "sia_storage/src/download.rs").read_text()
start = cur.index("    /// Shard topology after `prioritize` drops sectors")
tests = cur[start:cur.rindex("}\n")]
assert base.endswith("    }\n}\n") and tests.rstrip().endswith("}")
(out / "sia_storage/src/download.rs").write_text(base[:-2] + "\n" + tests + "}\n")
print("negative-control download.rs = baseline 5c9717f +", tests.count("#[sia_core_derive::cross_target_test]"), "shard_topology tests")
