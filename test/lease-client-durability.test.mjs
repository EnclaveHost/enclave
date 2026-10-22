// Shared client (client/lease-executor-client.mjs): the caller's durable journal (onSigned) gates EVERY relay attempt.
// If it refuses a signed lease, the operation stops with NotPersisted and that lease reaches NO relay - neither the
// current one nor any later one (root review 14:54Z: it used to be caught as a relay error and the next relay tried).
// Local anvil (test/helpers/lease-gas-world.mjs); fixture keys only.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import * as B from "../client/lease-executor-client.mjs";
import { startWorld, haveAnvil } from "./helpers/lease-gas-world.mjs";

const T = { skip: !haveAnvil && "needs anvil", timeout: 120_000 };
let W, relay; const closers = [];
before(async () => {
  if (!haveAnvil) return;
  W = await startWorld();
  const k = generatePrivateKey(); await W.fund(privateKeyToAccount(k).address);
  relay = await B.startLeaseRelay({ client: W.pc, wallet: W.wc(k), deployment: { chainId: 8453, ...W.addr }, allowLoopbackHttp: true });
  closers.push(() => relay.close());
});
after(async () => { for (const c of closers) await c(); W?.stop(); });
/** A front that counts lease POSTs; `fail` answers them 502 without forwarding (a relay that took the request and failed). */
async function front({ fail = false } = {}) {
  let posts = 0;
  const s = http.createServer(async (req, res) => {
    const chunks = []; for await (const c of req) chunks.push(c);
    if (req.method === "POST") {
      posts++;
      if (fail) { res.writeHead(502, { "content-type": "application/json" }); return res.end('{"error":"upstream"}'); }
    }
    const x = await fetch(relay.url + req.url, req.method === "POST" ? { method: "POST", headers: { "content-type": "application/json" }, body: Buffer.concat(chunks) } : {});
    res.writeHead(x.status, { "content-type": "application/json" }); res.end(await x.text());
  });
  await new Promise((ok) => s.listen(0, "127.0.0.1", ok));
  closers.push(() => { s.closeAllConnections(); s.close(); });
  return { url: `http://127.0.0.1:${s.address().port}`, posts: () => posts };
}
const client = (op, relays, onSigned) => B.createLeaseClient({ client: W.pc, account: op.account, reserve: W.addr.reserve, deployment: { chainId: 8453, ...W.addr },
  relays, allowLoopbackHttp: true, confirmations: 0, requestTimeoutMs: 3000, onSigned });

test("a journal refusal of the FIRST signed lease: NotPersisted, and no relay receives anything", T, async () => {
  const owner = await W.owner(), id = await W.create(owner); await W.enable(owner, id);
  const op = await W.operator("https://durability-a.test");
  const a = await front(), b = await front();
  let calls = 0;
  await assert.rejects(client(op, [a.url, b.url], () => { calls++; throw new Error("EIO: disk"); }).claim(id, op.enclaveId),
    (e) => e.code === "NotPersisted" && /sent to no relay/.test(e.message));
  assert.equal(calls, 1);
  assert.equal(a.posts() + b.posts(), 0, "no POST to any relay");
  assert.match((await W.row(id)).runner, /^0x0{64}$/);
});

test("a journal refusal on the SECOND relay's lease: the first (journaled) lease was sent, the second reaches no relay", T, async () => {
  const owner = await W.owner(), id = await W.create(owner); await W.enable(owner, id);
  const op = await W.operator("https://durability-b.test");
  const a = await front({ fail: true }), b = await front();
  const journaled = [];
  await assert.rejects(client(op, [a.url, b.url], (s) => { if (journaled.length) throw new Error("EIO: disk"); journaled.push(s); }).claim(id, op.enclaveId),
    (e) => e.code === "NotPersisted");
  assert.equal(a.posts(), 1, "the first, journaled lease went to the first relay");
  assert.equal(b.posts(), 0, "the unjournaled second lease went nowhere");
  assert.equal(journaled.length, 1);
  // and a journal that works: the same operation lands, through the honest relay
  const ok = await client(op, [b.url], () => {}).claim(id, op.enclaveId);
  assert.equal(ok.receipt.status, "success");
});
