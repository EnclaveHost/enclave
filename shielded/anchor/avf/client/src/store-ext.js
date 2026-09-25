// store-ext.js -- the browser extension's durable, monotonic memory (client/DESIGN.md "State"; LAB). The same interface as
// store-file.js: { gen, state } under one key in chrome.storage.local; every read-verify-write runs inside one Web Locks
// exclusive lock, which is held browser-wide for the extension's origin -- every page and tab of the extension, not just
// this one -- so two pages cannot both read an old generation and write out of order. Each write is read back before it
// counts; a storage error or a write that did not stick throws, and the caller sends nothing. A page closed mid-update
// releases the lock; the single storage.set either happened or did not.
export class StoreError extends Error {}
const KEY = "stateDoc", LOCK = "enclave-pvm-client-state";
// storage does not keep key order (Chrome returns keys reordered): compare states by their canonical form, keys sorted
const canon = (v) => JSON.stringify(v, (k, x) => (x && typeof x === "object" && !Array.isArray(x) ? Object.fromEntries(Object.keys(x).sort().map((y) => [y, x[y]])) : x));
export const sameState = (a, b) => canon(a) === canon(b);

export class ExtStore {
  constructor(storage = globalThis.chrome && chrome.storage && chrome.storage.local, locks = globalThis.navigator && navigator.locks) {
    if (!storage || !locks) throw new StoreError("no extension storage or Web Locks here: refusing");
    this.storage = storage; this.locks = locks;
  }
  async latest() {
    let got;
    try { got = await this.storage.get([KEY, "state"]); } catch (e) { throw new StoreError(`the extension storage is unreadable (${e.message})`); }
    if (got[KEY]) {
      const d = got[KEY];
      if (!Number.isSafeInteger(d.gen) || d.gen < 1 || !d.state || typeof d.state !== "object") throw new StoreError("the stored state is inconsistent: refusing");
      return d;
    }
    return got.state ? { gen: 0, state: got.state, legacy: true } : null;   // a 0.1.0 install, imported by the next commit
  }
  async write(doc) {
    try { await this.storage.set({ [KEY]: doc }); } catch (e) { throw new StoreError(`could not commit state generation ${doc.gen} (${e.message})`); }
    const back = await this.latest();
    if (!back || back.gen !== doc.gen || !sameState(back.state, doc.state)) throw new StoreError(`state generation ${doc.gen} did not stick`);
  }
  init(state) {
    return this.locks.request(LOCK, { mode: "exclusive" }, async () => {
      if (await this.latest()) return { ok: false, reason: "an anchor is already installed; reinstall the extension to change it" };
      await this.write({ gen: 1, state });
      return { ok: true, gen: 1, state };
    });
  }
  update(fn) {
    return this.locks.request(LOCK, { mode: "exclusive" }, async () => {
      const cur = await this.latest();
      if (!cur) throw new StoreError("no anchor installed");
      const r = await fn(cur.state, cur.gen);
      if (r.refuse !== undefined) return { ok: false, reason: r.refuse, gen: cur.gen };
      if (!cur.legacy && (r.same || sameState(r.state, cur.state))) return { ok: true, gen: cur.gen, state: cur.state, same: true };
      const doc = { gen: cur.gen + 1, state: r.state };
      await this.write(doc);
      return { ok: true, gen: doc.gen, state: doc.state };
    });
  }
}
