// The book-activation handoff on the in-memory Base model (test/fake-base.mjs) served by two loopback providers: exact
// frozen request vs the public plan, every refusal (pins, owner, entry, ledger, impact/stranding, nonce, fees, gas,
// balance, provider disagreement), the reviewed transport end to end over loopback HTTP, restart and lost responses,
// verification negatives, the preflight and the serve usage refusal. No network but loopback.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { decodeFunctionData, keccak256 } from "viem";
import { FakeBase, providers, fixtureTrust, memoryJournal, ZERO, EOA, POLICY_ID, l1UpperBound, BOOK_RUNTIME, push4s } from "./fake-base.mjs";
import { clientsFor } from "../rpc.mjs";
import { frozen, checkFrozen, prepare, verify, effectOf, keyOf, BOOK_ABI, PURPOSE, txSizes, assertCoversSigned, ORACLE_SIGNATURE_ALLOWANCE, bookAbiFor, observe } from "../activation.mjs";
import { toFunctionSelector } from "viem";
import { activationApp, recoverInterruptedPreparation } from "../stage-app.mjs";
import { assets, TEXT } from "../page.mjs";
import { PRODUCTION } from "../trust.mjs";
import { preflight } from "../preflight.mjs";

const here = path.dirname(fileURLToPath(import.meta.url)), root = path.resolve(here, "..");
const sha = (f) => createHash("sha256").update(fs.readFileSync(path.join(root, f))).digest("hex");
const T = { timeout: 30000 };
const plan = JSON.parse(fs.readFileSync(path.join(root, "evidence/factory-activation-unsigned-20261023.json"), "utf8"));

async function world(t, over = {}) {
  const base = new FakeBase(PRODUCTION), net = await providers(base);
  const trust = fixtureTrust(net.urls, over), clients = clientsFor(net.urls, { timeoutMs: trust.rpcTimeoutMs, allowLoopback: true });
  t.after(() => net.close());
  return { base, net, trust, clients };
}
async function serve(t, w, journal = memoryJournal()) {
  const app = activationApp({ trust: w.trust, clients: w.clients, journal, assets: assets() });
  await app.listen(); t.after(() => app.close());
  const { token } = await (await fetch(app.origin + "/request")).json();
  const post = async (url, data = {}) => { const r = await fetch(app.origin + url, { method: "POST", headers: { Origin: app.origin, "X-Signing-Token": token, "Content-Type": "application/json" }, body: JSON.stringify(data) }); return { status: r.status, body: await r.json() }; };
  return { app, post, journal };
}

test("the frozen request is exactly the public plan's transaction; only sessionVaultFactory can be set; reviewed code copied byte for byte", () => {
  assert.equal(sha("evidence/factory-activation-unsigned-20261023.json"), "3b28b16ff5a10ae6968547f12cca456da522995737eb684a5d922fa3e8f5770b");
  assert.equal(sha("handoff-server.mjs"), "fb189e4610c8579739fb59fe385b91b461bc5bfb06d95780e94ec92e53d95b75", "the reviewed transport is byte-identical");
  assert.equal(sha("rpc.mjs"), "da8d0f4d345412df744649a10d0022fcd471dd5089ba736fbdb6a9d93955bd52", "the revised read-only RPC layer matches the reviewed response-validation fix");
  const f = frozen(PRODUCTION), p = plan.transaction;
  assert.deepEqual([f.from, f.to, f.value, f.data, f.chainId], [p.from, p.to, p.value, p.data, p.chainId]);
  assert.deepEqual([plan.book, plan.factory, plan.implementation.toLowerCase(), plan.codeHashes.factory, plan.codeHashes.implementation, plan.expectedBefore.bookOwner],
    [PRODUCTION.book, PRODUCTION.factory, PRODUCTION.implementation, PRODUCTION.codeHashes.factory, PRODUCTION.codeHashes.implementation, PRODUCTION.admin]);
  const { functionName, args } = decodeFunctionData({ abi: BOOK_ABI, data: f.data });
  assert.deepEqual([functionName, args[0], args[1].toLowerCase()], ["set", keyOf("sessionVaultFactory"), PRODUCTION.factory]);
  for (const k of PRODUCTION.excludedKeys) assert.ok(!f.data.includes(keyOf(k).slice(2)), `the request can never set ${k}`);
  assert.throws(() => checkFrozen({ transaction: { ...f, data: f.data.replace(keyOf("sessionVaultFactory").slice(2), keyOf("secretVaultV2").slice(2)) } }, PRODUCTION), /calldata changed/);
  assert.throws(() => checkFrozen({ transaction: { ...f, to: PRODUCTION.vaults.v2 } }, PRODUCTION), /destination changed/);
  assert.throws(() => checkFrozen({ transaction: { ...f, value: "0x1" } }, PRODUCTION), /value changed/);
  // effectOf is byte-for-byte the consumer review's (custody-factory-consumer-review-20261023 lib/review.mjs)
  const fn = (src) => src.slice(src.indexOf("export function effectOf"), src.indexOf("\n}\n", src.indexOf("export function effectOf")) + 2);
  const review = path.join(root, "../custody-factory-consumer-review-20261023/lib/review.mjs");
  if (fs.existsSync(review)) assert.equal(fn(fs.readFileSync(path.join(root, "activation.mjs"), "utf8")), fn(fs.readFileSync(review, "utf8")));
  // the reviewed vault-held set is the consumer review's evidence
  const ev = JSON.parse(fs.readFileSync(path.join(root, "evidence/consumer-review-state-impact.json"), "utf8"));
  assert.deepEqual(ev.rows.filter((r) => r.ownerIsFactoryVault).map((r) => r.id), [...PRODUCTION.reviewedVaultHeld]);
  assert.equal(ev.book.deployments, PRODUCTION.ledger);
  for (const v of Object.values(TEXT)) assert.ok(!/[<>&"]/.test(v));
  assert.match(TEXT.EFFECT, /4 deployments held by the administrator's SessionVault/); assert.match(TEXT.ROLLBACK, /No simple rollback/); assert.match(TEXT.LEDE, /secretVaultV2 entry is NOT part/);
});

test("the deployed book's ACTUAL ABI: selected only by the exact code hash; no pendingOwner read; failures name the method", T, async (t) => {
  // the fixture is the deployed runtime itself (reproduced from source at 6c1135b0f; keccak = the live pin)
  assert.equal(keccak256(BOOK_RUNTIME), PRODUCTION.codeHashes.book);
  assert.equal(sha("evidence/book-legacy/EnclaveAddressBook.sol"), "124aa407863e2213d8ef700e6e9492e9112b7a8e1ce50fc10f324b781173ac9a");
  const live = JSON.parse(fs.readFileSync(path.join(root, "../custody-v2-live-20261023/evidence/book-abi-readcheck.json"), "utf8"));
  for (const r of live.rows) {
    assert.equal(r.codeHash, PRODUCTION.codeHashes.book, `${r.provider} reported the pinned code`);
    const pending = r.calls.find((x) => x.function === "pendingOwner");
    assert.deepEqual([pending.selector, pending.selectorPresentInCode, pending.error], ["0xe30c3978", false, "execution reverted"]);
  }
  const sels = push4s(BOOK_RUNTIME), fns = BOOK_ABI.filter((x) => x.type === "function");
  for (const f of fns) assert.ok(sels.has(toFunctionSelector(f)), `${f.name} is dispatched by the deployed code`);
  assert.ok(!sels.has("0xe30c3978"), "pendingOwner() is not in the deployed code");
  assert.ok(!sels.has(toFunctionSelector("acceptOwnership()")), "no two-step handoff in the deployed code");
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(root, "evidence/book-legacy/EnclaveAddressBook.abi.json"), "utf8")).filter((x) => x.type === "function").map((x) => x.name).sort(),
    fns.map((x) => x.name).sort(), "the ABI used is exactly the deployed source's committed ABI");
  assert.match(bookAbiFor(PRODUCTION.codeHashes.book).ownership, /single-step.*no pendingOwner/);
  assert.throws(() => bookAbiFor("0x" + "11".repeat(32)), /no reviewed ABI for the address book's code/);
  // the fake behaves like the chain: pendingOwner() reverts; the preparation never calls it
  const w = await world(t);
  const pendingCall = { to: PRODUCTION.book, data: "0xe30c3978" };
  assert.throws(() => w.base.answer("eth_call", [pendingCall, "latest"]), /execution reverted/);
  for (const p of w.net.list) p.calls.length = 0;
  const seen = [];
  for (const p of w.net.list) p.override.eth_call = (params, base) => { seen.push(String(params[0].data).slice(0, 10)); return base.answer("eth_call", params); };
  const o = await observe(w.clients, w.trust);
  assert.equal(o.bookOwnership, bookAbiFor(PRODUCTION.codeHashes.book).ownership);
  assert.ok(!seen.includes("0xe30c3978"), "no pendingOwner() call is ever made");
  assert.equal(o.book.pendingOwner, undefined);
  // a failing book read names the method, contract and provider
  w.net.list[1].override.eth_call = (params, base) => { if (String(params[0].data).startsWith("0x8da5cb5b")) throw Object.assign(Error("x"), { rpc: { code: 3, message: "execution reverted" } }); return base.answer("eth_call", params); };
  await assert.rejects(observe(w.clients, w.trust), /owner\(\) on 0xab214342d5a490150a4a977063a2f88e21f80907 failed on 127\.0\.0\.2:\d+: .*execution reverted/);
});

test("prepare: the exact unsigned request at an agreed anchor with the exhaustive impact; no key, no send", T, async (t) => {
  const w = await world(t);
  const r = await prepare({ trust: w.trust, clients: w.clients });
  assert.deepEqual([r.transaction.from, r.transaction.to, r.transaction.data, r.transaction.value, r.transaction.chainId, r.transaction.type],
    [PRODUCTION.admin, PRODUCTION.book, frozen(PRODUCTION).data, "0x0", "0x2105", "0x2"]);
  assert.equal(BigInt(r.transaction.nonce), 2210n);
  assert.ok(BigInt(r.transaction.gas) <= 120000n && BigInt(r.transaction.maxFeePerGas) <= 100_000_000n);
  assert.equal(r.impact.ledgerIds, 17); assert.equal(r.impact.stranded, 0);
  assert.deepEqual(r.impact.resolvedToAdministrator.map((x) => x.id), [...PRODUCTION.reviewedVaultHeld]);
  assert.deepEqual(r.impact.existingPolicies.map((p) => [p.vault, p.id, p.effect]), [["v1", POLICY_ID, "unchanged"], ["v2", POLICY_ID, "unchanged"]]);
  assert.match(r.notice, /NOT a safe rollback/);
  assert.equal(w.base.pool.length, 0, "nothing reached the chain");
});

test("prepare refuses every changed pin, owner, entry, ledger or impact", T, async (t) => {
  const cases = [
    ["the book contract's code", (w) => w.base.edit((s) => { s.code[PRODUCTION.book] = "0x6080dead"; })],
    ["the v1 contract's code", (w) => w.base.edit((s) => { s.code[PRODUCTION.vaults.v1] = "0x6080dead"; })],
    ["the implementation contract's code", (w) => w.base.edit((s) => { s.code[PRODUCTION.implementation] = "0x6080dead"; })],
    ["owner is not the administrator", (w) => w.base.edit((s) => { s.book.owner = EOA.other; })],
    ["already the original factory", (w) => w.base.edit((s) => { s.book.entries[keyOf("sessionVaultFactory")] = PRODUCTION.factory; })],
    ["not zero; stop", (w) => w.base.edit((s) => { s.book.entries[keyOf("sessionVaultFactory")] = EOA.other; })],
    ["another deployments ledger", (w) => w.base.edit((s) => { s.book.entries[keyOf("deployments")] = EOA.other; })],
    ["implementation is not the reviewed", (w) => w.base.edit((s) => { s.implementation = EOA.other; })],
    ["would strand it", (w) => w.base.edit((s) => { s.policies[PRODUCTION.vaults.v2][PRODUCTION.reviewedVaultHeld[0]] = { owner: PRODUCTION.sessionVault, policyRev: 1n }; })],
    ["would strand it", (w) => w.base.edit((s) => { s.policies[PRODUCTION.vaults.v1][PRODUCTION.reviewedVaultHeld[3]] = { owner: PRODUCTION.sessionVault, policyRev: 3n }; })],
    ["would change authority \\(restored\\)", (w) => w.base.edit((s) => { s.policies[PRODUCTION.vaults.v1][PRODUCTION.reviewedVaultHeld[1]] = { owner: PRODUCTION.admin, policyRev: 1n }; })],
    ["would change authority \\(claimant_changes\\)", (w) => w.base.edit((s) => { s.policies[PRODUCTION.vaults.v2][PRODUCTION.reviewedVaultHeld[2]] = { owner: EOA.other, policyRev: 1n }; })],
    ["was not in the reviewed set", (w) => w.base.edit((s) => { const id = keccak256("0x99"); s.ledger.ids.push(id); s.ledger.owner[id] = PRODUCTION.sessionVault; })],
    ["resolve to another wallet", (w) => w.base.edit((s) => { s.vaults[PRODUCTION.sessionVault] = EOA.other; })],
    ["4 deployments change resolution|3 deployments change", (w) => w.base.edit((s) => { s.ledger.owner[PRODUCTION.reviewedVaultHeld[0]] = PRODUCTION.admin; })],
    ["administrator transaction is pending", (w) => { w.base.mine(3); w.base.submit({ from: PRODUCTION.admin, to: EOA.other, value: 1, gas: 21000 }); return "pending"; }],
    ["network fee .* above the reviewed cap", (w) => { w.base.baseFee = 60_000_000n; }],
    ["outside the reviewed cap", (w) => { w.base.setGas = 110_000n; }],
    ["balance does not cover", (w) => w.base.edit((s) => { s.balance[PRODUCTION.admin] = 1000n; })],
  ];
  for (const [re, mutate] of cases) {
    const w = await world(t); if (mutate(w) !== "pending") w.base.mine(3);
    await assert.rejects(prepare({ trust: w.trust, clients: w.clients }), new RegExp(re), re);
  }
});

test("providers must agree; a wrong chain or a hanging provider fails closed within the bounds", T, async (t) => {
  let w = await world(t);
  w.net.list[1].override.eth_call = (params, base) => { const r = base.answer("eth_call", params); return params[0].to ? r : r.slice(0, -2) + "00"; };
  await assert.rejects(prepare({ trust: w.trust, clients: w.clients }), /disagree on a batched read|disagree on chain state/);
  w = await world(t);
  w.net.list[1].override.eth_getCode = (params, base) => (params[0] === PRODUCTION.vaults.v2 ? "0x6080beef" : base.answer("eth_getCode", params));
  await assert.rejects(prepare({ trust: w.trust, clients: w.clients }), /disagree on chain state/);
  w = await world(t); w.net.list[0].override.eth_chainId = () => "0x1";
  await assert.rejects(prepare({ trust: w.trust, clients: w.clients }), /disagree|wrong chain/);
  w = await world(t); w.net.list[1].hang = true;
  const t0 = Date.now();
  await assert.rejects(prepare({ trust: w.trust, clients: w.clients }), /no answer within/);
  assert.ok(Date.now() - t0 < 5000, "bounded by the per-request timeout");
});

test("transport end to end: journal before the wallet, one attempt, hash recorded only when a provider returns it exactly, verified with readback", T, async (t) => {
  const w = await world(t), s = await serve(t, w);
  const prep = await s.post("/prepare");
  assert.equal(prep.status, 200);
  assert.equal(s.journal.read().status, "awaiting-wallet");
  assert.deepEqual(s.journal.read().request.transaction, prep.body.transaction, "the journal holds exactly what the browser received");
  assert.equal((await s.post("/prepare")).status, 409, "one attempt per journal");
  assert.match((await s.post("/result", { hash: "0x" + "12".repeat(32) })).body.error, /neither provider returns this transaction/);
  assert.equal(s.journal.read().hash, undefined, "an unknown hash is not recorded");
  const hash = w.base.submit(prep.body.transaction);
  const pending = await s.post("/result", { hash });
  assert.equal(pending.status, 400); assert.match(pending.body.error, /no receipt|lacks two later blocks/);
  assert.equal(s.journal.read().status, "submitted"); assert.equal(s.journal.read().hash, hash);
  assert.equal((await s.post("/result", { hash: "0x" + "34".repeat(32) })).status, 409, "a recorded hash is never replaced");
  w.base.mine(3);
  const done = await s.post("/result", { hash });
  assert.equal(done.status, 200, JSON.stringify(done.body));
  assert.equal(done.body.entry, PRODUCTION.factory); assert.equal(done.body.bookOwner, PRODUCTION.admin); assert.equal(done.body.resolvedToAdministrator, 4);
  assert.equal(s.journal.read().status, "confirmed");
  // after activation a fresh preparation has nothing to sign
  await assert.rejects(prepare({ trust: w.trust, clients: w.clients }), /already the original factory/);
});

test("explicit 4001 resets; a restart keeps an open attempt; a lost response is resolved only by the real hash; nothing re-sent", T, async (t) => {
  const w = await world(t), journal = memoryJournal();
  let s = await serve(t, w, journal);
  let prep = await s.post("/prepare");
  assert.equal((await s.post("/rejected", { code: 4002 })).status, 409, "only an explicit 4001 resets");
  assert.equal((await s.post("/rejected", { code: 4001 })).status, 200);
  assert.equal(journal.read().status, "ready");
  prep = await s.post("/prepare");
  const hash = w.base.submit(prep.body.transaction);       // MetaMask sent it; the page never learned the hash
  await s.app.close();
  s = await serve(t, w, journal);                          // restart: the open attempt survives
  assert.equal(journal.read().status, "awaiting-wallet");
  assert.equal((await s.post("/prepare")).status, 409, "no second request while an attempt is open");
  // the admin nonce moved: a fresh preparation (outside the journal) also refuses while the transaction is pending
  await assert.rejects(prepare({ trust: w.trust, clients: w.clients }), /pending or was mined/);
  w.base.mine(3);
  const done = await s.post("/result", { hash });
  assert.equal(done.status, 200, JSON.stringify(done.body));
  assert.equal(w.base.pool.length, 0);
  // an interrupted preparation (crash mid-prepare) is reset; nothing reached the wallet
  const j = memoryJournal({ status: "preparing" });
  assert.equal(recoverInterruptedPreparation(j), true); assert.equal(j.read().status, "ready");
  assert.equal(recoverInterruptedPreparation(memoryJournal({ status: "awaiting-wallet" })), false, "an open attempt is never reset by a restart");
});

test("verification refuses an edited, re-gassed, fee-raised, reverted, wrongly-nonced or unrelated transaction, and a tampered journal", T, async (t) => {
  const cases = [
    ["the gas limit was changed", (tx) => ({ ...tx, gas: "0x" + (BigInt(tx.gas) + 1n).toString(16) })],
    ["raised the fee cap", (tx) => ({ ...tx, maxFeePerGas: "0x" + (BigInt(tx.maxFeePerGas) + 1n).toString(16) })],
    ["wrong calldata", (tx) => ({ ...tx, data: tx.data.slice(0, -2) + "00" })],
    ["wrong value", (tx) => ({ ...tx, value: "0x1" })],
  ];
  for (const [re, edit] of cases) {
    const w = await world(t), request = await prepare({ trust: w.trust, clients: w.clients });
    const hash = w.base.submit(edit(request.transaction)); w.base.mine(3);
    await assert.rejects(verify({ trust: w.trust, request, hash, clients: w.clients }), new RegExp(re), re);
  }
  // reverted: the book owner changed before it was mined
  let w = await world(t); let request = await prepare({ trust: w.trust, clients: w.clients });
  w.base.edit((s) => { s.book.owner = EOA.other; });
  let hash = w.base.submit(request.transaction); w.base.mine(3);
  await assert.rejects(verify({ trust: w.trust, request, hash, clients: w.clients }), /reverted/);
  // a different nonce (the wallet chose its own)
  w = await world(t); request = await prepare({ trust: w.trust, clients: w.clients });
  w.base.submit({ from: PRODUCTION.admin, to: EOA.other, value: 1, gas: 21000 });
  hash = w.base.submit({ ...request.transaction, nonce: "0x" + (BigInt(request.transaction.nonce) + 1n).toString(16) }); w.base.mine(3);
  await assert.rejects(verify({ trust: w.trust, request, hash, clients: w.clients }), /wrong nonce/);
  // too shallow
  w = await world(t); request = await prepare({ trust: w.trust, clients: w.clients });
  hash = w.base.submit(request.transaction); w.base.mine(1);
  await assert.rejects(verify({ trust: w.trust, request, hash, clients: w.clients }), /lacks two later blocks/);
  // a tampered journal request
  await assert.rejects(verify({ trust: w.trust, request: { ...request, transaction: { ...request.transaction, to: PRODUCTION.vaults.v1 } }, hash, clients: w.clients }), /destination changed/);
  // providers disagree on the receipt
  w = await world(t); request = await prepare({ trust: w.trust, clients: w.clients });
  hash = w.base.submit(request.transaction); w.base.mine(3);
  w.net.list[1].override.eth_getTransactionReceipt = (params, base) => ({ ...base.answer("eth_getTransactionReceipt", params), status: "0x0" });
  await assert.rejects(verify({ trust: w.trust, request, hash, clients: w.clients }), /reverted|disagree/);
});

test("L1 fee: the oracle's upper bound for the MAXIMUM SIGNED size; unsigned-only accounting is refused; no operator-fee claim", T, async (t) => {
  const w = await world(t), r = await prepare({ trust: w.trust, clients: w.clients });
  const fields = { nonce: Number(BigInt(r.transaction.nonce)), to: r.transaction.to, data: r.transaction.data, gas: BigInt(r.transaction.gas),
    fees: { maxFeePerGas: BigInt(r.transaction.maxFeePerGas), tip: BigInt(r.transaction.maxPriorityFeePerGas) } };
  const sizes = txSizes(w.trust, fields), e = r.feeBound.encodedBytes;
  assert.deepEqual([e.unsigned, e.signedMax, e.oracleArgument, e.oracleSignatureAllowance], [sizes.unsigned, sizes.signedMax, sizes.argument, 68]);
  assert.equal(sizes.signedMax - sizes.unsigned, 67, "yParity + 33-byte r + 33-byte s; the list header does not grow at this size");
  assert.ok(sizes.argument + ORACLE_SIGNATURE_ALLOWANCE >= sizes.signedMax, "the oracle-side size covers the maximum signed transaction");
  assert.equal(BigInt(r.feeBound.l1DataUpperBoundWei), l1UpperBound(sizes.argument, w.base.l1PerByte), "the fee is the oracle's upper bound for that size");
  assert.ok(BigInt(r.feeBound.l1DataUpperBoundWei) >= l1UpperBound(sizes.signedMax - 68, w.base.l1PerByte));
  assert.equal(BigInt(r.feeBound.totalExcludingOperatorFeeWei), BigInt(r.feeBound.l2MaxWei) + BigInt(r.feeBound.l1DataUpperBoundWei));
  assert.match(r.feeBound.note, /Not an all-fee cap: any OP-stack operator fee is not included/);
  assert.equal(r.estimatedFeeLimitWei, undefined, "no field claims an absolute fee limit");
  // unsigned-only accounting (the previous getL1Fee(unsigned bytes)) counts no signature bytes: refused
  assert.throws(() => assertCoversSigned({ argument: sizes.unsigned - ORACLE_SIGNATURE_ALLOWANCE, signedMax: sizes.signedMax }), /undercounts the signed transaction/);
  assert.throws(() => assertCoversSigned({ argument: sizes.signedMax - ORACLE_SIGNATURE_ALLOWANCE - 1, signedMax: sizes.signedMax }), /undercounts/);
  assert.doesNotThrow(() => assertCoversSigned(sizes));
  // a signature overhead above the oracle's allowance raises the argument instead of undercounting
  const big = txSizes(w.trust, { ...fields, data: "0x" + "ab".repeat(4000) });
  assert.ok(big.argument >= big.unsigned && big.argument + ORACLE_SIGNATURE_ALLOWANCE >= big.signedMax);
  // a wallet-added access list (larger than the bound) is refused at verification
  const hash = w.base.submit({ ...r.transaction, accessList: [{ address: PRODUCTION.book, storageKeys: [] }] }); w.base.mine(3);
  await assert.rejects(verify({ trust: w.trust, request: r, hash, clients: w.clients }), /access list/);
});

test("preflight is read-only and reports the request; serve refuses without the explicit flag", T, async (t) => {
  const w = await world(t);
  const journalSnapshot = () => { const d = path.join(root, "journals"); return fs.existsSync(d) ? fs.readdirSync(d).sort().map(f => [f, createHash("sha256").update(fs.readFileSync(path.join(d,f))).digest("hex")]) : null; };
  const beforeJournals = journalSnapshot();
  const out = await preflight({ trust: w.trust, clients: w.clients, journalStatus: "ready" });
  assert.equal(out.notSent, true); assert.equal(out.activate.ready, true, JSON.stringify(out.activate));
  assert.equal(out.activate.value.purpose, PURPOSE);
  assert.equal(w.base.pool.length, 0);
  for (const args of [[], ["--serve", "--now"], ["--stage", "x"]]) {
    const r = spawnSync(process.execPath, [path.join(root, "serve.mjs"), ...args], { encoding: "utf8", timeout: 10000, env: { PATH: process.env.PATH } });
    assert.notEqual(r.status, 0); assert.match(r.stderr, /usage: node serve.mjs --serve/);
  }
  assert.deepEqual(journalSnapshot(), beforeJournals, "existing journals were not changed and no journal was written by these runs");
});

test("effectOf (the review's classifier) and the static page carry no inline script and no automatic wallet call", () => {
  const html = assets()["/"].body, js = assets()["/app.js"].body;
  assert.ok(!/<script>(?!<)/.test(html) && /<script src="\/app.js" defer><\/script>/.test(html));
  const sends = [...js.matchAll(/method: 'eth_sendTransaction'/g)].length;
  assert.equal(sends, 1);
  const signBody = js.slice(js.indexOf("el('sign').onclick"));
  assert.ok(signBody.includes("eth_sendTransaction"), "the only send is inside the Review click handler");
  assert.ok(!/eth_sign['"]|personal_sign|eth_signTypedData/.test(js), "no custom signatures");
  assert.equal(effectOf({ before: PRODUCTION.sessionVault, after: PRODUCTION.admin, policy: { owner: PRODUCTION.sessionVault, policyRev: "1" } }), "STRANDED");
  assert.equal(effectOf({ before: PRODUCTION.sessionVault, after: PRODUCTION.admin, policy: { owner: ZERO, policyRev: "0" } }), "no_policy_first_writer_changes");
});


test("full 98-id impact read fits deployless EIP-170 limit; old 120-call batch fails", T, async (t) => {
  const w = await world(t);
  w.base.edit(s => {
    while (s.ledger.ids.length < 98) {
      const id = "0x" + BigInt(10000 + s.ledger.ids.length).toString(16).padStart(64, "0");
      s.ledger.ids.push(id); s.ledger.owner[id] = EOA.other;
    }
  });
  w.base.mine(3);
  const old = { ...w.trust, caps: { ...w.trust.caps, batch: 120 } };
  await assert.rejects(() => prepare({trust:old,clients:w.clients}), /CreateContractSizeLimit/);
  const prepared = await prepare({trust:w.trust,clients:w.clients});
  assert.ok(prepared);
});
