// Ledger sync planning (supervisor.js) — the pure half: what ONE claim tick has
// to read from the chain, given a mirror, a log cursor and the chain tip.
// Driven through the LEDGER_SYNC_SELFTEST seam, same contract as SWEEP_SELFTEST.
//
// Why this exists: the tick used to page the WHOLE ledger every 60 seconds —
// ceil(count/100) getPage calls returning every deployment that ever existed.
// Measured 2026-09-22 on the live rev-13 ledger that was 76 KB per host per
// tick (~110 MB/day/host) for a median of ZERO changes, and it is the shape of
// the 2026-07-05 outage: the burst tripped the public RPC's per-IP cap and
// killed the tail of every pass (the sweep) while the head (renewals) kept
// working. The mirror replaces it — so these branches decide when the cheap
// path is allowed to be trusted, and the expensive one is the answer.
//
// The live end-to-end half is LEDGER_SYNC_LIVE (see the seam in supervisor.js);
// it needs the network, so it is deliberately not run from here.

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
import { fileURLToPath } from "node:url";

const pexec = promisify(execFile);
const SUPERVISOR = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "supervisor.js");

async function plan(cases) {
  const { stdout } = await pexec(process.execPath, [SUPERVISOR], {
    env: { ...process.env, SECRET: "test-secret", LEDGER_SYNC_SELFTEST: JSON.stringify({ cases }),
           SWEEP_SELFTEST: "", REACH_SELFTEST: "", ACME_SELFTEST: "", ADDRESS_BOOK_ADDRESS: "",
           REGISTRY_ENABLED: "", CLAIM_ENABLED: "", ACME_EAB_KID: "", ACME_EAB_HMAC: "",
           APP_CERT_DOMAIN: "", DNS_API: "" } });
  const lines = stdout.trim().split("\n").filter(Boolean);
  return JSON.parse(lines[lines.length - 1]);
}

const ADDR = "0xF9e71385C5cB49844F2457ba6567De0742f8B89a";
const OLD  = "0x89d0c9820000000000000000000000000000009429";
const NOW  = 1_790_000_000_000;
// steady state: a seated mirror, 100 blocks of chain since the cursor
const OK = { addr: ADDR, mirrorAddr: ADDR, mirrorSize: 55, cursor: 1000, tip: 1100, count: 55,
             nowMs: NOW, lastFullAt: NOW - 60_000, fullEverySec: 1800, confirmations: 3,
             maxCatchup: 10_000 };
const one = async (patch) => (await plan([{ ...OK, ...patch }]))[0];

test("a seated mirror walks logs, and only up to tip - confirmations", async () => {
  const p = await one({});
  assert.equal(p.mode, "delta");
  assert.equal(p.from, 1000);
  assert.equal(p.to, 1097);          // tip 1100 less 3 confirmations
});

test("no mirror, and a mirror belonging to a retired ledger, both page", async () => {
  const [none, repointed] = await plan([
    { ...OK, mirrorAddr: null, mirrorSize: 0, cursor: null },
    { ...OK, mirrorAddr: OLD },      // the address book moved us mid-flight
  ]);
  assert.equal(none.mode, "full");
  assert.equal(repointed.mode, "full");
  assert.match(repointed.why, /no mirror for this ledger/);
});

// The reconcilers. Each one exists because a delta feed that has quietly
// stopped delivering is indistinguishable from a quiet network.
test("count() drift pages: the ledger is append-only, so the sizes must agree", async () => {
  const p = await one({ count: 56 });                 // a Created we never saw
  assert.equal(p.mode, "full");
  assert.match(p.why, /mirror holds 55 of 56 rows/);
});

test("the periodic pass fires on its own clock, and 0 disables it", async () => {
  const due    = await one({ lastFullAt: NOW - 1_800_000 });
  const notYet = await one({ lastFullAt: NOW - 1_799_000 });
  const off    = await one({ lastFullAt: 0, fullEverySec: 0 });
  assert.equal(due.mode, "full");
  assert.match(due.why, /periodic reconcile/);
  assert.equal(notYet.mode, "delta");
  assert.equal(off.mode, "delta");
});

test("a gap too wide to walk pages instead of grinding through chunks", async () => {
  const p = await one({ cursor: 1000, tip: 20_000 });
  assert.equal(p.mode, "full");
  assert.match(p.why, /over the catch-up cap/);
});

// Degradation: none of these may page, and none may advance anything.
test("nothing newly confirmed, and an unreadable tip, both serve the mirror", async () => {
  const fresh = await one({ cursor: 1098, tip: 1100 });   // to (1097) is behind the cursor
  const blind = await one({ tip: null });
  assert.equal(fresh.mode, "idle");
  assert.match(fresh.why, /no newly confirmed blocks/);
  assert.equal(blind.mode, "idle");
  assert.match(blind.why, /block height unavailable/);
});

test("a ledger with no count() is not a reason to page every tick", async () => {
  const p = await one({ count: null });    // pre-count() contract, or a throttled read
  assert.equal(p.mode, "delta");
});

test("no deployments contract at all is idle, never a page of nothing", async () => {
  const p = await one({ addr: "" });
  assert.equal(p.mode, "idle");
});
