#!/usr/bin/env python3
"""migration-cutover-prep-r1 generator. UNREVIEWED, NOT RUN by its author. ROOT reviews before running.

    python3 migration-cutover-prep-r1/generator/generate_cutover.py [--link-viem]

Derives an ISOLATED copy of the QUALIFIED production-grant-terms-r1/candidate/sdk/funding (13 tests passed; its eight
output hashes from that candidate's GENERATED.json are pinned below) in which ONLY migration.mjs gains an explicit,
root-reviewed cutover mode:

  terms.cutover = { pauseAfter: "terminate", activationPlanSha256, rollbackPlanSha256, claim }   (inside termsHash)
  - buildMigrationPlan may PREPARE a cutover plan while intake is off/absent (recorded as observed, never as on)
  - terminate is sent only with the FULL plan signed (replacement + every gas part), as before never without replacement
  - the terminate proof (exact refund, canonical receipt) and a durable pause are written in ONE compare-and-set
  - nothing after terminate is admitted (runMigration returns paused; admit refuses in the same CAS) until
    resumeCutover records root-reviewed activation evidence against a live, post-termination runtime with intake open
  - reconcile / reload / rearm keep the pause; resume never sends; the claim is "termination prefix only, not a drain"

Everything else (funding-client, codec, chain proofs, gas-execution, v2-store, util, browser-entry) is byte-identical.
Nothing in S (source/) or production-grant-terms-r1/ is written. Writes ONLY migration-cutover-prep-r1/candidate/ and
refuses if it exists. --link-viem creates ONE symlink candidate/node_modules/viem -> source/node_modules/viem
(version-checked, same package the qualified candidate used); nothing is copied.
"""
from pathlib import Path
import hashlib
import json
import os
import re
import sys

HERE = Path(__file__).resolve().parent.parent            # migration-cutover-prep-r1
UF = HERE.parent                                         # unified-funding-20261028
M = "migration-cutover-prep-r1"
BASE = UF / "production-grant-terms-r1" / "candidate"
SRC = BASE / "sdk" / "funding"
OUT = HERE / "candidate" / "sdk" / "funding"
VIEM_VERSION = "2.53.1"                                  # production-grant-terms-r1/candidate/GENERATED.json "viem"

# production-grant-terms-r1/candidate/GENERATED.json "outputs" (the qualified candidate). ROOT: re-hash independently.
PINS = {
    "browser-entry.mjs": "9820589c2aab82d3ae22f2ba73011970d0754557f12da7871859f3d368bbf879",
    "chain-proof.mjs": "ca799d8f86db1dd3a7113703cba5fd929e770f02f5c63fa3f5589b05f5e074b3",
    "funding-client.mjs": "4a17b36549b5eb115863b0d08ac76e6e9dbd966934b93875bbc34fd0ea897fa7",
    "funding-codec.mjs": "ceed082639299b35073005d2ffb0ce8e5ceee1a3035804f197cdf53a4f6739d7",
    "gas-execution.mjs": "1ccf75dbd8ac248c9a139ab692f1f144b8f0f16c8e2b0334c4047ceac9b3df5c",
    "migration.mjs": "4effbfeb6c893bd897991f609a3314a054ab81070b3772e739c0e6cded9a3b8f",
    "util.mjs": "38b678a68ecf7fd897fb1ae905d27471a17d10f8061fa29d81f5870549e12e66",
    "v2-store.mjs": "b00d0742ee3d2b211b4cf811c48c8e7004dbf7e8a4cf30517db5ec199181733c",
}
EDITED = "migration.mjs"


def before(a, ins):
    return (a, ins + a)


def after(a, ins):
    return (a, a + ins)


def sub(a, b):
    return (a, b)


HEADER = (
    "// DERIVED by " + M + "/generator/generate_cutover.py from production-grant-terms-r1/candidate/sdk/funding/migration.mjs\n"
    "// (sha256-pinned). The ONLY changes (marked \"" + M + "\"): an explicit root-reviewed cutover mode (terms.cutover):\n"
    "// full-plan signatures before terminate, a durable pause written with the terminate proof, and resumeCutover.\n"
)

BLOCK = '''// =====================================================================================================================
// migration-cutover-prep-r1: explicit cutover mode. terms.cutover = { pauseAfter: "terminate", activationPlanSha256,
// rollbackPlanSha256, claim } is root-reviewed (inside termsHash). Terminate is sent only with the FULL plan signed; its
// canonical proof (exact refund) and a durable pause are written in ONE compare-and-set; nothing after terminate is
// admitted until resumeCutover records reviewed activation evidence against a live runtime verified after termination.
// The pause proves the original's refund at its own relayer nonce only; it is NOT a drain of the legacy relay process.
// resumeCutover never signs or sends; the owner signs and sends the remaining steps by explicit clicks.
// =====================================================================================================================
export const CUTOVER_CLAIM = "termination-prefix-only-not-a-relay-drain";
export const CUTOVER_ACTIVATION_SCHEMA = "enclave-funding-cutover-activation-r1";
const CUTOVER_KEYS = Object.freeze(["activationPlanSha256", "pauseAfter", "rollbackPlanSha256"]);
const ACTIVATION_KEYS = Object.freeze(["activationPlanSha256", "legacyRelayerReconciledThroughNonce", "planId", "relayer",
  "reviewedBy", "rootReviewed", "schema", "terminateBlockHash", "terminateTxHash", "termsHash"]);

/** The reviewed cutover terms. Exactly { pauseAfter: "terminate", activationPlanSha256, rollbackPlanSha256 }. */
export function cutoverTerms(c) {
  if (c === null || typeof c !== "object" || Array.isArray(c) || canon(Object.keys(c).sort()) !== canon([...CUTOVER_KEYS])) {
    fail("cutover_shape", `cutover must be exactly { ${CUTOVER_KEYS.join(", ")} }`);
  }
  if (c.pauseAfter !== "terminate") fail("cutover_shape", "the only reviewed pause point is after terminate");
  const activationPlanSha256 = parseHex32(lower(c.activationPlanSha256), "cutover.activationPlanSha256", { nonZero: true });
  const rollbackPlanSha256 = parseHex32(lower(c.rollbackPlanSha256), "cutover.rollbackPlanSha256", { nonZero: true });
  if (activationPlanSha256 === rollbackPlanSha256) fail("cutover_shape", "the activation and rollback plans must be distinct documents");
  return Object.freeze({ pauseAfter: "terminate", activationPlanSha256, rollbackPlanSha256, claim: CUTOVER_CLAIM });
}

/** true while a cutover plan may not admit anything after terminate. Fail closed: only a pause marker for THE proven
 *  terminate plus a resume record for that same transaction releases it. */
export function cutoverHeld(plan) {
  if (!plan?.terms?.cutover) return false;
  const c = plan.cutover;
  const t = plan.steps?.terminate;
  return !(c?.paused === true && c.resumed && t?.status === "proven" && c.terminate?.txHash === t.txHash
    && c.resumed.terminateTxHash === t.txHash);
}

function cutoverActivation(a) {
  if (a === null || typeof a !== "object" || Array.isArray(a) || canon(Object.keys(a).sort()) !== canon([...ACTIVATION_KEYS].sort())) {
    fail("activation_shape", `activation evidence must be exactly { ${ACTIVATION_KEYS.join(", ")} }`);
  }
  if (a.schema !== CUTOVER_ACTIVATION_SCHEMA || a.rootReviewed !== true || typeof a.reviewedBy !== "string" || a.reviewedBy.length === 0) {
    fail("activation_required", "no root-reviewed activation evidence; the cutover stays paused");
  }
  if (typeof a.planId !== "string") fail("activation_shape", "activation.planId");
  return Object.freeze({ schema: a.schema, planId: a.planId, rootReviewed: true, reviewedBy: a.reviewedBy,
    termsHash: parseHex32(lower(a.termsHash), "activation.termsHash", { nonZero: true }),
    terminateTxHash: parseHex32(lower(a.terminateTxHash), "activation.terminateTxHash", { nonZero: true }),
    terminateBlockHash: parseHex32(lower(a.terminateBlockHash), "activation.terminateBlockHash", { nonZero: true }),
    activationPlanSha256: parseHex32(lower(a.activationPlanSha256), "activation.activationPlanSha256", { nonZero: true }),
    relayer: parseAddress(a.relayer, "activation.relayer"),
    legacyRelayerReconciledThroughNonce: String(parseUint(a.legacyRelayerReconciledThroughNonce, 64, "activation.legacyRelayerReconciledThroughNonce")) });
}

/** Explicit click, after the controller stopped / reconciled the legacy relayer and activated the qualified successor.
 *  ctx.runtime must be a FRESH verifyRuntime result (chain identities, live /funding/config) taken after the terminate
 *  block, with intake open and the activation's relayer. The terminate is re-proven at its original block and must be
 *  final. Records the resume in one compare-and-set; never signs, sends or re-arms anything. */
export async function resumeCutover(ctx, planId, activation) {
  const plan = await ctx.gasStore.getJournal(planId);
  if (!plan) fail("plan_missing", "no journaled plan");
  const co = plan.terms?.cutover;
  if (!co) fail("cutover_not_planned", "this plan has no reviewed cutover pause");
  if (!cutoverHeld(plan)) fail("cutover_not_paused", "the cutover is not paused; nothing to resume");
  const t = plan.steps.terminate;
  if (t.status !== "proven" || plan.cutover?.paused !== true || plan.cutover.terminate?.txHash !== t.txHash) {
    fail("cutover_marker_missing", "no durable pause for the proven terminate; STOP for review");
  }
  const a = cutoverActivation(activation);
  if (a.planId !== planId || a.termsHash !== lower(plan.termsHash) || hashOf(plan.terms) !== plan.termsHash) {
    fail("activation_not_plan", "the activation evidence names another plan or terms");
  }
  if (a.terminateTxHash !== t.txHash || a.terminateBlockHash !== t.proof.blockHash) fail("activation_not_plan", "the activation evidence names another termination");
  if (a.activationPlanSha256 !== co.activationPlanSha256) fail("activation_not_plan", "the activation evidence is not the reviewed activation plan");
  const rt = ctx.runtime;
  if (!rt?.intake?.openEnabled) fail("intake_off", `successor open intake is not live: ${rt?.intakeWhy ?? "open disabled"}`);
  if (!sameAddr(rt.intake.relayer, a.relayer)) fail("activation_relayer_mismatch", "the live relay's relayer is not the activated one");
  if (rt.block?.number === undefined || BigInt(rt.block.number) <= BigInt(t.proof.block)) {
    fail("runtime_stale", "the runtime was not verified after the termination block; verify it again");
  }
  await recheckProven(ctx, planId, plan, "terminate");                 // throws (proof kept, still paused) if lost or moved
  const now = await ctx.gasStore.getJournal(planId);
  if (now.steps.terminate.proof?.final !== true) fail("terminate_not_final", "the termination is not final yet; still paused");
  await ctx.gasStore.casJournal(planId, (cur) => {
    if (!cur || !cutoverHeld(cur) || cur.steps.terminate.txHash !== t.txHash || cur.cutover?.paused !== true) fail("step_state", "the plan changed meanwhile");
    cur.cutover.resumed = { at: Number(ctx.now), terminateTxHash: t.txHash, runtimeBlock: Number(rt.block.number),
      activationHash: hashOf(a), activation: jsonable(a) };
    cur.rev = Number(cur.rev ?? 0) + 1;
    return cur;
  });
  return ctx.gasStore.getJournal(planId);
}

'''

EDITS = [
    before("// DERIVED by production-grant-terms-r1/generator/generate_sdk.py from source/sdk/funding/migration.mjs (sha256-pinned). The ONLY\n",
           HEADER),
    sub("export async function buildMigrationPlan({ S, evidence, runtime, scope, split, now, rng, subtle, gasStore, relayBase, gasExpiresAt }) {\n",
        "export async function buildMigrationPlan({ S, evidence, runtime, scope, split, now, rng, subtle, gasStore, relayBase, gasExpiresAt, cutover }) {\n"),
    sub('  if (!runtime.intake?.openEnabled) fail("intake_off", "successor open intake is off; no plan is built");\n',
        "  const co = cutover === undefined ? null : cutoverTerms(cutover);     // " + M + "\n"
        "  // " + M + ": a reviewed cutover plan may be PREPARED while intake is off or absent (recorded as observed, never as\n"
        "  // on); every gas send still requires live intake (preconditions), and resumeCutover requires it.\n"
        '  if (!co && !runtime.intake?.openEnabled) fail("intake_off", "successor open intake is off; no plan is built");\n'),
    after("    gasCandidate: GAS_GRANT_CANDIDATE,      // production-grant-terms-r1: the exact candidate literals are part of termsHash\n",
          "    ...(co ? { cutover: co } : {}),         // " + M + ": the reviewed pause is part of termsHash\n"),
    after("    observed: { evidence: evidence.observed, scope: { block: Number(scope.block), hash: scope.blockHash ?? null } },\n",
          "    ...(co ? { stagedIntake: runtime.intake ? { openEnabled: runtime.intake.openEnabled === true } : null,   // " + M + "\n"
          "      stagedIntakeWhy: runtime.intakeWhy ?? null } : {}),\n"),
    before('  Object.assign(st, { status: "admitted", admittedAt: Number(ctx.now), observed });\n',
           '  if (k !== "terminate" && cutoverHeld(cur)) fail("cutover_paused", `${k}: the reviewed cutover pause holds; nothing is admitted before resumeCutover`);   // ' + M + "\n"),
    sub("const markProven = (ctx, id, k, proof) => cas(ctx, id, k, (st) => {\n",
        "const markProven = (ctx, id, k, proof) => cas(ctx, id, k, (st, cur) => {\n"),
    after("  Object.assign(st, { status: \"proven\", txHash: proof.txHash, proof: { block: proof.block, blockHash: proof.blockHash, final: proof.final } });\n",
          "  // " + M + ": the durable pause is written in the SAME compare-and-set as the terminate proof\n"
          '  if (k === "terminate" && cur.terms.cutover) {\n'
          '    cur.cutover = { paused: true, after: "terminate", at: Number(ctx.now), terminate: { txHash: proof.txHash, block: proof.block, blockHash: proof.blockHash } };\n'
          "  }\n"),
    after("    if (!k) return { done: true, steps: statusOf(plan) };\n",
          '    if (k !== "terminate" && cutoverHeld(plan)) return { stage: k, paused: true, cutover: plan.cutover ?? null, steps: statusOf(plan) };   // ' + M + "\n"),
    after('      fail("replacement_unsigned", "the original is only terminated with its replacement already signed");\n    }\n',
          '    if (k === "terminate" && plan.terms.cutover && order.some((s) => signed?.[s]?.digest !== plan.steps[s].review.digest)) {   // ' + M + "\n"
          '      fail("cutover_plan_unsigned", "cutover: the original is only terminated with the FULL plan (replacement and every gas part) signed");\n'
          "    }\n"),
    before("/** A fresh review (new nonce, new window) for a step that is chain-proven void or was never admitted. Terms are\n", BLOCK),
]

# Every existing refusal / gate stays exactly once.
KEEP = [
    'fail("replacement_unsigned", "the original is only terminated with its replacement already signed")',
    'if (steps.includes("terminate") && !steps.includes("legacyOpen")) fail("sign_steps"',
    'if (st.status !== "planned") return { stage: k, needsReconcile: true, steps: statusOf(plan) };',
    'if (!ctx.runtime.intake?.openEnabled) fail("intake_off", "successor open intake is off");',
    'fail("previous_unproven", `${p} is not (still) proven`);',
    'catch (err) { await noteError(ctx, planId, k, err?.code); throw err; }   // stays admitted: ambiguous, never resent',
    "await recheckPrior(ctx, planId, plan, k);            // adoption only on a still-valid chain of earlier proofs",
    'if (!clean) fail("step_contradiction"',
    "if (finalityPolicy(ctx.finalityPolicy) && st.proof.final === true) return;",
    'export const MIGRATION_SCHEMA = "enclave-funding-migration-plan-r3";',
    "gasCandidate: GAS_GRANT_CANDIDATE,",
]
# Would be a fake intake, a relaxation, a new signing/secret path or a silent override if it appeared in added text.
FORBIDDEN_NEW = ["openEnabled: true", "openEnabled = true", "intake = ", "requireFinal", "finalityPolicy:", "walletSignTyped",
                 "signSteps(", "send(ctx", "pkcs8", "exportKey", "privateKey", "process.env", "localStorage", "globalThis.",
                 "override", "rearmStep(", "drained", "\"*\""]


def sha(b):
    return hashlib.sha256(b).hexdigest()


def die(m):
    sys.exit(f"generate_cutover.py: {m}")


def apply(text, edits):
    new = text
    for a, b in edits:
        if new.count(a) != 1:
            die(f"anchor occurs {new.count(a)} times (expected 1): {a[:90]!r}")
        if a not in b and new.count(b) != 0:
            die("replacement text already present")
        new = new.replace(a, b)
    back = new
    for a, b in reversed(edits):
        if back.count(b) != 1:
            die(f"replacement occurs {back.count(b)} times: {b[:90]!r}")
        back = back.replace(b, a)
    if back != text:
        die("reversing the edits does not give back the pinned migration.mjs exactly")
    return new


def added_text(edits):
    return "".join(b.replace(a, "", 1) if a in b else b for a, b in edits)


def main():
    if sys.argv[1:] not in ([], ["--link-viem"]):
        die("usage: generate_cutover.py [--link-viem]")
    link_viem = sys.argv[1:] == ["--link-viem"]
    gen = json.loads((BASE / "GENERATED.json").read_text())
    outs = {k.rsplit("/", 1)[1]: v for k, v in gen["outputs"].items()}
    if outs != PINS:
        die("production-grant-terms-r1/candidate/GENERATED.json outputs differ from the pins in this generator")
    src = {}
    for f, want in PINS.items():
        b = (SRC / f).read_bytes()
        if sha(b) != want:
            die(f"{f}: sha256 {sha(b)} != pinned {want} (refusing)")
        src[f] = b
    if (HERE / "candidate").exists():
        die("candidate/ already exists; inspect or move it first (nothing is overwritten)")

    text = src[EDITED].decode("utf-8")
    if M in text or "cutover" in text:
        die("the pinned migration.mjs already mentions a cutover")
    new = apply(text, EDITS)
    for keep in KEEP:
        if text.count(keep) != 1 or new.count(keep) != 1:
            die(f"migration.mjs must keep {keep!r} exactly once")
    added = added_text(EDITS)
    for bad in FORBIDDEN_NEW:
        if bad in added:
            die(f"the edits add {bad!r}")
    if re.search(r"\bsend\(", added):
        die("the edits add a send call")

    outputs = {f: src[f] for f in PINS if f != EDITED}
    outputs[EDITED] = new.encode("utf-8")
    OUT.mkdir(parents=True)
    for f, b in outputs.items():
        (OUT / f).write_bytes(b)
    for f in PINS:
        if f != EDITED and (OUT / f).read_bytes() != src[f]:
            die(f"{f} must be byte-identical")

    viem = None
    if link_viem:
        target = (UF.parent / "source" / "node_modules" / "viem").resolve()
        v = json.loads((target / "package.json").read_text())
        if v.get("name") != "viem" or v.get("version") != VIEM_VERSION:
            die(f"viem at {target} is {v.get('name')}@{v.get('version')}, pinned {VIEM_VERSION}")
        nm = HERE / "candidate" / "node_modules"
        nm.mkdir()
        os.symlink(target, nm / "viem", target_is_directory=True)
        viem = {"symlink": "candidate/node_modules/viem", "target": str(target), "version": v["version"]}

    out = {"schema": f"{M}-generated/v1", "status": "UNREVIEWED_NOT_APPROVED_NOT_SIGNABLE",
           "base": "production-grant-terms-r1/candidate/sdk/funding", "inputs": PINS,
           "outputs": {f"candidate/sdk/funding/{f}": sha(b) for f, b in sorted(outputs.items())},
           "byteIdentical": sorted(f for f in PINS if f != EDITED), "edits": {EDITED: len(EDITS)}, "viem": viem}
    (HERE / "candidate" / "GENERATED.json").write_text(json.dumps(out, indent=2) + "\n")
    print(json.dumps(out, indent=2))


if __name__ == "__main__":
    main()
