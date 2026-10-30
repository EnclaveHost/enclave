#!/usr/bin/env python3
"""client-execution-recovery-r1 portable preparation. UNREVIEWED, NOT RUN by its author. ROOT reviews before running.

    python3 client-execution-recovery-r1/integration/prepare.py

Builds client-execution-recovery-r1/prepared/sdk/funding/ (refuses if prepared/ exists; writes nothing else):
  - the six UNCHANGED portable core files of client-site-repair-r2/candidate/sdk/funding (util, v2-store, chain-proof,
    funding-client, migration, funding-codec), each verified against that candidate's MANIFEST.json and copied byte for
    byte;
  - gas-execution.mjs = lib/gas-execution.mjs with ONLY its six import specifiers rewritten to the portable names (exact
    counts; the reverse rewrite must give back the pinned source; no "../" specifier may remain);
  - browser-entry.mjs = the successor portable entry below (the r4 entry plus explicit execution re-exports);
  - MANIFEST.json (same shape as the candidate's, so scripts/build-funding-vendor.mjs verifies it unchanged);
  - INSTALL.json: per target, must_not_exist or replaces_sha256, and the rollback action.
Every input is pinned in generated/PREPARE-PINS.json (root fills nulls; null or drift refuses). It never writes into the
candidate, the source checkout or r4.
"""
from pathlib import Path
import hashlib
import json
import re
import sys

HERE = Path(__file__).resolve().parent.parent           # client-execution-recovery-r1
UF = HERE.parent
OUT = HERE / "prepared"
CAND = "client-site-repair-r2/candidate/sdk/funding"
UNCHANGED = ["util.mjs", "v2-store.mjs", "chain-proof.mjs", "funding-client.mjs", "migration.mjs", "funding-codec.mjs"]
LIB = "client-execution-recovery-r1/lib/gas-execution.mjs"
REWRITES = [
    ('"../../../source/node_modules/viem/_esm/index.js"', '"viem"'),
    ('"../../client-r1/funding-codec.mjs"', '"./funding-codec.mjs"'),
    ('"../../client-repair-r4/lib/util.mjs"', '"./util.mjs"'),
    ('"../../client-repair-r4/lib/v2-store.mjs"', '"./v2-store.mjs"'),
    ('"../../client-repair-r4/lib/chain-proof.mjs"', '"./chain-proof.mjs"'),
    ('"../../client-repair-r4/lib/funding-client.mjs"', '"./funding-client.mjs"'),
]
ENTRY = """// Successor portable browser entry (client-execution-recovery-r1; UNREVIEWED). Every r4 export unchanged; the
// execution names below are EXPLICIT re-exports, which take precedence over the same names reached via `export *`.
export * from "./util.mjs";
export * from "./v2-store.mjs";
export * from "./funding-client.mjs";
export * from "./migration.mjs";
export {
  confirmGasFund, quoteGasFund, reconcileGasExecution, listGasExecutions, executionBlockers, classifyExecuteFailure,
  verifyStoredIntent, proveCandidate, bindReview, execId, isBlocking, EXEC_SCHEMA, CLEARED, DEFINITIVE_REFUSALS,
  MAX_DISCOVERY_BLOCKS, MAX_CANDIDATES,
} from "./gas-execution.mjs";
"""


def sha(b):
    return hashlib.sha256(b).hexdigest()


def die(m):
    sys.exit(f"prepare.py: {m}")


def main():
    pins = json.loads((HERE / "generated" / "PREPARE-PINS.json").read_text())["inputs"]
    want = {f"{CAND}/MANIFEST.json", LIB} | {f"{CAND}/{f}" for f in UNCHANGED + ["browser-entry.mjs"]}
    if set(pins) != want:
        die(f"PREPARE-PINS.json must list exactly {sorted(want)}")
    src = {}
    for rel, h in pins.items():
        if not isinstance(h, str) or not re.fullmatch(r"[0-9a-f]{64}", h):
            die(f"{rel}: no root-filled sha256 (refusing)")
        b = (UF / rel).read_bytes()
        if sha(b) != h:
            die(f"{rel}: sha256 {sha(b)} != pinned {h} (refusing)")
        src[rel] = b
    manifest = json.loads(src[f"{CAND}/MANIFEST.json"])
    for f in UNCHANGED + ["browser-entry.mjs"]:
        if manifest["files"].get(f) != sha(src[f"{CAND}/{f}"]):
            die(f"{CAND}/{f} differs from the candidate MANIFEST")
    if OUT.exists():
        die("prepared/ already exists; inspect or move it first")

    text = src[LIB].decode("utf-8")
    new = text
    for a, b in REWRITES:
        if text.count(a) != 1:
            die(f"{LIB}: {a} occurs {text.count(a)} times (expected 1)")
        if text.count(b) != 0:
            die(f"{LIB}: {b} already occurs; the rewrite would not be reversible")
        new = new.replace(a, b)
    back = new
    for a, b in reversed(REWRITES):
        back = back.replace(b, a)
    if back != text:
        die("the specifier rewrite is not exactly reversible")
    if re.search(r'''(from|import)\s*\(?\s*["'](\.\./|/|file:)''', new):
        die("a relative-parent or absolute import specifier remains")

    files = {f: src[f"{CAND}/{f}"] for f in UNCHANGED}
    files["gas-execution.mjs"] = new.encode("utf-8")
    files["browser-entry.mjs"] = ENTRY.encode("utf-8")
    out_manifest = {"schema": "client-execution-recovery-r1-funding-core/v1",
                    "source": {**{f: {"from": f"{CAND}/{f}", "sha256": pins[f"{CAND}/{f}"]} for f in UNCHANGED},
                               "gas-execution.mjs": {"from": LIB, "sha256": pins[LIB]},
                               "browser-entry.mjs": {"from": "client-execution-recovery-r1/integration/prepare.py ENTRY", "sha256": sha(ENTRY.encode("utf-8"))}},
                    "files": {f: sha(b) for f, b in sorted(files.items())}}
    files["MANIFEST.json"] = (json.dumps(out_manifest, indent=2) + "\n").encode("utf-8")
    d = OUT / "sdk" / "funding"
    d.mkdir(parents=True)
    for f, b in files.items():
        (d / f).write_bytes(b)
    install = {"schema": "client-execution-recovery-r1-install/v1",
               "note": "Install ONLY after root review: a replaced target must still have replaces_sha256, a new one must not exist. "
                       "Then rebuild site/vendor/funding.js with scripts/build-funding-vendor.mjs. Every FUNDING_* value stays null.",
               "targets": {}}
    for f, b in sorted(files.items()):
        t = f"sdk/funding/{f}"
        if f in UNCHANGED:
            install["targets"][t] = {"action": "unchanged", "sha256": sha(b)}
        elif f == "gas-execution.mjs":
            install["targets"][t] = {"action": "new", "must_not_exist": True, "sha256": sha(b), "rollback": "delete"}
        elif f == "browser-entry.mjs":
            install["targets"][t] = {"action": "replace", "replaces_sha256": pins[f"{CAND}/browser-entry.mjs"], "sha256": sha(b), "rollback": "restore the replaced bytes"}
        else:
            install["targets"][t] = {"action": "replace", "replaces_sha256": pins[f"{CAND}/MANIFEST.json"], "sha256": sha(b), "rollback": "restore the replaced bytes"}
    (OUT / "INSTALL.json").write_text(json.dumps(install, indent=2) + "\n")
    print(json.dumps(install["targets"], indent=2))


if __name__ == "__main__":
    main()
