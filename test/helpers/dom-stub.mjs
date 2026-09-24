// The smallest browser a site/js/core module needs to LOAD under node --test.
//
// catalog.js and featured.js subscribe to page events at module scope (util.js `on` ->
// document.addEventListener), so importing them in a test throws before a single assertion runs.
// The rules under test are pure - ranking, dedupe, membership - so the stub only has to make the
// import succeed: an event target for the subscriptions, and empty storage/location for the
// config module. Anything a test actually depends on is set by the test itself.
const listeners = new Map();
const target = {
  addEventListener(name, fn) { (listeners.get(name) || listeners.set(name, []).get(name)).push(fn); },
  removeEventListener(name, fn) {
    const l = listeners.get(name) || [];
    const i = l.indexOf(fn); if (i >= 0) l.splice(i, 1);
  },
  dispatchEvent(ev) { for (const fn of listeners.get(ev && ev.type) || []) fn(ev); return true; },
};
const store = new Map();
globalThis.document = globalThis.document || {
  ...target,
  visibilityState: "visible",
  documentElement: { style: { setProperty() {} }, classList: { add() {}, remove() {}, toggle() {} } },
  querySelector: () => null,
  querySelectorAll: () => [],
  getElementById: () => null,
  createElement: () => ({ style: {}, classList: { add() {}, remove() {}, toggle() {} }, dataset: {},
                          setAttribute() {}, appendChild() {}, addEventListener() {} }),
};
globalThis.window = globalThis.window || globalThis;
globalThis.location = globalThis.location || new URL("https://enclave.host/apps");
globalThis.localStorage = globalThis.localStorage || {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => void store.set(k, String(v)),
  removeItem: (k) => void store.delete(k),
};
globalThis.sessionStorage = globalThis.sessionStorage || globalThis.localStorage;
globalThis.CustomEvent = globalThis.CustomEvent || class CustomEvent {
  constructor(type, init) { this.type = type; this.detail = (init && init.detail) || {}; }
};
