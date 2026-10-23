// Server-level tests: the real local server (adapted transport + both stages) over HTTP exactly as the page calls it,
// against anvil with the deployed catalog/book runtimes and the fake relay/gateway. Loopback only.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { encodeFunctionData } from "viem";
import { CAT, startChain, startUploadServices, memoryJournal, fixtureTrust, ephemeralSigner, instantClock } from "./env.mjs";
import { canaryApp } from "../stage-app.mjs";
import { makePreparer, frozen } from "../publish-stage.mjs";
import { clientsFor } from "../rpc.mjs";
import { assets } from "../page.mjs";
import { fileJournal } from "../handoff-server.mjs";
import { PRODUCTION, PORT } from "../trust.mjs";
import { PRODUCTION as PUB, request as publishRequest } from "../vendor/publish.mjs";

let chain, up, signer, snap;
before(async () => { chain = await startChain(); up = await startUploadServices(); signer = ephemeralSigner(); snap = await chain.raw("evm_snapshot"); });
/** Back to the freshly set-up chain (no listing), and nothing stored at the fake gateway. */
async function fresh() { await chain.raw("anvil_dropAllTransactions"); await chain.raw("evm_revert", [snap]); snap = await chain.raw("evm_snapshot"); up.store.clear(); }
const storedJournal = () => { up.store.set(PRODUCTION.component.cid, fs.readFileSync(PRODUCTION.component.file)); return memoryJournal({ status: "stored-verified", cid: PRODUCTION.component.cid }); };
after(async () => { await up?.close(); await chain?.close(); });
const LEDGER_SEAM = () => PUB.ledgerCodeHash;
const pad32 = (n) => "0x" + BigInt(n).toString(16).padStart(64, "0");

async function open(t, { journals, componentFile, now, trustPatch } = {}) {
  up.mode.token = 200; up.mode.add = "ok"; up.mode.serve = "ok";
  const trust = { ...fixtureTrust({ rpcs: chain.urls, uploadBase: up.base, componentFile, admin: signer.address }), ...trustPatch };
  const clients = clientsFor(trust.rpcs, { timeoutMs: trust.rpcTimeoutMs, allowLoopback: true });
  journals ??= { upload: memoryJournal(), publish: memoryJournal() };
  const app = canaryApp({ trust, clients, journals, assets: assets(), now: now ?? (() => Date.now()),
    preparer: makePreparer(trust, { clock: instantClock(), ledgerCodeHashOf: LEDGER_SEAM }) });
  const origin = await app.listen(); t.after(() => app.close());
  const cfg = await (await fetch(origin + "/request")).json();
  const post = async (p, body, { token = cfg.token, from = origin } = {}) => {
    const r = await fetch(origin + p, { method: "POST", headers: { "content-type": "application/json", origin: from, "x-signing-token": token }, body: JSON.stringify(body ?? {}) });
    return { status: r.status, body: await r.json() };
  };
  return { app, trust, origin, cfg, post, journals, get: async () => (await fetch(origin + "/request")).json() };
}
async function authorizeAndUpload(h, sign = signer.sign) {
  const b = await h.post("/upload/begin");
  assert.equal(b.status, 200, JSON.stringify(b.body));
  return h.post("/upload/signature", { signature: await sign(b.body.message) });
}
const walletSend = async (tx, patch = {}) => chain.sendAs(tx.from, { to: tx.to, data: tx.data, value: tx.value, nonce: tx.nonce, gas: tx.gas,
  maxFeePerGas: tx.maxFeePerGas, maxPriorityFeePerGas: tx.maxPriorityFeePerGas, type: "0x2", ...patch });

test("pins: reviewed copies byte-identical, production trust consistent, port is not the factory's, serve needs --serve", async () => {
  const sha = (f) => createHash("sha256").update(fs.readFileSync(new URL("../" + f, import.meta.url))).digest("hex");
  assert.equal(sha("rpc.mjs"), "df00a18b6c454acaa95f4634dcf64941447bc019dd16d61379ce94f8ff3a86aa");
  assert.equal(sha("vendor/publish.mjs"), "d255587b66acb6afa9aebe14fd2d7bec86083213cdc07242d268a8e21d88cd41", "custody-proof-app ad81dd5 publish/lib/publish.mjs");
  assert.equal(sha("style.css"), "b055f0427d9b28ef9d10b27593c532755f864413869d2b926136f526af82e3c6");
  assert.equal(PRODUCTION.admin, PUB.publisher); assert.equal(PRODUCTION.catalog, PUB.catalog);
  assert.ok(!("uploadSigner" in PRODUCTION), "the test-only upload signer never exists in production");
  assert.equal(PRODUCTION.component.size, 101222); assert.equal(PRODUCTION.component.cid, "bafkreid44murqsilsg4hy772jt3jo2ogo223qnokchkvsbfrkeppspxiqm");
  assert.equal(PRODUCTION.upload.tokenUrl, "https://api.enclave.host/v1/apps/upload-token"); assert.equal(PRODUCTION.upload.addUrl, "https://ipfs.enclave.host/add-wasm");
  assert.notEqual(PORT, 39672);
  const tx = frozen(PRODUCTION);
  assert.equal(tx.to, PUB.catalog); assert.equal(tx.data, publishRequest().data); assert.equal(tx.value, "0x0"); assert.equal(tx.chainId, "0x2105");
  const { spawnSync } = await import("node:child_process");
  const r = spawnSync(process.execPath, [new URL("../serve.mjs", import.meta.url).pathname], { encoding: "utf8", timeout: 20_000 });
  assert.notEqual(r.status, 0); assert.match(r.stderr, /usage: node serve\.mjs --serve/);
  // no server-side code path can sign or send: only the page asks the wallet
  for (const f of ["handoff-server.mjs", "upload.mjs", "publish-stage.mjs", "stage-app.mjs", "serve.mjs", "rpc.mjs", "trust.mjs"]) {
    const src = fs.readFileSync(new URL("../" + f, import.meta.url), "utf8");
    for (const s of ["eth_sendRawTransaction", "privateKeyToAccount", "signTransaction", "signMessage", "console.log(sig", "readFileSync(\"/home/steven/Projects/enclave/metal"]) assert.ok(!src.includes(s), `${f}: ${s}`);
  }
  assert.ok(!fs.readFileSync(new URL("../upload.mjs", import.meta.url), "utf8").includes("console."), "the upload stage never logs");
});

test("transport guards: token, origin and unknown routes refused; nothing in the journal before a click", async (t) => {
  const h = await open(t);
  assert.equal((await h.post("/upload/begin", {}, { token: "x" })).status, 403);
  assert.equal((await h.post("/upload/begin", {}, { from: "http://evil.example" })).status, 403);
  assert.equal((await h.post("/upload/anything")).status, 404);
  assert.deepEqual(h.journals.upload.read(), { status: "ready" }); assert.deepEqual(h.journals.publish.read(), { status: "ready" });
  assert.equal(h.cfg.stages.upload.status, "ready"); assert.equal(h.cfg.request.transaction.to, PUB.catalog);
});

test("happy path: exact message -> upload -> CID and fetched bytes verified -> fresh prepare -> wallet -> pending -> confirmed with readback", async (t) => {
  const h = await open(t);
  // publishing is impossible before the upload is verified
  const early = await h.post("/prepare");
  assert.equal(early.status, 409); assert.match(early.body.error, /not stored and verified/);
  assert.equal(h.journals.publish.read().status, "ready");
  const b = await h.post("/upload/begin");
  assert.equal(b.body.message, `enclave-upload:${PRODUCTION.component.sha256}:${b.body.expiry}`);
  assert.equal(h.journals.upload.read().status, "authorizing", "durable before the browser saw the message");
  const sig = await signer.sign(b.body.message);
  const s = await h.post("/upload/signature", { signature: sig });
  assert.equal(s.status, 200, JSON.stringify(s.body)); assert.equal(s.body.status, "stored-verified");
  assert.equal(s.body.cid, PRODUCTION.component.cid); assert.equal(s.body.fetched.sha256, PRODUCTION.component.sha256);
  assert.equal(up.calls.token, up.calls.signatures.length);
  assert.ok(!h.journals.upload.text.includes(sig.slice(2, 40)), "the signature is never journaled");
  assert.equal((await h.post("/upload/begin")).status, 400, "a verified upload is never authorized again");
  // the publish: a fresh preparation (every reviewed check) gated on a fresh fetch-back
  const fetchesBefore = up.calls.fetch;
  const p = await h.post("/prepare");
  assert.equal(p.status, 200, JSON.stringify(p.body)); assert.ok(up.calls.fetch > fetchesBefore, "storage re-fetched before preparing");
  const tx = p.body.transaction, req = h.journals.publish.read();
  assert.equal(req.status, "awaiting-wallet"); assert.equal(tx.data, publishRequest().data); assert.equal(tx.to, PUB.catalog); assert.equal(tx.from, PUB.publisher);
  assert.ok(req.request.fees && req.request.transport && req.request.planHash);
  assert.equal((await h.post("/prepare")).status, 409, "one durable attempt");
  const hash = await walletSend(tx);
  const pend = await h.post("/result", { hash });
  assert.equal(pend.status, 400); assert.match(pend.body.error, /no receipt|pending/);
  assert.equal(h.journals.publish.read().status, "submitted");
  await chain.mine(3);
  const done = await h.post("/result", { hash });
  assert.equal(done.status, 200, JSON.stringify(done.body));
  assert.equal(done.body.approval, "approved"); assert.equal(done.body.cid, PRODUCTION.component.cid); assert.equal(done.body.memMb, 128);
  assert.equal(done.body.catalogRef, `catalog://${publishRequest().appId.toLowerCase()}/0`);
  assert.equal(h.journals.publish.read().status, "confirmed");
  assert.equal((await h.post("/result", { hash: "0x" + "ab".repeat(32) })).status, 409, "a recorded hash is never replaced");
});

test("refreshed prepare refuses once the listing exists (no duplicate publication through a new attempt)", async (t) => {
  const h = await open(t, { journals: { upload: memoryJournal({ status: "stored-verified", cid: PRODUCTION.component.cid }), publish: memoryJournal() } });
  up.store.set(PRODUCTION.component.cid, fs.readFileSync(PRODUCTION.component.file));
  const p = await h.post("/prepare");
  assert.equal(p.status, 400); assert.match(p.body.error, /already has 1 version|already listed/);
  assert.equal(h.journals.publish.read().status, "ready");
});

test("upload refusals: wrong signer, relay refusal, changed file, expiry, 4001 vs other wallet errors", async (t) => {
  await fresh();
  let now = Date.now();
  const h = await open(t, { now: () => now });
  // a signature by anyone but the administrator: refused locally, nothing sent anywhere
  const tokens = up.calls.token, b = await h.post("/upload/begin");
  const other = ephemeralSigner();
  const bad = await h.post("/upload/signature", { signature: await other.sign(b.body.message) });
  assert.equal(bad.status, 400); assert.match(bad.body.error, /not signed by the administrator/);
  assert.equal(up.calls.token, tokens); assert.equal(h.journals.upload.read().status, "authorizing");
  assert.equal((await h.post("/upload/signature", { signature: "0x1234" })).status, 400);
  // only an explicit 4001 resets; another wallet error code does not
  assert.equal((await h.post("/upload/rejected", { code: -32603 })).status, 400);
  assert.equal((await h.post("/upload/rejected", { code: 4001 })).status, 200);
  assert.equal(h.journals.upload.read().status, "ready");
  // the relay refuses: back to ready with the reason, nothing reached the gateway
  up.mode.token = 403; const adds = up.calls.add;
  const r = await authorizeAndUpload(h);
  assert.equal(r.status, 400); assert.match(r.body.error, /relay refused/);
  assert.equal(up.calls.add, adds); assert.equal(h.journals.upload.read().status, "ready"); up.mode.token = 200;
  // expiry: a signature arriving late is refused; a new authorization is allowed once the old one has expired
  const b2 = await h.post("/upload/begin"); const late = await signer.sign(b2.body.message);
  now += 301_000;
  const tooLate = await h.post("/upload/signature", { signature: late });
  assert.equal(tooLate.status, 400); assert.match(tooLate.body.error, /expire/);
  assert.equal((await h.post("/upload/begin")).status, 200, "an expired authorization can be replaced");
  // a changed component file is never uploaded
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "canary-")), f = path.join(dir, "c.wasm");
  fs.writeFileSync(f, Buffer.concat([fs.readFileSync(PRODUCTION.component.file), Buffer.from([0])]));
  const h2 = await open(t, { componentFile: f });
  const x = await h2.post("/upload/begin"); assert.equal(x.status, 400); assert.match(x.body.error, /not the pinned 101222/);
  fs.writeFileSync(f, Buffer.from(fs.readFileSync(PRODUCTION.component.file)).fill(1, 100, 101));
  const y = await h2.post("/upload/begin"); assert.equal(y.status, 400); assert.match(y.body.error, /sha256 is not the pinned one/);
});

test("storage: wrong CID is terminal; wrong served bytes block publishing until a re-fetch verifies", async (t) => {
  await fresh();
  const h = await open(t);
  up.mode.add = "wrongcid";
  const r = await authorizeAndUpload(h);
  assert.equal(r.status, 400); assert.match(r.body.error, /STOP: the gateway answered bafk[a-z2-7]+, not the pinned/);
  assert.equal(h.journals.upload.read().status, "cid-mismatch");
  assert.equal((await h.post("/upload/begin")).status, 400); assert.equal((await h.post("/upload/verify-storage")).status, 400);
  const p = await h.post("/prepare"); assert.equal(p.status, 409); assert.match(p.body.error, /cid-mismatch/);
  // a second handoff: stored, but the bytes served back differ
  up.store.clear();
  const h2 = await open(t); up.mode.serve = "wrong";
  const r2 = await authorizeAndUpload(h2);
  assert.equal(r2.status, 200); assert.equal(r2.body.status, "pinned-unverified"); assert.match(r2.body.lastError, /not the pinned component/);
  assert.equal((await h2.post("/prepare")).status, 409);
  up.mode.serve = "ok";
  const v = await h2.post("/upload/verify-storage"); assert.equal(v.body.status, "stored-verified");
  // and the gate re-fetches at every prepare: bytes that stop verifying block it again
  up.mode.serve = "wrong";
  const g = await h2.post("/prepare"); assert.equal(g.status, 409); assert.match(g.body.error, /did not verify just now/);
  assert.equal(h2.journals.publish.read().status, "ready"); up.mode.serve = "ok";
});

test("crash and no-answer: an unanswered upload is never re-sent blindly; restart reconciles by fetching", async (t) => {
  await fresh();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "canary-j-"));
  const journals = () => ({ upload: fileJournal(path.join(dir, "upload.json")), publish: fileJournal(path.join(dir, "publish.json")) });
  const h = await open(t, { journals: journals() });
  up.mode.add = "hang";                                           // the gateway stores the bytes but never answers
  const r = await authorizeAndUpload(h);
  assert.equal(r.status, 400); assert.match(r.body.error, /may have stored the component/);
  assert.equal(h.journals.upload.read().status, "upload-unknown");
  assert.equal((await h.post("/upload/begin")).status, 400, "no new authorization while the outcome is unknown");
  await h.app.close();
  up.mode.add = "ok";
  const h2 = await open(t, { journals: journals() });              // restart over the same files
  assert.equal(h2.cfg.stages.upload.status, "upload-unknown");
  const adds = up.calls.add;
  const v = await h2.post("/upload/verify-storage");
  assert.equal(v.body.status, "stored-verified"); assert.equal(up.calls.add, adds, "verified by fetching, not by uploading again");
  // a process that died DURING the upload restarts as upload-unknown; a failed fetch proves nothing, so it STAYS unknown
  up.store.clear();
  fs.writeFileSync(path.join(dir, "upload.json"), JSON.stringify({ status: "uploading", expiry: 1 }));
  const h3 = await open(t, { journals: journals() });
  assert.equal(h3.cfg.stages.upload.status, "upload-unknown");
  const v404 = await h3.post("/upload/verify-storage");                                    // a definitive 404 from the gateway
  assert.equal(v404.body.status, "upload-unknown"); assert.match(v404.body.lastError, /HTTP 404.*does not prove the earlier upload was not stored/);
  up.mode.serve = "502";
  const v502 = await h3.post("/upload/verify-storage");                                    // transient: nothing is concluded
  assert.equal(v502.body.status, "upload-unknown"); assert.match(v502.body.lastError, /HTTP 502 for the CID; the outcome stays unknown/);
  up.mode.serve = "ok";
  assert.equal((await h3.post("/upload/begin")).status, 400, "still no automatic re-authorization");
  assert.equal((await h3.post("/prepare")).status, 409);
  // only the administrator's explicit same-bytes retry reopens the authorization; nothing is uploaded by it
  const adds3 = up.calls.add;
  assert.equal((await h3.post("/upload/retry-same-bytes", {})).status, 400, "the page's explicit confirmation is required");
  const rs = await h3.post("/upload/retry-same-bytes", { confirm: "retry-same-bytes" });
  assert.equal(rs.body.status, "ready"); assert.match(rs.body.note, /outcome was never established/); assert.equal(up.calls.add, adds3);
  assert.equal((await h3.post("/upload/retry-same-bytes", { confirm: "retry-same-bytes" })).status, 400, "only from an unknown outcome");
  const again = await authorizeAndUpload(h3);
  assert.equal(again.body.status, "stored-verified"); assert.equal(again.body.cid, PRODUCTION.component.cid);
  assert.ok(!fs.readFileSync(path.join(dir, "upload.json"), "utf8").includes("signature"), "no signature on disk");
});

test("privacy: upstream error bodies that reflect the signature or token are never journaled, returned or shown", async (t) => {
  await fresh();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "canary-p-"));
  const journals = () => ({ upload: fileJournal(path.join(dir, "upload.json")), publish: fileJournal(path.join(dir, "publish.json")) });
  const h = await open(t, { journals: journals() });
  const seen = [];
  const run = async (setup) => {
    setup();
    const b = await h.post("/upload/begin"); assert.equal(b.status, 200, JSON.stringify(b.body));
    const sig = await signer.sign(b.body.message);
    const r = await h.post("/upload/signature", { signature: sig });
    seen.push({ sig, r: JSON.stringify(r.body), stages: JSON.stringify((await h.get()).stages) });
    return r;
  };
  // the relay refuses and echoes the signature in its error body
  let r = await run(() => { up.mode.reflect = true; up.mode.token = 403; });
  assert.equal(r.status, 400); assert.match(r.body.error, /^the relay refused the authorization \(HTTP 403\); nothing was uploaded$/);
  up.mode.token = 200; up.mode.reflect = false;
  // the gateway refuses and echoes the token (and the signature) in its error body
  r = await run(() => { up.mode.add = "reflect403"; });
  assert.equal(r.status, 400); assert.equal(r.body.error, "the gateway refused the upload (HTTP 403)");
  // the gateway answers the token itself as the "cid"
  up.mode.add = "ok";
  const h2 = await open(t, { journals: { upload: memoryJournal(), publish: memoryJournal() } });
  up.mode.add = "cidecho";
  const b2 = await h2.post("/upload/begin"); const sig2 = await signer.sign(b2.body.message);
  const r2 = await h2.post("/upload/signature", { signature: sig2 });
  assert.match(r2.body.error, /STOP: the gateway answered \(an answer that is not a CID\)/);
  assert.equal(h2.journals.upload.read().gatewayCid, "(an answer that is not a CID)");
  seen.push({ sig: sig2, r: JSON.stringify(r2.body), stages: JSON.stringify((await h2.get()).stages), journal: h2.journals.upload.text });
  // a malformed signature of the right length: the recovery error never echoes it
  const h3 = await open(t, { journals: { upload: memoryJournal(), publish: memoryJournal() } });
  await h3.post("/upload/begin");
  const junk = "0x" + "11".repeat(64) + "05";
  const r3 = await h3.post("/upload/signature", { signature: junk });
  assert.equal(r3.status, 400); assert.ok(!JSON.stringify(r3.body).includes("1111111111"), JSON.stringify(r3.body));
  // nothing anywhere carries a signature or a token
  const disk = fs.readFileSync(path.join(dir, "upload.json"), "utf8");
  const secrets = [...seen.map((x) => x.sig), ...up.calls.tokens].map((x) => String(x).replace(/^0x/, "").slice(0, 40));
  for (const x of seen) for (const k of secrets) { assert.ok(!x.r.includes(k), "response: " + x.r); assert.ok(!x.stages.includes(k)); if (x.journal) assert.ok(!x.journal.includes(k)); }
  for (const k of secrets) assert.ok(!disk.includes(k), "journal on disk");
  assert.ok(up.calls.tokens.length >= 2, "the fake really issued tokens that could have leaked");
  up.mode.add = "ok";
});

test("publish: 4001 resets; any other wallet error keeps the attempt; a raised fee is never recorded", async (t) => {
  await fresh();
  const h = await open(t, { journals: { upload: storedJournal(), publish: memoryJournal() } });
  const p = await h.post("/prepare"); assert.equal(p.status, 200, JSON.stringify(p.body));
  assert.equal((await h.post("/rejected", { code: -32603 })).status, 409, "a Trezor/transport error is not a rejection");
  assert.equal(h.journals.publish.read().status, "awaiting-wallet");
  assert.equal((await h.post("/rejected", { code: 4001 })).status, 200);
  assert.equal(h.journals.publish.read().status, "ready");
  const p2 = await h.post("/prepare"); const tx = p2.body.transaction;
  const raised = await walletSend(tx, { maxFeePerGas: "0x" + (BigInt(tx.maxFeePerGas) + 1n).toString(16) });
  const a = await h.post("/result", { hash: raised });
  assert.equal(a.status, 400); assert.match(a.body.error, /raised the fee cap/);
  assert.equal(h.journals.publish.read().status, "awaiting-wallet"); assert.equal(h.journals.publish.read().hash, undefined);
});

test("reconcile without a hash: too early / pending keep; mined+listed keeps (supply the hash); nonce taken elsewhere resets; unused resets", async (t) => {
  await fresh();
  let now = Date.now();
  const h = await open(t, { journals: { upload: storedJournal(), publish: memoryJournal() }, now: () => now });
  const p = await h.post("/prepare"); assert.equal(p.status, 200, JSON.stringify(p.body)); const tx = p.body.transaction;
  let r = await h.post("/reconcile");
  assert.equal(r.body.reset, false); assert.match(r.body.reason, /reject any open request in MetaMask/);
  now += 3_600_000;                                                  // well past the minimum age
  const hash = await walletSend(tx);                                 // MetaMask did send it; the page never learned the hash
  r = await h.post("/reconcile"); assert.equal(r.body.reset, false); assert.match(r.body.reason, /pending/);
  await chain.mine(3);
  r = await h.post("/reconcile"); assert.equal(r.body.reset, false); assert.equal(r.body.published, true);
  assert.equal(h.journals.publish.read().status, "awaiting-wallet");
  const done = await h.post("/result", { hash }); assert.equal(done.status, 200, JSON.stringify(done.body));
  assert.equal((await h.post("/reconcile")).status, 409, "a recorded hash is never reconciled away");
  // nonce used by another transaction and nothing listed: the prepared one can never be mined -> reset
  await fresh();
  const h2 = await open(t, { journals: { upload: storedJournal(), publish: memoryJournal() }, now: () => now + 3_600_000 });
  const p2 = await h2.post("/prepare"); const tx2 = p2.body.transaction;
  await chain.sendAs(PUB.publisher, { to: PUB.publisher, value: "0x0", nonce: tx2.nonce }); await chain.mine(3);
  r = await h2.post("/reconcile"); assert.equal(r.body.reset, true); assert.match(r.body.reason, /used by another transaction/);
  const p3 = await h2.post("/prepare"); assert.equal(p3.status, 200);
  assert.equal(BigInt(p3.body.transaction.nonce), BigInt(tx2.nonce) + 1n, "the new attempt uses the next nonce");
  // nonce still unused and old enough: nothing was sent -> reset
  r = await h2.post("/reconcile"); assert.equal(r.body.reset, true); assert.match(r.body.reason, /nothing was sent/);
});

test("the refreshed preparation still enforces the reviewed checks: catalog owner changed after the upload -> refused", async (t) => {
  await fresh();
  const h = await open(t, { journals: { upload: storedJournal(), publish: memoryJournal() } });
  await chain.raw("anvil_setStorageAt", [PUB.catalog, pad32(chain.ownerSlot), pad32(1n)]); await chain.mine(3);
  const p = await h.post("/prepare");
  assert.equal(p.status, 400); assert.match(p.body.error, /catalog owner/);
  assert.equal(h.journals.publish.read().status, "ready");
});

test("verification reads the stored version back: a version rejected after mining is not reported as published", async (t) => {
  await fresh();
  const h = await open(t, { journals: { upload: storedJournal(), publish: memoryJournal() } });
  const p = await h.post("/prepare"); assert.equal(p.status, 200, JSON.stringify(p.body));
  const hash = await walletSend(p.body.transaction); await chain.mine(1);
  await chain.sendAs(PUB.publisher, { to: PUB.catalog, data: encodeFunctionData({ abi: CAT.abi, functionName: "setApproval", args: [publishRequest().appId, 0n, 2] }) });
  await chain.mine(3);
  const r = await h.post("/result", { hash });
  assert.equal(r.status, 400); assert.match(r.body.error, /stored version differs/);
  assert.notEqual(h.journals.publish.read().status, "confirmed");
});
