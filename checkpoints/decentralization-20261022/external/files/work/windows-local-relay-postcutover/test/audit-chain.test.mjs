// audit-chain.mjs auditChain() on a LOCAL anvil (chain 8453; main's lease-gas world: the reviewed reserve, executor, ledger
// and registry sources). Real app-funded leases are relayed by two in-process relays (main's startLeaseRelay):
//   K = the "moved" payee (the us-west key);   E = the eu-central fallback payee.
// A K payment BEFORE the cutover stands for the us-west era (the same key on DigitalOcean): it must never count. After the
// cutover, K's payments must be found in "minipc's" relay log (here: K's own relay's log lines, parsed exactly as
// collect-minipc.sh extracts them). The audit reads through two loopback RPC endpoints (quorum 2); fixture keys only.
import { before, after, test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createHash } from "node:crypto";
const HERE = path.dirname(fileURLToPath(import.meta.url)), MAIN = path.resolve(HERE, "../../enclave");
const imp = (p) => import(pathToFileURL(path.join(MAIN, p)).href);
const { startWorld, haveAnvil } = await imp("test/helpers/lease-gas-world.mjs");
const B = await imp("client/lease-executor-client.mjs");
const viem = await imp("node_modules/viem/_esm/index.js");
const { generatePrivateKey, privateKeyToAccount } = await imp("node_modules/viem/_esm/accounts/index.js");
const { auditChain } = await import("../audit-chain.mjs");
const { findCutoverBlock } = await import("../find-cutover-block.mjs");
const T = { skip: !haveAnvil && "needs anvil", timeout: 300_000 };
const sha = (b) => createHash("sha256").update(b).digest("hex");
let W, op, owner, record, digest, K, E, relayK, relayE, logK = [], clients, servers = [], apps = [], pre, cut, post = {};

const parseLog = (lines) => lines.map((l) => /\[relay\] (success|reverted) (0x[0-9a-fA-F]{64}) paid (\d+|none)/.exec(l)).filter(Boolean).map((m) => ({ status: m[1], hash: m[2].toLowerCase(), paid: m[3] }));
let refuseReceipts = false;   // TEST-ONLY: the second endpoint stands for a provider that cannot serve receipts (unavailable/lagging)
async function forwarder(target) {   // a second, distinct loopback RPC endpoint for the quorum
  const s = http.createServer((req, res) => { const c = []; req.on("data", (d) => c.push(d)); req.on("end", () => {
    if (refuseReceipts && /eth_getTransactionReceipt/.test(Buffer.concat(c).toString())) { res.writeHead(503); return res.end(); }
    const up = http.request(target, { method: "POST", headers: { "content-type": "application/json" } }, (r) => { res.writeHead(r.statusCode, { "content-type": "application/json" }); r.pipe(res); });
    up.on("error", () => { res.writeHead(502); res.end(); }); up.end(Buffer.concat(c)); }); });
  await new Promise((ok) => s.listen(0, "127.0.0.1", ok)); servers.push(s); return `http://127.0.0.1:${s.address().port}`;
}
async function app() { const id = await W.create(owner, { fund6: 0n }); await W.enable(owner, id, { p: { claimPolicy: 1, renewWindow: 60, minExtension: 60 } }); apps.push(id); return id; }
const host = (relays) => B.createLeaseClient({ client: W.pc, account: op.account, reserve: W.addr.reserve, deployment: record.obj, relays, allowLoopbackHttp: true, confirmations: 0, requestTimeoutMs: 5000 });
const expectFor = () => ({ apps, operator: op.address, relay: { payee: K.address }, fallbackPayee: E.address, quorum: 2 });
const audit = (cutover, relayLog = parseLog(logK)) => auditChain({ clients, recordBytes: record.bytes, digest, expect: expectFor(), cutover, relayLog, allowLoopbackHttp: true, confirmations: 0 });
async function marker() {   // the activation "finishes"; root's marker is then the first block at or after it (find-cutover-block.mjs)
  await new Promise((ok) => setTimeout(ok, 1100));
  await W.rpc("evm_mine", []);
  const b = await W.pc.getBlock();
  const activatedAt = new Date(Number(b.timestamp) * 1000).toISOString();
  const found = await findCutoverBlock({ clients, quorum: 2, activatedAt, allowLoopbackHttp: true });
  assert.equal(found.cutoverBlock, Number(b.number), "the helper finds the first block at or after the activation");
  return { cutoverBlock: found.cutoverBlock, activatedAt };
}

before(async () => {
  if (!haveAnvil) return;
  W = await startWorld();
  const obj = { format: "enclave-lease-gas-deployment/v1", chainId: 8453, ...Object.fromEntries(["reserve", "executor", "ledger", "registry", "reserveCodeHash", "executorCodeHash"].map((k) => [k, W.addr[k]])) };
  record = { obj, bytes: Buffer.from(JSON.stringify(obj)) }; digest = "sha256:" + sha(record.bytes);
  K = { key: generatePrivateKey() }; K.address = privateKeyToAccount(K.key).address;
  E = { key: generatePrivateKey() }; E.address = privateKeyToAccount(E.key).address;
  for (const x of [K, E]) await W.fund(x.address, 10n ** 16n);
  relayK = await B.startLeaseRelay({ client: W.pc, wallet: W.wc(K.key), deployment: obj, allowLoopbackHttp: true, log: (m) => logK.push(m) });
  relayE = await B.startLeaseRelay({ client: W.pc, wallet: W.wc(E.key), deployment: obj, allowLoopbackHttp: true });
  op = await W.operator("https://minipc.postcutover.test"); owner = await W.owner();
  await W.write(owner.key, W.addr.registry, W.A.registry.abi, "setPayoutWallet", [op.enclaveId]);
  clients = [W.rpcUrl, await forwarder(W.rpcUrl)].map((url) => viem.createPublicClient({ transport: viem.http(url, { retryCount: 0 }) }));
  // the us-west era: K relays a claim BEFORE the cutover
  const a0 = await app(); pre = await host([relayK.url]).claim(a0, op.enclaveId);
  cut = await marker();
  // after the cutover: K (minipc's relay) claims one app, E (eu-central) another
  const a1 = await app(); post.k = await host([relayK.url]).claim(a1, op.enclaveId);
  const a2 = await app(); post.e = await host([relayE.url]).claim(a2, op.enclaveId);
  await W.rpc("evm_mine", []);
});
after(async () => { await relayK?.close(); await relayE?.close(); for (const s of servers) s.close(); W?.stop(); });

test("after the cutover: the moved payee's payment is VERIFIED and found in minipc's relay log; the pre-cutover K payment never counts", T, async () => {
  const r = await audit(cut);
  assert.equal(r.status, "LOCAL_VERIFIED", JSON.stringify(r.failures));
  assert.deepEqual([r.counts.moved, r.counts.fallback, r.counts.failed], [1, 1, 0]);
  const m = r.events.find((e) => e.relay === "moved");
  assert.equal(m.transactionHash, post.k.hash.toLowerCase()); assert.equal(m.minipcRelayLog, "success"); assert.equal(m.kind, 1);
  assert.ok(BigInt(m.chargedWei) > 0n, "charged to the app's reserve");
  assert.ok(!r.events.some((e) => e.transactionHash === pre.hash.toLowerCase()), "the us-west-era payment is outside the window");
  assert.equal(r.events.find((e) => e.relay === "fallback").transactionHash, post.e.hash.toLowerCase());
  assert.equal(r.window.fromBlock, String(cut.cutoverBlock)); assert.equal(r.absenceProven, false);
});

test("a moved-payee payment that is NOT in minipc's relay log FAILS: the key was used elsewhere", T, async () => {
  const r = await audit(cut, parseLog(logK).filter((l) => l.hash !== post.k.hash.toLowerCase()));
  assert.equal(r.status, "FAILED"); assert.match(r.failures[0].error, /not routed through minipc's relay/);
});

test("a window starting before the cutover would include us-west payments: the pre-cutover K payment then fails the log check", T, async () => {
  const early = { cutoverBlock: Number(pre.receipt.blockNumber), activatedAt: new Date(0).toISOString() };
  const r = await audit(early, parseLog(logK).filter((l) => l.hash !== pre.hash.toLowerCase()));   // minipc never relayed it
  assert.equal(r.status, "FAILED", "an earlier us-west payment is never taken as local routing");
});

test("the marker is required and must not predate the cutover block", T, async () => {
  await assert.rejects(audit(null), /cutover marker is required/);
  await assert.rejects(audit({ cutoverBlock: cut.cutoverBlock, activatedAt: new Date(Date.now() + 3600_000).toISOString() }), /BEFORE the activation/);
});

test("nothing after the marker is NO_EVENTS_YET; only eu-central is FALLBACK_ONLY - both pending, never success", T, async () => {
  const later = await marker();
  assert.equal((await audit(later)).status, "NO_EVENTS_YET");
  const a3 = await app(); await host([relayE.url]).claim(a3, op.enclaveId); await W.rpc("evm_mine", []);
  const r = await audit(later);
  assert.equal(r.status, "FALLBACK_ONLY"); assert.deepEqual([r.counts.moved, r.counts.fallback], [0, 1]);
});

test("a provider that cannot serve receipts makes payments UNVERIFIED (proof not observed), never FAILED; per-provider diagnostics are recorded", T, async () => {
  const normal = await audit(cut);   // every payment in the window, verified, with both providers answering
  refuseReceipts = true;
  try {
    const r = await audit(cut);
    assert.equal(r.status, "UNVERIFIED_ONLY", JSON.stringify(r.failures));
    assert.equal(r.failures.length, 0); assert.equal(r.counts.unverified, normal.counts.moved + normal.counts.fallback, "each one unverified, none failed");
    const u = r.unverified.find((x) => x.transactionHash === post.k.hash.toLowerCase());
    assert.match(u.error, /proof not observed/); assert.equal(u.minipcRelayLog, "success");
    assert.deepEqual(u.providers.map((p) => p.ok), [true, false], "one provider verified it alone, the other could not answer");
  } finally { refuseReceipts = false; }
  assert.equal((await audit(cut)).status, "LOCAL_VERIFIED", "with both providers answering it verifies again");
});
