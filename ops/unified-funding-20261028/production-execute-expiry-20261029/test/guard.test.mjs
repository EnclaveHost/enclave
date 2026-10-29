// UNREVIEWED, NOT RUN. The page's effect guard around the execute POST (client-site-repair-r2 flows.js guardRelayFn /
// guardGasStore, imported UNCHANGED) with the successor confirmGasFund: a context switch BEFORE fetch is provably unsent
// (abandoned_before_send); a relay error can never forge that outcome; a switch AFTER dispatch stays unknown.
// execute-expiry-recovery-r1: ported VERBATIM; only the import specifiers changed (flows.js = canonical source/site copy).
import test from "node:test";
import assert from "node:assert/strict";
import * as EX from "../sdk/funding/gas-execution.mjs";
import * as FL from "../../../source/site/js/funding/flows.js";
import { NOW, RELAY_BASE, countingSubtle, relayFor, reviewFor, runtime, setup } from "./exec-fixtures.mjs";

const OWNER_A = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8", OWNER_B = "0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC";
async function attempt({ switchAt, mode = "body" }) {
  const t = await setup();
  const R = relayFor(t.W, { mode });
  const live = { epoch: 1, owner: OWNER_A, chainId: 8453, provider: {} };
  const g = FL.createGuard(() => ({ ...live }));
  const inner = R.relay;
  const relay = async (m, p, b) => { if (switchAt === "during") { const out = inner(m, p, b); live.owner = OWNER_B; return out; } return inner(m, p, b); };
  if (switchAt === "before_fetch") {
    const cas = t.store.casJournal.bind(t.store);
    t.store.casJournal = async (id, fn) => { const r = await cas(id, fn); if (r.status === "dispatching") live.owner = OWNER_B; return r; };
  }
  const review = reviewFor(t.record);
  let err = null;
  try {
    await EX.confirmGasFund({ runtime, store: FL.guardGasStore(t.store, g), record: t.record, review, relay: FL.guardRelayFn(relay, g),
      relayBase: RELAY_BASE, rpc: t.W.rpc, now: NOW, subtle: countingSubtle(),
      dispatchGuard: switchAt === "before_marker" ? () => { live.owner = OWNER_B; g.check("sending the payment"); } : undefined });
  } catch (e) { err = e; }
  const entry = await t.store.getJournal(EX.execId(t.record.sid, review.call.execute.nonce));
  return { err, entry, R, blockers: EX.executionBlockers(await t.store.listJournal(), t.record) };
}

test("a switch caught by dispatchGuard before the dispatching marker: abandoned_before_send, nothing posted", async () => {
  const x = await attempt({ switchAt: "before_marker" });
  assert.equal(x.err?.code, FL.CANCELLED);
  assert.equal(x.entry.status, "abandoned_before_send");
  assert.deepEqual([x.R.posts, x.blockers.length], [0, 0]);
});

test("a switch after the marker but before fetch: the page guard refuses the POST; recorded abandoned_before_send", async () => {
  const x = await attempt({ switchAt: "before_fetch" });
  assert.equal(x.err?.code, FL.CANCELLED);
  assert.equal(x.entry.status, "abandoned_before_send");
  assert.equal(x.entry.outcome.phase, "page_guard_before_fetch");
  assert.equal(x.R.posts, 0);
});

test("a switch while the POST is in flight: the request was dispatched, so its lost reply stays UNKNOWN", async () => {
  const x = await attempt({ switchAt: "during" });
  assert.equal(x.R.posts, 1);
  assert.equal(x.entry.status, "unknown");
  assert.equal(x.blockers.length, 1);
});

test("a relay answering code context_changed is a RelayError, never a page cancellation", () => {
  const e = new (class extends Error { constructor() { super("x"); this.name = "StateError"; this.code = "context_changed"; } })();
  assert.equal(EX.classifyExecuteFailure(e).kind, "unknown", "classification alone never treats it as unsent");
});
