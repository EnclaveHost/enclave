// App lease gas for a deployment an EXISTING credit vault owns, through the PROPOSED parallel reserve
// (site/js/core/credit-vault-reserve.js; contract source work/credit-vault-final-integration/proposal, bytecode in
// test/fixtures/credit-vault-reserve-proposal.json - PROPOSAL ONLY, never deployed by anyone from here), and the submission
// relay as an Enclave host-service ROLE (network/credit-vault-submitter.mjs + network/host-services/credit-vault-submitter.mjs)
// whose gas is signed by the operator's loopback external signer (here anvil's own eth_signTransaction for its account).
// Chain: anvil (RIP-7212) with the PRODUCTION credit-vault factory bytecode, the live rev-16d ledger and the real address book
// (test/credit-vault-fixture.mjs); the OLDER credit-vault build at its real addresses from its Base runtime
// (test/fixtures/credit-vault-older-848a.json). Runs in an unshared network namespace (test/run-credit-vault.sh).
//   node --test test/credit-vault-reserve.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { encodeFunctionData, keccak256, parseAbi, getAddress, encodeAbiParameters } from "viem";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CV = await import(path.join(REPO, "site/js/core/credit-vault-independent.js"));
const GR = await import(path.join(REPO, "site/js/core/credit-vault-reserve.js"));
const { createQuorumReader, jsonRpc } = await import(path.join(REPO, "site/js/core/quorum.js"));
const CLI = await import(path.join(REPO, "cli/credit-vault.mjs"));
const ROLE = await import(path.join(REPO, "network/host-services/credit-vault-submitter.mjs"));
const F = await import(path.join(REPO, "test/credit-vault-fixture.mjs"));
const lib = CLI.lib;
const PROP = JSON.parse(fs.readFileSync(path.join(REPO, "test/fixtures/credit-vault-reserve-proposal.json"), "utf8"));
const OLDER = JSON.parse(fs.readFileSync(path.join(REPO, "test/fixtures/credit-vault-older-848a.json"), "utf8"));
const haveAnvil = (() => { try { execFileSync("anvil", ["--version"], { stdio: "ignore" }); return true; } catch { return false; } })();
const lc = (a) => String(a).toLowerCase();
const LIVE_LIMITS = { maxGasPriceCeiling: 1_000_000_000n, overheadClaimGas: 65000, overheadRenewGas: 55000, overheadReleaseGas: 36000, minClaimInterval: 60, l1Bps: 0 };
const POLICY = { enabled: true, claimPolicy: "any", sponsorRelease: true, maxClaimsPerEpoch: 4, maxPerOpWei: "1000000000000000", epochCapWei: "5000000000000000",
  epochSec: 3600, renewWindow: 300, minExtension: 600, claimCooldown: 1800, maxGasPrice: "50000000" };

if (process.env.INJECT_FAILURE) test("INJECTED FAILURE (negative control: the suite must exit nonzero)", () => assert.fail("injected"));

test("vault-owned app lease gas through the proposed parallel reserve; the submitter as a host-service role",
  { skip: process.env.INJECT_FAILURE ? "negative-control run" : !haveAnvil ? "needs Foundry's anvil" : false, timeout: 600000 }, async (t) => {
  const stops = [];
  t.after(() => { for (const s of stops.reverse()) try { s(); } catch {} });
  const A = await F.startChain(8453, stops);
  const S = await F.deployStack(A);
  const PINS = CV.validatePins({ chainId: 8453, origin: F.ORIGIN, rpId: F.RPID, usdc: S.usdc,
    factories: [{ address: OLDER.factory.address, implementation: OLDER.implementation.address, label: "older", originBound: false }, S.older, S.current] });
  const reader = CV.withTxReads(createQuorumReader({ rpcs: A.rpcs, quorum: 2, confirmations: 0, maxBlockAgeSeconds: 3600, chainId: 8453 }), jsonRpc());
  const opts = { reader, pins: PINS };
  // the proposal: parallel reserve + its own executor, live constructor values, the older build's clone runtime refused
  const oldCloneHash = keccak256(CV.cloneRuntime(lib, OLDER.implementation.address));
  const r2 = await F.deploy(A, "admin", PROP.reserve.abi, PROP.reserve.bytecode, [S.ledger, S.registry, "0x0000000000000000000000000000000000000000", LIVE_LIMITS, [oldCloneHash]]);
  const e2 = await F.deploy(A, "admin", PROP.executor.abi, PROP.executor.bytecode, [r2]);
  await F.send(A, "admin", r2, PROP.reserve.abi, "bindExecutor", [e2]);
  const record = { format: GR.RESERVE_RECORD_FORMAT, chainId: 8453, reserve: r2, executor: e2, reserveCodeHash: keccak256(await A.pub.getCode({ address: r2 })),
    executorCodeHash: keccak256(await A.pub.getCode({ address: e2 })), ledger: S.ledger, registry: S.registry };
  // the customer's vault (current factory) owning a funded deployment
  const K = F.passkey();
  await F.send(A, "admin", S.current.address, CV.ABI.factory, "createVault", [BigInt(K.x), BigInt(K.y)]);
  const vault = CV.deriveVault(lib, K.x, K.y, S.current);
  await F.send(A, "admin", S.usdc, F.CHAIN_FX.MockUSDC.abi, "mint", [vault, 50_000000n]);
  const profile = CV.makeProfile({ factory: S.current.address, vault, key: { x: K.x, y: K.y } }, { credentialId: K.credentialId }, PINS);
  const dj = F.memJournal();
  const spec = { appRef: "catalog://app/0", gpuMilli: 0, cpuMilli: 500, appPort: 8080, ports: "", isPublic: true, configCid: "", maxRate6: "1000" };
  const dp = await CV.prepareVaultOp(lib, profile, "deploy", { spec, fundUsd: "10" }, opts);
  const dreq = await CV.signPrepared(lib, dp, profile, { pins: PINS, origin: F.ORIGIN, getFn: K.getFn(), intent: { op: "deploy", params: { spec, fundUsd: "10" } } });
  const ds = await CV.submitRequest(lib, dreq, CV.walletTransport(F.eip1193(A), F.ACCT.payer.address), { journal: dj, reader, pins: PINS });
  // Wallet submission acknowledges broadcast, not inclusion of this setup deployment.
  const rc = await A.pub.waitForTransactionReceipt({ hash: ds.txHash, pollingInterval: 50, timeout: 30000 });
  assert.equal(rc.status, "success");
  const id = rc.logs.find((l) => lc(l.address) === lc(S.ledger) && l.topics[0] === "0x3b201eb11e77934b296f908775fc0a82679683fd83a1232579f1014bcf7d3239").topics[1];
  const rj = F.memJournal();
  const wallet = () => CV.walletTransport(F.eip1193(A), F.ACCT.payer.address);
  const ro = (fn, args) => A.pub.readContract({ address: r2, abi: PROP.reserve.abi, functionName: fn, args });
  const doAction = async (action, params, { prof = profile, key = K } = {}) => {
    const prep = await GR.prepareReserveAction(lib, prof, record, action, { id, ...params }, { ...opts, journal: rj });
    const req = await GR.signReserveAction(lib, prep, prof, { pins: PINS, origin: F.ORIGIN, getFn: key.getFn(), intent: { action, params: { id, ...params } } });
    const s = await GR.submitReserveRequest(lib, req, wallet(), { journal: rj, reader, pins: PINS, record });
    assert.equal(s.status, "broadcast");
    const out = await GR.reconcileReserve(lib, await rj.get(prof.vault), { reader, journal: rj });
    assert.equal(out.status, "executed", action);
    return { prep, req, out };
  };

  await t.test("without a reviewed record nothing is offered; with one, the reserve is verified against the platform book", async () => {
    assert.match(CV.reserveRefusal(true), /unavailable/);
    assert.throws(() => GR.validateReserveRecord(null, PINS), /not a lease-gas reserve deployment record/);
    const st = await GR.reserveState(lib, profile, record, id, opts);
    assert.equal(st.ownedByVault, true); assert.equal(st.originBound, true); assert.equal(st.signerRefused, false); assert.equal(st.reserve.enabled, false);
    await assert.rejects(GR.reserveState(lib, profile, { ...record, reserveCodeHash: "0x" + "11".repeat(32) }, id, opts), /not the reviewed code/);
    // the platform book names another ledger: the reserve (bound to the old one) is refused for this vault
    const ledger2 = await F.deployLedger(A, [S.usdc, F.PAYOUT, S.registry, S.feed]);
    await F.send(A, "admin", S.book, F.CHAIN_FX.EnclaveAddressBook.abi, "set", [F.bookKey("deployments"), ledger2]);
    await assert.rejects(GR.reserveState(lib, profile, record, id, opts), /the platform book names/);
    await F.send(A, "admin", S.book, F.CHAIN_FX.EnclaveAddressBook.abi, "set", [F.bookKey("deployments"), S.ledger]);
  });

  await t.test("deposit (payer ETH), passkey-signed configure and claimant, then a withdrawal to an explicit recipient only", async () => {
    const d = await GR.prepareReserveDeposit(lib, profile, record, { id, amountWei: "10000000000000000" }, opts);
    const h = await A.raw("eth_sendTransaction", [{ from: F.ACCT.payer.address, to: d.to, data: d.data, value: "0x" + d.value.toString(16) }]);
    assert.equal((await A.pub.waitForTransactionReceipt({ hash: h })).status, "success");
    assert.equal((await ro("reserveOf", [id, vault])).balanceWei, 10n ** 16n);
    const vn = await F.nonceOf(A, vault), vu = await F.usdcOf(A, S, vault);
    await doAction("configure", { policy: POLICY });
    const r = await ro("reserveOf", [id, vault]);
    assert.equal(r.enabled, true); assert.equal(r.maxPerOpWei, 10n ** 15n); assert.equal(r.epochSec, 3600);
    assert.equal(await F.nonceOf(A, vault), vn, "ERC-1271 is a view: the vault's own nonce did not move");
    assert.equal(await F.usdcOf(A, S, vault), vu, "closed-loop credit untouched");
    const op = F.ACCT.other.address;
    await doAction("claimant", { operator: op, allowed: true });
    assert.equal(await ro("claimantAllowed", [await ro("budgetKey", [id, vault]), op]), true);
    // withdrawals: no default recipient; never zero, the reserve or the vault; then exactly what was signed
    for (const [p, why] of [[{ amountWei: "1" }, /recipient you choose/], [{ amountWei: "1", to: "0x0000000000000000000000000000000000000000" }, /recipient you choose/],
      [{ amountWei: "1", to: vault }, /cannot be the reserve or the vault/], [{ amountWei: "1", to: r2 }, /cannot be the reserve or the vault/],
      [{ amountWei: "20000000000000000", to: op }, /holds 10000000000000000 wei/]])
      await assert.rejects(GR.prepareReserveAction(lib, profile, record, "withdraw", { id, ...p }, opts), why);
    const dest = "0x000000000000000000000000000000000000d00d";
    await doAction("withdraw", { amountWei: "4000000000000000", to: dest });
    assert.equal(await A.pub.getBalance({ address: dest }), 4n * 10n ** 15n);
    assert.equal((await ro("reserveOf", [id, vault])).balanceWei, 6n * 10n ** 15n);
  });

  await t.test("tampering is refused before the passkey; altered bytes are refused by the re-derivation and on chain", async () => {
    const c0 = K.calls;
    const prep = await GR.prepareReserveAction(lib, profile, record, "configure", { id, policy: POLICY }, opts);
    const raised = { ...POLICY, maxPerOpWei: "5000000000000000" };
    await assert.rejects(GR.signReserveAction(lib, prep, profile, { pins: PINS, origin: F.ORIGIN, getFn: K.getFn(), intent: { action: "configure", params: { id, policy: raised } } }), /different policy/);
    await assert.rejects(GR.signReserveAction(lib, { ...prep, args: { policy: raised } }, profile, { pins: PINS, origin: F.ORIGIN, getFn: K.getFn(), intent: { action: "configure", params: { id, policy: raised } } }), /digest that is not/);
    await assert.rejects(GR.signReserveAction(lib, prep, profile, { pins: PINS, origin: "https://x.app.enclave.host", getFn: K.getFn(), intent: { action: "configure", params: { id, policy: POLICY } } }), /signing works only at/);
    assert.equal(K.calls, c0, "the passkey was never asked");
    const wp = await GR.prepareReserveAction(lib, profile, record, "withdraw", { id, amountWei: "1000", to: "0x000000000000000000000000000000000000d00d" }, opts);
    const req = await GR.signReserveAction(lib, wp, profile, { pins: PINS, origin: F.ORIGIN, getFn: K.getFn(), intent: { action: "withdraw", params: { id, amountWei: "1000", to: "0x000000000000000000000000000000000000d00d" } } });
    const thief = { ...req, data: req.data.replace("000000000000000000000000000000000000d00d", "0000000000000000000000000000000000000bad") };
    assert.throws(() => GR.verifyReserveRequest(lib, thief, { pins: PINS, record }), /digest is not the digest/);
    await assert.rejects(A.raw("eth_call", [{ from: F.ACCT.payer.address, to: r2, data: thief.data }, "latest"]), /bad signature/);
    // a foreign-origin assertion assembled by hand: refused here, and by the vault through the reserve
    const evil = await F.rawAssertion(K, wp.digest, "https://x.app.enclave.host");
    assert.throws(() => GR.assembleReserveRequest(lib, wp, profile, evil), /exact operation at https:\/\/enclave.host/);
  });

  await t.test("the OLDER vault build: no on-chain origin check (explicit), refused by the client and by the reserve", async () => {
    await A.raw("anvil_setCode", [OLDER.factory.address, OLDER.factory.runtime]);
    await A.raw("anvil_setCode", [OLDER.implementation.address, OLDER.implementation.runtime]);
    const KO = F.passkey();
    // the older factory's own createVault (anyone may call it): its CREATE2 clone of the older implementation, initialized by it
    await F.send(A, "admin", OLDER.factory.address, CV.ABI.factory, "createVault", [BigInt(KO.x), BigInt(KO.y)]);
    const oldVault = CV.deriveVault(lib, KO.x, KO.y, { address: OLDER.factory.address, implementation: OLDER.implementation.address });
    assert.equal(lc(await A.pub.getCode({ address: oldVault })), CV.cloneRuntime(lib, OLDER.implementation.address));
    // a record it owns (none exists live; created by a wallet and transferred, as an import would leave one)
    const cr = await A.raw("eth_sendTransaction", [{ from: F.ACCT.other.address, to: S.ledger, gas: "0x500000", data: encodeFunctionData({ abi: F.CHAIN_FX.EnclaveDeployments.abi,
      functionName: "create", args: ["catalog://app/old", 0, 500, 8080, "", true, "", "0x0000000000000000000000000000000000000000", 0n, 1000n] }) }]);
    const crr = await A.pub.waitForTransactionReceipt({ hash: cr }); assert.equal(crr.status, "success");
    const oid = crr.logs.find((l) => lc(l.address) === lc(S.ledger)).topics[1];
    const tr = await A.raw("eth_sendTransaction", [{ from: F.ACCT.other.address, to: S.ledger, gas: "0x200000", data: encodeFunctionData({ abi: F.CHAIN_FX.EnclaveDeployments.abi,
      functionName: "transferDeployment", args: [oid, oldVault] }) }]);
    assert.equal((await A.pub.waitForTransactionReceipt({ hash: tr })).status, "success");
    const dg = keccak256("0x01");
    const evil = await F.rawAssertion(KO, dg, "https://x.app.enclave.host");
    const sigOf = (a) => encodeAbiParameters([{ type: "tuple", components: ["bytes authenticatorData", "string clientDataJSON", "uint256 r", "uint256 s", "uint256 x", "uint256 y"].map((x) => { const [type, name] = x.split(" "); return { type, name }; }) }],
      [{ authenticatorData: a.authenticatorData, clientDataJSON: a.clientDataJSON, r: a.r, s: a.s, x: BigInt(KO.x), y: BigInt(KO.y) }]);
    assert.equal(await A.pub.readContract({ address: oldVault, abi: CV.ABI.vault, functionName: "isValidSignature", args: [dg, sigOf(evil)] }), "0x1626ba7e",
      "the OLDER build accepts an assertion made on another site under enclave.host");
    // the older build's immutable book() is the BASE address book 0xab2143…: place a book there naming this chain's ledger
    // (owner slot 0 = the admin, then the admin's own set), exactly the production binding
    const BASE_BOOK = "0xab214342d5a490150a4a977063a2f88e21f80907";
    assert.equal(lc(await A.pub.readContract({ address: oldVault, abi: CV.ABI.vault, functionName: "book" })), BASE_BOOK);
    await A.raw("anvil_setCode", [BASE_BOOK, await A.pub.getCode({ address: S.book })]);
    await A.raw("anvil_setStorageAt", [BASE_BOOK, "0x" + "0".repeat(64), "0x" + F.ACCT.admin.address.slice(2).toLowerCase().padStart(64, "0")]);
    await F.send(A, "admin", BASE_BOOK, F.CHAIN_FX.EnclaveAddressBook.abi, "set", [F.bookKey("deployments"), S.ledger]);
    const pOld = CV.makeProfile({ factory: OLDER.factory.address, vault: oldVault, key: { x: KO.x, y: KO.y } }, { credentialId: KO.credentialId }, PINS);
    const st = await GR.reserveState(lib, pOld, record, oid, opts);
    assert.equal(st.originBound, false); assert.equal(st.signerRefused, true);
    await assert.rejects(GR.prepareReserveAction(lib, pOld, record, "configure", { id: oid, policy: POLICY }, opts), /OLDER credit-vault build/);
    await assert.rejects(GR.prepareReserveDeposit(lib, pOld, record, { id: oid, amountWei: "1000" }, opts), /refused by the reserve/);
    // the reserve itself refuses a VALID older-vault signature, whatever the origin
    const nonce = await ro("sigNonce", [await ro("budgetKey", [oid, oldVault])]);
    const blk = await A.pub.getBlock();
    const dl = blk.timestamp + 300n;
    const digest = await ro("configureDigest", [oid, oldVault, GR.policyArg(POLICY), nonce, dl]);
    const good = await F.rawAssertion(KO, digest, F.ORIGIN);
    const data = encodeFunctionData({ abi: PROP.reserve.abi, functionName: "configureBySig", args: [oid, GR.policyArg(POLICY), dl, sigOf(good)] });
    await assert.rejects(A.raw("eth_call", [{ from: F.ACCT.payer.address, to: r2, data }, "latest"]), /signer code refused/);
  });

  await t.test("the CLI: gas status with the reviewed record, verify and submit a reserve request with the owner's payer key", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cv-rcli-")); stops.push(() => fs.rmSync(dir, { recursive: true, force: true }));
    const pinsFile = path.join(dir, "pins.json"); fs.writeFileSync(pinsFile, JSON.stringify(PINS));
    const recFile = path.join(dir, "reserve.json"); fs.writeFileSync(recFile, JSON.stringify(record));
    const recDigest = "sha256:" + crypto.createHash("sha256").update(fs.readFileSync(recFile)).digest("hex");
    const profFile = path.join(dir, "profile.json"); fs.writeFileSync(profFile, JSON.stringify(profile));
    const keyFile = path.join(dir, "payer.key"); fs.writeFileSync(keyFile, F.KEYS.payer, { mode: 0o600 });
    const common = ["--pins", pinsFile, "--rpc", A.rpcs.join(","), "--confirmations", "0", "--max-block-age", "3600", "--journal-dir", path.join(dir, "j"), "--json"];
    const cli = async (...a) => { let o = ""; await CLI.main([...a, ...common], { out: (x) => { o += x; } }); return JSON.parse(o); };
    const g = await cli("gas", id, "--ledger", S.ledger, "--profile", profFile, "--reserve-record", recFile, "--reserve-record-digest", recDigest);
    assert.equal(g.creditVault, true); assert.equal(g.liveReserveSupported, false); assert.equal(lc(g.parallelReserve), lc(r2)); assert.equal(g.enabled, true);
    await assert.rejects(cli("gas", id, "--ledger", S.ledger, "--profile", profFile, "--reserve-record", recFile, "--reserve-record-digest", "sha256:" + "0".repeat(64)), /not the reviewed/);
    const params = { id, operator: F.ACCT.relay.address, allowed: true };
    const prep = await GR.prepareReserveAction(lib, profile, record, "claimant", params, opts);
    const req = await GR.signReserveAction(lib, prep, profile, { pins: PINS, origin: F.ORIGIN, getFn: K.getFn(), intent: { action: "claimant", params } });
    const reqFile = path.join(dir, "req.json"); fs.writeFileSync(reqFile, JSON.stringify(req));
    const v = await cli("verify", reqFile, "--reserve-record", recFile, "--reserve-record-digest", recDigest);
    assert.equal(v.ok, true); assert.equal(v.action, "claimant");
    const sub = await cli("submit", reqFile, "--key-file", keyFile, "--reserve-record", recFile, "--reserve-record-digest", recDigest);
    assert.equal(sub.submit, "broadcast"); assert.equal(sub.outcome.status, "executed");
    assert.equal(await ro("claimantAllowed", [await ro("budgetKey", [id, vault]), F.ACCT.relay.address]), true);
    assert.equal((await cli("reconcile", "--profile", profFile)).status, "none");
  });

  await t.test("the submitter host-service role: refuses secrets, remote signers and DigitalOcean; submits a reserve request with the operator's signer", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cv-role-")); stops.push(() => fs.rmSync(dir, { recursive: true, force: true }));
    const recSha = "sha256:" + crypto.createHash("sha256").update(JSON.stringify(record)).digest("hex");
    const cfg = { port: await F.freePort(), bind: "127.0.0.1", stateDir: path.join(dir, "state"), rpc: A.rpcs, confirmations: 0, signer: A.url, from: F.ACCT.relay.address,
      chainId: 8453, pins: PINS, reserveRecord: record, reserveRecordSha256: recSha };
    assert.deepEqual(ROLE.validateSubmitterConfig(cfg).from, F.ACCT.relay.address);
    for (const [bad, why] of [[{ ...cfg, privateKey: "0x01" }, /holds no secret/], [{ ...cfg, signer: "https://wallet.example.com" }, /loopback JSON-RPC wallet/],
      [{ ...cfg, signer: "http://user:pw@127.0.0.1:1" }, /loopback JSON-RPC wallet/], [{ ...cfg, rpc: [A.rpcs[0]] }, /2 to 8/], [{ ...cfg, reserveRecordSha256: undefined }, /come together/]])
      assert.throws(() => ROLE.validateSubmitterConfig(bad), why);
    // placement: a DigitalOcean machine is refused before anything binds
    const dmi = path.join(dir, "dmi"); fs.mkdirSync(dmi); fs.writeFileSync(path.join(dmi, "sys_vendor"), "DigitalOcean\n");
    const cfgFile = path.join(dir, "cfg.json"); fs.writeFileSync(cfgFile, JSON.stringify(cfg, (_k, v) => typeof v === "bigint" ? v.toString() : v));
    const run = (env) => spawn(process.execPath, [path.join(REPO, "network/credit-vault-submitter.mjs"), cfgFile], { env: { PATH: process.env.PATH, ...env }, stdio: ["ignore", "pipe", "pipe"] });
    const doProc = run({ CVS_TEST_DMI: dmi });
    let derr = ""; doProc.stderr.on("data", (d) => { derr += d; });
    assert.equal(await new Promise((ok) => doProc.on("exit", ok)), 1); assert.match(derr, /DigitalOcean machines are transport-only/);
    fs.writeFileSync(path.join(dmi, "sys_vendor"), "ASUSTeK COMPUTER INC.\n");
    // a recorded digest that is not the record's: refused
    const badFile = path.join(dir, "bad.json"); fs.writeFileSync(badFile, JSON.stringify({ ...cfg, reserveRecordSha256: "sha256:" + "0".repeat(64) }));
    const bp = spawn(process.execPath, [path.join(REPO, "network/credit-vault-submitter.mjs"), badFile], { env: { PATH: process.env.PATH, CVS_TEST_DMI: dmi }, stdio: ["ignore", "pipe", "pipe"] });
    let berr = ""; bp.stderr.on("data", (d) => { berr += d; });
    assert.equal(await new Promise((ok) => bp.on("exit", ok)), 1); assert.match(berr, /not the reviewed/);
    const proc = run({ CVS_TEST_DMI: dmi }); stops.push(() => proc.kill("SIGKILL"));
    const line = await new Promise((ok, bad) => { let e = ""; proc.stderr.on("data", (d) => { e += d; }); proc.stdout.once("data", (d) => ok(String(d))); proc.once("exit", (c) => bad(new Error("submitter exited " + c + ": " + e))); });
    const url = JSON.parse(line).submitter;
    const health = await (await fetch(url + "/health")).json();
    assert.equal(health.ok, true); assert.equal(lc(health.payer), lc(F.ACCT.relay.address)); assert.equal(lc(health.reserve), lc(r2));
    const eth0 = await A.pub.getBalance({ address: F.ACCT.relay.address });
    const prep = await GR.prepareReserveAction(lib, profile, record, "claimant", { id, operator: F.ACCT.admin.address, allowed: true }, opts);
    const req = await GR.signReserveAction(lib, prep, profile, { pins: PINS, origin: F.ORIGIN, getFn: K.getFn(), intent: { action: "claimant", params: { id, operator: F.ACCT.admin.address, allowed: true } } });
    const s = await GR.submitReserveRequest(lib, req, CV.relayTransport(url), { journal: rj, pins: PINS, record });
    assert.equal(s.status, "broadcast");
    assert.equal((await GR.reconcileReserve(lib, await rj.get(vault), { reader, journal: rj })).status, "executed");
    assert.equal(await ro("claimantAllowed", [await ro("budgetKey", [id, vault]), F.ACCT.admin.address]), true);
    assert.ok((await A.pub.getBalance({ address: F.ACCT.relay.address })) < eth0, "the operator's signer paid the gas");
    // the same relay still submits ordinary vault requests (one role for both)
    const fp = await CV.prepareVaultOp(lib, profile, "fund", { id, amountUsd: "1" }, opts);
    const freq = await CV.signPrepared(lib, fp, profile, { pins: PINS, origin: F.ORIGIN, getFn: K.getFn(), intent: { op: "fund", params: { id, amountUsd: "1" } } });
    const vj = F.memJournal();
    assert.equal((await CV.submitRequest(lib, freq, CV.relayTransport(url), { journal: vj, pins: PINS })).status, "broadcast");
    assert.equal((await CV.reconcile(lib, await vj.get(vault), { reader, journal: vj })).status, "executed");
    // the role is registered with the shared host-service runner under service-index kind 8 (outside default listings);
    // the runner's own launch, admission and advertisement are tested in test/credit-vault-submitter-runner.test.mjs
    const si = await import(path.join(REPO, "network/service-index.mjs"));
    assert.equal(si.SERVICE_KINDS["credit-vault-submitter"], 8); assert.equal(si.SERVICE_KINDS.policy, 6); assert.equal(si.SERVICE_KINDS.relay, 7);
  });
});
