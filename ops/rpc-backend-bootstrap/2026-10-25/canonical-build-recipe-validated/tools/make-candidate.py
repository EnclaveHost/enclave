#!/usr/bin/env python3
"""Candidate = the integration's 5 files (canonical-integration-actual/candidate, sha-checked against its SOURCE-FILES.sha256)
+ counted closure.json/doc edits for the source-rebuild linkage. The 4 scripts/rpc-runtime recipe files are written by
hand (reviewed) and only checked here. Usage: make-candidate.py  (rewrites the 5 integration-derived files in candidate/ from the pinned integration copies)."""
import hashlib, json, pathlib, shutil, sys
W = pathlib.Path("/home/steven/Documents/Codex/2026-10-18/wo/work/rpc-production-final-20261025"); BR = W / "canonical-build-recipe-stage"
IA = W / "canonical-integration-actual"; CAND = BR / "candidate"
sha = lambda b: hashlib.sha256(b).hexdigest()
def fail(m): sys.exit(f"make-candidate: {m}")
after = {l.split()[2]: l.split()[1] for l in (IA / "SOURCE-FILES.sha256").read_text().splitlines()}
for f, d in after.items():
    b = (IA / "candidate" / f).read_bytes()
    if sha(b) != d: fail(f"integration {f} is not {d}")
    p = CAND / f; p.parent.mkdir(parents=True, exist_ok=True); p.write_bytes(b)
# closure.json: edited as an object only if the file is exactly json.dumps(indent=1) of itself (formatting preserved)
cp = CAND / "scripts/rpc-runtime/closure.json"; s = cp.read_text(); c = json.loads(s)
if json.dumps(c, indent=1, ensure_ascii=False) + "\n" != s: fail("closure.json is not indent=1 canonical JSON")
c["purpose"] = ("Pinned inputs of the three native binaries network/rpc-runtime.mjs runs. build-binaries.sh builds them offline from exactly "
  "these: the listener from listener 5e178676, witness-check from helios ef320298, and the Helios CLI from its own tree, helios eeffcc9 "
  "plus scripts/rpc-runtime/canonical-block.patch (sources.heliosCli). A digest it produces is accepted only once it is in PINNED_BUILDS "
  "with its own test evidence: the profile and the (remapped) build paths change the digest.")
h = c["sources"]["helios"]
if set(h["binaries"]) != {"helios", "witnessCheck"}: fail("unexpected sources.helios.binaries")
h["binaries"] = {"witnessCheck": h["binaries"]["witnessCheck"]}
cli = {"what": "the Helios CLI: enclave-base-evm eeffcc9 (a16z/helios 2af9b418 + 4 patches) + canonical-block.patch (exact-hash and canonical-ancestry block checks, core and revm-utils only)",
  "commit": "eeffcc980a4a9aa092e23e07b1077c1f3fdfc95e", "tree": "2171ad2bfd3c97f2e0e029e866b1a8535cbbd187",
  "cargoLockSha256": "28f4400cef93f04c28c2a0fe012cef917937c821560387456369ee88241cabc4",
  "sourceDateEpoch": 1792720709,
  "patch": {"file": "scripts/rpc-runtime/canonical-block.patch", "sha256": "41667ec946d2f591498e4ab9d791914a6d5c886221996c5f0c920a0be39dcc31"},
  "patchedManifest": {"file": "scripts/rpc-runtime/canonical-block.PATCHED.sha256", "sha256": "7e87fad838fcccdf801fa3ee732ca878b56799f44b4d64973a2265853769b0f3",
    "check": "scripts/rpc-runtime/verify-patched-tree.py: the 15 listed files have these sha256, every other file equals eeffcc9 (git blob id and mode), nothing missing or extra"},
  "layout": "<work>/helios-cli next to <work>/helios (ef320298, witness-check only), sharing <work>/vendor-inspect/base-v1.5.1",
  "binaries": {"helios": "-p helios-cli --bin helios"},
  "tested": "8250f08a was built from exactly this source by the separate stage recipe canonical-verifier-binary-stage/jobs/build-helios.sh (dev profile, debuginfo off, NO path remap, absolute stage paths, cache reuse; root-canonical-helios-build-0046), not by build-binaries.sh. build-binaries.sh remaps paths, so its build of the same source is expected to have a different digest; no identical-hash claim is made without an independent rebuild."}
c["sources"] = {k: v for k0, v0 in c["sources"].items() for k, v in ([(k0, v0), ("heliosCli", cli)] if k0 == "helios" else [(k0, v0)])}
cp.write_text(json.dumps(c, indent=1, ensure_ascii=False) + "\n")
dp = CAND / "docs/network/local-chain-verifier.md"; d = dp.read_text()
E = [("scripts/rpc-runtime/build-binaries.sh <new-work-dir> <helios repo with ef320298> <listener repo with 5e178676> \\",
      "scripts/rpc-runtime/build-binaries.sh <new-work-dir> <helios repo with ef320298 and eeffcc9> <listener repo with 5e178676> \\"),
     ("  (`<work>/vendor-inspect/base-v1.5.1`). No unrecorded local tree is read.\n",
      "  (`<work>/vendor-inspect/base-v1.5.1`). No unrecorded local tree is read.\n"
      "- The Helios CLI has its own tree: `eeffcc9` plus `scripts/rpc-runtime/canonical-block.patch` (`41667ec9…`, pinned in the\n"
      "  script), applied with exact context and checked file by file (`canonical-block.PATCHED.sha256`,\n"
      "  `verify-patched-tree.py`: every other file equals `eeffcc9`, nothing missing or extra). witness-check is still built\n"
      "  from `ef320298` and the listener from `5e178676`. A wrong commit, tree, patch, manifest or Cargo.lock stops the build.\n"
      "- The accepted Helios `8250f08a…` was built from the same source by a separate stage recipe (dev profile, debuginfo off,\n"
      "  unremapped absolute build paths). This script remaps paths, so its build is expected to have a different digest; no\n"
      "  identical-hash claim is made, and any new digest needs its own `PINNED_BUILDS` entry and tests.\n")]
for a, b in E:
    if d.count(a) != 1: fail(f"docs: expected exactly 1 of {a[:50]!r}, found {d.count(a)}")
    d = d.replace(a, b)
dp.write_text(d)
for f in ["build-binaries.sh", "verify-patched-tree.py", "canonical-block.patch", "canonical-block.PATCHED.sha256"]:
    if not (CAND / "scripts/rpc-runtime" / f).is_file(): fail(f"missing reviewed recipe file {f}")
print("candidate written")
