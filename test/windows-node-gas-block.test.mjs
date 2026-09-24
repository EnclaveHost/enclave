// An operator key with no gas, and what the box does about it.
//
// The incident this is written from. On 2026-09-23 the nucbox-k11 operator key ran out of Base
// ETH. Five leases it held lapsed (05:21-05:38 UTC), `renew` on a lapsed lease reverts, and for
// the next 34 hours the box took those same five deployments off the ledger every 30 seconds and
// stopped them again: 18,767 takes, 18,761 stops, and not one line naming an empty key. The five
// deployments were funded the whole time and the ledger said claimableBy = true for each. Nothing
// was broken except that the box could not pay for a transaction, and nothing said so.
//
// Two properties, then, and they are separate:
//   1. the SENTENCE names the blocker and what to do about it, because it is what a tenant reads;
//   2. the box does not keep trying, because the answer cannot change until somebody tops it up.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { claimGasBlock } from "../windows/node/host.mjs";

const OP = "0x389C3f030a209D04D026228D2D053fEB75DbadcA";
const src = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "../windows/node/host.mjs"), "utf8");

test("gas in the tank is not a block, and an empty one is", () => {
  assert.equal(claimGasBlock(200, OP), null);
  assert.equal(claimGasBlock(1, OP), null);
  assert.equal(claimGasBlock(undefined, OP), null, "not yet measured is not the same as empty: it must not stop a fresh box claiming");
  assert.equal(claimGasBlock(null, OP), null);
  assert.notEqual(claimGasBlock(0, OP), null);
});

test("the sentence names the key, the chain and the one thing that is missing", () => {
  const r = claimGasBlock(0, OP);
  assert.match(r, /no gas for a claim transaction/);
  assert.match(r, new RegExp(OP), "the address to top up, so nobody has to go and find it");
  assert.match(r, /on Base/, "which chain's gas");
  assert.match(r, /the lease is funded/i, "what is NOT wrong: money and policy are fine, and saying so stops the wrong repair");
  assert.match(r, /only the gas is missing/);
});

test("a box with no operator address still produces a usable sentence", () => {
  assert.match(claimGasBlock(0, ""), /the operator address/);
  assert.match(claimGasBlock(0, null), /the operator address/);
});

// The wiring, pinned: these are the three places the loop ran through, and a guard that is written
// but not called is the same outage again.
test("the claim paths each ask before spending a tick on a claim they cannot send (pinned in source)", () => {
  const consider = src.slice(src.indexOf("async consider(id, {"), src.indexOf("async #resize") > 0 ? src.indexOf("async #resize") : src.length);
  assert.match(consider, /if \(!\(ours && live\) && claimGasBlock\(this\.gasRenewals/,
               "consider() refuses the claim before it adds the deployment to the watch list");
  assert.ok(consider.indexOf("claimGasBlock") < consider.indexOf("this.tracked.add(id)"),
            "the guard must come BEFORE tracked.add: tracking it is what brought it back round every tick");

  const scan = src.slice(src.indexOf("const rank = (d) =>"), src.indexOf("async tick()"));
  assert.match(scan, /if \(claimGasBlock\(this\.gasRenewals, chain\.operatorAddress\(\)\)\) \{ this\.#noGasToClaim\(id, d\); continue; \}/,
               "the ledger scan does not print a take line for a take it cannot do");
  assert.ok(scan.indexOf("claimGasBlock") < scan.indexOf("ledger: taking"),
            'a "taking" line followed by nothing reads as progress');

  const tick = src.slice(src.indexOf("async tick()"));
  assert.match(tick, /if \(!leaseLive\) \{/, "a lapsed lease is handled as a lapse, not as a renewal that failed");
  assert.ok(tick.indexOf("if (!leaseLive) {") < tick.indexOf("chain.renewDeployment"),
            "renew is never sent to a lease the ledger has already closed");
});

test("the reason is recorded every time and logged only when it changes (pinned in source)", () => {
  const fn = src.slice(src.indexOf("#noGasToClaim(id, d) {"), src.indexOf("async consider(id, {"));
  assert.match(fn, /if \(!rec \|\| rec\.reason !== reason\) this\.log\(/,
               "say it once: a standing condition repeated every 30 seconds is how the real reason got buried");
  assert.match(fn, /this\.#record\(id, \{ status: "queued", reason/,
               "but RECORD it every time: the record is what the console and the tenant read");
});
