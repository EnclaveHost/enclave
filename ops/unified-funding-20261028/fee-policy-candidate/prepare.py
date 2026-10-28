#!/usr/bin/env python3
"""fee-policy-r1 prepare.py. UNREVIEWED SOURCE: its author executed nothing (no python, no node, no tests).

Deterministic generation of ISOLATED copies that wire the gas.fund fee envelope seam. Writes ONLY inside this stage:

  generated/relay/sessions.mjs       host-queue-r1/patched/relay/sessions.mjs (sha256-pinned) + marked fee-policy-r1 hunks:
                                     TxQueue._send honours an optional `envelope` (gas, fees, replacements, size, attempts,
                                     deadline), simulateAndSend forwards it, and the funding route's callback declares the
                                     guard. A send WITHOUT an envelope (every original/nongas op) runs the original lines.
  generated/relay/funding-route.mjs  host-queue-r1/patched/relay/funding-route.mjs (sha256-pinned) + marked hunks: v2
                                     policy + declared queue guard required for activation; quote returns the fee's
                                     components; execute builds the post-signature envelope and passes it to the queue.
  generated/relay/funding-abi.mjs    byte copy (sha256-pinned)
  generated/relay/fee-policy.mjs     ./fee-policy.mjs with its viem import rewritten to the bare specifier
  generated/relay/sessions-abi.mjs   symlink -> source/relay/sessions-abi.mjs   (read-only import)
  generated/relay/snp-verify.mjs     symlink -> source/relay/snp-verify.mjs     (read-only import)
  generated/node_modules             symlink -> source/node_modules              (viem)
  generated/PREPARE-MANIFEST.json    sha256 of every input, output and hunk

Every hunk's `before` must occur exactly once; after patching, undoing every hunk must give the input byte for byte.
Nothing outside this stage is written; host-queue-r1 and source/ are only read. Activation stays OFF: no hunk wires a
quote policy into the host bootstrap (o.fundingQuotePolicy stays unset by main()).

  python3 prepare.py --accept-unpinned          write the outputs
  python3 prepare.py --check --accept-unpinned  write nothing; exit 1 if anything is missing or differs

fee-policy.mjs is this stage's own unreviewed source; its sha256 could not be computed by its author (no commands), so it
is not pinned (POLICY_SHA256 = "32bcf03ea52db9be70d86e957dd440c1697daf0eaeab79f732378002d4f2bcfd"): --accept-unpinned is REQUIRED and the observed hash is recorded under "unpinned".
"""
import hashlib
import json
import os
import sys

STAGE = os.path.dirname(os.path.realpath(__file__))
UF = os.path.dirname(STAGE)                                   # unified-funding-20261028
SOURCE = os.path.abspath(os.path.join(STAGE, "..", "..", ".."))
HQ = os.path.join(UF, "host-queue-candidate")
HQ_MANIFEST = os.path.join(HQ, "generated", "PREPARE-MANIFEST.json")
# host-queue-r1/generated/PREPARE-MANIFEST.json "outputs", as read when this stage was written
HQ_PINS = {
    "patched/relay/sessions.mjs": "eb0f5543f2d16bc846ab158b291d26379dc32a7e11461946b1c3537f1b9cd7ba",
    "patched/relay/funding-route.mjs": "87e6df639df4569d6a5c44439d0448a4fe3ce4c2580c2b7e997baab61f5aa7bc",
    "patched/relay/funding-abi.mjs": "93a951752cbcbdbd01537965f3d540a43fc796665f1a77e87791c9b2e555198a",
}
POLICY_SRC = os.path.join(STAGE, "fee-policy.mjs")
POLICY_SHA256 = "32bcf03ea52db9be70d86e957dd440c1697daf0eaeab79f732378002d4f2bcfd"               # root: pin after review
POLICY_REWRITE = ('from "viem";', 'from "viem";')
MARK = "fee-policy-r1"
SYMLINKS = {
    "generated/relay/sessions-abi.mjs": os.path.join(SOURCE, "relay", "sessions-abi.mjs"),
    "generated/relay/snp-verify.mjs": os.path.join(SOURCE, "relay", "snp-verify.mjs"),
    "generated/node_modules": os.path.join(SOURCE, "node_modules"),
}

HEADER = (
    f"// >>> {MARK} GENERATED COPY by fee-policy-r1/prepare.py from host-queue-r1/patched/relay/sessions.mjs (sha256\n"
    f"// {HQ_PINS['patched/relay/sessions.mjs']}). Every change is a marked {MARK} hunk; undoing them gives the input.\n"
    f"// <<< {MARK}\n"
)
ROUTE_HEADER = (
    f"// >>> {MARK} GENERATED COPY by fee-policy-r1/prepare.py from host-queue-r1/patched/relay/funding-route.mjs (sha256\n"
    f"// {HQ_PINS['patched/relay/funding-route.mjs']}). Every change is a marked {MARK} hunk; undoing them gives the input.\n"
    f"// <<< {MARK}\n"
)

# ---------------------------------------------------------------------------------------------------------------------
# sessions.mjs hunks
# ---------------------------------------------------------------------------------------------------------------------
S_IMPORT = (r'''import { createFundingRoute, fundingManifestFromEnv } from "./funding-route.mjs";
// <<< funding-r2
''', r'''import { createFundingRoute, fundingManifestFromEnv } from "./funding-route.mjs";
// <<< funding-r2
// >>> fee-policy-r1 (the gas.fund transaction envelope this queue enforces; inert unless a send carries an envelope)
import { ENVELOPE_GUARD, checkEnvelopeAttempt, envelopeInitialFees, envelopeReplacementFees, queueGasFor, verifyEnvelope }
  from "./fee-policy.mjs";
// <<< fee-policy-r1
''')

S_SEND_HEAD = (r'''  async _send({ to, data, label }) {
    const gas = (await this.pc.estimateGas({ account: this.account, to, data })) * 125n / 100n + 20_000n;
    let fees = await cappedFees(this.pc, this.maxTipWei);
    const nonce = await this._nextNonce();
    const rec = { label, to, nonce, hashes: [], status: "sending", at: Date.now() };
''', r'''  // >>> fee-policy-r1 (REPLACES the first five lines of _send). Without an envelope these are the original lines. With
  // one (the gas.fund call only) gas and first fees come from the checked envelope, and the exact first broadcast is
  // checked BEFORE the record is journaled, so a refusal sends nothing and leaves no nonce claim behind.
  async _send({ to, data, label, envelope }) {
    const env = envelope === undefined ? null : await this._envelopeStart(envelope, to, data);
    const gas = env ? env.gas : (await this.pc.estimateGas({ account: this.account, to, data })) * 125n / 100n + 20_000n;
    let fees = env ? env.fees : await cappedFees(this.pc, this.maxTipWei);
    const nonce = await this._nextNonce();
    if (env) this._envelopeAttempt(env, { to, data, gas, nonce, ...fees, attempt: 0 });
    const rec = { label, to, nonce, hashes: [], status: "sending", at: Date.now() };
    if (env) rec.envelope = env.journal;
  // <<< fee-policy-r1
''')

S_LOOP = (r'''    for (let attempt = 0; attempt < this.maxAttempts; attempt++) {
      if (broadcast) {
        let hash;
''', r'''    for (let attempt = 0; attempt < this.maxAttempts; attempt++) {
      // >>> fee-policy-r1: a REPLACEMENT is re-checked against the envelope before it is signed; outside it nothing more
      // is broadcast and the hashes already sent are only watched (the first broadcast was checked before journaling)
      if (broadcast && env && attempt > 0) {
        try { this._envelopeAttempt(env, { to, data, gas, nonce, ...fees, attempt }); } catch (e) {
          broadcast = false; rec.envelopeStop = String(e?.code ?? "refused"); this.journal.saveSoon();
          this.log(`[sessions] ${label}: no replacement at nonce ${nonce} (${rec.envelopeStop}); watching the hashes sent`);
        }
      }
      // <<< fee-policy-r1
      if (broadcast) {
        let hash;
''')

S_BUMP = (r'''      } else if (broadcast) {
        // replace at the same nonce, fees up 25% (clears the 10% replacement floor)
''', r'''      // >>> fee-policy-r1: an enveloped replacement stays inside the envelope's caps; past them nothing more is sent
      } else if (broadcast && env) {
        const next = envelopeReplacementFees(env.envelope, fees);
        if (next) {
          fees = next;
          this.log(`[sessions] ${label}: not mined yet, replacing at nonce ${nonce} inside the fee envelope (attempt ${attempt + 2})`);
        } else {
          broadcast = false; rec.envelopeCapped = true; this.journal.saveSoon();
          this.log(`[sessions] ${label}: not mined yet; a replacement would leave the fee envelope, so the hashes sent are only watched`);
        }
      // <<< fee-policy-r1
      } else if (broadcast) {
        // replace at the same nonce, fees up 25% (clears the 10% replacement floor)
''')

S_METHODS = (r'''  /** Only ever called with a receipt _canonical accepted. */
  _done(rec, rc) {
''', r'''  // >>> fee-policy-r1 envelope helpers (only an enveloped gas.fund send reaches them)
  /** Re-estimate the exact call and require it to fit the checked gas limit under this queue's own rule, then take the
   *  first fees inside the envelope's caps. The gas limit is the envelope's, as priced; it is never re-derived. */
  async _envelopeStart(envelope, to, data) {
    try {
      verifyEnvelope(envelope);
      const est = await this.pc.estimateGas({ account: this.account, to, data });
      if (queueGasFor(est) > envelope.gasLimit) {
        throw httpError(503, "envelope_gas", `the call now needs ${queueGasFor(est)} gas, above the checked ${envelope.gasLimit}; nothing was sent`);
      }
      const blk = await this.pc.getBlock();
      let tip = 1_000_000n;
      try { tip = await this.pc.estimateMaxPriorityFeePerGas(); } catch { /* cappedFees' default; capped below */ }
      const fees = envelopeInitialFees(envelope, { baseFeePerGas: blk?.baseFeePerGas ?? null, tipWei: tip, maxTipWei: this.maxTipWei });
      return { envelope, gas: envelope.gasLimit, fees,
        journal: { digest: envelope.digest, fee6: envelope.fee6.toString(), gasLimit: envelope.gasLimit.toString(),
          maxFeePerGasCap: envelope.maxFeePerGasCap.toString(), maxPriorityFeePerGasCap: envelope.maxPriorityFeePerGasCap.toString(),
          maxSignedBytes: envelope.maxSignedBytes, maxAttempts: envelope.maxAttempts, notAfter: envelope.notAfter.toString() } };
    } catch (e) { throw this._envelopeRefusal(e); }
  }

  /** The exact parameters of one broadcast, against the envelope (throws a 503 carrying the policy's code). */
  _envelopeAttempt(env, a) {
    try {
      return checkEnvelopeAttempt(env.envelope, { chainId: this.wc.chain?.id, from: this.account.address, value: 0n,
        nowSec: Math.floor(this.clock() / 1000), ...a });
    } catch (e) { throw this._envelopeRefusal(e); }
  }

  _envelopeRefusal(e) {
    if (e?.name !== "FeePolicyError") return e;
    return httpError(503, e.code, `the gas.fund envelope refused this send (${e.message}); nothing was sent for it`);
  }
  // <<< fee-policy-r1

  /** Only ever called with a receipt _canonical accepted. */
  _done(rec, rc) {
''')

S_SIM_SIG = (r'''  async function simulateAndSend({ to, abi, functionName, args, label, afterSimulate }) {
''', r'''  // >>> fee-policy-r1 (REPLACES the signature line: adds the optional gas.fund `envelope`)
  async function simulateAndSend({ to, abi, functionName, args, label, afterSimulate, envelope }) {
  // <<< fee-policy-r1
''')

S_SIM_SEND = (r'''    const rc = await queue.send({ to, data: encodeFunctionData({ abi, functionName, args }), label });
''', r'''    // >>> fee-policy-r1 (REPLACES the send line: the envelope, when given, goes to the ONE queue with the same calldata)
    const rc = await queue.send({ to, data: encodeFunctionData({ abi, functionName, args }), label, ...(envelope === undefined ? {} : { envelope }) });
    // <<< fee-policy-r1
''')

# inside a funding-r2 block: an inline marker, never a nested >>> block
S_WIRE = (r'''    simulateAndSend: (req) => simulateAndSend(req) });
''', r'''    // [fee-policy-r1] REPLACES the callback line: declares that this host's queue enforces the gas.fund envelope
    simulateAndSend: Object.assign((req) => simulateAndSend(req), { envelopeGuard: ENVELOPE_GUARD }) });
''')

SESSIONS_HUNKS = [("import", *S_IMPORT), ("_send head", *S_SEND_HEAD), ("attempt loop", *S_LOOP), ("replacement", *S_BUMP),
                  ("queue helpers", *S_METHODS), ("simulateAndSend signature", *S_SIM_SIG), ("simulateAndSend send", *S_SIM_SEND),
                  ("funding wiring", *S_WIRE)]

# ---------------------------------------------------------------------------------------------------------------------
# funding-route.mjs hunks
# ---------------------------------------------------------------------------------------------------------------------
R_IMPORT = (r'''  from "./funding-abi.mjs";
''', r'''  from "./funding-abi.mjs";
// >>> fee-policy-r1 (the v2 gas.fund quote policy interface and the host queue's envelope guard)
import { encodeFunctionData } from "viem";
import { ENVELOPE_GUARD, QUOTE_POLICY_INTERFACE } from "./fee-policy.mjs";
// <<< fee-policy-r1
''')

R_ACTIVATION = (r'''  if (!why && typeof simulateAndSend !== "function") why = "funding needs the host's simulateAndSend callback";
''', r'''  if (!why && typeof simulateAndSend !== "function") why = "funding needs the host's simulateAndSend callback";
  // >>> fee-policy-r1: gas.fund is priced only by a v2 policy (quote, accept, envelope) AND sent only through a queue that
  // enforces the envelope; either missing keeps EVERY /funding/* route off
  if (!why && (quotePolicy.interface !== QUOTE_POLICY_INTERFACE || typeof quotePolicy.quote !== "function"
    || typeof quotePolicy.envelope !== "function")) {
    why = `funding needs a ${QUOTE_POLICY_INTERFACE} quote policy (quote, accept, envelope); the wired policy is not one`;
  }
  if (!why && simulateAndSend.envelopeGuard !== ENVELOPE_GUARD) {
    why = "funding needs a host queue that enforces the gas.fund transaction envelope; none is declared";
  }
  // <<< fee-policy-r1
''')

R_QUOTE_FEE = (r'''    const feeRaw = await policyCall("fee", { phase: "quote", chainId: FUNDING_CHAIN_ID, block: B, vault, sid, deployment, ethOut,
      feeTier: tier, amountIn6, maxFee6 });
    let fee6;
    try { fee6 = uint(feeRaw, 128, "quotePolicy.fee"); } catch { throw httpError(503, "quote_policy_failed", "the host quote policy returned no integer fee"); }
''', r'''    // >>> fee-policy-r1 (REPLACES the policy fee call: the v2 policy returns the fee WITH its components and assumptions)
    const policyQuote = await policyCall("quote", { phase: "quote", chainId: FUNDING_CHAIN_ID, block: B, vault, sid, deployment, ethOut,
      feeTier: tier, amountIn6, maxFee6, envelopeEnforced: true });
    let fee6;
    try { fee6 = uint(policyQuote?.fee6, 128, "quotePolicy.quote.fee6"); } catch { throw httpError(503, "quote_policy_failed", "the host quote policy returned no integer fee"); }
    // <<< fee-policy-r1
''')

R_QUOTE_OUT = (r'''      quote: { quoter: A.quoter, feeTier: tier, amountIn6, block: B, slippageBps: M.maxSlippageBps } };
''', r'''      quote: { quoter: A.quoter, feeTier: tier, amountIn6, block: B, slippageBps: M.maxSlippageBps },
      // >>> fee-policy-r1: every component and assumption behind fee6 (conservative capped compensation, not a receipt)
      feePolicy: policyQuote.detail };
      // <<< fee-policy-r1
''')

R_EXECUTE = (r'''    await presimulate(vault, vaultAbi, "execute", execArgs, B);
    refuseRevoked(vault, sid);
    const rc = await simulateAndSend({ to: vault, abi: vaultAbi, functionName: "execute", args: execArgs,
      label: `funding gas.fund ${sid.slice(0, 10)}` });
''', r'''    await presimulate(vault, vaultAbi, "execute", execArgs, B);
    // >>> fee-policy-r1 (REPLACES the send): the POST-signature check. The exact signed calldata is decoded against the
    // accepted quote, estimated at the accepted block and sized; the envelope returned bounds EVERY broadcast of it,
    // replacements included, and the host queue refuses anything outside it before signing.
    const data = encodeFunctionData({ abi: vaultAbi, functionName: "execute", args: execArgs });
    const envelope = await policyCall("envelope", { phase: "envelope", chainId: FUNDING_CHAIN_ID, block: B, vault, sid, intent,
      fee6: fee, amountIn6, nonce, deadline, to: vault, data, from: R });
    refuseRevoked(vault, sid);
    const rc = await simulateAndSend({ to: vault, abi: vaultAbi, functionName: "execute", args: execArgs,
      label: `funding gas.fund ${sid.slice(0, 10)}`, envelope });
    // <<< fee-policy-r1
''')

ROUTE_HUNKS = [("import", *R_IMPORT), ("activation", *R_ACTIVATION), ("quote fee", *R_QUOTE_FEE), ("quote output", *R_QUOTE_OUT),
               ("execute envelope", *R_EXECUTE)]


def die(m):
    sys.stderr.write(f"prepare.py: {m}\n")
    sys.exit(1)


def sha256(b):
    return hashlib.sha256(b).hexdigest()


def read(path):
    with open(path, "rb") as f:
        return f.read()


def inside_stage(path):
    p = os.path.join(os.path.realpath(os.path.dirname(path)), os.path.basename(path))
    if os.path.commonpath([p, STAGE]) != STAGE:
        die(f"refusing to write outside the stage: {p}")
    return p


def apply(text, hunks, what):
    if MARK in text:
        die(f"{what} already contains {MARK}")
    out = text
    for name, before, after in hunks:
        if MARK in before or MARK not in after:
            die(f"{what} hunk {name}: malformed")
        if out.count(before) != 1:
            die(f"{what} hunk {name}: its anchor occurs {out.count(before)} times (must be exactly once)")
        out = out.replace(before, after, 1)
    back = out
    for name, before, after in reversed(hunks):
        if back.count(after) != 1:
            die(f"{what} hunk {name}: its result occurs {back.count(after)} times after patching")
        back = back.replace(after, before, 1)
    if back != text:
        die(f"{what}: undoing the hunks does not give the input")
    return out


def build(accept_unpinned):
    inputs = {}
    for rel, want in HQ_PINS.items():
        b = read(os.path.join(HQ, rel))
        if sha256(b) != want:
            die(f"host-queue-r1/{rel} sha256 {sha256(b)} is not the pinned {want} (host-queue-r1 changed: re-review and re-pin)")
        inputs[rel] = b
    try:
        hm = json.loads(read(HQ_MANIFEST))
    except (OSError, ValueError) as e:
        die(f"host-queue-r1 manifest unreadable: {e}")
    for rel, want in HQ_PINS.items():
        if (hm.get("outputs") or {}).get(rel) != want:
            die(f"host-queue-r1 manifest outputs[{rel}] is {(hm.get('outputs') or {}).get(rel)}, not {want}")
    policy = read(POLICY_SRC)
    unpinned = {}
    if POLICY_SHA256 is None:
        unpinned["fee-policy-r1/fee-policy.mjs"] = sha256(policy)
        if not accept_unpinned:
            die(f"fee-policy.mjs is not pinned (observed sha256 {sha256(policy)}): review it, set POLICY_SHA256, or pass --accept-unpinned")
    elif sha256(policy) != POLICY_SHA256:
        die(f"fee-policy.mjs sha256 {sha256(policy)} is not the pinned {POLICY_SHA256}")
    ptext = policy.decode()
    a, b = POLICY_REWRITE
    if ptext.count(a) != 1:
        die("fee-policy.mjs must import viem exactly once through the stage-relative path")
    gen_policy = ptext.replace(a, b, 1).encode()

    sessions = (HEADER + apply(inputs["patched/relay/sessions.mjs"].decode(), SESSIONS_HUNKS, "sessions.mjs")).encode()
    route = (ROUTE_HEADER + apply(inputs["patched/relay/funding-route.mjs"].decode(), ROUTE_HUNKS, "funding-route.mjs")).encode()
    for k, t in SYMLINKS.items():
        if not os.path.exists(t):
            die(f"{k}: the import target {t} does not exist")
    if not os.path.exists(os.path.join(SOURCE, "node_modules", "viem", "package.json")):
        die("source/node_modules has no viem")

    outputs = {
        "generated/relay/sessions.mjs": sessions,
        "generated/relay/funding-route.mjs": route,
        "generated/relay/funding-abi.mjs": inputs["patched/relay/funding-abi.mjs"],
        "generated/relay/fee-policy.mjs": gen_policy,
    }
    rel_links = {k: os.path.relpath(t, os.path.dirname(os.path.join(STAGE, k))) for k, t in sorted(SYMLINKS.items())}
    hunks = {}
    for what, hs in (("sessions.mjs", SESSIONS_HUNKS), ("funding-route.mjs", ROUTE_HUNKS)):
        for name, before, after in hs:
            hunks[f"{what}: {name}"] = {"before": sha256(before.encode()), "after": sha256(after.encode())}
    manifest = {
        "inputs": {**{f"host-queue-r1/{k}": sha256(v) for k, v in sorted(inputs.items())},
                   "host-queue-r1/generated/PREPARE-MANIFEST.json": sha256(read(HQ_MANIFEST)),
                   "fee-policy-r1/fee-policy.mjs": sha256(policy)},
        "unpinned": unpinned,
        "hunks": hunks,
        "outputs": {k: sha256(v) for k, v in sorted(outputs.items())},
        "symlinks": rel_links,
        "activation": "OFF: no hunk wires a quote policy into the host bootstrap",
        "note": "source-only stage: these hashes are computed when the root runs prepare.py; nothing here was executed by its author",
    }
    outputs["generated/PREPARE-MANIFEST.json"] = (json.dumps(manifest, indent=2, sort_keys=True) + "\n").encode()
    return outputs, rel_links


def write_outputs(outputs, links, check):
    stale = []
    for rel, data in outputs.items():
        path = inside_stage(os.path.join(STAGE, rel))
        if check:
            if os.path.islink(path) or not os.path.isfile(path) or read(path) != data:
                stale.append(rel)
            continue
        os.makedirs(os.path.dirname(path), exist_ok=True)
        path = inside_stage(path)
        if os.path.islink(path):
            die(f"{rel} is a symlink; refusing to write through it")
        with open(path, "wb") as f:
            f.write(data)
    for rel, target in links.items():
        path = os.path.join(STAGE, rel)
        if not check:
            os.makedirs(os.path.dirname(path), exist_ok=True)
        path = inside_stage(path)
        if os.path.islink(path):
            if os.readlink(path) != target:
                (stale.append(rel) if check else die(f"{rel} links to {os.readlink(path)}, not {target}"))
        elif os.path.exists(path):
            (stale.append(rel) if check else die(f"{rel} exists and is not a symlink"))
        elif check:
            stale.append(rel)
        else:
            os.symlink(target, path)
    return stale


def main(argv):
    flags = set(argv)
    if flags - {"--check", "--accept-unpinned"}:
        die(f"unknown argument(s) {sorted(flags - {'--check', '--accept-unpinned'})}")
    outputs, links = build("--accept-unpinned" in flags)
    stale = write_outputs(outputs, links, "--check" in flags)
    if stale:
        die("stale or missing: " + ", ".join(stale))
    m = json.loads(outputs["generated/PREPARE-MANIFEST.json"])
    for k, v in sorted(m["outputs"].items()):
        print(f"{v}  {k}")
    for k, v in sorted(m["unpinned"].items()):
        print(f"UNPINNED {v}  {k}")
    print("checked" if "--check" in flags else "written")


if __name__ == "__main__":
    main(sys.argv[1:])
