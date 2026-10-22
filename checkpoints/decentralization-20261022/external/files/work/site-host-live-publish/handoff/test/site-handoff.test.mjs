// Site activation handoff: the exact five-step flow and its refusals, against an in-memory Base model (deployed ABIs),
// an injected wallet (a fixture key standing in for the admin) and an injected upload gateway. Nothing touches a network.
//   - plan: the production calldata equals the CLI-path encodings probed on chain; stage B equals the approved ops
//   - flow: upload authorization -> upload + CID/CAR -> publish -> create -> handover -> reviewed queue deposit + configure
//   - refusals: account, chain, destination, tampered artifact, wrong CID, malformed replies/CAR, counter/version moved,
//     pending tx, provider disagreement, wallet-altered transaction, non-canonical receipt, expiry
//   - transport: host/origin/token/CSRF, double click, interrupted submission and recovery, restart
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { encodeFunctionData, decodeFunctionData } from "../../../enclave/node_modules/viem/_esm/index.js";
import { privateKeyToAccount } from "../../../enclave/node_modules/viem/_esm/accounts/index.js";
import { importFile, cidString } from "../../../enclave/scripts/site-release/unixfs.mjs";
import { SITE, sitePlan, CATALOG_ABI } from "../site-trust.mjs";
import { prepareSiteTx, verifySiteTx, checkSiteLanding, makeStageBPrecheck } from "../site-chain.mjs";
import { uploadMessage, runUpload, frozenWasm, verifyCar, checkUploadSignature } from "../site-upload.mjs";
import { reserveOperations, createReserveQueue } from "../reserve-queue.mjs";
import * as reviewedChain from "../../../lease-enrollment-signing/chain.mjs";
import { ENROLLMENT } from "../../../lease-enrollment-signing/trust.mjs";
import { LOGS, KEY, OTHER, wallet, ADMIN, abi, FROZEN, fixture, carOf, UNIQUE, GOOD_CAR, resp, gateway, hit, launch, signUpload, sendStep, fileJournals, gc, upload } from "./site-harness.mjs";

test.afterEach(() => gc());   // each upload holds the 46 MB artifact: free it before the next test (site-harness.mjs)

// ---- plan ------------------------------------------------------------------------------------------------------------
test("production plan: deployed-ABI calldata equals the on-chain-simulated CLI encodings; stage B equals the approved ops", () => {
  const plan = sitePlan(SITE), p1 = JSON.parse(fs.readFileSync(path.join(LOGS, "probe.json"))), p4 = JSON.parse(fs.readFileSync(path.join(LOGS, "probe4.json")));
  // The on-chain probes simulated the FIRST frozen package (upload CID bafybeihfcjkk…, release bafybeibs6…). The recovery
  // package changes only the version's CID and its release pin: the same encoder with those two old values reproduces the
  // probed calldata byte for byte, and the new calldata decodes to the same arguments except exactly those two.
  const OLD = { cid: "bafybeihfcjkkynfm6fumslxrziib2yinq52krrnjzgpqkf6fhwnh7wrad4", release: "bafybeibs6ouoiqwsr632yvb4ffvmpee4bvxhiaqdg64khrijnt6lgbt3na" };
  const old = sitePlan({ ...SITE, expectedCid: OLD.cid, release: OLD.release, publish: { ...SITE.publish, config: JSON.stringify({ release: OLD.release, wasi: "0.2" }) } });
  assert.equal(old.publishData, p1.publishCall.data, "publishVersion calldata of the probed package");
  assert.notEqual(SITE.expectedCid, OLD.cid); assert.notEqual(SITE.release, OLD.release);
  const argsOf = (d) => decodeFunctionData({ abi: CATALOG_ABI, data: d }).args;
  const now = argsOf(plan.publishData), then = argsOf(old.publishData);
  assert.deepEqual(now.map((x, i) => (i === 4 || i === 7 ? null : x)), then.map((x, i) => (i === 4 || i === 7 ? null : x)), "only the CID and the config differ");
  assert.equal(now[4], SITE.expectedCid); assert.equal(now[7], JSON.stringify({ release: SITE.release, wasi: "0.2" }));
  assert.equal(plan.createData, p4.create.data, "create calldata");
  assert.equal(plan.appId, p1.catalog.appIdOfOwnerSlug);
  assert.equal(SITE.predictedId, p4.perProvider[0].predictedDeploymentId);
  assert.deepEqual(plan.steps.map((s) => [s.n, s.step, s.kind, s.amountWei]), [[1, "upload", "personal_sign", "0"], [2, "publish", "transaction", "0"], [3, "create", "transaction", "0"]]);
  assert.equal(plan.steps[1].to, SITE.catalog); assert.equal(plan.steps[2].to, SITE.ledger.toLowerCase());
  const b = reserveOperations({ id: SITE.predictedId, depositWei: SITE.stageB.depositWei, abi });
  assert.equal(b.opsSha256, SITE.stageB.approvedOpsSha256);
  assert.deepEqual(b.operations.map((o) => [o.kind, o.to, o.value]), [["deposit", ENROLLMENT.reserve, "0x38d7ea4c68000"], ["configure", ENROLLMENT.reserve, "0x0"]]);
  assert.equal(cidString(FROZEN.dag.cid), SITE.expectedCid);
});
test("the frozen artifact is refused if its size, bytes or CID differ", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "site-wasm-")), f = path.join(tmp, "w.wasm");
  const b = Buffer.from(FROZEN.bytes); b[1000] ^= 1; fs.writeFileSync(f, b);
  assert.throws(() => frozenWasm({ ...SITE, wasm: { ...SITE.wasm, path: f } }), /not the pinned artifact/);
  fs.writeFileSync(f, FROZEN.bytes.subarray(0, 1000));
  assert.throws(() => frozenWasm({ ...SITE, wasm: { ...SITE.wasm, path: f } }), /not the pinned size/);
  assert.throws(() => frozenWasm({ ...SITE, expectedCid: "bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi" }), /does not import to the pinned CID/);
});

// ---- the five-step flow ----------------------------------------------------------------------------------------------
test("exact five-step flow: upload auth -> verified upload -> publish -> create -> handover -> reviewed queue deposit + configure", async () => {
  const fx = fixture(), h = await launch(fx);
  try {
    assert.equal((await hit(h.origin, "/start", { token: h.token })).status, 200);
    const { prepared, res, signature } = await signUpload(h);
    assert.match(prepared.message, new RegExp(`^enclave-upload:${SITE.wasm.sha256}:\\d+$`));
    assert.ok(prepared.expiry - Math.floor(Date.now() / 1000) <= 300 && prepared.expiry - Math.floor(Date.now() / 1000) >= 295);
    assert.equal(res.status, 200, JSON.stringify(res.json)); assert.equal(res.json.upload.status, "uploaded"); assert.equal(res.json.upload.cid, SITE.expectedCid);
    assert.equal(h.gw.seen.uploadedSha, SITE.wasm.sha256); assert.equal(h.gw.seen.uploadedBytes, SITE.wasm.bytes); assert.equal(h.gw.seen.car, 1);
    // the token and the signature are never journaled or shown
    const persisted = JSON.stringify(Object.fromEntries(Object.entries(h.journals).map(([k, j]) => [k, j.read()]))) + JSON.stringify(res.json);
    assert.ok(!persisted.includes(signature.slice(2, 40)) && !persisted.includes(h.gw.seen.tokens[0]));
    const pub = await sendStep(h, fx, "publish");
    assert.equal(pub.prepared.transaction.to, fx.t.catalog); assert.equal(pub.prepared.transaction.data, fx.plan.publishData); assert.equal(pub.prepared.transaction.value, "0x0");
    assert.equal(pub.res.json.verification.outcome, "confirmed");
    const cr = await sendStep(h, fx, "create");
    assert.equal(cr.res.json.verification.deploymentId, fx.t.predictedId.toLowerCase());
    assert.ok(cr.res.json.stageB.url, "handover after the verified Created receipt");
    // stage B: the reviewed queue, unchanged, for exactly the approved two operations
    const B = h.stageB.url, q = (await (await fetch(B + "/queue")).json());
    assert.deepEqual(q.operations.map((o) => [o.kind, o.amountWei]), [["deposit", "1000000000000000"], ["configure", "0"]]);
    const bh = (p, body) => hit(B, p, { token: q.token, body });
    assert.equal((await bh("/start")).status, 200);
    for (const i of [0, 1]) {
      const p = await bh("/prepare", { index: i }); assert.equal(p.status, 200, JSON.stringify(p.json));
      const r = await bh("/result", { index: i, hash: fx.model.land(p.json.transaction) }); assert.equal(r.json.verification.outcome, "confirmed");
    }
    const st = fx.model.exec(structuredClone(fx.model.state), ADMIN, fx.t.reserve, encodeFunctionData({ abi, functionName: "statusOf", args: [fx.t.predictedId, 1, fx.t.minipc.hostId, fx.t.minipc.operator] }));
    assert.equal(BigInt(st.returnData.slice(0, 66)), 0n, "the reserve is Ready for minipc");
    assert.equal(fx.model.state.nonce, 44, "exactly four transactions landed");
  } finally { await h.close(); }
});

// ---- upload refusals ---------------------------------------------------------------------------------------------------
test("upload: another signer, an expired or altered authorization, and malformed or foreign token replies are refused", async () => {
  const fx = fixture(), now = Date.now(), auth = uploadMessage(fx.t, now);
  const good = await wallet.signMessage({ message: auth.message }), other = await privateKeyToAccount(OTHER).signMessage({ message: auth.message });
  await assert.rejects(checkUploadSignature(fx.t, auth, other, now), /not the admin's/);
  await assert.rejects(checkUploadSignature(fx.t, auth, good, now + 290_000), /expired/);
  await assert.rejects(checkUploadSignature(fx.t, { ...auth, message: auth.message.replace(/:\d+$/, ":1") }, good, now), /not this artifact's/);
  await assert.rejects(checkUploadSignature(fx.t, auth, "0x1234", now), /65-byte/);
  for (const tokenReply of [() => ({ token: "short" }), (b, who) => ({ token: "x".repeat(40), address: "0x" + "11".repeat(20), expiry: b.expiry }), (b, who) => ({ token: "x".repeat(40), address: who, expiry: b.expiry + 1 })])
    await assert.rejects(upload({ t: fx.t, auth, signature: good, fetchFn: gateway(fx.t, { tokenReply }).fetchFn, nowMs: now }), /upload token/);
});
test("upload: a wrong CID, a malformed reply, an oversized reply, and a tampered, short or padded CAR are refused; nothing is published", async () => {
  const fx = fixture(), now = Date.now(), auth = uploadMessage(fx.t, now), sig = await wallet.signMessage({ message: auth.message });
  const run = (o) => upload({ t: fx.t, auth, signature: sig, fetchFn: gateway(fx.t, o).fetchFn, nowMs: now });
  await assert.rejects(run({ addReply: JSON.stringify({ cid: "bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi" }) }), /a CID other than the expected/);
  await assert.rejects(run({ addReply: "<html>" }), /not JSON/);
  await assert.rejects(run({ addReply: JSON.stringify({ cid: fx.t.expectedCid, pad: "x".repeat(70000) }) }), /larger than/);
  const blocks = UNIQUE;
  const tampered = blocks.map(([k, b], i) => [k, i === 3 ? Buffer.from(b).fill(0, 0, 8) : b]);
  await assert.rejects(run({ carReply: () => resp(200, carOf(fx.t.expectedCid, tampered)) }), /does not hash/);
  await assert.rejects(run({ carReply: () => resp(200, carOf(fx.t.expectedCid, blocks.slice(1))) }), /lacks 1/);
  const foreign = importFile(Buffer.from("not the site")).blocks;
  await assert.rejects(run({ carReply: () => resp(200, carOf(fx.t.expectedCid, [...blocks, ...foreign])) }), /not in the frozen file's DAG/);
  await assert.rejects(run({ carReply: () => resp(200, Buffer.alloc(10), { "content-length": String(fx.t.upload.maxCarBytes + 1) }) }), /larger than/);
  assert.deepEqual(verifyCar(fx.t, GOOD_CAR, FROZEN.dag).blocks, blocks.length);
  // through the server: a failed upload returns to ready (no publish possible) and its error carries no secret
  const h = await launch(fx, { gw: gateway(fx.t, { addReply: JSON.stringify({ cid: "bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi" }) }) });
  try {
    await hit(h.origin, "/start", { token: h.token });
    const { res, signature } = await signUpload(h);
    assert.equal(res.status, 409); assert.ok(!JSON.stringify(res.json).includes(signature.slice(2, 40)));
    assert.equal((await hit(h.origin, "/tx/prepare", { token: h.token, body: { step: "publish" } })).status, 409);
  } finally { await h.close(); }
});

// ---- chain refusals ----------------------------------------------------------------------------------------------------
test("prepare refuses: admin code (7702), wrong chain, another catalog/owner, changed code, existing version, pending tx, provider disagreement, expiry", async () => {
  const cases = [
    ["7702", (m) => { m.state.adminCode = "0xef0100" + "11".repeat(20); }, /admin account has code/],
    ["book", (m) => { m.state.book.appCatalog = "0x" + "22".repeat(20); }, /names another catalog/],
    ["owner", (m) => { m.state.catalogOwner = "0x" + "33".repeat(20); }, /catalog owner is not the admin/],
    ["code", (m) => { m.state.codes[SITE.catalog] = "0x6099"; }, /runtime code is not the pinned/],
    ["version", (m) => { m.exec(m.state, ADMIN, SITE.catalog, sitePlan(fixture().t).publishData); }, /already holds a version/],
    ["pending", (m) => { m.state.pendingExtra = 1; }, /pending/],
  ];
  for (const [name, f, re] of cases) {
    const fx = fixture(); f(fx.model);
    await assert.rejects(prepareSiteTx({ t: fx.t, plan: fx.plan, step: "publish", clients: fx.model.clients() }), re, name);
  }
  const fx = fixture();
  await assert.rejects(prepareSiteTx({ t: fx.t, plan: fx.plan, step: "publish", clients: fx.model.clients([null, (m, a, r) => (m === "getChainId" ? 1 : r)]) }), /wrong chain/);
  await assert.rejects(prepareSiteTx({ t: fx.t, plan: fx.plan, step: "publish", clients: fx.model.clients([null, (m, a, r) => (m === "getBlock" ? { ...r, hash: "0x" + "44".repeat(32) } : r)]) }), /disagree on the anchor/);
  await assert.rejects(prepareSiteTx({ t: fx.t, plan: fx.plan, step: "publish", clients: fx.model.clients(), now: Date.now() - fx.t.maxAgeMs - 1 }), /expired/);
  assert.equal((await prepareSiteTx({ t: fx.t, plan: fx.plan, step: "publish", clients: fx.model.clients() })).transaction.data, fx.plan.publishData);
});
test("create refuses when the owner's deployment counter or the published version or minipc's payout moved; replan, never re-aim", async () => {
  const publishOk = (fx) => fx.model.exec(fx.model.state, ADMIN, fx.t.catalog, fx.plan.publishData);
  let fx = fixture(); publishOk(fx);
  fx.model.exec(fx.model.state, ADMIN, fx.t.ledger, fx.plan.createData);   // another create by the owner moved the counter
  await assert.rejects(prepareSiteTx({ t: fx.t, plan: fx.plan, step: "create", clients: fx.model.clients() }), /deployment counter moved/);
  fx = fixture(); await assert.rejects(prepareSiteTx({ t: fx.t, plan: fx.plan, step: "create", clients: fx.model.clients() }), /exactly the one published version/);
  fx = fixture(); publishOk(fx); fx.model.state.versions[fx.plan.appId][0].config = "{}";
  await assert.rejects(prepareSiteTx({ t: fx.t, plan: fx.plan, step: "create", clients: fx.model.clients() }), /release pin/);
  fx = fixture(); publishOk(fx); fx.model.state.registry[fx.t.minipc.hostId].payoutWallet = "0x" + "55".repeat(20);
  await assert.rejects(prepareSiteTx({ t: fx.t, plan: fx.plan, step: "create", clients: fx.model.clients() }), /payout wallet is not the admin/);
  fx = fixture(); publishOk(fx);
  const ops = reserveOperations({ id: fx.t.predictedId, depositWei: fx.t.stageB.depositWei, abi, base: fx.base }).operations;
  const stageBPrecheck = makeStageBPrecheck({ t: fx.t, plan: fx.plan, operations: ops, reserveAbi: abi });
  const ok = await prepareSiteTx({ t: fx.t, plan: fx.plan, step: "create", clients: fx.model.clients(), stageBPrecheck });
  assert.equal(ok.transaction.to, fx.t.ledger.toLowerCase()); assert.equal(ok.transaction.data, fx.plan.createData);
  assert.equal(ok.stageBPrecheck.statusOfClaimOnMinipc, 0); assert.equal(ok.stageBPrecheck.claimableByMinipc, true); assert.equal(ok.stageBPrecheck.reserveAvailableWei, "1000000000000000");
  assert.match(ok.stageBPrecheck.label, /simulation only/);
  assert.equal(fx.model.state.deps[fx.t.predictedId.toLowerCase()], undefined, "the pre-check changed no state");
  // the same pre-check refuses when the reserve would not be Ready (the self-hosted premise broken mid-bundle)
  const broken = makeStageBPrecheck({ t: fx.t, plan: fx.plan, operations: ops.slice(0, 1), reserveAbi: abi });
  await assert.rejects(prepareSiteTx({ t: fx.t, plan: fx.plan, step: "create", clients: fx.model.clients(), stageBPrecheck: broken }), /would not be Ready/);
});
test("landing refuses a wallet-altered destination, value or calldata, extra or foreign events, a short or non-canonical receipt", async () => {
  const fx = fixture(), clients = fx.model.clients();
  const req = await prepareSiteTx({ t: fx.t, plan: fx.plan, step: "publish", clients });
  for (const mutate of [(x) => { x.to = fx.t.ledger; }, (x) => { x.value = "0x1"; }, (x) => { x.data = x.data.slice(0, 80) + (x.data[80] === "0" ? "1" : "0") + x.data.slice(81); }]) {
    const f2 = fixture(), r2 = await prepareSiteTx({ t: f2.t, plan: f2.plan, step: "publish", clients: f2.model.clients() });
    const hash = f2.model.land(r2.transaction, { mutate });
    await assert.rejects(verifySiteTx({ t: f2.t, plan: f2.plan, step: "publish", attempts: [r2], hash, clients: f2.model.clients() }), /not this step's request/);
  }
  const hash = fx.model.land(req.transaction, { extra: 0 });
  await assert.rejects(verifySiteTx({ t: fx.t, plan: fx.plan, step: "publish", attempts: [req], hash, clients }), /two later blocks/);
  fx.model.mine(2);
  await assert.rejects(verifySiteTx({ t: fx.t, plan: fx.plan, step: "publish", attempts: [req], hash, clients: fx.model.clients([null, (m, a, r) => (m === "getTransactionReceipt" ? { ...r, blockHash: "0x" + "66".repeat(32) } : r)]) }), /not canonical/);
  await assert.rejects(verifySiteTx({ t: fx.t, plan: fx.plan, step: "publish", attempts: [req], hash, clients: fx.model.clients([null, (m, a, r) => (m === "getTransactionReceipt" ? { ...r, logs: [...r.logs, r.logs[0]] } : r)]) }), /exactly 3 events/);
  const tx = fx.model.state.txs[hash], rc = fx.model.state.receipts[hash];
  assert.throws(() => checkSiteLanding(fx.t, fx.plan, "publish", req, { transaction: { ...tx, chainId: 1 }, receipt: rc }), /wrong chain/);
  assert.throws(() => checkSiteLanding(fx.t, fx.plan, "publish", req, { transaction: { ...tx, from: "0x" + "88".repeat(20) }, receipt: rc }), /wrong sender/);
  assert.throws(() => checkSiteLanding(fx.t, fx.plan, "publish", req, { transaction: { ...tx, maxFeePerGas: tx.maxFeePerGas + 1n }, receipt: rc }), /fee cap/);
  assert.throws(() => checkSiteLanding(fx.t, fx.plan, "publish", req, { transaction: { ...tx, authorizationList: [{}] }, receipt: rc }), /authorization list/);
  assert.throws(() => checkSiteLanding(fx.t, fx.plan, "publish", req, { transaction: tx, receipt: { ...rc, logs: rc.logs.map((l) => ({ ...l, address: fx.t.ledger })) } }), /not from the step's contract/);
  assert.equal((await verifySiteTx({ t: fx.t, plan: fx.plan, step: "publish", attempts: [req], hash, clients })).outcome, "confirmed");
  // a Created for another id (the counter moved between preparation and landing) is refused at landing
  const f3 = fixture({ ledgerNonce: 1 }); f3.model.exec(f3.model.state, ADMIN, f3.t.catalog, f3.plan.publishData);
  f3.model.state.ledgerNonce[ADMIN] = 1;   // prepared while the counter predicts the reviewed id
  const r3 = await prepareSiteTx({ t: f3.t, plan: f3.plan, step: "create", clients: f3.model.clients() });
  f3.model.state.ledgerNonce[ADMIN] = 0;   // the chain then mints a different id than the request was prepared for
  const h3 = f3.model.land(r3.transaction);
  await assert.rejects(verifySiteTx({ t: f3.t, plan: f3.plan, step: "create", attempts: [r3], hash: h3, clients: f3.model.clients() }), /another deployment/);
});

// ---- transport -------------------------------------------------------------------------------------------------------
test("transport: wrong host, other origin, cross-site, missing token are refused; replies are no-store with a self-only CSP", async () => {
  const fx = fixture(), h = await launch(fx);
  try {
    assert.equal((await hit(h.origin, "/start", { token: h.token, headers: { host: "evil.example" } })).status, 403);
    assert.equal((await hit(h.origin, "/start", { token: h.token, headers: { origin: "http://evil.example" } })).status, 403);
    assert.equal((await hit(h.origin, "/start", { token: h.token, headers: { "sec-fetch-site": "cross-site" } })).status, 403);
    assert.equal((await hit(h.origin, "/start", {})).status, 403);
    assert.equal((await hit(h.origin, "/start", { token: "0".repeat(48) })).status, 403);
    const g = await hit(h.origin, "/state", { method: "GET" });
    assert.equal(g.headers["cache-control"], "no-store"); assert.match(g.headers["content-security-policy"], /default-src 'none'/);
    assert.equal(g.json.admin, ADMIN); assert.equal(g.json.chainId, "0x2105");
    assert.equal((await hit(h.origin, "/tx/prepare", { token: h.token, body: { step: "publish" } })).status, 409, "nothing before Start");
  } finally { await h.close(); }
});
test("double click: a second action while one runs gets 409; a prepared step cannot be prepared again; steps run in order", async () => {
  const fx = fixture(), h = await launch(fx);
  try {
    await hit(h.origin, "/start", { token: h.token }); await signUpload(h);
    assert.equal((await hit(h.origin, "/tx/prepare", { token: h.token, body: { step: "create" } })).status, 409, "create before publish");
    const [a, b] = await Promise.all([hit(h.origin, "/tx/prepare", { token: h.token, body: { step: "publish" } }), hit(h.origin, "/tx/prepare", { token: h.token, body: { step: "publish" } })]);
    assert.deepEqual([a.status, b.status].sort(), [200, 409]);
    assert.equal((await hit(h.origin, "/tx/prepare", { token: h.token, body: { step: "publish" } })).status, 409, "no duplicate request while one is open");
    assert.equal((await hit(h.origin, "/upload/prepare", { token: h.token })).status, 409, "no second upload");
  } finally { await h.close(); }
});
test("interrupted submission: after a restart the open attempt is kept; release only with the nonce unused; a landed tx is recovered by its hash", async () => {
  const fx = fixture(), tmp = fs.mkdtempSync(path.join(os.tmpdir(), "site-journals-"));
  const journals = () => fileJournals(tmp);
  let h = await launch(fx, { journals: journals() });
  await hit(h.origin, "/start", { token: h.token }); await signUpload(h);
  const p = await hit(h.origin, "/tx/prepare", { token: h.token, body: { step: "publish" } });
  await h.close();                                                   // the browser/server died with the request at MetaMask
  h = await launch(fx, { journals: journals() });
  try {
    const v = (await hit(h.origin, "/state", { method: "GET" })).json;
    assert.equal(v.steps[1].status, "awaiting-wallet"); assert.equal(v.upload.status, "uploaded");
    assert.equal((await hit(h.origin, "/tx/prepare", { token: h.token, body: { step: "publish" } })).status, 409);
    const hash = fx.model.land(p.json.transaction);                  // MetaMask did send it
    const rel = await hit(h.origin, "/tx/release", { token: h.token, body: { step: "publish" } });
    assert.equal(rel.status, 400); assert.match(rel.json.error, /was used/);
    const r = await hit(h.origin, "/tx/result", { token: h.token, body: { step: "publish", hash } });
    assert.equal(r.json.verification.outcome, "confirmed");
    // an unanswered create request whose nonce stays unused is released; the retry keeps the same nonce
    const c1 = await hit(h.origin, "/tx/prepare", { token: h.token, body: { step: "create" } });
    assert.equal((await hit(h.origin, "/tx/release", { token: h.token, body: { step: "create" } })).status, 200);
    const c2 = await hit(h.origin, "/tx/prepare", { token: h.token, body: { step: "create" } });
    assert.equal(c2.json.transaction.nonce, c1.json.transaction.nonce);
    // a hash of the publish step is refused for create before it is recorded
    assert.equal((await hit(h.origin, "/tx/result", { token: h.token, body: { step: "create", hash } })).status, 409);
    const done = await hit(h.origin, "/tx/result", { token: h.token, body: { step: "create", hash: fx.model.land(c2.json.transaction) } });
    assert.equal(done.json.verification.outcome, "confirmed"); assert.ok(done.json.stageB.url);
    const disk = fs.readdirSync(tmp).map((f) => fs.readFileSync(path.join(tmp, f), "utf8")).join("");
    assert.ok(!/x-upload-token|tok-zzzz|"signature"/.test(disk), "journals hold public data only");
  } finally { await h.close(); }
});
test("explicit wallet rejection resets only that attempt; a revert halts everything; stage B refuses unapproved operations", async () => {
  let fx = fixture(), h = await launch(fx);
  try {
    await hit(h.origin, "/start", { token: h.token }); await signUpload(h);
    await hit(h.origin, "/tx/prepare", { token: h.token, body: { step: "publish" } });
    assert.equal((await hit(h.origin, "/tx/rejected", { token: h.token, body: { step: "publish", code: 4002 } })).status, 409);
    assert.equal((await hit(h.origin, "/tx/rejected", { token: h.token, body: { step: "publish", code: 4001 } })).status, 200);
    const p = await hit(h.origin, "/tx/prepare", { token: h.token, body: { step: "publish" } });
    // a version "1" appeared after preparation: the landed publish reverts ("version exists")
    fx.model.state.versions[fx.plan.appId] = [{ cid: "x", version: "1", vramMb: 0, gpuGflops: 0, memMb: 1, cpuGflops: 0, createdAt: 0n, verified: false, yanked: false, ports: "", approval: 0, config: "" }];
    const hash = fx.model.land(p.json.transaction);                    // "version exists": the landed transaction reverts
    const r = await hit(h.origin, "/tx/result", { token: h.token, body: { step: "publish", hash } });
    assert.equal(r.json.verification.outcome, "reverted"); assert.match(r.json.blocked, /reverted/);
    assert.equal((await hit(h.origin, "/tx/prepare", { token: h.token, body: { step: "create" } })).status, 409);
  } finally { await h.close(); }
  fx = fixture();
  await assert.rejects(createReserveQueue({ id: fx.t.predictedId, depositWei: fx.t.stageB.depositWei, approvedOpsSha256: "0".repeat(64), abi, clients: fx.model.clients(), receiptClients: fx.model.clients(), journalDir: fs.mkdtempSync(path.join(os.tmpdir(), "sb-")), chain: reviewedChain, base: fx.base }), /not the approved ones/);
  assert.throws(() => reserveOperations({ id: fx.t.predictedId, depositWei: 6n * 10n ** 15n, abi, base: fx.base }), /<= 0.005 ETH/);
});

// ---- wallet compatibility (finding 4): exact gas stays; an altered landing halts ---------------------------------------
test("gas limits against the ACTUAL two-provider simulation (logs/probe4.json, Base block 52890773, not the model): every step fits its cap", async () => {
  const p4 = JSON.parse(fs.readFileSync(path.join(LOGS, "probe4.json")));
  assert.equal(p4.readOnly, true); assert.equal(p4.providersAgree, true); assert.deepEqual(p4.rpcs, SITE.rpcs);
  const [a, b] = p4.perProvider;
  assert.equal(a.block, b.block); assert.ok(a.allCallsSucceeded && b.allCallsSucceeded); assert.deepEqual(a.gasUsed, b.gasUsed);
  const limit = (used) => (BigInt(used) * 125n + 99n) / 100n;   // prepareSiteTx and the reviewed chain.mjs: +25%
  assert.ok(limit(a.gasUsed.publishVersion) <= SITE.gasCaps.publish && limit(a.gasUsed.create) <= SITE.gasCaps.create);
  const ops = reserveOperations({ id: SITE.predictedId, depositWei: SITE.stageB.depositWei, abi }).operations;
  assert.ok(limit(a.gasUsed.deposit) <= BigInt(ops[0].gas) && limit(a.gasUsed.configure) <= BigInt(ops[1].gas));
  // the model charges exactly these actual gas figures, so the modelled flow requests the production gas limits
  const fx = fixture(), pub = await prepareSiteTx({ t: fx.t, plan: fx.plan, step: "publish", clients: fx.model.clients() });
  assert.equal(BigInt(pub.simulatedGasUsed), BigInt(a.gasUsed.publishVersion)); assert.equal(BigInt(pub.transaction.gas), limit(a.gasUsed.publishVersion));
  fx.model.exec(fx.model.state, ADMIN, fx.t.catalog, fx.plan.publishData);
  const cr = await prepareSiteTx({ t: fx.t, plan: fx.plan, step: "create", clients: fx.model.clients() });
  assert.equal(BigInt(cr.simulatedGasUsed), BigInt(a.gasUsed.create)); assert.equal(BigInt(cr.transaction.gas), limit(a.gasUsed.create));
});
test("wallet compatibility (model): an edited gas limit or a raised fee/priority cap that lands halts the flow for review; a lower fee cap is accepted", async () => {
  const bump = (k, d) => (x) => { x[k] = "0x" + (BigInt(x[k]) + d).toString(16); };
  const fx = fixture(), h = await launch(fx);
  try {
    await hit(h.origin, "/start", { token: h.token }); await signUpload(h);
    const { hash, res } = await sendStep(h, fx, "publish", { mutate: bump("gas", 1000n) });
    assert.equal(res.status, 409); assert.match(res.json.error, /changed the gas limit or fee caps.*halted for review.*gas changed/);
    const v = (await hit(h.origin, "/state", { method: "GET" })).json;
    assert.match(v.blocked, /halted for review/); assert.equal(v.steps[1].status, "submitted"); assert.equal(v.steps[1].hash, hash);
    assert.equal((await hit(h.origin, "/tx/prepare", { token: h.token, body: { step: "create" } })).status, 409, "nothing after an altered landing");
    assert.equal((await hit(h.origin, "/tx/result", { token: h.token, body: { step: "publish", hash } })).status, 409, "asking again does not accept it");
  } finally { await h.close(); }
  for (const [k, re] of [["maxFeePerGas", /increased fee cap/], ["maxPriorityFeePerGas", /increased priority cap/]]) {
    const f = fixture(), r = await prepareSiteTx({ t: f.t, plan: f.plan, step: "publish", clients: f.model.clients() });
    const hash = f.model.land(r.transaction, { mutate: bump(k, 1n) });
    await assert.rejects(verifySiteTx({ t: f.t, plan: f.plan, step: "publish", attempts: [r], hash, clients: f.model.clients() }), (e) => e.halt === true && re.test(e.message));
  }
  const f = fixture(), r = await prepareSiteTx({ t: f.t, plan: f.plan, step: "publish", clients: f.model.clients() });
  const other = f.model.land(r.transaction, { mutate: (x) => { x.data = f.plan.createData; x.to = f.t.ledger; } });
  await assert.rejects(verifySiteTx({ t: f.t, plan: f.plan, step: "publish", attempts: [r], hash: other, clients: f.model.clients() }), (e) => e.halt === false && /not this step's request/.test(e.message));
  const g = fixture(), q = await prepareSiteTx({ t: g.t, plan: g.plan, step: "publish", clients: g.model.clients() });
  const lower = g.model.land(q.transaction, { mutate: bump("maxFeePerGas", -1n) });
  assert.equal((await verifySiteTx({ t: g.t, plan: g.plan, step: "publish", attempts: [q], hash: lower, clients: g.model.clients() })).outcome, "confirmed");
});
