// windows/node/payout.mjs -- where this box's USDC earnings go, and when.
//
// The ledger keeps a runner's earnings against its OPERATOR key (EnclaveDeployments.earned6), and only that key can
// withdraw them, to any address it names (withdrawEarnings(to)). The key lives on this box, so this node is what pays
// the box owner. Where to is the owner's PAYOUT WALLET, and it takes two agreeing parties to name one:
//
//   - the WALLET declares itself, on chain, for this box: EnclaveRegistry.setPayoutWallet(id) records msg.sender, so
//     only a wallet can name itself (the site's payout page sends it from the owner's wallet, over WalletConnect or an
//     extension). But ANY wallet can do that for ANY box, and the last one wins - on its own it proves nothing about
//     who owns the box;
//   - the box OWNER confirms that exact address here, through the local hosting API (the tray), which only an
//     administrator of this machine or the configured tray user can reach.
//
// Earnings are paid only to a wallet that is BOTH confirmed here AND still declared on chain, re-read just before every
// payout. A stranger overwriting the declaration stops payouts (the tray says so) and gains nothing: the earnings stay
// in the ledger against the operator until the owner's wallet declares itself again. A confirmation the chain does not
// agree with, or a chain that cannot be read, pays nobody.
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

const ZERO = "0x0000000000000000000000000000000000000000";
const isAddr = (a) => typeof a === "string" && /^0x[0-9a-fA-F]{40}$/.test(a);
const same = (a, b) => isAddr(a) && isAddr(b) && a.toLowerCase() === b.toLowerCase();
const usd = (v6) => `$${(Number(v6) / 1e6).toFixed(2)}`;

export const DEFAULT_MIN_PAYOUT6 = 1_000_000n;          // $1: below it the gas is not worth spending
export const MIN_GAS_WEI = 200_000_000_000_000n;          // 0.0002 ETH: claims and renewals need the gas more
const CACHE_MS = 60_000;                                  // the tray polls every 10 s; the chain is read once a minute

/** The state file: { confirmed, confirmedAt, history: [{ tx, to, amount6, at }] }; absent or unreadable -> nothing confirmed. */
export function loadPayoutState(file) {
  try {
    const o = JSON.parse(fs.readFileSync(file, "utf8"));
    return { confirmed: isAddr(o.confirmed) ? o.confirmed : null, confirmedAt: o.confirmedAt || null,
             history: Array.isArray(o.history) ? o.history.filter((h) => h && typeof h.tx === "string") : [] };
  } catch { return { confirmed: null, confirmedAt: null, history: [] }; }
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
 * readEnclave(id) -> { payoutWallet }, earnedOf(addr) -> bigint, withdrawEarnings(to) -> txHash } (chain.mjs).
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
    const [entry, earned6, gasWei] = await Promise.all([this.chain.readEnclave(this.enclaveId), this.chain.earnedOf(operator),
                                                        this.chain.operatorBalance()]);
    const declared = entry && isAddr(entry.payoutWallet) && entry.payoutWallet !== ZERO ? entry.payoutWallet : null;
    this.cache = { at: this.now(), operator, declared, earned6: BigInt(earned6), gasWei: BigInt(gasWei) };
    return this.cache;
  }

  /** Who would be paid right now, or why nobody is. */
  #payee(c) {
    const confirmed = this.state.confirmed;
    if (!confirmed) return { to: null, why: c.declared ? `${c.declared} is declared on chain for this box but not confirmed here yet` : "no payout wallet is set" };
    if (!c.declared) return { to: null, why: `the confirmed wallet ${confirmed} no longer declares itself on chain for this box` };
    if (!same(c.declared, confirmed)) return { to: null, why: `the chain now names ${c.declared}, not the confirmed ${confirmed}: payouts wait until they agree` };
    if (same(confirmed, c.operator)) return { to: null, why: "the payout wallet is this box's own operator key, which already holds the earnings" };
    return { to: confirmed, why: null };
  }

  /** GET /v1/local/hosting/earnings */
  async status() {
    const paid = this.state.history.reduce((a, h) => a + BigInt(h.amount6 || 0), 0n);
    const base = { enclaveId: this.enclaveId, confirmed: this.state.confirmed, minPayout6: String(this.minPayout6),
                   paidOut6: String(paid), history: this.state.history.slice(-10).reverse(), paying: this.paying, lastError: this.lastError };
    let c;
    try { c = await this.#read(); }
    catch (e) { return { ...base, readable: false, why: `the chain could not be read: ${e.shortMessage || e.message}` }; }
    const p = this.#payee(c);
    return { ...base, readable: true, operator: c.operator, declared: c.declared, earned6: String(c.earned6),
             gasWei: String(c.gasWei), payTo: p.to, why: p.why };
  }

  /** The owner confirms the wallet that declared itself on chain (or clears with null). Only the declared one. */
  async confirm(address) {
    if (address === null) {
      this.state = { ...this.state, confirmed: null, confirmedAt: new Date(this.now()).toISOString() };
      savePayoutState(this.file, this.state);
      this.log("payout wallet cleared by the owner of this box: earnings stay in the ledger until one is set");
      return this.status();
    }
    if (!isAddr(address)) throw Object.assign(new Error("address must be 0x and 40 hex digits, or null"), { status: 400 });
    const c = await this.#read(true);
    if (!same(c.declared, address))
      throw Object.assign(new Error(`${address} has not declared itself on chain for this box (the chain names ${c.declared || "nobody"}):`
        + " connect that wallet on the payout page and send its declaration first"), { status: 409, code: "not_declared" });
    this.state = { ...this.state, confirmed: c.declared, confirmedAt: new Date(this.now()).toISOString() };
    savePayoutState(this.file, this.state);
    this.log(`payout wallet confirmed by the owner of this box: ${c.declared}`);
    return this.status();
  }

  /**
   * Pay what the ledger holds for this operator to the payout wallet, if there is one both sides agree on, it is at
   * least the minimum (any amount when `now`), and the operator has gas to spare. -> { paid, tx?, amount6?, why? }
   */
  async payout({ now = false } = {}) {
    if (this.paying) return { paid: false, why: "a payout is already being sent" };
    this.paying = true;
    try {
      const c = await this.#read(true);                  // fresh: the declaration is re-read right before paying
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
