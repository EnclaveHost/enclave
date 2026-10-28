// production-activation-prep-r1: pinned inputs and the reviewed decision schema. UNREVIEWED, NOT RUN by its author.
// Every file is named in a root-filled pins file and refused on a null or different sha256 BEFORE it is parsed or
// imported. Public data only: receipts, the public relay config, the reviewed proposal and fee observation, root's
// explicit decisions. No key, env value, journal or private file is read here.
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import url from "node:url";
import { CHAIN_ID, isAddr, lower, refuse } from "./bindings.mjs";

export const HERE = path.resolve(path.dirname(url.fileURLToPath(import.meta.url)), "..");   // production-activation-prep-r1
export const UF = path.dirname(HERE);                                                       // unified-funding-20261028
export const PINS_SCHEMA = "production-activation-prep-r1-pins/v1";
export const DECISIONS_SCHEMA = "enclave-funding-production-decisions-r1";
/** The five staged relay modules (relay-prestage-r1 STAGED-MANIFEST = activation-r1 generated outputs). The preparer
 *  imports the tested parsers and loader from exactly these bytes. */
export const MODULES = Object.freeze(["sessions.mjs", "funding-route.mjs", "funding-abi.mjs", "fee-policy.mjs", "funding-activation.mjs"]
  .map((f) => `activation-r1/generated/relay/${f}`));
export const INPUT_NAMES = Object.freeze(["receipts", "deploymentObservation", "sessionConfig", "proposal", "feeObservation", "decisions", "observation"]);
const H32 = /^0x[0-9a-f]{64}$/;
export const sha = (b) => createHash("sha256").update(b).digest("hex");
const abs = (rel) => path.resolve(UF, rel);
const DEC = /^(0|[1-9][0-9]{0,77})$/;

function readPinned(rel, want, label) {
  if (typeof want !== "string" || !/^[0-9a-f]{64}$/.test(want)) refuse("pin_missing", `${label} (${rel}) has no root-filled sha256`);
  if (typeof rel !== "string" || rel.length === 0) refuse("pin_missing", `${label} has no path`);
  let b;
  try { b = fs.readFileSync(abs(rel)); } catch (e) { refuse("input_unreadable", `${label} (${rel}) cannot be read (${e.code ?? e.message})`); }
  if (sha(b) !== want) refuse("pin_drift", `${label} (${rel}) sha256 ${sha(b)} != pinned ${want}`);
  return b;
}
const json = (b, label) => { try { return JSON.parse(b.toString("utf8")); } catch { return refuse("input_json", `${label} is not JSON`); } };

/** { pins, modules (imported), receipts, original, adapterArgs, deploymentObservation, reviewedFee, decisions, observation }.
 *  `capture: true` (capture-observation.mjs only) skips the observation, which does not exist yet; every other pin holds. */
export async function loadContext(pinsPath, { capture = false } = {}) {
  let raw;
  try { raw = fs.readFileSync(pinsPath); } catch (e) { refuse("pins_unreadable", `pins file ${pinsPath} cannot be read (${e.code ?? e.message})`); }
  const pins = json(raw, "pins");
  if (pins.schema !== PINS_SCHEMA) refuse("pins_schema", `pins.schema must be ${PINS_SCHEMA}`);
  if (Object.keys(pins.modules ?? {}).sort().join() !== [...MODULES].sort().join()) refuse("pins_modules", `pins.modules must list exactly ${MODULES.join(", ")}`);
  if (Object.keys(pins.inputs ?? {}).sort().join() !== [...INPUT_NAMES].sort().join()) refuse("pins_inputs", `pins.inputs must list exactly ${INPUT_NAMES.join(", ")}`);
  for (const rel of MODULES) readPinned(rel, pins.modules[rel], rel);
  const inp = {};
  for (const n of INPUT_NAMES) {
    if (capture && n === "observation") { inp[n] = null; continue; }
    inp[n] = json(readPinned(pins.inputs[n]?.path, pins.inputs[n]?.sha256, n), n);
  }
  // import ONLY after every module hash matched
  const route = await import(url.pathToFileURL(abs(MODULES[1])).href);
  const fee = await import(url.pathToFileURL(abs(MODULES[3])).href);
  const activation = await import(url.pathToFileURL(abs(MODULES[4])).href);
  const decisions = validateDecisions(inp.decisions, activation.DEV_ACCOUNTS);
  return { pins, modules: { route, fee, activation }, receipts: parseReceipts(inp.receipts), original: parseSessionConfig(inp.sessionConfig),
    adapterArgs: parseProposal(inp.proposal, inp.receipts), deploymentObservation: checkDeploymentObservation(inp.deploymentObservation, decisions),
    reviewedFee: parseFeeObservation(inp.feeObservation), decisions, observation: inp.observation };
}

// ---- confirmed receipts (production-deployment-20261028/receipts.json): four contracts, canonical, exact runtime ------
const NAMES = ["FundingSessionVaultLib", "FundingGasLib", "LeaseGasDexAdapter", "FundingSessionVaultFactory"];
export function parseReceipts(r) {
  if (Number(r?.chainId) !== CHAIN_ID || !Array.isArray(r.contracts)) refuse("receipts", "receipts must be chain 8453 with a contracts list");
  const byName = {};
  for (const c of r.contracts) {
    if (!NAMES.includes(c?.name) || byName[c.name]) refuse("receipts", `unexpected or repeated receipt ${c?.name}`);
    const rc = c.receipt ?? {};
    if (!isAddr(c.address) || lower(rc.contractAddress) !== lower(c.address)) refuse("receipts", `${c.name}: contractAddress does not equal its address`);
    if (rc.status !== "1" || !H32.test(lower(rc.blockHash)) || !/^\d+$/.test(String(rc.blockNumber)) || !H32.test(lower(c.transactionHash))
      || lower(rc.hash) !== lower(c.transactionHash)) refuse("receipts", `${c.name}: not a confirmed receipt (status / block / hash)`);
    if (!H32.test(c.runtimeCodehash ?? "")) refuse("receipts", `${c.name}: runtimeCodehash must be lowercase 32-byte hex`);
    byName[c.name] = { address: c.address, runtimeCodehash: c.runtimeCodehash, blockNumber: String(rc.blockNumber), blockHash: lower(rc.blockHash) };
  }
  for (const n of NAMES) if (!byName[n]) refuse("receipts", `no confirmed receipt for ${n}`);
  return { byName, owner: r.owner };
}
// ---- the original relay's PUBLIC /v1/sessions/config: factory, book, USDC, relayer ----------------------------------
export function parseSessionConfig(c) {
  if (Number(c?.chainId) !== CHAIN_ID) refuse("session_config", "the sessions config must be chain 8453");
  for (const k of ["factory", "book", "usdc", "relayer"]) if (!isAddr(c[k])) refuse("session_config", `sessions config ${k} is missing`);
  return { legacyFactory: lower(c.factory), book: lower(c.book), usdc: lower(c.usdc), relayer: lower(c.relayer) };
}
// ---- the reviewed proposal: the adapter's constructor arguments, at the address the receipts confirm --------------
export function parseProposal(p, receipts) {
  const item = findDeep(p, (o) => o?.name === "LeaseGasDexAdapter" && Array.isArray(o.constructorArgs));
  if (!item) refuse("proposal", "the reviewed proposal has no LeaseGasDexAdapter constructor arguments");
  const rc = (receipts.contracts ?? []).find((c) => c.name === "LeaseGasDexAdapter");
  if (!rc || lower(item.predictedAddress) !== lower(rc.address)) refuse("proposal", "the proposal's adapter address is not the confirmed one");
  const a = item.constructorArgs;
  if (a.length !== 7 || !a.slice(0, 6).every(isAddr) || !DEC.test(String(a[6]))) refuse("proposal", "unexpected adapter constructor arguments");
  return a.map((x, i) => (i < 6 ? lower(x) : String(x)));
}
function findDeep(o, pred) {
  if (pred(o)) return o;
  if (o && typeof o === "object") for (const v of Object.values(o)) { const f = findDeep(v, pred); if (f) return f; }
  return null;
}
// ---- root's two-provider deployment observation must agree with the decision's expected implementation ------------
export function checkDeploymentObservation(o, D) {
  const v = o?.contracts?.FundingSessionVault;
  if (o?.ok !== true || o.exactReviewedDeployedRuntimeVerified !== true || !v) refuse("deployment_observation", "the deployment observation is not a verified pass");
  if (lower(v.address) !== lower(D.expected.implementation) || lower(v.codehash) !== lower(D.expected.implementationCodehash)) {
    refuse("inconsistent_hashes", "the deployment observation's implementation differs from the decision's expected implementation");
  }
  return { at: o.at, block: o.snapshot?.number ?? null };
}
// ---- the reviewed fee observation: the baseline every fee-policy field is compared with ---------------------------
export function parseFeeObservation(o) {
  const cfgs = (o?.results ?? []).map((x) => x.config);
  if (o?.agreed !== true || cfgs.length < 2) refuse("fee_observation", "the reviewed fee observation is not an agreed multi-provider result");
  const strip = (c) => JSON.stringify({ ...c, notAfter: 0 });
  if (cfgs.some((c) => strip(c) !== strip(cfgs[0]))) refuse("fee_observation", "the reviewed fee observation's providers disagree");
  return cfgs[0];
}

// ---- the explicit decision file (root-reviewed; every field required; no defaults) ---------------------------------
/** keys exactly; every value present and non-null except the `nullable` ones (present, possibly null). */
const exact = (o, keys, name, nullable = []) => {
  if (o === null || typeof o !== "object" || Array.isArray(o)) refuse("decisions", `${name} must be an object`);
  const extra = Object.keys(o).filter((k) => !keys.includes(k));
  if (extra.length) refuse("decisions", `${name} has unknown field(s) ${extra.join(", ")}`);
  const missing = keys.filter((k) => o[k] === undefined || (o[k] === null && !nullable.includes(k)));
  if (missing.length) refuse("decision_missing", `${name} is missing ${missing.join(", ")}`);
};
const dec = (v, name) => { if (!DEC.test(String(v))) refuse("decisions", `${name} must be a decimal integer`); return String(v); };
export function validateDecisions(D, devAccounts) {
  exact(D, ["schema", "chainId", "reviewedBy", "reviewRef", "expected", "relayer", "queue", "ownerControls", "intake", "feePolicy"], "decisions",
    ["intake", "feePolicy"]);
  if (D.schema !== DECISIONS_SCHEMA) refuse("decisions", `decisions.schema must be ${DECISIONS_SCHEMA}`);
  if (Number(D.chainId) !== CHAIN_ID) refuse("decisions", "decisions.chainId must be 8453");
  for (const k of ["reviewedBy", "reviewRef"]) if (typeof D[k] !== "string" || D[k].trim().length < 3) refuse("decision_missing", `decisions.${k} must name the review`);
  exact(D.expected, ["implementation", "implementationCodehash"], "decisions.expected");
  if (!isAddr(D.expected.implementation) || !H32.test(D.expected.implementationCodehash)) refuse("decisions", "decisions.expected must be an address and a lowercase code hash");
  if (!isAddr(D.relayer)) refuse("decisions", "decisions.relayer must be the production relayer address");
  if (devAccounts.includes(lower(D.relayer))) refuse("default_credentials", "decisions.relayer is a well-known development account");
  exact(D.queue, ["maxTipWei", "maxAttempts", "measuredExecuteGasUsed", "measuredEvidence", "minRelayerBalanceWei"], "decisions.queue");
  for (const k of ["maxTipWei", "measuredExecuteGasUsed", "minRelayerBalanceWei"]) dec(D.queue[k], `decisions.queue.${k}`);
  if (!Number.isInteger(D.queue.maxAttempts) || D.queue.maxAttempts < 1 || D.queue.maxAttempts > 5) refuse("decisions", "decisions.queue.maxAttempts must be the host TxQueue's 1..5");
  if (typeof D.queue.measuredEvidence !== "string" || D.queue.measuredEvidence.length < 8) refuse("decision_missing", "decisions.queue.measuredEvidence must name the measurement");
  exact(D.ownerControls, ["maxBlockAgeSec"], "decisions.ownerControls");
  if ((D.intake === null) !== (D.feePolicy === null)) refuse("decisions", "intake and feePolicy are prepared together or not at all");
  if (D.intake !== null) {
    exact(D.intake, ["notAfter", "maxBlockAgeSec", "feeTiers", "maxSlippageBps", "deadlineSec", "quoter"], "decisions.intake");
    if (!isAddr(D.intake.quoter) || !Array.isArray(D.intake.feeTiers) || D.intake.feeTiers.length === 0) refuse("decisions", "decisions.intake needs a quoter address and fee tiers");
    const F = D.feePolicy;
    exact(F, ["notAfter", "maxBlockAgeSec", "quoteTtlSec", "oracle", "feed", "sequencer", "sequencerDecision", "tx", "pricing", "changesFromReviewedObservation"],
      "decisions.feePolicy", ["sequencer"]);
    if (F.sequencer === null ? F.sequencerDecision !== "not_checked_reviewed" : F.sequencerDecision !== "checked") {
      refuse("sequencer_decision", 'feePolicy.sequencerDecision must be "not_checked_reviewed" with sequencer null, or "checked" with a sequencer feed');
    }
    if (F.sequencer !== null) exact(F.sequencer, ["address", "graceSec"], "decisions.feePolicy.sequencer");
    exact(F.feed, ["address", "decimals", "description", "maxAgeSec", "minAnswer", "maxAnswer"], "decisions.feePolicy.feed");
    exact(F.tx, ["gasLimit", "maxFeePerGas", "maxPriorityFeePerGas", "maxSignedBytes", "maxAttempts", "replacementBumpBps"], "decisions.feePolicy.tx");
    exact(F.pricing, ["marginBps", "maxFee6"], "decisions.feePolicy.pricing");
    if (!Array.isArray(F.changesFromReviewedObservation) || F.changesFromReviewedObservation.some((x) => typeof x !== "string")) {
      refuse("decisions", "feePolicy.changesFromReviewedObservation must list field paths (possibly none)");
    }
  }
  return D;
}
