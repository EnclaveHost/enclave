#!/usr/bin/env python3
"""Generate the attested-verifier-source update for a NEW canonical Helios (AFTER the actual build; never before).
Usage: make-source-update.py <build-run-dir>/out OUT_DIR
Reads the actual artifact sha from out/provenance.json AND re-hashes out/helios (must match out/SHA256SUMS); takes the
three files from commit 77d6cc859 (git show, read-only; the worktree is not touched), applies exact counted replacements
and writes OUT_DIR/{the three files, update.diff, UPDATE.json}. Root reviews and commits; this script commits nothing.
The OLD cc962e2b entry is REPLACED (not kept) in PINNED_BUILDS, so the runtime refuses the uncorrected Helios."""
import difflib, hashlib, json, pathlib, re, subprocess, sys
SRC = "/home/steven/Documents/Codex/2026-10-18/wo/work/rpc-production-final-20261025/attested-verifier-source"
COMMIT, OLD = "77d6cc859fbd3dba0fcf28d372e8fe463e5a589c", "cc962e2b97d545930a3c2051aa6e1c5b08a6c43a4b6b8021eead462ac02c07f0"
FILES = {"metal/chain-verifier-image.json": "23ac96adb0c6728ab48627e45b150845ef93690f73dba70da60ab6cf79dea964",
         "network/rpc-runtime.mjs": "ed7054cbada3c6d8fc783c5cb290be4fb6cb244126af8b27637130ed38856d10",
         "scripts/rpc-runtime/closure.json": "92ff59d118002d921f213f476bd07b6ce344af96a300564ea77181703206fef4"}
MANUAL = ["docs/network/local-chain-verifier.md:63,120 (example pin and 'the tested Helios is the debug build cc962e2b')",
          "test/chain-verifier-guest.e2e.test.mjs:4 (comment naming cc962e2b)",
          "scripts/rpc-runtime/closure.json:27 (ef320298 note) and :62 (release-blocked history): historical, review wording only"]
def main(out, dst):
    out, dst = pathlib.Path(out), pathlib.Path(dst)
    prov = json.loads((out / "provenance.json").read_text()); new = prov["artifact"]["sha256"]
    if not re.fullmatch(r"[0-9a-f]{64}", new) or new == OLD: sys.exit(f"bad artifact sha {new!r}")
    if hashlib.sha256((out / "helios").read_bytes()).hexdigest() != new: sys.exit("out/helios does not hash to provenance.json")
    if f"{new}  helios" not in (out / "SHA256SUMS").read_text().splitlines(): sys.exit("out/SHA256SUMS does not list it")
    if prov["source"]["baseCommit"] != "eeffcc980a4a9aa092e23e07b1077c1f3fdfc95e" or not prov["source"]["patch"]["sha256"].startswith("41667ec9"):
        sys.exit("provenance is not eeffcc9 + canonical-block.patch 41667ec9")
    if dst.exists(): sys.exit(f"{dst} exists (fresh output dir only)")
    desc = (f"helios enclave-base-evm eeffcc9 + canonical-block.patch 41667ec9 (exact-hash canonical block checks), "
            f"base/base v1.5.1 EVM, Rust 1.96.0, debug profile (not an optimized release); build {out.parent.name}")
    edits = {
     "metal/chain-verifier-image.json": [(f'"sha256": "{OLD}"', f'"sha256": "{new}"', 1),
       ('"helios": "Helios enclave-base-evm eeffcc9 (CLI identical in function through ef320298), DEBUG profile',
        '"helios": "Helios enclave-base-evm eeffcc9 + canonical-block.patch 41667ec9, DEBUG profile', 1)],
     # the new key is QUOTED: a digest may start with a digit (the listener entry is quoted the same way)
     "network/rpc-runtime.mjs": [(re.compile(rf"^    {OLD}: '[^'\n]*',$", re.M), f"    '{new}': '{desc}',", 1)],
     "scripts/rpc-runtime/closure.json": [(f'"helios": "{OLD}"', f'"helios": "{new}"', 1),
       ('"heliosNote": "cc962e2b was built from eeffcc9; later commits through ef320298 change only the witness-check helper"',
        f'"heliosNote": "{new[:8]} was built from eeffcc9 + canonical-block.patch 41667ec9 ({out.parent.name}, provenance.json); it replaces cc962e2b (eeffcc9 without the patch)"', 1)]}
    dst.mkdir(parents=True); diff, rec = [], {"commit": COMMIT, "newHelios": new, "replaces": OLD, "files": {}, "manualReview": MANUAL}
    for f, pin in FILES.items():
        old = subprocess.run(["git", "-C", SRC, "show", f"{COMMIT}:{f}"], check=True, capture_output=True).stdout
        if hashlib.sha256(old).hexdigest() != pin: sys.exit(f"{f} at {COMMIT} is not {pin}")
        s = old.decode()
        for a, b, n in edits[f]:
            c = len(a.findall(s)) if hasattr(a, "findall") else s.count(a)
            if c != n: sys.exit(f"{f}: expected {n} match(es) of {getattr(a, 'pattern', a)!r}, found {c}")
            s = a.sub(lambda m: b, s) if hasattr(a, "sub") else s.replace(a, b)
        if f.endswith(".json"): json.loads(s)
        if OLD in s and f != "scripts/rpc-runtime/closure.json": sys.exit(f"{f}: old pin still present")
        p = dst / f; p.parent.mkdir(parents=True, exist_ok=True); p.write_text(s)
        rec["files"][f] = {"before": pin, "after": hashlib.sha256(s.encode()).hexdigest()}
        diff += difflib.unified_diff(old.decode().splitlines(True), s.splitlines(True), f"a/{f}", f"b/{f}")
    (dst / "update.diff").write_text("".join(diff)); (dst / "UPDATE.json").write_text(json.dumps(rec, indent=1) + "\n")
    print(json.dumps(rec, indent=1))
if __name__ == "__main__":
    if len(sys.argv) != 3: sys.exit(__doc__)
    main(*sys.argv[1:])
