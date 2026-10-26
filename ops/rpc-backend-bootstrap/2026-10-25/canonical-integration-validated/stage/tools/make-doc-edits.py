#!/usr/bin/env python3
"""Exact, counted doc/comment edits on top of the generated candidate (accuracy only; no behaviour). Usage: make-doc-edits.py CANDIDATE_DIR
Reads each file from commit 77d6cc859 (or the generated candidate copy when it exists), applies each replacement exactly once."""
import hashlib, json, pathlib, subprocess, sys
SRC = "/home/steven/Documents/Codex/2026-10-18/wo/work/rpc-production-final-20261025/attested-verifier-source"; C = "77d6cc859fbd3dba0fcf28d372e8fe463e5a589c"
NEW, OLD = "8250f08a7b0e1f2432ea6262903ca3203b60bca6a8e17abd6d9bccbe0dbfa378", "cc962e2b97d545930a3c2051aa6e1c5b08a6c43a4b6b8021eead462ac02c07f0"
E = {
 "docs/network/local-chain-verifier.md": [
  ('"sha256": "cc962e2b…" },', '"sha256": "8250f08a…" },'),
  ("allocation builds it, the tested Helios is the debug build `cc962e2b…`. Debug builds are slower; no optimized or\n    reproducible-release claim is made.",
   "allocation builds it, the tested Helios is the debug build `8250f08a…`: enclave-base-evm `eeffcc9` plus\n    canonical-block.patch `41667ec9` (exact-hash and canonical-ancestry block checks), built once offline with the recorded\n    debug recipe. It replaces `cc962e2b…` (`eeffcc9` without the patch), which the runtime no longer accepts. Debug builds\n    are slower; no optimized, independently reproduced or reproducible-release claim is made.")],
 "test/chain-verifier-guest.e2e.test.mjs": [("(the PINNED Helios cc962e2b and helper 4fe0cd3b, run", "(the PINNED Helios 8250f08a and helper 4fe0cd3b, run")],
 "scripts/rpc-runtime/closure.json": [
  ("so the Helios CLI built from eeffcc9 (cc962e2b) is functionally the CLI of this commit\"",
   "so this commit's helper is witness-check 4fe0cd3b; the tested Helios CLI is NOT built from this commit but from eeffcc9 + canonical-block.patch 41667ec9 (8250f08a; tested.heliosNote)\""),
  ("until then the tested Helios is the debug build cc962e2b.\"", "until then the tested Helios is a debug build (now 8250f08a, which replaced cc962e2b; tested.helios).\"")]}
def main(d):
    d = pathlib.Path(d); rec = {}
    for f, reps in E.items():
        p = d / f
        s = p.read_text() if p.exists() else subprocess.run(["git", "-C", SRC, "show", f"{C}:{f}"], check=True, capture_output=True, text=True).stdout
        for a, b in reps:
            if s.count(a) != 1: sys.exit(f"{f}: expected exactly 1 of {a[:60]!r}, found {s.count(a)}")
            s = s.replace(a, b)
        if f.endswith(".json"): json.loads(s)
        if OLD[:8] in s and f != "scripts/rpc-runtime/closure.json" and f != "docs/network/local-chain-verifier.md": sys.exit(f"{f}: old pin remains")
        p.parent.mkdir(parents=True, exist_ok=True); p.write_text(s); rec[f] = hashlib.sha256(s.encode()).hexdigest()
    print(json.dumps(rec, indent=1))
if __name__ == "__main__": main(*sys.argv[1:])
