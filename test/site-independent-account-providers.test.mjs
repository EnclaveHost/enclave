// Existing audited passkey smart accounts as independent owners (site/js/core/account-providers.js): pinned provider
// deployments (address + runtime code hash), read-only recognition of a Safe (owners, passkey signers from the pinned
// factory or shared signer, threshold, modules, fallback handler, guard) and of a Coinbase Smart Wallet (owners, pinned
// implementation), honest warnings, and validation of an owner-chosen ERC-4337 transport. Fixtures are ABI-encoded with
// viem; every read must come from ONE agreed block. A live read-only check of the real Base pins runs with
// ENCLAVE_LIVE_READS=1 (public Base RPCs).
//   run: node --test test/site-independent-account-providers.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { encodeAbiParameters, keccak256 } from "viem";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
let AP;
test.before(async () => {
  globalThis.localStorage ??= { getItem: () => null, setItem(){}, removeItem(){} };
  globalThis.sessionStorage ??= globalThis.localStorage;
  globalThis.location ??= { hostname: "localhost" };
  AP = await import(pathToFileURL(path.join(REPO, "site/js/core/account-providers.js")).href);
});

const lc = (a) => a.toLowerCase();
const enc = (types, values) => encodeAbiParameters(types.map((t) => ({ type: t })), values);
const word = (v) => enc(["uint256"], [BigInt(v)]);
/* a scripted agreed reader: code by address, eth_call answers by `${to}:${data}`; records the block of every read */
function chain({ code = {}, calls = {} }){
  const blocks = new Set();
  return { blocks, snapshot: async () => ({ number: 777, hash: "0x" + "77".repeat(32) }),
    code: async (snap, a) => { blocks.add(snap.number); return code[lc(a)] ?? "0x"; },
    call: async (snap, to, data) => { blocks.add(snap.number); const k = lc(to) + ":" + lc(data);
      if (k in calls) return calls[k]; const e = new Error("the contract call reverted"); e.revert = true; throw e; } };
}
const SAFE = "0x" + "5a".repeat(20), EOA = "0x" + "e0".repeat(20), SIGNER = "0x" + "51".repeat(20), FORGED = "0x" + "f0".repeat(20);
const pad = (v) => (typeof v === "bigint" ? v.toString(16) : v.replace(/^0x/, "")).padStart(64, "0");
const verifiers = (0x100n << 160n);                                  // precompile only
function safeWorld({ singleton, owners, threshold, modules, fallback, guard, signerCfg = {}, factoryDerives = {} }){
  const P = AP.PROVIDERS["safe-passkey"].contracts;
  const calls = {
    [lc(SAFE) + ":0xa619486e"]: enc(["address"], [singleton]),
    [lc(SAFE) + ":0xa0e67e2b"]: enc(["address[]"], [owners]),
    [lc(SAFE) + ":0xe75235b8"]: word(threshold),
    [lc(SAFE) + ":0xcc2f8452" + pad("0x" + "0".repeat(39) + "1") + pad(20n)]: enc(["address[]", "address"], [modules, "0x0000000000000000000000000000000000000001"]),
    [lc(SAFE) + ":0x5624b25b" + "6c9a6c4a39284e37ed1cf53d337577d14212a4870fb976a4366c693b939918d5" + pad(1n)]: enc(["bytes"], [enc(["address"], [fallback])]),
    [lc(SAFE) + ":0x5624b25b" + "4a204f620c8c5ccdca3fd54d003badd85ba500436a431f0cbda4f558c93c34c8" + pad(1n)]: enc(["bytes"], [enc(["address"], [guard])]),
  };
  const code = { [lc(SAFE)]: "0x608060" };
  for (const [addr, cfg] of Object.entries(signerCfg)){
    code[lc(addr)] = "0x6080signer";
    calls[lc(addr) + ":0x6bd50cef"] = enc(["uint256", "uint256", "uint176"], [cfg.x, cfg.y, cfg.v]);
    calls[lc(P.webauthnSignerFactory.address) + ":0xa541d91a" + pad(cfg.x) + pad(cfg.y) + pad(cfg.v)] = enc(["address"], [factoryDerives[addr] || addr]);
  }
  return { code, calls };
}

test("Safe on the pinned singleton: passkey signer from the pinned factory, shared signer, EOA; 2-of-3; pinned module and handler", async () => {
  const P = AP.PROVIDERS["safe-passkey"].contracts;
  const w = safeWorld({ singleton: P.safeL2.address, owners: [SIGNER, P.webauthnSharedSigner.address, EOA], threshold: 2,
    modules: [P.safe4337Module.address], fallback: P.safe4337Module.address, guard: "0x" + "00".repeat(20),
    signerCfg: { [SIGNER]: { x: 11n, y: 22n, v: verifiers } } });
  w.code[lc(P.webauthnSharedSigner.address)] = "0x6080shared";
  w.calls[lc(P.webauthnSharedSigner.address) + ":0xc44b11f7" + pad(SAFE)] = enc(["uint256", "uint256", "uint176"], [33n, 44n, verifiers | BigInt(P.daimoP256Verifier.address)]);
  const r = chain(w);
  const a = await AP.identifyAccount(SAFE, { reader: r });
  assert.equal(a.provider, "safe-passkey"); assert.equal(a.recognized, true); assert.equal(a.threshold, 2);
  assert.deepEqual(a.owners.map((o) => [o.kind, o.via || null]), [["passkey", "signer factory"], ["passkey", "shared signer"], ["eoa", null]]);
  assert.deepEqual(a.owners[1].verifiers, { precompile: "0x0100", fallback: P.daimoP256Verifier.address });
  assert.deepEqual(a.modules, [{ address: P.safe4337Module.address, known: true }]);
  assert.deepEqual(a.warnings.length, 1, JSON.stringify(a.warnings));
  assert.match(a.warnings[0], /not the website \(origin\) or RP/);
  assert.deepEqual([...r.blocks], [777], "every read at the one agreed block");
});

test("Safe warnings: threshold 1, a forged passkey signer, an unknown module, an unreviewed fallback handler, a guard", async () => {
  const P = AP.PROVIDERS["safe-passkey"].contracts;
  const w = safeWorld({ singleton: P.safeL2.address, owners: [FORGED, EOA], threshold: 1, modules: ["0x" + "bb".repeat(20), P.safe4337Module.address],
    fallback: "0x" + "cc".repeat(20), guard: "0x" + "dd".repeat(20),
    signerCfg: { [FORGED]: { x: 1n, y: 2n, v: verifiers } }, factoryDerives: { [FORGED]: "0x" + "99".repeat(20) } });
  const a = await AP.identifyAccount(SAFE, { reader: chain(w) });
  assert.deepEqual(a.owners.map((o) => o.kind), ["contract", "eoa"], "a signer the pinned factory does not derive is not a passkey");
  const all = a.warnings.join("\n");
  for (const re of [/Threshold 1: any single owner can act alone/, /No passkey owner/, /Module 0xbbbb.* without the owners' signatures/,
                    /Fallback handler 0xcccc.* unreviewed/, /Guard 0xdddd.* can block/]) assert.match(all, re);
  // one owner; owners equal to the threshold
  const one = await AP.identifyAccount(SAFE, { reader: chain(safeWorld({ singleton: P.safeL2.address, owners: [EOA], threshold: 1, modules: [],
    fallback: P.fallbackHandler.address, guard: "0x" + "00".repeat(20) })) });
  assert.match(one.warnings.join("\n"), /One owner: losing that key loses the account/);
  const tight = await AP.identifyAccount(SAFE, { reader: chain(safeWorld({ singleton: P.safeL2.address, owners: [EOA, "0x" + "e1".repeat(20)], threshold: 2,
    modules: [], fallback: "0x" + "00".repeat(20), guard: "0x" + "00".repeat(20) })) });
  assert.match(tight.warnings.join("\n"), /No spare key/); assert.match(tight.warnings.join("\n"), /No fallback handler/);
  // a Safe on another singleton is not described
  const other = await AP.identifyAccount(SAFE, { reader: chain(safeWorld({ singleton: "0x" + "ab".repeat(20), owners: [EOA], threshold: 1, modules: [],
    fallback: P.fallbackHandler.address, guard: "0x" + "00".repeat(20) })) });
  assert.equal(other.provider, "safe-unrecognized"); assert.equal(other.recognized, false); assert.deepEqual(other.owners, []);
});

test("Coinbase Smart Wallet: address and passkey owners, a removed slot skipped, the 1-of-N warning, an upgraded implementation flagged", async () => {
  const C = AP.PROVIDERS["coinbase-smart-wallet"];
  const ACC = "0x" + "cb".repeat(20);
  const world = (impl) => ({ code: { [lc(ACC)]: "0x363d3d37" }, calls: {
    [lc(ACC) + ":0x5c60da1b"]: enc(["address"], [impl]),
    [lc(ACC) + ":0xb0d691fe"]: enc(["address"], [C.entryPoint]),
    [lc(ACC) + ":0xd948fd2e"]: word(3),
    [lc(ACC) + ":0x8ea69029" + pad(0n)]: enc(["bytes"], [enc(["address"], [EOA])]),
    [lc(ACC) + ":0x8ea69029" + pad(1n)]: enc(["bytes"], ["0x"]),
    [lc(ACC) + ":0x8ea69029" + pad(2n)]: enc(["bytes"], [enc(["uint256", "uint256"], [5n, 6n])]) } });
  const a = await AP.identifyAccount(ACC, { reader: chain(world(C.contracts.implementation.address)) });
  assert.equal(a.provider, "coinbase-smart-wallet"); assert.equal(a.version, "1.1"); assert.equal(a.recognized, true);
  assert.deepEqual(a.owners, [{ kind: "eoa-or-contract", index: 0, address: lc(EOA) }, { kind: "passkey", index: 2, x: "0x" + pad(5n), y: "0x" + pad(6n) }]);
  assert.match(a.warnings.join("\n"), /Any one owner of this account can act alone, including upgrading/);
  assert.match(a.warnings.join("\n"), /does not require user verification/);
  const up = await AP.identifyAccount(ACC, { reader: chain(world("0x" + "ee".repeat(20))) });
  assert.equal(up.recognized, false); assert.match(up.warnings.join("\n"), /not the pinned v1.1 code/);
});

test("EOA, EIP-7702-delegated EOA, and contracts that are neither (including one that answers every call with empty data)", async () => {
  const X = "0x" + "aa".repeat(20);
  assert.equal((await AP.identifyAccount(X, { reader: chain({}) })).provider, "eoa");
  const d = await AP.identifyAccount(X, { reader: chain({ code: { [lc(X)]: "0xef0100" + "cd".repeat(20) } }) });
  assert.deepEqual([d.provider, d.delegate], ["delegated-eoa", "0x" + "cd".repeat(20)]);
  const unknown = await AP.identifyAccount(X, { reader: chain({ code: { [lc(X)]: "0x6080" } }) });
  assert.equal(unknown.provider, "contract-unknown");
  const permissive = chain({ code: { [lc(X)]: "0x6080" } });
  permissive.call = async () => "0x";                                  // a fallback that accepts any selector (WETH-like)
  assert.equal((await AP.identifyAccount(X, { reader: permissive })).provider, "contract-unknown");
  await assert.rejects(AP.identifyAccount("0x12", { reader: chain({}) }), /account address/);
});

test("provider deployment check: every pinned contract's code hash, at one block; a changed contract fails the provider", async () => {
  const codeA = "0x6001600101", codeB = "0x6002600202";
  const providers = { demo: { contracts: { a: { address: "0x" + "0a".repeat(20), codeHash: keccak256(codeA) }, b: { address: "0x" + "0b".repeat(20), codeHash: keccak256(codeB) } } } };
  const good = await AP.verifyProviderDeployment("demo", { providers, reader: chain({ code: { ["0x" + "0a".repeat(20)]: codeA, ["0x" + "0b".repeat(20)]: codeB } }) });
  assert.equal(good.ok, true); assert.equal(good.block, 777);
  const bad = await AP.verifyProviderDeployment("demo", { providers, reader: chain({ code: { ["0x" + "0a".repeat(20)]: codeA, ["0x" + "0b".repeat(20)]: "0x6003" } }) });
  assert.equal(bad.ok, false); assert.deepEqual(bad.rows.filter((r) => !r.ok).map((r) => r.name), ["b"]);
  const gone = await AP.verifyProviderDeployment("demo", { providers, reader: chain({ code: { ["0x" + "0a".repeat(20)]: codeA } }) });
  assert.equal(gone.ok, false, "no code is a failure");
  await assert.rejects(AP.verifyProviderDeployment("nope", { providers, reader: chain({}) }), /unknown account provider/);
  // the shipped pins are well-formed and name each provider's own EntryPoint
  for (const p of Object.values(AP.PROVIDERS)){
    for (const c of Object.values(p.contracts)){ assert.match(c.address, /^0x[0-9a-f]{40}$/); assert.match(c.codeHash, /^0x[0-9a-f]{64}$/); }
    assert.equal(p.contracts.entryPoint.address, p.entryPoint);
    assert.ok(p.sources.length && p.audits.length);
  }
  assert.equal(AP.PROVIDERS["safe-passkey"].preferred, true); assert.equal(AP.PROVIDERS["coinbase-smart-wallet"].preferred, false);
});

test("owner-chosen ERC-4337 transport: the provider's EntryPoint, HTTPS bundlers on distinct hosts, never only Enclave, a well-formed paymaster", () => {
  const S = AP.PROVIDERS["safe-passkey"], C = AP.PROVIDERS["coinbase-smart-wallet"];
  const ok = AP.validateAccountTransport({ provider: "safe-passkey", entryPoint: S.entryPoint, bundlers: ["https://bundler.example.org/rpc", "https://aa.enclave.host/rpc"] });
  assert.match(ok.gas, /pays gas in ETH itself/);
  const pm = AP.validateAccountTransport({ provider: "coinbase-smart-wallet", entryPoint: C.entryPoint.toUpperCase().replace("0X", "0x"),
    bundlers: ["https://b.example.net"], paymaster: { kind: "erc20", address: "0x" + "12".repeat(20), url: "https://pm.example.net" } });
  assert.equal(pm.paymaster.enclaveOperated, false); assert.match(pm.gas, /charges gas in a token/);
  for (const [t, re] of [
    [{ provider: "nope", entryPoint: S.entryPoint, bundlers: ["https://a.example"] }, /unknown provider/],
    [{ provider: "safe-passkey", entryPoint: C.entryPoint, bundlers: ["https://a.example"] }, /uses EntryPoint/],
    [{ provider: "safe-passkey", entryPoint: S.entryPoint, bundlers: [] }, /1 to 8/],
    [{ provider: "safe-passkey", entryPoint: S.entryPoint, bundlers: ["http://a.example"] }, /plain https/],
    [{ provider: "safe-passkey", entryPoint: S.entryPoint, bundlers: ["https://u:p@a.example"] }, /plain https/],
    [{ provider: "safe-passkey", entryPoint: S.entryPoint, bundlers: ["https://a.example/1", "https://a.example/2"] }, /distinct hosts/],
    [{ provider: "safe-passkey", entryPoint: S.entryPoint, bundlers: ["https://aa.enclave.host", "https://b.enclave.host"] }, /Enclave-operated/],
    [{ provider: "safe-passkey", entryPoint: S.entryPoint, bundlers: ["https://a.example"], paymaster: { kind: "free", address: "0x" + "12".repeat(20), url: "https://p.example" } }, /kind/],
    [{ provider: "safe-passkey", entryPoint: S.entryPoint, bundlers: ["https://a.example"], paymaster: { kind: "verifying", address: "0x" + "12".repeat(20), url: "http://p.example" } }, /https url/],
    [{ provider: "safe-passkey", entryPoint: S.entryPoint, bundlers: ["https://a.example"], relay: "https://r.example" }, /unknown account transport fields/],
  ]) assert.throws(() => AP.validateAccountTransport(t), re, JSON.stringify(t));
});

test("live (opt-in): the real Base deployments still match every pin", { skip: process.env.ENCLAVE_LIVE_READS !== "1" && "set ENCLAVE_LIVE_READS=1 (read-only public Base RPCs)" }, async () => {
  const { createQuorumReader } = await import(pathToFileURL(path.join(REPO, "site/js/core/quorum.js")).href);
  const reader = createQuorumReader({ rpcs: ["https://mainnet.base.org", "https://base-rpc.publicnode.com", "https://base.drpc.org"], quorum: 2,
    confirmations: 2, maxBlockAgeSeconds: 600, chainId: 8453 });
  for (const p of Object.keys(AP.PROVIDERS)){
    const r = await AP.verifyProviderDeployment(p, { reader });
    assert.equal(r.ok, true, p + ": " + JSON.stringify(r.rows.filter((x) => !x.ok)));
  }
});
