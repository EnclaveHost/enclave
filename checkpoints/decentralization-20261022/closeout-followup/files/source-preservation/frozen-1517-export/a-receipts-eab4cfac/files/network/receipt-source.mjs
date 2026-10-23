// The validated RECEIPT SOURCE for independent sends: worker E's source-binding adapters (network/tx-evidence/, vendored
// byte-for-byte, see PROVENANCE.json) built from ONE explicit config file, plus the binding of a minted receipt to the
// transaction a client intended. This is not a verifier: inclusion, status and level come only from evidence MINTED by
// createBaseNodeSource (bound to createL1PairSource), accepted by E's own rule (acceptEvidence: minted, right kind,
// accepted trust); this module adds only what a receipt does not carry - which transaction it is:
//   * the transaction hash IS keccak256 of the signed bytes (held by this client, or a transaction object re-encoded with
//     its own signature), so the hash binds every signed field, the nonce included;
//   * the sender is RECOVERED from that signature, and must be the intended sender and the receipt's `from`;
//   * the nonce is read from those signed bytes and must be the intended nonce.
// A transport may supply the transaction object (it cannot forge a signature that hashes to the receipt's hash); it can
// never supply inclusion or status.
//
// Trust is explicit and shown verbatim: 'local-validated-pair' = the LOCAL full nodes (reth + Lighthouse L1, base-reth +
// base-consensus) validated the chain - local full-node validation, NOT a portable cryptographic proof. A config with
// `testFixture` identities mints 'test-fixture' trust, is accepted only when ENCLAVE_TEST_RECEIPT_FIXTURE=1 is set by a
// test harness, and is labelled TEST FIXTURE in every answer; a production config never accepts it.
// Evidence objects are used by reference and never copied or annotated (a copy is not minted and is refused).
import fs from "node:fs";
import { keccak256, parseTransaction, recoverTransactionAddress, serializeTransaction } from "viem";
import { createL1PairSource } from "./tx-evidence/l1-source-binding.mjs";
import { createBaseNodeSource } from "./tx-evidence/base-source-binding.mjs";
import { acceptEvidence, Refused, refuse } from "./tx-evidence/forced-inclusion.mjs";
import { TRUST } from "./tx-evidence/evidence-brand.mjs";

export const RECEIPT_SOURCE_FORMAT = "enclave-receipt-source/v1";
export const FIXTURE_ENV = "ENCLAVE_TEST_RECEIPT_FIXTURE";
const lc = (v) => String(v ?? "").toLowerCase();
const HASH = /^0x[0-9a-f]{64}$/;
// refusals that may clear on their own (the node catching up, a reorg settling, a timeout): retried by pollers
const TRANSIENT = new Set(["l1-source-not-ready", "l2-source-not-ready", "l2-not-canonical", "l2-source-regressed"]);
export const isTransient = (e) => !(e instanceof Refused) || TRANSIENT.has(e.code);

function only(o, keys, where) {
  if (!o || typeof o !== "object" || Array.isArray(o)) throw new Error(`receipt source config: ${where} must be an object`);
  for (const k of Object.keys(o)) if (!keys.includes(k)) throw new Error(`receipt source config: unknown key ${where}.${k}`);
  return o;
}
const url = (o, where) => { only(o, ["url"], where); if (typeof o.url !== "string") throw new Error(`receipt source config: ${where}.url`); return { url: o.url }; };
const int = (v, where, lo) => { if (v === undefined) return undefined; if (!Number.isInteger(v) || v < lo) throw new Error(`receipt source config: ${where} must be an integer >= ${lo}`); return v; };

/**
 * Parse and check a receipt-source config (the file `--receipt-source FILE` names):
 *   { "format": "enclave-receipt-source/v1",
 *     "l1":   { "execution": {"url"}, "consensus": {"url"}, "minPeers"?, "maxHeadLagSec"?, "maxFinalizedLagSec"? },
 *     "base": { "execution": {"url"}, "rollup": {"url"}, "maxUnsafeLagSec"? },
 *     "testFixture"?: { "label": "TEST …", "l1Identity": {...}, "l2Identity": {...} } }
 * URLs must be loopback (the adapters refuse anything else). testFixture needs env ENCLAVE_TEST_RECEIPT_FIXTURE=1.
 */
export function parseReceiptSourceConfig(cfg, { env = process.env } = {}) {
  only(cfg, ["format", "l1", "base", "testFixture"], "config");
  if (cfg.format !== RECEIPT_SOURCE_FORMAT) throw new Error(`receipt source config: format must be "${RECEIPT_SOURCE_FORMAT}"`);
  const l1 = only(cfg.l1, ["execution", "consensus", "minPeers", "maxHeadLagSec", "maxFinalizedLagSec"], "l1");
  const base = only(cfg.base, ["execution", "rollup", "maxUnsafeLagSec"], "base");
  const out = {
    l1: { execution: url(l1.execution, "l1.execution"), consensus: url(l1.consensus, "l1.consensus"), minPeers: int(l1.minPeers, "l1.minPeers", 1),
      maxHeadLagSec: int(l1.maxHeadLagSec, "l1.maxHeadLagSec", 1), maxFinalizedLagSec: int(l1.maxFinalizedLagSec, "l1.maxFinalizedLagSec", 1) },
    base: { execution: url(base.execution, "base.execution"), rollup: url(base.rollup, "base.rollup"), maxUnsafeLagSec: int(base.maxUnsafeLagSec, "base.maxUnsafeLagSec", 1) },
    testFixture: null,
  };
  if (cfg.testFixture !== undefined) {
    if (env[FIXTURE_ENV] !== "1") throw new Error(`receipt source config: testFixture identities mint 'test-fixture' trust and are refused outside a test harness (${FIXTURE_ENV}=1); a production config names only the local L1 pair and Base node`);
    const f = only(cfg.testFixture, ["label", "l1Identity", "l2Identity"], "testFixture");
    if (typeof f.label !== "string" || !/^TEST/.test(f.label)) throw new Error("receipt source config: testFixture.label must start with TEST");
    only(f.l1Identity, ["chainIdHex", "elGenesisHash", "clGenesisValidatorsRoot", "genesisNumber"], "testFixture.l1Identity");
    only(f.l2Identity, ["chainIdHex", "genesisHash"], "testFixture.l2Identity");
    out.testFixture = { label: f.label, l1Identity: { ...f.l1Identity, label: `${f.label} (L1)` }, l2Identity: { ...f.l2Identity, label: `${f.label} (Base)` } };
  }
  return out;
}
export const loadReceiptSourceConfig = (file, opts) => parseReceiptSourceConfig(JSON.parse(fs.readFileSync(file, "utf8")), opts);

const defined = (o) => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined));

/**
 * The bound transaction for `hash`: from the signed bytes this client holds (`raw`), or from a transaction object
 * (`txLookup(hash)`, any source) re-encoded with its own signature. -> a viem-shaped transaction (hash, from recovered).
 */
export async function bindTransaction({ hash, raw = null, txLookup = null }) {
  hash = lc(hash);
  if (!HASH.test(hash)) refuse("tx-identity", "not a transaction hash");
  let bytes, t;
  if (raw) {
    bytes = lc(raw);
    if (keccak256(bytes) !== hash) refuse("tx-identity", "the signed bytes this client holds do not hash to that transaction");
    t = parseTransaction(bytes);
  } else {
    if (typeof txLookup !== "function") refuse("tx-unbound", "no signed bytes are held for it and no transaction transport is configured to read it");
    const o = await txLookup(hash);
    if (!o) refuse("tx-unbound", "the transaction transport does not show the transaction");
    const sig = { r: o.r, s: o.s, ...(o.type === "legacy" ? { v: BigInt(o.v) } : { yParity: Number(o.yParity) }) };
    const fields = { chainId: o.chainId !== undefined && o.chainId !== null ? Number(o.chainId) : undefined, nonce: Number(o.nonce), to: o.to ?? undefined,
      value: BigInt(o.value ?? 0n), data: o.input ?? "0x", gas: BigInt(o.gas) };
    try {
      if (o.type === "eip1559") bytes = serializeTransaction({ type: "eip1559", ...fields, maxFeePerGas: BigInt(o.maxFeePerGas), maxPriorityFeePerGas: BigInt(o.maxPriorityFeePerGas), accessList: o.accessList || [] }, sig);
      else if (o.type === "eip2930") bytes = serializeTransaction({ type: "eip2930", ...fields, gasPrice: BigInt(o.gasPrice), accessList: o.accessList || [] }, sig);
      else if (o.type === "legacy") bytes = serializeTransaction({ type: "legacy", ...fields, gasPrice: BigInt(o.gasPrice) }, sig);
      else refuse("tx-type-unsupported", `transaction type ${o.type}`);
    } catch (e) { if (e instanceof Refused) throw e; refuse("tx-identity", "the transaction's fields and signature do not re-encode"); }
    if (keccak256(bytes) !== hash) refuse("tx-identity", "the transaction's fields and signature do not hash to that transaction (altered fields)");
    t = parseTransaction(bytes);
  }
  const from = lc(await recoverTransactionAddress({ serializedTransaction: bytes }).catch(() => ""));
  if (!from) refuse("tx-identity", "no sender is recoverable from the signature");
  return Object.freeze({ hash, from, to: t.to ? lc(t.to) : null, input: lc(t.data ?? "0x"), value: BigInt(t.value ?? 0n), nonce: Number(t.nonce ?? 0), gas: BigInt(t.gas ?? 0n),
    type: t.type, chainId: t.chainId !== undefined ? Number(t.chainId) : null, maxFeePerGas: t.maxFeePerGas !== undefined ? BigInt(t.maxFeePerGas) : null,
    maxPriorityFeePerGas: t.maxPriorityFeePerGas !== undefined ? BigInt(t.maxPriorityFeePerGas) : t.maxFeePerGas !== undefined ? 0n : null,
    gasPrice: t.gasPrice !== undefined ? BigInt(t.gasPrice) : null, accessList: t.accessList || [], r: t.r, s: t.s, yParity: t.yParity, v: t.v });
}

/** createReceiptSource(parsed config) -> { trust, acceptTrust, fixture, label, readiness(), receipt({hash, from, nonce, raw, txLookup}) } */
export function createReceiptSource(cfg, { fetch, now } = {}) {
  const fx = cfg.testFixture;
  const io = defined({ fetch, now });
  const l1 = createL1PairSource(defined({ execution: cfg.l1.execution, consensus: cfg.l1.consensus, maxHeadLagSec: cfg.l1.maxHeadLagSec, maxFinalizedLagSec: cfg.l1.maxFinalizedLagSec,
    ...(fx ? { identity: fx.l1Identity, minPeers: 0 } : { minPeers: cfg.l1.minPeers ?? 1 }), ...io }));
  const base = createBaseNodeSource(defined({ execution: cfg.base.execution, rollup: cfg.base.rollup, l1, maxUnsafeLagSec: cfg.base.maxUnsafeLagSec,
    ...(fx ? { identity: fx.l2Identity } : {}), ...io }));
  const trust = fx ? TRUST.TEST_FIXTURE : TRUST.LOCAL_VALIDATED_PAIR;
  if (l1.trust !== trust || base.trust !== trust) throw new Error(`receipt source: the adapters mint '${base.trust}' trust, the config expects '${trust}'`);
  const acceptTrust = Object.freeze([trust]);
  const label = fx ? `${fx.label} (TEST FIXTURE trust 'test-fixture': scripted beacon/rollup, not local full-node validation)` : `local L1 pair ${cfg.l1.execution.url} + ${cfg.l1.consensus.url}, Base node ${cfg.base.execution.url} + ${cfg.base.rollup.url}`;

  /** The two adapters' readiness, verbatim (E: show readiness().checks as they are). */
  async function readiness() {
    const [a, b] = [await l1.readiness(), await base.readiness()];
    return { ok: a.ok && b.ok, trust, label, l1: a, base: b };
  }
  /**
   * ONE look (no retry, no cache): -> {state: 'pending'} | {state: 'included', evidence (the minted object itself), status,
   * level, trust, blockNumber, blockHash, transaction (bound), binding}. Throws E's Refused for a not-ready or
   * misbehaving source, a trust it does not accept, or a receipt that is not this sender's transaction at this nonce.
   */
  async function receipt({ hash, from = null, nonce = null, raw = null, txLookup = null }) {
    hash = lc(hash);
    const r = await base.receipt(hash);
    if (r.state !== "included") return { state: "pending" };
    const ev = r.evidence;
    acceptEvidence(ev, "l2-receipt", { acceptTrust }, "receipt-unverified");
    if (lc(ev.txHash) !== hash || lc(ev.receipt?.transactionHash) !== hash) refuse("receipt-identity", "the minted receipt is for another transaction");
    const tx = await bindTransaction({ hash, raw, txLookup });
    if (lc(ev.receipt.from) !== tx.from) refuse("receipt-sender", `the receipt names sender ${lc(ev.receipt.from)}, the signed transaction ${tx.from}`);
    if (from !== null && tx.from !== lc(from)) refuse("receipt-sender", `transaction ${hash} is signed by ${tx.from}, not the intended ${lc(from)}`);
    if (nonce !== null && tx.nonce !== Number(nonce)) refuse("receipt-nonce", `transaction ${hash} carries nonce ${tx.nonce}, not the intended ${nonce}`);
    return { state: "included", evidence: ev, status: ev.receipt.status, level: ev.level, trust: ev.trust, blockNumber: ev.blockNumber, blockHash: lc(ev.blockHash), transaction: tx,
      binding: raw ? "hash = keccak256 of the signed bytes this client holds; sender recovered from their signature; nonce from those bytes"
        : "the transaction's fields re-encoded with its own signature hash to the receipt's hash; sender recovered from that signature; nonce from those fields" };
  }
  return Object.freeze({ trust, acceptTrust, fixture: !!fx, label, l1, base, readiness, receipt });
}

/** How a verified inclusion may be described: E's facts verbatim (verifiedBy, trust, level), never "final" beyond them. */
export function describeInclusion(v) {
  const t = v.trust === TRUST.TEST_FIXTURE ? "TEST FIXTURE - " : "";
  return `${t}${v.status} in block ${v.blockNumber}: receipt minted by the local Base node source (verifiedBy '${v.evidence.verifiedBy}', trust '${v.trust}', level '${v.level}'); `
    + "hash, sender and nonce bound to the signed transaction";
}
