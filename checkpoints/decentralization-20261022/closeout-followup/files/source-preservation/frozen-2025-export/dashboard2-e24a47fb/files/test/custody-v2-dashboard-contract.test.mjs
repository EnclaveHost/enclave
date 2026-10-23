// The dashboard's custody v2 owner flow (site/js/core/custody-v2.js over the COMMITTED site/vendor/custody-v2.js, its REAL
// agreed chain reader over two JSON-RPC origins) against REAL contracts on a local chain (anvil, chain id 8453):
//   - the ORIGINAL EnclaveSecretVaultV2 (contracts/EnclaveSecretVaultV2.sol), built with the production immutables
//     (book 0xab21…, Enclave owner 0x0b2d…) and placed at the production address 0xE48699B8…: its code hash must equal the
//     reviewed production hash, so the page's identity check passes on genuine bytecode, not on a stub;
//   - EnclaveAddressBook at 0xab21… (its runtime, owner = the administrator 0x0b2d…, impersonated here), the schema-4
//     EnclaveRegistry and EnclaveHostOwnership, and the real SessionVault + SessionVaultFactory (contracts/SessionVault.sol);
//   - a genesis committee created through the vault's own createCommittee on an Enclave-paid host (the production shape:
//     n = 1, t = 1, W = 1); only the deployments ledger is a minimal stand-in (test/helpers/original-vault-rig.mjs RigLedger).
// The activation and rollback transactions are root's EXACT unsigned calldata (work/custody-v2-live-20261023/evidence/
// book-activation-unsigned-20261023.json). What this proves and does not: the page's calldata, ownership rules and
// refusals against the real vault/book/SessionVault code; NOT production state, custodian release, or any wallet UI.
//   run: node --test test/custody-v2-dashboard-contract.test.mjs   (skipped, saying so, without anvil/forge)
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { randomBytes } from "node:crypto";
import { createPublicClient, createWalletClient, http as viemHttp, keccak256, toBytes, stringToHex, encodeFunctionData, encodeDeployData, parseEther, getAddress, decodeErrorResult } from "viem";
import { privateKeyToAccount, generatePrivateKey } from "viem/accounts";
import { originalVaultRig } from "./helpers/original-vault-rig.mjs";
import { leaseGasForgeOut, haveForge } from "./helpers/lease-gas-forge.mjs";
import { openBundle } from "./helpers/custody-v2-fake-vault.mjs";
import { linkBytecode } from "../site/js/lib/contract-linker.js";
import * as v2 from "../custody/v2/protocol.mjs";
import * as D from "../custody/v2/digests.mjs";
import { REVIEWED_CUSTODY_VAULTS } from "../network/custody-vaults.mjs";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const EVIDENCE = path.resolve(REPO, "../../custody-v2-live-20261023/evidence/book-activation-unsigned-20261023.json");
const anvilOk = spawnSync("anvil", ["--version"], { stdio: "ignore" }).status === 0;
const skip = !anvilOk ? "anvil not installed" : !haveForge ? "forge not installed" : false;

// config.js reads storage at import
const store = new Map();
globalThis.localStorage = { getItem: (k) => (store.has(k) ? store.get(k) : null), setItem: (k, v) => store.set(k, String(v)), removeItem: (k) => store.delete(k) };
globalThis.sessionStorage = globalThis.localStorage;
globalThis.CustomEvent = class { constructor(t, o){ this.type = t; this.detail = (o || {}).detail; } };
globalThis.document = { dispatchEvent(){}, addEventListener(){} };

const VAULT = "0xe48699b8401564aace7a814ae4569b67a3f7eef5";
const PROD = REVIEWED_CUSTODY_VAULTS[VAULT];
const BOOK = PROD.immutable.book, ADMIN = PROD.immutable.enclaveOwner;
const key = (s) => stringToHex(s, { size: 32 });
const ZERO = "0x" + "00".repeat(20);
const freePort = () => new Promise((ok) => { const s = net.createServer(); s.listen(0, "127.0.0.1", () => { const p = s.address().port; s.close(() => ok(p)); }); });
const PREDICTION = { appId: "a7".repeat(32), images: [{ releaseAdmitted: true, measurement: "5c".repeat(48), runtimeId: "ef".repeat(32) }] };

test("the dashboard's custody v2 calldata against the REAL original vault, book and SessionVault: activation, EOA and SessionVault owners, wrong authority",
  { skip, timeout: 600_000 }, async () => {
  const C = originalVaultRig();
  const SV = (() => { const out = leaseGasForgeOut();
    const art = (n) => { const j = JSON.parse(fs.readFileSync(path.join(out, "SessionVault.sol", n + ".json"), "utf8")); return { abi: j.abi, bytecode: j.bytecode.object, links: j.bytecode.linkReferences || {} }; };
    const usdc = JSON.parse(fs.readFileSync(path.join(out, "MockUSDC.sol", "MockUSDC.json"), "utf8"));
    return { factory: art("SessionVaultFactory"), vault: art("SessionVault"), usdc: { abi: usdc.abi, bytecode: usdc.bytecode.object, links: {} },
             lib: fs.existsSync(path.join(out, "SessionVault.sol", "SessionVaultLib.json")) ? art("SessionVaultLib") : null }; })();
  const FACTORY_EVIDENCE = JSON.parse(fs.readFileSync(path.join(path.dirname(EVIDENCE), "factory-activation-unsigned-20261023.json"), "utf8"));
  const evidence = JSON.parse(fs.readFileSync(EVIDENCE, "utf8"));

  const port = await freePort();
  const anvil = spawn("anvil", ["--port", String(port), "--silent", "--chain-id", "8453", "--block-time", "1"], { stdio: "ignore" });
  const RPC = `http://127.0.0.1:${port}`;
  // a second JSON-RPC origin (one loopback port is one vote): a plain forwarder to the same chain
  const proxy = http.createServer(async (req, res) => {
    let body = ""; for await (const c of req) body += c;
    try { const r = await fetch(RPC, { method: "POST", headers: { "content-type": "application/json" }, body }); res.writeHead(r.status, { "content-type": "application/json" }); res.end(await r.text()); }
    catch { res.writeHead(502); res.end(); }
  });
  await new Promise((r) => proxy.listen(0, "127.0.0.1", r));
  const RPC2 = `http://127.0.0.1:${proxy.address().port}`;
  const chain = { id: 8453, name: "local-base", nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 }, rpcUrls: { default: { http: [RPC] } } };
  const pub = createPublicClient({ chain, transport: viemHttp(RPC), pollingInterval: 200 });
  try {
    for (let i = 0; i < 100; i++) { try { await pub.getChainId(); break; } catch { await new Promise((r) => setTimeout(r, 100)); } }
    const rpc = (method, params) => pub.request({ method, params });
    const fund = (a) => rpc("anvil_setBalance", [a, "0x" + parseEther("100").toString(16)]);
    const acct = async () => { const a = privateKeyToAccount(generatePrivateKey()); await fund(a.address); return a; };
    const wallet = (a) => createWalletClient({ account: a, chain, transport: viemHttp(RPC) });
    const mined = async (hash) => { const r = await pub.waitForTransactionReceipt({ hash }); if (r.status !== "success") throw Object.assign(new Error("transaction reverted"), { receipt: r }); return r; };
    const send = async (a, to, abi, functionName, args) => mined(await wallet(a).writeContract({ address: to, abi, functionName, args, gas: 15_000_000n }));
    const deploy = async (a, c, args = [], libs = {}) => {
      const bytecode = c.links && Object.keys(c.links).length ? linkBytecode(c.bytecode, c.links, libs) : c.bytecode;
      return getAddress((await mined(await wallet(a).sendTransaction({ data: encodeDeployData({ abi: c.abi, bytecode, args }), gas: 30_000_000n }))).contractAddress);
    };
    const read = (address, abi, functionName, args = []) => pub.readContract({ address, abi, functionName, args });
    // the administrator, impersonated: the book owner and the vault's Enclave wallet, exactly as on Base
    await rpc("anvil_impersonateAccount", [ADMIN]); await fund(ADMIN);
    const admin = ADMIN;
    const adminSend = async (to, data) => mined(await createWalletClient({ account: admin, chain, transport: viemHttp(RPC) }).sendTransaction({ to, data, gas: 3_000_000n }));
    const deployer = await acct();

    // ---- the book at 0xab21…: its runtime, owner (slot 0) = the administrator ----
    const scratchBook = await deploy(deployer, C.book);
    await rpc("anvil_setCode", [BOOK, await rpc("eth_getCode", [scratchBook, "latest"])]);
    await rpc("anvil_setStorageAt", [BOOK, "0x0", "0x" + ADMIN.slice(2).padStart(64, "0")]);
    assert.equal((await read(BOOK, C.book.abi, "owner")).toLowerCase(), ADMIN);
    const ledger = await deploy(deployer, C.ledger), registry = await deploy(deployer, C.registry);
    const ownership = await deploy(deployer, C.ownership, [registry]);
    await adminSend(BOOK, encodeFunctionData({ abi: C.book.abi, functionName: "set", args: [key("deployments"), ledger] }));
    await adminSend(BOOK, encodeFunctionData({ abi: C.book.abi, functionName: "set", args: [key("registry"), registry] }));

    // ---- the ORIGINAL vault, built with the production immutables, at the production address ----
    const scratchVault = await deploy(deployer, C.vault, [BOOK, ADMIN]);
    const runtime = await rpc("eth_getCode", [scratchVault, "latest"]);
    assert.equal(keccak256(runtime), PROD.codeHash, "the rig's original vault with the production immutables is byte-identical to the reviewed production runtime");
    assert.equal((runtime.length - 2) / 2, PROD.runtimeBytes);
    await rpc("anvil_setCode", [VAULT, runtime]);

    // ---- the live committee shape: genesis on an Enclave-paid host with no accepted owner; n = 1, t = 1, W = 1 ----
    const op = await acct(), endpoint = "https://metal0.host.test", registryId = keccak256(toBytes(endpoint));
    await send(op, registry, C.registry.abi, "register", [endpoint, "repo", "0x" + "11".repeat(32), 1n, 0n, ZERO]);
    await adminSend(registry, encodeFunctionData({ abi: C.registry.abi, functionName: "setPayoutWallet", args: [registryId] }));
    const identity = privateKeyToAccount(generatePrivateKey());
    const machine = { identity: identity.address.toLowerCase(), encKey: "0x" + "3f".repeat(32), endpoint: "https://custody-metal0.test",
      chipId: "0x" + randomBytes(32).toString("hex"), registryId, measurement: "0x" + "25".repeat(32) };
    const g = v2.genesis(), salt = "0x" + "03".repeat(32), codeSet = [machine.measurement];
    const cid = D.committeeIdOf({ chainId: 8453, vault: VAULT, salt, Y: g.Y });
    await send(deployer, VAULT, C.vault.abi, "createCommittee", [salt, machine, "0x" + Buffer.from(g.Y).toString("hex"), codeSet,
      await D.signDigest(identity, D.genesisDigest({ chainId: 8453, vault: VAULT, committeeId: cid, Y: g.Y, machine, codeSet })),
      await D.signDigest(op, D.hostDigest({ chainId: 8453, vault: VAULT, machine }))]);

    // ---- deployments: an EOA owner, and a REAL SessionVault (factory.createVault) owned by another EOA ----
    const ownerA = await acct(), ownerB = await acct(), sessionKey = await acct();
    const lib = SV.lib ? await deploy(deployer, SV.lib) : null;
    // the SessionVault's own USDC check after every ownerCall needs a real token (a stand-in ERC-20), never address(0)
    const usdc = await deploy(deployer, SV.usdc);
    const factory = await deploy(deployer, SV.factory, [usdc, BOOK, ZERO, ZERO, 10n ** 9n], lib ? { "contracts/SessionVault.sol:SessionVaultLib": lib } : {});
    const ownerC = await acct();
    await send(deployer, factory, SV.factory.abi, "createVault", [ownerB.address]);
    await send(deployer, factory, SV.factory.abi, "createVault", [ownerC.address]);
    const sv = getAddress(await read(factory, SV.factory.abi, "vaultFor", [ownerB.address]));
    const svC = getAddress(await read(factory, SV.factory.abi, "vaultFor", [ownerC.address]));
    assert.equal(await read(factory, SV.factory.abi, "isVault", [sv]), true);
    const idA = "0x" + randomBytes(32).toString("hex"), idB = "0x" + randomBytes(32).toString("hex"), idC = "0x" + randomBytes(32).toString("hex");
    const until = BigInt(Number((await pub.getBlock()).timestamp) + 7200);
    await send(deployer, ledger, C.ledger.abi, "set", [idA, ownerA.address, "0x" + "00".repeat(32), ZERO, until]);
    await send(deployer, ledger, C.ledger.abi, "set", [idB, sv, "0x" + "00".repeat(32), ZERO, until]);
    await send(deployer, ledger, C.ledger.abi, "set", [idC, svC, "0x" + "00".repeat(32), ZERO, until]);

    // ---- the page: its own module and bundle, the bundle's REAL reader over two origins ----
    const C2 = await import(path.join(REPO, "site/js/core/custody-v2.js"));
    const V = await import(path.join(REPO, "site/vendor/custody-v2.js"));
    // the first-policy committee: this chain's genesis (production uses the live 0x4774… constant)
    const config = { vault: VAULT, book: BOOK, chainId: 8453, rpcs: [RPC, RPC2], independent: { state: "off" }, committee: cid.toLowerCase() };
    C2._setForTests({ lib: V, config, sleep: (ms) => new Promise((r) => setTimeout(r, Math.min(ms, 300))) });
    // the dashboard's signer: the connected wallet sends the page's calldata DIRECTLY (wallet.js sendTx), never via a SessionVault
    const sent = [];
    const signer = (a, from = a) => ({ address: a.address,
      sendTx: async (to, data) => { sent.push({ from: from.address.toLowerCase(), to: to.toLowerCase(), data }); return wallet(from).sendTransaction({ to, data, gas: 3_000_000n }); },
      waitReceipt: mined });
    const code = (p) => p.then(() => null, (e) => e.code || e.message);
    // the vault's custom error, by the selector its own ABI gives (viem reports it as "custom error 0x…")
    const NOT_OWNER = keccak256(toBytes("NotOwner()")).slice(0, 10);
    assert.ok(C.vault.abi.some((x) => x.type === "error" && x.name === "NotOwner" && !x.inputs.length), "the vault declares NotOwner()");
    const vaultErr = (e) => {
      let data = null;
      if (typeof e?.walk === "function") e.walk((x) => { if (typeof x?.data === "string" && /^0x[0-9a-f]{8}/i.test(x.data)) data = x.data; return false; });
      if (data) return decodeErrorResult({ abi: C.vault.abi, data }).errorName;
      return String(e?.message || "").includes("custom error " + NOT_OWNER) ? "NotOwner" : null;
    };
    const none = { none: true };
    const policyOf = (id) => read(VAULT, C.vault.abi, "policyOf", [id]);

    // 1. production today: the book names no secretVaultV2 -> UNSET, no action
    const s0 = await C2.vaultState();
    assert.equal(s0.state, "unset", s0.why);
    assert.equal(await code(C2.saveV2({ id: idA, env: { K: "v" }, signer: signer(ownerA) })), "vault_unset");

    // 2. root's EXACT unsigned activation, sent by the book owner -> VERIFIED on genuine code; a non-owner cannot
    const act = evidence.transaction;
    assert.deepEqual([act.to, act.from, act.chainId], [BOOK, ADMIN, "0x2105"]);
    await assert.rejects(wallet(deployer).sendTransaction({ to: BOOK, data: act.data, gas: 300_000n }).then(mined), /reverted/);
    await adminSend(BOOK, act.data);
    const vs = await C2.vaultState();
    assert.equal(vs.state, "verified", vs.why);
    assert.equal(vs.codeHash, PROD.codeHash);

    // 3. status from the chain: the committee is exactly n = 1, t = 1, W = 1, labelled SINGLE-SEAT
    let st = await C2.statusV2(idA);
    assert.equal(st.policy, null);
    const plan = await C2.planFirstPolicy(idA, PREDICTION);
    assert.deepEqual([plan.committee.n, plan.committee.t, plan.committee.W, plan.committee.kind], [1, 1, 1, "single-seat-bootstrap"]);
    assert.match(plan.committee.label, /^SINGLE-SEAT BOOTSTRAP: n = 1 seat \(the Enclave seat\), t = 1 of W = 1 shares/);

    // 4. an EOA owner: first save through the real vault's update; the stored bundle opens to exactly the env
    const ENV_A = { API_TOKEN: "tok_contract_" + "a".repeat(20) };
    const rA = await C2.saveV2({ id: idA, env: ENV_A, admittedRules: plan.rules, configOverride: none, signer: signer(ownerA) });
    assert.deepEqual([rA.secretRev, rA.policyRev], [1n, 1n]);
    let [pOwner, pRev, sRev, pCid, paused] = await policyOf(idA);
    assert.deepEqual([pOwner.toLowerCase(), pRev, sRev, pCid.toLowerCase(), paused], [ownerA.address.toLowerCase(), 1n, 1n, cid.toLowerCase(), false]);
    const bundleOf = async (id) => new Uint8Array(Buffer.from((await read(VAULT, C.vault.abi, "bundleOf", [id]))[2].slice(2), "hex"));
    const x = g.shares[0].x;
    assert.deepEqual(openBundle({ x, id: idA, secretRev: 1n, committeeId: cid.toLowerCase(), bundle: await bundleOf(idA) }).env, ENV_A);
    assert.equal(sent.at(-1).from, ownerA.address.toLowerCase()); assert.equal(sent.at(-1).to, VAULT);

    // 5. pause, rotate while paused (stays paused), resume - each one real update
    await C2.setPausedV2({ id: idA, paused: true, signer: signer(ownerA) });
    const ENV_A2 = { API_TOKEN: "tok_rotated_" + "b".repeat(20) };
    const rA2 = await C2.saveV2({ id: idA, env: ENV_A2, configOverride: none, signer: signer(ownerA) });
    [, pRev, sRev, , paused] = await policyOf(idA);
    assert.deepEqual([rA2.secretRev, pRev, sRev, paused], [2n, 3n, 2n, true]);
    assert.deepEqual(openBundle({ x, id: idA, secretRev: 2n, committeeId: cid.toLowerCase(), bundle: await bundleOf(idA) }).env, ENV_A2);
    await C2.setPausedV2({ id: idA, paused: false, signer: signer(ownerA) });
    assert.equal((await policyOf(idA))[4], false);

    // 6. wrong authority: the page refuses a session key; the SAME page calldata sent from it is rejected by the vault itself
    assert.equal(await code(C2.saveV2({ id: idA, env: ENV_A, configOverride: none, signer: signer(sessionKey) })), "not_owner");
    const n = sent.length;
    const misSent = await code(C2.saveV2({ id: idA, env: ENV_A, configOverride: none, signer: signer(ownerA, sessionKey) }));
    assert.equal(misSent, "transaction reverted", "a wallet that signs from another key gets a revert, and the page claims nothing");
    assert.equal(sent.length, n + 1);
    await assert.rejects(pub.call({ account: sessionKey.address, to: VAULT, data: sent.at(-1).data }), (e) => vaultErr(e) === "NotOwner");
    [, pRev, sRev] = await policyOf(idA);
    assert.deepEqual([pRev, sRev], [4n, 2n], "nothing changed on chain");

    // 7. SessionVault-held deployments while the book names NO sessionVaultFactory (production at block 52998138): the vault
    //    treats each SessionVault itself as the owner. The page refuses and names the factory gate; nothing is sent.
    assert.equal((await read(VAULT, C.vault.abi, "beneficialOwnerOf", [idB])).toLowerCase(), sv.toLowerCase());
    const before = sent.length;
    const refusedB = await C2.saveV2({ id: idB, env: ENV_A, admittedRules: plan.rules, configOverride: none, signer: signer(ownerB) }).catch((e) => e);
    assert.equal(refusedB.code, "session_vault_not_unwrapped");
    assert.match(refusedB.message, /sessionVaultFactory book entry is required first/);
    assert.equal(sent.length, before);
    const updateFor = (id, rev, extra = {}) => encodeFunctionData({ abi: V.UPDATE_V2_ABI, functionName: "update", args: [id, V.makeUpdateV2({ expectPolicyRev: rev,
      ...extra, bundle: V.buildBundleV2({ chainId: 8453, vault: VAULT, id, secretRev: BigInt(rev) + 1n, committeeId: cid.toLowerCase(), Y: g.Y, env: ENV_A, configText: "" }) })] });
    const firstPolicy = { policy: { committeeId: cid.toLowerCase(), paused: false, rules: plan.rules } };
    //    the wallet's DIRECT update is rejected by the vault (msg.sender is the EOA, the owner is the SessionVault)...
    await assert.rejects(pub.call({ account: ownerB.address, to: VAULT, data: updateFor(idB, 0n, firstPolicy) }), (e) => vaultErr(e) === "NotOwner");
    //    ...while the SAME update through SessionVault.ownerCall IS accepted (msg.sender = the SessionVault): root's 20:02 reading
    //    of the source is right. It PINS the SessionVault as the policy owner - why the dashboard does not offer it:
    const viaOwnerCall = (who, svAddr, data) => wallet(who).sendTransaction({ to: svAddr, data: encodeFunctionData({ abi: SV.vault.abi, functionName: "ownerCall", args: [VAULT, data] }), gas: 3_000_000n });
    await mined(await viaOwnerCall(ownerC, svC, updateFor(idC, 0n, firstPolicy)));
    assert.equal((await policyOf(idC))[0].toLowerCase(), svC.toLowerCase(), "a policy pinned to the SessionVault");
    assert.ok((await bundleOf(idC)).length > 0);

    // 8. the administrator names the factory: root's unsigned activation is exactly book.set("sessionVaultFactory", <factory>); this
    //    chain's factory differs, so the same encoding with this chain's address is sent
    const activation = encodeFunctionData({ abi: C.book.abi, functionName: "set", args: [key("sessionVaultFactory"), FACTORY_EVIDENCE.factory] });
    assert.equal(activation.toLowerCase(), FACTORY_EVIDENCE.transaction.data.toLowerCase(), "root's factory calldata is book.set(sessionVaultFactory, 0x1f5c…)");
    assert.deepEqual([FACTORY_EVIDENCE.transaction.to, FACTORY_EVIDENCE.transaction.from], [BOOK, ADMIN]);
    await adminSend(BOOK, encodeFunctionData({ abi: C.book.abi, functionName: "set", args: [key("sessionVaultFactory"), factory] }));
    //    (a) idB: the vault now unwraps its SessionVault to ownerB, whose DIRECT update (the dashboard's wallet send) is accepted
    assert.equal((await read(VAULT, C.vault.abi, "beneficialOwnerOf", [idB])).toLowerCase(), ownerB.address.toLowerCase());
    st = await C2.statusV2(idB);
    assert.equal(st.beneficialOwner, ownerB.address.toLowerCase());
    assert.equal(st.leaseOwner, sv.toLowerCase(), "the ledger still names the SessionVault");
    const ENV_B = { DB_PASS: "session-held-" + "c".repeat(16) };
    const rB = await C2.saveV2({ id: idB, env: ENV_B, admittedRules: plan.rules, configOverride: none, signer: signer(ownerB) });
    assert.equal(rB.secretRev, 1n);
    assert.equal((await policyOf(idB))[0].toLowerCase(), ownerB.address.toLowerCase(), "the policy owner is the beneficial EOA");
    assert.equal(sent.at(-1).from, ownerB.address.toLowerCase());
    assert.deepEqual(openBundle({ x, id: idB, secretRev: 1n, committeeId: cid.toLowerCase(), bundle: await bundleOf(idB) }).env, ENV_B);
    //        with the factory set, the ownerCall route now FAILS (msg.sender = the SessionVault, not the beneficial owner),
    //        and a session key is refused by the page and by the vault
    const updB2 = updateFor(idB, 1n);
    await assert.rejects(viaOwnerCall(ownerB, sv, updB2).then(mined), /reverted/);
    await assert.rejects(pub.call({ account: sv, to: VAULT, data: updB2 }), (e) => vaultErr(e) === "NotOwner");
    await assert.rejects(pub.call({ account: sessionKey.address, to: VAULT, data: updB2 }), (e) => vaultErr(e) === "NotOwner");
    assert.equal(await code(C2.saveV2({ id: idB, env: ENV_B, configOverride: none, signer: signer(sessionKey) })), "not_owner");
    await mined(await wallet(ownerB).sendTransaction({ to: VAULT, data: updB2, gas: 3_000_000n }));   // the direct route works
    //    (b) idC, pinned to its SessionVault in step 7, is now STRANDED: neither the wallet nor the SessionVault may update it,
    //        the page says so, and the only way on is claimPolicy - which destroys its bundle and pauses it
    assert.equal((await read(VAULT, C.vault.abi, "beneficialOwnerOf", [idC])).toLowerCase(), ownerC.address.toLowerCase());
    await assert.rejects(pub.call({ account: ownerC.address, to: VAULT, data: updateFor(idC, 1n) }), (e) => vaultErr(e) === "NotOwner");
    await assert.rejects(pub.call({ account: svC, to: VAULT, data: updateFor(idC, 1n) }), (e) => vaultErr(e) === "NotOwner");
    assert.equal(await code(C2.saveV2({ id: idC, env: ENV_A, configOverride: none, signer: signer(ownerC) })), "owner_moved");
    await send(ownerC, VAULT, C.vault.abi, "claimPolicy", [idC]);
    const claimed = await policyOf(idC);
    assert.deepEqual([claimed[0].toLowerCase(), claimed[4]], [ownerC.address.toLowerCase(), true]);
    assert.equal((await bundleOf(idC)).length, 0, "claimPolicy destroyed the bundle written through ownerCall");

    // 9. root's EXACT rollback: the book stops naming the vault; the page stops at once (no cached verdict)
    await adminSend(BOOK, evidence.rollback.data);
    assert.equal((await C2.vaultState()).state, "unset");
    assert.equal(await code(C2.setPausedV2({ id: idA, paused: true, signer: signer(ownerA) })), "vault_unset");
    assert.equal((await policyOf(idA))[4], false, "the rollback removes discovery only; the stored policy is unchanged");
  } finally {
    anvil.kill("SIGKILL");
    proxy.close();
  }
});

test("the Secrets panel's v2 signer is the connected wallet's DIRECT send (wallet.js sendTx), never the SessionVault-routed ledger send", () => {
  const src = fs.readFileSync(path.join(REPO, "site/components/deployments/deployments.js"), "utf8");
  assert.match(src, /import \{[^}]*\bsendTx as walletSendTx\b[^}]*\} from "\.\.\/\.\.\/js\/core\/wallet\.js";/);
  const signer = /const c2signer = async \(\) => \{([\s\S]*?)\n    \};/.exec(src);
  assert.ok(signer, "c2signer present");
  assert.match(signer[1], /sendTx: \(to, data\) => walletSendTx\(to, data\)/);
  assert.doesNotMatch(signer[1], /ledgerSend|sessionCall|ownerCall|sendTx\(DEPLOYMENTS/);
  const w = fs.readFileSync(path.join(REPO, "site/js/core/wallet.js"), "utf8");
  const body = /export async function sendTx\(to, data, value, gasLimit\)\{([\s\S]*?)\n\}/.exec(w)[1];
  assert.match(body, /const tx = \{ from: Enclave\.address, data, value: value \|\| "0x0" \};/, "from the connected wallet itself");
  assert.doesNotMatch(body, /ledgerSend|ownerCall|SessionVault/);
});
