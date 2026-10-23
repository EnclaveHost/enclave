/* ============================================================
   Broadcast through the network profile (independent mode, on the
   owner's explicit choice under Broadcast in the wallet menu).

   By default a connected wallet both signs and broadcasts
   (eth_sendTransaction): the transaction leaves through the RPC the
   WALLET has set for Base, which this page can neither see nor
   change (EIP-3085 wallet_addEthereumChain is only an offer). On
   this route the wallet SIGNS ONLY (eth_signTransaction) and this
   page hands the exact signed bytes to the profile's own endpoints
   (eth_sendRawTransaction). Nothing else is contacted.

   Many wallets cannot sign without broadcasting (MetaMask offers no
   eth_signTransaction). They are refused with that reason, nothing is
   signed or sent, and this route never falls back to the wallet's own
   broadcast: the owner switches routes explicitly.

   Before anything leaves the page:
   1. the profile is still the one this tab confirmed;
   2. nonce and fees come from the profile (the base fee from an
      agreed block), the gas limit from the caller's measurement;
   3. the signed transaction must be exactly what was asked (EIP-1559,
      chain, nonce, to, value, data, gas, fees, no access list), and
      its signer - recovered by the ecrecover precompile at an agreed
      block - must be the connected address.
   Endpoints are tried in the profile's order: after a refusal, no
   answer, or an answer naming another hash, the SAME signed bytes go
   to the next endpoint - no new signature, nonce or replacement. Those
   bytes have one nonce and one hash: they execute at most once. Once
   every endpoint was tried without an acceptance, nothing more is sent;
   an unknown outcome must be checked before another transaction is
   created. Acceptance is only that: the receipt is read through the
   profile (chain.js waitReceipt).
   ============================================================ */
import { INDEPENDENT, APP_CATALOG_RPCS, BASE_CHAIN, assertProfileCurrent } from "./config.js";
import { keccak256Bytes, bytesToHex, hexToBytes } from "./keccak.js";

const ROUTE_KEY = "enclave_broadcast_route:v1";
const ECRECOVER = "0x0000000000000000000000000000000000000001";
const MAX_TIP = 2_000_000_000n;       // 2 gwei: never more than the account path pays (account-transport.js)
const lower = (a) => String(a || "").toLowerCase();
const ls = () => { try { return globalThis.localStorage || null; } catch { return null; } };

export class BroadcastError extends Error {
  constructor(message, { code = "refused", outcomeUnknown = false, hash = null } = {}){
    super(message); this.name = "BroadcastError"; this.code = code; this.outcomeUnknown = outcomeUnknown; this.hash = hash;
  }
}

let _deps = null;
/** Tests only: stand-ins for the profile reads (chain.js baseRpc), the agreed reader and the receipt registry. */
export function _setForTests(d){ _deps = d; }
async function deps(){
  if (_deps) return _deps;
  const [C, IC] = await Promise.all([import("./chain.js"), import("./independent-chain.js")]);
  return { read: C.baseRpc, reader: IC.reader(), noteSent: C.noteProfileBroadcast, rpcs: APP_CATALOG_RPCS, fetchImpl: (...a) => globalThis.fetch(...a) };
}

/* ---- the owner's choice ---- */
/** "wallet" (the wallet broadcasts through its own RPC: the default, and the only route outside independent mode) or
 *  "profile" (the wallet signs only; the profile's endpoints broadcast). */
export function broadcastRoute(){
  if (INDEPENDENT.state !== "on") return "wallet";
  return (ls() && ls().getItem(ROUTE_KEY)) === "profile" ? "profile" : "wallet";
}
export function setBroadcastRoute(mode){
  if (mode !== "wallet" && mode !== "profile") throw new BroadcastError("choose your wallet or the network profile");
  if (mode === "profile" && INDEPENDENT.state !== "on") throw new BroadcastError("only a confirmed independent profile has its own broadcast endpoints");
  if (mode === "profile" && !APP_CATALOG_RPCS.length) throw new BroadcastError("this network profile names no RPC endpoint");
  ls().setItem(ROUTE_KEY, mode);
}

/* ---- RLP (strict: canonical lengths and integers, the whole input consumed) ---- */
const bad = (why) => new BroadcastError("your wallet returned a transaction this page cannot read (" + why + "): nothing was sent", { code: "malformed" });
function rlpLength(b, at, n){
  if (n === 0 || at + n > b.length || b[at] === 0) throw bad("length");
  let v = 0; for (let i = 0; i < n; i++) v = v * 256 + b[at + i];
  if (v < 56) throw bad("length");
  return v;
}
function rlpItem(b, at){
  const p = b[at];
  if (p === undefined) throw bad("truncated");
  if (p < 0x80) return [b.subarray(at, at + 1), at + 1];
  let start, len, list = p >= 0xc0;
  const short = list ? p - 0xc0 : p - 0x80;
  if (short <= 55){ start = at + 1; len = short; }
  else { const n = short - 55; len = rlpLength(b, at + 1, n); start = at + 1 + n; }
  const end = start + len;
  if (end > b.length) throw bad("truncated");
  if (!list){
    if (len === 1 && b[start] < 0x80) throw bad("non-canonical byte");
    return [b.subarray(start, end), end];
  }
  const items = [];
  for (let i = start; i < end;){ const [x, next] = rlpItem(b, i); items.push(x); i = next; }
  return [items, end];
}
function rlpEncode(x){
  const head = (n, off) => {
    if (n < 56) return [off + n];
    const l = []; for (let v = n; v > 0; v = Math.floor(v / 256)) l.unshift(v % 256);
    return [off + 55 + l.length, ...l];
  };
  if (Array.isArray(x)){
    const parts = x.map(rlpEncode), n = parts.reduce((s, p) => s + p.length, 0), h = head(n, 0xc0);
    const out = new Uint8Array(h.length + n);
    out.set(h); let o = h.length;
    for (const p of parts){ out.set(p, o); o += p.length; }
    return out;
  }
  if (x.length === 1 && x[0] < 0x80) return x;
  const h = head(x.length, 0x80), out = new Uint8Array(h.length + x.length);
  out.set(h); out.set(x, h.length);
  return out;
}
const int = (b, what) => {
  if (!(b instanceof Uint8Array)) throw bad(what);
  if (b.length && b[0] === 0) throw bad(what + " has a leading zero");
  if (b.length > 32) throw bad(what);
  return b.length ? BigInt(bytesToHex(b)) : 0n;
};

/** The signed EIP-1559 transaction's fields and the hash its signer signed. Anything else is refused. */
export function decodeSigned(raw){
  if (!/^0x02([0-9a-fA-F]{2})+$/.test(String(raw || ""))) throw bad("not a signed EIP-1559 transaction");
  const b = hexToBytes(raw);
  const [items, end] = rlpItem(b, 1);
  if (end !== b.length || !Array.isArray(items) || items.length !== 12) throw bad("not a signed EIP-1559 transaction");
  const [chainId, nonce, tip, maxFee, gas, to, value, data, access, yParity, r, s] = items;
  if (!(to instanceof Uint8Array) || (to.length !== 0 && to.length !== 20) || !(data instanceof Uint8Array)) throw bad("recipient or data");
  if (!Array.isArray(access)) throw bad("access list");
  const v = int(yParity, "signature");
  if (v > 1n) throw bad("signature");
  return {
    chainId: int(chainId, "chain"), nonce: int(nonce, "nonce"), maxPriorityFeePerGas: int(tip, "fee"), maxFeePerGas: int(maxFee, "fee"), gas: int(gas, "gas"),
    to: to.length ? bytesToHex(to) : null, value: int(value, "value"), data: bytesToHex(data), accessList: access, yParity: Number(v),
    r: int(r, "signature"), s: int(s, "signature"),
    signingHash: bytesToHex(keccak256Bytes(new Uint8Array([0x02, ...rlpEncode(items.slice(0, 9))]))),
    hash: bytesToHex(keccak256Bytes(b)),
  };
}

const hex = (n) => "0x" + BigInt(n).toString(16);
const word = (n) => BigInt(n).toString(16).padStart(64, "0");
const UNSUPPORTED = /not supported|unsupported|does not exist|not available|not implemented|method not found|unknown method|request\(\) method/i;
const KNOWN = /already known|known transaction|already imported|already exists/i;

/**
 * Sign with the connected wallet, broadcast through the profile. `tx` is sendTx's request ({from, to?, data, value, gas}).
 * -> the transaction hash, once one of the profile's endpoints accepted it. Throws BroadcastError: "unsupported" (the wallet
 * cannot sign only), "changed" (the wallet signed something else), "signer", "gas", "refused" (every endpoint refused:
 * sent nowhere), "unknown" (an endpoint may have it: outcomeUnknown; the same bytes were offered to every endpoint, and
 * nothing more is sent for them). A wallet rejection is rethrown.
 */
export async function sendViaProfile(tx, { provider, from }){
  if (broadcastRoute() !== "profile") throw new BroadcastError("broadcasting through the network profile is not chosen");
  if (!provider || typeof provider.request !== "function") throw new BroadcastError("connect a wallet to sign", { code: "input" });
  if (!tx.gas) throw new BroadcastError("the network profile's endpoints did not measure this transaction's gas, and this route sends only a measured limit: nothing was signed", { code: "gas" });
  const D = await deps();
  const snap = await D.reader.snapshot();
  let tip = 1_000_000n;                   // 0.001 gwei when the profile quotes none: ample on Base (admin-console migrator)
  try { tip = BigInt(await D.read("eth_maxPriorityFeePerGas", [])); } catch {}
  if (tip > MAX_TIP) tip = MAX_TIP;
  const nonce = BigInt(await D.read("eth_getTransactionCount", [from, "pending"]));
  const want = { chainId: BigInt(BASE_CHAIN), nonce, maxPriorityFeePerGas: tip, maxFeePerGas: (snap.baseFeePerGas ?? 0n) * 2n + tip, gas: BigInt(tx.gas),
    to: tx.to ? lower(tx.to) : null, value: BigInt(tx.value || 0), data: lower(tx.data || "0x") };
  const request = { from, ...(want.to ? { to: want.to } : {}), data: want.data, value: hex(want.value), gas: hex(want.gas), nonce: hex(nonce),
    maxFeePerGas: hex(want.maxFeePerGas), maxPriorityFeePerGas: hex(tip), chainId: hex(want.chainId), type: "0x2" };
  let signed;
  try { signed = await provider.request({ method: "eth_signTransaction", params: [request] }); }
  catch (e){
    if (e && (e.code === 4001 || e.code === "ACTION_REJECTED")) throw e;
    const msg = String((e && e.message) || e).slice(0, 160);
    if (e && (e.code === 4200 || e.code === -32601 || e.code === -32004 || UNSUPPORTED.test(msg)))
      throw new BroadcastError("your wallet does not sign a transaction without broadcasting it itself (no eth_signTransaction; MetaMask is one of these). Nothing was signed or sent. To send it through your wallet's own RPC instead, choose \"my wallet broadcasts\" under Broadcast in the wallet menu.", { code: "unsupported" });
    throw new BroadcastError("your wallet did not sign it (" + msg + "). Nothing was sent.", { code: "unsigned" });
  }
  const raw = typeof signed === "string" ? signed : signed && typeof signed.raw === "string" ? signed.raw : null;
  const got = decodeSigned(raw);
  for (const k of ["chainId", "nonce", "maxPriorityFeePerGas", "maxFeePerGas", "gas", "to", "value", "data"])
    if ((got[k] === null ? null : typeof got[k] === "bigint" ? got[k] : lower(got[k])) !== want[k])
      throw new BroadcastError("your wallet signed a different transaction (" + k + " changed): nothing was sent", { code: "changed" });
  if (got.accessList.length) throw new BroadcastError("your wallet added an access list: nothing was sent", { code: "changed" });
  // the signer, recovered by the chain's own ecrecover at an agreed block
  const who = await D.reader.call(snap, ECRECOVER, got.signingHash + word(27 + got.yParity) + word(got.r) + word(got.s));
  if (!/^0x[0-9a-f]{64}$/.test(who || "") || "0x" + who.slice(26) !== lower(from))
    throw new BroadcastError("the transaction your wallet signed is not from " + from + ": nothing was sent", { code: "signer" });
  // broadcast, in the profile's order
  assertProfileCurrent();
  const errors = [];
  let unanswered = false;
  for (const url of D.rpcs){
    let j;
    try {
      const r = await D.fetchImpl(url, { method: "POST", headers: { "content-type": "application/json" }, credentials: "omit", redirect: "error", cache: "no-store",
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_sendRawTransaction", params: [lower(raw)] }), signal: AbortSignal.timeout(15000) });
      j = await r.json();
    } catch (e){ unanswered = true; errors.push(host(url) + ": no answer (" + String((e && e.message) || e).slice(0, 80) + ")"); continue; }
    if (j && typeof j.result === "string" && lower(j.result) === got.hash){ D.noteSent(got.hash); return got.hash; }
    if (j && j.error && KNOWN.test(String(j.error.message || ""))){ D.noteSent(got.hash); return got.hash; }
    if (j && j.error){ errors.push(host(url) + ": " + String(j.error.message || "refused").slice(0, 160)); continue; }
    unanswered = true; errors.push(host(url) + ": an answer that is not this transaction");
  }
  if (unanswered){
    D.noteSent(got.hash);
    throw new BroadcastError("the network profile's endpoints may have received it (" + errors.join("; ") + "). Its outcome is unknown: the same signed bytes were offered to each of them"
      + " and nothing more is sent. Check " + got.hash + " before creating another transaction (nonce " + nonce + " executes at most once).", { code: "unknown", outcomeUnknown: true, hash: got.hash });
  }
  throw new BroadcastError("every endpoint of the network profile refused this transaction (" + errors.join("; ") + "). It was sent nowhere else, and your wallet was not asked to broadcast it.", { code: "refused", hash: got.hash });
}
const host = (u) => { try { return new URL(u).host; } catch { return String(u); } };
