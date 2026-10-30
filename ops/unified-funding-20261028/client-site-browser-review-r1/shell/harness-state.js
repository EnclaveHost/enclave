// client-site-browser-r1 shared TEST shell state (UNREVIEWED, NOT RUN). One instance per page load, imported by the
// shell (main.mjs) and by the facades that stand in for the site modules the /funding page imports. It holds:
//   - this run's random TEST database names (sessionStorage, public names only) and the refusal of any other name;
//   - the page configuration (runtime pins / proposal / approval) that facade/config.js exports, set by the shell from
//     /test/fixture/config BEFORE the page module is evaluated;
//   - one-shot "holds": a delayed fixture-signer reply or a delayed RPC read that runs a wallet/network switch while
//     the page's flow is pending (the switch itself is the shell's, through the facade Enclave object).
export const PREFIX = "client-site-browser-r1-TEST-";
export const SS_KEY = "client-site-browser-r1";
const NAME = /^client-site-browser-r1-TEST-(legacy|v2)-[0-9a-f]{16}$/;
const KNOWN_REAL = new Set(["enclave-sessions", "enclave-funding-v2", "enclave_sessions", "enclave-v2"]);

let pageConfig = null;
export const H = {
  counters: { accountFromSession: 0, rpcHolds: 0, signHolds: 0 },
  configUnavailable: false,
  load() { return JSON.parse(sessionStorage.getItem(SS_KEY) || "null"); },
  save(o) { sessionStorage.setItem(SS_KEY, JSON.stringify(o)); },
  /** The TEST database name for `kind`, refusing anything that is not this run's random prefixed name. */
  dbName(kind, alsoRefuse = []) {
    const st = H.load();
    const n = kind === "legacy" ? st?.legacyDb : kind === "v2" ? st?.v2Db : null;
    if (typeof n !== "string" || !NAME.test(n) || !n.startsWith(`${PREFIX}${kind}-`) || KNOWN_REAL.has(n) || alsoRefuse.includes(n)) {
      throw new Error(`TEST harness refuses database ${String(n)} (no random ${PREFIX}${kind}-* name for this run)`);
    }
    return n;
  },
  setPageConfig(c) {
    if (pageConfig) throw new Error("page config is set once per page load");
    pageConfig = Object.freeze({ runtime: c.runtime ?? null, proposal: c.proposal ?? null, approval: c.approval ?? null });
  },
  pageConfig() {
    if (!pageConfig) throw new Error("TEST harness: the page module was evaluated before the fixture config was loaded");
    return pageConfig;
  },
  // ---- one-shot holds -----------------------------------------------------------------------------------------------
  signHold: null,                        // { n, action }: after the n-th fixture-signer answer from now, run action()
  rpcHold: null,                         // { action }: before the next RPC read from now, run action()
  armSign(n, action) { H.signHold = { left: n, action }; },
  armRpc(action) { H.rpcHold = { action }; },
  async afterSign() {
    const h = H.signHold;
    if (!h) return;
    h.left -= 1;
    if (h.left > 0) return;
    H.signHold = null;
    H.counters.signHolds += 1;
    await h.action();
  },
  async onRpc() {
    const h = H.rpcHold;
    if (!h) return;
    H.rpcHold = null;
    H.counters.rpcHolds += 1;
    await h.action();
  },
};
