// The platform host policy over DESIGNATED lease relays (network/lease-relay-discovery.mjs), with the real descriptor and
// signed-statement verification and an ephemeral relay key; only the index chain read is injected (readIndex). Root's
// review (outputs/decentralization-audit/host-relay-policy-review.json) reproduced two defects, regression-tested here:
//   - an unusable, undecided or "behind" policy must not admit a payable relay (only an explicit admit does, including the
//     deliberate "not-activated" admit; policy off stays the host's explicit configuration);
//   - operator authority is never cached with the endpoint list: it is judged fresh for every signature, through the shared
//     operatorDecider adapter's refresh semantics, and a stale list cannot revive a known ban.
// The same rules through the actual Windows chain module and live relays: test/lease-designated-relays.test.mjs.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { discoverLeaseRelays, relayDescriptor, judgeRelayOperators, relayPolicyDecider, relayAdmission, cachedRelayDiscovery } from "../network/lease-relay-discovery.mjs";
import { relayStatementMessage } from "../client/lease-executor-client.mjs";

const pins = { chainId: 8453, reserve: "0x" + "11".repeat(20), executor: "0x" + "22".repeat(20) };
const relay = privateKeyToAccount(generatePrivateKey());                  // ephemeral; no production key
const operator = privateKeyToAccount(generatePrivateKey()).address;
const bytes = relayDescriptor({ operator, payee: relay.address, ...pins });
const index = { status: "complete", blockNumber: 1n, blockHash: "0x" + "33".repeat(32),
  candidates: [{ operator, kindName: "relay", endpoints: ["https://relay.example/"], descriptor: "0x" + createHash("sha256").update(bytes).digest("hex") }] };
const readIndex = async () => index;
const fetch = async (url) => {
  if (url.endsWith("/v1/descriptor")) return new Response(bytes);
  const message = relayStatementMessage({ ...pins, payee: relay.address, issuedAt: Math.floor(Date.now() / 1000) });
  return new Response(JSON.stringify({ ...pins, payee: relay.address, statement: { message, signature: await relay.signMessage({ message }) } }));
};
const discover = (decide) => discoverLeaseRelays({ pins, decide, fetch, readIndex, resolve: async () => ["192.0.2.1"] });
const one = (d) => async (ops) => Object.fromEntries(ops.map((o) => [o, d]));

test("only an explicit admit pays a relay: unusable, undecided, behind, banned and unlisted operators are refused", async () => {
  const refused = {
    throws: async () => { throw new Error("policy on but unusable"); },
    behind: one({ admit: false, status: "behind", reason: "policy behind anchor" }),
    unanchored: one({ admit: false, status: "unanchored", reason: "no platform host policy is anchored" }),
    authority: one({ admit: false, status: "authority-unread", reason: "no current book owner" }),
    missing: async () => ({}),
    nonObject: async () => null,
    truthyNotTrue: one({ admit: "yes", status: "current" }),
    banned: one({ admit: false, status: "current", reason: "banned by platform policy #3 (operator): abuse" }),
    unlisted: one({ admit: false, status: "current", reason: "not admitted by platform allowlist #3" }),
  };
  for (const [name, decide] of Object.entries(refused)) {
    const r = await discover(decide);
    assert.equal(r.relays.length, 0, `${name}: no relay`);
    assert.equal(r.refusedByPolicy.length, 1, `${name}: refused, and reported`);
    assert.equal(r.policy, name === "throws" ? "unreadable" : "applied", name);
  }
  for (const [name, decide] of Object.entries({ current: one({ admit: true, status: "current", reason: null }),
    "not-activated": one({ admit: true, status: "not-activated", reason: "the admin has anchored no policy" }) })) {
    const r = await discover(decide);
    assert.deepEqual(r.relays.map((x) => x.payee), [relay.address], `${name}: admitted`);
    assert.equal(r.policy, "applied");
  }
  const off = await discover(null);                                        // the host's explicit policy-off configuration
  assert.equal(off.relays.length, 1); assert.equal(off.policy, "not applied");
});

test("judgeRelayOperators and relayAdmission decide fresh on every call and never cache an admit", async () => {
  const state = { banned: false, fail: false }; let calls = 0;
  const decide = async (ops) => { calls++; if (state.fail) throw new Error("rpc down");
    return Object.fromEntries(ops.map((o) => [o, state.banned ? { admit: false, status: "current", reason: "banned by platform policy #4 (operator): x" } : { admit: true, status: "current" }])); };
  const admit = relayAdmission(decide);
  assert.equal((await admit(operator)).admit, true);
  state.banned = true;
  assert.deepEqual(await admit(operator), { admit: false, operator: operator.toLowerCase(), status: "current", reason: "banned by platform policy #4 (operator): x" }, "a new ban applies on the very next signature");
  state.fail = true;
  const failed = await admit(operator);                                    // a known ban is not revived by a failing read
  assert.equal(failed.admit, false); assert.equal(failed.status, "unreadable");
  state.fail = false; state.banned = false;
  assert.equal((await admit(operator)).admit, true, "the admin's unban applies at once");
  assert.equal(calls, 4, "one decision per signature, nothing cached");
  const j = await judgeRelayOperators([operator, operator.toLowerCase()], decide);
  assert.deepEqual([...j.admitted], [operator.toLowerCase()]);
});

test("a policy GATE goes through the shared operatorDecider adapter: behind refreshes once, a failed refresh refuses", async () => {
  const gate = { stale: true, refreshes: 0, failRefresh: true,
    async refresh() { this.refreshes++; if (this.failRefresh) throw new Error("mirror down"); this.stale = false; },
    async decideOperators(ops) { return Object.fromEntries(ops.map((o) => [o, this.stale ? { admit: false, status: "behind", reason: "behind" } : { admit: true, status: "current" }])); } };
  const admit = relayAdmission(relayPolicyDecider(gate));
  const a = await admit(operator);
  assert.equal(a.admit, false); assert.equal(a.status, "behind"); assert.equal(gate.refreshes, 1);
  gate.failRefresh = false;
  assert.equal((await admit(operator)).admit, true); assert.equal(gate.refreshes, 2);
  assert.equal(relayPolicyDecider(null), null, "off only when the host passes null");
  assert.throws(() => relayPolicyDecider({}), /policy gate/);
});

test("the cached ENDPOINT list carries no authority: a ban 31 s later is refused at the next signature (root's fake clock)", async () => {
  let now = 1000, discoveries = 0, banned = false;
  const list = cachedRelayDiscovery(async () => { discoveries++; return discover(null); }, { now: () => now });
  const admit = relayAdmission(one({ admit: true, status: "current" }));
  const banAware = relayAdmission(async (ops) => Object.fromEntries(ops.map((o) => [o, banned ? { admit: false, status: "current", reason: "banned by platform policy #5 (operator): y" } : { admit: true, status: "current" }])));
  const first = await list();
  assert.equal((await admit(first[0].operator)).admit, true);
  banned = true; now += 31_000;
  const cached = await list();
  assert.equal(discoveries, 1, "the endpoint list is still cached");
  assert.equal((await banAware(cached[0].operator)).admit, false, "but its operator is judged now, and refused");
});
