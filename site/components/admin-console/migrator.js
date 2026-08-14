/* ============================================================
   Delegated migration signer — the admin console's answer to
   "one approval, not forty".

   A contract migration is hundreds of storage writes and Base
   mines nothing over ~15M gas, so it is unavoidably dozens of
   transactions. What IS avoidable is a hardware-wallet
   confirmation for each one: every import gates on
   msg.sender == owner and nothing else, so a MIGRATOR identity
   can own the new contract and do the work unattended.

   The migrator key is DERIVED, never stored and never generated:
   one personal_sign over a fixed string, hashed to a private key.
   RFC6979 makes that signature deterministic, so the same wallet
   always yields the same migrator address — fund it once, reuse
   it for every migration, and there is no secret at rest
   anywhere. Same construction the encrypted-volume keys use.

   THIS FILE SIGNS TRANSACTIONS. It is the only place on the site
   that holds a private key, and it holds it in a closure for the
   length of one migration. The rest of the site still loads no
   web3 library; the signing primitives here are @noble (audited,
   already vendored under viem) and the transaction encoding is
   pinned against viem in test/admin-console.test.mjs, exactly
   like the ABI codec in js/core/chain.js.
   ============================================================ */
import { secp256k1 } from "@noble/curves/secp256k1";
import { keccak_256 } from "@noble/hashes/sha3";
import { baseRpc } from "../../js/core/chain.js";
import { personalSign } from "../../js/core/wallet.js";
import { APP_CATALOG_RPCS } from "../../js/core/config.js";
import { Enclave } from "../../js/core/api.js";
import { EnclaveError } from "../../js/core/api.js";

// Canonical and VERSIONED: the migrator address is a pure function of this
// string and the signing wallet. Changing it mints a different identity (and
// strands whatever funded the old one).
export const DERIVE_MSG = "enclave-migrator:v1";
// Base mines nothing above ~15M (measured: 3,569 txs across 30 blocks, largest
// included limit 15.0M). Above it an RPC may accept and the chain never mine.
export const MAX_TX_GAS = 15_000_000n;

const hex = (b) => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
const bytes = (h) => {
  const s = (h || "").replace(/^0x/, "");
  const out = new Uint8Array(s.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(s.slice(i * 2, i * 2 + 2), 16);
  return out;
};
// minimal big-endian encoding: RLP integers carry NO leading zeros, and zero is
// the empty string (not 0x00) — getting this wrong changes the hash and the tx
// is rejected as malformed rather than mis-executed
const uint = (n) => {
  let v = BigInt(n);
  if (v === 0n) return new Uint8Array(0);
  let s = v.toString(16);
  if (s.length % 2) s = "0" + s;
  return bytes(s);
};

/* ---- RLP ---- */
function rlpLen(n, offset) {
  if (n < 56) return Uint8Array.of(offset + n);
  const l = uint(n);
  return Uint8Array.of(offset + 55 + l.length, ...l);
}
function rlp(item) {
  if (Array.isArray(item)) {
    const parts = item.map(rlp);
    const total = parts.reduce((s, p) => s + p.length, 0);
    const out = new Uint8Array(total);
    let o = 0;
    for (const p of parts) { out.set(p, o); o += p.length; }
    return new Uint8Array([...rlpLen(total, 0xc0), ...out]);
  }
  const b = item instanceof Uint8Array ? item : bytes(item);
  if (b.length === 1 && b[0] < 0x80) return b;
  return new Uint8Array([...rlpLen(b.length, 0x80), ...b]);
}

/* ---- the derived identity ---- */
const privToAddress = (priv) => {
  const pub = secp256k1.getPublicKey(priv, false).slice(1);   // drop the 0x04 tag
  return "0x" + hex(keccak_256(pub)).slice(-40);
};

/* Ask the connected wallet to sign the canonical string ONCE, and derive the
   migrator from it. This is a message signature: no gas, no chain state — but
   it IS the whole authority, so it never leaves this closure. */
export async function deriveMigrator() {
  if (!Enclave.provider || !Enclave.address)
    throw new EnclaveError("Connect the governance wallet first.", 0);
  let sig;
  try {
    sig = await personalSign(DERIVE_MSG);
  } catch (e) {
    if (e && (e.code === 4001 || /reject|denied|declin|cancell/i.test(e.message || "")))
      throw new EnclaveError("derivation canceled: you declined the signature.", 0);
    throw e;
  }
  if (!/^0x[0-9a-fA-F]{130}$/.test(sig || ""))
    throw new EnclaveError("the wallet returned an unexpected signature shape; cannot derive the migrator.", 0);
  const priv = keccak_256(bytes(sig));
  const address = privToAddress(priv);
  return {
    address,
    /* Sign + broadcast an EIP-1559 transaction. `to: null` deploys. Returns the
       hash. The caller owns nonce sequencing — one sender, one loop, so the
       nonce is counted locally rather than re-asked (asking is what races). */
    async send({ to, data, gas, nonce, chainId, maxFeePerGas, maxPriorityFeePerGas, value = 0n }) {
      const fields = [
        uint(chainId), uint(nonce), uint(maxPriorityFeePerGas), uint(maxFeePerGas), uint(gas),
        to ? bytes(to) : new Uint8Array(0), uint(value), bytes(data || "0x"), [],
      ];
      const unsigned = new Uint8Array([0x02, ...rlp(fields)]);
      const sigObj = secp256k1.sign(keccak_256(unsigned), priv, { prehash: false });
      const signed = new Uint8Array([0x02, ...rlp([...fields,
        uint(sigObj.recovery), uint(sigObj.r), uint(sigObj.s)])]);
      return await baseRpc("eth_sendRawTransaction", ["0x" + hex(signed)]);
    },
  };
}

/* ---- chain helpers the migration loop needs ---- */
export const migratorBalance = (addr) => baseRpc("eth_getBalance", [addr, "latest"]).then((b) => BigInt(b || "0x0"));
export const migratorNonce = (addr) => baseRpc("eth_getTransactionCount", [addr, "latest"]).then((n) => Number(BigInt(n || "0x0")));

/* Current fees, padded for the minutes a long migration runs: a base fee that
   doubles mid-run must not strand the remaining transactions. Base's base fee
   is a rounding error either way (~0.005 gwei), so the padding costs nothing. */
export async function feeData() {
  const blk = await baseRpc("eth_getBlockByNumber", ["latest", false]);
  const base = BigInt(blk?.baseFeePerGas || "0x0");
  const tip = 1_000_000n;                          // 0.001 gwei is ample on Base
  // 2x, not 4x. EIP-1559 RESERVES maxFee x gas up front, so padding is not free
  // here: at 4x a 28-batch catalog reserves ~$24 for a run that spends ~$5, and
  // the console would refuse to start on a perfectly adequate balance. The loop
  // re-prices every ten transactions, so a genuine climb is picked up in flight
  // rather than needing to be pre-bought.
  return { maxPriorityFeePerGas: tip, maxFeePerGas: base * 2n + tip };
}

/* Measure, then clamp. estimateGas is authoritative when it answers, and it
   REFUSES above its own (~11M) cap — which our batches sit right on top of, so
   refusal is the common case, not the exception. That is why this does NOT go
   through baseRpc: baseRpc rotates the whole endpoint pool on error, so every
   over-cap batch would burn eight round-trips before falling back. One shot,
   short timeout, then trust the planner's (measured, padded) figure. */
export async function gasFor({ from, to, data }, fallback) {
  let g = BigInt(Math.round(fallback * 1.25));
  try {
    const r = await fetch(APP_CATALOG_RPCS[0], {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_estimateGas",
                             params: [{ from, ...(to ? { to } : {}), data }] }),
      signal: AbortSignal.timeout(6000),
    });
    const j = await r.json();
    if (j && j.result) g = BigInt(j.result) * 5n / 4n;
  } catch (_) { /* over the cap or unreachable: the model stands */ }
  return g > MAX_TX_GAS ? MAX_TX_GAS : g;
}

export async function waitMined(hash, tries = 90) {
  for (let i = 0; i < tries; i++) {
    let rec = null;
    try { rec = await baseRpc("eth_getTransactionReceipt", [hash]); } catch (_) {}
    if (rec) {
      if (BigInt(rec.status || "0x0") === 0n) throw new EnclaveError(`transaction reverted: ${hash}`, 0);
      return rec;
    }
    await new Promise((r) => setTimeout(r, 2000));
  }
  throw new EnclaveError(`timed out waiting for ${hash}`, 0);
}

/* What a planned run can RESERVE, not what it will spend: EIP-1559 locks
   maxFee x gas per transaction and refunds the difference, so this is the
   balance the migrator must actually hold. Typically ~4x the real cost at
   Base's base fee, which is the point — a run that starts must be able to
   finish. */
export async function runCost(txs) {
  const { maxFeePerGas } = await feeData();
  const gas = txs.reduce((n, t) => n + BigInt(Math.min(Math.round((t.gas || 1e6) * 1.25), Number(MAX_TX_GAS))), 0n);
  return gas * maxFeePerGas;
}

/* Return whatever the run did not spend. The migrator signs this itself, so it
   costs the operator no approval — and it means funding the migrator is a loan
   for the length of a migration rather than money parked in a side account.
   A plain transfer is 21000 gas; anything at or below that is dust and not
   worth a transaction, so it just stays for next time. */
export async function sweepTo(mig, to, chainId) {
  const bal = await migratorBalance(mig.address);
  const { maxFeePerGas, maxPriorityFeePerGas } = await feeData();
  const cost = 21_000n * maxFeePerGas;
  if (bal <= cost) return 0n;
  const value = bal - cost;
  const nonce = await migratorNonce(mig.address);
  const hash = await mig.send({ to, data: "0x", gas: 21_000n, nonce, chainId, maxFeePerGas, maxPriorityFeePerGas, value });
  await waitMined(hash);
  return value;
}
