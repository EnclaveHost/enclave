// An EXISTING credit vault operated with Enclave's billing API refused (site/js/core/credit-vault-independent.js,
// cli/credit-vault.mjs). Everything that decides authority is real: the PRODUCTION credit-vault factory bytecode
// (test/fixtures/credit-vault-d36100ae.json, origin https://enclave.host), the live rev-16d ledger and schema-4 registry
// sources (test/fixtures/credit-vault-independence-chain.json), the real address book, anvil's RIP-7212 P-256 precompile
// (--optimism), P-256 passkey assertions signed by @noble/curves in the exact WebAuthn shape, the site's own
// quorum reader over two RPC origins, the CLI and its relay as separate code paths. Stand-ins: MockUSDC (a settled card
// top-up is modelled as USDC minted to the vault, which is what the relay's float deposit amounts to) and the ETH/USD feed.
// Runs inside an unshared network namespace (test/run-credit-vault.sh): no Enclave API, RPC or DNS is reachable, and a
// fetch guard records every request this process makes.
//   node --test test/credit-vault-independent.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createPublicClient, createWalletClient, http as viemHttp, encodeDeployData, encodeFunctionData, decodeEventLog, parseAbi, keccak256, toHex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { p256 } from "@noble/curves/p256";
import { sha256 } from "@noble/hashes/sha256";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CV = await import(path.join(REPO, "site/js/core/credit-vault-independent.js"));
const { createQuorumReader, jsonRpc } = await import(path.join(REPO, "site/js/core/quorum.js"));
const CLI = await import(path.join(REPO, "cli/credit-vault.mjs"));
const { verifyPrepare } = await import(path.join(REPO, "site/js/core/vault.js"));
const lib = CLI.lib;
const F = await import(path.join(REPO, "test/credit-vault-fixture.mjs"));
const { VAULT_FX, CHAIN_FX, ORIGIN, RPID, sleep, lc, freePort, KEYS, ACCT, TREASURY, PAYOUT, passkey, rawAssertion, startChain, deploy, deployLedger, send, bookKey,
  deployStack, usdcOf, recordOf, nonceOf, eip1193, memJournal } = F;
const haveAnvil = (() => { try { execFileSync("anvil", ["--version"], { stdio: "ignore" }); return true; } catch { return false; } })();

/* ---- every request this process makes is recorded; only loopback is allowed ---- */
const requests = [];
const realFetch = globalThis.fetch;
globalThis.fetch = (url, opts) => {
  const u = new URL(typeof url === "string" ? url : url.url);
  requests.push(u.href);
  if (!["127.0.0.1", "localhost"].includes(u.hostname)) return Promise.reject(new Error("refused by the test's fetch guard: " + u.host));
  return realFetch(url, opts);
};

if (process.env.INJECT_FAILURE) test("INJECTED FAILURE (negative control: the suite must exit nonzero)", () => assert.fail("injected"));

test("existing credit vault without the billing API", { skip: process.env.INJECT_FAILURE ? "negative-control run: only the injected test" : !haveAnvil ? "needs Foundry's anvil" : false, timeout: 600000 }, async (t) => {
  const stops = [];
  t.after(() => { for (const s of stops.reverse()) try { s(); } catch {} });
  const A = await startChain(8453, stops);
  const S = await deployStack(A);
  const PINS = CV.validatePins({ chainId: 8453, origin: ORIGIN, rpId: RPID, usdc: S.usdc, factories: [S.older, S.current] });
  const reader = CV.withTxReads(createQuorumReader({ rpcs: A.rpcs, quorum: 2, confirmations: 0, maxBlockAgeSeconds: 3600, chainId: 8453 }), jsonRpc());
  const K1 = passkey();
  const opts = { reader, pins: PINS };
  const wallet = () => CV.walletTransport(eip1193(A), ACCT.payer.address);
  // A wallet acknowledges broadcast before mining. Tests of executed state wait
  // for inclusion explicitly; hostile relay/pending/replay-refusal paths stay raw.
  const submitConfirmedWallet = async (request, options) => {
    const submitted = await CV.submitRequest(lib, request, wallet(), options);
    assert.equal(submitted.status, "broadcast");
    const receipt = await A.pub.waitForTransactionReceipt({ hash: submitted.txHash, pollingInterval: 50, timeout: 30000 });
    assert.equal(receipt.status, "success");
    return submitted;
  };

  // the customer's credit: a vault at the OLDER factory (from before a factory rotation) and at the current one
  const vOld = CV.deriveVault(lib, K1.x, K1.y, S.older), vCur = CV.deriveVault(lib, K1.x, K1.y, S.current);
  await send(A, "admin", S.older.address, CV.ABI.factory, "createVault", [BigInt(K1.x), BigInt(K1.y)]);
  await send(A, "admin", S.usdc, CHAIN_FX.MockUSDC.abi, "mint", [vOld, 25_000000n]);
  await send(A, "admin", S.usdc, CHAIN_FX.MockUSDC.abi, "mint", [vCur, 100_000000n]);   // credit sent before the vault is minted
  const profileOf = (row, k, label) => CV.makeProfile(row, { credentialId: k.credentialId, label }, PINS);
  let profile, deploymentId, signer = K1;
  const sign = (prepared, intent, extra = {}) => CV.signPrepared(lib, prepared, profile, { pins: PINS, origin: ORIGIN, getFn: signer.getFn(), intent, ...extra });

  await t.test("derive and recover the same existing vault (factory history, quorum, no account record)", async () => {
    // the key from two passkey answers alone
    const key = await CV.recoverPasskeyKey(lib, await rawAssertion(K1, "0x" + "11".repeat(32)), await rawAssertion(K1, "0x" + "22".repeat(32)));
    assert.deepEqual(key, { x: K1.x, y: K1.y });
    await assert.rejects(CV.recoverPasskeyKey(lib, await rawAssertion(K1, "0x" + "11".repeat(32)), await rawAssertion(passkey(), "0x" + "22".repeat(32))), /SAME passkey/);
    // ...or from the hosted account's migration file
    assert.deepEqual(CV.passkeysFromMigrationFile({ kind: "EAB1-bundle", credentials: [{ kind: "passkey", value: `p256:${K1.x.slice(2)}:${K1.y.slice(2)}:${K1.credentialId}` }] })[0],
      { credentialId: K1.credentialId, x: K1.x, y: K1.y });
    let d = await CV.discoverVaults(lib, key, opts);
    const [o, c] = d.vaults;
    assert.equal(o.vault, vOld); assert.equal(o.deployed, true); assert.equal(o.balance6, "25000000"); assert.equal(o.current, false); assert.equal(o.keyActive, true);
    assert.equal(c.vault, vCur); assert.equal(c.deployed, false); assert.equal(c.balance6, "100000000", "credit at the counterfactual address is visible before minting");
    for (const f of [S.older, S.current]) assert.equal(lc(await A.pub.readContract({ address: f.address, abi: CV.ABI.factory, functionName: "vaultFor", args: [BigInt(K1.x), BigInt(K1.y)] })), CV.deriveVault(lib, K1.x, K1.y, f));
    // anyone mints (no authority): then the current vault reads with the book's ledger
    await send(A, "other", S.current.address, CV.ABI.factory, "createVault", [BigInt(K1.x), BigInt(K1.y)]);
    d = await CV.discoverVaults(lib, key, opts);
    assert.equal(d.vaults[1].deployed, true); assert.equal(d.vaults[1].current, true); assert.equal(d.vaults[1].ledger, S.ledger); assert.equal(d.vaults[1].nonce, "0");
    profile = profileOf({ ...d.vaults[1], key }, K1, "laptop");
    // a factory that is not what the pins say is refused, not trusted
    await assert.rejects(CV.discoverVaults(lib, key, { reader, pins: { ...PINS, factories: [{ ...S.current, implementation: S.older.implementation }] } }), /reports implementation/);
  });

  await t.test("authentic signed deploy, fund and control with exact balances (owner's wallet pays gas)", async () => {
    const journal = memJournal();
    const run = async (op, params) => {
      const prepared = await CV.prepareVaultOp(lib, profile, op, params, { ...opts, journal });
      const req = await CV.signPrepared(lib, prepared, profile, { pins: PINS, origin: ORIGIN, getFn: K1.getFn(), intent: { op, params } });
      const s = await submitConfirmedWallet(req, { journal, reader, pins: PINS });
      assert.equal(s.status, "broadcast");
      const r = await CV.reconcile(lib, await journal.get(profile.vault), { reader, journal });
      assert.equal(r.status, "executed", op); assert.equal(r.txHash, s.txHash);
      assert.equal(await journal.get(profile.vault), null);
      return { prepared, req, receipt: await A.pub.getTransactionReceipt({ hash: s.txHash }) };
    };
    const eth0 = await A.pub.getBalance({ address: ACCT.payer.address });
    const spec = { appRef: "catalog://app/0", gpuMilli: 0, cpuMilli: 500, appPort: 8080, ports: "", isPublic: true, configCid: "", maxRate6: "1000" };
    const { receipt } = await run("deploy", { spec, fundUsd: "30" });
    const ev = receipt.logs.filter((l) => lc(l.address) === profile.vault).map((l) => { try { return decodeEventLog({ abi: parseAbi(["event Deployed(bytes32 indexed id, uint256 funded6)"]), ...l }); } catch { return null; } }).find(Boolean);
    deploymentId = ev.args.id;
    let rec = await recordOf(A, S.ledger, deploymentId);
    assert.equal(lc(rec.owner), profile.vault, "the vault owns the record"); assert.equal(rec.balance6, 30_000000n);
    assert.equal(await usdcOf(A, S, profile.vault), 70_000000n);
    assert.ok((await A.pub.getBalance({ address: ACCT.payer.address })) < eth0, "the owner's wallet paid the gas");
    assert.equal(await A.pub.getBalance({ address: profile.vault }), 0n, "no ETH ever in the vault");
    await run("fund", { id: deploymentId, amountUsd: "10" });
    rec = await recordOf(A, S.ledger, deploymentId);
    assert.equal(rec.balance6, 40_000000n); assert.equal(await usdcOf(A, S, profile.vault), 60_000000n);
    await run("control", { id: deploymentId, action: "suspend" });
    assert.equal((await recordOf(A, S.ledger, deploymentId)).active, false);
    await run("control", { id: deploymentId, action: "resize", gpuMilli: 0, cpuMilli: 250, ref: "catalog://app/0@2", active: true });
    rec = await recordOf(A, S.ledger, deploymentId);
    assert.equal(rec.appRef, "catalog://app/0@2"); assert.equal(rec.cpuMilli, 250); assert.equal(rec.active, true);
    await run("control", { id: deploymentId, action: "maxrate", maxRate6: "2000" });
    assert.equal(await A.pub.readContract({ address: S.ledger, abi: CHAIN_FX.EnclaveDeployments.abi, functionName: "capOf", args: [deploymentId] }), 2000n);
    await run("control", { id: deploymentId, action: "options", envelope: '{"waf":{"rps":10}}' });
    assert.equal(await nonceOf(A, profile.vault), 6n);
  });

  await t.test("malicious preparation, amount, fee or target is refused before the passkey is asked", async () => {
    const spec = { appRef: "catalog://app/9", gpuMilli: 0, cpuMilli: 500, appPort: 8080, ports: "", isPublic: true, configCid: "", maxRate6: "1000" };
    const intent = { op: "deploy", params: { spec, fundUsd: "5" } };
    const good = await CV.prepareVaultOp(lib, profile, "deploy", intent.params, opts);
    const redigest = (p) => ({ ...p, digest: CV.opDigest(lib, p.op, { vault: p.vault, chainId: p.chainId, nonce: p.nonce, deadline: p.deadline, args: p.args }) });
    const attacker = "0x000000000000000000000000000000000000dead";
    const feeCall = encodeFunctionData({ abi: parseAbi(["function create(string,uint16,uint16,uint32,string,bool,string,address,uint256,uint256)"]), functionName: "create",
      args: [spec.appRef, 0, 500, 8080, "", true, "", attacker, 900n, 1000n] });
    const calls0 = K1.calls;
    const tampered = [
      [redigest({ ...good, args: { ...good.args, createCall: feeCall } }), /different create\(\)/],
      [redigest({ ...good, args: { ...good.args, fund6: "50000000" } }), /different amount/],
      [{ ...good, digest: "0x" + "ab".repeat(32) }, /digest that is not/],
      [redigest({ ...good, deadline: String(Number(good.blockTimestamp) + 3600) }), /deadline beyond/],
    ];
    for (const [p, why] of tampered)
      await assert.rejects(CV.signPrepared(lib, p, profile, { pins: PINS, origin: ORIGIN, getFn: K1.getFn(), intent }), why);
    const fundIntent = { op: "fund", params: { id: deploymentId, amountUsd: "1" } };
    const f = await CV.prepareVaultOp(lib, profile, "fund", fundIntent.params, opts);
    await assert.rejects(CV.signPrepared(lib, redigest({ ...f, args: { ...f.args, id: "0x" + "77".repeat(32) } }), profile, { pins: PINS, origin: ORIGIN, getFn: K1.getFn(), intent: fundIntent }), /different deployment/);
    const ctlIntent = { op: "control", params: { id: deploymentId, action: "suspend" } };
    const cp = await CV.prepareVaultOp(lib, profile, "control", ctlIntent.params, opts);
    const xfer = encodeFunctionData({ abi: parseAbi(["function transferDeployment(bytes32,address)"]), functionName: "transferDeployment", args: [deploymentId, attacker] });
    await assert.rejects(CV.signPrepared(lib, redigest({ ...cp, args: { callData: xfer } }), profile, { pins: PINS, origin: ORIGIN, getFn: K1.getFn(), intent: ctlIntent }), /different change/);
    assert.equal(K1.calls, calls0, "the passkey was never prompted for a tampered operation");
    // the request bytes, changed in transit by a relay: refused by the re-derivation, and by the vault if sent anyway
    const req = await CV.signPrepared(lib, f, profile, { pins: PINS, origin: ORIGIN, getFn: K1.getFn(), intent: fundIntent });
    const w64 = (h) => h.padStart(64, "0");
    const bumped = { ...req, data: req.data.replace(w64("f4240"), w64("2faf080")) };     // $1 -> $50
    assert.notEqual(bumped.data, req.data);
    assert.throws(() => CV.verifyRequest(lib, bumped, PINS), /digest is not the digest/);
    const bal = await usdcOf(A, S, profile.vault), n = await nonceOf(A, profile.vault);
    await assert.rejects(A.raw("eth_call", [{ from: ACCT.payer.address, to: bumped.to, data: bumped.data }, "latest"]), /bad signature/);
    assert.equal(await usdcOf(A, S, profile.vault), bal); assert.equal(await nonceOf(A, profile.vault), n);
    // the hosted default path keeps its own gate: a lying billing server's preparation is refused by site/js/core/vault.js
    const hostedPrep = { op: "fund", vault: profile.vault, chainId: 8453, nonce: String(n), deadline: f.deadline, id: deploymentId, fund6: "50000000", credId: K1.credentialId };
    hostedPrep.digest = CV.opDigest(lib, "fund", { vault: profile.vault, chainId: 8453, nonce: n, deadline: f.deadline, args: { id: deploymentId, fund6: "50000000" } });
    assert.throws(() => verifyPrepare("fund", hostedPrep, { id: deploymentId, amountUsd: 1 }), /larger amount/);
  });

  await t.test("replay, removed owner key, wrong chain and wrong origin are rejected", async () => {
    const journal = memJournal();
    // replay: an executed request, submitted again
    const intent = { op: "fund", params: { id: deploymentId, amountUsd: "2" } };
    const prep = await CV.prepareVaultOp(lib, profile, "fund", intent.params, opts);
    const req = await CV.signPrepared(lib, prep, profile, { pins: PINS, origin: ORIGIN, getFn: K1.getFn(), intent });
    assert.equal((await submitConfirmedWallet(req, { journal, reader, pins: PINS })).status, "broadcast");
    assert.equal((await CV.reconcile(lib, await journal.get(profile.vault), { reader, journal })).status, "executed");
    const bal = await usdcOf(A, S, profile.vault);
    await assert.rejects(CV.submitRequest(lib, req, wallet(), { journal, reader, pins: PINS }), /vault would refuse/);
    const h = await A.raw("eth_sendTransaction", [{ from: ACCT.other.address, to: req.to, data: req.data, gas: "0x200000" }]);
    assert.equal((await A.pub.waitForTransactionReceipt({ hash: h })).status, "reverted", "the vault refuses the replay on chain");
    assert.equal(await usdcOf(A, S, profile.vault), bal);

    // wrong origin: the page refuses before any prompt; an assertion made at another origin is refused here and on chain
    const c0 = K1.calls;
    const ip = await CV.prepareVaultOp(lib, profile, "fund", intent.params, opts);
    await assert.rejects(CV.signPrepared(lib, ip, profile, { pins: PINS, origin: "https://x.app.enclave.host", getFn: K1.getFn(), intent }), /signing works only at https:\/\/enclave.host/);
    assert.equal(K1.calls, c0);
    await assert.rejects(CV.signPrepared(lib, ip, profile, { pins: PINS, origin: ORIGIN, getFn: K1.getFn({ origin: "https://x.app.enclave.host" }), intent }), /not an assertion over this exact operation at https:\/\/enclave.host/);
    const evil = await rawAssertion(K1, ip.digest, "https://x.app.enclave.host");
    const evilData = encodeFunctionData({ abi: CV.ABI.vault, functionName: "fundDeployment", args: [deploymentId, 2_000000n, BigInt(ip.deadline),
      { authenticatorData: evil.authenticatorData, clientDataJSON: evil.clientDataJSON, r: evil.r, s: evil.s, x: BigInt(K1.x), y: BigInt(K1.y) }] });
    await assert.rejects(A.raw("eth_call", [{ from: ACCT.payer.address, to: profile.vault, data: evilData }, "latest"]), /bad signature/);
    // and a missing user-presence flag
    await assert.rejects(CV.signPrepared(lib, ip, profile, { pins: PINS, origin: ORIGIN, getFn: K1.getFn({ flags: 0x00 }), intent }), /user presence/);

    // wrong chain: the same stack on chain 84532 (same addresses); a request signed for 8453 is refused there
    const B = await startChain(84532, stops);
    const SB = await deployStack(B);
    assert.equal(SB.current.address, S.current.address);
    await send(B, "admin", SB.current.address, CV.ABI.factory, "createVault", [BigInt(K1.x), BigInt(K1.y)]);
    await send(B, "admin", SB.usdc, CHAIN_FX.MockUSDC.abi, "mint", [profile.vault, 100_000000n]);
    const cross = await CV.signPrepared(lib, ip, profile, { pins: PINS, origin: ORIGIN, getFn: K1.getFn(), intent });
    assert.throws(() => CV.verifyRequest(lib, cross, { ...PINS, chainId: 84532 }), /for chain 8453/);
    await assert.rejects(B.raw("eth_call", [{ from: ACCT.payer.address, to: cross.to, data: cross.data }, "latest"]), /bad signature/);

    // removed key: K1 adds a second passkey K2; K2 removes K1; K1 is refused from then on
    const K2 = passkey();
    const addI = { op: "addKey", params: { x: K2.x, y: K2.y } };
    let p = await CV.prepareVaultOp(lib, profile, "addKey", addI.params, opts);
    let r = await CV.signPrepared(lib, p, profile, { pins: PINS, origin: ORIGIN, getFn: K1.getFn(), intent: addI });
    await submitConfirmedWallet(r, { journal, reader, pins: PINS }); assert.equal((await CV.reconcile(lib, await journal.get(profile.vault), { reader, journal })).status, "executed");
    const row2 = await CV.checkVaultForKey(lib, profile.vault, K2, opts);
    const profile2 = profileOf(row2, K2, "phone");
    const kh1 = CV.keyHash(lib, K1.x, K1.y);
    const delI = { op: "removeKey", params: { keyHash: kh1 } };
    p = await CV.prepareVaultOp(lib, profile2, "removeKey", delI.params, opts);
    r = await CV.signPrepared(lib, p, profile2, { pins: PINS, origin: ORIGIN, getFn: K2.getFn(), intent: delI });
    await submitConfirmedWallet(r, { journal, reader, pins: PINS }); assert.equal((await CV.reconcile(lib, await journal.get(profile.vault), { reader, journal })).status, "executed");
    await assert.rejects(CV.prepareVaultOp(lib, profile, "fund", intent.params, opts), /not an active key/);
    await assert.rejects(CV.checkVaultForKey(lib, profile.vault, K1, opts), /not an active key/);
    const st = await CV.vaultState(lib, profile2, opts);
    const late = await rawAssertion(K1, CV.opDigest(lib, "fund", { vault: profile.vault, chainId: 8453, nonce: st.nonce, deadline: BigInt(st.snap.timestamp + 300), args: { id: deploymentId, fund6: 1_000000n } }));
    const lateData = encodeFunctionData({ abi: CV.ABI.vault, functionName: "fundDeployment", args: [deploymentId, 1_000000n, BigInt(st.snap.timestamp + 300),
      { authenticatorData: late.authenticatorData, clientDataJSON: late.clientDataJSON, r: late.r, s: late.s, x: BigInt(K1.x), y: BigInt(K1.y) }] });
    await assert.rejects(A.raw("eth_call", [{ from: ACCT.payer.address, to: profile.vault, data: lateData }, "latest"]), /bad signature/);
    await assert.rejects(CV.prepareVaultOp(lib, profile2, "removeKey", { keyHash: CV.keyHash(lib, K2.x, K2.y), allowSelf: true }, opts), /last key/);
    profile = profile2; signer = K2;   // the owner continues with the phone's passkey
  });

  await t.test("a lost submission reply is held and reconciles once; expired and superseded requests are decided", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cv-relay-"));
    stops.push(() => fs.rmSync(dir, { recursive: true, force: true }));
    const keyFile = path.join(dir, "relay.key"); fs.writeFileSync(keyFile, KEYS.relay, { mode: 0o600 });
    const pinsFile = path.join(dir, "pins.json"); fs.writeFileSync(pinsFile, JSON.stringify(PINS));
    const relay = spawn(process.execPath, [path.join(REPO, "cli/credit-vault.mjs"), "relay", "--listen", "127.0.0.1:0", "--key-file", keyFile, "--pins", pinsFile,
      "--rpc", A.rpcs.join(","), "--confirmations", "0", "--max-block-age", "3600"], { stdio: ["ignore", "pipe", "inherit"] });
    stops.push(() => relay.kill("SIGKILL"));
    const line = await new Promise((ok, bad) => { relay.stdout.once("data", (d) => ok(String(d))); relay.once("exit", (c) => bad(new Error("relay exited " + c))); });
    const relayUrl = JSON.parse(line).relay;
    // a front that forwards the first submission to the relay and then drops the reply (the client never hears back)
    let dropped = 0;
    const front = http.createServer((req, res) => {
      const chunks = []; req.on("data", (c) => chunks.push(c)); req.on("end", async () => {
        const r = await realFetch(relayUrl + req.url, { method: req.method, headers: { "content-type": "application/json" }, body: req.method === "POST" ? Buffer.concat(chunks) : undefined });
        const body = Buffer.from(await r.arrayBuffer());
        if (dropped++ === 0){ req.socket.destroy(); return; }
        res.writeHead(r.status, { "content-type": "application/json" }); res.end(body);
      });
    });
    await new Promise((r) => front.listen(0, "127.0.0.1", r)); stops.push(() => front.close());
    const frontUrl = `http://127.0.0.1:${front.address().port}`;
    const journal = CLI.fileJournal(path.join(dir, "journal"), 8453);
    const intent = { op: "fund", params: { id: deploymentId, amountUsd: "5" } };
    const req = await sign(await CV.prepareVaultOp(lib, profile, "fund", intent.params, { ...opts, journal }), intent);
    const bal0 = await usdcOf(A, S, profile.vault), rec0 = (await recordOf(A, S.ledger, deploymentId)).balance6;
    const relayEth0 = await A.pub.getBalance({ address: ACCT.relay.address });
    const s1 = await CV.submitRequest(lib, req, CV.relayTransport(frontUrl), { journal, pins: PINS });
    assert.equal(s1.status, "unknown", "the reply was lost: the outcome is unknown");
    assert.equal(dropped, 1);
    assert.equal((await journal.get(profile.vault)).request.digest, req.digest, "held in the owner's journal");
    await assert.rejects(CV.prepareVaultOp(lib, profile, "fund", intent.params, { ...opts, journal }), /still undecided/, "nothing new is prepared while it is held");
    let r;
    for (let i = 0; i < 50; i++){ r = await CV.reconcile(lib, await journal.get(profile.vault), { reader, journal }); if (r.status !== "pending") break; await sleep(100); }
    assert.equal(r.status, "executed", "found on chain by its exact bytes, with no transaction hash known");
    assert.match(r.txHash, /^0x[0-9a-f]{64}$/);
    assert.equal(await journal.get(profile.vault), null, "decided and released");
    assert.equal(await usdcOf(A, S, profile.vault), bal0 - 5_000000n, "the credit moved exactly once");
    assert.equal((await recordOf(A, S.ledger, deploymentId)).balance6, rec0 + 5_000000n);
    assert.ok((await A.pub.getBalance({ address: ACCT.relay.address })) < relayEth0, "the relay paid the gas, not the vault");
    // the client retries the same bytes (now the reply arrives): the relay answers the same transaction, nothing moves
    const s2 = await CV.submitRequest(lib, req, CV.relayTransport(frontUrl), { journal, pins: PINS });
    assert.equal(s2.status, "broadcast"); assert.equal(s2.txHash, r.txHash, "idempotent by digest");
    assert.equal((await CV.reconcile(lib, await journal.get(profile.vault), { reader, journal })).status, "executed");
    assert.equal(await usdcOf(A, S, profile.vault), bal0 - 5_000000n, "still exactly once");
    // a control op whose reply is lost is found through the LEDGER's logs (the vault emits nothing for control)
    dropped = 0;
    const ctl2 = { op: "control", params: { id: deploymentId, action: "suspend" } };
    const req5 = await sign(await CV.prepareVaultOp(lib, profile, "control", ctl2.params, { ...opts, journal }), ctl2);
    assert.equal((await CV.submitRequest(lib, req5, CV.relayTransport(frontUrl), { journal, pins: PINS })).status, "unknown");
    for (let i = 0; i < 50; i++){ r = await CV.reconcile(lib, await journal.get(profile.vault), { reader, journal }); if (r.status !== "pending") break; await sleep(100); }
    assert.equal(r.status, "executed"); assert.equal((await recordOf(A, S.ledger, deploymentId)).active, false);
    // a relay that answers a refusal does not release the hold; the chain decides. Unreachable relay -> held, then EXPIRED
    const dead = `http://127.0.0.1:${await freePort()}`;
    const req2 = await sign(await CV.prepareVaultOp(lib, profile, "fund", { ...intent.params, deadlineSec: 30 }, { ...opts, journal }), { op: "fund", params: { ...intent.params, deadlineSec: 30 } });
    assert.equal((await CV.submitRequest(lib, req2, CV.relayTransport(dead, { timeoutMs: 2000 }), { journal, pins: PINS })).status, "unknown");
    assert.equal((await CV.reconcile(lib, await journal.get(profile.vault), { reader, journal })).status, "pending");
    await sleep(32000); await A.raw("evm_mine");       // real time: every reader (site, CLI, relay) checks block freshness against the clock
    assert.equal((await CV.reconcile(lib, await journal.get(profile.vault), { reader, journal })).status, "expired");
    assert.equal(await journal.get(profile.vault), null);
    assert.equal(await usdcOf(A, S, profile.vault), bal0 - 5_000000n, "an expired request never moves anything");
    // SUPERSEDED: a request held on this device while another device spends the same nonce
    const other = memJournal();
    const req3 = await sign(await CV.prepareVaultOp(lib, profile, "fund", intent.params, { ...opts, journal }), intent);
    assert.equal((await CV.submitRequest(lib, req3, CV.relayTransport(dead, { timeoutMs: 2000 }), { journal, pins: PINS })).status, "unknown");
    const ctl = { op: "control", params: { id: deploymentId, action: "resume" } };
    const req4 = await sign(await CV.prepareVaultOp(lib, profile, "control", ctl.params, { ...opts, journal: other }), ctl);
    assert.equal(req4.nonce, req3.nonce);
    await submitConfirmedWallet(req4, { journal: other, reader, pins: PINS });
    assert.equal((await CV.reconcile(lib, await other.get(profile.vault), { reader, journal: other })).status, "executed", "control: found by its receipt");
    assert.equal((await CV.reconcile(lib, await journal.get(profile.vault), { reader, journal })).status, "superseded");
    await assert.rejects(A.raw("eth_call", [{ from: ACCT.payer.address, to: req3.to, data: req3.data }, "latest"]), /bad signature/, "the superseded bytes can never execute");
  });

  await t.test("the platform book stays authoritative for ledger and factory versions; older vaults keep working", async () => {
    // admin repoints "deployments" to a new ledger revision: the vault pays and controls THAT ledger
    const ledger2 = await deployLedger(A, [S.usdc, PAYOUT, S.registry, S.feed]);
    await send(A, "admin", S.book, CHAIN_FX.EnclaveAddressBook.abi, "set", [bookKey("deployments"), ledger2]);
    const st = await CV.vaultState(lib, profile, opts);
    assert.equal(st.ledger, ledger2);
    await assert.rejects(CV.prepareVaultOp(lib, profile, "control", { id: deploymentId, action: "resume" }, opts), /no such deployment on the ledger the book names/);
    const spec = { appRef: "catalog://app/1", gpuMilli: 0, cpuMilli: 500, appPort: 8080, ports: "", isPublic: false, configCid: "", maxRate6: "1500" };
    const intent = { op: "deploy", params: { spec, fundUsd: "4" } };
    const journal = memJournal();
    const req = await sign(await CV.prepareVaultOp(lib, profile, "deploy", intent.params, opts), intent);
    const s = await submitConfirmedWallet(req, { journal, reader, pins: PINS });
    assert.equal((await CV.reconcile(lib, await journal.get(profile.vault), { reader, journal })).status, "executed");
    const rc = await A.pub.getTransactionReceipt({ hash: s.txHash });
    assert.ok(rc.logs.some((l) => lc(l.address) === ledger2), "created on the ledger the book names");
    await send(A, "admin", S.book, CHAIN_FX.EnclaveAddressBook.abi, "set", [bookKey("deployments"), S.ledger]);
    // admin repoints "vaultFactory": discovery follows the book's notion of current
    await send(A, "admin", S.book, CHAIN_FX.EnclaveAddressBook.abi, "set", [bookKey("vaultFactory"), S.older.address]);
    const d = await CV.discoverVaults(lib, { x: K1.x, y: K1.y }, opts);
    assert.equal(d.vaults[0].current, true); assert.equal(d.vaults[1].current, false);
    await send(A, "admin", S.book, CHAIN_FX.EnclaveAddressBook.abi, "set", [bookKey("vaultFactory"), S.current.address]);
    // the OLDER vault (K1 is still its key): its credit is returned through its own immutable refund path, to the treasury
    const pOld = profileOf({ ...d.vaults[0], key: { x: K1.x, y: K1.y } }, K1, "older vault");
    const t0 = await usdcOf(A, S, TREASURY);
    await assert.rejects(CV.prepareVaultOp(lib, pOld, "refund", { amountUsd: "25" }, opts), /acknowledgeTreasury/);
    const ri = { op: "refund", params: { amountUsd: "25", acknowledgeTreasury: true } };
    const pr = await CV.prepareVaultOp(lib, pOld, "refund", ri.params, opts);
    assert.ok(pr.limits.some((l) => /off-chain/.test(l)));
    const rq = await CV.signPrepared(lib, pr, pOld, { pins: PINS, origin: ORIGIN, getFn: K1.getFn(), intent: ri });
    await submitConfirmedWallet(rq, { journal, reader, pins: PINS });
    assert.equal((await CV.reconcile(lib, await journal.get(pOld.vault), { reader, journal })).status, "executed");
    assert.equal(await usdcOf(A, S, TREASURY), t0 + 25_000000n); assert.equal(await usdcOf(A, S, pOld.vault), 0n);
  });

  await t.test("app lease gas: a vault-owned record is recognized and no reserve deposit is offered", async () => {
    const code = await A.pub.getCode({ address: profile.vault });
    assert.equal(CV.isCreditVaultClone(lib, code, PINS).address, S.current.address);
    assert.equal(CV.isCreditVaultClone(lib, "0x", PINS), null);
    assert.match(CV.reserveRefusal(true), /unavailable for a deployment owned by a credit vault/);
    assert.equal(CV.reserveRefusal(false), null);
  });

  await t.test("the CLI: discover, status, verify, submit with the owner's payer key, reconcile, gas advice", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cv-cli-"));
    stops.push(() => fs.rmSync(dir, { recursive: true, force: true }));
    const pinsFile = path.join(dir, "pins.json"); fs.writeFileSync(pinsFile, JSON.stringify(PINS));
    const profFile = path.join(dir, "profile.json"); fs.writeFileSync(profFile, JSON.stringify(profile));
    const keyFile = path.join(dir, "payer.key"); fs.writeFileSync(keyFile, KEYS.payer, { mode: 0o600 });
    const common = ["--pins", pinsFile, "--rpc", A.rpcs.join(","), "--confirmations", "0", "--max-block-age", "3600", "--journal-dir", path.join(dir, "j"), "--json"];
    const cli = async (...a) => { let o = ""; await CLI.main([...a, ...common], { out: (s) => { o += s; } }); return JSON.parse(o); };
    const d = await cli("discover", "--x", K1.x, "--y", K1.y);
    assert.equal(d.vaults[1].vault, profile.vault);
    const st = await cli("status", "--profile", profFile);
    assert.equal(st.deployed, true); assert.equal(st.pending, null);
    const intent = { op: "fund", params: { id: deploymentId, amountUsd: "3" } };
    const req = await sign(await CV.prepareVaultOp(lib, profile, "fund", intent.params, opts), intent);
    const reqFile = path.join(dir, "request.json"); fs.writeFileSync(reqFile, JSON.stringify(req));
    const v = await cli("verify", reqFile);
    assert.equal(v.ok, true); assert.equal(v.op, "fund"); assert.equal(v.args.fund6, "3000000");
    // the same command through the main CLI's dispatcher (`enclave credit-vault ...`), as a separate process
    const viaMain = await new Promise((ok, bad) => {
      const p = spawn(process.execPath, [path.join(REPO, "cli/enclave.mjs"), "credit-vault", "verify", reqFile, "--pins", pinsFile, "--json"],
        { env: { ...process.env, ENCLAVE_ADDRESS_BOOK: "" }, stdio: ["ignore", "pipe", "pipe"] });
      let o = "", e = ""; p.stdout.on("data", (d) => { o += d; }); p.stderr.on("data", (d) => { e += d; });
      p.on("exit", (c) => c === 0 ? ok(JSON.parse(o)) : bad(new Error("enclave credit-vault verify exited " + c + ": " + e)));
    });
    assert.equal(viaMain.ok, true); assert.equal(viaMain.args.fund6, "3000000");
    const bal = await usdcOf(A, S, profile.vault);
    const sub = await cli("submit", reqFile, "--key-file", keyFile);
    assert.equal(sub.submit, "broadcast"); assert.equal(sub.outcome.status, "executed");
    assert.equal(await usdcOf(A, S, profile.vault), bal - 3_000000n);
    assert.equal((await cli("reconcile", "--profile", profFile)).status, "none");
    const g = await cli("gas", deploymentId, "--ledger", S.ledger);
    assert.equal(g.creditVault, true); assert.equal(g.reserveSupported, false);
    // the key file is never echoed
    assert.ok(!JSON.stringify(sub).includes(KEYS.payer.slice(2, 20)));
  });

  await t.test("no request ever left loopback (the Enclave API and billing were never contacted)", async () => {
    assert.ok(requests.length > 50);
    const offLoopback = requests.filter((u) => !/^http:\/\/(127\.0\.0\.1|localhost):/.test(u));
    assert.deepEqual(offLoopback, []);
    assert.ok(!requests.some((u) => /enclave\.host/.test(u)));
    await assert.rejects(fetch("https://api.enclave.host/v1/billing/vault"), /refused/);
  });
});
