import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { createHash, generateKeyPairSync, randomBytes, sign } from "node:crypto";
import { createPadsLedger, createShipmentStore, padsRouter, signedMessage, PAD_INDEX_LIMIT } from "../relay/pads.mjs";
import { mergeAck, ackProgress, MAX_ACK_RANGES } from "../relay/pad-ack.mjs";

const hash = b => createHash("sha256").update(b).digest("hex");
function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pad-ack-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const ed = generateKeyPairSync("ed25519"), x = generateKeyPairSync("x25519");
  const der = ed.publicKey.export({ type: "spki", format: "der" });
  const tunnel = { name: "phone1", keyFp: hash(der), spki: der.toString("base64"),
    padKey: x.publicKey.export({ type: "spki", format: "der" }).subarray(-32).toString("hex") };
  const hub = { info: name => name === tunnel.name ? tunnel : null, origins: () => [{ name: tunnel.name }] };
  const open = () => createPadsLedger({ dir, hub, log: () => {} });
  let ledger = open();
  function request(kind, values) {
    const nonce = randomBytes(16).toString("hex"), name = tunnel.name;
    return { name, ...values, nonce, sig: sign(null, Buffer.from(signedMessage(kind, [name, ...Object.values(values), nonce])), ed.privateKey).toString("hex") };
  }
  const seed = ledger.seed(request("seed", {})).body.seed_id, store = createShipmentStore({ dir });
  const ack = (lo, count, sha256) => request("ack", { seed_id: seed, index0: lo, count, sha256 });
  async function put(lo, count, body = Buffer.from(`shipment:${lo}:${count}`)) {
    const p = store.plan(seed, `${seed}-${lo}-${count}.pads`), sha = hash(body);
    fs.writeFileSync(p.tmp, body); await store.commit(p, sha, body.length);
    try { fs.unlinkSync(p.tmp); } catch {}
    return sha;
  }
  return { dir, open, ledger, seed, store, ack, request, put, tunnel };
}

test("PADACK requires this seed's signature and exact stored bytes; it never substitutes the reservation mark", async t => {
  const f = fixture(t), { ledger: L, seed, store } = f;
  assert.equal(L.reserve(f.request("reserve", { seed_id: seed, want: 64 })).status, 200);
  assert.equal(L.mark(seed).ack_floor, 0);
  const sha = await f.put(0, 7), good = f.ack(0, 7, sha);
  assert.equal((await L.ack({ ...good, count: 8 }, store)).status, 403);
  assert.equal((await L.ack(f.ack(7, 9, sha), store)).body.error, "ack_shipment_missing");
  assert.equal((await L.ack(f.ack(0, 7, "00".repeat(32)), store)).body.error, "digest_mismatch");
  for (const [lo, count] of [[-1, 1], [0, 0], [PAD_INDEX_LIMIT, 1], [1, PAD_INDEX_LIMIT], [0.5, 1], ["0", 1]])
    assert.equal((await L.ack(f.ack(lo, count, sha), store)).status, 400);
  assert.equal((await L.ack({ ...good, name: "foreign" }, store)).status, 403);
  assert.equal((await L.ack(good, store)).body.ack_floor, 7);
  assert.equal(L.mark(seed).mark, 64);
  assert.equal(L.pvm(f.tunnel.name).ack_floor, 7);
  assert.equal(L.consumers()[0].ack_floor, 7);
  store.remove(seed, `${seed}-0-7.pads`);
  for (let i = 0; i < 270; i++) L.reserve(f.request("reserve", { seed_id: seed, want: 1 }));
  const restarted = f.open();
  assert.equal((await restarted.ack(good, store)).status, 200, "exact retry works after prune, nonce churn, restart");
  assert.equal(restarted.mark(seed).ack_floor, 7);
  assert.equal(restarted.mark(seed).mark, 334);
});

test("out-of-order and concurrent ACKs preserve the union, including across an asynchronous store read", async t => {
  const f = fixture(t), high = f.ack(7, 9, await f.put(7, 9)), low = f.ack(0, 7, await f.put(0, 7));
  let release;
  const gated = { digest: async (...args) => { await new Promise(r => { release = r; }); return f.store.digest(...args); } };
  const pending = f.ledger.ack(low, gated);
  assert.deepEqual((await f.ledger.ack(high, f.store)).body.acked, [[7, 16]]);
  assert.deepEqual(f.open().mark(f.seed).acked, [[7, 16]]);
  release();
  const r = await pending;
  assert.equal(r.body.ack_floor, 16); assert.deepEqual(r.body.acked, []);
  assert.equal(f.open().mark(f.seed).ack_floor, 16);
});

test("failed ACK persistence cannot advertise a floor that permits pruning", async t => {
  const f = fixture(t), req = f.ack(0, 8, await f.put(0, 8));
  const original = fs.fsyncSync;
  fs.fsyncSync = () => { throw new Error("injected sync failure"); };
  try { await assert.rejects(f.ledger.ack(req, f.store), /injected sync failure/); }
  finally { fs.fsyncSync = original; }
  assert.equal(f.ledger.mark(f.seed).ack_floor, 0);
  assert.equal(f.open().mark(f.seed).ack_floor, 0);
  assert.equal((await f.ledger.ack(req, f.store)).body.ack_floor, 8);
});

test("range memory is bounded without dropping gaps or already acknowledged coverage", () => {
  let p = ackProgress(null);
  for (let i = 0; i < MAX_ACK_RANGES; i++) p = mergeAck(p, i * 2 + 1, i * 2 + 2);
  assert.equal(p.acked.length, MAX_ACK_RANGES);
  assert.equal(mergeAck(p, 1000, 1001), null);
  p = mergeAck(p, 0, 128);
  assert.equal(p.ack_floor, 128); assert.deepEqual(p.acked, []);
  for (const invalid of [{ ack_floor: -1 }, { acked: [[0, 1]] }, { acked: [[3, 6], [5, 7]] }, { acked: "bad" }])
    assert.throws(() => ackProgress(invalid), /invalid persisted/);
});

test("the HTTP store records computed hashes, upgrades old files, and refuses concurrent ciphertext replacement", async t => {
  const f = fixture(t);
  const json = (res, status, body) => { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(body)); };
  const readBody = async req => { const chunks = []; for await (const c of req) chunks.push(c); return Buffer.concat(chunks); };
  const router = padsRouter({ ledger: f.ledger, store: f.store, dealerToken: "fixture", json, readBody });
  const server = http.createServer((req, res) => router(req, res, new URL(req.url, "http://x")).catch(e => json(res, 500, { error: e.message })));
  await new Promise(r => server.listen(0, "127.0.0.1", r));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const name = `${f.seed}-0-8.pads`, url = `${base}/v1/pads/shipments/${f.seed}/${name}`;
  const bodies = [Buffer.alloc(300000, 1), Buffer.alloc(300000, 2)];
  const upload = b => fetch(`${url}?sha256=${hash(b)}`, { method: "PUT", headers: { authorization: "Bearer fixture" }, body: b });
  const uploaded = await Promise.all(bodies.map(upload));
  assert.deepEqual(uploaded.map(r => r.status).sort(), [200, 409]);
  const winner = bodies[uploaded.findIndex(r => r.status === 200)];
  assert.equal((await upload(winner)).status, 200, "same ciphertext retry is idempotent");
  assert.deepEqual(Buffer.from(await (await fetch(url)).arrayBuffer()), winner);
  assert.equal(f.store.list(f.seed)[0].sha256, hash(winner));
  assert.equal(await f.store.digest(f.seed, name), hash(winner));
  const ack = await fetch(`${base}/v1/pads/ack`, { method: "POST", body: JSON.stringify(f.ack(0, 8, hash(winner))) });
  assert.equal(ack.status, 200); assert.equal((await ack.json()).ack_floor, 8);
  const old = f.store.plan(f.seed, `${f.seed}-8-8.pads`); fs.writeFileSync(old.final, "old ciphertext");
  assert.equal(await f.store.digest(f.seed, old.name), hash("old ciphertext"));
  assert.equal(f.store.list(f.seed)[1].sha256, hash("old ciphertext"));
  for (const bad of [`${f.seed}-00-8.pads`, `${f.seed}-8-0.pads`, `${f.seed}-${PAD_INDEX_LIMIT}-1.pads`, `${"ab".repeat(16)}-0-8.pads`])
    assert.equal(f.store.plan(f.seed, bad), null);
});
