#!/usr/bin/env node
// production-activation-qualification-r2 PREPARATION-INPUT GENERATOR. SOURCE ONLY, NOT RUN by its author. Root runs it offline:
//   node production-activation-qualification-r2/generate-preparation-inputs.mjs --out <absolute new directory>
//
// Emits a DRAFT decisions file, a DRAFT pins skeleton and DRAFT-NOTES.json for production-activation-prep-r1. Nothing
// here is an approval: decisions.reviewedBy / reviewRef are null and the decisions / observation pins are null, so the
// preparer refuses (decision_missing / pin_missing) until root reviews, fills and re-pins them. Reads only the five
// public inputs and the five staged relay modules (sha256 recorded; modules must equal relay-prestage-r1 STAGED-MANIFEST).
// No network, no key, no env value, no signing, no owner grant, no budget migration, no relayer funding action.
import fs from "node:fs";
import path from "node:path";
import url from "node:url";
import { CHAIN_ID, checksum, lower, refuse } from "../production-activation-prep-r1/lib/bindings.mjs";
import { DECISIONS_SCHEMA, MODULES, PINS_SCHEMA, UF, checkDeploymentObservation, parseFeeObservation, parseProposal, parseReceipts,
  parseSessionConfig, sha, validateDecisions } from "../production-activation-prep-r1/lib/context.mjs";

/** The exact public inputs (relative to unified-funding-20261028, as lib/context.mjs resolves them). */
export const INPUTS = Object.freeze({
  receipts: "../source/ops/unified-funding-20261028/production-deployment-20261028/receipts.json",
  deploymentObservation: "production-deployment-observation-r1.json",
  sessionConfig: "production-session-config-2128.json",
  proposal: "deployment-r1/UNSIGNED-PROPOSAL-r1.json",
  feeObservation: "production-fee-observation-r6.json",
});
export const STAGED_MANIFEST = "relay-prestage-r1/STAGED-MANIFEST.json";
/** The explicit policy. Every value is compared with its source below; a difference refuses, nothing is defaulted. */
export const POLICY = Object.freeze({
  queueMaxAttempts: 5, queueMaxTipWei: "10000000",                  // host TxQueue (staged sessions.mjs)
  txMaxAttempts: 3, maxPriorityFeePerGas: "2000000", gasLimit: 1_000_000, maxFeePerGas: "20000000",
  maxFee6: "80000", marginBps: 2000, maxBlockAgeSec: 180, quoteTtlSec: 300, sequencerGraceSec: 3600,
  feeTiers: [100, 500, 3000], maxSlippageBps: 100, deadlineSec: 300, validitySec: 86_400,
  minRelayerBalanceWei: "100000000000000",                          // 1e14 wei; a floor check only, no funding action
  quoter: "0x3d4e44Eb1374240CE5F1B871ab261CD16335B76a",             // Base Uniswap V3 QuoterV2; root verifies getters + runtime
  feeObservationBlock: "53217886",
});
export const HISTORICAL_CALL_GAS = Object.freeze([625399, 609472, 631198]);
export const MEASURED_EVIDENCE = "Historical Base fork eth_call (CALL trace) gas of vault.execute: 625399 / 609472 / 631198; the largest, "
  + "631198, is used. These are NOT transaction receipts and NOT a production measurement: a CALL trace excludes the 21000 intrinsic "
  + "and calldata gas and cold-state / access-list differences of a real signed transaction. The relay's actual eth_estimateGas at "
  + "quote time (queueGasFor(estimate) <= tx.gasLimit 1000000, else gas_above_cap) is mandatory and remains the binding check.";

const read = (rel) => fs.readFileSync(path.resolve(UF, rel));
const json = (rel) => JSON.parse(read(rel).toString("utf8"));

/** The host queue defaults as the staged sessions.mjs source actually states them (no maxAttempts override). */
export function stagedQueueDefaults(src) {
  const ctor = /class TxQueue \{\s*constructor\(\{[\s\S]{0,400}?\bmaxAttempts = (\d+),\s*maxTipWei = ([0-9_]+)n,/.exec(src);
  const svc = /const maxTipWei = BigInt\(o\.maxTipWei \?\? ([0-9_]+)n\);\s*const queue = new TxQueue\(\{ pc, wc, account, journal, log, alert, maxTipWei \}\);/.exec(src);
  if (!ctor || !svc) refuse("staged_queue", "the staged sessions.mjs TxQueue / createSessionsService defaults were not found");
  const q = { maxAttempts: Number(ctor[1]), maxTipWei: ctor[2].replaceAll("_", ""), serviceMaxTipWei: svc[1].replaceAll("_", "") };
  if (q.maxAttempts !== POLICY.queueMaxAttempts || q.maxTipWei !== POLICY.queueMaxTipWei || q.serviceMaxTipWei !== POLICY.queueMaxTipWei) {
    refuse("staged_queue", `staged queue defaults ${JSON.stringify(q)} differ from the explicit policy`);
  }
  return q;
}

export function generateDraft({ now }) {
  if (!Number.isSafeInteger(now) || now <= 0) refuse("now", "now must be a unix time");
  // ---- the five staged modules, exactly the STAGED-MANIFEST bytes -------------------------------------------------
  const staged = json(STAGED_MANIFEST).files ?? {};
  const modules = {};
  for (const rel of MODULES) {
    modules[rel] = sha(read(rel));
    if (staged[path.basename(rel)] !== modules[rel]) refuse("staged_drift", `${rel} sha256 ${modules[rel]} is not the STAGED-MANIFEST ${staged[path.basename(rel)]}`);
  }
  const queue = stagedQueueDefaults(read(MODULES[0]).toString("utf8"));
  // ---- the public inputs, parsed by the preparer's own parsers -----------------------------------------------------
  const raw = Object.fromEntries(Object.keys(INPUTS).map((k) => [k, json(INPUTS[k])]));
  parseReceipts(raw.receipts);
  parseProposal(raw.proposal, raw.receipts);
  const original = parseSessionConfig(raw.sessionConfig);
  const fo = raw.feeObservation, F = parseFeeObservation(fo);
  if (fo.readOnly !== true || fo.activation !== false || String(fo.block) !== POLICY.feeObservationBlock || new Set(fo.providers ?? []).size !== 2) {
    refuse("fee_observation", `the fee observation must be the read-only, two-provider block ${POLICY.feeObservationBlock} result`);
  }
  const want = { "tx.gasLimit": POLICY.gasLimit, "tx.maxFeePerGas": POLICY.maxFeePerGas, "tx.maxPriorityFeePerGas": POLICY.maxPriorityFeePerGas,
    "tx.maxAttempts": POLICY.txMaxAttempts, "pricing.marginBps": POLICY.marginBps, "pricing.maxFee6": POLICY.maxFee6,
    maxBlockAgeSec: POLICY.maxBlockAgeSec, quoteTtlSec: POLICY.quoteTtlSec, "sequencer.graceSec": POLICY.sequencerGraceSec };
  const got = (p) => p.split(".").reduce((x, k) => (x == null ? x : x[k]), F);
  const differ = Object.entries(want).filter(([p, v]) => String(got(p)) !== String(v)).map(([p]) => p);
  if (differ.length) refuse("policy_mismatch", `the reviewed fee observation differs from the explicit policy in ${differ.join(", ")}`);
  const impl = raw.deploymentObservation.contracts?.FundingSessionVault ?? {};
  const notAfter = now + POLICY.validitySec;

  const decisions = {
    schema: DECISIONS_SCHEMA, chainId: CHAIN_ID, reviewedBy: null, reviewRef: null,
    expected: { implementation: checksum(impl.address), implementationCodehash: lower(impl.codehash) },
    relayer: checksum(original.relayer),
    queue: { maxTipWei: queue.maxTipWei, maxAttempts: queue.maxAttempts, measuredExecuteGasUsed: String(Math.max(...HISTORICAL_CALL_GAS)),
      measuredEvidence: MEASURED_EVIDENCE, minRelayerBalanceWei: POLICY.minRelayerBalanceWei },
    ownerControls: { maxBlockAgeSec: POLICY.maxBlockAgeSec },
    intake: { notAfter, maxBlockAgeSec: POLICY.maxBlockAgeSec, feeTiers: [...POLICY.feeTiers], maxSlippageBps: POLICY.maxSlippageBps,
      deadlineSec: POLICY.deadlineSec, quoter: POLICY.quoter },
    feePolicy: { notAfter, maxBlockAgeSec: F.maxBlockAgeSec, quoteTtlSec: F.quoteTtlSec, oracle: F.oracle.address,
      feed: { address: F.feed.address, decimals: F.feed.decimals, description: F.feed.description, maxAgeSec: F.feed.maxAgeSec,
        minAnswer: F.feed.minAnswer, maxAnswer: F.feed.maxAnswer },
      sequencer: { address: F.sequencer.address, graceSec: F.sequencer.graceSec }, sequencerDecision: "checked",
      tx: { ...F.tx }, pricing: { ...F.pricing }, changesFromReviewedObservation: [] },
  };
  checkDeploymentObservation(raw.deploymentObservation, decisions);
  // the draft is complete except for the review names: it must pass the preparer's decision validation once they are filled
  validateDecisions({ ...decisions, reviewedBy: "draft-self-check", reviewRef: "draft-self-check" }, []);

  const pins = { schema: PINS_SCHEMA, status: "DRAFT_NOT_APPROVED", modules,
    inputs: { ...Object.fromEntries(Object.entries(INPUTS).map(([k, rel]) => [k, { path: rel, sha256: sha(read(rel)) }])),
      decisions: { path: null, sha256: null }, observation: { path: null, sha256: null } } };
  const notes = {
    status: "DRAFT_NOT_APPROVED", generatedAt: now,
    rootMustFill: ["decisions.reviewedBy", "decisions.reviewRef", "pins.inputs.decisions (path + sha256 of the reviewed decisions file)",
      "pins.inputs.observation (path + sha256 of a LIVE capture-observation.mjs output; never a TEST fixture)"],
    validity: `intake.notAfter and feePolicy.notAfter = generatedAt + ${POLICY.validitySec}s; the preparer needs >= 600s left at prepare time`,
    hostQueue: { ...queue, source: MODULES[0], note: "SESSIONS_MAX_TIP_WEI must be unset (or exactly 10000000) on the production relay; this generator cannot read env" },
    quoter: `${POLICY.quoter}: Base Uniswap V3 QuoterV2; collectBindings checks quoter.factory() / WETH9() against the adapter, root verifies the runtime`,
    measuredEvidence: MEASURED_EVIDENCE,
    relayerBalance: `minimum ${POLICY.minRelayerBalanceWei} wei is a refusal floor only; no funding action is prepared`,
    notIncluded: ["owner grant", "budget migration", "relayer funding", "signing / sending", "env or service changes"],
  };
  return { pins, decisions, notes };
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(url.fileURLToPath(import.meta.url));
if (isMain) {
  const a = process.argv.slice(2);
  if (a.length !== 2 || a[0] !== "--out") { console.error("usage: generate-preparation-inputs.mjs --out <absolute new directory>"); process.exit(2); }
  const out = a[1];
  try {
    if (!path.isAbsolute(out) || path.normalize(out) !== out || out.endsWith("/")) refuse("out_path", "--out must be an absolute, normalized directory path");
    if (fs.existsSync(out)) refuse("out_exists", `${out} already exists; nothing is overwritten`);
    const d = generateDraft({ now: Math.floor(Date.now() / 1000) });
    fs.mkdirSync(out, { mode: 0o750 });
    for (const [n, v] of [["DRAFT-decisions.json", d.decisions], ["DRAFT-pins.json", d.pins], ["DRAFT-NOTES.json", d.notes]]) {
      fs.writeFileSync(path.join(out, n), `${JSON.stringify(v, null, 2)}\n`, { flag: "wx", mode: 0o640 });
    }
    console.log(JSON.stringify({ status: "DRAFT_NOT_APPROVED", out, inputs: d.pins.inputs, modules: d.pins.modules }, null, 2));
  } catch (e) { console.error(`REFUSED ${e.code ?? ""} ${e.message}`); process.exit(1); }
}
