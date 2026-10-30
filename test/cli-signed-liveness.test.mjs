// The independent CLI's host liveness with EXPLICIT CONTRACT PINS only (no reviewed profile), on a real chain (anvil,
// chain 8453, the cli-independent rig's real schema-4 registry) read through the CLI's own RPC quorum:
//   - a healthy host whose last registry write is two hours old is live on its own operator-signed capacity record,
//     verified against its row in the SAME agreed snapshot of the pinned registry (cli/independent.mjs signedLiveness);
//   - with registry writes as the only evidence it is not, nor is the rig's other host (old write, no record);
//   - a forged record, an expired record, a record for another registry and a deregistered row never count.
// HTTPS hosts on loopback under the host-capacity fixture's test CA; the fetch is the CLI's own guarded publicJsonFetch with
// the fixture's address/CA seams. Only anvil's published dev keys are used.
import test from "node:test";
import assert from "node:assert/strict";
import { privateKeyToAccount } from "viem/accounts";
import { haveTools, startRig, KEYS } from "./helpers/cli-independent-rig.mjs";
import { hostServer, loopbackFetch, gpuDoc } from "./helpers/host-capacity-fixture.mjs";
import { buildHostCapacityRecord, signHostCapacity, hostIdOf } from "../network/host-capacity.mjs";
import { createHostCapacityProducer } from "../network/host-capacity-http.mjs";
import * as I from "../cli/independent.mjs";

const skip = haveTools();
const Z32 = "0x" + "00".repeat(32), Z20 = "0x" + "00".repeat(20);

test("explicit pins: a healthy host with a two-hour-old registry write is live on its verified signed record; forged, expired, foreign and deregistered are not",
  skip ? { skip } : { timeout: 240000 }, async (t) => {
  const r = await startRig(); t.after(() => r.stop());
  const op = privateKeyToAccount(KEYS.other), stranger = privateKeyToAccount(KEYS.deployer);
  let serve = () => null;
  const ep = await hostServer(t, "host-a.example.org", (req, res) => { const env = serve();
    res.writeHead(env ? 200 : 404, { "content-type": "application/json" }); res.end(JSON.stringify(env || { error: "none" })); });
  await r.write(r.wc(KEYS.other), r.addresses.registry, r.A.registry4.abi, "register", [ep, "independent/host", Z32, 1500n, 0n, Z20]);
  // two hours pass on chain with no registry write by either host
  const offset = 7200_000;
  await r.rpcCall("evm_increaseTime", [7200]); for (let i = 0; i < 4; i++) await r.mine();
  const chain = new I.QuorumChain({ rpcs: r.rpcs, quorum: 2, confirmations: 1, maxBlockAgeMs: 120000, now: () => Date.now() + offset });
  const snapshot = () => I.registryHosts(chain, r.addresses.registry);
  let reg = await snapshot();
  const id = hostIdOf(ep), mine = reg.hosts.find((h) => h.id === id);
  assert.ok(mine && mine.active && Math.floor(reg.timestamp / 1000) - mine.lastSeen >= 7200, "the host's last registry write is two hours old");
  const live = (signedUntil) => I.liveHosts(reg.hosts, reg.timestamp, { signedUntil }).map((h) => [h.id, h.liveness.evidence]);
  assert.deepEqual(live(null), [], "registry writes alone: nobody is live after two quiet hours");
  // the host serves its own signed record (the shared producer, as the supervisor and the Windows node run it)
  const producer = createHostCapacityProducer({ account: op, hostIdOf, registry: r.addresses.registry, endpoint: ep, availability: async () => gpuDoc(Date.now()) });
  serve = () => null; const env = await producer.current(); serve = () => env;
  let ev = await I.signedLiveness(reg, { registry: r.addresses.registry, fetchHost: loopbackFetch() });
  assert.deepEqual(live(ev.signedUntil), [[id, "signed-record"]], "live on its verified record, with only --contract-pins trust");
  assert.match(ev.failures.get(r.runner), /fetch|resolve|ENOTFOUND|refused|EAI_AGAIN|getaddrinfo|non-public/i, "the rig's other host serves no record: a reported failure, not liveness");
  assert.equal(I.cheapestPrices(I.liveHosts(reg.hosts, reg.timestamp, { signedUntil: ev.signedUntil })).cpu6, 1500n, "priced from the live host");
  assert.deepEqual([ev.unchecked, ev.admitted], [[], 2], "both admitted hosts were checked");
  // the per-command limit: a host beyond it is reported UNCHECKED, never as a failure (it is not evidence of an outage)
  const capped = await I.signedLiveness(reg, { registry: r.addresses.registry, fetchHost: loopbackFetch(), maxHosts: 1 });
  assert.equal(capped.unchecked.length, 1); assert.equal(capped.signedUntil.size + capped.failures.size, 1, "exactly one host was fetched");
  assert.ok(!capped.failures.has(capped.unchecked[0]), "the unchecked host is not listed as failed");
  // forged: a stranger's signature over a record claiming the operator
  const rec = buildHostCapacityRecord({ availability: gpuDoc(Date.now()), chainId: 8453, registry: r.addresses.registry, endpoint: ep, operator: op.address });
  const forged = { record: rec, signature: (await signHostCapacity(stranger, { ...rec, operator: stranger.address.toLowerCase() })).signature };
  serve = () => forged;
  ev = await I.signedLiveness(reg, { registry: r.addresses.registry, fetchHost: loopbackFetch() });
  assert.deepEqual(live(ev.signedUntil), []); assert.match(ev.failures.get(id), /not signed by its operator/);
  // expired: a genuine record whose lifetime is over
  const old = await signHostCapacity(op, buildHostCapacityRecord({ availability: gpuDoc(Date.now() - 20 * 60_000), chainId: 8453, registry: r.addresses.registry,
    endpoint: ep, operator: op.address, now: Date.now() - 20 * 60_000, lifetimeMs: 15 * 60_000 }));
  serve = () => old;
  ev = await I.signedLiveness(reg, { registry: r.addresses.registry, fetchHost: loopbackFetch() });
  assert.deepEqual(live(ev.signedUntil), []); assert.match(ev.failures.get(id), /expired/);
  // a genuine record for ANOTHER registry is not evidence for this one
  serve = () => env;
  ev = await I.signedLiveness(reg, { registry: "0x" + "77".repeat(20), fetchHost: loopbackFetch() });
  assert.deepEqual(live(ev.signedUntil), []); assert.match(ev.failures.get(id), /another chain or registry/);
  // the operator deregisters: the row is no longer admitted, whatever the host still serves
  await r.write(r.wc(KEYS.other), r.addresses.registry, r.A.registry4.abi, "deregister", [id]);
  for (let i = 0; i < 4; i++) await r.mine();
  reg = await snapshot();
  ev = await I.signedLiveness(reg, { registry: r.addresses.registry, fetchHost: loopbackFetch() });
  assert.ok(!ev.signedUntil.has(id), "an inactive row is not even asked");
  assert.deepEqual(live(ev.signedUntil), []);
  assert.equal(I.withLiveness(reg.hosts, reg.timestamp, { signedUntil: new Map([[id, Date.now() + 60_000]]) }).find((h) => h.id === id).liveness.reason, "inactive in the registry");
});
