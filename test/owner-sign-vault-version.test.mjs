// rpc/snp/owner-sign/vault-version.mjs: a new version of an app the owner's session vault publishes and holds. The
// upload is made only for the owner's signature over exactly the plan's component and only accepted under the plan's
// CID; the publish waits for the component to be served, the promote for the approved version, the host and the
// component still being served.
import { test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { promotedHash, served, upload, uploadMessage, vaultVersionStatus } from "../rpc/snp/owner-sign/vault-version.mjs";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vault-version-"));
const bytes = Buffer.from("\0asm component bytes"), sha256 = crypto.createHash("sha256").update(bytes).digest("hex");
const file = path.join(dir, "app.wasm"); fs.writeFileSync(file, bytes);
const owner = privateKeyToAccount(generatePrivateKey()), other = privateKeyToAccount(generatePrivateKey());
const CID = "bafybeidkdt5kv3bkyygeyofbkoo3abqd2oi7o5wgcsbrkodmjf5q3zzub4";
const U = { file, sha256, cid: CID, tokenUrl: "https://relay.test/v1/apps/upload-token", uploadUrl: "https://pin.test/add-wasm", gateways: ["https://pin.test", "https://gw.test"] };
const reply = (status, body) => ({ ok: status < 400, status, text: async () => JSON.stringify(body), arrayBuffer: async () => body });
const soon = () => Math.floor(Date.now() / 1000) + 300;

// the relay and the gateway: record what they were sent, answer with a token and `cid`
function net({ cid = CID } = {}) {
  const seen = [];
  return { seen, fetch: async (url, init) => {
    seen.push({ url, headers: init.headers, body: init.body });
    return url === U.tokenUrl ? reply(200, { token: "ab".repeat(32), address: owner.address.toLowerCase(), expiry: JSON.parse(init.body).expiry }) : reply(200, { cid });
  } };
}

// The pair and the record SessionVault 0xB794…345D held for deployment 0x9a28642b…8a6b on Base, read 2026-11-13.
test("the promoted record is keccak256(abi.encode(appRef, configCid))", () => {
  const appRef = "catalog://0xcdc1fa941d248411e49f922e0bc7adfe8cc343712ca4fe4dfb24fab3ef6c70ce/0";
  const option = '{"isolation":{"cpuTee":false,"gpuTee":false},"placement":{"hostId":"0x2fcef48d6ad6919a6264074592b13855968b9f7be52c463764609a68af41447a"},"network":{"relay":"us-west"}}';
  assert.equal(promotedHash(appRef, option), "0x98ba7eff2aa4dc64ab5a9b6e16238bd176ab4b260e28e88b38091a8e66240ccf");
  assert.notEqual(promotedHash("a", "b"), promotedHash("ab", ""));
});

test("the upload sends the owner's signature to the relay and the file with the token to the gateway", async () => {
  const expiry = soon(), signature = await owner.signMessage({ message: uploadMessage(sha256, expiry) }), n = net();
  assert.equal(await upload(U, owner.address, { expiry, signature }, n.fetch), CID);
  assert.deepEqual(n.seen.map((s) => s.url), [U.tokenUrl, U.uploadUrl]);
  assert.deepEqual(JSON.parse(n.seen[0].body), { hash: sha256, expiry, signature });
  assert.equal(n.seen[1].headers["x-upload-token"], "ab".repeat(32));
  assert.equal(n.seen[1].headers["x-upload-expiry"], String(expiry));
  assert.ok(n.seen[1].body.equals(bytes));
});

test("nothing is sent for another signer, another file, or a stale authorization", async () => {
  const expiry = soon(), n = net();
  const wrong = await other.signMessage({ message: uploadMessage(sha256, expiry) });
  await assert.rejects(upload(U, owner.address, { expiry, signature: wrong }, n.fetch), /not the owner/);
  const elsewhere = await owner.signMessage({ message: uploadMessage("0".repeat(64), expiry) });
  await assert.rejects(upload(U, owner.address, { expiry, signature: elsewhere }, n.fetch), /not the owner/);
  const good = await owner.signMessage({ message: uploadMessage(sha256, expiry) });
  await assert.rejects(upload({ ...U, sha256: "0".repeat(64) }, owner.address, { expiry, signature: good }, n.fetch), /not the one the plan names/);
  await assert.rejects(upload(U, owner.address, { expiry: expiry - 1000, signature: good }, n.fetch), /bad upload authorization/);
  await assert.rejects(upload(U, owner.address, { expiry: expiry + 1000, signature: good }, n.fetch), /bad upload authorization/);
  assert.equal(n.seen.length, 0);
});

test("a gateway that pins the file under another CID is an error", async () => {
  const expiry = soon(), signature = await owner.signMessage({ message: uploadMessage(sha256, expiry) });
  await assert.rejects(upload(U, owner.address, { expiry, signature }, net({ cid: "bafkreiother" }).fetch), /pinned it as bafkreiother/);
});

test("served means every gateway returns exactly the component", async () => {
  const from = (map) => async (url) => (map[new URL(url).host] ? reply(200, map[new URL(url).host]) : reply(404, ""));
  assert.equal(await served(U, from({ "pin.test": bytes, "gw.test": bytes })), null);
  assert.match(await served(U, from({ "pin.test": bytes })), /gw\.test does not serve/);
  assert.match(await served(U, from({ "pin.test": bytes, "gw.test": Buffer.from("x") })), /gw\.test serves other bytes/);
});

// A chain that answers the four reads from `state` and simulates every call unless `revert` names its target.
const OLD = "catalog://0x" + "cd".repeat(32) + "/0", NEW = "catalog://0x" + "cd".repeat(32) + "/1", OPTION = '{"network":{"relay":"us-west"}}';
const marker = path.join(dir, "switched.json");
const plan = {
  owner: owner.address, steps: [{ id: "upload", upload: { sha256 } }, { id: "publish", to: "0xva", data: "0x01" }, { id: "approve", to: "0xca", data: "0x02" }, { id: "promote", to: "0xva", data: "0x03" }],
  status: { catalog: "0xca", ledger: "0xle", vault: "0xva", appId: "0x" + "cd".repeat(32), versionIndex: 1, label: "0.9.1", versionConfig: "{}", ports: "http:8000",
    deployment: "0x" + "9a".repeat(32), oldAppRef: OLD, newAppRef: NEW, configCid: OPTION, hostRelease: "de".repeat(32), hostMarker: marker, upload: U },
};
function chain(state) {
  const calls = [];
  return { calls, call: async (c) => { calls.push(c); if (state.revert === c.data) throw new Error("execution reverted"); },
    readContract: async ({ functionName }) => ({
      numVersions: () => BigInt(state.versions), get: () => ({ appRef: state.appRef, configCid: OPTION }),
      held: () => [2, state.promoted, "0x" + "0".repeat(64)],
      getVersion: () => ({ cid: state.cid ?? CID, version: "0.9.1", config: "{}", ports: "http:8000", approval: state.approval, yanked: false }) }[functionName])() };
}
const none = async () => reply(404, ""), all = async () => reply(200, bytes);

test("each step waits for the one before it, and the promote for the host", async () => {
  fs.rmSync(marker, { force: true });
  let st = await vaultVersionStatus(plan, chain({ versions: 1, appRef: OLD, promoted: promotedHash(OLD, OPTION) }), { fetchImpl: none });
  assert.deepEqual(st.ready, { upload: true, publish: false, approve: false, promote: false });
  assert.match(st.blocked.publish, /does not serve/);

  let c = chain({ versions: 1, appRef: OLD, promoted: promotedHash(OLD, OPTION) });
  st = await vaultVersionStatus(plan, c, { fetchImpl: all });
  assert.equal(st.upload, true);
  assert.deepEqual(st.ready, { upload: false, publish: true, approve: false, promote: false });
  assert.deepEqual(c.calls, [{ account: owner.address, to: "0xva", data: "0x01" }]);

  st = await vaultVersionStatus(plan, chain({ versions: 2, approval: 0, appRef: OLD, promoted: promotedHash(OLD, OPTION) }), { fetchImpl: all });
  assert.equal(st.publish, true);
  assert.deepEqual(st.ready, { upload: false, publish: false, approve: true, promote: false });
  assert.match(st.blocked.promote, /not approved/);

  st = await vaultVersionStatus(plan, chain({ versions: 2, approval: 1, appRef: OLD, promoted: promotedHash(OLD, OPTION) }), { fetchImpl: all });
  assert.equal(st.approve, true);
  assert.equal(st.ready.promote, false);
  assert.match(st.blocked.promote, /run the host switch first/);

  fs.writeFileSync(marker, JSON.stringify({ igvmSha256: "00".repeat(32) }));
  st = await vaultVersionStatus(plan, chain({ versions: 2, approval: 1, appRef: OLD, promoted: promotedHash(OLD, OPTION) }), { fetchImpl: all });
  assert.match(st.blocked.promote, /another release/);

  fs.writeFileSync(marker, JSON.stringify({ igvmSha256: "de".repeat(32) }));
  st = await vaultVersionStatus(plan, chain({ versions: 2, approval: 1, appRef: OLD, promoted: promotedHash(OLD, OPTION) }), { fetchImpl: all });
  assert.equal(st.ready.promote, true);
  st = await vaultVersionStatus(plan, chain({ versions: 2, approval: 1, appRef: OLD, promoted: promotedHash(OLD, OPTION), revert: "0x03" }), { fetchImpl: all });
  assert.match(st.blocked.promote, /it would revert/);
});

test("the promote is done only when the vault recorded the new pair, and a foreign version blocks everything after it", async () => {
  fs.writeFileSync(marker, JSON.stringify({ igvmSha256: "de".repeat(32) }));
  // the ledger moved but the vault's record did not (a bare setAppRef): not done
  let st = await vaultVersionStatus(plan, chain({ versions: 2, approval: 1, appRef: NEW, promoted: promotedHash(OLD, OPTION) }), { fetchImpl: all });
  assert.equal(st.promote, false);
  st = await vaultVersionStatus(plan, chain({ versions: 2, approval: 1, appRef: NEW, promoted: promotedHash(NEW, OPTION) }), { fetchImpl: all });
  assert.equal(st.promote, true);
  assert.equal(st.ready.promote, false);
  st = await vaultVersionStatus(plan, chain({ versions: 2, approval: 1, cid: "bafkreiother", appRef: OLD, promoted: promotedHash(OLD, OPTION) }), { fetchImpl: all });
  assert.equal(st.publish, false);
  for (const id of ["publish", "approve", "promote"]) assert.match(st.blocked[id], /is not this release/);
});

test("the served check is not repeated once it has passed", async () => {
  const cache = {}; let fetched = 0;
  const counting = async () => { fetched++; return reply(200, bytes); };
  for (let i = 0; i < 3; i++) await vaultVersionStatus(plan, chain({ versions: 1, appRef: OLD, promoted: promotedHash(OLD, OPTION) }), { fetchImpl: counting, cache });
  assert.equal(fetched, U.gateways.length);
});

test("the promote waits while a gateway that served the component no longer does", async () => {
  fs.writeFileSync(marker, JSON.stringify({ igvmSha256: "de".repeat(32) }));
  const cache = {}, state = { versions: 2, approval: 1, appRef: OLD, promoted: promotedHash(OLD, OPTION) };
  let clock = 1000000, up = true, fetched = 0;
  const gateway = async () => { fetched++; return up ? reply(200, bytes) : reply(404, ""); };
  const status = () => vaultVersionStatus(plan, chain(state), { fetchImpl: gateway, cache, now: () => clock });
  assert.equal((await status()).ready.promote, true);
  // the answer is kept for a minute
  up = false; clock += 59000;
  const before = fetched;
  assert.equal((await status()).ready.promote, true);
  assert.equal(fetched, before);
  clock += 2000;
  let st = await status();
  assert.equal(st.upload, true);
  assert.equal(st.ready.promote, false);
  assert.match(st.blocked.promote, /pin\.test does not serve the component now/);
  up = true; clock += 61000;
  st = await status();
  assert.equal(st.ready.promote, true);
  assert.equal(st.blocked.promote, null);
  // a page started while the gateways do not serve it holds the promote too
  up = false;
  st = await vaultVersionStatus(plan, chain(state), { fetchImpl: gateway, cache: {}, now: () => clock });
  assert.equal(st.ready.promote, false);
  assert.match(st.blocked.promote, /does not serve the component now/);
  up = true;
  // once the deployment runs the version, the gateways are not asked
  const after = fetched;
  await vaultVersionStatus(plan, chain({ ...state, appRef: NEW, promoted: promotedHash(NEW, OPTION) }), { fetchImpl: gateway, cache, now: () => clock + 120000 });
  assert.equal(fetched, after);
});
