// What the NucBox node's hv-node attach carries for the relay's owner-only rule (enclave-87's (B)): the operator's
// signature - v2 (bound to the transport key and the EK certificate) only when the relay's challenge offers it, v1
// otherwise - and, with v2, the owners' delegations exactly as the node's files hold them. Checked with real keys, and
// against enclave-e3's shared verifier (the same module the relay runs), so what the node sends is what the relay accepts.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { privateKeyToAccount } from "viem/accounts";
import { recoverMessageAddress } from "viem";
import { fakeBaseRpc, DEPLOYMENTS } from "./helpers/fake-base-rpc.mjs";

const OPERATOR_KEY = "0x" + "5e".repeat(32);
process.env.NODE_OPERATOR_KEY = OPERATOR_KEY;
const rpc = await fakeBaseRpc();
const chain = await import("../windows/node/chain.mjs");
chain.addresses.deployments = DEPLOYMENTS;
const REGISTRY = "0x868eb7fc5b5a84b2ff082eafc9bf40b7aac5ccac";
chain.addresses.registry = REGISTRY;
chain.loadOperator();
const { Host } = await import("../windows/node/host.mjs");
const { attachExtras, finishHvAttach, relayTakesV2, shouldReattach, attachMessageV1 } = await import("../windows/node/hvnode-attach.mjs");
const { attachMessageV2, verifyDelegation, servedOwners, delegationText } = await import("../windows/node/host-delegation.mjs");
after(() => rpc.close());

const operator = privateKeyToAccount(OPERATOR_KEY);
const OPERATOR = operator.address.toLowerCase();
const ownerA = privateKeyToAccount("0x" + "a7".repeat(32));
const BOX = "nucbox-k11";
const sign = (m) => operator.signMessage({ message: m });
const sha = (b) => crypto.createHash("sha256").update(b).digest("hex");
const SPKI = Buffer.concat([Buffer.from("302a300506032b6570032100", "hex"), crypto.randomBytes(32)]);
const EK = crypto.randomBytes(900);                      // stands in for the EK certificate DER the vbs-keys frame sent
const NONCE = crypto.randomBytes(32).toString("base64");
const now = () => Math.floor(Date.now() / 1000);
const del = async (expires = now() + 90 * 86400, signer = ownerA) => {
  const message = delegationText({ owner: signer.address, operator: OPERATOR, box: BOX, chain: 8453, registry: REGISTRY, expires });
  return { message, signature: await signer.signMessage({ message }) };
};

test("the challenge decides the version: v2 only when the relay lists it", () => {
  assert.equal(relayTakesV2({ t: "challenge", nonce: NONCE, sigVersions: [1, 2] }), true);
  for (const c of [{ t: "challenge", nonce: NONCE }, { sigVersions: [1] }, { sigVersions: "2" }, null]) assert.equal(relayTakesV2(c), false);
});

test("v2: the operator signs attachMessageV2 over sha256(transport SPKI) and sha256(EK DER) - recoverable as the relay recovers it", async () => {
  const d = await del();
  const x = await attachExtras({ name: BOX, nonceB64: NONCE, spki: SPKI, ekCertDer: EK, v2: true, sign, delegations: [d] });
  assert.equal(x.version, 2);
  assert.equal(x.message, attachMessageV2(BOX, NONCE, sha(SPKI), sha(EK)));
  assert.equal((await recoverMessageAddress({ message: attachMessageV2(BOX, NONCE, sha(SPKI), sha(EK)), signature: x.operatorSig })).toLowerCase(), OPERATOR);
  // the relay's own verifier accepts the delegation exactly as sent, and serves its owner beside the operator
  assert.deepEqual(x.delegations, [d]);
  const v = await verifyDelegation(x.delegations[0], { operator: OPERATOR, box: BOX, chain: 8453, registry: REGISTRY });
  assert.equal(v.ok, true, v.reason);
  assert.deepEqual((await servedOwners(x.delegations, { operator: OPERATOR, box: BOX, chain: 8453, registry: REGISTRY })).owners,
                   [OPERATOR, ownerA.address.toLowerCase()].sort());
});

test("v1 (a relay without v2): the v1 text, and NO delegations - a v1 attach records no served owner, so none are sent", async () => {
  const x = await attachExtras({ name: BOX, nonceB64: NONCE, spki: SPKI, ekCertDer: EK, v2: false, sign, delegations: [await del()] });
  assert.equal(x.version, 1);
  assert.equal(x.message, `enclave-tunnel-attach:${BOX}:${NONCE}`);
  assert.equal(x.message, attachMessageV1(BOX, NONCE));
  assert.equal((await recoverMessageAddress({ message: x.message, signature: x.operatorSig })).toLowerCase(), OPERATOR);
  assert.deepEqual(x.delegations, []);
});

test("v2 without the EK certificate refuses; no operator key sends no signature", async () => {
  await assert.rejects(() => attachExtras({ name: BOX, nonceB64: NONCE, spki: SPKI, ekCertDer: null, v2: true, sign }), /binds the EK certificate/);
  assert.equal((await attachExtras({ name: BOX, nonceB64: NONCE, spki: SPKI, ekCertDer: EK, v2: true, sign: null })).operatorSig, null);
});

test("the frame: operatorSig on it, delegations on rad with v2 only, raw strings, at most 8, oversized dropped", async () => {
  const d = await del();
  const many = [...Array(10)].map(() => d).concat([{ message: "x".repeat(2000), signature: d.signature }]);
  const f2 = { t: "attest", rad: { format: "windows-hv-node/v1", body: "e30=" } };
  const x2 = await finishHvAttach(f2, { name: BOX, nonceB64: NONCE, spki: SPKI, ekCertDer: EK, v2: true, sign, delegations: many });
  assert.equal(f2.operatorSig, x2.operatorSig);
  assert.equal(f2.rad.delegations.length, 8);
  assert.ok(f2.rad.delegations.every((e) => e.message === d.message && e.signature === d.signature));
  const f1 = { t: "attest", rad: { format: "windows-hv-node/v1", body: "e30=" } };
  await finishHvAttach(f1, { name: BOX, nonceB64: NONCE, spki: SPKI, ekCertDer: EK, v2: false, sign, delegations: [d] });
  assert.ok(f1.operatorSig);
  assert.equal("delegations" in f1.rad, false);
});

test("re-attach when whom the node serves changed since its attach - at most every 2 minutes, never for a v1 attach", () => {
  const t = 1_000_000;
  assert.equal(shouldReattach({ attached: true, attachedVersion: "a", currentVersion: "a", nowMs: t }), false);
  assert.equal(shouldReattach({ attached: true, attachedVersion: "a", currentVersion: "b", lastRedialMs: 0, nowMs: t }), true);
  assert.equal(shouldReattach({ attached: true, attachedVersion: "a", currentVersion: "b", lastRedialMs: t - 60_000, nowMs: t }), false);
  assert.equal(shouldReattach({ attached: false, attachedVersion: "a", currentVersion: "b", nowMs: t }), false);
  assert.equal(shouldReattach({ attached: true, attachedVersion: null, currentVersion: "b", nowMs: t }), false, "a v1 attach carries no owners");
});

test("the Host: attachDelegations sends the VALID, unexpired files as written; ownersVersion moves when a file comes or goes or expires", async () => {
  const h = new Host({ dir: fs.mkdtempSync(path.join(os.tmpdir(), "ee-attach-")), endpoint: `https://api.enclave.host/t/${BOX}`, name: BOX,
    appsEnabled: true, cpuPricePerSec6: 12, log: () => {}, engineRetired: true, isolationManager: "http://127.0.0.1:1" });
  const dir = path.join(h.cfg.dir, "delegations"); fs.mkdirSync(dir);
  await h.refreshOwners();
  const v0 = h.ownersVersion();
  assert.deepEqual(h.attachDelegations(), []);
  const good = await del(), soon = await del(now() + 60, privateKeyToAccount("0x" + "b8".repeat(32)));
  fs.writeFileSync(path.join(dir, "a.json"), JSON.stringify(good));
  fs.writeFileSync(path.join(dir, "b.json"), JSON.stringify(soon));
  // invalid, deterministically: it names owner A but another key signed it (a flipped v byte is NOT reliably invalid -
  // v 0/1 and 27/28 recover alike, so whether it changes the signer depends on the signature's parity)
  const forged = await del();
  forged.signature = await privateKeyToAccount("0x" + "c9".repeat(32)).signMessage({ message: forged.message });
  fs.writeFileSync(path.join(dir, "c.json"), JSON.stringify(forged));
  await h.refreshOwners();
  assert.deepEqual(h.attachDelegations(), [good, soon]);
  const v1 = h.ownersVersion();
  assert.notEqual(v1, v0);
  assert.deepEqual(h.attachDelegations(now() + 120), [good], "an expired one is not sent");
  assert.notEqual(h.ownersVersion(now() + 120), v1, "and its expiry changes the version");
  fs.rmSync(path.join(dir, "a.json"));
  await h.refreshOwners();
  assert.deepEqual(h.attachDelegations(), [soon]);
  assert.notEqual(h.ownersVersion(), v1);
});

test("the version an attach records is of the list it SENT: a refresh during the attach's await still triggers a re-attach", async () => {
  const h = new Host({ dir: fs.mkdtempSync(path.join(os.tmpdir(), "ee-attach-v-")), endpoint: `https://api.enclave.host/t/${BOX}`, name: BOX,
    appsEnabled: true, cpuPricePerSec6: 12, log: () => {}, engineRetired: true, isolationManager: "http://127.0.0.1:1" });
  const dir = path.join(h.cfg.dir, "delegations"); fs.mkdirSync(dir);
  fs.writeFileSync(path.join(dir, "a.json"), JSON.stringify(await del()));
  await h.refreshOwners();
  const sent = h.attachDelegations();                                  // what the frame carries
  assert.equal(h.ownersVersion(undefined, sent), h.ownersVersion(), "nothing changed: the two agree");
  // a delegation arrives while the attach awaits the operator's signature, and the tick refreshes
  fs.writeFileSync(path.join(dir, "b.json"), JSON.stringify(await del(undefined, privateKeyToAccount("0x" + "d2".repeat(32)))));
  await h.refreshOwners();
  const recorded = h.ownersVersion(undefined, sent);
  assert.notEqual(recorded, h.ownersVersion());
  assert.equal(shouldReattach({ attached: true, attachedVersion: recorded, currentVersion: h.ownersVersion(), lastRedialMs: 0 }), true);
});

test("the agent records the version of x.delegations, the list its frame carried (source)", () => {
  const src = fs.readFileSync(new URL("../windows/node/agent.mjs", import.meta.url), "utf8");
  // both what the frame carried: its owners' version (shouldReattach) and whom it made the relay serve (reattachMode)
  assert.match(src, /attachSent = \{ version: x\.version, owners: APPS \? host\.ownersVersion\(undefined, x\.delegations\) : null,\s*served: APPS \? host\.servedBy\(x\.delegations\) : null \};/);
});
