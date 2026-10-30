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
const { directoryPolicies, publishToDirectories, nextPolicyNonce } = await import("../site/js/core/enclave-network.js");

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
