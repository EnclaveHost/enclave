// Relay-free session OWNER operations against the REAL contracts on a local chain: a PinnedSessionVaultFactory over the
// schema-16 ledger and the catalog (test/helpers/sessions-chain.mjs), driven only by the SDK's prepare functions and
// independent gas payers. Authorization is the vault's own _ownerAuth at execution: msg.sender == owner (direct), or
// the owner's EIP-712 signature with a single-use opNonce before signBefore (signed). No relay, no fake method.
//   run: node --test test/sessions-owner-ops.test.mjs      (needs anvil + forge and a built SDK)
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { privateKeyToAccount } from "viem/accounts";
import { encodeDeployData, getAddress, parseUnits, decodeErrorResult, parseEventLogs } from "viem";
import { haveFoundry, startChain, deployPlatform, KEYS } from "./helpers/sessions-chain.mjs";
import { linkBytecode } from "../site/js/lib/contract-linker.js";
import * as sdk from "../sdk/sessions/dist/node.mjs";

const REPO = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const skip = !haveFoundry() ? "needs Foundry (anvil + forge)" : false;
const owner = privateKeyToAccount(KEYS.owner), stranger = privateKeyToAccount(KEYS.stranger);
const signerOf = (acct, claimed = acct.address) => ({ address: claimed, signTypedData: (td) => acct.signTypedData(td) });
let chain, P, factory, vault, sid, usdcDom;

const art = (file, name) => { const j = JSON.parse(fs.readFileSync(path.join(REPO, "contracts/foundry/out", file, name + ".json"), "utf8"));
  return { abi: j.abi, bytecode: j.bytecode.object, linkReferences: j.bytecode.linkReferences || {} }; };
async function send(key, prep){
  const hash = await chain.wc(key).sendTransaction({ to: prep.to, data: prep.data, value: prep.value });
  const rc = await chain.pc.waitForTransactionReceipt({ hash });
  assert.equal(rc.status, "success"); return rc;
}
/** The vault's revert reason for a call from `from`, or null when it would succeed. */
async function revertOf(from, prep){
  try { await chain.pc.call({ account: from, to: prep.to, data: prep.data }); return null; }
  catch (e){
    for (let c = e; c; c = c.cause){
      const data = c.data && typeof c.data === "string" ? c.data : c.data?.data;
      if (typeof data === "string" && data.startsWith("0x") && data.length >= 10){
        try { return decodeErrorResult({ abi: sdk.sessionVaultAbi, data }).errorName; } catch { return "revert:" + data.slice(0, 10); }
      }
    }
    return "revert:" + String(e.shortMessage || e.message).slice(0, 80);
  }
}
const sessionOf = async () => sdk.readSession(chain.pc, vault, sid);

before(async () => {
  if (skip) return;
  chain = await startChain();
  P = await deployPlatform(chain, { ledger: "contracts" });
  const lib = art("SessionVault.sol", "SessionVaultLib"), fac = art("PinnedSessionVaultFactory.sol", "PinnedSessionVaultFactory");
  const dep = chain.wc(KEYS.deployer);
  const libHash = await dep.sendTransaction({ data: encodeDeployData({ abi: lib.abi, bytecode: lib.bytecode }) });
  const libAddr = getAddress((await chain.pc.waitForTransactionReceipt({ hash: libHash })).contractAddress);
  const links = {}; for (const [f, ls] of Object.entries(fac.linkReferences)) for (const n of Object.keys(ls)) links[`${f}:${n}`] = libAddr;
  const fh = await dep.sendTransaction({ data: encodeDeployData({ abi: fac.abi, bytecode: linkBytecode(fac.bytecode, fac.linkReferences, links),
    args: [P.usdc, P.ledger, P.catalog, P.router, "0x0000000000000000000000000000000000000000", parseUnits("1000", 6)] }) });
  factory = getAddress((await chain.pc.waitForTransactionReceipt({ hash: fh })).contractAddress);
  usdcDom = await sdk.usdcDomain(chain.pc, P.usdc, 31337);
  const signer = await sdk.signerFromKeyPair(await sdk.generateKeyPair(false));
  const grant = sdk.buildGrant({ sessionKey: signer.keyHash, label: "owner ops", preset: "browser", policy: { budget: parseUnits("2", 6), expiresIn: 3600 } });
  const opened = await sdk.prepareSessionOpen({ publicClient: chain.pc, factory, owner: signerOf(owner), chainId: 31337, grant, usdc: usdcDom });
  await send(KEYS.stranger, opened);                // any gas payer
  vault = opened.vault; sid = opened.sid;
  chain.session = new sdk.Session({ chainId: 31337, vault, sid, relay: "https://refused.invalid" }, signer,
    { publicClient: chain.pc, fetch: async () => { throw new Error("no relay"); } });
});
after(() => chain?.stop());

test("top-up from the owner's wallet: one EIP-3009 signature bound to this session, submitted by anyone, once", { skip }, async () => {
  const b0 = (await sessionOf()).balance6;
  const prep = await sdk.prepareTopUpFromWallet({ publicClient: chain.pc, chainId: 31337, vault, sessionId: sid, amount: parseUnits("1", 6),
    usdc: usdcDom, owner: signerOf(owner) });
  await send(KEYS.stranger, prep);
  assert.equal((await sessionOf()).balance6, b0 + parseUnits("1", 6));
  assert.ok(await revertOf(stranger.address, prep), "the same authorization cannot fund twice");
  // the vault pulls only from its own owner: a stranger's authorization (even claiming the owner's address) fails
  await assert.rejects(sdk.prepareTopUpFromWallet({ publicClient: chain.pc, chainId: 31337, vault, sessionId: sid, amount: 1n, usdc: usdcDom,
    owner: signerOf(stranger) }), (e) => e.code === "signature");
  const forged = await sdk.prepareTopUpFromWallet({ publicClient: chain.pc, chainId: 31337, vault, sessionId: sid, amount: 1n, usdc: usdcDom,
    owner: signerOf(stranger, owner.address) });
  assert.ok(await revertOf(stranger.address, forged));
});

test("signed owner operations: valid once, before signBefore, only with the owner's key", { skip }, async () => {
  const now = BigInt(chain.now());
  const extend = (expiresAt, signer, validSeconds) => sdk.prepareOwnerOperation({ publicClient: chain.pc, chainId: 31337, vault, mode: "signed",
    owner: signer, validSeconds, op: { op: "extend", sessionId: sid, expiresAt } });
  const ok = await extend(now + 7200n, signerOf(owner));
  assert.equal(await revertOf(stranger.address, ok), null);
  await send(KEYS.stranger, ok);
  assert.equal((await sessionOf()).expiresAt, now + 7200n);
  assert.equal(await revertOf(stranger.address, ok), "NonceUsed", "replay refused");
  const forged = await extend(now + 9000n, signerOf(stranger, owner.address));
  assert.equal(await revertOf(stranger.address, forged), "BadSignature");
  await assert.rejects(extend(now + 9000n, signerOf(stranger)), (e) => e.code === "signature", "a known non-owner fails before signing");
  const late = await extend(now + 9000n, signerOf(owner), 5);
  await chain.warp(30);
  assert.equal(await revertOf(stranger.address, late), "Expired");
  // the signature is bound to this vault's domain and chain: a different session id is a different digest
  const other = await extend(BigInt(chain.now()) + 9000n, signerOf(owner));
  const tampered = { ...other, data: other.data.replace(sid.slice(2), "11".repeat(32)) };
  assert.equal(await revertOf(stranger.address, tampered), "BadSignature");
});

test("direct owner operations: authorized by msg.sender == owner in the executing block; nobody else can submit them", { skip }, async () => {
  const target = BigInt(chain.now()) + 10800n;
  const prep = await sdk.prepareOwnerOperation({ publicClient: chain.pc, chainId: 31337, vault, mode: "direct", expectOwner: owner.address,
    op: { op: "extend", sessionId: sid, expiresAt: target } });
  assert.equal(await revertOf(stranger.address, prep), "BadSignature", "the same calldata from another account has no signature");
  await send(KEYS.owner, prep);
  assert.equal((await sessionOf()).expiresAt, target);
  await send(KEYS.owner, prep);                     // direct calls carry no single-use nonce: the owner may repeat them
  await assert.rejects(sdk.prepareOwnerOperation({ publicClient: chain.pc, chainId: 31337, vault, mode: "direct", expectOwner: stranger.address,
    op: { op: "withdraw", amount: 0n } }), (e) => e.code === "signature");
  await assert.rejects(sdk.prepareOwnerOperation({ publicClient: chain.pc, chainId: 1, vault, mode: "direct", op: { op: "withdraw", amount: 0n } }),
    (e) => e.code === "config", "the RPC must serve the vault's chain");
});

test("promote: a staging deployment the session created becomes production only through the owner, then revocation ends the session", { skip }, async () => {
  const created = await send(KEYS.stranger, await chain.session.prepareCall("deploy.create", { appRef: P.storeRef, gpuMilli: 0, cpuMilli: 100,
    appPort: 8080, ports: "", isPublic: true, configCid: "", maxRate6: 1000n, env: "staging", fund6: parseUnits("0.5", 6) }));
  const result = parseEventLogs({ abi: sdk.sessionVaultAbi, logs: created.logs, eventName: "SessionOp" })[0].args.result;
  const id = `0x${result.slice(2, 66)}`;
  const [env0] = await chain.pc.readContract({ address: vault, abi: sdk.sessionVaultAbi, functionName: "held", args: [id] });
  assert.equal(Number(env0), 1, "staging");
  const op = { op: "promote", deployment: id, app: "store", publisher: P.publisher, appRef: P.storeRef, configCid: "", versionLabel: "1.0.0", isPublic: true };
  const wrongLabel = await sdk.prepareOwnerOperation({ publicClient: chain.pc, chainId: 31337, vault, mode: "direct", op: { ...op, versionLabel: "9.9.9" } });
  assert.equal(await revertOf(owner.address, wrongLabel), "LabelMismatch", "the device-visible label must be the catalog's");
  const signed = await sdk.prepareOwnerOperation({ publicClient: chain.pc, chainId: 31337, vault, mode: "signed", owner: signerOf(owner), op });
  await send(KEYS.stranger, signed);
  const [env1, promoted] = await chain.pc.readContract({ address: vault, abi: sdk.sessionVaultAbi, functionName: "held", args: [id] });
  assert.equal(Number(env1), 2, "production");
  assert.notEqual(promoted, "0x" + "00".repeat(32));
  // a session may no longer change the production record's version
  await assert.rejects(async () => { const p = await chain.session.prepareCall("deploy.setAppRef", { id, appRef: P.storeRef }); await send(KEYS.stranger, p); });
  const revoke = await sdk.prepareOwnerOperation({ publicClient: chain.pc, chainId: 31337, vault, mode: "direct", op: { op: "revokeAll", withdraw: false } });
  await send(KEYS.owner, revoke);
  assert.equal((await sessionOf()).live, false, "revocation ends the session");
  const term = await sdk.prepareOwnerOperation({ publicClient: chain.pc, chainId: 31337, vault, mode: "signed", owner: signerOf(owner), op: { op: "terminate", sessionId: sid } });
  assert.equal(await revertOf(stranger.address, term), "NotLive");
});
