// The run log's ACTION lines - the "[↻] Retry payment" a failed deploy leaves
// behind. Three things have to hold together or the offer silently disappears:
// the descriptor must survive the persisted tuple (a reload keeps the button),
// paintLine must render a real <button> carrying it in data-*, and every place
// that replays a run's lines must pass the third slot through. The last one is
// a source check - <c-deployments> needs a DOM this suite doesn't have, and a
// dropped `l[2]` is exactly the drift that would paint the offer as dead prose.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/* --- the smallest DOM runlog.js touches: dispatchEvent + createElement --- */
const EVENTS = [];
class El {
  constructor(tag){ this.tagName = String(tag).toUpperCase(); this.children = []; this.dataset = {}; this.className = ""; this.textContent = ""; this.disabled = false; this.scrollTop = 0; this.scrollHeight = 0; this.clientHeight = 0; }
  appendChild(c){ this.children.push(c); return c; }
  get lastElementChild(){ return this.children[this.children.length - 1] || null; }
}
globalThis.CustomEvent = class { constructor(name, opts){ this.type = name; this.detail = (opts || {}).detail; } };
globalThis.document = { dispatchEvent: (e) => EVENTS.push(e), addEventListener(){}, createElement: (t) => new El(t) };
globalThis.localStorage = {
  _m: new Map(),
  getItem(k){ return this._m.has(k) ? this._m.get(k) : null; },
  setItem(k, v){ this._m.set(k, String(v)); },
  removeItem(k){ this._m.delete(k); },
};

const { runlog, paintLine } = await import("../site/js/core/runlog.js");
const ACT = { kind: "fund", id: "0x" + "d6".repeat(32), usd: 5, asset: "USDC" };

test("an action line keeps its descriptor in the run, the event and localStorage", async () => {
  EVENTS.length = 0;
  const w = runlog.startRun();
  w.line("warn", "[x] funding rejected in wallet.");
  w.line("act", "[↻] Retry payment · $5 USDC", ACT);

  // in the run record: prose stays a pair, an offer carries the third slot
  const lines = w.run.lines;
  assert.deepEqual(lines[0], ["warn", "[x] funding rejected in wallet."]);
  assert.deepEqual(lines[1], ["act", "[↻] Retry payment · $5 USDC", ACT]);

  // on the wire: mounted views paint from the event, not the record
  const line = EVENTS.filter(e => e.detail && e.detail.type === "line");
  assert.equal(line[0].detail.act, null, "a prose line must carry act:null, not undefined");
  assert.deepEqual(line[1].detail.act, ACT);

  // and across a reload: save() is debounced, so wait it out
  w.end();
  await new Promise(r => setTimeout(r, 400));
  const saved = JSON.parse(localStorage.getItem("enclave_term_logs"));
  const run = saved[saved.length - 1];
  assert.deepEqual(run.lines[1], ["act", "[↻] Retry payment · $5 USDC", ACT],
    "the retry offer must survive a hard reload with the narrative around it");
});

test("paintLine renders an action line as a button carrying the descriptor", () => {
  const box = new El("div");
  paintLine(box, "act", "[↻] Retry payment · $5 USDC", null, ACT);
  const b = box.lastElementChild;
  assert.equal(b.tagName, "BUTTON", "an offer must be a real button - clickable AND keyboard-reachable");
  assert.equal(b.type, "button", "without type=button it would submit a form it happens to sit in");
  assert.equal(b.className, "ln ln-act act");
  assert.equal(b.textContent, "[↻] Retry payment · $5 USDC");
  assert.deepEqual(b.dataset, { kind: "fund", id: ACT.id, usd: "5", asset: "USDC" });
  assert.equal(b.dataset.raw, undefined, "no .raw: the repeat-collapse must never fold a later line into this button");
});

test("two identical offers stay two buttons (never collapsed into a xN counter)", () => {
  const box = new El("div");
  paintLine(box, "act", "[↻] Retry payment · $5 USDC", null, ACT);
  paintLine(box, "act", "[↻] Retry payment · $5 USDC", null, ACT);
  assert.equal(box.children.length, 2);
  assert.equal(box.children[1].textContent, "[↻] Retry payment · $5 USDC");
});

test("plain lines are unchanged: same span, same repeat collapse", () => {
  const box = new El("div");
  paintLine(box, "info", "[*] waiting…");
  paintLine(box, "info", "[*] waiting…");
  assert.equal(box.children.length, 1, "identical prose still collapses");
  assert.equal(box.children[0].tagName, "SPAN");
  assert.equal(box.children[0].textContent, "[*] waiting…  (x2)");
});

test("a failed deploy funding offers the retry, and retryFunding is exported for it", () => {
  const src = fs.readFileSync(path.join(REPO, "site/js/pages/deploy.js"), "utf8");
  assert.match(src, /w\.line\("warn", rejected \? "\[x\] funding rejected in wallet\."[\s\S]{0,400}?offerRetry\(w, id, fund, asset\)/,
    "the created-but-unfunded branch must leave a retry offer behind");
  assert.match(src, /export async function retryFunding\(/);
  assert.match(src, /kind: "fund", id: id, usd: usd, asset: asset/, "offerRetry's descriptor is what the button dispatches on");
  // the retry must read the ledger before signing again - the double-pay guard
  assert.match(src, /export async function retryFunding\([\s\S]*?await depGet\(id\)[\s\S]*?balance6 >= d\.rate/,
    "retryFunding must check the on-chain balance before asking for a second signature");
});

test("<c-deployments> passes the descriptor through every run-line painter", () => {
  const src = fs.readFileSync(path.join(REPO, "site/components/deployments/deployments.js"), "utf8");
  const replays = src.match(/run\.lines\.forEach\(l => paintLine\([^)]*\)\)/g) || [];
  assert.ok(replays.length >= 2, "expected the strip and the row Output panel to replay run lines");
  replays.forEach(r => assert.match(r, /l\[2\]\)/, "a replay that drops l[2] paints the retry offer as dead prose: " + r));
  assert.match(src, /paintLine\(s\.querySelector\("\.enc-live-out"\), d\.cls, d\.txt, null, d\.act\)/);
  assert.match(src, /paintLine\(nar\.box, d\.cls, d\.txt, nar\.scroller, d\.act\)/);
  // and the click reaches the retry
  assert.match(src, /closest\("\.ln-act"\)/);
  assert.match(src, /m\.retryFunding\(id, parseFloat\(b\.dataset\.usd\), b\.dataset\.asset, runlog\.runFor\(id\)\)/);
});

test("the action button is styled, and after .term .ln so its display wins", () => {
  const css = fs.readFileSync(path.join(REPO, "site/components/deployments/deployments.css"), "utf8");
  const ln = css.indexOf(".term .ln{"), act = css.indexOf(".term .ln-act{");
  assert.ok(ln !== -1 && act !== -1, "both rules must exist");
  assert.ok(act > ln, "equal specificity - .ln-act must come after .ln or it paints as a full-width block");
  assert.match(css, /\.term \.ln-act:disabled\{/, "a taken offer must read as taken");
});
