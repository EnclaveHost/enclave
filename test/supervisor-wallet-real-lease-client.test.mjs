// The Linux supervisor's REAL claim path (tryClaim -> sendLeaseTx, sliced from supervisor.js) driving the REAL app-funded
// lease client (client/lease-executor-client.mjs createLeaseClient, wired exactly as supervisor.js leaseGasSender wires
// onSigned) and a REAL relay service (network/lease-relay-service.mjs) on a local anvil chain (test/helpers/lease-gas-world.mjs),
// behind a proxy that counts relay POSTs and can delay /v1/info. A withdrawal of the host wallet permission after the
// operator queue's check but before the relay POST stops the signed lease in the client's own pre-relay hook: no POST, no
// claim on chain, no reserve gas. Fixture keys only; nothing leaves loopback.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import crypto from "node:crypto";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import * as B from "../client/lease-executor-client.mjs";
import { startRelayService } from "../network/lease-relay-service.mjs";
import { startWorld, haveAnvil } from "./helpers/lease-gas-world.mjs";
import { fixture, sleep, ref, source } from "./helpers/supervisor-wallet-fixture.mjs";

const T = { skip: !haveAnvil && "needs anvil", timeout: 180_000 };
let W, dir, svc, proxy, proxyUrl;
const seen = { posts: 0, infos: 0, infoDelayMs: 0, onInfo: null };
before(async () => {
  if (!haveAnvil) return;
  W = await startWorld();
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "wallet-real-client-"));
  const bytes = Buffer.from(JSON.stringify({ format: "enclave-lease-gas-deployment/v1", chainId: 8453,
    ...Object.fromEntries(["reserve", "executor", "ledger", "registry", "reserveCodeHash", "executorCodeHash"].map((k) => [k, W.addr[k]])) }));
  const rec = path.join(dir, "record.json"); fs.writeFileSync(rec, bytes);
  const key = generatePrivateKey(), kf = path.join(dir, "relay.key"); fs.writeFileSync(kf, key + "\n", { mode: 0o600 });
  await W.fund(privateKeyToAccount(key).address, 10n ** 16n);
  svc = await startRelayService({ recordFile: rec, digest: "sha256:" + crypto.createHash("sha256").update(bytes).digest("hex"), keyFile: kf,
    rpcs: [W.rpcUrl], allowLoopbackHttp: true, maxFloatEth: "0.02", log: () => {} });
  // the counting/delaying proxy in front of the relay: every POST is a lease handed to the relay
  proxy = http.createServer(async (req, res) => {
    const chunks = []; for await (const c of req) chunks.push(c);
    if (req.method === "POST") seen.posts++;
    if (req.method === "GET" && req.url.startsWith("/v1/info")) { seen.infos++; if (seen.onInfo) seen.onInfo(); if (seen.infoDelayMs) await sleep(seen.infoDelayMs); }
    const r = await fetch(svc.url + req.url, { method: req.method, headers: { "content-type": req.headers["content-type"] || "application/json" },
      body: req.method === "POST" ? Buffer.concat(chunks) : undefined });
    res.writeHead(r.status, { "content-type": r.headers.get("content-type") || "application/json" }); res.end(Buffer.from(await r.arrayBuffer()));
  });
  await new Promise((r) => proxy.listen(0, "127.0.0.1", r));
  proxyUrl = `http://127.0.0.1:${proxy.address().port}`;
});
after(async () => { proxy?.close(); await svc?.close(); W?.stop(); if (dir) fs.rmSync(dir, { recursive: true, force: true }); });

// a fresh funded, app-funded deployment, a zero-ETH operator, and the supervisor fixture as that host
async function world() {
  const owner = await W.owner(), id = await W.create(owner); await W.enable(owner, id);
  const op = await W.operator(`https://wallet-real-client-${crypto.randomBytes(4).toString("hex")}.test`);
  const f = fixture({ hostId: op.enclaveId });
  f.ctx.leaseGasActive = () => true;
  f.ctx.leaseGasError = (fn, i, e) => e;
  const client = B.createLeaseClient({ client: W.pc, account: op.account, reserve: W.addr.reserve, deployment: { chainId: 8453, ...W.addr },
    relays: [proxyUrl], allowLoopbackHttp: true, confirmations: 0,
    onSigned: (s) => (f.ctx._onLeaseSigned ? f.ctx._onLeaseSigned(s) : undefined) });   // supervisor.js leaseGasSender's wiring
  f.ctx.leaseGasSender = () => client;
  const d = f.row({ id, appRef: ref, leaseUntil: 0n, runner: "0x" + "00".repeat(32) });
  return { f, id, op, d };
}
const reset = () => { seen.posts = 0; seen.infos = 0; seen.infoDelayMs = 0; seen.onInfo = null; };

test("control: an allowed claim goes through the real client and relay and lands on chain, paid by the app's reserve", T, async () => {
  reset(); const { f, id, op, d } = await world();
  assert.match((await W.row(id)).runnerOperator, /^0x0{40}$/i, "unclaimed before");
  assert.equal(await f.ctx.tryClaim(d, { wasmRef: "catalog" }, [], {}, { hinted: true }), undefined);
  assert.equal(seen.posts, 1, "one lease handed to the relay");
  assert.equal((await W.row(id)).runnerOperator, op.address, "claimed on chain by this operator");
  assert.equal(await W.pc.getBalance({ address: op.address }), 0n, "zero host ETH");
  assert.deepEqual(f.s.adopted, ["claim"]);
});

test("a refusal that lands AFTER the operator queue's check, while the real client is reading its relay, stops the SIGNED lease before the relay: no POST, nothing on chain", T, async () => {
  reset(); const { f, id, d } = await world();
  const before = await W.reserveOf(id, (await W.row(id)).owner).catch(() => null);
  seen.infoDelayMs = 400;
  seen.onInfo = () => { seen.onInfo = null;   // the client is now past the queue gate and inside its relay work
    f.w.catalog = { ...f.w.catalog, yanked: true };
    void f.ctx.hostWalletDecision(d.id, ref, false).then((r) => { seen.refusal = r.refusal; }); };
  const why = await f.ctx.tryClaim(d, { wasmRef: "catalog" }, [], {}, { hinted: true });
  assert.equal(why, undefined, "tryClaim reports the failed send (logged), it does not throw");
  assert.ok(seen.refusal, "the separate admission call refused");
  assert.equal(seen.infos >= 1, true, "the real client did reach its relay read");
  assert.equal(seen.posts, 0, "the signed lease was given to NO relay (the client's onSigned refused it)");
  assert.match((await W.row(id)).runnerOperator, /^0x0{40}$/i, "nothing claimed on chain");
  if (before != null) assert.deepEqual(await W.reserveOf(id, (await W.row(id)).owner), before, "the reserve paid nothing");
  assert.deepEqual(f.s.adopted, []);
});

test("decision window with the real client: a refusal during openForUs means the claim never reaches the client at all", T, async () => {
  reset(); const { f, id, d } = await world();
  let release; const gate = new Promise((r) => { release = r; }); f.ctx.openForUs = async () => { await gate; return true; };
  const p = f.ctx.tryClaim(d, { wasmRef: "catalog" }, [], {}, { hinted: true }); await sleep(80);
  f.w.catalog = { ...f.w.catalog, yanked: true }; assert.ok((await f.ctx.hostWalletDecision(d.id, ref, false)).refusal);
  f.w.catalog = { ...f.w.catalog, yanked: false }; release(); await p;
  assert.equal(seen.infos, 0, "superseded at the operator queue: the client was never asked");
  assert.equal(seen.posts, 0); assert.match((await W.row(id)).runnerOperator, /^0x0{40}$/i);
});

test("source: supervisor.js wires the client's onSigned exactly as this test does", () => {
  assert.ok(source.includes("onSigned: (s) => (_onLeaseSigned ? _onLeaseSigned(s) : undefined)"));
});
