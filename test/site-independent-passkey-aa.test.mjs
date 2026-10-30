// The independent passkey account (site/js/core/passkey-account.js) against the PINNED, already-deployed Safe v1.4.1, Safe
// passkey signer v0.2.1, Safe4337Module v0.3.0, EntryPoint v0.7 and USDC v2.2 code: anvil forks Base at block 52,836,800
// (read-only upstream; --optimism for the RIP-7212 precompile Base has) and only the repository's own ledger and pinned
// session factory are deployed locally. A software WebAuthn authenticator (test/helpers/software-authenticator.mjs) answers
// the same ox createCredential / sign calls the browser makes. Nothing touches a real chain, key or fund.
// Run under the allocation:
//   node test/helpers/memory-guard.mjs --max-rss-mib 768 --floor-available-mib 16384 -- node --test test/site-independent-passkey-aa.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import net from "node:net";
import { spawn, execFileSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import * as viem from "viem";
import { WebAuthnP256 } from "ox";
import { privateKeyToAccount, generatePrivateKey } from "viem/accounts";
import * as S from "../sdk/sessions/dist/node.mjs";
import { softwareAuthenticator } from "./helpers/software-authenticator.mjs";
import { linkBytecode } from "../site/js/lib/contract-linker.js";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUT = path.join(REPO, "contracts/foundry/out");
const UPSTREAM = process.env.BASE_FORK_RPC || "https://mainnet.base.org";
const FORK_BLOCK = 52836800;
const haveAnvil = (() => { try { execFileSync("anvil", ["--version"], { stdio: "ignore" }); return true; } catch { return false; } })();
const skip = !haveAnvil && "needs anvil";
// fresh keys: anvil's well-known dev-key addresses carry code on Base mainnet (EIP-7702 delegations), so the fork would show them so
const KEY = { submitter: generatePrivateKey(), recovery: generatePrivateKey() };
const USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const chain = { id: 8453, name: "base-fork", nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 }, rpcUrls: { default: { http: [] } } };

let anvil = null, rpcUrl, pc, wc, PA, AP, OS, auth, contracts = {}, reader, safe, profile, A, B, recovery, setupError = null;
const cleanups = [];
const cleanup = async () => { while (cleanups.length) { try { await cleanups.pop()(); } catch {} } };
const freePort = () => new Promise((ok) => { const s = net.createServer(); s.listen(0, "127.0.0.1", () => { const p = s.address().port; s.close(() => ok(p)); }); });
const art = (file, name) => { const j = JSON.parse(fs.readFileSync(path.join(OUT, file, name + ".json"), "utf8")); return { abi: j.abi, bytecode: j.bytecode.object, linkReferences: j.bytecode.linkReferences || {} }; };
const rpc = async (method, params) => { const r = await fetch(rpcUrl, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) }); const j = await r.json(); if (j.error) throw new Error(j.error.message); return j.result; };
const send = async (tx) => { const h = await wc.sendTransaction({ ...tx, gas: 8_000_000n }); const rc = await pc.waitForTransactionReceipt({ hash: h }); if (rc.status !== "success") throw new Error("reverted: " + (tx.label || tx.to)); return rc; };
const usdcBal = (a) => pc.readContract({ address: USDC, abi: viem.erc20Abi, functionName: "balanceOf", args: [a] });
const ready = () => { if (setupError) throw new Error("setup failed: " + setupError.message); };

test.before(async () => {
  if (skip) return;
  const watchdog = setTimeout(() => { console.error("passkey-aa: watchdog"); cleanup().finally(() => process.exit(1)); }, 9 * 60 * 1000); watchdog.unref();
  try {
    const port = await freePort();
    rpcUrl = `http://127.0.0.1:${port}`;
    anvil = spawn("anvil", ["--port", String(port), "--fork-url", UPSTREAM, "--fork-block-number", String(FORK_BLOCK), "--optimism", "--silent", "--base-fee", "0"], { stdio: "ignore" });
    cleanups.push(() => anvil.kill("SIGKILL"));
    for (let i = 0; i < 120; i++){ try { await rpc("eth_chainId", []); break; } catch { await new Promise((r) => setTimeout(r, 250)); } }
    globalThis.localStorage = { m: new Map(), getItem(k){ return this.m.has(k) ? this.m.get(k) : null; }, setItem(k, v){ this.m.set(k, String(v)); }, removeItem(k){ this.m.delete(k); } };
    globalThis.sessionStorage = globalThis.localStorage; globalThis.location = { hostname: "localhost" };
    PA = await import(pathToFileURL(path.join(REPO, "site/js/core/passkey-account.js")).href);
    AP = await import(pathToFileURL(path.join(REPO, "site/js/core/account-providers.js")).href);
    OS = await import(pathToFileURL(path.join(REPO, "site/js/core/owner-signature.js")).href);
    const { createQuorumReader } = await import(pathToFileURL(path.join(REPO, "site/js/core/quorum.js")).href);
    PA._useLibForTests({ ...viem, WebAuthnP256 });
    reader = createQuorumReader({ rpcs: [rpcUrl, rpcUrl.replace("127.0.0.1", "localhost")], quorum: 2, confirmations: 0, maxBlockAgeSeconds: 10 ** 9, chainId: 8453 });
    pc = viem.createPublicClient({ chain, transport: viem.http(rpcUrl) });
    wc = viem.createWalletClient({ chain, account: privateKeyToAccount(KEY.submitter), transport: viem.http(rpcUrl) });
    recovery = privateKeyToAccount(KEY.recovery);
    await rpc("anvil_setBalance", [wc.account.address, "0x56bc75e2d63100000"]);       // 100 ETH, local fork state only
    // the repository's own ledger and pinned session factory on top of the fork, with the REAL USDC
    const deploy = async (a, args = [], libs = {}) => {
      const bytecode = Object.keys(a.linkReferences).length ? linkBytecode(a.bytecode, a.linkReferences, libs) : a.bytecode;
      const rc = await send({ data: viem.encodeDeployData({ abi: a.abi, bytecode, args }), label: "deploy" });
      return viem.getAddress(rc.contractAddress);
    };
    const treasury = "0x00000000000000000000000000000000000e2e01";
    const registry = await deploy(art("EnclaveRegistry.sol", "EnclaveRegistry"));
    const bw = await deploy(art("EnclaveDeployments.sol", "EnclaveLedgerBandwidth"));
    const ledger = await deploy(art("EnclaveDeployments.sol", "EnclaveDeployments"), [USDC, treasury, registry, "0x0000000000000000000000000000000000000000"],
      { "contracts/EnclaveDeployments.sol:EnclaveLedgerBandwidth": bw });
    const catalog = await deploy(art("EnclaveAppCatalog.sol", "EnclaveAppCatalog"));
    const router = await deploy(art("PaymentRouter.sol", "PaymentRouter"), [USDC, treasury]);
    const svlib = await deploy(art("SessionVault.sol", "SessionVaultLib"));
    const factory = await deploy(art("PinnedSessionVaultFactory.sol", "PinnedSessionVaultFactory"), [USDC, ledger, catalog, router, "0x0000000000000000000000000000000000000000", 1_000_000_000n],
      { "contracts/SessionVault.sol:SessionVaultLib": svlib });
    contracts = { ledger, factory };
    auth = softwareAuthenticator();
  } catch (e){ setupError = e; await cleanup(); throw e; }
});
test.after(cleanup);

/* USDC v2.2 keeps balances in the low 255 bits of a mapping slot; find that slot on the fork (local state only) */
async function fundUsdc(account, amount){
  for (let slot = 0; slot < 24; slot++){
    const key = viem.keccak256(viem.encodeAbiParameters([{ type: "address" }, { type: "uint256" }], [account, BigInt(slot)]));
    const before = await rpc("eth_getStorageAt", [USDC, key, "latest"]);
    await rpc("anvil_setStorageAt", [USDC, key, viem.pad(viem.toHex(amount), { size: 32 })]);
    if ((await usdcBal(account)) === amount) return slot;
    await rpc("anvil_setStorageAt", [USDC, key, before]);
  }
  throw new Error("USDC balance slot not found");
}

test("the fork serves the pinned deployed code (every provider pin matches) and has the RIP-7212 precompile", { skip, timeout: 180000 }, async () => {
  ready();
  const v = await AP.verifyProviderDeployment("safe-passkey", { reader });
  assert.equal(v.ok, true, JSON.stringify(v.rows.filter((r) => !r.ok)));
  // RIP-7212 P256VERIFY: a signature made here verifies (1); with another key it does not (empty)
  const { generateKeyPairSync, sign: nsign, createHash } = await import("node:crypto");
  const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
  const jwk = publicKey.export({ format: "jwk" }), msg = Buffer.from("rip-7212 probe");
  const sig = nsign("sha256", msg, { key: privateKey, dsaEncoding: "ieee-p1363" });
  const h = (b) => Buffer.from(b).toString("hex"), xy = h(Buffer.from(jwk.x, "base64url")) + h(Buffer.from(jwk.y, "base64url"));
  const call = (data) => rpc("eth_call", [{ to: "0x0000000000000000000000000000000000000100", data }, "latest"]);
  assert.equal(await call("0x" + h(createHash("sha256").update(msg).digest()) + h(sig) + xy), "0x" + "0".repeat(63) + "1");
  assert.equal(await call("0x" + h(createHash("sha256").update(Buffer.from("other")).digest()) + h(sig) + xy), "0x");
});

test("create: two passkeys under two RPs and a recovery key; signers from the pinned factory; the Safe at its predicted address", { skip, timeout: 240000 }, async () => {
  ready();
  A = await PA.createPasskey({ rpId: "dash-a.example", rpName: "Dashboard A", userName: "owner (laptop)", createFn: auth.createFn });
  B = await PA.createPasskey({ rpId: "dash-b.example", rpName: "Dashboard B", userName: "owner (phone)", createFn: auth.createFn });
  assert.deepEqual(auth.mode.log.filter((l) => l.op === "create").map((l) => [l.rpId, l.uv]), [["dash-a.example", "required"], ["dash-b.example", "required"]]);
  await assert.rejects(PA.createPasskey({ rpId: "not a domain", userName: "x", createFn: auth.createFn }), /RP id/);
  const sA = await PA.passkeySigner({ x: A.x, y: A.y }, { reader }), sB = await PA.passkeySigner({ x: B.x, y: B.y, verifiers: PA.VERIFIERS_WITH_FALLBACK }, { reader });
  assert.equal(sA.deployed, false);
  await assert.rejects(PA.passkeySigner({ x: A.x, y: A.y, verifiers: 1n }, { reader }), /pinned/);
  for (const s of [sA, sB]) await send({ ...s.deploy, label: "createSigner" });
  const owners = [sA.signer, sB.signer, recovery.address.toLowerCase()];
  const pred = await PA.prepareSafeCreation({ owners, threshold: 1, saltNonce: "42" }, { reader });
  profile = { v: 1, provider: "safe-passkey", chainId: 8453, safe: pred.safe, saltNonce: "42", threshold: 1, transport: null, owners: [
    { kind: "passkey", signer: sA.signer, x: A.x, y: A.y, verifiers: String(PA.VERIFIERS_PRECOMPILE), credentialId: A.credentialId, rpId: A.rpId, label: "laptop" },
    { kind: "passkey", signer: sB.signer, x: B.x, y: B.y, verifiers: String(PA.VERIFIERS_WITH_FALLBACK), credentialId: B.credentialId, rpId: B.rpId, label: "phone" },
    { kind: "key", address: recovery.address.toLowerCase(), label: "recovery key" }] };
  assert.deepEqual((await PA.verifyAccountProfile(profile, { reader })).predicted, true);
  const caps = PA.accountCapabilities(profile).join("\n");
  assert.match(caps, /3 owner\(s\): 2 passkey\(s\) under 2 RP id\(s\) \(dash-a.example, dash-b.example\), 1 recovery key\(s\); 1 of 3/);
  assert.match(caps, /Any single owner controls the account alone/); assert.match(caps, /No Enclave account, relay, RP, bundler or paymaster/);
  await send({ ...pred.create, label: "createProxyWithNonce" });
  safe = pred.safe;
  assert.notEqual(await rpc("eth_getCode", [safe, "latest"]), "0x");
  const id = await AP.identifyAccount(safe, { reader });
  assert.equal(id.provider, "safe-passkey"); assert.equal(id.threshold, 1);
  assert.deepEqual(id.owners.map((o) => o.kind).sort(), ["eoa", "passkey", "passkey"]);
  assert.deepEqual(id.modules, [{ address: AP.PROVIDERS["safe-passkey"].contracts.safe4337Module.address, known: true }]);
  assert.ok(!id.warnings.some((w) => /Fallback handler|Module 0x/.test(w)), "the pinned module is the reviewed handler");
  // the deployed handler computes the same SafeMessage hash the passkeys will sign
  const d = viem.keccak256("0x1234");
  const onchain = await pc.readContract({ address: AP.PROVIDERS["safe-passkey"].contracts.fallbackHandler.address,
    abi: viem.parseAbi(["function getMessageHashForSafe(address safe, bytes message) view returns (bytes32)"]), functionName: "getMessageHashForSafe",
    args: [safe, viem.encodeAbiParameters([{ type: "bytes32" }], [d])] });
  assert.equal(await PA.safeMessageHash(safe, 8453, d), onchain);
  PA.saveAccountProfile(profile, globalThis.localStorage);
  assert.equal(PA.loadAccountProfile(8453, globalThis.localStorage).safe, safe);
});

test("sign in: a funded session opened by the Safe - SessionGrant and USDC authorization signed by ONE passkey as ERC-1271, checked by the contracts before submission", { skip, timeout: 240000 }, async () => {
  ready(); assert.ok(safe);
  await fundUsdc(safe, 5_000_000n);
  const store = new S.MemoryStore();
  const { signer, record } = await S.newSessionKey(store, { relay: "", chainId: 8453, label: "passkey sign-in", extractable: true });
  const grant = S.buildGrant({ sessionKey: signer.keyHash, label: "passkey sign-in", preset: "browser", policy: { budget: 2_000_000n, expiresIn: 3600 }, signWithin: 900 });
  const usdc = await S.usdcDomain(pc, USDC, 8453);
  const rec = OS.recordingSigner(PA.passkeySafeOwnerSigner({ profile, passkeys: [A.credentialId], getFn: auth.getFn }));
  const prep = await S.prepareSessionOpen({ publicClient: pc, factory: contracts.factory, owner: rec.signer, chainId: 8453, grant, usdc });
  assert.equal(rec.signatures.length, 2, "grant + USDC authorization, both as the Safe");
  assert.deepEqual(auth.mode.log.filter((l) => l.op === "get").map((l) => [l.rpId, l.uv]), [["dash-a.example", "required"], ["dash-a.example", "required"]], "each assertion on the key's own RP, UV required");
  const checked = await OS.verifyOwnerSubmission({ prep, owner: safe, signatures: rec.signatures }, { reader });
  assert.equal(checked.kind, "contract");
  // a signature the contracts would refuse is refused before submission: flip one byte of the passkey signature data
  // a genuine passkey signature, but over another message: the Safe (through the deployed passkey signer) refuses it
  const wrong = { address: safe, signTypedData: async () => PA.safeSignatures(await PA.passkeyParts([profile.owners[0]], viem.keccak256("0x99"), { getFn: auth.getFn })) };
  const bad = await S.prepareSessionOpen({ publicClient: pc, factory: contracts.factory, owner: wrong, chainId: 8453, grant, usdc });
  await assert.rejects(OS.verifyOwnerSubmission({ prep: bad, owner: safe, signatures: [] }, { reader }), (e) => e.code === "refused" && e.kind === "contract");
  const before = await usdcBal(safe);
  await send({ to: prep.to, data: prep.data, label: "openWithDepositFor" });
  const st = await S.readSession(pc, prep.vault, prep.sid);
  assert.equal(st.live, true); assert.equal(st.balance6, 2_000_000n);
  assert.equal(before - (await usdcBal(safe)), 2_000_000n, "the budget came from the Safe through its own ERC-1271 USDC authorization");
  const open = await S.completeSession(store, record, { vault: prep.vault, owner: safe, grant });
  assert.equal(open.handle.owner, safe);
});

test("refused before anything is sent: a wrong challenge, no user verification; and the passkey signer itself refuses a UV-less assertion", { skip, timeout: 120000 }, async () => {
  ready();
  const challenge = viem.keccak256("0xabcdef");
  auth.mode.tamperChallenge = true;
  await assert.rejects(PA.passkeyParts([profile.owners[0]], challenge, { getFn: auth.getFn }), /not an assertion over this exact challenge/);
  auth.mode.tamperChallenge = false; auth.mode.uv = false;
  await assert.rejects(PA.passkeyParts([profile.owners[0]], challenge, { getFn: auth.getFn }), /user presence and verification/);
  // bypass the page's check: the deployed signer (WebAuthn.verifySignature with USER_VERIFICATION) refuses it on its own
  const a = await WebAuthnP256.sign({ challenge, credentialId: A.credentialId, rpId: A.rpId, getFn: auth.getFn });
  auth.mode.uv = true;
  const head = '{"type":"webauthn.get","challenge":"' + Buffer.from(challenge.slice(2), "hex").toString("base64url") + '",';
  const data = viem.encodeAbiParameters([{ type: "bytes" }, { type: "string" }, { type: "uint256" }, { type: "uint256" }],
    [a.metadata.authenticatorData, a.metadata.clientDataJSON.slice(head.length, -1), a.signature.r, a.signature.s]);
  const ok = await pc.readContract({ address: profile.owners[0].signer, abi: viem.parseAbi(["function isValidSignature(bytes32,bytes) view returns (bytes4)"]),
    functionName: "isValidSignature", args: [challenge, data] }).catch(() => "0x00000000");
  assert.notEqual(ok, "0x1626ba7e", "no UV, no signature");
  // the pinned transport rules: no transport, no user operation
  await assert.rejects(PA.prepareUserOperation(profile, { to: USDC, gas: {} }, { reader }), (e) => e.code === "no-transport");
});

test("recovery: raise the threshold with one passkey, then remove the other passkey with a passkey AND the recovery key (Safe owner management)", { skip, timeout: 240000 }, async () => {
  ready();
  const t2 = await PA.prepareOwnerChange(profile, { op: "threshold", threshold: 2 }, { reader });
  const sigs1 = await PA.safeSignatures(await PA.passkeyParts([profile.owners[0]], t2.safeTxHash, { getFn: auth.getFn }));
  await send({ ...(await PA.execOwnerChange(t2, sigs1)), label: "changeThreshold" });
  profile = { ...profile, threshold: 2 };
  const rm = await PA.prepareOwnerChange(profile, { op: "remove", owner: profile.owners[1].signer, threshold: 2 }, { reader });
  // one approval is no longer enough: the Safe refuses it (simulated, nothing sent)
  const one = await PA.safeSignatures(await PA.passkeyParts([profile.owners[0]], rm.safeTxHash, { getFn: auth.getFn }));
  await assert.rejects(pc.call({ to: rm.to, data: (await PA.execOwnerChange(rm, one)).data, account: wc.account }));
  const parts = await PA.passkeyParts([profile.owners[0]], rm.safeTxHash, { getFn: auth.getFn });
  parts.push({ signer: recovery.address.toLowerCase(), ecdsa: await recovery.sign({ hash: rm.safeTxHash }) });
  await send({ ...(await PA.execOwnerChange(rm, await PA.safeSignatures(parts))), label: "removeOwner" });
  profile = { ...profile, owners: profile.owners.filter((o) => o.signer !== profile.owners[1].signer) };
  const id = await AP.identifyAccount(safe, { reader });
  assert.equal(id.threshold, 2); assert.deepEqual(id.owners.map((o) => o.kind).sort(), ["eoa", "passkey"]);
  assert.match(PA.accountCapabilities(profile).join("\n"), /No spare owner/);
  assert.match(PA.accountCapabilities(profile).join("\n"), /Every passkey is under dash-a.example/);
  await PA.verifyAccountProfile(profile, { reader });
});

/* the bundler stand-in: only this test. It takes eth_sendUserOperation in the v0.7 RPC form and submits handleOps itself. */
function localBundler(seen){
  return async (url, init) => {
    const { method, params: [op, entryPoint] } = JSON.parse(init.body);
    seen.push({ url, method, entryPoint });
    const L = (v) => viem.pad(viem.toHex(BigInt(v)), { size: 16 });
    const packed = { sender: op.sender, nonce: BigInt(op.nonce), initCode: op.factory ? viem.concat([op.factory, op.factoryData]) : "0x", callData: op.callData,
      accountGasLimits: viem.concat([L(op.verificationGasLimit), L(op.callGasLimit)]), preVerificationGas: BigInt(op.preVerificationGas),
      gasFees: viem.concat([L(op.maxPriorityFeePerGas), L(op.maxFeePerGas)]), paymasterAndData: "0x", signature: op.signature };
    const rc = await send({ to: entryPoint, data: viem.encodeFunctionData({ abi: PA.ABI.entryPoint, functionName: "handleOps", args: [[packed], wc.account.address] }), label: "handleOps" });
    const ev = rc.logs.find((l) => l.topics[0] === viem.keccak256(viem.toBytes("UserOperationEvent(bytes32,address,address,uint256,bool,uint256,uint256)")));
    if (!ev) throw new Error("no UserOperationEvent");
    if (BigInt("0x" + ev.data.slice(2 + 64, 2 + 128)) !== 1n) return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, error: { message: "user operation reverted" } }));
    return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: ev.topics[1] }));
  };
}
const GAS = { verificationGasLimit: 900_000n, callGasLimit: 300_000n, preVerificationGas: 80_000n, maxFeePerGas: 2_000_000_000n, maxPriorityFeePerGas: 1_000_000n };

test("ERC-4337 v0.7: the owner's own transport only; a 2-of-2 user operation (passkey + recovery key) moves USDC; a passkey account is CREATED by a user operation", { skip, timeout: 300000 }, async () => {
  ready();
  const transport = { provider: "safe-passkey", entryPoint: AP.PROVIDERS["safe-passkey"].entryPoint, bundlers: ["https://bundler.owner-choice.example/rpc"] };
  profile = { ...profile, transport };
  PA.validateAccountProfile(profile);
  await rpc("anvil_setBalance", [safe, "0xde0b6b3a7640000"]);
  const dst = "0x" + "d5".repeat(20);
  const data = viem.encodeFunctionData({ abi: viem.erc20Abi, functionName: "transfer", args: [dst, 1_000_000n] });
  const prep = await PA.prepareUserOperation(profile, { to: USDC, data, gas: GAS }, { reader });
  const parts = await PA.passkeyParts([profile.owners[0]], prep.operationHash, { getFn: auth.getFn });
  parts.push({ signer: recovery.address.toLowerCase(), ecdsa: await recovery.sign({ hash: prep.operationHash }) });
  const op = await PA.signUserOperation(prep, await PA.safeSignatures(parts));
  const seen = [];
  const sent = await PA.sendUserOperation(transport, op, { fetchImpl: localBundler(seen), gas: GAS });
  assert.equal(sent.bundler, transport.bundlers[0]);
  assert.deepEqual(seen.map((s) => [s.url, s.method, s.entryPoint]), [[transport.bundlers[0], "eth_sendUserOperation", transport.entryPoint]], "only the owner's bundler was asked");
  assert.equal(await usdcBal(dst), 1_000_000n);
  // a bundler that refuses: nothing else is tried
  await assert.rejects(PA.sendUserOperation(transport, op, { fetchImpl: async () => new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, error: { message: "AA25 invalid account nonce" } })), gas: GAS }),
    (e) => e.code === "transport" && /Nothing else was tried/.test(e.message));
  // account CREATION by a user operation: a new passkey-only Safe (signer already deployed), deployed through initCode
  const sA = profile.owners[0].signer;
  const pred = await PA.prepareSafeCreation({ owners: [sA], threshold: 1, saltNonce: "7" }, { reader });
  const p2 = { ...profile, safe: pred.safe, saltNonce: "7", threshold: 1, owners: [profile.owners[0]] };
  await rpc("anvil_setBalance", [pred.safe, "0xde0b6b3a7640000"]);
  const initCode = { factory: pred.create.to, data: pred.create.data };
  const prep2 = await PA.prepareUserOperation(p2, { to: dst, data: "0x", initCode, gas: GAS }, { reader });
  const op2 = await PA.signUserOperation(prep2, await PA.safeSignatures(await PA.passkeyParts([p2.owners[0]], prep2.operationHash, { getFn: auth.getFn })));
  await PA.sendUserOperation(transport, op2, { fetchImpl: localBundler(seen), gas: GAS, initCode });
  const id = await AP.identifyAccount(pred.safe, { reader });
  assert.equal(id.provider, "safe-passkey"); assert.equal(id.threshold, 1); assert.deepEqual(id.owners.map((o) => o.kind), ["passkey"]);
  assert.match(id.warnings.join("\n"), /One owner: losing that key loses the account/);
});

test("account-first: a shared-signer passkey configured atomically by the initializer; front-running deploys exactly it; the account creates itself by a user operation paid from its own ETH", { skip, timeout: 300000 }, async () => {
  ready();
  const C = AP.PROVIDERS["safe-passkey"].contracts;
  const P = await PA.createPasskey({ rpId: "dash-a.example", rpName: "Dashboard A", userName: "owner (first key)", createFn: auth.createFn });
  const X = await PA.createPasskey({ rpId: "dash-a.example", rpName: "Dashboard A", userName: "someone else", createFn: auth.createFn });
  const shared = (k, label) => ({ kind: "passkey", signer: C.webauthnSharedSigner.address, shared: true, x: k.x, y: k.y, verifiers: String(PA.VERIFIERS_PRECOMPILE), credentialId: k.credentialId, rpId: k.rpId, label });
  const transport = { provider: "safe-passkey", entryPoint: AP.PROVIDERS["safe-passkey"].entryPoint, bundlers: ["https://bundler.owner-choice.example/rpc"] };
  const base = { v: 1, provider: "safe-passkey", chainId: 8453, safe: "0x" + "00".repeat(19) + "01", saltNonce: "2026", threshold: 1, transport,
    owners: [shared(P, "laptop"), { kind: "key", address: recovery.address.toLowerCase(), label: "recovery key" }] };
  const pred = await PA.prepareSafeCreation(PA.creationOf(base), { reader });
  const p3 = { ...base, safe: pred.safe };
  PA.validateAccountProfile(p3);
  // another key with the same owners' shape and salt is another address: nobody can claim this one with their own key
  const other = await PA.prepareSafeCreation(PA.creationOf({ ...base, owners: [shared(X, "x"), base.owners[1]] }), { reader });
  assert.notEqual(other.safe, pred.safe);
  // the initializer is the reviewed shape: setup(owners, 1, MultiSend, multiSend[delegatecall enableModules, delegatecall configure], module)
  const [owners, threshold, to, , handler] = viem.decodeFunctionData({ abi: PA.ABI.safe, data: pred.initializer }).args;
  assert.deepEqual(owners.map((a) => a.toLowerCase()), [C.webauthnSharedSigner.address, recovery.address.toLowerCase()]);
  assert.equal(threshold, 1n); assert.equal(to.toLowerCase(), C.multiSend.address); assert.equal(handler.toLowerCase(), C.safe4337Module.address);
  // configure is only ever delegatecalled: a direct call reverts (NotDelegateCalled)
  const direct = viem.encodeFunctionData({ abi: PA.ABI.sharedSigner, functionName: "configure", args: [{ x: BigInt(X.x), y: BigInt(X.y), verifiers: PA.VERIFIERS_PRECOMPILE }] });
  await assert.rejects(pc.call({ to: C.webauthnSharedSigner.address, data: direct, account: wc.account }));
  // the owner pre-funds the counterfactual address (from anywhere); the account then creates ITSELF through its own user
  // operation: the passkey approves the operation hash through the shared signer, the account pays the EntryPoint
  await rpc("anvil_setBalance", [pred.safe, "0x2386f26fc10000"]);              // 0.01 ETH of its own
  const prep = await PA.prepareUserOperation(p3, { to: pred.safe, data: "0x", initCode: pred.initCode, gas: GAS }, { reader });
  const op = await PA.signUserOperation(prep, await PA.safeSignatures(await PA.passkeyParts([p3.owners[0]], prep.operationHash, { getFn: auth.getFn })));
  const seen = [];
  await PA.sendUserOperation(transport, op, { fetchImpl: localBundler(seen), gas: GAS, initCode: pred.initCode });
  assert.ok((await pc.getBalance({ address: pred.safe })) < 10n ** 16n, "the account paid its own gas");
  const v = await PA.verifyAccountProfile(p3, { reader });
  assert.equal(v.deployed, true);
  const cfg = await pc.readContract({ address: C.webauthnSharedSigner.address, abi: PA.ABI.sharedSigner, functionName: "getConfiguration", args: [pred.safe] });
  assert.equal(cfg.x, BigInt(P.x)); assert.equal(cfg.y, BigInt(P.y)); assert.equal(cfg.verifiers, PA.VERIFIERS_PRECOMPILE);
  const id = await AP.identifyAccount(pred.safe, { reader });
  assert.deepEqual(id.owners.map((o) => [o.kind, o.via || null, o.configured ?? null]), [["passkey", "shared signer", true], ["eoa", null, null]]);
  assert.deepEqual(id.modules, [{ address: C.safe4337Module.address, known: true }]); assert.equal(id.fallbackHandler, C.safe4337Module.address);
  assert.equal((await pc.readContract({ address: C.safe4337Module.address, abi: PA.ABI.module4337, functionName: "SUPPORTED_ENTRYPOINT" })).toLowerCase(), C.entryPoint.address);
  // the same passkey now signs AS the Safe (ERC-1271 through the shared signer): a session vault accepts it
  const store = new S.MemoryStore();
  const { signer } = await S.newSessionKey(store, { relay: "", chainId: 8453, label: "account-first", extractable: true });
  const grant = S.buildGrant({ sessionKey: signer.keyHash, label: "account-first", preset: "browser", policy: { budget: 0n, expiresIn: 3600 }, signWithin: 900 });
  const rec = OS.recordingSigner(PA.passkeySafeOwnerSigner({ profile: p3, passkeys: [P.credentialId], getFn: auth.getFn }));
  const open = await S.prepareSessionOpen({ publicClient: pc, factory: contracts.factory, owner: rec.signer, chainId: 8453, grant });
  await OS.verifyOwnerSubmission({ prep: open, owner: pred.safe, signatures: rec.signatures }, { reader });
  // a front-runner may deploy a counterfactual account before its owner does, but only with ITS initializer: same owners,
  // same key, same module - deploying ours again reverts, and a third party's copy of another salt is simply another account
  await assert.rejects(send({ ...pred.create, label: "createProxyWithNonce again" }));
  const fr = await PA.prepareSafeCreation({ ...PA.creationOf(p3), saltNonce: "2027" }, { reader });
  await send({ ...fr.create, label: "a front-runner deploys the owner's next account" });
  const frCfg = await pc.readContract({ address: C.webauthnSharedSigner.address, abi: PA.ABI.sharedSigner, functionName: "getConfiguration", args: [fr.safe] });
  assert.equal(frCfg.x, BigInt(P.x), "whoever deploys it, the account holds the owner's key");
  const frId = await AP.identifyAccount(fr.safe, { reader });
  assert.deepEqual(frId.owners.map((o) => o.address.toLowerCase()), owners.map((a) => a.toLowerCase()));
});
