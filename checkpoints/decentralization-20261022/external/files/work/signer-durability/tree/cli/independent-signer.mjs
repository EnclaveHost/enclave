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
import os from "node:os";
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
const DECIDED = new Set(["confirmed", "reverted", "rejected", "not-delivered", "mismatch", "replaced", "abandoned"]);
export const isUnresolved = (rec) => UNRESOLVED.has(rec?.state);
/** Not provably decided: an unresolved state, or one this version does not know (a newer CLI's, a hand edit). Blocks sends. */
export const isOpen = (rec) => !DECIDED.has(rec?.state);
const enc = (o) => JSON.stringify(o, (_k, v) => typeof v === "bigint" ? `${v}n` : v, 2);
const dec = (s) => JSON.parse(s, (_k, v) => typeof v === "string" && /^-?\d+n$/.test(v) ? BigInt(v.slice(0, -1)) : v);
const ID_RE = /^tx-[0-9a-z]{6,12}-[0-9a-f]{8}$/;
const SLOT_FORMAT = "enclave-signer-slot/v1";
const ACCT_RE = /^\d{1,16}-0x[0-9a-f]{40}$/, KEY_RE = /^(\d{1,16}-0x[0-9a-f]{40})\/(\d{8})$/;
const gen8 = (n) => String(n).padStart(8, "0");

// Durable files: nothing is reported written before it is on disk. A record is flushed before it is renamed into place,
// and its directory after, so the name survives a power loss too. Windows: Node cannot flush a directory handle, so the
// renamed file is flushed again and the rename's own durability rests on NTFS's metadata log (best effort there). A
// POSIX filesystem that refuses fsync on a directory (EINVAL/ENOTSUP: some network and FUSE mounts) gets the same
// best effort rather than no CLI at all.
const WIN = process.platform === "win32";
function syncDir(d) {
  if (WIN) return;
  const fd = fs.openSync(d, "r");
  try { fs.fsyncSync(fd); } catch (e) { if (e.code !== "EINVAL" && e.code !== "ENOTSUP") throw e; } finally { fs.closeSync(fd); }
}
function writeAll(fd, text) { const b = Buffer.from(text); for (let o = 0; o < b.length;) o += fs.writeSync(fd, b, o, b.length - o); fs.fsyncSync(fd); }
/** `f` is created only if it does not exist (EEXIST: O_EXCL, CREATE_NEW on Windows), 0600, flushed with its name. */
function createExclusive(f, text) {
  const fd = fs.openSync(f, "wx", 0o600);
  try { writeAll(fd, text); } catch (e) { fs.closeSync(fd); try { fs.unlinkSync(f); } catch {} throw e; }
  fs.closeSync(fd);
  syncDir(path.dirname(f));
}
/** `f` replaced atomically: a reader, or a crash, sees the old content or the new, never a part. */
function replaceDurable(f, text) {
  const tmp = `${f}.${process.pid}.${crypto.randomBytes(4).toString("hex")}.tmp`;
  const fd = fs.openSync(tmp, "wx", 0o600);
  try { writeAll(fd, text); } catch (e) { fs.closeSync(fd); try { fs.unlinkSync(tmp); } catch {} throw e; }
  fs.closeSync(fd);
  try { fs.renameSync(tmp, f); } catch (e) { try { fs.unlinkSync(tmp); } catch {} throw e; }
  if (WIN) { const fd2 = fs.openSync(f, "r+"); try { fs.fsyncSync(fd2); } finally { fs.closeSync(fd2); } }
  else syncDir(path.dirname(f));
}
/** A private directory: 0700 (tightened on POSIX when it already existed), its creation flushed into its parent. */
function privateDir(d) {
  const first = fs.mkdirSync(d, { recursive: true, mode: 0o700 });
  if (!WIN && (fs.statSync(d).mode & 0o777) !== 0o700) fs.chmodSync(d, 0o700);
  if (first) for (let x = d; ; x = path.dirname(x)) { syncDir(path.dirname(x)); if (x === first) break; }
}

/**
 * Durable intents: one 0600 JSON file per transaction this CLI asked a wallet about, on disk before the request.
 * Reservations: at most one send in flight per (journal, chain, account), across processes. A send takes the next
 * generation <dir>/slot-<chainId>-<from>.<gen>.slot by exclusive create, before it reads the pending nonce or asks the
 * wallet anything; gen N+1 can only be created once gen N carries its .released marker, and no generation file is ever
 * removed, so a late or repeated release only ever marks its own generation. The send's intent names the generation;
 * it is released when that intent is decided (any command), or at the end of a send that recorded no intent. Nothing
 * waits for a reservation and nothing takes one over: a holder that died before recording an intent is released by hand.
 */
export function intentJournal(dir) {
  if (!dir) throw new SignerError("state", "an external signer needs a journal directory (--state-dir)");
  dir = path.resolve(dir);
  const fileOf = (id) => { if (!ID_RE.test(String(id))) throw new SignerError("state", "not an intent id"); return path.join(dir, `${id}.json`); };
  // never echo an unreadable file's content: it may hold signed bytes
  const unreadable = (id, why) => new SignerError("state", `intent file ${id}.json in ${dir} is unreadable (${why}); it may hold an unresolved `
    + `transaction, so nothing is sent from this journal until it is reviewed and restored, or set aside: enclave --independent … signer quarantine ${id}`, { unreadable: id, why });
  function put(rec) {
    privateDir(dir);
    replaceDurable(fileOf(rec.id), enc({ ...rec, updatedAt: Date.now() }) + "\n");
    return rec;
  }
  function get(id) {
    const f = fileOf(id);
    let s;
    try { s = fs.readFileSync(f, "utf8"); } catch (e) { if (e.code === "ENOENT") throw new SignerError("state", `no intent ${id}`); throw unreadable(id, e.code || "read error"); }
    let rec;
    try { rec = dec(s); } catch { throw unreadable(id, `not JSON, ${s.length} bytes`); }
    if (!rec || typeof rec !== "object" || rec.format !== INTENT_FORMAT || rec.id !== id) throw unreadable(id, "not a signer intent");
    if (!isAddr(rec.from) || !Number.isSafeInteger(rec.chainId) || typeof rec.state !== "string") throw unreadable(id, "fields missing");
    return rec;
  }
  /** Every intent file: the readable records, and the unreadable ones, which are never dropped silently. */
  function scan() {
    const records = [], problems = [];
    for (const n of names()) {
      if (!n.endsWith(".json") || !ID_RE.test(n.slice(0, -5))) continue;
      try { records.push(get(n.slice(0, -5))); }
      catch (e) { if (e.unreadable) problems.push({ id: e.unreadable, file: path.join(dir, n), why: e.why }); else if (!/^no intent /.test(e.message)) throw e; }
    }
    return { records: records.sort((a, b) => a.createdAt - b.createdAt), problems };
  }
  const list = () => scan().records;
  const problems = () => scan().problems;
  const create = (fields) => put({ format: INTENT_FORMAT, id: `tx-${Date.now().toString(36)}-${crypto.randomBytes(4).toString("hex")}`, createdAt: Date.now(), ...fields });
  function update(id, fields) {
    const cur = get(id), next = { ...cur, ...fields };
    // a decided intent never reopens: when another command decided it first (abandon, resolve), only facts are added
    if (!isOpen(cur) && isOpen(next)) next.state = cur.state;
    put(next);
    // the decision is on disk; a release that fails here stays pending and the next reserve() completes it
    if (!isOpen(next) && next.slot) try { settle(next.slot, next); } catch {}
    return next;
  }
  const unresolved = (from, chainId) => {
    const s = scan();
    if (s.problems.length) throw new SignerError("state", `refusing to send: ${s.problems.length} intent file${s.problems.length === 1 ? "" : "s"} in ${dir} cannot be read `
      + `(${s.problems[0].id}.json: ${s.problems[0].why}); one may hold an unresolved transaction from ${getAddress(from)}. Review it, then restore it or set it aside: `
      + `enclave --independent … signer quarantine ${s.problems[0].id}`, { unreadable: s.problems.map((p) => p.id) });
    return s.records.filter((r) => isOpen(r) && r.from.toLowerCase() === from.toLowerCase() && r.chainId === Number(chainId));
  };

  // ---- reservations ----
  const names = () => { try { return fs.readdirSync(dir); } catch (e) { if (e.code !== "ENOENT") throw e; return []; } };
  const SLOT_NAME = /^slot-(\d{1,16}-0x[0-9a-f]{40})\.(\d{8})\.(slot|released)$/;
  function gens(acct) {
    let top = 0, lastReleased = 0;
    const released = new Set();
    for (const n of names()) {
      const [, a, g, ext] = SLOT_NAME.exec(n) || [];
      if (a !== acct) continue;
      if (ext === "slot") top = Math.max(top, Number(g)); else { released.add(Number(g)); lastReleased = Math.max(lastReleased, Number(g)); }
    }
    // a marker without its generation would pre-release a future one: refuse instead of guessing
    if (lastReleased > top) throw new SignerError("state", `${dir} has a release marker for reservation ${acct}/${gen8(lastReleased)} but no such reservation; review it by hand`);
    return { next: top + 1, open: top > 0 && !released.has(top) ? `${acct}/${gen8(top)}` : null };
  }
  const slotFile = (key, ext) => { const m = KEY_RE.exec(String(key)); return m ? path.join(dir, `slot-${m[1]}.${m[2]}.${ext}`) : null; };
  function holder(key) {
    try { const h = JSON.parse(fs.readFileSync(slotFile(key, "slot"), "utf8")); if (h?.format === SLOT_FORMAT) return { pid: h.pid, host: h.host, createdAt: h.createdAt }; } catch {}
    return { unreadable: true };
  }
  const isReleased = (key) => fs.existsSync(slotFile(key, "released"));
  function markReleased(key, info) {
    const f = slotFile(key, "slot");
    if (!f || !fs.existsSync(f)) return false;   // only a generation that exists
    try { createExclusive(slotFile(key, "released"), JSON.stringify({ ...info, pid: process.pid, at: Date.now() }) + "\n"); }
    catch (e) { if (e.code !== "EEXIST") throw e; }
    return true;
  }
  /** Release `key` unless a readable open intent is still bound to it. */
  function settle(key, rec = null) {
    if (scan().records.some((r) => r.slot === key && isOpen(r))) return false;
    return markReleased(key, rec ? { intent: rec.id, why: `intent ${rec.state}` } : { intent: null, why: "the send recorded no open intent" });
  }
  function busy(key, open) {
    if (open) return new SignerError("busy", `refusing to send: intent ${open.id} (${open.state}, nonce ${open.nonce}) from ${getAddress(open.from)} is unresolved; `
      + `${resolveHint(open.id)} first (or attach/abandon it)`, { intent: open.id, reservation: key });
    const h = holder(key);
    const who = h.unreadable ? "its holder stopped while taking it" : `process ${h.pid} on ${h.host}, since ${new Date(h.createdAt).toISOString()}`;
    return new SignerError("busy", `refusing to send: another send from this account holds the signing reservation ${key} (${who}) and has recorded no intent yet. `
      + `If no enclave command for this account is still running, it stopped before broadcasting anything or asking a wallet to broadcast `
      + `(a signature it asked for was never journaled or sent): enclave --independent … signer release ${key}`, { reservation: key });
  }
  /** -> { key, assertHeld(), settle() }, or SignerError busy. Never waits, never takes over another holder's reservation. */
  function reserve(from, chainId) {
    const acct = `${Number(chainId)}-${String(from).toLowerCase()}`;
    if (!ACCT_RE.test(acct)) throw new SignerError("state", "not an account to reserve");
    for (let pass = 0; ; pass++) {
      const g = gens(acct);
      if (g.open) {
        const s = scan(), bound = s.records.filter((r) => r.slot === g.open);
        // its send recorded an intent and that intent is decided: only the release was lost (a crash) - finish it
        if (pass === 0 && !s.problems.length && bound.length && !bound.some(isOpen)) { markReleased(g.open, { intent: bound[0].id, why: `completed later: intent ${bound[0].state}` }); continue; }
        throw busy(g.open, bound.find(isOpen));
      }
      privateDir(dir);
      const key = `${acct}/${gen8(g.next)}`;
      try { createExclusive(slotFile(key, "slot"), JSON.stringify({ format: SLOT_FORMAT, key, pid: process.pid, host: os.hostname(), createdAt: Date.now() }) + "\n"); }
      catch (e) { if (e.code === "EEXIST") throw busy(key, null); throw e; }
      // assertHeld(rec) runs after the send records its intent and before that intent goes to the wallet or the RPCs: the
      // holder writes its intent, then checks for a release; a hand release checks for an intent, then writes. So of a
      // live holder and a send that follows a hand release, at most one goes on.
      return { key, settle: () => settle(key),
        assertHeld(rec = null) {
          if (!isReleased(key)) return;
          if (rec) update(rec.id, { state: "abandoned", abandonedFrom: rec.state, note: `reservation ${key} was released by hand first; nothing of this intent was sent` });
          throw new SignerError("busy", `the signing reservation ${key} was released by hand while this send was in progress; it stops here and broadcasts nothing`, { reservation: key });
        } };
    }
  }
  /** Open reservations, for `signer list`. */
  function reservations() {
    const accts = new Set(names().map((n) => SLOT_NAME.exec(n)?.[1]).filter(Boolean));
    const out = [], records = scan().records;
    for (const a of [...accts].sort()) {
      let g;
      try { g = gens(a); } catch (e) { out.push({ key: `${a}/?`, error: e.message }); continue; }
      if (!g.open) continue;
      const bound = records.filter((r) => r.slot === g.open);
      out.push({ key: g.open, intent: bound.find(isOpen)?.id || null, decided: bound.length && !bound.some(isOpen) ? bound[0].id : null, ...holder(g.open) });
    }
    return out;
  }
  /** `signer release <key>`: the explicit end of a reservation whose holder recorded no open intent (a stopped process). */
  function releaseReservation(key) {
    const f = slotFile(key, "slot");
    if (!f) throw new SignerError("state", "not a reservation (<chainId>-<0xaddress>/<8 digits>, as signer list prints it)");
    if (!fs.existsSync(f)) throw new SignerError("state", `no reservation ${key}`);
    if (isReleased(key)) throw new SignerError("state", `reservation ${key} is already released`);
    const s = scan();
    if (s.problems.length) throw new SignerError("state", `intent file ${s.problems[0].id}.json is unreadable and may belong to ${key}: review it (signer quarantine ${s.problems[0].id}) first`);
    const open = s.records.find((r) => r.slot === key && isOpen(r));
    if (open) throw new SignerError("state", `intent ${open.id} (${open.state}, nonce ${open.nonce}) holds ${key}: resolve, attach or abandon it instead`, { intent: open.id });
    const h = holder(key);
    markReleased(key, { intent: null, why: "released by hand" });
    return { key, holder: h, warning: `if ${h.unreadable ? "its holder" : `process ${h.pid} on ${h.host}`} is in fact still running, it stops before it broadcasts `
      + "or asks the wallet to; a signature it may have asked for was never journaled or sent. Unless an intent file of it was set aside with "
      + "quarantine, nothing of it is pending, and the next send takes the quorum's pending nonce" };
  }
  /** `signer quarantine <id>`: set an UNREADABLE intent file aside (kept, private) after review. Readable ones are settled. */
  function quarantine(id) {
    const f = fileOf(id);
    try { const rec = get(id); throw new SignerError("state", `intent ${id} is readable (${rec.state}): settle it with resolve, attach or abandon; quarantine is for unreadable files`); }
    catch (e) { if (!e.unreadable) throw e; }
    const to = `${f}.quarantined-${Date.now()}`;
    fs.renameSync(f, to);
    syncDir(dir);
    return { id, file: to, warning: "if it held an unresolved transaction, a wallet may still send it; the next send from that account takes the quorum's "
      + "pending nonce, so at most one of them can be mined. A reservation it held stays until signer release" };
  }
  return { dir, put, get, list, problems, create, update, unresolved, reserve, reservations, releaseReservation, quarantine };
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

async function decidedReceipt(chain, rec) {
  const s = await lookHash(chain, rec);
  if (!s.value.receipt) throw new SignerError("state", `intent ${rec.id} is recorded confirmed, but the quorum shows no receipt for ${rec.hash} at block ${s.blockNumber}`, { intent: rec.id });
  return { ...s.value.receipt, agreedBlock: s.blockNumber, agreeing: s.agreeing, intent: rec.id, adjusted: rec.adjusted || [] };
}

/** Wait for an intent with a hash to be mined and agreed: the receipt (sendQuorumTx-shaped) or throws. */
export async function confirmIntent(chain, journal, id, { timeoutMs = 180000, pollMs = 1000, now = Date.now, sleep = (ms) => new Promise((r) => setTimeout(r, ms)) } = {}) {
  const deadline = now() + timeoutMs;
  let last = "no quorum yet";
  for (;;) {
    try {
      const r = await resolveIntent(chain, journal, id);
      if (r.state === "confirmed") return r.receipt || await decidedReceipt(chain, r.intent);   // another command may have confirmed it
      if (!isOpen(r.intent) && !r.error && r.state !== "replaced")
        throw new SignerError("state", `intent ${id} was ${r.state} meanwhile by another command; see signer show ${id}`, { intent: id, decided: true });
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
    const open = journal.unresolved(address, chainId);   // open intents of this account; throws while any intent file is unreadable
    if (open.length) throw new SignerError("busy", `refusing to send: intent ${open[0].id} (${open[0].state}, nonce ${open[0].nonce}) from ${address} is unresolved; `
      + `${resolveHint(open[0].id)} first (or attach/abandon it)`, { intent: open[0].id });
  }
  const record = (pre, extra) => journal.create({ from: address, chainId, to: getAddress(extra.to), data: String(extra.data || "0x").toLowerCase(),
    value: BigInt(extra.value || 0n), nonce: pre.nonce, gas: pre.gas, maxFeePerGas: pre.maxFeePerGas, maxPriorityFeePerGas: pre.maxPriorityFeePerGas,
    capWei: pre.capWei, gasCap: BigInt(extra.gasCap ?? 15_000_000n), startBlock: pre.startBlock, feePolicy, signer: label, mode: extra.mode, state: extra.state, hash: null, slot: extra.slot.key });
  const sendParams = (rec) => ({ from: address, to: rec.to, value: hex(rec.value), data: rec.data, nonce: hex(rec.nonce), gas: hex(rec.gas),
    maxFeePerGas: hex(rec.maxFeePerGas), maxPriorityFeePerGas: hex(rec.maxPriorityFeePerGas), chainId: hex(chainId), type: "0x2" });

  async function walletSend(chain, o) {
    const pre = await preflight(chain, { from: address, ...o });
    await probe();
    await walletChain();
    const rec = record(pre, { ...o, mode: "wallet-send", state: "requested" });
    o.slot.assertHeld(rec);
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
    o.slot.assertHeld(rec);
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
    // one send in flight per journal and account, across processes: reserved before the pending nonce is read or the
    // wallet is asked anything, held while this send's intent is open, released once it is decided (by any command)
    const slot = journal.reserve(address, chainId);
    try {
      assertFree();   // again under the reservation
      return await sendReserved(chain, { to, data, value, maxFeeGwei, gasCap, timeoutMs, pollMs, slot }, note, l);
    } finally {
      try { slot.settle(); } catch (e) { log(`could not release reservation ${slot.key} (${clip(e.message)}); sends from ${address} stay refused until: signer release ${slot.key}`); }
    }
  }
  async function sendReserved(chain, o, note, l) {
    const { to, data, value, maxFeeGwei, gasCap, timeoutMs, pollMs, slot } = o;
    if (mode === "handoff") return handoff(chain, o);
    if (mode === "wallet-send") return walletSend(chain, o);
    let rec = null;
    const signing = { address, signTransaction: async (tx) => {
      slot.assertHeld();
      const raw = await signTransaction(tx);
      const t = intendedTx(tx, chainId);
      const r = journal.create({ from: address, chainId, to: t.to, data: t.data, value: t.value, nonce: t.nonce, gas: t.gas, maxFeePerGas: t.maxFeePerGas,
        maxPriorityFeePerGas: t.maxPriorityFeePerGas, startBlock: chain.lastBlock ?? 0n, signer: label, mode: "sign", state: "signed", raw, hash: keccak256(raw), slot: slot.key });
      slot.assertHeld(r);
      rec = r;
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

/** Close an unresolved intent by hand. The wallet might still send it; the next send reuses its nonce, so at most one mines.
 *  Its reservation is released with it. */
export function abandonIntent(journal, id) {
  const rec = journal.get(id);
  if (!isOpen(rec)) throw new SignerError("state", `intent ${id} is ${rec.state}`);
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
  const usage = "usage: enclave --independent … signer probe | list | show <id> | resolve <id> | attach <id> <0xhash> | rebroadcast <id> | abandon <id> "
    + "| release <reservation> | quarantine <id>";
  const id = rest[0];
  if (sub === "probe") {
    if (!ctx.signer) throw new SignerError("state", "signer probe needs --signer URL --from 0x…");
    const p = await ctx.signer.probe();
    return out(p, `${p.label}: ${p.protocol === "clef" ? "Clef (account_* API)" : "EIP-1193 JSON-RPC"}; offers ${p.address}${p.walletChainId ? `; wallet chain ${p.walletChainId}` : ""}. `
      + "Whether it signs without broadcasting is learned at the first transaction (nothing is signed by a probe).");
  }
  if (sub === "list") {
    const l = journal.list(), held = journal.reservations(), bad = journal.problems();
    const text = [...l.map(show),
      ...held.map((h) => `reservation ${h.key}  ${h.error ? `UNREADABLE: ${h.error}` : h.intent ? `held by intent ${h.intent}`
        : h.decided ? `intent ${h.decided} is decided; the next send completes the release`
        : `held with no intent recorded (${h.unreadable ? "holder unreadable" : `process ${h.pid} on ${h.host}`}); if that process is gone: signer release ${h.key}`}`),
      ...bad.map((p) => `UNREADABLE ${p.id}.json (${p.why}): every send from this journal is refused; review it, then restore it or: signer quarantine ${p.id}`)];
    return out({ intents: l.map(({ raw, ...r }) => r), reservations: held, unreadable: bad.map(({ id: i, why }) => ({ id: i, why })) }, text.length ? text.join("\n") : "no signer intents");
  }
  if (!id && sub !== undefined) throw new SignerError("state", usage);
  if (sub === "show") { const { raw, ...r } = journal.get(id); return out(r, Object.entries(r).map(([k, v]) => `${k.padEnd(22)} ${typeof v === "object" ? JSON.stringify(v, (_k, x) => typeof x === "bigint" ? String(x) : x) : String(v)}`).join("\n")); }
  if (sub === "resolve") { const r = await resolveIntent(ctx.chain, journal, id); const { raw, ...i } = r.intent; return out({ ...r, intent: i }, `${show(i)}${r.note ? `\n${r.note}` : ""}${r.error ? `\n${r.error}` : ""}`); }
  if (sub === "attach") { const r = await attachHash(ctx.chain, journal, id, rest[1], ctx.waitOpts); return out(r, `confirmed: ${r.transactionHash} in block ${r.blockNumber}, by ${r.agreeing} RPCs${r.adjusted?.length ? ` (the wallet changed ${r.adjusted.join(", ")})` : ""}`); }
  if (sub === "rebroadcast") { const r = await rebroadcast(ctx.chain, journal, id, ctx.waitOpts); return out(r, `confirmed: ${r.transactionHash} in block ${r.blockNumber}, by ${r.agreeing} RPCs`); }
  if (sub === "abandon") { const r = abandonIntent(journal, id); return out(r, `intent ${id} abandoned. ${r.warning}`); }
  if (sub === "release") { const r = journal.releaseReservation(id); return out(r, `reservation ${id} released. ${r.warning}`); }
  if (sub === "quarantine") { const r = journal.quarantine(id); return out(r, `intent file ${id}.json set aside as ${r.file}. ${r.warning}`); }
  throw new SignerError("state", usage);
}
