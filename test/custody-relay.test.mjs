// The relay's side of secret custody (docs/security/secret-custody.md): once a deployment's owner has moved its secrets to
// custodians, the relay stores and serves NO value for it on any path (owner write, lease-holder fetch, Shield, pVM), keeps
// accepting a CLEAR so the old copy can be deleted, says so in the existence probe, and fails closed (503) when it cannot
// confirm the custody state. Also: relay/custody-state.mjs reads the vault exactly as custody/chain.mjs does (anvil).
//   run: node --test test/custody-relay.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { privateKeyToAccount } from "viem/accounts";

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), "enclave-custody-relay-test-"));
process.env.SECRETS_KEY = "cd".repeat(32);
process.env.AUTH_DATA_DIR = DIR;
const { initSecrets, handleSecrets, applyPut, readSecrets, putMessage } = await import("../relay/secrets.js");
await initSecrets();

const OWNER = privateKeyToAccount("0x" + "31".repeat(32));
const OP = privateKeyToAccount("0x" + "32".repeat(32));
const ID = "0x" + "c7".repeat(32);
const RUNNER = "0x" + "aa".repeat(32);
const ENDPOINT = "https://enclave1.example";
let held = true, heldThrows = false;
const ctx = {
  json: (res, code, body) => { res.code = code; res.body = body; },
  readBody: async (req) => Buffer.from(JSON.stringify(req.body)),
  clientIp: () => "203.0.113.8",
  ledgerRows: async () => [{ id: ID, owner: OWNER.address, runner: RUNNER, leaseUntil: BigInt(Math.floor(Date.now() / 1000) + 1800) }],
  ledgerExpire: () => {},
  endpointIdOf: async (ep) => (ep === ENDPOINT ? RUNNER : "0x" + "ee".repeat(32)),
  operatorOfEndpoint: async () => OP.address,
  hostEligibility: () => ({ eligible: true, reason: null }),
  custodyHeld: async () => { if (heldThrows) throw new Error("RPCs disagree"); return held; },
  shieldSecretRelease: async () => ({ released: "a relay-held copy" }),
  pvmSecretRelease: async () => ({ released: "a relay-held copy" }),
};
const call = async (pathname, body) => { const res = {}; await handleSecrets({ method: "POST", body }, res, new URL("http://x" + pathname), ctx); return res; };
const put = async (payload) => {
  const expiry = Math.floor(Date.now() / 1000) + 300;
  return call(`/v1/secrets/${ID}`, { payload, expiry, signature: await OWNER.signMessage({ message: putMessage(ID, expiry, payload) }) });
};
const fetchBody = async () => {
  const ts = Math.floor(Date.now() / 1000) - Math.floor(Math.random() * 100);
  return { id: ID, endpoint: ENDPOINT, ts, sig: "00".repeat(32), opSig: await OP.signMessage({ message: `enclave-secrets-fetch:${ID}:${ENDPOINT}:${ts}` }) };
};

test("an old relay copy left from before the move is never served, and owner writes other than a clear are refused", async () => {
  applyPut(ID, JSON.stringify({ set: { LEGACY_TOKEN: "pre-migration-value" } }));   // what the relay held before custody
  held = true;
  const f = await call("/v1/secrets/fetch", await fetchBody());
  assert.equal(f.code, 409);
  assert.equal(f.body.error, "custody_held");
  assert.ok(!JSON.stringify(f.body).includes("pre-migration-value"));
  const w = await put(JSON.stringify({ set: { NEW: "x" } }));
  assert.equal(w.code, 409);
  assert.equal(w.body.error, "custody_held");
  // the clear goes through, and deletes the copy
  const c = await put(JSON.stringify({ clear: true }));
  assert.equal(c.code, 200, JSON.stringify(c.body));
  assert.deepEqual(readSecrets(ID).env, {});
});

test("Shield and pVM releases of a custody-held deployment are refused before their handlers run", async () => {
  held = true;
  for (const p of ["/v1/secrets/shield-release", "/v1/secrets/pvm-release"]) {
    const r = await call(p, { id: ID, endpoint: ENDPOINT, ts: Math.floor(Date.now() / 1000) });
    assert.equal(r.code, 409, p);
    assert.equal(r.body.error, "custody_held");
  }
});

test("the existence probe counts custody-held secrets (a secrets-incapable runner must not claim the deployment)", async () => {
  held = true;
  const r = await call("/v1/secrets/exists", { id: ID });
  assert.deepEqual(r.body, { id: ID, exists: true, custody: true });
  held = false;
  const r2 = await call("/v1/secrets/exists", { id: ID });
  assert.equal(r2.body.custody, undefined);
});

test("an unconfirmable custody state fails closed: 503 on every path, never a plaintext copy", async () => {
  applyPut(ID, JSON.stringify({ set: { LEGACY_TOKEN: "still-here" } }));
  heldThrows = true;
  try {
    const f = await call("/v1/secrets/fetch", await fetchBody());
    assert.equal(f.code, 503);
    assert.ok(!JSON.stringify(f.body).includes("still-here"));
    assert.equal((await put(JSON.stringify({ set: { X: "1" } }))).code, 503);
    // the existence probe needs no custody answer when the relay holds a record: yes either way, just without the flag
    // (an id with no record still answers 503 here: test/relay-exists-fastpath.test.mjs)
    const e = await call("/v1/secrets/exists", { id: ID });
    assert.equal(e.code, 200);
    assert.deepEqual(e.body, { id: ID, exists: true });
    assert.equal((await call("/v1/secrets/shield-release", { id: ID })).code, 503);
  } finally { heldThrows = false; }
  // without custody the legacy paths are exactly as before
  held = false;
  const f = await call("/v1/secrets/fetch", await fetchBody());
  assert.equal(f.code, 200);
  assert.equal(f.body.env.LEGACY_TOKEN, "still-here");
});

// ---- relay/custody-state.mjs against the real vault, the same state as custody/chain.mjs reads ----
const { anvilAvailable, custodyRig } = await import("./helpers/custody-rig.mjs");
const SKIP = anvilAvailable() ? false : "anvil (Foundry) is not installed";
test("the relay's custody reader agrees with the custodians' reader, needs agreeing RPCs, and reports no-policy as null", { skip: SKIP }, async () => {
  const { createCustodyReader } = await import("../relay/custody-state.mjs");
  const { buildBundle, makeUpdate, UPDATE_ABI } = await import("../custody/owner.mjs");
  const { createPublicClient, http } = await import("viem");
  const R = await custodyRig({ n: 5, t: 3 });
  try {
    const owner = await R.account();
    const id = "0x" + randomBytes(32).toString("hex");
    await R.setDeployment(id, { owner: owner.address });
    const clients = [createPublicClient({ transport: http(R.anvil.url) }), createPublicClient({ transport: http(R.anvil.url) })];
    const relay = createCustodyReader({ vault: R.vault, chainId: R.chainId, clients, minAgree: 2 });
    assert.equal(await relay.custodyStateFor(id), null);
    assert.equal(await relay.custodyHeld(id), false);
    const ep = await R.reader().readEpoch({ committeeId: R.committeeId, epoch: 1 });
    const b = buildBundle({ chainId: R.chainId, vault: R.vault, id, secretRev: 1n, committeeId: R.committeeId, epoch: 1, threshold: ep.threshold, members: ep.members, env: { A: "1" }, configText: "" });
    const rules = { v: 1, appId: "ab".repeat(32), images: [{ platform: "sev-snp", measurement: "77".repeat(48), runtimeId: "cd".repeat(32) }], minTcb: { Genoa: { bootloader: 10, tee: 0, snp: 23, microcode: 84 } }, vmpl: 0 };
    await R.send(owner, R.vault, UPDATE_ABI, "update", [id, makeUpdate({ expectPolicyRev: 0, policy: { committeeId: R.committeeId, paused: false, rules }, bundle: { ...b, epoch: 1 } })]);
    const p = await relay.custodyStateFor(id);
    const s = await R.reader().readState({ id });
    assert.equal(p.policyRev, String(s.policy.policyRev));
    assert.equal(p.secretRev, String(s.policy.secretRev));
    assert.equal(p.epoch, s.bundle.epoch);
    assert.equal(p.threshold, s.committee.threshold);
    assert.deepEqual(p.members, s.committee.members.map((m) => ({ encKey: Buffer.from(m.encKey).toString("hex"), endpoint: m.endpoint })));
    assert.equal(p.c0, Buffer.from(s.shares.commitments.subarray(0, 33)).toString("hex"));
    assert.equal(p.ciphertext, Buffer.from(s.bundle.ciphertext).toString("base64"));
    assert.equal(await relay.custodyHeld(id), true);
    // a "minAgree 2" reader over ONE reachable RPC refuses
    const lonely = createCustodyReader({ vault: R.vault, chainId: R.chainId, clients: [clients[0], createPublicClient({ transport: http("http://127.0.0.1:9") })], minAgree: 2 });
    await assert.rejects(lonely.custodyStateFor(id), (e) => e.code === "custody_unconfirmed");
  } finally { await R.stop(); }
});
