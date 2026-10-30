// cli/independent-signer.mjs -- an external wallet (Clef, an eth_signTransaction endpoint, a broadcast-only wallet such as
// Frame or one behind a browser) as the SIGNING AUTHORITY of independent mode, never as a source of chain state. Nonce,
// gas, fees, simulation and receipts come from the agreeing RPC quorum (cli/independent.mjs); the wallet only approves.
//
//   sign (preferred): the CLI prepares every field, the wallet signs (eth_signTransaction / Clef account_signTransaction),
//     every field of the returned bytes is checked and the sender recovered, and sendQuorumTx broadcasts the identical
//     bytes to the quorum. The bytes are journaled before they leave this process.
//   wallet-send (secondary): a wallet that only offers eth_sendTransaction gets the fully prepared transaction once; the
//     intent is journaled first, and the returned hash is accepted only when the quorum shows a mined transaction with
//     that hash, this sender and these fields. The wallet chooses where it broadcasts; a different transaction can only
//     be detected afterwards, not prevented. That is weaker than sign, and is reported as such.
//   handoff: no endpoint at all (MetaMask in a browser): the exact transaction is printed with its intent id; `signer
//     attach <id> <hash>` then confirms it the same way.
// Nothing is retried automatically. An ambiguous outcome stays an intent until `signer resolve` decides it from the chain.
// work/independent-signer-interface.txt is the contract.
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { getAddress, keccak256, parseTransaction, serializeTransaction, recoverTransactionAddress, recoverMessageAddress,
  recoverTypedDataAddress, serializeTypedData, getTypesForEIP712Domain, validateTypedData, stringToHex, toHex } from "viem";
import { rpcEndpoint, redactUrls } from "../network/rpc-identity.mjs";
import { sendQuorumTx } from "./independent.mjs";

export const INTENT_FORMAT = "enclave-signer-intent/v1";
const MODES = ["auto", "sign", "wallet-send", "handoff"];
const PROTOCOLS = ["auto", "eth", "clef"];
const MAX_RAW_HEX = 2 + 2 * 131072;
const SECP256K1_HALF_N = 0x7fffffffffffffffffffffffffffffff5d576e7357a4501ddfe92f46681b20a0n;
const isAddr = (a) => typeof a === "string" && /^0x[0-9a-fA-F]{40}$/.test(a);
const isHash = (h) => typeof h === "string" && /^0x[0-9a-fA-F]{64}$/.test(h);
const hex = (n) => "0x" + BigInt(n).toString(16);
const clip = (s) => redactUrls(String(s ?? "")).replace(/\s+/g, " ").slice(0, 200);

/** code: url | account | chain | busy | rejected | unsupported | unreachable | timeout | transport | protocol | wallet |
 *  mismatch | replaced | unknown | handoff | state. `delivered`: false when the request provably never reached the wallet. */
export class SignerError extends Error {
  constructor(code, message, extra = {}) {
    super(message);
    this.name = "SignerError"; this.code = code;
    Object.assign(this, extra);
  }
}

// ---- transport --------------------------------------------------------------------------------------------------------

/** The signer URL under the shared policy (https, or plain http only on loopback; no userinfo or fragment). */
export function signerEndpoint(raw) {
  let e;
  try { e = rpcEndpoint(raw); } catch (err) { throw new SignerError("url", `--signer: ${err.message.replace(/^RPC URLs?/, "signer URLs")}`); }
  return { url: e.url.href, label: e.label };
}

function transportError(e, method, label, timeoutMs) {
  const chainOf = (x) => { const out = []; for (let i = 0; x && i < 6; x = x.cause, i++) out.push(x); return out; };
  const all = chainOf(e);
  if (all.some((x) => x?.name === "TimeoutError" || x?.name === "AbortError"))
    return new SignerError("timeout", `${label} did not answer ${method} within ${Math.round(timeoutMs / 1000)}s`, { delivered: "unknown" });
  if (all.some((x) => x?.code === "ECONNREFUSED"))
    return new SignerError("unreachable", `${label} refused the connection (${method} was not delivered)`, { delivered: false });
  if (all.some((x) => /redirect/i.test(String(x?.message))))
    return new SignerError("transport", `${label} answered ${method} with a redirect; signers are never followed elsewhere`, { delivered: "unknown" });
  return new SignerError("transport", `${label}: ${method} failed (${clip(all.at(-1)?.code || all.at(-1)?.message || e)})`, { delivered: "unknown" });
}

function walletError(err, method, label) {
  const code = Number(err?.code), msg = clip(err?.message);
  if (code === 4001 || /\b(denied|rejected|declined|cancel+ed)\b/i.test(msg))
    return new SignerError("rejected", `${label} refused ${method}: ${msg || "rejected by the user"}`, { walletCode: code });
  if (code === -32601 || code === 4200 || /\bmethod\b.*\b(not found|not supported|unsupported|does not exist|not available)\b/i.test(msg) || /\bunsupported method\b/i.test(msg))
    return new SignerError("unsupported", `${label} does not offer ${method}`, { walletCode: code });
  return new SignerError("wallet", `${label} answered ${method} with an error: ${msg || code}`, { walletCode: code });
}

/** One JSON-RPC request per call: no redirects, a deadline, a response size cap, the id checked; never retried. */
export function jsonRpcClient({ url, label = "signer", fetch: inner = globalThis.fetch, maxBytes = 1 << 20 }) {
  let nextId = 1;
  async function call(method, params, { timeoutMs = 10000 } = {}) {
    const id = nextId++;
    const signal = AbortSignal.timeout(timeoutMs);
    let text;
    try {
      const res = await inner(url, { method: "POST", redirect: "error", signal,
        headers: { "content-type": "application/json", accept: "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id, method, params }) });
      const len = Number(res.headers.get("content-length"));
      if (Number.isFinite(len) && len > maxBytes) throw new SignerError("protocol", `${label} answered ${method} with more than ${maxBytes} bytes`, { delivered: "unknown" });
      const chunks = []; let size = 0;
      if (res.body) for await (const c of res.body) {
        size += c.length;
        if (size > maxBytes) throw new SignerError("protocol", `${label} answered ${method} with more than ${maxBytes} bytes`, { delivered: "unknown" });
        chunks.push(c);
      }
      text = Buffer.concat(chunks).toString("utf8");
      if (res.status >= 300 && res.status < 400) throw new SignerError("transport", `${label} answered ${method} with a redirect; signers are never followed elsewhere`, { delivered: "unknown" });
      if (!res.ok && !/^\s*\{/.test(text)) throw new SignerError("transport", `${label} answered ${method} with HTTP ${res.status}`, { delivered: "unknown" });
    } catch (e) {
      if (e instanceof SignerError) throw e;
      throw transportError(e, method, label, timeoutMs);
    }
    let msg;
    try { msg = JSON.parse(text); } catch { throw new SignerError("protocol", `${label} answered ${method} with something that is not JSON`, { delivered: "unknown" }); }
    if (!msg || typeof msg !== "object" || Array.isArray(msg) || msg.jsonrpc !== "2.0" || msg.id !== id || (("result" in msg) === ("error" in msg)))
      throw new SignerError("protocol", `${label} answered ${method} with a malformed JSON-RPC response`, { delivered: "unknown" });
    if (msg.error) throw walletError(msg.error, method, label);
    return msg.result;
  }
  return { call };
}

// ---- verification ---------------------------------------------------------------------------------------------------

/** The transaction the CLI intends, in one canonical shape (EIP-1559, every field explicit, no access list). */
export function intendedTx(tx, chainId) {
  if (tx.type !== undefined && tx.type !== "eip1559") throw new SignerError("state", `only EIP-1559 transactions are signed externally (asked for ${tx.type})`);
  if (tx.chainId !== undefined && Number(tx.chainId) !== Number(chainId)) throw new SignerError("chain", `the transaction is for chain ${tx.chainId}, the quorum is chain ${chainId}`);
  if (tx.accessList?.length || tx.authorizationList?.length || tx.blobVersionedHashes?.length) throw new SignerError("state", "access lists, authorizations and blobs are not signed externally");
  if (!isAddr(tx.to)) throw new SignerError("state", "a contract creation or a transaction without a recipient is not signed externally");
  for (const k of ["nonce", "gas", "maxFeePerGas", "maxPriorityFeePerGas"]) if (tx[k] === undefined || tx[k] === null) throw new SignerError("state", `the prepared transaction has no ${k}`);
  return { type: "eip1559", chainId: Number(chainId), nonce: Number(tx.nonce), to: getAddress(tx.to), value: BigInt(tx.value || 0n),
    data: String(tx.data || "0x").toLowerCase(), gas: BigInt(tx.gas), maxFeePerGas: BigInt(tx.maxFeePerGas), maxPriorityFeePerGas: BigInt(tx.maxPriorityFeePerGas) };
}

function fieldDiffs(got, want, { fees = true } = {}) {
  const d = [];
  const eq = (k, a, b) => { if (a !== b) d.push(`${k} ${b} != intended ${a}`); };
  eq("chainId", want.chainId, Number(got.chainId));
  eq("nonce", want.nonce, Number(got.nonce));
  eq("to", want.to.toLowerCase(), String(got.to || "").toLowerCase());
  eq("value", String(want.value), String(BigInt(got.value || 0n)));
  const data = String(got.data ?? got.input ?? "0x").toLowerCase();
  if (data !== want.data) d.push(`data (${(data.length - 2) / 2} bytes) != intended (${(want.data.length - 2) / 2} bytes)`);
  if (fees) for (const k of ["gas", "maxFeePerGas", "maxPriorityFeePerGas"]) eq(k, String(want[k]), String(BigInt(got[k] ?? -1n)));
  if ((got.accessList?.length || 0) !== 0) d.push("an access list was added");
  if (got.authorizationList?.length || got.blobVersionedHashes?.length || got.maxFeePerBlobGas !== undefined && got.maxFeePerBlobGas !== null) d.push("blob or authorization fields were added");
  return d;
}

function sigOk(t) {
  const r = BigInt(t.r || 0), s = BigInt(t.s || 0);
  return (t.yParity === 0 || t.yParity === 1) && r > 0n && s > 0n && s <= SECP256K1_HALF_N;
}

/** Signed bytes from a wallet -> { raw, hash } once they are exactly `want`, canonical, and from `from`; else `mismatch`. */
export async function verifySignedTransaction(raw, want, from) {
  const bad = (why) => new SignerError("mismatch", `the wallet's signed transaction was refused (${why}); nothing was broadcast`);
  if (typeof raw !== "string" || raw.length > MAX_RAW_HEX || raw.length % 2 || !/^0x02(?:[0-9a-fA-F]{2})*$/.test(raw)) throw bad("not EIP-1559 signed bytes");
  raw = raw.toLowerCase();
  let t;
  try { t = parseTransaction(raw); } catch { throw bad("the bytes do not decode"); }
  if (t.type !== "eip1559") throw bad(`type ${t.type}`);
  const diffs = fieldDiffs(t, want);
  if (diffs.length) throw bad(`it differs from the prepared transaction: ${diffs.join("; ")}`);
  if (!sigOk(t)) throw bad("a malformed or high-s signature");
  let canonical;
  try { canonical = serializeTransaction({ ...want }, { r: t.r, s: t.s, yParity: t.yParity }); } catch { throw bad("the signature does not encode"); }
  if (canonical !== raw) throw bad("a non-canonical encoding (extra or re-ordered bytes)");
  const sender = await recoverTransactionAddress({ serializedTransaction: raw });
  if (sender.toLowerCase() !== from.toLowerCase()) throw bad(`it is signed by ${sender}, not ${getAddress(from)}`);
  return { raw, hash: keccak256(raw) };
}

/** A mined transaction object (as agreed by the quorum) -> { diffs, adjusted }. Its own fields and signature must
 *  re-encode to `hash` and recover to `from`; then its fields are compared with the intent. */
export async function verifyMinedTransaction(tx, intent, { feePolicy = "capped", capWei, gasCap } = {}) {
  const diffs = [], adjusted = [];
  if (tx.type !== "eip1559") return { diffs: [`type ${tx.type}, not EIP-1559`], adjusted };
  let raw;
  try {
    raw = serializeTransaction({ type: "eip1559", chainId: Number(tx.chainId), nonce: Number(tx.nonce), to: tx.to, value: BigInt(tx.value),
      data: tx.input, gas: BigInt(tx.gas), maxFeePerGas: BigInt(tx.maxFeePerGas), maxPriorityFeePerGas: BigInt(tx.maxPriorityFeePerGas),
      accessList: tx.accessList || [] }, { r: tx.r, s: tx.s, yParity: Number(tx.yParity) });
  } catch { return { diffs: ["the transaction does not re-encode"], adjusted }; }
  if (keccak256(raw) !== String(tx.hash).toLowerCase()) diffs.push("its fields do not hash to the reported transaction hash");
  if (intent.hash && String(tx.hash).toLowerCase() !== intent.hash) diffs.push(`hash ${tx.hash} is not the wallet's ${intent.hash}`);
  const sender = await recoverTransactionAddress({ serializedTransaction: raw }).catch(() => null);
  if (!sender || sender.toLowerCase() !== intent.from.toLowerCase()) diffs.push(`signed by ${sender || "nobody recoverable"}, not ${intent.from}`);
  const want = wantOf(intent);
  diffs.push(...fieldDiffs({ ...tx, data: tx.input }, want, { fees: feePolicy === "exact" }));
  if (feePolicy !== "exact") {
    for (const k of ["gas", "maxFeePerGas", "maxPriorityFeePerGas"]) if (BigInt(tx[k]) !== want[k]) adjusted.push(`${k} ${tx[k]} (prepared ${want[k]})`);
    if (capWei !== undefined && BigInt(tx.maxFeePerGas) > BigInt(capWei)) diffs.push(`maxFeePerGas ${tx.maxFeePerGas} is above the --max-fee-gwei cap`);
    if (BigInt(tx.maxPriorityFeePerGas) > BigInt(tx.maxFeePerGas)) diffs.push("priority fee above max fee");
    if (gasCap !== undefined && BigInt(tx.gas) > BigInt(gasCap)) diffs.push(`gas ${tx.gas} is above the ${gasCap} cap`);
  }
  return { diffs, adjusted };
}

const normSig = (sig, label, what) => {
  if (typeof sig !== "string" || !/^0x[0-9a-fA-F]{130}$/.test(sig)) throw new SignerError("protocol", `${label} answered ${what} with something that is not a 65-byte signature`);
  const v = parseInt(sig.slice(130), 16);
  if (v === 0 || v === 1) return sig.slice(0, 130).toLowerCase() + (v + 27).toString(16);
  if (v !== 27 && v !== 28) throw new SignerError("protocol", `${label} answered ${what} with a signature whose v is ${v}`);
  return sig.toLowerCase();
};

// ---- intent journal -----------------------------------------------------------------------------------------------------

const UNRESOLVED = new Set(["signed", "requested", "submitted", "unknown", "handoff"]);
export const isUnresolved = (rec) => UNRESOLVED.has(rec?.state);
const enc = (o) => JSON.stringify(o, (_k, v) => typeof v === "bigint" ? `${v}n` : v, 2);
const dec = (s) => JSON.parse(s, (_k, v) => typeof v === "string" && /^-?\d+n$/.test(v) ? BigInt(v.slice(0, -1)) : v);
const ID_RE = /^tx-[0-9a-z]{6,12}-[0-9a-f]{8}$/;

/** Durable intents: one 0600 JSON file per transaction this CLI asked a wallet about, written atomically before the request. */
export function intentJournal(dir) {
  if (!dir) throw new SignerError("state", "an external signer needs a journal directory (--state-dir)");
  dir = path.resolve(dir);
  const ensure = () => fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const fileOf = (id) => { if (!ID_RE.test(String(id))) throw new SignerError("state", "not an intent id"); return path.join(dir, `${id}.json`); };
  function put(rec) {
    ensure();
    const f = fileOf(rec.id), tmp = `${f}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, enc({ ...rec, updatedAt: Date.now() }) + "\n", { mode: 0o600 });
    fs.renameSync(tmp, f);
    return rec;
  }
  function get(id) {
    let s;
    try { s = fs.readFileSync(fileOf(id), "utf8"); } catch (e) { if (e.code === "ENOENT") throw new SignerError("state", `no intent ${id}`); throw e; }
    const rec = dec(s);
    if (rec.format !== INTENT_FORMAT || rec.id !== id) throw new SignerError("state", `intent ${id} is not a signer intent`);
    return rec;
  }
  function list() {
    let names = [];
    try { names = fs.readdirSync(dir); } catch (e) { if (e.code !== "ENOENT") throw e; }
    return names.filter((n) => n.endsWith(".json") && ID_RE.test(n.slice(0, -5))).map((n) => { try { return get(n.slice(0, -5)); } catch { return null; } })
      .filter(Boolean).sort((a, b) => a.createdAt - b.createdAt);
  }
  const create = (fields) => put({ format: INTENT_FORMAT, id: `tx-${Date.now().toString(36)}-${crypto.randomBytes(4).toString("hex")}`, createdAt: Date.now(), ...fields });
  const update = (id, fields) => put({ ...get(id), ...fields });
  const unresolved = (from, chainId) => list().filter((r) => isUnresolved(r) && r.from.toLowerCase() === from.toLowerCase() && r.chainId === Number(chainId));
  return { dir, put, get, list, create, update, unresolved };
}
const wantOf = (r) => ({ type: "eip1559", chainId: r.chainId, nonce: Number(r.nonce), to: getAddress(r.to), value: BigInt(r.value), data: r.data,
  gas: BigInt(r.gas), maxFeePerGas: BigInt(r.maxFeePerGas), maxPriorityFeePerGas: BigInt(r.maxPriorityFeePerGas) });

// ---- quorum reads for wallet-sent and unknown transactions ---------------------------------------------------------------

const isRevert = (e) => { for (let x = e, i = 0; x && i < 8; x = x.cause, i++) if (x.name === "ContractFunctionRevertedError" || x.name === "ExecutionRevertedError") return true; return false; };
const revertReason = (e) => { for (let x = e, i = 0; x && i < 8; x = x.cause, i++) if (x.reason) return String(x.reason).slice(0, 200); return clip(e?.shortMessage || e?.message).replace(/^.*?reverted(?: with the following reason:)?:?\s*/i, ""); };
const notFound = (e) => e?.name === "TransactionReceiptNotFoundError" || e?.name === "TransactionNotFoundError" || /not.?found|could not be found/i.test(String(e?.shortMessage || e?.message));
const receiptView = (r) => ({ status: r.status, blockNumber: r.blockNumber, blockHash: r.blockHash, transactionHash: r.transactionHash,
  contractAddress: r.contractAddress ?? null, gasUsed: r.gasUsed,
  logs: (r.logs || []).map((l) => ({ address: l.address.toLowerCase(), topics: l.topics, data: l.data, logIndex: l.logIndex })) });
const txView = (t) => ({ hash: String(t.hash).toLowerCase(), from: String(t.from).toLowerCase(), to: t.to ? String(t.to).toLowerCase() : null,
  input: String(t.input || "0x").toLowerCase(), value: BigInt(t.value || 0n), nonce: Number(t.nonce), gas: BigInt(t.gas), type: t.type,
  maxFeePerGas: t.maxFeePerGas !== undefined ? BigInt(t.maxFeePerGas) : null, maxPriorityFeePerGas: t.maxPriorityFeePerGas !== undefined ? BigInt(t.maxPriorityFeePerGas) : null,
  chainId: t.chainId !== undefined ? Number(t.chainId) : null, accessList: t.accessList || [], r: t.r, s: t.s,
  yParity: t.yParity !== undefined ? Number(t.yParity) : null, blockNumber: t.blockNumber, blockHash: t.blockHash });

/** sendQuorumTx's preflight, for paths where the CLI does not hold the signed bytes: an agreed simulation, one agreed
 *  pending nonce, the highest gas estimate (+20%, capped) and the highest fees (capped by --max-fee-gwei). */
export async function preflight(chain, { from, to, data, value = 0n, maxFeeGwei = 5, gasCap = 15_000_000n }) {
  const sim = await chain.snapshot(async (c, blockNumber) => {
    try { await c.call({ account: from, to, data, value, blockNumber }); return { ok: true }; }
    catch (e) { if (isRevert(e)) return { revert: revertReason(e) }; throw e; }
  });
  if (sim.value.revert !== undefined) throw new SignerError("state", `refusing to send: the transaction would revert at agreed block ${sim.blockNumber} (${sim.value.revert || "no reason"})`);
  const nonces = await chain.each((c) => c.getTransactionCount({ address: from, blockTag: "pending" }), "pending nonce");
  if (new Set(nonces.map(String)).size !== 1) throw new SignerError("state", `refusing to send: the RPCs disagree on this wallet's pending nonce (${[...new Set(nonces.map(String))].join(", ")}); a transaction may be in flight - wait and check status`);
  const gases = await chain.each((c) => c.estimateGas({ account: from, to, data, value }), "gas estimate");
  let gas = gases.reduce((m, g) => (g > m ? g : m), 0n); gas += gas / 5n;
  if (gas > BigInt(gasCap)) throw new SignerError("state", `refusing to send: gas estimate ${gas} is above the ${gasCap} cap`);
  const fees = await chain.each((c) => c.estimateFeesPerGas(), "fee estimate");
  const maxFeePerGas = fees.reduce((m, f) => (f.maxFeePerGas > m ? f.maxFeePerGas : m), 0n) || 1n;
  let maxPriorityFeePerGas = fees.reduce((m, f) => (f.maxPriorityFeePerGas > m ? f.maxPriorityFeePerGas : m), 0n);
  if (maxPriorityFeePerGas > maxFeePerGas) maxPriorityFeePerGas = maxFeePerGas;
  const capWei = BigInt(Math.round(Number(maxFeeGwei) * 1e9));
  if (maxFeePerGas > capWei) throw new SignerError("state", `refusing to send: max fee ${maxFeePerGas} wei/gas is above --max-fee-gwei ${maxFeeGwei}`);
  return { nonce: Number(nonces[0]), gas, maxFeePerGas, maxPriorityFeePerGas, capWei, startBlock: sim.blockNumber };
}

/** One agreed look at a hash: { receipt, tx } once mined in a confirmed block, else { pending, nonceUsed }. */
async function lookHash(chain, { hash, from, nonce }) {
  return chain.snapshot(async (c, blockNumber) => {
    let r;
    try { r = await c.getTransactionReceipt({ hash }); } catch (e) { if (!notFound(e)) throw e; }
    if (!r || r.blockNumber > blockNumber || (await c.getBlock({ blockNumber: r.blockNumber })).hash !== r.blockHash)
      return { pending: true, nonceUsed: BigInt(await c.getTransactionCount({ address: from, blockNumber })) > BigInt(nonce) };
    return { receipt: receiptView(r), tx: txView(await c.getTransaction({ hash })) };
  });
}

/** Which transaction used `from`'s nonce N, decided in ONE agreed snapshot: each peer binary-searches the first block in
 *  [startBlock, agreed] whose nonce count passes N (historical state: an archive-capable RPC is needed for old ranges). */
export async function findByNonce(chain, { from, nonce, startBlock = 0n, maxRange = 1_000_000n }) {
  return chain.snapshot(async (c, head) => {
    const count = async (b) => BigInt(await c.getTransactionCount({ address: from, blockNumber: b }));
    const N = BigInt(nonce);
    if (await count(head) <= N) return { used: false };
    let lo = BigInt(startBlock) - 1n, hi = head;
    if (hi - lo > BigInt(maxRange)) throw new SignerError("state", `the search range ${hi - lo} blocks is above ${maxRange}`);
    if (lo >= 0n && (await count(lo)) > N) return { used: true, block: null };
    while (hi - lo > 1n) { const mid = (lo + hi) / 2n; if ((await count(mid)) > N) hi = mid; else lo = mid; }
    const blk = await c.getBlock({ blockNumber: hi, includeTransactions: true });
    const t = blk.transactions.find((x) => String(x.from).toLowerCase() === from.toLowerCase() && BigInt(x.nonce) === N);
    if (!t) return { used: true, block: hi };
    return { used: true, block: hi, tx: txView(t), receipt: receiptView(await c.getTransactionReceipt({ hash: t.hash })) };
  });
}

// ---- outcomes ---------------------------------------------------------------------------------------------------------------

const resolveHint = (id) => `enclave --independent … signer resolve ${id}`;
function unknownError(rec, why) {
  return new SignerError("unknown", `${rec.hash ? `transaction ${rec.hash}` : `the wallet's transaction for nonce ${rec.nonce}`} (intent ${rec.id}) ${why}; `
    + `its outcome is UNKNOWN. Do not resend or re-sign it: ${resolveHint(rec.id)} decides it from the chain.`, { outcomeUnknown: true, intent: rec.id, hash: rec.hash || null });
}

/** A mined transaction for an intent -> the journal's verdict, or throws for a mismatch or a revert. */
async function settleMined(journal, rec, { receipt, tx }, s, policy) {
  const { diffs, adjusted } = await verifyMinedTransaction(tx, rec, policy);
  if (diffs.length) {
    journal.update(rec.id, { state: "mismatch", hash: tx.hash, minedBlock: receipt.blockNumber, diffs });
    throw new SignerError("mismatch", `THE WALLET SENT A DIFFERENT TRANSACTION than the one prepared (intent ${rec.id}, ${tx.hash}): ${diffs.join("; ")}. `
      + "It is mined; nothing that depends on it was done.", { intent: rec.id, hash: tx.hash, mined: true });
  }
  if (receipt.status !== "success") {
    journal.update(rec.id, { state: "reverted", hash: tx.hash, minedBlock: receipt.blockNumber });
    throw Object.assign(new SignerError("state", `transaction reverted: ${tx.hash} (block ${receipt.blockNumber})`), { mined: true, intent: rec.id });
  }
  journal.update(rec.id, { state: "confirmed", hash: tx.hash, minedBlock: receipt.blockNumber, adjusted });
  return { ...receipt, agreedBlock: s.blockNumber, agreeing: s.agreeing, intent: rec.id, adjusted };
}

const policyOf = (rec, capWei, gasCap) => ({ feePolicy: rec.mode === "sign" ? "exact" : (rec.feePolicy || "capped"), capWei: rec.capWei ?? capWei, gasCap: rec.gasCap ?? gasCap });

/** One agreed decision about an intent (no waiting): -> { state, ... }. Updates the journal; never sends anything. */
export async function resolveIntent(chain, journal, id) {
  const rec = journal.get(id);
  if (!isUnresolved(rec)) return { state: rec.state, intent: rec };
  if (rec.chainId !== chain.chainId) throw new SignerError("chain", `intent ${id} is for chain ${rec.chainId}`);
  const policy = policyOf(rec);
  if (rec.hash) {
    const s = await lookHash(chain, rec);
    if (s.value.receipt) {
      try { const r = await settleMined(journal, rec, s.value, s, policy); return { state: "confirmed", receipt: r, intent: journal.get(id) }; }
      catch (e) { if (e.mined) return { state: journal.get(id).state, error: e.message, intent: journal.get(id) }; throw e; }
    }
    if (!s.value.nonceUsed) return { state: rec.state, pending: true, open: true, intent: rec, agreedBlock: s.blockNumber,
      note: `${rec.hash} is not mined and nonce ${rec.nonce} of ${rec.from} is unused at agreed block ${s.blockNumber}: it may still be mined, or it was dropped; the wallet may still send it` };
  }
  const f = await findByNonce(chain, rec);
  if (!f.value.used) return { state: rec.state, open: true, intent: rec, agreedBlock: f.blockNumber,
    note: `nonce ${rec.nonce} of ${rec.from} is unused at agreed block ${f.blockNumber}: the wallet may still send it` };
  if (!f.value.tx) { journal.update(id, { state: "unknown", nonceUsedAt: f.value.block }); return { state: "unknown", intent: journal.get(id), note: `nonce ${rec.nonce} was used, but its transaction was not found` }; }
  if (rec.hash && f.value.tx.hash !== rec.hash) {
    journal.update(id, { state: "replaced", replacedBy: f.value.tx.hash, minedBlock: f.value.block });
    return { state: "replaced", replacedBy: f.value.tx.hash, intent: journal.get(id), note: `nonce ${rec.nonce} went to ${f.value.tx.hash}; ${rec.hash} can never be mined` };
  }
  try { const r = await settleMined(journal, rec, f.value, f, policy); return { state: "confirmed", receipt: r, intent: journal.get(id) }; }
  catch (e) { if (e.mined) return { state: journal.get(id).state, error: e.message, intent: journal.get(id) }; throw e; }
}

/** Wait for an intent with a hash to be mined and agreed: the receipt (sendQuorumTx-shaped) or throws. */
export async function confirmIntent(chain, journal, id, { timeoutMs = 180000, pollMs = 1000, now = Date.now, sleep = (ms) => new Promise((r) => setTimeout(r, ms)) } = {}) {
  const deadline = now() + timeoutMs;
  let last = "no quorum yet";
  for (;;) {
    try {
      const r = await resolveIntent(chain, journal, id);
      if (r.state === "confirmed") return r.receipt;
      if (r.state === "replaced") throw new SignerError("replaced", `intent ${id}: ${r.note}`, { intent: id, definite: true });
      if (r.error) throw Object.assign(new SignerError(r.state === "mismatch" ? "mismatch" : "state", r.error), { mined: true, intent: id });
      last = r.pending ? "not yet mined in a confirmed block" : r.note || r.state;
    } catch (e) { if (e instanceof SignerError && e.code !== "unknown") throw e; last = clip(e.message); }
    if (now() >= deadline) break;
    await sleep(pollMs);
  }
  throw unknownError(journal.get(id), `was not confirmed by an RPC quorum within ${Math.round(timeoutMs / 1000)}s (${last})`);
}

// ---- the signer --------------------------------------------------------------------------------------------------------

/**
 * An account-shaped external signer. { url, from, chainId, protocol, mode, journalDir, approvalTimeoutMs, probeTimeoutMs,
 * feePolicy, fetch, log, onHandoff(rec, params) }. `from` is required: nothing is ever chosen for the user.
 */
export function createExternalSigner({ url, from, chainId, protocol = "auto", mode = "auto", journalDir, approvalTimeoutMs = 300000,
  probeTimeoutMs = 10000, feePolicy = "capped", fetch, log = () => {}, onHandoff = null, now = Date.now, sleep } = {}) {
  if (!isAddr(from)) throw new SignerError("account", "an external signer needs --from 0x… (the account to act as); a signer may hold several and none is chosen for you");
  if (!MODES.includes(mode)) throw new SignerError("state", `--signer-mode must be one of ${MODES.join(", ")}`);
  if (!PROTOCOLS.includes(protocol)) throw new SignerError("state", `signer protocol must be one of ${PROTOCOLS.join(", ")}`);
  if (!["capped", "exact"].includes(feePolicy)) throw new SignerError("state", "fee policy must be capped or exact");
  if (!Number.isSafeInteger(Number(chainId)) || Number(chainId) <= 0) throw new SignerError("chain", "an external signer needs the quorum's chain id");
  chainId = Number(chainId);
  const address = getAddress(from);
  const ep = mode === "handoff" ? (url ? signerEndpoint(url) : null) : signerEndpoint(url);
  const label = ep ? ep.label : "your wallet";
  const rpc = ep ? jsonRpcClient({ url: ep.url, label, fetch }) : null;
  const journal = intentJournal(journalDir);
  let probed = null;

  async function walletChain() {
    const id = await rpc.call("eth_chainId", [], { timeoutMs: probeTimeoutMs });
    const n = typeof id === "string" && /^0x[0-9a-fA-F]{1,16}$/.test(id) ? parseInt(id, 16) : NaN;
    if (n !== chainId) throw new SignerError("chain", `${label} is on chain ${Number.isFinite(n) ? n : "?"}, the quorum is chain ${chainId}: switch the wallet's network (nothing was asked of it)`);
    return n;
  }
  /** -> { protocol, label, address, walletChainId }. Lists accounts (Clef asks its user to approve the listing). */
  async function probe() {
    if (probed) return probed;
    if (!rpc) throw new SignerError("state", "handoff mode has no signer endpoint to probe");
    let proto = protocol;
    if (proto === "auto") {
      try { await rpc.call("account_version", [], { timeoutMs: probeTimeoutMs }); proto = "clef"; }
      catch (e) { if (e.code === "unsupported" || e.code === "wallet") proto = "eth"; else throw e; }
    }
    const asList = (v, method) => {
      if (!Array.isArray(v) || v.length > 1000 || !v.every(isAddr)) throw new SignerError("protocol", `${label} answered ${method} with something that is not a list of addresses`);
      return v.map((a) => a.toLowerCase());
    };
    let accounts;
    if (proto === "clef") accounts = asList(await rpc.call("account_list", [], { timeoutMs: approvalTimeoutMs }), "account_list");
    else {
      accounts = asList(await rpc.call("eth_accounts", [], { timeoutMs: probeTimeoutMs }), "eth_accounts");
      if (!accounts.includes(address.toLowerCase())) {
        try { accounts = asList(await rpc.call("eth_requestAccounts", [], { timeoutMs: approvalTimeoutMs }), "eth_requestAccounts"); }
        catch (e) { if (e.code !== "unsupported") throw e; }
      }
    }
    if (!accounts.includes(address.toLowerCase()))
      throw new SignerError("account", `${label} does not offer ${address} (it offers ${accounts.length} account${accounts.length === 1 ? "" : "s"}); nothing was signed`);
    const walletChainId = proto === "eth" ? await walletChain() : null;
    probed = Object.freeze({ protocol: proto, label, address, walletChainId });
    return probed;
  }

  async function signTransaction(tx) {
    const p = await probe();
    const want = intendedTx(tx, chainId);
    const req = { from: address, to: want.to, value: hex(want.value), data: want.data, nonce: hex(want.nonce), gas: hex(want.gas),
      maxFeePerGas: hex(want.maxFeePerGas), maxPriorityFeePerGas: hex(want.maxPriorityFeePerGas), chainId: hex(chainId), accessList: [] };
    const [method, params] = p.protocol === "clef" ? ["account_signTransaction", [{ ...req, input: want.data }]] : ["eth_signTransaction", [{ ...req, type: "0x2" }]];
    log(`asking ${label} to sign nonce ${want.nonce} to ${want.to} (approve it in the wallet)`);
    let out;
    try { out = await rpc.call(method, params, { timeoutMs: approvalTimeoutMs }); }
    catch (e) { e.signed = false; e.message += "; nothing was broadcast"; throw e; }
    const raw = typeof out === "string" ? out : out && typeof out.raw === "string" ? out.raw : null;
    if (!raw) throw new SignerError("protocol", `${label} answered ${method} without signed bytes; nothing was broadcast`);
    return (await verifySignedTransaction(raw, want, address)).raw;
  }

  async function signMessage({ message }) {
    const p = await probe();
    const data = typeof message === "string" ? stringToHex(message) : typeof message?.raw === "string" ? message.raw.toLowerCase() : toHex(message?.raw);
    const [method, params] = p.protocol === "clef" ? ["account_signData", ["text/plain", address, data]] : ["personal_sign", [data, address]];
    const sig = normSig(await rpc.call(method, params, { timeoutMs: approvalTimeoutMs }), label, method);
    const who = await recoverMessageAddress({ message, signature: sig }).catch(() => null);
    if (!who || who.toLowerCase() !== address.toLowerCase()) throw new SignerError("mismatch", `${label} returned a message signature by ${who || "nobody recoverable"}, not ${address}; it was not used`);
    return sig;
  }

  async function signTypedData(td) {
    const p = await probe();
    if (td?.domain?.chainId !== undefined && Number(td.domain.chainId) !== chainId)
      throw new SignerError("chain", `the typed data is for chain ${td.domain.chainId}, the quorum is chain ${chainId}; nothing was asked of the wallet`);
    // the wallet hashes what it is sent: the domain's own type must be spelled out (viem's signTypedData does the same)
    const full = { ...td, types: { EIP712Domain: getTypesForEIP712Domain({ domain: td.domain || {} }), ...td.types } };
    try { validateTypedData(full); } catch (e) { throw new SignerError("state", `malformed typed data (${clip(e.shortMessage || e.message)}); nothing was asked of the wallet`); }
    const json = serializeTypedData(full);
    const [method, params] = p.protocol === "clef" ? ["account_signTypedData", [address, JSON.parse(json)]] : ["eth_signTypedData_v4", [address, json]];
    const sig = normSig(await rpc.call(method, params, { timeoutMs: approvalTimeoutMs }), label, method);
    const who = await recoverTypedDataAddress({ ...td, signature: sig }).catch(() => null);
    if (!who || who.toLowerCase() !== address.toLowerCase()) throw new SignerError("mismatch", `${label} returned a typed-data signature by ${who || "nobody recoverable"}, not ${address}; it was not used`);
    return sig;
  }

  function assertFree() {
    const open = journal.unresolved(address, chainId);
    if (open.length) throw new SignerError("busy", `refusing to send: intent ${open[0].id} (${open[0].state}, nonce ${open[0].nonce}) from ${address} is unresolved; `
      + `${resolveHint(open[0].id)} first (or attach/abandon it)`, { intent: open[0].id });
  }
  const record = (pre, extra) => journal.create({ from: address, chainId, to: getAddress(extra.to), data: String(extra.data || "0x").toLowerCase(),
    value: BigInt(extra.value || 0n), nonce: pre.nonce, gas: pre.gas, maxFeePerGas: pre.maxFeePerGas, maxPriorityFeePerGas: pre.maxPriorityFeePerGas,
    capWei: pre.capWei, gasCap: BigInt(extra.gasCap ?? 15_000_000n), startBlock: pre.startBlock, feePolicy, signer: label, mode: extra.mode, state: extra.state, hash: null });
  const sendParams = (rec) => ({ from: address, to: rec.to, value: hex(rec.value), data: rec.data, nonce: hex(rec.nonce), gas: hex(rec.gas),
    maxFeePerGas: hex(rec.maxFeePerGas), maxPriorityFeePerGas: hex(rec.maxPriorityFeePerGas), chainId: hex(chainId), type: "0x2" });

  async function walletSend(chain, o) {
    const pre = await preflight(chain, { from: address, ...o });
    await probe();
    await walletChain();
    const rec = record(pre, { ...o, mode: "wallet-send", state: "requested" });
    log(`asking ${label} to SEND nonce ${rec.nonce} to ${rec.to} itself (intent ${rec.id}; approve it in the wallet)`);
    let hash;
    try { hash = await rpc.call("eth_sendTransaction", [sendParams(rec)], { timeoutMs: approvalTimeoutMs }); }
    catch (e) {
      if (e.code === "rejected" || e.code === "unsupported" || e.delivered === false) {
        journal.update(rec.id, { state: e.code === "rejected" ? "rejected" : "not-delivered", note: e.message });
        throw Object.assign(e, { message: `${e.message}; nothing was sent (intent ${rec.id} closed)`, intent: rec.id });
      }
      journal.update(rec.id, { state: "unknown", note: e.message });
      throw unknownError(journal.get(rec.id), `was asked of ${label}, which did not answer clearly (${e.message})`);
    }
    if (!isHash(hash)) { journal.update(rec.id, { state: "unknown", note: "malformed hash" }); throw unknownError(journal.get(rec.id), `got an answer that is not a transaction hash from ${label}`); }
    journal.update(rec.id, { state: "submitted", hash: hash.toLowerCase() });
    log(`${label} returned ${hash}; waiting for the quorum to show it mined with the prepared fields`);
    return confirmIntent(chain, journal, rec.id, { timeoutMs: o.timeoutMs, pollMs: o.pollMs, now, sleep });
  }

  async function handoff(chain, o) {
    const pre = await preflight(chain, { from: address, ...o });
    const rec = record(pre, { ...o, mode: "handoff", state: "handoff" });
    const params = sendParams(rec);
    if (onHandoff) return onHandoff(rec, params);
    throw new SignerError("handoff", `send this exact transaction from ${address} with your own wallet, then run: enclave --independent … signer attach ${rec.id} <0xhash>\n`
      + JSON.stringify(params, null, 2), { intent: rec.id, params });
  }

  /** sendQuorumTx through this signer (the hook in cli/independent.mjs): sign path first, wallet-send only when allowed. */
  async function send(chain, { to, data = "0x", value = 0n, maxFeeGwei = 5, gasCap = 15_000_000n, timeoutMs = 180000, pollMs = 1000, log: l = log } = {}) {
    // the caller's log (the CLI's -x trace) gets sendQuorumTx's detail; what the user must see (the signed hash and its
    // intent, a fallback to a weaker path) always goes to the signer's own log as well, never only to a silent trace
    const note = (m) => { log(m); if (l !== log) l(m); };
    if (chain.chainId !== chainId) throw new SignerError("chain", `the signer is configured for chain ${chainId}, the quorum is chain ${chain.chainId}`);
    assertFree();
    const o = { to, data, value, maxFeeGwei, gasCap, timeoutMs, pollMs };
    if (mode === "handoff") return handoff(chain, o);
    if (mode === "wallet-send") return walletSend(chain, o);
    let rec = null;
    const signing = { address, signTransaction: async (tx) => {
      const raw = await signTransaction(tx);
      const t = intendedTx(tx, chainId);
      rec = journal.create({ from: address, chainId, to: t.to, data: t.data, value: t.value, nonce: t.nonce, gas: t.gas, maxFeePerGas: t.maxFeePerGas,
        maxPriorityFeePerGas: t.maxPriorityFeePerGas, startBlock: chain.lastBlock ?? 0n, signer: label, mode: "sign", state: "signed", raw, hash: keccak256(raw) });
      note(`${label} signed ${rec.hash} (intent ${rec.id}); every field checked, broadcasting these bytes through the quorum`);
      return raw;
    } };
    try {
      const receipt = await sendQuorumTx(chain, { account: signing, to, data, value, maxFeeGwei, gasCap, timeoutMs, pollMs, log: l });
      journal.update(rec.id, { state: "confirmed", minedBlock: receipt.blockNumber });
      return { ...receipt, intent: rec.id };
    } catch (e) {
      if (!rec) {
        if (mode === "auto" && e.code === "unsupported" && e.signed === false) {
          note(`${label} cannot sign without broadcasting; asking it to send the prepared transaction instead (weaker: the wallet broadcasts, the quorum checks afterwards)`);
          return walletSend(chain, o);
        }
        throw e;
      }
      if (e.mined) { journal.update(rec.id, { state: "reverted" }); throw Object.assign(e, { intent: rec.id }); }
      if (/no RPC accepted the transaction, nothing is pending/.test(e.message)) { journal.update(rec.id, { state: "rejected", note: clip(e.message) }); throw Object.assign(e, { intent: rec.id }); }
      journal.update(rec.id, { state: "unknown", note: clip(e.message) });
      const u = unknownError(journal.get(rec.id), e.outcomeUnknown ? "was broadcast but not confirmed" : `stopped after signing (${clip(e.message)})`);
      throw Object.assign(u, { cause: e });
    }
  }

  return { address, _external: true, label, mode, journal, probe, signTransaction, signMessage, signTypedData, sendQuorumTx: send,
    get protocol() { return probed?.protocol || protocol; } };
}

// ---- explicit follow-ups --------------------------------------------------------------------------------------------------

/** Attach the hash a wallet (or a browser page) returned for an intent that has none, then wait for the agreed verdict. */
export async function attachHash(chain, journal, id, hash, opts) {
  const rec = journal.get(id);
  if (!isHash(hash)) throw new SignerError("state", "not a 0x transaction hash");
  if (!isUnresolved(rec) || rec.hash) throw new SignerError("state", `intent ${id} is ${rec.state}${rec.hash ? ` with hash ${rec.hash}` : ""}; nothing to attach`);
  journal.update(id, { state: "submitted", hash: hash.toLowerCase() });
  return confirmIntent(chain, journal, id, opts);
}

/** Broadcast a journaled signed transaction AGAIN: the same bytes, the only safe repeat. Never re-signs. */
export async function rebroadcast(chain, journal, id, opts) {
  const rec = journal.get(id);
  if (!rec.raw) throw new SignerError("state", `intent ${id} has no signed bytes this CLI holds (a wallet-sent transaction is the wallet's to repeat)`);
  if (!isUnresolved(rec)) throw new SignerError("state", `intent ${id} is ${rec.state}; nothing to repeat`);
  const now = await resolveIntent(chain, journal, id);
  if (!isUnresolved(now.intent)) return now.state === "confirmed" ? now.receipt : (() => { throw new SignerError(now.state, `intent ${id} is ${now.state}${now.note ? `: ${now.note}` : ""}`); })();
  const sent = await Promise.allSettled(chain.peers.map(({ client }) => client.request({ method: "eth_sendRawTransaction", params: [rec.raw] })));
  const accepted = sent.filter((r) => r.status === "fulfilled" && String(r.value).toLowerCase() === rec.hash || r.status === "rejected" && /already known|known transaction/i.test(String(r.reason?.message))).length;
  journal.update(id, { state: "submitted", rebroadcasts: (rec.rebroadcasts || 0) + 1, lastRebroadcastAccepted: accepted });
  return confirmIntent(chain, journal, id, opts);
}

/** Close an unresolved intent by hand. The wallet might still send it; the next send reuses its nonce, so at most one mines. */
export function abandonIntent(journal, id) {
  const rec = journal.get(id);
  if (!isUnresolved(rec)) throw new SignerError("state", `intent ${id} is ${rec.state}`);
  journal.update(id, { state: "abandoned", abandonedFrom: rec.state });
  return { id, nonce: rec.nonce, warning: `if a wallet still holds ${rec.hash || `the request for nonce ${rec.nonce}`}, it may yet be mined; `
    + `the next transaction from ${rec.from} reuses nonce ${rec.nonce}, so at most one of them can be` };
}

/** `enclave --independent … signer <sub>`. ctx: { chain, signer, journal, flags, say, jout, json } */
export async function signerCommand(sub, rest, ctx) {
  const { say, jout, json } = ctx;
  const journal = ctx.signer?.journal || ctx.journal;
  const out = (o, text) => (json ? jout(o) : say(text));
  const show = (r) => `${r.id}  ${r.state}  ${r.mode}  nonce ${r.nonce}  to ${r.to}${r.hash ? `  ${r.hash}` : ""}`;
  const usage = "usage: enclave --independent … signer probe | list | show <id> | resolve <id> | attach <id> <0xhash> | rebroadcast <id> | abandon <id>";
  const id = rest[0];
  if (sub === "probe") {
    if (!ctx.signer) throw new SignerError("state", "signer probe needs --signer URL --from 0x…");
    const p = await ctx.signer.probe();
    return out(p, `${p.label}: ${p.protocol === "clef" ? "Clef (account_* API)" : "EIP-1193 JSON-RPC"}; offers ${p.address}${p.walletChainId ? `; wallet chain ${p.walletChainId}` : ""}. `
      + "Whether it signs without broadcasting is learned at the first transaction (nothing is signed by a probe).");
  }
  if (sub === "list") { const l = journal.list(); return out({ intents: l.map(({ raw, ...r }) => r) }, l.length ? l.map(show).join("\n") : "no signer intents"); }
  if (!id && sub !== undefined) throw new SignerError("state", usage);
  if (sub === "show") { const { raw, ...r } = journal.get(id); return out(r, Object.entries(r).map(([k, v]) => `${k.padEnd(22)} ${typeof v === "object" ? JSON.stringify(v, (_k, x) => typeof x === "bigint" ? String(x) : x) : String(v)}`).join("\n")); }
  if (sub === "resolve") { const r = await resolveIntent(ctx.chain, journal, id); const { raw, ...i } = r.intent; return out({ ...r, intent: i }, `${show(i)}${r.note ? `\n${r.note}` : ""}${r.error ? `\n${r.error}` : ""}`); }
  if (sub === "attach") { const r = await attachHash(ctx.chain, journal, id, rest[1], ctx.waitOpts); return out(r, `confirmed: ${r.transactionHash} in block ${r.blockNumber}, by ${r.agreeing} RPCs${r.adjusted?.length ? ` (the wallet changed ${r.adjusted.join(", ")})` : ""}`); }
  if (sub === "rebroadcast") { const r = await rebroadcast(ctx.chain, journal, id, ctx.waitOpts); return out(r, `confirmed: ${r.transactionHash} in block ${r.blockNumber}, by ${r.agreeing} RPCs`); }
  if (sub === "abandon") { const r = abandonIntent(journal, id); return out(r, `intent ${id} abandoned. ${r.warning}`); }
  throw new SignerError("state", usage);
}
