#!/usr/bin/env python3
"""production-grant-terms-r1 SDK candidate generator. UNREVIEWED, NOT RUN by its author. ROOT reviews before running.

    python3 production-grant-terms-r1/generator/generate_sdk.py [--link-viem]

Derives an ISOLATED copy of source/sdk/funding (S is never written) in which ONLY the gas-grant candidate literals change
to the NEW root-proposed candidate "gas-recovery-6usdc-r1" (CANDIDATE-TERMS.json; NOT human-approved, authorizes nothing):

    budget / spendPerPeriod   1_000_000n          -> 6_000_000n
    maxFeePerOp               50_000n             -> 80_000n
    maxGasUsdcPerOp           100_000n            -> 600_000n
    maxEthPerOp               20_000_000_000_000n -> 200_000_000_000_000n
    + id "gas-recovery-6usdc-r1" (not a grant field; buildGasGrant never reads it)
    migration terms           + gasCandidate: GAS_GRANT_CANDIDATE (the exact literals enter termsHash)
    comments                  "1 USDC" wording next to the literals / in the migration header

Unchanged (asserted below): maxUsdcPerEth6 2_500_000_000n, periodSeconds 86_400n, opsPerPeriod 20n, preset, action 10
only, staging+prod, measurement, MAX_GRANT_APPS 8, MAX_COMBINED6 30_000_000n, every refusal in buildGasGrant/parseSplit,
rebuildGasReview, owner controls, chain proofs, and gas-execution.mjs (unknown-outcome recovery) byte for byte.

Inputs: the eight source/sdk/funding modules, each sha256-pinned in generated/SDK-PINS.json (root-confirmed; null, drift
or rootConfirmed != true refuses). Writes ONLY production-grant-terms-r1/candidate/ and refuses if it exists.
--link-viem additionally creates ONE symlink candidate/node_modules/viem -> source/node_modules/viem (version-checked) so
the copied modules' bare "viem" import resolves to the SAME package the originals use; nothing is copied.
"""
from pathlib import Path
import hashlib
import json
import os
import re
import sys

HERE = Path(__file__).resolve().parent.parent           # production-grant-terms-r1
UF = HERE.parent                                        # unified-funding-20261028
M = "production-grant-terms-r1"
CID = "gas-recovery-6usdc-r1"
FILES = ["browser-entry.mjs", "chain-proof.mjs", "funding-client.mjs", "funding-codec.mjs", "gas-execution.mjs",
         "migration.mjs", "util.mjs", "v2-store.mjs"]
EDITED = ["funding-client.mjs", "migration.mjs"]
OUT = HERE / "candidate" / "sdk" / "funding"

# The NEW literals (must equal CANDIDATE-TERMS.json gasGrantCandidate exactly; checked below).
NEW = {"budget": 6_000_000, "spendPerPeriod": 6_000_000, "maxFeePerOp": 80_000, "maxGasUsdcPerOp": 600_000,
       "maxEthPerOp": 200_000_000_000_000}
KEEP = {"periodSeconds": 86_400, "opsPerPeriod": 20, "maxAppFeePerHour": 0, "maxRatePerHour": 0,
        "maxUsdcPerEth6": 2_500_000_000}


def sub(a, b):
    return (a, b)


def before(a, ins):
    return (a, ins + a)


def after(a, ins):
    return (a, a + ins)


OLD_LITERAL = (
    "export const GAS_GRANT_CANDIDATE = Object.freeze({\n"
    '  preset: "gas-recovery", actions: Object.freeze(["gas.fund"]), environments: Object.freeze(["staging", "prod"]),\n'
    "  budget: 1_000_000n, spendPerPeriod: 1_000_000n, periodSeconds: 86_400n, opsPerPeriod: 20n,\n"
    "  maxFeePerOp: 50_000n, maxAppFeePerHour: 0n, maxRatePerHour: 0n,\n"
    "  maxGasUsdcPerOp: 100_000n, maxUsdcPerEth6: 2_500_000_000n, maxEthPerOp: 20_000_000_000_000n, measurement: ZERO_HASH,\n"
    "});\n")
NEW_LITERAL = (
    "export const GAS_GRANT_CANDIDATE = Object.freeze({\n"
    f'  id: "{CID}",                                                       // {M}: NEW candidate\n'
    '  preset: "gas-recovery", actions: Object.freeze(["gas.fund"]), environments: Object.freeze(["staging", "prod"]),\n'
    f"  budget: 6_000_000n, spendPerPeriod: 6_000_000n, periodSeconds: 86_400n, opsPerPeriod: 20n,      // {M}\n"
    f"  maxFeePerOp: 80_000n, maxAppFeePerHour: 0n, maxRatePerHour: 0n,                                  // {M}\n"
    "  maxGasUsdcPerOp: 600_000n, maxUsdcPerEth6: 2_500_000_000n, maxEthPerOp: 200_000_000_000_000n, measurement: ZERO_HASH,"
    f"   // {M}\n"
    "});\n")

CLIENT_EDITS = [
    before("// UNREVIEWED SOURCE (unified-funding client-repair-r4; r3 + central relay wire normalisation). Browser client for\n",
           f"// DERIVED by {M}/generator/generate_sdk.py from source/sdk/funding/funding-client.mjs (sha256-pinned). The ONLY\n"
           f"// change: the gas-grant candidate literals are the NEW candidate {CID} (lines marked \"{M}\"). Root-\n"
           "// proposed, NOT human-approved; every grant built from it still needs the owner's wallet signature over its digest.\n"),
    sub("// Gas-only grants (candidate terms; reviewable, not approved). A partition part narrows these candidate terms (its own\n"
        "// budget <= 1 USDC, spendPerPeriod = its budget, opsPerPeriod <= 20); it never widens any cap.\n",
        "// Gas-only grants (candidate terms; reviewable, not approved). A partition part narrows these candidate terms (its own\n"
        "// budget <= 6 USDC, spendPerPeriod = its budget, opsPerPeriod <= 20); it never widens any cap.\n"
        f"// {M}: NEW candidate {CID} replaces the 1 USDC / 0.05 fee / 0.10 gas / 2e13 wei literals. maxUsdcPerEth6,\n"
        "// the period, the 20 ops, staging+prod, action 10, the finite <= 8 app scope and the expiry rule are unchanged.\n"),
    sub(OLD_LITERAL, NEW_LITERAL),
]
MIGRATION_EDITS = [
    before("// UNREVIEWED SOURCE (unified-funding client-repair-r4; r3 + exact legacy app-scope semantics). Resumable budget\n",
           f"// DERIVED by {M}/generator/generate_sdk.py from source/sdk/funding/migration.mjs (sha256-pinned). The ONLY\n"
           f"// changes (marked \"{M}\"): the reviewed terms carry the exact gas candidate literals, and one comment.\n"),
    sub("// exactly the reviewed 1 USDC, legacy + gas = the fresh old balance <= 30 USDC. Nothing is widened or duplicated.\n",
        f"// exactly the reviewed candidate budget (6 USDC, {M}), legacy + gas = the fresh old balance <= 30 USDC.\n"
        "// Nothing is widened or duplicated.\n"),
    after("    schema: MIGRATION_SCHEMA, chainId: CHAIN_ID, owner: evidence.owner, order, notes: STEP_NOTES,\n",
          f"    gasCandidate: GAS_GRANT_CANDIDATE,      // {M}: the exact candidate literals are part of termsHash\n"),
]
# Strings that must survive unchanged (every refusal the task requires, and no new default/override path).
KEEP_CLIENT = [
    'if (b !== T.budget) fail("gas_budget_not_candidate"',
    'if (b === 0n || b > T.budget) fail("gas_part_budget"',
    'if (ops === 0n || ops > T.opsPerPeriod) fail("gas_part_ops"',
    'appIds.length > MAX_GRANT_APPS) fail("gas_scope_apps"',
    'if (new Set(apps).size !== apps.length) fail("gas_scope_apps"',
    'fail("gas_expiry_after_legacy"',
    'fail("gas_grant_shape", "the gas grant must be exactly action 10 over staging+prod")',
    'if (lower(built.digest) !== lower(digest)) fail("review_digest_mismatch"',
    "export const MAX_GRANT_APPS = 8;",
    'if (op !== "terminate" && op !== "withdraw") fail("owner_op_unsupported"',
    'if (max * 10n ** 18n > g.maxUsdcPerEth6 * eo) fail("price_cap"',
    'if (fee > g.maxFeePerOp) fail("fee_exceeds_grant"',
    'if (max > g.maxGasUsdcPerOp) fail("gas_cap"',
    'if (eo === 0n || eo > g.maxEthPerOp) fail("eth_cap"',
    'if (total > balance6) fail("quote_exceeds_budget"',
]
KEEP_MIGRATION = [
    "export const MAX_COMBINED6 = 30_000_000n;",
    'export const MIGRATION_SCHEMA = "enclave-funding-migration-plan-r3";',
    'if (gasTotal !== T.budget) fail("gas_budget_not_candidate"',
    'if (parts.some((p) => p.budget6 > T.budget)) fail("gas_part_budget"',
    'if (opsTotal > T.opsPerPeriod) fail("gas_part_ops"',
    'fail("gas_scope_overlap"',
    'fail("gas_scope_excess"',
    'fail("gas_scope_uncovered"',
    'fail("gas_partition_required"',
    'fail("split_total", "combined budget may not exceed 30 USDC")',
    'if (legacy6 + gasTotal !== fresh6) fail("split_total"',
    'canon(["appIds", "budget6", "name", "opsPerPeriod"])',
]
# Anything that would be a silent override / widening if it appeared in the added text.
FORBIDDEN_NEW = ["\"*\"", "process.env", "localStorage", "globalThis.", "FUNDING_GAS", "override", "Infinity"]


def sha(b):
    return hashlib.sha256(b).hexdigest()


def die(m):
    sys.exit(f"generate_sdk.py: {m}")


def apply(text, edits, what):
    new = text
    for a, b in edits:
        if new.count(a) != 1:
            die(f"{what}: anchor occurs {new.count(a)} times (expected 1): {a[:80]!r}")
        if a not in b and new.count(b) != 0:
            die(f"{what}: replacement text already present")
        new = new.replace(a, b)
    back = new
    for a, b in reversed(edits):
        if back.count(b) != 1:
            die(f"{what}: replacement occurs {back.count(b)} times: {b[:80]!r}")
        back = back.replace(b, a)
    if back != text:
        die(f"{what}: reversing the edits does not give back the pinned source exactly")
    return new


def added_text(edits):
    return "".join(b.replace(a, "", 1) if a in b else b for a, b in edits)


def check_terms():
    terms_bytes = (HERE / "CANDIDATE-TERMS.json").read_bytes()
    t = json.loads(terms_bytes)
    g = t["gasGrantCandidate"]
    if t.get("id") != CID or g.get("id") != CID:
        die("CANDIDATE-TERMS.json names another candidate")
    if not str(t.get("status", "")).startswith("PROPOSED_BY_ROOT_NOT_HUMAN_APPROVED"):
        die("CANDIDATE-TERMS.json status changed; this generator only prepares the unapproved candidate")
    for k, v in {**NEW, **KEEP}.items():
        if g.get(k) != str(v):
            die(f"CANDIDATE-TERMS.json {k} = {g.get(k)!r}, generator literal {v}")
    if g["actions"] != ["gas.fund"] or g["environments"] != ["staging", "prod"] or g["preset"] != "gas-recovery":
        die("CANDIDATE-TERMS.json scope differs from the unchanged action/environment/preset")
    if g["measurement"] != "0x" + "0" * 64:
        die("CANDIDATE-TERMS.json measurement changed")
    s = t["split"]
    parts = s["parts"]
    if [p["name"] for p in parts] != ["nucbox", "metal"]:
        die("split parts must be nucbox, metal")
    gas = sum(int(p["budget6"]) for p in parts)
    if int(s["total6"]) != 30_000_000 or int(s["legacy6"]) + gas != 30_000_000 or int(s["gas6"]) != NEW["budget"] or gas != NEW["budget"]:
        die("split does not conserve exactly 30 USDC with gas = the candidate budget")
    if sum(int(p["opsPerPeriod"]) for p in parts) > KEEP["opsPerPeriod"]:
        die("split parts exceed the candidate's ops")
    got = (int(parts[0]["budget6"]), int(parts[0]["opsPerPeriod"]), int(parts[1]["budget6"]), int(parts[1]["opsPerPeriod"]))
    if got != (4_800_000, 16, 1_200_000, 4) or int(s["legacy6"]) != 24_000_000:
        die("split differs from 24 + 4.8 / 16 ops + 1.2 / 4 ops")
    pp = t["provisionalPartition"]
    for name, quoted in (("nucbox", 4_434_142), ("metal", 1_109_714)):
        ids = pp[name]["appIds"]
        if int(pp[name]["quotedMaxTotal6"]) != quoted or not 1 <= len(ids) <= 8 or len(set(ids)) != len(ids) or "*" in ids:
            die(f"provisional {name} partition malformed")
        budget = next(int(p["budget6"]) for p in parts if p["name"] == name)
        if quoted > budget:
            die(f"{name}: quoted maximum {quoted} exceeds its part budget {budget}")
    if set(pp["nucbox"]["appIds"]) & set(pp["metal"]["appIds"]):
        die("provisional partition overlaps")
    return sha(terms_bytes)


def main():
    if sys.argv[1:] not in ([], ["--link-viem"]):
        die("usage: generate_sdk.py [--link-viem]")
    link_viem = sys.argv[1:] == ["--link-viem"]
    pins = json.loads((HERE / "generated" / "SDK-PINS.json").read_text())
    if pins.get("rootConfirmed") is not True:
        die("SDK-PINS.json rootConfirmed is not true: root must hash the eight source files independently first")
    if set(pins["inputs"]) != set(FILES):
        die(f"SDK-PINS.json must list exactly {FILES}")
    src_dir = (UF / pins["source"]).resolve()
    if src_dir != (UF.parent / "source" / "sdk" / "funding").resolve():
        die(f"source must be S/sdk/funding, got {src_dir}")
    src = {}
    for f, want in pins["inputs"].items():
        if not isinstance(want, str) or not re.fullmatch(r"[0-9a-f]{64}", want):
            die(f"{f}: no root-filled sha256 (refusing)")
        b = (src_dir / f).read_bytes()
        if sha(b) != want:
            die(f"{f}: sha256 {sha(b)} != pinned {want} (refusing)")
        src[f] = b
    if (HERE / "candidate").exists():
        die("candidate/ already exists; inspect or move it first (nothing is overwritten)")
    terms_sha = check_terms()

    client = src["funding-client.mjs"].decode("utf-8")
    migration = src["migration.mjs"].decode("utf-8")
    if M in client or M in migration or CID in client or CID in migration:
        die("the pinned source already mentions this candidate")
    new_client = apply(client, CLIENT_EDITS, "funding-client.mjs")
    new_migration = apply(migration, MIGRATION_EDITS, "migration.mjs")
    for keep in KEEP_CLIENT:
        if client.count(keep) != 1 or new_client.count(keep) != 1:
            die(f"funding-client.mjs must keep {keep!r} exactly once")
    for keep in KEEP_MIGRATION:
        if migration.count(keep) != 1 or new_migration.count(keep) != 1:
            die(f"migration.mjs must keep {keep!r} exactly once")
    for what, edits in (("funding-client.mjs", CLIENT_EDITS), ("migration.mjs", MIGRATION_EDITS)):
        for bad in FORBIDDEN_NEW:
            if bad in added_text(edits):
                die(f"{what}: the edits add {bad!r}")
    # no code in the client may still carry the OLD candidate numbers
    for old in ("1_000_000n", "50_000n", "100_000n", "20_000_000_000_000n"):
        if re.search(rf"(?<!\w){re.escape(old)}", new_client):
            die(f"funding-client.mjs still contains the old literal {old}")
    if new_client.count("GAS_GRANT_CANDIDATE") != client.count("GAS_GRANT_CANDIDATE"):
        die("funding-client.mjs GAS_GRANT_CANDIDATE references changed")
    if new_migration.count("GAS_GRANT_CANDIDATE") != migration.count("GAS_GRANT_CANDIDATE") + 1:
        die("migration.mjs must gain exactly one GAS_GRANT_CANDIDATE reference (the terms field)")

    outputs = {f: src[f] for f in FILES if f not in EDITED}
    outputs["funding-client.mjs"] = new_client.encode("utf-8")
    outputs["migration.mjs"] = new_migration.encode("utf-8")
    OUT.mkdir(parents=True)
    for f, b in outputs.items():
        (OUT / f).write_bytes(b)
    for f in FILES:
        if f not in EDITED and (OUT / f).read_bytes() != src[f]:
            die(f"{f} must be byte-identical")

    viem = None
    if link_viem:
        target = (UF / pins["viem"]["path"]).resolve()
        if target != (UF.parent / "source" / "node_modules" / "viem").resolve():
            die("viem must be source/node_modules/viem")
        v = json.loads((target / "package.json").read_text())
        if v.get("name") != "viem" or v.get("version") != pins["viem"]["version"]:
            die(f"viem at {target} is {v.get('name')}@{v.get('version')}, pinned {pins['viem']['version']}")
        nm = HERE / "candidate" / "node_modules"
        nm.mkdir()
        os.symlink(target, nm / "viem", target_is_directory=True)
        viem = {"symlink": "candidate/node_modules/viem", "target": str(target), "version": v["version"]}

    gen = {"schema": f"{M}-sdk-generated/v1", "candidate": CID, "status": "UNREVIEWED_NOT_APPROVED_NOT_SIGNABLE",
           "candidateTermsSha256": terms_sha, "inputs": pins["inputs"],
           "outputs": {f"candidate/sdk/funding/{f}": sha(b) for f, b in sorted(outputs.items())},
           "byteIdentical": sorted(f for f in FILES if f not in EDITED),
           "edits": {"funding-client.mjs": len(CLIENT_EDITS), "migration.mjs": len(MIGRATION_EDITS)}, "viem": viem}
    (HERE / "candidate" / "GENERATED.json").write_text(json.dumps(gen, indent=2) + "\n")
    print(json.dumps(gen, indent=2))


if __name__ == "__main__":
    main()
