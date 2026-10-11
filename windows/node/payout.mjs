// windows/node/payout.mjs -- where this box's USDC earnings go, and when.
//
// The ledger keeps a runner's earnings against its OPERATOR key (EnclaveDeployments.earned6), and only that key can
// withdraw them, to any address it names (withdrawEarnings(to)). The key lives on this box, so this node is what pays
// the box owner. Where to is the owner's PAYOUT WALLET, changed FROM THIS MACHINE, at any time while it hosts:
//
//   - the owner starts the change here (the tray asks the local hosting API, which only an administrator of this
//     machine or the configured tray user can reach): the node issues a one-time CODE, good for 30 minutes, and the
//     tray opens the site's payout page with it in the URL fragment (never sent to a server);
//   - the page sends EnclaveRegistry.setPayoutWallet(id) from the owner's wallet (WalletConnect or an extension) with
//     the code appended after the arguments. The contract records msg.sender and ignores trailing calldata, so the
//     declaration is the usual one - but the code is now on chain, in the transaction that made it;
//   - this node sees the box's new declaration (PayoutWalletSet), reads that transaction's calldata, and when it carries
//     the code this machine issued, adopts the wallet as the payout wallet on its own. No click.
//
// ANY wallet can declare itself for ANY box (last one wins), so a declaration WITHOUT this machine's code is never
// adopted: payouts wait, the tray says the wallet was changed from somewhere else, and the earnings stay in the ledger
// against the operator. The declaration is re-read right before every payout; a chain that cannot be read pays nobody.
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

const ZERO = "0x0000000000000000000000000000000000000000";
const isAddr = (a) => typeof a === "string" && /^0x[0-9a-fA-F]{40}$/.test(a);
const same = (a, b) => isAddr(a) && isAddr(b) && a.toLowerCase() === b.toLowerCase();
const usd = (v6) => `$${(Number(v6) / 1e6).toFixed(2)}`;

export const DEFAULT_MIN_PAYOUT6 = 1_000_000n;          // $1: below it the gas is not worth spending
export const MIN_GAS_WEI = 200_000_000_000_000n;          // 0.0002 ETH: claims and renewals need the gas more
export const CODE_TTL_MS = 30 * 60_000;                   // a change started here must land within 30 minutes
export const SET_PAYOUT_SELECTOR = "d6a60cad";            // setPayoutWallet(bytes32)
export const PAYOUT_PAGE = "https://enclave.host/payout";
const isCode = (c) => typeof c === "string" && /^0x[0-9a-f]{64}$/.test(c);
/** The calldata a declaration made from this machine carries: setPayoutWallet(id) followed by the code (hex, no 0x). */
export const declarationCalldata = (id, code) => (SET_PAYOUT_SELECTOR + String(id).slice(2) + String(code).slice(2)).toLowerCase();
const CACHE_MS = 60_000;                                  // the tray polls every 10 s; the chain is read once a minute

/** The state file: { confirmed, confirmedAt, confirmedTx, pending: { code, fromBlock, expiresAt } | null,
 *  history: [{ tx, to, amount6, at }] }; absent or unreadable -> nothing confirmed, nothing pending. */
export function loadPayoutState(file) {
  try {
    const o = JSON.parse(fs.readFileSync(file, "utf8"));
    const p = o.pending;
    return { confirmed: isAddr(o.confirmed) ? o.confirmed : null, confirmedAt: o.confirmedAt || null, confirmedTx: o.confirmedTx || null,
             pending: p && isCode(p.code) && /^\d+$/.test(String(p.fromBlock)) && Number.isFinite(p.expiresAt) ? p : null,
             history: Array.isArray(o.history) ? o.history.filter((h) => h && typeof h.tx === "string") : [] };
  } catch { return { confirmed: null, confirmedAt: null, confirmedTx: null, pending: null, history: [] }; }
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
 * readEnclave(id) -> { payoutWallet }, earnedOf(addr) -> bigint, withdrawEarnings(to) -> txHash, blockNumber(),
 * payoutDeclarations(id, fromBlock) -> [{ wallet, txHash }], txInput(hash) -> calldata } (chain.mjs).
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
    // a failed look for the declaration is said, never fatal: the next read looks again
    try { await this.#adopt(this.cache); this.adoptError = null; }
    catch (e) { this.adoptError = e.shortMessage || e.message; }
    return this.cache;
  }

  /**
   * A change started on this machine: adopt the declared wallet once the transaction that declared it is found to carry
   * this machine's code. Only the wallet the chain names NOW, and only through a declaration made since the code was
   * issued; the code is spent when it is used and dropped when it expires.
   */
  async #adopt(c) {
    const p = this.state.pending;
    if (!p) return;
    if (this.now() > p.expiresAt) {
      this.state = { ...this.state, pending: null }; savePayoutState(this.file, this.state);
      this.log("the payout wallet change started from this machine expired before a declaration carrying its code arrived");
      return;
    }
    if (!c.declared || same(c.declared, this.state.confirmed)) return;
    const want = declarationCalldata(this.enclaveId, p.code);
    const made = (await this.chain.payoutDeclarations(this.enclaveId, BigInt(p.fromBlock))).filter((d) => same(d.wallet, c.declared));
    for (const d of made.reverse()) {                                      // the newest declaration by that wallet first
      const input = String(await this.chain.txInput(d.txHash)).toLowerCase().replace(/^0x/, "");
      if (!input.includes(want)) continue;                                 // a contract wallet nests it; an EOA starts with it
      this.state = { ...this.state, confirmed: c.declared, confirmedAt: new Date(this.now()).toISOString(), confirmedTx: d.txHash, pending: null };
      savePayoutState(this.file, this.state);
      this.log(`payout wallet changed from this machine: ${c.declared} (declared in ${d.txHash}, carrying this machine's code)`);
      return;
    }
  }

  /** Who would be paid right now, or why nobody is. */
  #payee(c) {
    const confirmed = this.state.confirmed;
    const waiting = this.state.pending ? "; waiting for the declaration started from this machine" : "";
    if (!confirmed) return { to: null, why: (c.declared ? `${c.declared} is declared on chain for this box, but not from this machine` : "no payout wallet is set") + waiting };
    if (!c.declared) return { to: null, why: `the payout wallet ${confirmed} no longer declares itself on chain for this box${waiting}` };
    if (!same(c.declared, confirmed))
      return { to: null, why: `the chain now names ${c.declared}, which was not set from this machine: payouts wait until the wallet is changed here${waiting}` };
    if (same(confirmed, c.operator)) return { to: null, why: "the payout wallet is this box's own operator key, which already holds the earnings" };
    return { to: confirmed, why: null };
  }

  /** GET /v1/local/hosting/earnings. The chain is read FIRST: reading it is what adopts a change made from here. */
  async status() {
    let c = null, unreadable = null;
    try { c = await this.#read(); } catch (e) { unreadable = e.shortMessage || e.message; }
    const paid = this.state.history.reduce((a, h) => a + BigInt(h.amount6 || 0), 0n);
    const pending = this.state.pending ? { expiresAt: new Date(this.state.pending.expiresAt).toISOString() } : null;
    const base = { enclaveId: this.enclaveId, confirmed: this.state.confirmed, confirmedTx: this.state.confirmedTx, pending,
                   minPayout6: String(this.minPayout6), paidOut6: String(paid), history: this.state.history.slice(-10).reverse(),
                   paying: this.paying, lastError: this.lastError || this.adoptError || null };
    if (!c) return { ...base, readable: false, why: `the chain could not be read: ${unreadable}` };
    const p = this.#payee(c);
    return { ...base, readable: true, operator: c.operator, declared: c.declared, earned6: String(c.earned6),
             gasWei: String(c.gasWei), payTo: p.to, why: p.why };
  }

  /**
   * The owner starts a payout wallet change on this machine: a fresh one-time code (any earlier one is void), and the
   * page to declare the wallet on, with the code in the fragment. -> { url, expiresAt }
   */
  async begin() {
    const code = "0x" + crypto.randomBytes(32).toString("hex");
    const fromBlock = String(await this.chain.blockNumber());
    const expiresAt = this.now() + CODE_TTL_MS;
    this.state = { ...this.state, pending: { code, fromBlock, expiresAt } };
    savePayoutState(this.file, this.state);
    this.cache = null;
    this.log("payout wallet change started from this machine: waiting up to 30 minutes for a declaration carrying its code");
    return { url: `${PAYOUT_PAGE}?id=${this.enclaveId}#code=${code}`, expiresAt: new Date(expiresAt).toISOString() };
  }

  /** The owner stops paying anyone (earnings stay in the ledger) and voids a change in progress. */
  async clear() {
    this.state = { ...this.state, confirmed: null, confirmedAt: new Date(this.now()).toISOString(), confirmedTx: null, pending: null };
    savePayoutState(this.file, this.state);
    this.cache = null;
    this.log("payout wallet cleared by the owner of this box: earnings stay in the ledger until one is set from this machine");
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
