// Independent dashboard Network tab: the owner's setting is signed by the wallet and posted straight to the profile's
// public directories (REAL PublicDirectory + directory server here), with no relay. Directories check the owner
// signature and nonce themselves; one unreachable directory does not block publication.
//   run: node --test test/site-independent-network.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os"; import path from "node:path";
import { privateKeyToAccount } from "viem/accounts";
import { PublicDirectory } from "../network/public-directory.mjs";
import { createDirectoryServer } from "../network/directory-server.mjs";
import { networkPolicyMessage, validateNetworkPolicy } from "../network/network-policy-core.mjs";

const mk = (m = new Map()) => ({ getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k) });
globalThis.localStorage = mk(); globalThis.sessionStorage = mk(); globalThis.location = { hostname: "localhost" };
const { directoryPolicies, publishToDirectories, nextPolicyNonce, oneHopControl, enclaveNetworkChoice, circuitLine, ONE_HOP_PRIVACY } = await import("../site/js/core/enclave-network.js");

const owner = privateKeyToAccount("0x" + "1".repeat(64)), stranger = privateKeyToAccount("0x" + "4".repeat(64));
const id = "0x" + "ab".repeat(32);

async function directory(t){
  const dir = await mkdtemp(path.join(os.tmpdir(), "ind-dir-")); t.after(() => rm(dir, { recursive: true, force: true }));
  const now = Date.now();
  const lease = { id, owner: owner.address, runner: "0x" + "cd".repeat(32), chainId: 8453, deployments: "0x" + "05".repeat(20),
    runnerOperator: "0x" + "06".repeat(20), active: true, isPublic: true, leaseUntil: now + 600000, validUntil: now + 90000 };
  const d = new PublicDirectory({ directory: dir, checkers: ["0x" + "03".repeat(20)], now: () => Date.now(), hostOperator: async () => lease.runnerOperator, leaseOf: async () => ({ ...lease }) });
  const server = createDirectoryServer(d);
  await new Promise((r) => server.listen(0, "127.0.0.1", r)); t.after(() => server.close());
  return "http://127.0.0.1:" + server.address().port;
}
const signed = async (who, policy) => ({ envelope: { policy, signature: await who.signMessage({ message: networkPolicyMessage(policy) }) } });

test("publish a wallet-signed setting to every directory; read it back; stale and forged settings are refused", async (t) => {
  const a = await directory(t), b = await directory(t), down = "http://127.0.0.1:9";
  const dirs = [a, b, down];
  const first = await directoryPolicies(id, dirs);
  assert.deepEqual(first.failed, [down]);
  assert.ok(first.answers.every((x) => x.policy === null), "no setting yet");
  const issuedAt = Math.floor(Date.now() / 1000);
  const policy = { version: 5, deploymentId: id, nonce: nextPolicyNonce(first.answers, issuedAt), issuedAt, mode: "enclave-network", fallback: "none",
    enclaveNetwork: { routes: 1, guard: true, maxPricePerGiB6: 0, budget6: 0 } };
  validateNetworkPolicy(policy);
  const out = await publishToDirectories(id, await signed(owner, policy), dirs);
  assert.deepEqual(out.accepted.sort(), [a, b].sort());
  assert.equal(out.refused.length, 1, "the unreachable directory is reported, not fatal");
  const back = await directoryPolicies(id, dirs);
  assert.ok(back.answers.every((x) => x.policy && x.policy.nonce === policy.nonce && x.policy.enclaveNetwork.routes === 1));
  // the next nonce is above what the directories hold even if the clock went backwards
  assert.equal(nextPolicyNonce(back.answers, issuedAt - 100), policy.nonce + 1);
  await assert.rejects(publishToDirectories(id, await signed(owner, { ...policy, nonce: policy.nonce - 5, issuedAt: issuedAt - 5 }), [a, b]), /no directory accepted/);
  await assert.rejects(publishToDirectories(id, await signed(stranger, { ...policy, nonce: policy.nonce + 1 }), [a, b]), /no directory accepted/);
});

test("nextPolicyNonce ignores malformed reports and never goes below the issue time", () => {
  assert.equal(nextPolicyNonce([{ policy: { nonce: "9" } }, { policy: null }], 1000), 1000);
  assert.equal(nextPolicyNonce([{ policy: { nonce: 5000 } }], 1000), 5001);
});

test("one hop: the form writes guard:false only when the box is ticked, and a directory stores the owner's signed choice", async (t) => {
  assert.deepEqual(enclaveNetworkChoice({ routes: "2", oneHop: false, price: "0", budget: "0" }), { routes: 2, guard: true, maxPricePerGiB6: 0, budget6: 0 });
  const choice = enclaveNetworkChoice({ routes: "1", oneHop: true, price: "0.05", budget: "3" });
  assert.deepEqual(choice, { routes: 1, guard: false, maxPricePerGiB6: 50000, budget6: 3000000 });
  assert.throws(() => enclaveNetworkChoice({ routes: "2", oneHop: true, price: "0.05", budget: "0" }), /price limit needs a budget/);
  const a = await directory(t), issuedAt = Math.floor(Date.now() / 1000);
  const policy = { version: 5, deploymentId: id, nonce: issuedAt, issuedAt, mode: "enclave-network", fallback: "none", enclaveNetwork: choice };
  assert.equal(validateNetworkPolicy(policy).enclaveNetwork.guard, false);
  assert.deepEqual((await publishToDirectories(id, await signed(owner, policy), [a])).accepted, [a]);
  assert.equal((await directoryPolicies(id, [a])).answers[0].policy.enclaveNetwork.guard, false, "read back as signed");
  await assert.rejects(publishToDirectories(id, await signed(stranger, { ...policy, nonce: issuedAt + 1 }), [a]), /no directory accepted/, "a stranger cannot take the guard off");
});

test("one hop: the box says what is given up, and cannot be newly ticked for a host that does not report the setting", () => {
  const box = (o) => oneHopControl(o), input = (h) => h.match(/<input[^>]*>/)[0];
  for (const o of [{}, { hostAllows: true }, { hostAllows: false }, { hostAllows: null }, { checked: true, hostAllows: null }])
    assert.ok(box(o).includes("it sees the host&#39;s IP address together with this app&#39;s visitors and destinations"), "the cost is stated in every state");
  assert.ok(ONE_HOP_PRIVACY.includes("a single provider carries the whole route"));
  // independent mode: no host report to go by; offered, with what an old host or directory does with it
  assert.doesNotMatch(input(box({})), /disabled|checked/);
  assert.match(box({}), /does not know this setting refuses the whole network setting/);
  // the host reports its operator's choice
  assert.doesNotMatch(input(box({ hostAllows: true })), /disabled/);
  assert.match(box({ hostAllows: true }), /This app&#39;s host allows it\./);
  assert.doesNotMatch(input(box({ hostAllows: false })), /disabled/);
  assert.match(box({ hostAllows: false }), /does not allow it: routes keep their guard there/);
  // a host that has not said (older code, or no report): not offered, but a ticked box can still be unticked
  assert.match(input(box({ hostAllows: null })), /disabled/);
  assert.match(box({ hostAllows: null }), /has not reported that it knows this setting/);
  const set = input(box({ checked: true, hostAllows: null }));
  assert.match(set, /checked/); assert.doesNotMatch(set, /disabled/);
});

test("one hop: the status line names the one provider and says it sees the host; other circuits read as before", () => {
  const exit = { providerId: "0x" + "0e".repeat(32), address: "44.0.0.3", region: "sfo3" }, guard = { providerId: "0x" + "0a".repeat(32), address: "44.0.0.1", region: "tor1" };
  const one = circuitLine({ kind: "network", guard: null, exit, healthy: true, ingress: true, egress: false });
  assert.equal(one, "Route: one hop through sfo3 44.0.0.3 (no guard: this provider sees the host) — healthy · website");
  assert.equal(circuitLine({ kind: "network", guard, exit, healthy: true, ingress: true, egress: true, standby: true }), "Route: guard tor1 → exit sfo3 44.0.0.3 · standing by — healthy · website · outbound");
  // no guard is not one hop for the kinds that never had one
  assert.match(circuitLine({ kind: "byo", guard: null, exit: null, healthy: true, egress: true }), /^Your WireGuard peer — healthy/);
  assert.match(circuitLine({ kind: "host", guard: null, exit: null, healthy: false, egress: true }), /^The host's own connection — <span class="warn">checking<\/span>/);
  assert.ok(!circuitLine({ kind: "network", guard: null, exit: { ...exit, region: "<b>" }, healthy: true }).includes("<b>"), "a provider's region is escaped");
});
