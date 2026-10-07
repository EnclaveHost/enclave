// Sessions relayer + keeper + index (docs/design/sessions.md §5-6).
//
// Session keys sign intents; this relay SUBMITS them to the owner's
// SessionVault and is reimbursed by the vault, in USDC, through the
// PaymentRouter (the fee is part of what the key signed - the relay can't
// change it). The relay is trusted for liveness only: it can't forge a
// signature, change an amount or pick a destination. If it censors, the owner
// calls the vault directly; every owner operation has a direct form.
//
// It runs its OWN hot key (SESSIONS_RELAYER_KEY) with its own nonce manager and
// write-ahead journal - never PROVISIONER_PRIVATE_KEY, whose two existing
// writers already race on one nonce.
//
// Activation (all three, or the surface answers 503 sessions_disabled):
//   AUTH_DATA_DIR            the relay's state dir (journal + index live there)
//   SESSIONS_RELAYER_KEY     0x-hex private key of the relayer EOA (funded with ETH)
//   SESSIONS_FACTORY         SessionVaultFactory address (else the book's "sessionVaultFactory")
// Optional: SESSIONS_NETWORK (base | base-sepolia | local), SESSIONS_RPC (comma list),
//   SESSIONS_BOOK, SESSIONS_START_BLOCK, SESSIONS_FEE_MARGIN_BPS (2000), SESSIONS_MIN_FEE6 (500),
//   SESSIONS_ETH_USD (fallback price, 3000), SESSIONS_ETH_USD_FEED, SESSIONS_MIN_ETH_WEI,
//   SESSIONS_OWNER_OPS_PER_DAY (60), SESSIONS_SITE (origin used in links).
// Attested session keys (POST /v1/sessions/attest, phase g; off unless SESSIONS_KEY_ATTESTATIONS is set, and
// then answering 503 attest_disabled until every policy piece is set too; see "Attested session keys" below):
//   SESSIONS_KEY_ATTESTATIONS     EnclaveKeyAttestations address (the relayer key must be one of its attestors)
//   SESSIONS_ATTEST_MIN_TCB       JSON minimum-TCB policy per product line (relay/snp-verify.mjs checkMinTcb)
//   SESSIONS_ATTEST_VMPL          the VMPL a key's report must state (0-3)
//   SESSIONS_ATTEST_MEASUREMENTS  "*" (any image) or a comma list of 48-byte SNP measurements (96 hex)
//   SESSIONS_ATTEST_MAX_PER_DAY   on-chain attestations per UTC day (200): bounds the relayer's gas

import { createPublicClient, createWalletClient, decodeErrorResult, decodeEventLog, decodeFunctionResult, encodeAbiParameters, encodeFunctionData,
  fallback, getAddress, http, isAddress, keccak256, parseEventLogs } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { base, baseSepolia, foundry } from "viem/chains";
import { createPublicKey, verify as nodeVerify, createHash } from "node:crypto";
import { sessionVaultAbi, sessionVaultFactoryAbi } from "./sessions-abi.mjs";
import { verifyQuote, parseSnpReport, provenSnpChip, seedCertChain } from "./snp-verify.mjs";

const ZERO = "0x0000000000000000000000000000000000000000";
const BOOK_FACTORY = "0x" + Buffer.from("sessionVaultFactory").toString("hex").padEnd(64, "0");

// gas units per action for the fee quote: measured on anvil (osaka, native
// P-256) through this relay, padded ~15-30%. create 565-749k (with funding),
// publish 350-571k (the first publish also creates the app), fund 240k (cap +
// fee + lease checks, re-base), setShares 204k, setAppRef 183k.
const GAS = { 0: 850_000n, 1: 300_000n, 2: 240_000n, 3: 280_000n, 4: 300_000n, 5: 220_000n, 6: 220_000n,
  7: 300_000n, 8: 750_000n };   // (9 was order.pay: dropped before launch)
const CLOSE_GAS = 200_000n;

const ser = (o) => JSON.stringify(o, (_k, v) => (typeof v === "bigint" ? `${v}n` : v));
const de = (s) => JSON.parse(s, (_k, v) => (typeof v === "string" && /^\d+n$/.test(v) ? BigInt(v.slice(0, -1)) : v));
const big = (v, name) => {
  if (typeof v === "bigint") return v;
  if (typeof v === "number" && Number.isSafeInteger(v) && v >= 0) return BigInt(v);
  if (typeof v === "string" && /^\d{1,78}n?$/.test(v)) return BigInt(v.replace(/n$/, ""));
  throw httpError(400, "bad_request", `${name} must be a non-negative integer`);
};
const hex32 = (v, name) => {
  if (typeof v !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(v)) throw httpError(400, "bad_request", `${name} must be 32-byte hex`);
  return v.toLowerCase();
};
const hexAny = (v, name, max = 64 * 1024) => {
  if (typeof v !== "string" || !/^0x([0-9a-fA-F]{2})*$/.test(v) || v.length > 2 + 2 * max)
    throw httpError(400, "bad_request", `${name} must be hex`);
  return v;
};
const addr = (v, name) => {
  if (typeof v !== "string" || !isAddress(v)) throw httpError(400, "bad_request", `${name} must be an address`);
  return getAddress(v);
};
function httpError(status, code, message, extra) {
  const e = new Error(message);
  e.status = status; e.code = code; e.extra = extra;
  return e;
}

/** Pull revert data out of a viem error (simulation or send). Duck-typed down the
 *  cause chain, not instanceof: the client that threw may come from another copy of
 *  viem than this module's (a test harness, a bundle). */
export function revertData(e) {
  for (let x = e, i = 0; x && i < 12; x = x.cause, i++) {
    if (typeof x.raw === "string" && /^0x[0-9a-fA-F]{8}/.test(x.raw)) return x.raw;
    if (typeof x.data === "string" && /^0x[0-9a-fA-F]{8}/.test(x.data)) return x.data;
  }
  return undefined;
}

/** EIP-1559 fees from the block's base fee and a CAPPED tip: an RPC that suggests an
 *  absurd priority fee (anvil says 1 gwei; Base runs ~0.001) must not inflate what the
 *  relayer pays, nor the USDC fee a session is quoted. */
export async function cappedFees(pc, maxTipWei = 10_000_000n) {
  const blk = await pc.getBlock();
  const base = blk.baseFeePerGas ?? 0n;
  let tip = 1_000_000n;
  try { tip = await pc.estimateMaxPriorityFeePerGas(); } catch { /* keep the default */ }
  if (tip > maxTipWei) tip = maxTipWei;
  return { maxFeePerGas: base * 2n + tip, maxPriorityFeePerGas: tip };
}

// ============================================================================
// Transaction queue: one key, one serial lane, journaled before every await
// ============================================================================

export class TxQueue {
  constructor({ pc, wc, account, journal, log = console.log, alert = () => {}, receiptTimeoutMs = 25_000, maxAttempts = 5,
    maxTipWei = 10_000_000n }) {
    Object.assign(this, { pc, wc, account, journal, log, alert, receiptTimeoutMs, maxAttempts, maxTipWei });
    this.chain = Promise.resolve();
    this.nonce = null;
    if (!journal.data.txs) journal.data.txs = [];
  }

  /** Serialize sends: each waits for the previous to be mined (or given up). */
  send(item) {
    const p = this.chain.then(() => this._send(item));
    this.chain = p.catch(() => {});
    return p;
  }

  async _nextNonce() {
    const onChain = await this.pc.getTransactionCount({ address: this.account.address, blockTag: "pending" });
    if (this.nonce === null || onChain > this.nonce) this.nonce = onChain;
    return this.nonce;
  }

  async _send({ to, data, label }) {
    const gas = (await this.pc.estimateGas({ account: this.account, to, data })) * 125n / 100n + 20_000n;
    let fees = await cappedFees(this.pc, this.maxTipWei);
    const nonce = await this._nextNonce();
    const rec = { label, to, nonce, hashes: [], status: "sending", at: Date.now() };
    this.journal.data.txs.push(rec);
    if (this.journal.data.txs.length > 500) this.journal.data.txs.splice(0, this.journal.data.txs.length - 500);
    for (let attempt = 0; attempt < this.maxAttempts; attempt++) {
      let hash;
      try {
        hash = await this.wc.sendTransaction({ account: this.account, chain: this.wc.chain, to, data, gas, nonce,
          maxFeePerGas: fees.maxFeePerGas, maxPriorityFeePerGas: fees.maxPriorityFeePerGas });
      } catch (e) {
        const m = String(e?.shortMessage || e?.message || e);
        if (/nonce too low|already known|replacement transaction underpriced/i.test(m)) {
          const mined = await this._minedAny(rec.hashes);
          if (mined) return this._done(rec, mined);
          if (/nonce too low/i.test(m)) { this.nonce = null; rec.status = "nonce_lost"; this.journal.saveSoon(); throw e; }
        } else { rec.status = "send_failed"; rec.error = m.slice(0, 300); this.journal.flush(); throw e; }
      }
      if (hash) { rec.hashes.push(hash); rec.status = "sent"; this.journal.flush(); }
      try {
        const rc = await this.pc.waitForTransactionReceipt({ hash: hash ?? rec.hashes.at(-1),
          timeout: this.receiptTimeoutMs * (attempt + 1) });
        return this._done(rec, rc);
      } catch {
        const mined = await this._minedAny(rec.hashes);
        if (mined) return this._done(rec, mined);
        // replace at the same nonce, fees up 25% (clears the 10% replacement floor)
        fees = { maxFeePerGas: fees.maxFeePerGas * 125n / 100n + 1n,
          maxPriorityFeePerGas: fees.maxPriorityFeePerGas * 125n / 100n + 1n };
        this.log(`[sessions] ${label}: not mined yet, replacing at nonce ${nonce} (attempt ${attempt + 2})`);
      }
    }
    rec.status = "stuck";
    this.journal.flush();
    this.alert("sessions_stuck_tx", { label, nonce, hashes: rec.hashes });
    throw httpError(503, "relay", "the transaction is taking unusually long to be included; it may still land");
  }

  async _minedAny(hashes) {
    for (const h of hashes) {
      try { const rc = await this.pc.getTransactionReceipt({ hash: h }); if (rc) return rc; } catch {}
    }
    return null;
  }

  _done(rec, rc) {
    rec.status = rc.status === "success" ? "mined" : "reverted";
    rec.hash = rc.transactionHash;
    rec.block = Number(rc.blockNumber);
    rec.gasUsed = rc.gasUsed?.toString();
    this.nonce = Math.max(this.nonce ?? 0, rec.nonce + 1);
    this.journal.saveSoon();
    return rc;
  }
}

// ============================================================================
// Attested session keys (docs/design/sessions.md §10, phase g)
// ============================================================================
//
// A grant with measurement != 0 may only be used by a key GENERATED INSIDE an
// enclave running that image. The enclave proves it with its SEV-SNP report:
//
//   report_data[0:32] = sha256("enclave-session-key-v1" ‖ chainId ‖ x ‖ y)
//                       (ASCII domain, then three 32-byte big-endian integers)
//
// The relay verifies the report with relay/snp-verify.mjs (AMD signature over
// the report, VCEK -> ASK -> pinned ARK, VCEK matches the report's chip and
// TCB, the caller's minimum TCB, the pinned VMPL, DEBUG and MIGRATE_MA off),
// re-checks the fields it depends on itself, and records
//
//   EnclaveKeyAttestations.attest(keyHash, measurement)
//     keyHash     = keccak256(abi.encode(uint256 x, uint256 y))   (the vault's)
//     measurement = sha256(MEASUREMENT)                            (MAPPING below)
//
// MEASUREMENT MAPPING: an SNP launch measurement is 48 bytes (SHA-384) and the
// vault's grant field is bytes32, so the bytes32 is sha256 of the 48 raw bytes.
// An owner who wants "keys made in image M" puts snpMeasurementToBytes32(M) in
// the grant. The response states the mapping and both values.
//
// The relay is the TRUSTED party here (sessions.md §10): the contract cannot
// check a report, so everything below fails closed. A report is never trusted
// for anything but a refusal until the verifier has checked its signature.
// No freshness challenge: a key is attested once, re-presenting the same report
// re-attests the same (key, measurement), which is a no-op on chain.

export const SESSION_KEY_DOMAIN = "enclave-session-key-v1";
export const SESSION_KEY_MEASUREMENT_MAPPING = "sha256(SEV-SNP MEASUREMENT, the 48 raw bytes)";
const SNP_REPORT_BYTES = 0x4a0;              // ATTESTATION_REPORT, SEV-SNP ABI
const SNP_VCEK_GUID = "63da758de6644564adc5f4b93be8accd";
const TWO_256 = 1n << 256n;

const u256be = (v, name) => {
  const b = typeof v === "bigint" ? v : BigInt(v);
  if (b < 0n || b >= TWO_256) throw new Error(`${name} out of range`);
  return Buffer.from(b.toString(16).padStart(64, "0"), "hex");
};

/** report_data[0:32] a session key's SNP report must carry:
 *  sha256("enclave-session-key-v1" ‖ uint256 chainId ‖ uint256 x ‖ uint256 y), all big-endian. */
export function sessionKeyReportData(chainId, x, y) {
  return createHash("sha256").update(sessionKeyPreimage(chainId, x, y)).digest();
}
function sessionKeyPreimage(chainId, x, y) {
  return Buffer.concat([Buffer.from(SESSION_KEY_DOMAIN, "ascii"), u256be(chainId, "chainId"), u256be(x, "x"), u256be(y, "y")]);
}

/** The bytes32 a grant names for an SNP image: sha256 of its 48-byte launch measurement. */
export function snpMeasurementToBytes32(m) {
  const b = Buffer.isBuffer(m) ? m : Buffer.from(String(m).replace(/^0x/, ""), "hex");
  if (b.length !== 48) throw new Error("an SEV-SNP measurement is 48 bytes");
  return "0x" + createHash("sha256").update(b).digest("hex");
}

/** keccak256(abi.encode(uint256 x, uint256 y)): SessionVault's keyHash. */
export function sessionKeyHash(x, y) {
  return keccak256(encodeAbiParameters([{ type: "uint256" }, { type: "uint256" }], [BigInt(x), BigInt(y)]));
}

// The report fields the attestation depends on, read from the raw bytes. Run twice: BEFORE verification only
// to refuse early (no KDS fetch for a report that cannot pass), and AFTER it as belt and braces over the verdict.
// Returns null, or [status, code, message].
export function snpKeyReportRefusal(report, { binding, vmpl, measurements }) {
  let p;
  try { p = parseSnpReport(report); } catch (e) { return [422, "bad_report", `unparseable report: ${e.message}`]; }
  const signingKey = (report.readUInt32LE(0x48) >> 2) & 0x7;
  if (p.version < 2) return [422, "bad_report", `report version ${p.version} < 2`];
  if (p.policy & (1n << 19n)) return [403, "policy_refused", "the guest policy allows DEBUG (the host can read guest memory, the key included)"];
  if (p.policy & (1n << 18n)) return [403, "policy_refused", "the guest policy allows MIGRATE_MA"];
  if (signingKey !== 0) return [403, "not_vcek_signed", "the report is not signed by the chip's VCEK"];
  if (p.vmpl !== vmpl) return [403, "vmpl_mismatch", `the report states VMPL ${p.vmpl}, not the pinned ${vmpl}`];
  if (!p.reportData.subarray(0, 32).equals(binding))
    return [422, "report_data_mismatch", "report_data[0:32] is not sha256(\"enclave-session-key-v1\" ‖ chainId ‖ x ‖ y) for this key on this chain"];
  if (measurements !== "*" && !measurements.has(p.measurement.toString("hex")))
    return [403, "measurement_not_allowed", "this relay does not attest keys for this image's measurement"];
  return null;
}

/** A VCEK (PEM, or DER as hex) as the certificate table verifyQuote reads (the guest's auxblob layout):
 *  one {GUID, offset, length} entry, a zero terminator, then the DER. The VCEK is untrusted either way:
 *  the verifier chains it to the pinned AMD root and matches it to the report's chip and TCB. */
export function vcekAuxblob(vcek) {
  const s = String(vcek).trim();
  const der = s.includes("-----BEGIN") ? Buffer.from(s.replace(/-----[^-]+-----|\s/g, ""), "base64")
    : Buffer.from(s.replace(/^0x/, ""), "hex");
  if (der.length < 64 || der[0] !== 0x30) throw new Error("vcek is not a DER certificate (PEM or hex)");
  const hdr = Buffer.alloc(48);
  Buffer.from(SNP_VCEK_GUID, "hex").copy(hdr, 0);
  hdr.writeUInt32LE(48, 16);
  hdr.writeUInt32LE(der.length, 20);
  return Buffer.concat([hdr, der]);
}

/** The default verifier: relay/snp-verify.mjs verifyQuote. Its freshness check is report_data[0:32] ==
 *  sha256(transportKeySpki ‖ challenge); the session-key binding's preimage is split there (the domain as
 *  the first part, chainId ‖ x ‖ y as the second), so the verifier checks exactly sessionKeyReportData().
 *  `allowedMeasurements` "*" admits the report's own measurement: the image is the GRANT's policy, and the
 *  relay records whichever image the hardware proves (an allowlist, when set, narrows what it will pay to write). */
export async function verifySnpKeyReport(report, { preimage, auxblob, minTcb, vmpl, measurements, kds = true }) {
  const domain = Buffer.from(SESSION_KEY_DOMAIN, "ascii");
  if (!preimage.subarray(0, domain.length).equals(domain)) throw new Error("not a session-key preimage");
  const allowed = measurements === "*" ? [parseSnpReport(report).measurement.toString("hex")] : [...measurements];
  return verifyQuote(report, { transportKeySpki: domain, challenge: preimage.subarray(domain.length),
    allowedMeasurements: allowed, auxblob, requireVcek: true, minTcb, kds, expectedVmpl: vmpl });
}

export const keyAttestationsAbi = [
  { type: "function", name: "attest", stateMutability: "nonpayable",
    inputs: [{ name: "keyHash", type: "bytes32" }, { name: "measurement", type: "bytes32" }], outputs: [] },
  { type: "function", name: "bindingOf", stateMutability: "view", inputs: [{ name: "keyHash", type: "bytes32" }],
    outputs: [{ name: "measurement", type: "bytes32" }, { name: "revoked", type: "bool" }] },
  { type: "function", name: "getBinding", stateMutability: "view", inputs: [{ name: "keyHash", type: "bytes32" }],
    outputs: [{ name: "", type: "tuple", internalType: "struct EnclaveKeyAttestations.Binding", components: [
      { name: "measurement", type: "bytes32", internalType: "bytes32" }, { name: "attestedAt", type: "uint64", internalType: "uint64" },
      { name: "attestor", type: "address", internalType: "address" }, { name: "revoked", type: "bool", internalType: "bool" }] }] },
  { type: "function", name: "isAttestor", stateMutability: "view", inputs: [{ name: "", type: "address" }], outputs: [{ name: "", type: "bool" }] },
  { type: "event", name: "KeyAttested", anonymous: false, inputs: [{ name: "keyHash", type: "bytes32", indexed: true },
    { name: "measurement", type: "bytes32", indexed: true }, { name: "attestor", type: "address", indexed: true }] },
  { type: "error", name: "NotAttestor", inputs: [] },
  { type: "error", name: "ZeroKey", inputs: [] },
  { type: "error", name: "ZeroMeasurement", inputs: [] },
  { type: "error", name: "MeasurementConflict", inputs: [{ name: "keyHash", type: "bytes32" }, { name: "recorded", type: "bytes32" }] },
  { type: "error", name: "KeyIsRevoked", inputs: [{ name: "keyHash", type: "bytes32" }] },
];

// The attestor config, checked once; anything missing keeps the route at 503 attest_disabled.
function attestorSetup(a) {
  if (!a) return { why: "attested session keys are not enabled on this relay" };
  const missing = [];
  if (!isAddress(a.address || "")) missing.push("the EnclaveKeyAttestations address");
  if (!a.minTcb || typeof a.minTcb !== "object" || Array.isArray(a.minTcb) || !Object.keys(a.minTcb).length)
    missing.push("a minimum-TCB policy");
  if (!Number.isInteger(a.vmpl) || a.vmpl < 0 || a.vmpl > 3) missing.push("the pinned VMPL (0-3)");
  let measurements = null;
  if (a.measurements === "*") measurements = "*";
  else if (Array.isArray(a.measurements) && a.measurements.length
           && a.measurements.every((m) => /^[0-9a-f]{96}$/.test(String(m).toLowerCase().replace(/^0x/, ""))))
    measurements = new Set(a.measurements.map((m) => String(m).toLowerCase().replace(/^0x/, "")));
  else missing.push("the measurement policy (\"*\" or a list of 48-byte SNP measurements)");
  if (a.verifySnp !== undefined && typeof a.verifySnp !== "function") missing.push("a callable verifier");
  if (a.queue !== undefined && (typeof a.queue?.send !== "function" || !isAddress(a.queue?.account?.address || "")))
    missing.push("a queue with an account");
  if (a.maxPerDay !== undefined && !(Number.isInteger(a.maxPerDay) && a.maxPerDay >= 0)) missing.push("a whole-number daily cap");
  if (missing.length) return { why: `attested session keys are not fully configured (missing: ${missing.join(", ")})` };
  // a held copy of AMD's chain (a file of KDS's cert_chain) is pinned like a fetched one: a wrong root throws here
  for (const [product, pem] of Object.entries(a.certChains || {})) seedCertChain(product, pem);
  return { address: getAddress(a.address), minTcb: a.minTcb, vmpl: a.vmpl, measurements, kds: a.kds !== false,
    verify: a.verifySnp ?? verifySnpKeyReport, queue: a.queue ?? null, maxPerDay: a.maxPerDay ?? 200 };
}

// ============================================================================
// The service
// ============================================================================

const NETS = {
  base: { chain: base, rpc: ["https://base-rpc.publicnode.com", "https://mainnet.base.org"],
    book: "0xab214342d5A490150A4A977063A2f88E21F80907", ethUsdFeed: "0x71041dddad3595F9CEd3DcCFBe3D1F4b0a16Bb70" },
  "base-sepolia": { chain: baseSepolia, rpc: ["https://sepolia.base.org"],
    ethUsdFeed: "0x4aDC67696bA383F43DD60A9e78F2C97Fbbfc7cb1" },
  local: { chain: foundry, rpc: ["http://127.0.0.1:8545"] },
};

const FEED_ABI = [{ type: "function", name: "latestRoundData", stateMutability: "view", inputs: [],
  outputs: [{ type: "uint80" }, { type: "int256" }, { type: "uint256" }, { type: "uint256" }, { type: "uint80" }] }];
const BOOK_ABI = [{ type: "function", name: "addr", stateMutability: "view", inputs: [{ type: "bytes32" }], outputs: [{ type: "address" }] }];

/** Build the sessions service. Everything external is injectable for tests. */
export function createSessionsService(o) {
  const log = o.log ?? ((...a) => console.log("[sessions]", ...a));
  const alert = o.alert ?? (() => {});
  const now = o.now ?? (() => Math.floor(Date.now() / 1000));
  const { pc, wc, account, chainId } = o;
  const store = o.store;            // JsonStore-like: { data, saveSoon(), flush() }
  const journal = o.journal;
  store.data.cursor ??= o.startBlock != null ? String(o.startBlock) : null;
  store.data.vaults ??= {};         // vault -> owner
  store.data.sessions ??= {};       // sid -> record
  store.data.ops ??= {};            // sid -> [op]
  store.data.held ??= {};           // deployment id -> { vault, env, promoted }
  store.data.revoked ??= {};        // sid -> unix (off-chain revocation, before or without the chain)
  store.data.revokedVaults ??= {};  // vault -> { at, block } of a revokeAll this relay submitted (block null: in flight)
  const maxTipWei = BigInt(o.maxTipWei ?? 10_000_000n);
  const queue = new TxQueue({ pc, wc, account, journal, log, alert, maxTipWei });
  const marginBps = BigInt(o.feeMarginBps ?? 2000);
  const minFee6 = BigInt(o.minFee6 ?? 500);
  const ownerOpsPerDay = o.ownerOpsPerDay ?? 60;
  let factory = o.factory ? getAddress(o.factory) : null;
  const isVaultCache = new Map();
  const liveCache = new Map();      // `${vault}:${sid}` -> { at, state }
  const ownerOpsCount = new Map();  // owner -> { day, n }
  const replay = new Map();         // api nonce -> expiry
  const att = attestorSetup(o.attestor);
  const attestDay = { day: -1, n: 0 };
  if (o.attestor) log(att.address ? `attest: on, EnclaveKeyAttestations ${att.address}` : `attest: off (${att.why})`);

  async function getFactory() {
    if (factory) return factory;
    if (!o.book) throw httpError(503, "sessions_disabled", "no SessionVaultFactory configured");
    const a = await pc.readContract({ address: o.book, abi: BOOK_ABI, functionName: "addr", args: [BOOK_FACTORY] });
    if (!a || a === ZERO) throw httpError(503, "sessions_disabled", "the address book has no sessionVaultFactory yet");
    return (factory = getAddress(a));
  }

  async function isVault(v) {
    if (isVaultCache.get(v) === true) return true;
    const ok = await pc.readContract({ address: await getFactory(), abi: sessionVaultFactoryAbi, functionName: "isVault", args: [v] });
    if (ok) isVaultCache.set(v, true);
    return ok;
  }

  async function requireVault(v) {
    const a = addr(v, "vault");
    if (!(await isVault(a))) throw httpError(404, "not_a_vault", `${a} is not a SessionVault of this factory`);
    return a;
  }

  async function sessionOf(vault, sid) {
    const [s, live, apps] = await pc.readContract({ address: vault, abi: sessionVaultAbi, functionName: "sessionOf", args: [sid] });
    return { ...s, live, apps };
  }

  async function ethUsd6() {
    if (o.ethUsdFeed) {
      try {
        const [, answer, , updatedAt] = await pc.readContract({ address: o.ethUsdFeed, abi: FEED_ABI, functionName: "latestRoundData" });
        if (answer > 0n && now() - Number(updatedAt) < 6 * 3600) return answer / 100n;   // 8dp -> 6dp
      } catch { /* fall back */ }
    }
    return BigInt(Math.round((o.ethUsd ?? 3000) * 1e6));
  }

  /** USDC (6dp) to reimburse `gas` units at today's fee level, with margin. */
  async function feeFor(gas) {
    const fees = o.feesPerGas ? await o.feesPerGas() : await cappedFees(pc, maxTipWei);
    const wei = gas * fees.maxFeePerGas;
    const usd6 = (wei * (await ethUsd6()) + 10n ** 18n - 1n) / 10n ** 18n;
    const withMargin = usd6 * (10_000n + marginBps) / 10_000n;
    return withMargin > minFee6 ? withMargin : minFee6;
  }

  /** `afterSimulate` runs only once the vault has ACCEPTED the call in
   *  simulation (signatures checked) - off-chain revocation goes there, so a
   *  forged sign-out can never cut anyone's API access. */
  async function simulateAndSend({ to, abi, functionName, args, label, afterSimulate }) {
    try {
      await pc.simulateContract({ address: to, abi, functionName, args, account });
    } catch (e) {
      const data = revertData(e);
      if (!data) log(`simulation of ${label} failed without revert data: ${e.shortMessage || e.message}`);
      throw httpError(409, "revert", `the vault refused: ${e.shortMessage || e.message}`.slice(0, 400), { revert: data });
    }
    afterSimulate?.();
    const { encodeFunctionData } = await import("viem");
    const rc = await queue.send({ to, data: encodeFunctionData({ abi, functionName, args }), label });
    if (rc.status !== "success") throw httpError(409, "revert", `${label} reverted on-chain (${rc.transactionHash})`);
    // fold this receipt's vault/factory events into the index right away
    ingestLogs(rc.logs);
    return rc;
  }

  /** Relayed (gas-free) owner operations per owner per day. Checked BEFORE simulation but
   *  only COUNTED after the vault accepted the signature (a stranger can't burn an owner's
   *  quota with junk), and never applied to terminate / revokeAll: an owner without ETH must
   *  always be able to stop a leaked key. */
  function rateOwner(owner, op, commit = false) {
    if (op === "terminate" || op === "revokeAll") return;
    const day = Math.floor(now() / 86400);
    let c = ownerOpsCount.get(owner);
    if (!c || c.day !== day) { c = { day, n: 0 }; ownerOpsCount.set(owner, c); }
    if (c.n >= ownerOpsPerDay) throw httpError(429, "rate", "too many owner operations today; submit directly to your vault");
    if (commit) c.n++;
  }

  // ---- index -----------------------------------------------------------------

  function ingestLogs(logs) {
    const f = factory?.toLowerCase();
    for (const l of logs) {
      const a = l.address.toLowerCase();
      try {
        if (a === f) {
          const ev = decodeEventLog({ abi: sessionVaultFactoryAbi, data: l.data, topics: l.topics });
          if (ev.eventName === "VaultCreated") store.data.vaults[getAddress(ev.args.vault)] = getAddress(ev.args.owner);
          continue;
        }
        const vault = getAddress(l.address);
        if (!store.data.vaults[vault]) continue;
        const ev = decodeEventLog({ abi: sessionVaultAbi, data: l.data, topics: l.topics });
        const A = ev.args;
        const blk = l.blockNumber != null ? Number(l.blockNumber) : null;
        switch (ev.eventName) {
          case "SessionOpened":
            // merge, never replace: a re-scan replays Opened after Ended/Extended were already folded in
            store.data.sessions[A.sid] = { ...(store.data.sessions[A.sid] ?? {}), vault, keyHash: A.keyHash,
              expiresAt: Math.max(Number(A.expiresAt), store.data.sessions[A.sid]?.expiresAt ?? 0),
              actions: A.actions.toString(), envs: Number(A.envs), budget6: A.budget6.toString(), label: A.label,
              openedBlock: blk ?? store.data.sessions[A.sid]?.openedBlock ?? null, tx: l.transactionHash };
            break;
          case "SessionOp": {
            const list = (store.data.ops[A.sid] ??= []);
            if (!list.some((x) => x.tx === l.transactionHash && x.nonce === A.nonce.toString()))
              list.push({ nonce: A.nonce.toString(), action: Number(A.action), amount6: A.amount6.toString(),
                fee6: A.fee6.toString(), argsHash: A.argsHash, tx: l.transactionHash, block: blk });
            if (list.length > 200) list.splice(0, list.length - 200);
            break;
          }
          case "SessionEnded": {
            store.data.revoked[A.sid] ??= now();            // API access ends with it (owner-direct ends too)
            const s = store.data.sessions[A.sid];
            if (s) Object.assign(s, { ended: true, reason: Number(A.reason), refund6: A.refund6.toString(), endTx: l.transactionHash });
            break;
          }
          case "ToppedUp": {
            const s = store.data.sessions[A.sid];
            if (s) s.toppedUp6 = (BigInt(s.toppedUp6 ?? "0") + A.amount6).toString();
            break;
          }
          case "Extended": { const s = store.data.sessions[A.sid]; if (s) s.expiresAt = Number(A.expiresAt); break; }
          case "RevokedAll":
            // only sessions that existed at that block: a re-scan replays an old
            // RevokedAll after newer sessions are already in the index
            for (const [sid, s] of Object.entries(store.data.sessions))
              if (s.vault === vault && !s.ended && (blk == null || s.openedBlock == null || s.openedBlock <= blk)) {
                Object.assign(s, { ended: true, reason: 4 });
                store.data.revoked[sid] ??= now();
              }
            break;
          case "HeldSet": store.data.held[A.id] = { vault, env: Number(A.env), createdBy: A.createdBy, promoted: store.data.held[A.id]?.promoted ?? null }; break;
          case "Promoted": (store.data.held[A.id] ??= { vault }).promoted = A.promoted; break;
          case "Released": delete store.data.held[A.id]; break;
        }
      } catch { /* not one of ours */ }
    }
    store.saveSoon();
  }

  async function indexOnce() {
    const f = await getFactory();
    const head = await pc.getBlockNumber();
    const safe = head > 2n ? head - 2n : head;
    let from = store.data.cursor != null ? BigInt(store.data.cursor) + 1n : (safe > 5000n ? safe - 5000n : 0n);
    while (from <= safe) {
      const to = from + 1999n < safe ? from + 1999n : safe;
      const flogs = await pc.getLogs({ address: f, fromBlock: from, toBlock: to });
      ingestLogs(flogs);
      const vaults = Object.keys(store.data.vaults);
      for (let i = 0; i < vaults.length; i += 100) {
        const vlogs = await pc.getLogs({ address: vaults.slice(i, i + 100), fromBlock: from, toBlock: to });
        ingestLogs(vlogs);
      }
      store.data.cursor = to.toString();
      store.saveSoon();
      from = to + 1n;
    }
  }

  // ---- keeper ----------------------------------------------------------------

  const closing = new Map();   // sid -> last attempt
  async function keeperOnce() {
    const t = now();
    for (const [sid, s] of Object.entries(store.data.sessions)) {
      if (s.ended || s.expiresAt >= t) continue;
      if ((closing.get(sid) ?? 0) > t - 600) continue;
      closing.set(sid, t);
      try {
        const st = await sessionOf(s.vault, sid);
        const epoch = await pc.readContract({ address: s.vault, abi: sessionVaultAbi, functionName: "epoch" });
        if (Number(st.state) !== 1) { s.ended = true; continue; }
        if (st.epoch !== epoch || st.balance6 === 0n) { s.ended = true; s.reason ??= 3; continue; } // nothing to refund
        await simulateAndSend({ to: s.vault, abi: sessionVaultAbi, functionName: "close", args: [sid], label: `close ${sid.slice(0, 10)}` });
        log(`closed expired session ${sid.slice(0, 10)} (refund to owner)`);
      } catch (e) {
        log(`keeper: close ${sid.slice(0, 10)} failed: ${e.message}`);
        if (t - s.expiresAt > 3600) alert("sessions_close_overdue", { sid, vault: s.vault, error: e.message });
      }
    }
    store.saveSoon();
  }

  async function gasCheck() {
    const bal = await pc.getBalance({ address: account.address });
    if (bal < BigInt(o.minEthWei ?? 2_000_000_000_000_000n)) alert("sessions_relayer_low_gas", { relayer: account.address, wei: bal.toString() });
    return bal;
  }

  // ---- API request verification (used by other relay routes) -------------------

  const SCOPES = { "api.status": 128n, "api.logs": 129n, "api.restart": 130n, "api.upload": 131n, "api.appAccess": 132n,
    "api.placement": 133n, "api.account": 134n };

  /** Verify `Authorization: EnclaveSession v1 ...` for one request. Returns
   *  { vault, sid, owner, actions } or throws (401/403). `fresh` forces an
   *  on-chain liveness read (mutations); reads may use a <=5 s cache. */
  async function verifyApiRequest({ header, method, hostPath, body, scope, fresh = false }) {
    const m = /^EnclaveSession v1 (.+)$/.exec(header || "");
    if (!m) throw httpError(401, "unauthorized", "missing EnclaveSession authorization");
    const f = Object.fromEntries(m[1].split(",").map((kv) => { const i = kv.indexOf("="); return [kv.slice(0, i).trim(), kv.slice(i + 1).trim()]; }));
    const vault = addr(f.vault, "vault");
    const sid = hex32(f.sid, "sid");
    const ts = Number(f.ts);
    if (!Number.isInteger(ts) || Math.abs(now() - ts) > 60) throw httpError(401, "unauthorized", "stale or future request timestamp");
    if (!/^[A-Za-z0-9_-]{8,64}$/.test(f.n || "")) throw httpError(401, "unauthorized", "bad request nonce");
    const rkey = `${sid}:${f.n}`;
    if (replay.has(rkey)) throw httpError(401, "unauthorized", "replayed request");
    // claimed BEFORE any await: concurrent copies of one signed request must not all verify
    replay.set(rkey, now() + 120);
    try {
      return await verifyClaimed(f, vault, sid, ts, { method, hostPath, body, scope, fresh });
    } catch (e) { replay.delete(rkey); throw e; }
  }

  /** A revokeAll this relay submitted also covers sessions its index hadn't seen yet: while the
   *  revoke is in flight (<= 10 min) every session of the vault is refused, and once it is mined a
   *  session passes only if the index saw it OPEN after that block. */
  function revokedBeforeOpen(vault, sid) {
    const r = store.data.revokedVaults[vault];
    if (!r || typeof r !== "object") return false;
    if (r.block == null) return now() - r.at < 600;
    const ob = store.data.sessions[sid]?.openedBlock;
    return ob == null || ob <= r.block;
  }

  async function verifyClaimed(f, vault, sid, ts, { method, hostPath, body, scope, fresh }) {
    if (store.data.revoked[sid]) throw httpError(401, "session_ended", "this session has been signed out");
    const xb = Buffer.from(f.x || "", "base64url"), yb = Buffer.from(f.y || "", "base64url");
    if (xb.length !== 32 || yb.length !== 32) throw httpError(401, "unauthorized", "bad session public key");
    const bodyHash = createHash("sha256").update(body ?? Buffer.alloc(0)).digest("hex");
    const msg = `enclave-api-v1\n${method.toUpperCase()}\n${hostPath}\n${bodyHash}\n${ts}\n${f.n}\n${vault.toLowerCase()}\n${sid.toLowerCase()}`;
    const key = createPublicKey({ key: { kty: "EC", crv: "P-256", x: xb.toString("base64url"), y: yb.toString("base64url") }, format: "jwk" });
    const ok = nodeVerify("sha256", Buffer.from(msg), { key, dsaEncoding: "ieee-p1363" }, Buffer.from(f.sig || "", "base64url"));
    if (!ok) throw httpError(401, "unauthorized", "bad session signature");
    await requireVault(vault);
    const ck = `${vault}:${sid}`;
    let c = liveCache.get(ck);
    if (fresh || !c || Date.now() - c.at > 5000) {
      const st = await sessionOf(vault, sid);
      c = { at: Date.now(), st };
      liveCache.set(ck, c);
    }
    const keyHash = keccak256(encodeAbiParameters([{ type: "uint256" }, { type: "uint256" }],
      [BigInt("0x" + xb.toString("hex")), BigInt("0x" + yb.toString("hex"))]));
    if (c.st.keyHash.toLowerCase() !== keyHash.toLowerCase()) throw httpError(401, "unauthorized", "key does not belong to this session");
    if (!c.st.live) throw httpError(401, "session_ended", "this session has ended or expired");
    if (revokedBeforeOpen(vault, sid)) throw httpError(401, "session_ended", "every session of this vault was revoked");
    if (scope && !(scope in SCOPES)) throw httpError(500, "relay", `unknown API scope ${scope}`);
    if (scope && ((c.st.actions >> SCOPES[scope]) & 1n) === 0n) throw httpError(403, "not_allowed", `this session lacks ${scope}`);
    if (replay.size > 50_000) for (const [k, exp] of replay) if (exp < now()) replay.delete(k);
    const owner = store.data.vaults[vault] ?? await pc.readContract({ address: vault, abi: sessionVaultAbi, functionName: "owner" });
    return { vault, sid, owner: getAddress(owner), actions: c.st.actions, envs: Number(c.st.envs),
      anyApp: Boolean(c.st.anyApp), apps: c.st.apps || [], live: true };
  }

  // ---- HTTP --------------------------------------------------------------------

  async function route(method, path, body, ctx) {
    if (method === "GET" && path === "/config") {
      return { chainId, factory: await getFactory(), book: o.book ?? null, usdc: o.usdc ?? null, router: o.router ?? null,
        relayer: account.address, site: o.site ?? null, rpc: o.publicRpc ?? null, keyAttestations: att.address ?? null };
    }
    if (method === "POST" && path === "/attest") return attestKey(body);
    if (method === "POST" && path === "/quote") {
      const vault = await requireVault(body.vault);
      const sid = hex32(body.sid, "sid");
      const action = Number(body.action);
      if (!Number.isInteger(action) || !(action in GAS)) throw httpError(400, "bad_request", "unknown action");
      const st = await sessionOf(vault, sid);
      if (!st.live) throw httpError(409, "not_live", "this session is not live");
      const fee = await feeFor(GAS[action]);
      const nonce = BigInt(await pc.readContract({ address: vault, abi: sessionVaultAbi, functionName: "seqOf", args: [sid, 0n] }));
      return { fee, deadline: BigInt(now() + 120), nonce };
    }
    if (method === "POST" && path === "/execute") {
      const vault = await requireVault(body.vault);
      const sid = hex32(body.sid, "sid");
      if (store.data.revoked[sid]) throw httpError(409, "not_live", "this session has been signed out");
      const action = Number(body.action);
      if (!Number.isInteger(action) || !(action in GAS)) throw httpError(400, "bad_request", "unknown action");
      const fee = big(body.fee, "fee");
      const deadline = big(body.deadline, "deadline");
      if (deadline > BigInt(now() + 900)) throw httpError(400, "bad_request", "deadline too far out");
      const floor = await feeFor(GAS[action]);
      if (fee * 10n < floor * 8n) throw httpError(402, "fee", `fee ${fee} is below the current quote ${floor}; re-quote`);
      const args = [sid, big(body.nonce, "nonce"), action, hexAny(body.args, "args"), fee, deadline,
        big(body.x, "x"), big(body.y, "y"), hex32(body.r, "r"), hex32(body.s, "s")];
      const rc = await simulateAndSend({ to: vault, abi: sessionVaultAbi, functionName: "execute", args,
        label: `execute ${sid.slice(0, 10)}#${action}` });
      const ev = parseEventLogs({ abi: sessionVaultAbi, logs: rc.logs, eventName: "SessionOp" })
        .find((x) => x.address.toLowerCase() === vault.toLowerCase());
      return { txHash: rc.transactionHash, result: ev?.args.result ?? "0x", block: Number(rc.blockNumber) };
    }
    if (method === "POST" && path === "/open") {
      const owner = addr(body.owner, "owner");
      const scr = ctx?.screenAddress?.(owner);
      if (scr?.result === "hit") throw httpError(451, "refused", "this address cannot be served");
      rateOwner(owner, "open");
      const g = parseGrant(body.grant);
      const f = await getFactory();
      const vault = await pc.readContract({ address: f, abi: sessionVaultFactoryAbi, functionName: "vaultFor", args: [owner] });
      const sig = hexAny(body.ownerSig, "ownerSig", 2048);
      let rc;
      if (g.budget > 0n) {
        const d = body.deposit;
        if (!d) throw httpError(400, "bad_request", "a funded grant needs the USDC deposit authorization");
        rc = await simulateAndSend({ to: f, abi: sessionVaultFactoryAbi, functionName: "openWithDepositFor",
          args: [owner, g, sig, big(d.validAfter, "validAfter"), big(d.validBefore, "validBefore"), hexAny(d.sig, "deposit.sig", 2048)],
          label: `open+deposit ${owner.slice(0, 8)}`, afterSimulate: () => rateOwner(owner, "open", true) });
      } else {
        rc = await simulateAndSend({ to: f, abi: sessionVaultFactoryAbi, functionName: "openFor", args: [owner, g, sig],
          label: `open ${owner.slice(0, 8)}`, afterSimulate: () => rateOwner(owner, "open", true) });
      }
      store.data.vaults[getAddress(vault)] ??= owner;
      const ev = parseEventLogs({ abi: sessionVaultAbi, logs: rc.logs, eventName: "SessionOpened" })[0];
      if (!ev) throw httpError(500, "relay", "opened, but no SessionOpened event was found");
      ingestLogs(rc.logs);
      return { txHash: rc.transactionHash, vault: getAddress(vault), sid: ev.args.sid, block: Number(rc.blockNumber) };
    }
    if (method === "POST" && path === "/owner") {
      const owner = addr(body.owner, "owner");
      const vault = await requireVault(body.vault);
      const real = await pc.readContract({ address: vault, abi: sessionVaultAbi, functionName: "owner" });
      if (getAddress(real) !== owner) throw httpError(403, "not_owner", "that vault belongs to someone else");
      rateOwner(owner, body.op);
      const a = body.args ?? {};
      const sig = body.op === "topUpWithAuthorization" ? undefined : hexAny(body.sig, "sig", 2048);
      const on = () => hex32(a.opNonce, "opNonce");
      const sb = () => big(a.signBefore, "signBefore");
      let fn, args, afterSimulate;
      switch (body.op) {
        case "topUp": fn = "topUp"; args = [hex32(a.sessionId, "sessionId"), big(a.amount, "amount"), on(), sb(), sig]; break;
        case "topUpWithAuthorization":
          if (ctx?.screenAddress?.(owner)?.result === "hit") throw httpError(451, "refused", "this address cannot be served");
          fn = "topUpWithAuthorization";
          args = [hex32(a.sessionId, "sessionId"), big(a.amount, "amount"), on(), big(a.validAfter, "validAfter"),
            big(a.validBefore, "validBefore"), hexAny(a.sig, "sig", 2048)];
          break;
        case "extend": fn = "extend"; args = [hex32(a.sessionId, "sessionId"), big(a.expiresAt, "expiresAt"), on(), sb(), sig]; break;
        case "terminate": {
          const sid = hex32(a.sessionId, "sessionId");
          // off-chain BEFORE the chain (never more permissive than it), but only
          // once the vault has accepted the owner's signature in simulation
          afterSimulate = () => { store.data.revoked[sid] = now(); store.flush?.(); };
          fn = "terminate"; args = [sid, on(), sb(), sig];
          break;
        }
        case "revokeAll":
          afterSimulate = () => {
            store.data.revokedVaults[vault] = { at: now(), block: null };
            for (const [sid, s] of Object.entries(store.data.sessions)) if (s.vault === vault && !s.ended) store.data.revoked[sid] = now();
            store.flush?.();
          };
          fn = "revokeAll"; args = [Boolean(a.withdraw), on(), sb(), sig];
          break;
        case "withdraw": fn = "withdraw"; args = [big(a.amount, "amount"), on(), sb(), sig]; break;
        case "promote":
          if (typeof a.isPublic !== "boolean") throw httpError(400, "bad_request", "isPublic must be a boolean");
          fn = "promote"; args = [hex32(a.deployment, "deployment"), String(a.app), addr(a.publisher, "publisher"), String(a.appRef),
            String(a.configCid), String(a.versionLabel), a.isPublic, on(), sb(), sig];
          break;
        case "adopt": fn = "adopt"; args = [hex32(a.deployment, "deployment"), String(a.environment), on(), sb(), sig]; break;
        case "setEnvironment": fn = "setEnvironment"; args = [hex32(a.deployment, "deployment"), String(a.environment), on(), sb(), sig]; break;
        case "release": fn = "release"; args = [hex32(a.deployment, "deployment"), addr(a.to, "to"), on(), sb(), sig]; break;
        default: throw httpError(400, "bad_request", "unknown owner operation");
      }
      const revokeFirst = afterSimulate;
      const rc = await simulateAndSend({ to: vault, abi: sessionVaultAbi, functionName: fn, args, label: `${fn} ${vault.slice(0, 8)}`,
        afterSimulate: () => { rateOwner(owner, body.op, true); revokeFirst?.(); } });
      if (fn === "revokeAll") {      // from here a session of this vault must have OPENED after this block
        store.data.revokedVaults[vault] = { at: now(), block: Number(rc.blockNumber) };
        for (const k of liveCache.keys()) if (k.startsWith(`${vault}:`)) liveCache.delete(k);
        store.flush?.();
      }
      return { txHash: rc.transactionHash, block: Number(rc.blockNumber) };
    }
    if (method === "POST" && path === "/end") {
      const vault = await requireVault(body.vault);
      const sid = hex32(body.sid, "sid");
      // sign-out cuts API access before the chain catches up - once the vault
      // has accepted the session key's signature in simulation
      const rc = await simulateAndSend({ to: vault, abi: sessionVaultAbi, functionName: "terminateBySession",
        args: [sid, big(body.deadline, "deadline"), big(body.x, "x"), big(body.y, "y"), hex32(body.r, "r"), hex32(body.s, "s")],
        label: `end ${sid.slice(0, 10)}`, afterSimulate: () => { store.data.revoked[sid] = now(); store.flush?.(); } });
      const ev = parseEventLogs({ abi: sessionVaultAbi, logs: rc.logs, eventName: "SessionEnded" })[0];
      return { txHash: rc.transactionHash, refund6: ev?.args.refund6 ?? 0n };
    }
    let mm;
    if (method === "GET" && (mm = /^\/by-key\/(0x[0-9a-fA-F]{64})$/.exec(path))) {
      const kh = mm[1].toLowerCase();
      const out = Object.entries(store.data.sessions).filter(([, s]) => s.keyHash.toLowerCase() === kh)
        .map(([sid, s]) => ({ sid, ...s, owner: store.data.vaults[s.vault] }));
      return { sessions: out };
    }
    if (method === "GET" && (mm = /^\/owner\/(0x[0-9a-fA-F]{40})$/.exec(path))) {
      const owner = getAddress(mm[1]);
      const vault = await pc.readContract({ address: await getFactory(), abi: sessionVaultFactoryAbi, functionName: "vaultFor", args: [owner] });
      const sessions = Object.entries(store.data.sessions).filter(([, s]) => s.vault === vault)
        .map(([sid, s]) => ({ sid, ...s, revoked: Boolean(store.data.revoked[sid]), ops: (store.data.ops[sid] ?? []).length }));
      const held = Object.entries(store.data.held).filter(([, h]) => h.vault === vault).map(([id, h]) => ({ id, ...h }));
      const deployed = (await pc.getCode({ address: vault }))?.length > 2;
      return { owner, vault, deployed, sessions, held };
    }
    if (method === "GET" && (mm = /^\/session\/(0x[0-9a-fA-F]{40})\/(0x[0-9a-fA-F]{64})$/.exec(path))) {
      const vault = await requireVault(mm[1]);
      const sid = mm[2].toLowerCase();
      const st = await sessionOf(vault, sid);
      return { vault, sid, state: st, index: store.data.sessions[sid] ?? null, ops: store.data.ops[sid] ?? [],
        revoked: Boolean(store.data.revoked[sid]) || revokedBeforeOpen(getAddress(mm[1]), sid) };
    }
    throw httpError(404, "not_found", "no such sessions endpoint");
  }

  // ---- attested session keys (phase g; see "Attested session keys" above) ---------

  const coord = (v, name) => {
    let b;
    if (typeof v === "string" && /^0x[0-9a-fA-F]{1,64}$/.test(v)) b = BigInt(v);
    else b = big(v, name);
    if (b <= 0n || b >= TWO_256) throw httpError(400, "bad_request", `${name} must be a 256-bit coordinate`);
    return b;
  };
  const hexBuf = (v, name, maxBytes) => {
    if (typeof v !== "string") throw httpError(400, "bad_request", `${name} must be hex`);
    const h = v.replace(/^0x/, "");
    if (!/^([0-9a-fA-F]{2})*$/.test(h) || h.length > 2 * maxBytes) throw httpError(400, "bad_request", `${name} must be hex, at most ${maxBytes} bytes`);
    return Buffer.from(h, "hex");
  };
  const refuse = (keyHash, status, code, message) => {
    log(`attest refused ${keyHash ? keyHash.slice(0, 10) : "?"}: ${code}: ${message}`);
    return httpError(status, code, message);
  };
  // the stored record and whether it is live (recorded, not revoked, its attestor still named)
  async function bindingRecord(keyHash) {
    const b = await pc.readContract({ address: att.address, abi: keyAttestationsAbi, functionName: "getBinding", args: [keyHash] });
    const recorded = BigInt(b.measurement) !== 0n;
    const named = recorded && await pc.readContract({ address: att.address, abi: keyAttestationsAbi, functionName: "isAttestor", args: [b.attestor] });
    return { measurement: b.measurement.toLowerCase(), revoked: b.revoked, live: recorded && !b.revoked && named };
  }

  /** POST /attest {x, y, evidence: {type: "sev-snp", report: hex, vcek?: PEM|hex DER, auxblob?: hex}}
   *  -> {keyHash, measurement, snpMeasurement, mapping, contract, attestor, tcb, txHash, already} */
  async function attestKey(body) {
    if (!att.address) throw httpError(503, "attest_disabled", att.why);
    const q = att.queue ?? queue;
    const signer = q === queue ? account : att.queue.account;
    // the key: a point on P-256
    const x = coord(body?.x, "x"), y = coord(body?.y, "y");
    const b64 = (n) => Buffer.from(n.toString(16).padStart(64, "0"), "hex").toString("base64url");
    try { createPublicKey({ key: { kty: "EC", crv: "P-256", x: b64(x), y: b64(y) }, format: "jwk" }); }
    catch { throw httpError(422, "bad_key", "(x, y) is not a P-256 public key"); }
    const keyHash = sessionKeyHash(x, y);
    // the evidence
    const ev = body?.evidence;
    if (!ev || typeof ev !== "object") throw httpError(400, "bad_request", "evidence missing");
    if (ev.type !== "sev-snp") throw refuse(keyHash, 422, "unsupported_evidence", "only {type: \"sev-snp\"} evidence is accepted");
    const report = hexBuf(ev.report, "evidence.report", 4 * SNP_REPORT_BYTES);
    if (report.length !== SNP_REPORT_BYTES) throw refuse(keyHash, 422, "bad_report", `an SEV-SNP report is ${SNP_REPORT_BYTES} bytes, not ${report.length}`);
    if (ev.vcek != null && ev.auxblob != null) throw httpError(400, "bad_request", "give evidence.vcek or evidence.auxblob, not both");
    let auxblob = null;
    if (ev.vcek != null) {
      if (typeof ev.vcek !== "string" || ev.vcek.length > 16384) throw httpError(400, "bad_request", "evidence.vcek must be a PEM or hex DER certificate");
      try { auxblob = vcekAuxblob(ev.vcek); } catch (e) { throw refuse(keyHash, 422, "bad_vcek", e.message); }
    } else if (ev.auxblob != null) auxblob = hexBuf(ev.auxblob, "evidence.auxblob", 16384);
    const preimage = sessionKeyPreimage(chainId, x, y);
    const binding = createHash("sha256").update(preimage).digest();
    const policy = { binding, vmpl: att.vmpl, measurements: att.measurements };

    // 1. refusals readable off the raw report (it is trusted for nothing else yet): no KDS fetch for a report that cannot pass
    let why = snpKeyReportRefusal(report, policy);
    if (why) throw refuse(keyHash, ...why);
    // 2. the chain: this relay must be an attestor, and a revoked key is refused before any verification
    const named = await pc.readContract({ address: att.address, abi: keyAttestationsAbi, functionName: "isAttestor", args: [signer.address] });
    if (!named) throw refuse(keyHash, 503, "attestor_not_authorized", `${signer.address} is not an attestor of ${att.address}`);
    if ((await bindingRecord(keyHash)).revoked)
      throw refuse(keyHash, 409, "key_revoked", "this key's attestation was revoked, permanently: generate a new key");
    // 3. the hardware: AMD signature and chain to the pinned root, VCEK = this chip at this TCB, minimum TCB, VMPL,
    //    guest policy, report_data. Any error is a refusal.
    let v;
    try { v = await att.verify(report, { preimage, binding, auxblob, minTcb: att.minTcb, vmpl: att.vmpl, measurements: att.measurements, kds: att.kds }); }
    catch (e) { v = { ok: false, reasons: [`verifier error: ${e.message}`] }; }
    if (!v || v.ok !== true) throw refuse(keyHash, 403, "evidence_refused", (v && Array.isArray(v.reasons) && v.reasons.at(-1)) || "the report did not verify");
    // belt and braces over the verdict and the now-verified report: never more permissive than either
    const p = parseSnpReport(report);
    const snpMeasurement = p.measurement.toString("hex");
    if (v.vcekVerified !== true || !provenSnpChip(report, v))
      throw refuse(keyHash, 403, "evidence_refused", "the report's signature was not verified against its own chip's VCEK");
    if (!v.tcb || v.tcb.checked !== true) throw refuse(keyHash, 403, "evidence_refused", "the report's TCB was not judged against the minimum-TCB policy");
    if (v.vmpl !== att.vmpl) throw refuse(keyHash, 403, "evidence_refused", `the verifier saw VMPL ${v.vmpl}, not the pinned ${att.vmpl}`);
    if (String(v.measurement || "").toLowerCase() !== snpMeasurement)
      throw refuse(keyHash, 403, "evidence_refused", "the verifier's measurement is not the report's");
    why = snpKeyReportRefusal(report, policy);
    if (why) throw refuse(keyHash, ...why);
    const measurement = snpMeasurementToBytes32(p.measurement);

    // 4. record it (re-read: the verification can take seconds)
    const rec = await bindingRecord(keyHash);
    if (rec.revoked) throw refuse(keyHash, 409, "key_revoked", "this key's attestation was revoked, permanently: generate a new key");
    if (rec.live && rec.measurement !== measurement)
      throw refuse(keyHash, 409, "measurement_conflict", `this key is already attested under another image (${rec.measurement}); a key belongs to one image`);
    const out = { keyHash, measurement, snpMeasurement, mapping: SESSION_KEY_MEASUREMENT_MAPPING, contract: att.address,
      attestor: signer.address, tcb: v.tcb };
    if (rec.live) return { ...out, txHash: null, already: true };
    const day = Math.floor(now() / 86400);
    if (attestDay.day !== day) { attestDay.day = day; attestDay.n = 0; }
    if (attestDay.n >= att.maxPerDay) throw refuse(keyHash, 429, "attest_rate", "this relay's attestations for today are used up; retry tomorrow");
    attestDay.n++;
    try {
      await pc.simulateContract({ address: att.address, abi: keyAttestationsAbi, functionName: "attest", args: [keyHash, measurement], account: signer });
    } catch (e) {
      const data = revertData(e);
      let name = null;
      try { name = data ? decodeErrorResult({ abi: keyAttestationsAbi, data }).errorName : null; } catch { /* not ours */ }
      if (name === "NotAttestor") throw refuse(keyHash, 503, "attestor_not_authorized", `${signer.address} is not an attestor of ${att.address}`);
      if (name === "KeyIsRevoked") throw refuse(keyHash, 409, "key_revoked", "this key's attestation was revoked, permanently: generate a new key");
      if (name === "MeasurementConflict") throw refuse(keyHash, 409, "measurement_conflict", "this key is already attested under another image");
      throw refuse(keyHash, 409, "revert", `EnclaveKeyAttestations refused: ${e.shortMessage || e.message}`.slice(0, 400));
    }
    const rc = await q.send({ to: att.address, data: encodeFunctionData({ abi: keyAttestationsAbi, functionName: "attest", args: [keyHash, measurement] }),
      label: `attest ${keyHash.slice(0, 10)}` });
    if (rc.status !== "success") throw refuse(keyHash, 409, "revert", `attest reverted on-chain (${rc.transactionHash})`);
    const [m, revoked] = await pc.readContract({ address: att.address, abi: keyAttestationsAbi, functionName: "bindingOf", args: [keyHash] });
    if (m.toLowerCase() !== measurement || revoked) throw httpError(500, "relay", `attested in ${rc.transactionHash}, but the binding does not read back`);
    log(`attested key ${keyHash.slice(0, 10)} under ${measurement.slice(0, 10)} (SNP ${snpMeasurement.slice(0, 16)}…) in ${rc.transactionHash}`);
    return { ...out, txHash: rc.transactionHash, block: Number(rc.blockNumber), already: false };
  }

  function parseGrant(g) {
    if (!g || typeof g !== "object") throw httpError(400, "bad_request", "grant missing");
    const strs = (v, n) => { if (!Array.isArray(v) || v.some((s) => typeof s !== "string" || s.length > 200) || v.length > 32) throw httpError(400, "bad_request", `${n} must be a string list`); return v; };
    const str = (v, n) => { if (typeof v !== "string" || v.length > 200) throw httpError(400, "bad_request", `${n} must be a short string`); return v; };
    const u32 = (v, n) => { const b = big(v, n); if (b > 0xffffffffn) throw httpError(400, "bad_request", `${n} out of range`); return Number(b); };
    return {
      label: str(g.label, "label"), preset: str(g.preset, "preset"), sessionKey: hex32(g.sessionKey, "sessionKey"),
      actions: strs(g.actions, "actions"), apps: strs(g.apps, "apps"), environments: strs(g.environments, "environments"),
      budget: big(g.budget, "budget"), spendPerPeriod: big(g.spendPerPeriod, "spendPerPeriod"),
      periodSeconds: u32(g.periodSeconds, "periodSeconds"), opsPerPeriod: u32(g.opsPerPeriod, "opsPerPeriod"),
      maxFeePerOp: big(g.maxFeePerOp, "maxFeePerOp"), maxAppFeePerHour: big(g.maxAppFeePerHour, "maxAppFeePerHour"),
      maxRatePerHour: big(g.maxRatePerHour ?? 0, "maxRatePerHour"),
      expiresAt: big(g.expiresAt, "expiresAt"), measurement: hex32(g.measurement, "measurement"),
      grantNonce: hex32(g.grantNonce, "grantNonce"), signBefore: big(g.signBefore, "signBefore"),
    };
  }

  /** Node http adapter: (req, res, u, ctx) like the relay's other modules. */
  async function handle(req, res, u, ctx) {
    const send = ctx?.json ?? ((r, code, obj) => { r.writeHead(code, { "content-type": "application/json" }); r.end(ser(obj)); });
    const path = u.pathname.replace(/^\/v1\/sessions/, "") || "/";
    try {
      if (req.method === "OPTIONS") return send(res, 204, {}, req);
      let body = {};
      if (req.method === "POST") {
        const raw = await (ctx?.readBody ? ctx.readBody(req, 64 * 1024) : readAll(req));
        try { body = de(raw.toString() || "{}"); } catch { throw httpError(400, "bad_request", "body must be JSON"); }
      }
      if (ctx?.rate && !ctx.rate(`${ctx.clientIp?.(req) ?? "ip"}:${req.method === "POST" ? "w" : "r"}`))
        throw httpError(429, "rate", "too many requests; slow down");
      const out = await route(req.method, path, body, ctx);
      // bigints travel as "123n" strings - the SDK's (de)serializer understands them
      return send(res, 200, JSON.parse(ser(out)), req);
    } catch (e) {
      const status = e.status || 500;
      if (status >= 500 && e.code !== "relay") log(`error on ${req.method} ${path}: ${e.stack || e.message}`);
      return send(res, status, { error: e.message, code: e.code || "relay", ...(e.extra || {}) }, req);
    }
  }

  return { handle, route, verifyApiRequest, indexOnce, keeperOnce, gasCheck, queue, store,
    getFactory, isVault, feeFor, account, ingestLogs,
    /** the beneficial owner when `owner` is a SessionVault, else `owner` itself */
    async beneficialOwner(owner) {
      const a = getAddress(owner);
      if (store.data.vaults[a]) return store.data.vaults[a];
      try {
        if (await isVault(a)) {
          const real = getAddress(await pc.readContract({ address: a, abi: sessionVaultAbi, functionName: "owner" }));
          store.data.vaults[a] = real;
          return real;
        }
      } catch { /* not a vault, or factory unset */ }
      return a;
    },
    /** custody record of a vault-held deployment (secret release reads this) */
    async heldOf(owner, id) {
      const [env, promoted] = await pc.readContract({ address: owner, abi: sessionVaultAbi, functionName: "held", args: [id] });
      return { env: Number(env), promoted };
    },
  };
}

function readAll(req) {
  return new Promise((ok, bad) => {
    const chunks = [];
    let n = 0;
    req.on("data", (c) => { n += c.length; if (n > 64 * 1024) { bad(httpError(413, "bad_request", "body too large")); req.destroy(); } else chunks.push(c); });
    req.on("end", () => ok(Buffer.concat(chunks)));
    req.on("error", bad);
  });
}


// ============================================================================
// Custody gate: who really owns a vault-held deployment, and may its secrets
// flow? Independent of the relayer (works with no SESSIONS_RELAYER_KEY), so a
// relay that cannot submit sessions still refuses an unpromoted prod release.
// ============================================================================

export function createCustodyGate({ pc, book, factory: fixedFactory = null, factories: history = [], ttlMs = 60_000,
  knownVault = null }) {
  let factory = fixedFactory ? getAddress(fixedFactory) : null;
  // a vault of ANY factory we ever ran stays recognised: a v1 vault's unpromoted prod record must not
  // start releasing secrets because a v2 factory replaced v1 in the book
  const older = history.filter((a) => a && isAddress(a)).map((a) => getAddress(a));
  let factoryAt = 0;
  const vaultOwner = new Map();      // vault -> owner (immutable once read)
  const notVault = new Map();        // address -> checkedAt

  async function getFactory() {
    if (fixedFactory) return factory;
    if (factory && Date.now() - factoryAt < 10 * ttlMs) return factory;
    if (!book) return null;
    const a = await pc.readContract({ address: book, abi: BOOK_ABI, functionName: "addr", args: [BOOK_FACTORY] });
    factory = a && a !== ZERO ? getAddress(a) : null;
    factoryAt = Date.now();
    return factory;
  }

  /** the vault's owner when `addr` is a SessionVault of the book's factory, else null */
  async function vaultOwnerOf(a, { fresh = false } = {}) {
    const x = getAddress(a);
    if (vaultOwner.has(x)) return vaultOwner.get(x);
    const seen = notVault.get(x);
    if (!fresh && seen && Date.now() - seen < ttlMs) return null;
    const current = await getFactory();
    const all = [...new Set([current, fixedFactory && getAddress(fixedFactory), ...older].filter(Boolean))];
    if (!all.length) { notVault.set(x, Date.now()); return null; }
    const code = await pc.getCode({ address: x });
    if (!code || code.length <= 2) { notVault.set(x, Date.now()); return null; }
    let is = false;
    for (const f of all)
      if (await pc.readContract({ address: f, abi: sessionVaultFactoryAbi, functionName: "isVault", args: [x] })) { is = true; break; }
    if (!is) { notVault.set(x, Date.now()); return null; }
    const owner = getAddress(await pc.readContract({ address: x, abi: sessionVaultAbi, functionName: "owner" }));
    vaultOwner.set(x, owner);
    return owner;
  }

  const codeAt = new Map();          // address -> { at, has }
  async function hasCode(a, { fresh = false } = {}) {
    const c = codeAt.get(a);
    if (!fresh && c && Date.now() - c.at < ttlMs) return c.has;
    const code = await pc.getCode({ address: a });
    const has = Boolean(code && code.length > 2);
    codeAt.set(a, { at: Date.now(), has });
    if (codeAt.size > 50000) codeAt.clear();
    return has;
  }

  /** held(id) of ANY contract owner: [env, promoted], or null when the contract has no such
   *  function (it reverts or answers nothing). Anything else - an unreachable RPC - throws. */
  async function heldOf(a, id) {
    let out;
    try {
      out = await pc.call({ to: a, data: encodeFunctionData({ abi: sessionVaultAbi, functionName: "held", args: [id] }) });
    } catch (e) {
      for (let x = e, i = 0; x && i < 12; x = x.cause, i++)
        if (x.name === "ExecutionRevertedError" || /revert/i.test(String(x.details ?? x.shortMessage ?? ""))) return null;
      throw e;
    }
    if (!out?.data || out.data.length < 2 + 64 * 3) return null;
    const [env, promoted] = decodeFunctionResult({ abi: sessionVaultAbi, functionName: "held", data: out.data });
    return [env, promoted];
  }

  return {
    getFactory, vaultOwnerOf,
    /** the address whose wallet signature counts as the owner's for this record */
    async beneficialOwner(owner) { return (await vaultOwnerOf(owner)) ?? getAddress(owner); },
    /** null = no objection; a string = why this deployment's secrets must not be released.
     *  Wallet-held rows pass untouched. A vault of a factory this relay knows (the book's,
     *  SESSIONS_FACTORY, SESSIONS_FACTORIES) MUST answer held(); any other contract owner
     *  that answers it is gated by its answer too, so a vault from a factory rotated out of
     *  the book never falls back to "plain wallet" (an impostor answering held() only ever
     *  makes its OWN records stricter). List every factory ever run in SESSIONS_FACTORIES:
     *  only a known vault is held to the strict read. Errors propagate: the callers refuse
     *  (fail closed) on an unreadable chain. */
    async custodyRefusal(row) {
      if (!row?.owner) return null;
      const a = getAddress(row.owner);
      let env, promoted;
      // a vault this relay INDEXED (VaultCreated) or a known factory confirms is held to the strict
      // read; nothing negative is cached on this path, so one empty getCode from a lagging or lying
      // node can't open a window (and an indexed vault never depends on getCode at all)
      if ((knownVault && knownVault(a)) || (await vaultOwnerOf(a, { fresh: true }))) {
        // a KNOWN vault answers held() or the release is refused: an empty answer from a
        // lagging node, a gas-cap error, anything at all, throws (fail closed)
        [env, promoted] = await pc.readContract({ address: a, abi: sessionVaultAbi, functionName: "held", args: [row.id] });
      } else {
        if (!(await hasCode(a, { fresh: true }))) return null;
        const h = await heldOf(a, row.id);
        if (!h) return null;
        [env, promoted] = h;
      }
      if (Number(env) === 0) return "this deployment sits in a session vault its owner has not adopted";
      if (Number(env) === 2) {
        const now = keccak256(encodeAbiParameters([{ type: "string" }, { type: "string" }],
          [String(row.appRef ?? ""), String(row.configCid ?? "")]));
        if (String(promoted).toLowerCase() !== now.toLowerCase())
          return "production deployment: its current version/config has not been promoted by the owner";
      }
      return null;
    },
  };
}

// ============================================================================
// Wiring into api-relay.js (env-configured singleton)
// ============================================================================

let _svc = null;
let _why = "sessions are not configured on this relay";

export async function initSessions({ dataDir, JsonStore, alert, log } = {}) {
  const key = (process.env.SESSIONS_RELAYER_KEY || "").trim();
  if (!dataDir || !key) {
    _why = !dataDir ? "sessions need AUTH_DATA_DIR" : "sessions need SESSIONS_RELAYER_KEY";
    console.log(`[sessions] disabled: ${_why}`);
    return null;
  }
  const netName = process.env.SESSIONS_NETWORK || "base";
  const net = NETS[netName];
  if (!net) { _why = `unknown SESSIONS_NETWORK ${netName}`; console.error(`[sessions] ${_why}`); return null; }
  const rpcs = (process.env.SESSIONS_RPC || "").split(",").map((s) => s.trim()).filter(Boolean);
  const transport = fallback((rpcs.length ? rpcs : net.rpc).map((u) => http(u, { retryCount: 2, retryDelay: 400 })));
  // a local chain may carry another id (the e2e rig runs anvil as 8453); real networks keep theirs
  const chain = netName === "local" && process.env.SESSIONS_CHAIN_ID
    ? { ...net.chain, id: Number(process.env.SESSIONS_CHAIN_ID) } : net.chain;
  const pc = createPublicClient({ chain, transport });
  const account = privateKeyToAccount(key);
  const wc = createWalletClient({ chain, account, transport });
  const path = (n) => `${dataDir}/${n}`;
  const svc = createSessionsService({
    pc, wc, account, chainId: chain.id,
    factory: process.env.SESSIONS_FACTORY || null,
    book: process.env.SESSIONS_BOOK || net.book || null,
    usdc: process.env.SESSIONS_USDC || null,
    router: process.env.SESSIONS_ROUTER || null,
    startBlock: process.env.SESSIONS_START_BLOCK ? Number(process.env.SESSIONS_START_BLOCK) : null,
    feeMarginBps: process.env.SESSIONS_FEE_MARGIN_BPS, minFee6: process.env.SESSIONS_MIN_FEE6,
    ethUsd: process.env.SESSIONS_ETH_USD ? Number(process.env.SESSIONS_ETH_USD) : undefined,
    ethUsdFeed: process.env.SESSIONS_ETH_USD_FEED || net.ethUsdFeed,
    minEthWei: process.env.SESSIONS_MIN_ETH_WEI ? BigInt(process.env.SESSIONS_MIN_ETH_WEI) : undefined,
    maxTipWei: process.env.SESSIONS_MAX_TIP_WEI ? BigInt(process.env.SESSIONS_MAX_TIP_WEI) : undefined,
    ownerOpsPerDay: process.env.SESSIONS_OWNER_OPS_PER_DAY ? Number(process.env.SESSIONS_OWNER_OPS_PER_DAY) : undefined,
    site: process.env.SESSIONS_SITE || "https://enclave.host",
    publicRpc: process.env.SESSIONS_PUBLIC_RPC || null,
    store: new JsonStore(path("sessions-index.json"), {}, { durable: false }),
    journal: new JsonStore(path("sessions-relayer.json"), { txs: [] }, { durable: true }),
    attestor: attestorEnv(),
    alert, log,
  });
  try {
    const f = await svc.getFactory();
    const bal = await svc.gasCheck();
    console.log(`[sessions] relayer ${account.address} (${bal} wei) on ${netName}, factory ${f}`);
  } catch (e) {
    console.error(`[sessions] init: ${e.message} (serving anyway; requests will say why)`);
  }
  _svc = svc;
  const tick = (fn, ms, name) => {
    let busy = false;
    const t = setInterval(async () => {
      if (busy) return; busy = true;
      try { await fn(); } catch (e) { console.error(`[sessions] ${name}: ${e.message}`); } finally { busy = false; }
    }, ms);
    t.unref?.();
  };
  tick(() => svc.indexOnce(), 15_000, "index");
  tick(() => svc.keeperOnce(), 60_000, "keeper");
  tick(() => svc.gasCheck(), 300_000, "gas");
  return svc;
}

export function sessionsService() { return _svc; }

// SESSIONS_KEY_ATTESTATIONS and its policy (header). Unset: no attestor (503 attest_disabled). Set: every policy
// piece is passed as read, and a missing or malformed one keeps the route at 503 naming it (attestorSetup).
function attestorEnv() {
  const address = (process.env.SESSIONS_KEY_ATTESTATIONS || "").trim();
  if (!address) return null;
  let minTcb = null;
  try { minTcb = JSON.parse(process.env.SESSIONS_ATTEST_MIN_TCB || ""); } catch { /* missing or not JSON: none */ }
  const vmpl = String(process.env.SESSIONS_ATTEST_VMPL ?? "").trim();
  const ms = String(process.env.SESSIONS_ATTEST_MEASUREMENTS || "").trim();
  const cap = String(process.env.SESSIONS_ATTEST_MAX_PER_DAY || "").trim();
  return { address, minTcb, vmpl: /^[0-3]$/.test(vmpl) ? Number(vmpl) : null,
    measurements: ms === "*" ? "*" : ms ? ms.split(",").map((m) => m.trim()).filter(Boolean) : null,
    ...(cap ? { maxPerDay: /^\d+$/.test(cap) ? Number(cap) : NaN } : {}) };
}

export function handleSessions(req, res, u, ctx) {
  if (!_svc) return ctx.json(res, 503, { error: _why, code: "sessions_disabled" }, req);
  return _svc.handle(req, res, u, ctx);
}
