// Quorum reads of Base, the publisher's rule in JavaScript: every endpoint is asked; the target is the quorum-th
// highest head minus the confirmations; quorum endpoints must return the identical (number, hash, timestamp); every
// state read is bound to that hash (EIP-1898, requireCanonical) and needs quorum identical answers. The block's age is
// judged when the reads END. Nothing here signs or sends.
import { createRequire } from "node:module";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { REPO } from "./paths.mjs";

// the enclave repository's pinned viem (package-lock.json), not a new dependency
export const viem = createRequire(join(REPO, "package.json"))("viem");
// the repository's ONE rule for telling RPC peers apart (network/rpc-identity.mjs): a public host is one vote whatever
// its port, path, case or trailing dot; loopback spellings on one port are one local listener
export const { rpcEndpoint } = await import(pathToFileURL(join(REPO, "network/rpc-identity.mjs")).href);

/**
 * The publisher's own grammar (ipns-publisher src/anchor.rs parse_rpc_url) is stricter than the JS URL policy: no
 * query, percent-escape or backslash either. A list the publisher would refuse, or one that counts a provider twice,
 * is refused here too, so a plan never emits a config the publisher rejects. -> the vote identities.
 */
export function publisherRpcIdentities(rpcs, quorum) {
  if (!Array.isArray(rpcs) || rpcs.length < 1 || rpcs.length > 16) throw new Error("publisher rpcs: 1..16 URLs");
  const ids = rpcs.map((u, i) => {
    if (/[?%#@\\\s]/.test(String(u)) || !/^[\x21-\x7e]+$/.test(String(u))) throw new Error(`publisher rpcs[${i}]: no query, escapes, credentials, fragment or spaces`);
    return rpcEndpoint(u).identity;
  });
  if (new Set(ids).size !== ids.length) throw new Error("publisher rpcs name one provider twice (same host whatever the port or path)");
  if (!(quorum >= 2 && quorum <= ids.length)) throw new Error("publisher quorum must be 2..len(rpcs)");
  return ids;
}

let nextId = 1;
export async function rpcCall(url, method, params, timeoutMs = 15_000) {
  const t0 = Date.now();
  try {
    const r = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: nextId++, method, params }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const j = JSON.parse(await r.text());
    if (j.error) return { ok: false, ms: Date.now() - t0, error: `${j.error.code}: ${String(j.error.message).slice(0, 160)}` };
    return { ok: true, ms: Date.now() - t0, result: j.result };
  } catch (e) {
    return { ok: false, ms: Date.now() - t0, error: String(e?.cause?.code ?? e?.message ?? e).slice(0, 160) };
  }
}

export class Quorum {
  constructor({ rpcs, chainId, quorum = 2, confirmations = 6, maxBlockAgeSecs = 120 }) {
    const eps = rpcs.map((u) => rpcEndpoint(u));
    if (new Set(eps.map((e) => e.identity)).size !== eps.length) throw new Error("rpcs repeat a provider (one host whatever the port or path)");
    const ids = eps.map((e) => e.label); // safe display: scheme, canonical host, port (never the path or a key)
    if (quorum < 2 || quorum > rpcs.length) throw new Error("quorum must be 2..len(rpcs)");
    Object.assign(this, { rpcs, ids, chainId, quorum, confirmations, maxBlockAgeSecs, outcomes: {} });
  }
  note(i, what, r) { (this.outcomes[this.ids[i]] ??= {})[what] = r.ok ? "ok" : r.error; }

  /** The agreed block; throws without quorum. */
  async block() {
    const heads = [];
    for (let i = 0; i < this.rpcs.length; i++) {
      const c = await rpcCall(this.rpcs[i], "eth_chainId", []);
      this.note(i, "eth_chainId", c);
      if (!c.ok || Number(BigInt(c.result)) !== this.chainId) { heads.push(null); if (c.ok) this.outcomes[this.ids[i]].eth_chainId = `wrong chain ${Number(BigInt(c.result))}`; continue; }
      const h = await rpcCall(this.rpcs[i], "eth_blockNumber", []);
      this.note(i, "eth_blockNumber", h);
      heads.push(h.ok ? Number(BigInt(h.result)) : null);
    }
    const hs = heads.filter((x) => x != null).sort((a, b) => b - a);
    if (hs.length < this.quorum) throw new Error(`only ${hs.length} of the required ${this.quorum} endpoints answered the head`);
    const target = hs[this.quorum - 1] - this.confirmations;
    const groups = new Map();
    this.answering = [];
    for (let i = 0; i < this.rpcs.length; i++) {
      if (heads[i] == null) continue;
      const b = await rpcCall(this.rpcs[i], "eth_getBlockByNumber", ["0x" + target.toString(16), false]);
      this.note(i, "eth_getBlockByNumber", b);
      if (!b.ok || !b.result) continue;
      const key = `${Number(BigInt(b.result.number))}|${b.result.hash}|${Number(BigInt(b.result.timestamp))}`;
      groups.set(key, [...(groups.get(key) ?? []), i]);
    }
    const winners = [...groups].filter(([, v]) => v.length >= this.quorum);
    if (winners.length !== 1) throw new Error(winners.length ? "two blocks each reached the quorum" : `no ${this.quorum} endpoints agree on block ${target}`);
    const [key, members] = winners[0];
    const [number, hash, timestamp] = key.split("|");
    this.agreed = { number: Number(number), hash, timestamp: Number(timestamp) };
    this.members = members;
    return this.agreed;
  }

  async #agree(method, params, what) {
    const answers = new Map();
    for (const i of this.members) {
      const r = await rpcCall(this.rpcs[i], method, params);
      this.note(i, what, r);
      if (r.ok) answers.set(JSON.stringify(r.result), [...(answers.get(JSON.stringify(r.result)) ?? []), i]);
    }
    const winners = [...answers].filter(([, v]) => v.length >= this.quorum);
    if (winners.length !== 1) throw new Error(`no ${this.quorum} endpoints returned the same ${what}`);
    return JSON.parse(winners[0][0]);
  }
  at() { return { blockHash: this.agreed.hash, requireCanonical: true }; }
  call(to, data, what = `eth_call ${to}`) { return this.#agree("eth_call", [{ to, data }, this.at()], what); }
  code(addr) { return this.#agree("eth_getCode", [addr, this.at()], `eth_getCode ${addr}`); }
  nonce(addr) { return this.#agree("eth_getTransactionCount", [addr, this.at()], `nonce ${addr}`).then((x) => Number(BigInt(x))); }
  balance(addr) { return this.#agree("eth_getBalance", [addr, this.at()], `balance ${addr}`).then((x) => BigInt(x)); }

  /** Typed call through a viem ABI. */
  async read(to, abi, functionName, args = []) {
    const data = viem.encodeFunctionData({ abi, functionName, args });
    const raw = await this.call(to, data, `${functionName}@${to}`);
    return viem.decodeFunctionResult({ abi, functionName, data: raw });
  }

  /** Close the read: the agreed block must still be fresh now (the clock read AFTER the last answer). */
  close() {
    const now = Math.floor(Date.now() / 1000);
    const age = now - this.agreed.timestamp;
    if (age > this.maxBlockAgeSecs) throw new Error(`stale: block ${this.agreed.number} is ${age}s old at the end of the reads`);
    if (this.agreed.timestamp > now + 120) throw new Error("block timestamp ahead of the local clock");
    return { ...this.agreed, ageAtEndSecs: age, readEndedAt: new Date(now * 1000).toISOString(), agreeing: this.members.map((i) => this.ids[i]), outcomes: this.outcomes };
  }
}

/** Fee inputs (not authority: an estimate only): the median of the providers' answers. */
export async function feeEstimate(rpcs) {
  const prices = [];
  const bases = [];
  for (const u of rpcs) {
    const g = await rpcCall(u, "eth_gasPrice", []);
    if (g.ok) prices.push(BigInt(g.result));
    const b = await rpcCall(u, "eth_getBlockByNumber", ["latest", false]);
    if (b.ok && b.result?.baseFeePerGas) bases.push(BigInt(b.result.baseFeePerGas));
  }
  const med = (xs) => xs.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))[Math.floor(xs.length / 2)] ?? null;
  return { gasPriceWei: med(prices), baseFeeWei: med(bases), samples: prices.length };
}

const SECRETISH = /key|secret|token|passw|seed|private|mnemonic|auth|credential/i;
const ENV_REF = /^\$\{?[A-Za-z_][A-Za-z0-9_]*\}?$/;
/**
 * A config object with every secret-like value removed: what can be shown and stored. A `$NAME` reference is a name,
 * not a secret, and is kept; an inline value under a secret-like key is reported only as present + its length.
 */
export function redactConfig(v, path = "") {
  if (Array.isArray(v)) return v.map((x, i) => redactConfig(x, `${path}[${i}]`));
  if (v && typeof v === "object") {
    return Object.fromEntries(Object.entries(v).map(([k, x]) => {
      const p = path ? `${path}.${k}` : k;
      if (SECRETISH.test(k) && typeof x === "string") {
        if (x === "") return [k, { redacted: "empty" }];
        if (ENV_REF.test(x)) return [k, { envReference: x }];
        return [k, { redacted: "INLINE VALUE PRESENT (not shown)", length: x.length }];
      }
      if (SECRETISH.test(k) && x && typeof x === "object") return [k, { redacted: "object under a secret-like key (not shown)" }];
      return [k, redactConfig(x, p)];
    }));
  }
  if (typeof v === "string" && v.length > 40 && /^[0-9a-fA-F]+$/.test(v)) return { redacted: "long hex string (not shown)", length: v.length };
  return v;
}
