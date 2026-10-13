// windows/node/payout.mjs -- where this box's USDC earnings go, and when.
//
// The ledger keeps a runner's earnings against its OPERATOR key (EnclaveDeployments.earned6), and only that key can
// withdraw them, to any address it names (withdrawEarnings(to)). The key lives on this box, so this node is what pays
// the box owner. Where to is the owner's PAYOUT WALLET: an address the owner pastes into the tray on this machine (the
// local hosting API, which only an administrator of this machine or the configured tray user can reach). It is checked
// for FORMAT only (0x and 40 hex digits, not the zero address); nothing is declared on chain and no wallet connects. It
// changes whenever the owner pastes another, and clearing it pays nobody: earnings wait in the ledger.
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

const ZERO = "0x0000000000000000000000000000000000000000";
export const isWalletAddress = (a) => typeof a === "string" && /^0x[0-9a-fA-F]{40}$/.test(a) && a.toLowerCase() !== ZERO;
const same = (a, b) => isWalletAddress(a) && isWalletAddress(b) && a.toLowerCase() === b.toLowerCase();
const usd = (v6) => `$${(Number(v6) / 1e6).toFixed(2)}`;

export const DEFAULT_MIN_PAYOUT6 = 1_000_000n;          // $1: below it the gas is not worth spending
export const MIN_GAS_WEI = 200_000_000_000_000n;          // 0.0002 ETH: claims and renewals need the gas more
const CACHE_MS = 60_000;                                  // the tray polls every 10 s; the chain is read once a minute

/** The state file: { wallet, setAt, history: [{ tx, to, amount6, at }] }; absent or unreadable -> no wallet. A file from
 *  the earlier on-chain declaration scheme keeps its confirmed wallet. */
export function loadPayoutState(file) {
  try {
    const o = JSON.parse(fs.readFileSync(file, "utf8"));
    const wallet = isWalletAddress(o.wallet) ? o.wallet : isWalletAddress(o.confirmed) ? o.confirmed : null;
    return { wallet, setAt: o.setAt || o.confirmedAt || null,
             history: Array.isArray(o.history) ? o.history.filter((h) => h && typeof h.tx === "string") : [] };
  } catch { return { wallet: null, setAt: null, history: [] }; }
}
export function savePayoutState(file, st) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${crypto.randomBytes(4).toString("hex")}.tmp`;
  try {
    const fd = fs.openSync(tmp, "wx", 0o644);
    try { fs.writeFileSync(fd, JSON.stringify(st, null, 1) + "\n"); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    fs.renameSync(tmp, file);
  } catch (e) { try { fs.unlinkSync(tmp); } catch {} throw e; }
}

/**
 * Payouts({ file, enclaveId, chain, log, minPayout6 }) where `chain` is { operatorAddress(), operatorBalance(),
 * earnedOf(addr) -> bigint, withdrawEarnings(to) -> txHash } (chain.mjs).
 */
export class Payouts {
  constructor({ file, enclaveId, chain, log = () => {}, minPayout6 = DEFAULT_MIN_PAYOUT6, now = () => Date.now() }) {
    Object.assign(this, { file, enclaveId, chain, log, minPayout6: BigInt(minPayout6), now });
    this.state = loadPayoutState(file);
    this.cache = null; this.paying = false; this.lastError = null;
  }

  /** The chain's side, cached for a minute unless `fresh`. Throws when it cannot be read. */
  async #read(fresh = false) {
    if (!fresh && this.cache && this.now() - this.cache.at < CACHE_MS) return this.cache;
    const operator = this.chain.operatorAddress();
    if (!operator) throw new Error("no operator key on this box");
    const [earned6, gasWei] = await Promise.all([this.chain.earnedOf(operator), this.chain.operatorBalance()]);
    this.cache = { at: this.now(), operator, earned6: BigInt(earned6), gasWei: BigInt(gasWei) };
    return this.cache;
  }

  /** Who would be paid right now, or why nobody is. */
  #payee(c) {
    const w = this.state.wallet;
    if (!w) return { to: null, why: "no payout wallet is set" };
    if (c && same(w, c.operator)) return { to: null, why: "the payout wallet is this box's own operator key, which already holds the earnings" };
    return { to: w, why: null };
  }

  /** GET /v1/local/hosting/earnings */
  async status() {
    let c = null, unreadable = null;
    try { c = await this.#read(); } catch (e) { unreadable = e.shortMessage || e.message; }
    const paid = this.state.history.reduce((a, h) => a + BigInt(h.amount6 || 0), 0n);
    const base = { enclaveId: this.enclaveId, wallet: this.state.wallet, setAt: this.state.setAt,
                   minPayout6: String(this.minPayout6), paidOut6: String(paid), history: this.state.history.slice(-10).reverse(),
                   paying: this.paying, lastError: this.lastError || null };
    if (!c) return { ...base, readable: false, why: `the chain could not be read: ${unreadable}` };
    const p = this.#payee(c);
    return { ...base, readable: true, operator: c.operator, earned6: String(c.earned6), gasWei: String(c.gasWei), payTo: p.to, why: p.why };
  }

  /** The owner sets the payout wallet on this machine. Format only: 0x and 40 hex digits, not the zero address. */
  async set(address) {
    const a = String(address ?? "").trim();
    if (!isWalletAddress(a))
      throw Object.assign(new Error("that is not a wallet address: it is 0x followed by 40 hexadecimal characters (0-9, a-f)"), { status: 400, code: "bad_address" });
    this.state = { ...this.state, wallet: a, setAt: new Date(this.now()).toISOString() };
    savePayoutState(this.file, this.state);
    this.cache = null;
    this.log(`payout wallet set on this machine: ${a}`);
    return this.status();
  }

  /** The owner stops paying anyone: earnings stay in the ledger. */
  async clear() {
    this.state = { ...this.state, wallet: null, setAt: new Date(this.now()).toISOString() };
    savePayoutState(this.file, this.state);
    this.cache = null;
    this.log("payout wallet cleared by the owner of this box: earnings stay in the ledger until one is set");
    return this.status();
  }

  /**
   * Pay what the ledger holds for this operator to the payout wallet, if one is set, it is at least the minimum (any
   * amount when `now`), and the operator has gas to spare. -> { paid, tx?, amount6?, why? }
   */
  async payout({ now = false } = {}) {
    if (this.paying) return { paid: false, why: "a payout is already being sent" };
    this.paying = true;
    try {
      const c = await this.#read(true);
      const p = this.#payee(c);
      if (!p.to) return { paid: false, why: p.why };
      if (c.earned6 === 0n || (!now && c.earned6 < this.minPayout6))
        return { paid: false, why: `${usd(c.earned6)} earned; paid out automatically from ${usd(this.minPayout6)}` };
      if (c.gasWei < MIN_GAS_WEI) return { paid: false, why: "the operator key is low on gas for Base; renewals come first" };
      const tx = await this.chain.withdrawEarnings(p.to);
      const rec = { tx, to: p.to, amount6: String(c.earned6), at: new Date(this.now()).toISOString() };
      this.state = { ...this.state, history: [...this.state.history, rec].slice(-200) };
      savePayoutState(this.file, this.state);
      this.cache = null; this.lastError = null;
      this.log(`paid out ${usd(c.earned6)} of earnings to ${p.to} (tx ${tx})`);
      return { paid: true, tx, amount6: rec.amount6, to: p.to };
    } catch (e) {
      this.lastError = e.shortMessage || e.message;
      this.log(`payout failed: ${this.lastError}`);
      return { paid: false, why: this.lastError };
    } finally { this.paying = false; }
  }
}
