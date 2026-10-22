// OWNER-AUTHORIZED CUSTODY REWRAP on a REAL chain (anvil) with the ORIGINAL vault source (contracts/EnclaveSecretVaultV2.sol,
// the deployed 0xE486… runtime), the real AddressBook, schema-4 registry and EnclaveHostOwnership (test/helpers/original-vault-rig.mjs).
//   OLD committee: the EXACT running custodian code - custodian, member, chain reader and verifier from
//                  test/fixtures/custodian-9d43e63 (the closure that rebuilds the running bundle 7c2cd000… byte for byte) -
//                  founded like the live one (Enclave-paid host, no accepted owner, t = 1), served over HTTP with the
//                  original daemon's routes.
//   NEW committee: the current custodian (with the platform host gate), founded on an Enclave-owned host, its own code set.
//   REWRAP GUEST : custody/v2/rewrap-guest.mjs main() - the measured entry itself - with the real chain reader, the real host
//                  API (custody/v2/rewrap-host.mjs) over HTTP, and a SYNTHETIC SEV-SNP report. The attestation is a test
//                  fixture (synthetic AMD chain): it proves the release path and every check around it, NOT that any
//                  production TEE ran this code.
// Owners: an EOA, a SessionVault-held deployment (the book's factory; the vault answers to the SessionVault's owner) and an
// ERC-1271 contract wallet (updateBySig; the rewrap authorization verified by isValidSignature at the agreed block).
//   run: node --test test/custody-owner-rewrap.test.mjs     (queue: 768 MiB, anvil + node)
import test from "node:test";
import assert from "node:assert/strict";
import net from "node:net";
import http from "node:http";
import { spawn, spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { createPublicClient, createWalletClient, http as viemHttp, keccak256, toBytes, parseEther, stringToHex, decodeEventLog } from "viem";
import { privateKeyToAccount, generatePrivateKey } from "viem/accounts";
import { foundry } from "viem/chains";
import { snpAttester, RUNTIME, MEASUREMENT, FLOOR } from "./helpers/custody-rig.mjs";
import { originalVaultRig } from "./helpers/original-vault-rig.mjs";
import { synthChain } from "./helpers/snp-synth.mjs";
import { walletContract, custodianFront, syntheticReport } from "./helpers/rewrap-rig.mjs";
// ---- the OLD (running) custodian code ----
import * as OLDV2 from "./fixtures/custodian-9d43e63/custody/v2/protocol.mjs";
import * as OLDD from "./fixtures/custodian-9d43e63/custody/v2/digests.mjs";
import { createChainReaderV2 as oldReader } from "./fixtures/custodian-9d43e63/custody/v2/chain.mjs";
import { createMember as oldMember } from "./fixtures/custodian-9d43e63/custody/v2/member.mjs";
import { createCustodianV2 as oldCustodian, Refusal as OldRefusal } from "./fixtures/custodian-9d43e63/custody/v2/custodian.mjs";
import { snpVerifier as oldSnpVerifier, SNP_GUEST_FORMAT as OLD_FORMAT } from "./fixtures/custodian-9d43e63/custody/verifiers.mjs";
import { memoryCollateral as oldMemoryCollateral } from "./fixtures/custodian-9d43e63/verifier/collateral.mjs";
// ---- the current (corrected) code ----
import { memoryCollateral } from "../verifier/index.mjs";
import { snpVerifier, SNP_GUEST_FORMAT } from "../custody/verifiers.mjs";
import * as hpke from "../custody/hpke.mjs";
import * as v2 from "../custody/v2/protocol.mjs";
import * as D from "../custody/v2/digests.mjs";
import { createChainReaderV2, VAULT_V2_ABI } from "../custody/v2/chain.mjs";
import { createCustodianV2, Refusal } from "../custody/v2/custodian.mjs";
import { createMember } from "../custody/v2/member.mjs";
import { buildBundleV2, makeUpdateV2, UPDATE_V2_ABI, updateTypedDataV2 } from "../custody/v2/owner.mjs";
import { canonicalRules } from "../custody/rules.mjs";
import { runtimeId } from "../isolation/contract/runtime.mjs";
import { createPlatformHostGate, policyTypedData, policyDigest, anchorTransaction, POLICY_FORMAT } from "../network/platform-host-policy.mjs";
import { planRewrap, checkResultAndSwitch, rewrapTypedData, rewrapDigest, ownerUpdateRequests, REWRAP_RUNTIME_ID } from "../custody/v2/rewrap.mjs";
import { main as rewrapGuest, REWRAP_ROLE } from "../custody/v2/rewrap-guest.mjs";
import { rewrapHostApi } from "../custody/v2/rewrap-host.mjs";

const anvilAvailable = () => spawnSync("anvil", ["--version"], { stdio: "ignore" }).status === 0;
const freePort = () => new Promise((resolve) => { const s = net.createServer(); s.listen(0, "127.0.0.1", () => { const p = s.address().port; s.close(() => resolve(p)); }); });
async function startAnvil(chainId) {
  const port = await freePort();
  const p = spawn("anvil", ["--port", String(port), "--silent", "--chain-id", String(chainId), "--block-time", "1"], { stdio: "ignore" });
  const url = `http://127.0.0.1:${port}`, chain = { ...foundry, id: chainId };
  const client = createPublicClient({ chain, transport: viemHttp(url), pollingInterval: 250 });
  for (let i = 0; i < 100; i++) { try { await client.getChainId(); return { url, client, chain, stop: () => p.kill("SIGTERM") }; } catch { await new Promise((r) => setTimeout(r, 100)); } }
  p.kill("SIGKILL"); throw new Error("anvil did not start");
}
const sha = (b) => "0x" + createHash("sha256").update(b).digest("hex");
const key = (s) => stringToHex(s, { size: 32 });
const ZERO = "0x" + "00".repeat(20);
const APP = Buffer.alloc(32, 0xa7);
const RULES = { v: 1, appId: APP.toString("hex"), images: [{ platform: "sev-snp", measurement: MEASUREMENT, runtimeId: runtimeId(RUNTIME).toString("hex") }], minTcb: FLOOR, vmpl: 0 };
const OLD_MEAS = Buffer.alloc(48, 0x25), NEW_MEAS = Buffer.alloc(48, 0x9e);          // custodian launch measurements (fixtures)
const REWRAP_MEAS = "5e".repeat(48);                                                  // the rewrap image's (fixture; the real build's is in the report)
const CONFIG = "port = 8080\nmode = production\n";

test("owner-authorized rewrap: ORIGINAL vault + RUNNING custodian code -> corrected committee; refusals, interruption, switch, rollback; no plaintext out",
  { skip: anvilAvailable() ? false : "anvil not installed", timeout: 900_000 }, async (t) => {
  const C = originalVaultRig(), W1271 = walletContract();             // compiled in child processes before anvil starts
  const chainId = 31337, anvil = await startAnvil(chainId);
  const closers = [];
  t.after(async () => { for (const c of closers.reverse()) await c(); anvil.stop(); });
  const pub = anvil.client;
  const fund = (a) => pub.request({ method: "anvil_setBalance", params: [a, "0x" + parseEther("100").toString(16)] });
  const acct = async () => { const a = privateKeyToAccount(generatePrivateKey()); await fund(a.address); return a; };
  const wallet = (a) => createWalletClient({ account: a, chain: anvil.chain, transport: viemHttp(anvil.url) });
  const send = async (a, address, abi, functionName, args) => {
    const r = await pub.waitForTransactionReceipt({ hash: await wallet(a).writeContract({ address, abi, functionName, args, gas: 15_000_000n }) });
    if (r.status !== "success") throw new Error(`${functionName} reverted`);
    return r;
  };
  const reverts = (a, address, abi, functionName, args, re) => assert.rejects(pub.simulateContract({ account: a, address, abi, functionName, args }), re);
  const deploy = async (a, c, args = []) => (await pub.waitForTransactionReceipt({ hash: await wallet(a).deployContract({ abi: c.abi, bytecode: c.bytecode, args }) })).contractAddress;
  const read = (address, abi, functionName, args = []) => pub.readContract({ address, abi, functionName, args });

  // ---- the admin's contracts, as on Base ----
  const admin = await acct(), enclaveWallet = await acct(), enclaveOwner = enclaveWallet.address.toLowerCase();
  const book = await deploy(admin, C.book), ledger = await deploy(admin, C.ledger), registry = await deploy(admin, C.registry);
  await send(admin, book, C.book.abi, "set", [key("deployments"), ledger]);
  await send(admin, book, C.book.abi, "set", [key("registry"), registry]);
  const ownership = await deploy(admin, C.ownership, [registry]);
  const vault = (await deploy(admin, C.vault, [book, enclaveWallet.address])).toLowerCase();
  const hosts = {};
  const host = async (name, { payoutEnclave = false, owner = null } = {}) => {
    const op = await acct(), endpoint = `https://${name}.host.test`, registryId = keccak256(toBytes(endpoint));
    await send(op, registry, C.registry.abi, "register", [endpoint, "repo", "0x" + "11".repeat(32), 1n, 0n, ZERO]);
    if (payoutEnclave) await send(enclaveWallet, registry, C.registry.abi, "setPayoutWallet", [registryId]);
    if (owner) { await send(op, ownership, C.ownership.abi, "proposeOwner", [registryId, owner.address]); await send(owner, ownership, C.ownership.abi, "acceptOwner", [registryId]); }
    return (hosts[name] = { op, endpoint, registryId, owner });
  };
  await host("metal0", { payoutEnclave: true });                       // the live seat's shape: Enclave-paid, NO accepted owner
  await host("ea", { payoutEnclave: true, owner: enclaveWallet });     // an enrolled Enclave host for the corrected committee
  await host("eb", { payoutEnclave: true, owner: enclaveWallet });     // another Enclave host (a third committee: a wrong-key target)
  await host("app", { owner: await acct() });                          // the deployments' lease host

  // ---- verifiers on the synthetic AMD chain: the OLD verifier code for the old committee, the current for the new ----
  const S = synthChain();
  const oldVerifiers = Object.freeze({ [OLD_FORMAT]: oldSnpVerifier({ collateral: oldMemoryCollateral({ chains: { Genoa: S.chainPem }, vceks: { Genoa: S.vcekDer }, crls: { Genoa: S.crlDer } }), roots: new Map([["Genoa", S.arkFp]]) }) });
  const newVerifiers = Object.freeze({ [SNP_GUEST_FORMAT]: snpVerifier({ collateral: memoryCollateral({ chains: { Genoa: S.chainPem }, vceks: { Genoa: S.vcekDer }, crls: { Genoa: S.crlDer } }), roots: new Map([["Genoa", S.arkFp]]) }) });
  const submitter = await acct();
  const submit = async (fn, args) => (await send(submitter, vault, VAULT_V2_ABI, fn, args)).transactionHash;
  const readerOpts = { rpcs: [anvil.url], vault, minAgree: 1, vaultKind: "book", book, hostOwnership: ownership, hostPolicy: { book, hostOwnership: ownership }, maxAgeSec: 3600 };
  const reader = createChainReaderV2(readerOpts);

  // ---- committees: genesis exactly as the contract requires (Enclave-paid host, its operator's binding, identity signature) ----
  const machines = {};                                                // endpoint -> HTTP front
  const logs = [];                                                    // EVERY log line any custodian, guest or host emits
  const capture = (who) => (...a) => logs.push(`${who}: ${a.join(" ")}`);
  const found = async (name, h, measurement, { old }) => {
    const P = old ? OLDV2 : v2, Dg = old ? OLDD : D;
    const identity = privateKeyToAccount(generatePrivateKey()), kp = hpke.generateKeyPair(), chip = randomBytes(64);
    const machine = { identity: identity.address.toLowerCase(), encKey: "0x" + Buffer.from(kp.publicKey).toString("hex"), endpoint: `https://custody-${name}.test`,
                      chipId: sha(chip), registryId: h.registryId, measurement: sha(measurement) };
    const g = P.genesis(), salt = "0x" + randomBytes(32).toString("hex"), codeSet = [machine.measurement];
    const cid = Dg.committeeIdOf({ chainId, vault, salt, Y: g.Y });
    const hostSig = await Dg.signDigest(h.op, Dg.hostDigest({ chainId, vault, machine }));
    await submit("createCommittee", [salt, machine, "0x" + Buffer.from(g.Y).toString("hex"), codeSet,
      await Dg.signDigest(identity, Dg.genesisDigest({ chainId, vault, committeeId: cid, Y: g.Y, machine, codeSet })), hostSig]);
    let st = { epochs: { [`${cid.toLowerCase()}:1`]: g.shares.map((s) => ({ k: s.k, x: s.x.toString(16).padStart(64, "0") })) }, pending: {}, hostSig, candidates: {} };
    const store = { load: () => st, save: (s) => { st = JSON.parse(JSON.stringify(s)); } };
    const noPeer = async () => ({ ok: false, reason: "no peers in this rig" });
    let custodian;
    if (old) {
      const chain = oldReader({ rpcs: [anvil.url], vault, minAgree: 1 });
      const member = oldMember({ chainId, vault, identity, encPrivateKey: kp.privateKey, machine, chain, store, submit, fetchJson: async () => { throw new Error("offline"); },
        attestSelf: async () => ({ report: Buffer.alloc(0) }), verifyPeerQuote: noPeer, enclaveOwner, log: () => {} });
      custodian = oldCustodian({ chainId, vault, encPrivateKey: kp.privateKey, shares: member.shares, chain, verifiers: oldVerifiers, log: capture(`old-custodian ${name}`) });
    } else {
      const chain = createChainReaderV2(readerOpts);
      const member = createMember({ chainId, vault, identity, encPrivateKey: kp.privateKey, machine, chain, store, submit, fetchJson: async () => { throw new Error("offline"); },
        now: () => Date.now(), log: () => {}, enclaveOwner, attestSelf: async () => ({ report: Buffer.alloc(0) }), verifyPeerQuote: noPeer,
        capacityCheck: async () => ({ ok: false, reason: "none" }), hostGate: newGate });
      custodian = createCustodianV2({ chainId, vault, encPrivateKey: kp.privateKey, shares: member.shares, chain, verifiers: newVerifiers, log: capture(`new-custodian ${name}`), hostGate: newGate });
    }
    const front = await custodianFront(custodian, { Refusal: old ? OldRefusal : Refusal });
    closers.push(front.close);
    machines[machine.endpoint] = front.url;
    return { cid: cid.toLowerCase(), machine, Y: "0x" + Buffer.from(g.Y).toString("hex") };
  };
  // the platform host policy (admin-signed, anchored by the exact setMany) and the gates that read it
  const signedPolicies = new Map();
  const mirror = async (digest) => (signedPolicies.has(digest) ? [signedPolicies.get(digest)] : []);
  const newGate = createPlatformHostGate({ book, hostOwnership: ownership, snapshot: reader.snapshot, mirrors: [mirror] });
  const guestReader = createChainReaderV2({ ...readerOpts, chainId });
  const guestGate = () => createPlatformHostGate({ book, hostOwnership: ownership, snapshot: guestReader.snapshot, mirrors: [mirror] });
  let policySeq = 0;
  const publishPolicy = async (deny) => {
    const tt = Math.floor(Date.now() / 1000);
    const p = { format: POLICY_FORMAT, chainId: 8453, book: book.toLowerCase(), registry: registry.toLowerCase(), hostOwnership: ownership.toLowerCase(), sequence: ++policySeq,
                issuedAt: tt - 60, expiresAt: 0, maxStaleSec: 0, previousDigest: "0x" + "00".repeat(32), mode: "denylist", deny, admit: [] };
    const d = policyDigest(p);
    signedPolicies.set(d, { document: JSON.stringify(p), signature: await admin.signTypedData(policyTypedData(p)) });
    const r = await pub.waitForTransactionReceipt({ hash: await wallet(admin).sendTransaction({ to: book, data: anchorTransaction(book, d).data }) });
    assert.equal(r.status, "success");
    await newGate.refresh();
  };
  const banApp = { kind: "operator", value: hosts.app.op.address.toLowerCase(), reason: "malicious app host" };

  const OLDC = await found("metal0", hosts.metal0, OLD_MEAS, { old: true });  // the live committee's shape
  const NEWC = await found("ea", hosts.ea, NEW_MEAS, { old: false });         // the corrected committee
  const OTHER = await found("eb", hosts.eb, NEW_MEAS, { old: false });        // a third committee (an attacker's would look the same)
  const route = async (url, body) => {
    const base = Object.keys(machines).find((e) => url.startsWith(e + "/"));
    if (!base) throw new Error(`unreachable ${url}`);
    const r = await fetch(machines[base] + url.slice(base.length), { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body ?? {}) });
    const j = await r.json();
    if (!r.ok) throw Object.assign(new Error(`${j.error}: ${j.message}`), { code: j.error });
    return j;
  };

  // ---- an attested APP guest's release (unchanged protocol) from whichever committee the policy names ----
  const unlock = async (id) => {
    const st = await reader.readRelease({ id, endpoint: hosts.app.endpoint }), com = st.committee;
    const att = snpAttester(S, { appId: APP, hostData: Buffer.from(id.slice(2), "hex") }), recipient = hpke.generateKeyPair();
    const ch = [];
    for (const m of com.machines) ch.push({ m, ...(await route(`${m.endpoint}/v2/custody/challenge`, {})) });
    const challenges = ch.map((c) => ({ encKey: Buffer.from(c.encKey, "hex"), nonce: Buffer.from(c.nonce, "hex") }));
    const binding = v2.releaseBinding({ chainId, vault, id, policyRev: st.policy.policyRev, secretRev: st.policy.secretRev, committeeId: com.committeeId, epoch: com.epoch,
      challenges, runtimeId: new Uint8Array(runtimeId(RUNTIME)), transportSpki: att.transportSpki, recipientKey: recipient.publicKey });
    const expiry = Math.floor(Date.now() / 1000) + 300;
    const sig = await hosts.app.op.signMessage({ message: v2.operatorMessage({ chainId, vault, id, endpoint: hosts.app.endpoint, binding, expiry }) });
    const evidence = await att.evidence(binding);
    const commitments = []; for (let i = 0; i < com.commitments.length; i += 33) commitments.push(com.commitments.subarray(i, i + 33));
    const R = v2.parseBundle(st.bundle.data).R, parts = [];
    for (const c of ch) {
      const r = await route(`${c.m.endpoint}/v2/custody/release`, { v: 2, id, endpoint: hosts.app.endpoint, committeeId: com.committeeId, epoch: com.epoch,
        policyRev: String(st.policy.policyRev), secretRev: String(st.policy.secretRev), recipientKey: Buffer.from(recipient.publicKey).toString("hex"),
        challenges: ch.map((x) => ({ encKey: x.encKey, nonce: x.nonce })), operator: { sig, expiry }, evidence });
      for (const record of v2.openPartials({ recipientPrivate: recipient.privateKey, binding, encKey: Buffer.from(r.encKey, "hex"), count: r.count, sealed: Buffer.from(r.sealed, "base64") }))
        parts.push(v2.verifyPartial({ record, R, binding, commitments }));
    }
    return v2.decryptBundle({ S: v2.combine(parts.slice(0, com.t), com.t), label: v2.labelOf({ chainId, vault, id, secretRev: st.policy.secretRev, committeeId: com.committeeId }), bundle: st.bundle.data });
  };

  // ---- owners and their deployments (lease on the app host) ----
  const leaseUntil = async () => BigInt(Number((await pub.getBlock()).timestamp) + 7200);
  const deployment = async (ledgerOwner) => { const id = "0x" + randomBytes(32).toString("hex"); await send(admin, ledger, C.ledger.abi, "set", [id, ledgerOwner, hosts.app.registryId, hosts.app.op.address, await leaseUntil()]); return id; };
  const policyOf = async (id) => { const [owner, policyRev, secretRev, committeeId, paused, rules] = await read(vault, VAULT_V2_ABI, "policyOf", [id]); return { id, owner: owner.toLowerCase(), policyRev, secretRev, committeeId: committeeId.toLowerCase(), paused, rules: rules.toLowerCase() }; };
  const bundleOf = async (id) => { const [committeeId, secretRev, data] = await read(vault, VAULT_V2_ABI, "bundleOf", [id]); return { committeeId: committeeId.toLowerCase(), secretRev, data: data.toLowerCase() }; };
  // an owner signer: { address (the vault's view of the owner), apply(id, update), signTyped(td) }
  const eoaOwner = (a) => ({ address: a.address.toLowerCase(), apply: (id, u) => send(a, vault, UPDATE_V2_ABI, "update", [id, u]), signTyped: (td) => a.signTypedData(td) });
  const walletOwner = (w, key) => ({ address: w.toLowerCase(), signTyped: (td) => key.signTypedData(td),
    apply: async (id, u) => {                                          // the gasless path: the wallet's ERC-1271 answer authorizes
      const deadline = BigInt(Number((await pub.getBlock()).timestamp) + 600);
      const sig = await key.signTypedData(updateTypedDataV2({ chainId, vault, id, update: u, deadline }));
      return send(submitter, vault, UPDATE_V2_ABI, "updateBySig", [id, u, deadline, sig]);
    } });
  const publish = async (owner, id, env, cid, Y) => {
    const p = await policyOf(id);
    const bundle = buildBundleV2({ chainId, vault, id, secretRev: p.secretRev + 1n, committeeId: cid, Y: Buffer.from(Y.slice(2), "hex"), env, configText: CONFIG });
    await owner.apply(id, makeUpdateV2({ expectPolicyRev: p.policyRev, policy: { committeeId: cid, paused: false, rules: RULES }, bundle }));
  };

  // ---- the rewrap guest, through its measured entry and the host's API over HTTP ----
  const measured = { role: REWRAP_ROLE, chainId, vault, book, rpcs: [anvil.url], minAgree: 1, maxAgeSec: 3600 };
  const posted = [];
  const runGuest = async ({ authorization, signature, measurement = REWRAP_MEAS, hostData, gate = guestGate(), operator = hosts.app.op }) => {
    const api = rewrapHostApi({ chainId, vault, id: authorization.id, endpoint: authorization.leaseEndpoint, operator, onResult: async (b) => { posted.push(b); } });
    const srv = http.createServer(api); await new Promise((r) => srv.listen(0, "127.0.0.1", r));
    try {
      const result = await rewrapGuest({ cfg: { hostUrl: `http://127.0.0.1:${srv.address().port}`, authorization, signature }, measured,
        io: { chain: guestReader, hostGate: gate, report: syntheticReport(S, { measurement, hostData: hostData || authorization.id.slice(2) }), fetchJson: route, log: capture("guest") } });
      return { result };
    } catch (e) { return { error: e.code || e.message }; } finally { srv.closeAllConnections?.(); await new Promise((r) => srv.close(r)); }
  };
  const expiryIn = async (s) => BigInt(Number((await pub.getBlock()).timestamp) + s).toString();
  const plan = async (id, dest = NEWC, { expiry } = {}) => planRewrap({ policy: await policyOf(id), bundle: await bundleOf(id), dest: { committeeId: dest.cid, Y: dest.Y },
    destCodeMeasurement: sha(NEW_MEAS), leaseEndpoint: hosts.app.endpoint, rewrapMeasurement: REWRAP_MEAS, expiry: expiry ?? await expiryIn(3600) });
  const sign = (owner, authorization, cId = chainId) => owner.signTyped(rewrapTypedData({ chainId: cId, vault, authorization }));
  const unchanged = async (id, before, what) => assert.deepEqual([await policyOf(id), await bundleOf(id)], before, `${what}: nothing on chain changed`);

  // ======================================================================== A. an EOA owner, edge-case payload
  const ownerA = await acct(), A = eoaOwner(ownerA), stranger = await acct();
  const ENV_A = { API_KEY: "sk-live-" + randomBytes(24).toString("hex"), UNICODE: "pässwörd-秘密-🔑-" + randomBytes(6).toString("hex"),
    JSON_LIKE: '{"a":"b\\"c"}\t\\x\'' + randomBytes(4).toString("hex"), B64_BINARY: randomBytes(600).toString("base64"), EMPTY: "",
    MAX_VALUE: randomBytes(2048).toString("hex"), SPACES: "  leading and trailing  " + randomBytes(4).toString("hex") };
  const idA = await deployment(ownerA.address);
  await publish(A, idA, ENV_A, OLDC.cid, OLDC.Y);
  assert.deepEqual((await unlock(idA)).env, ENV_A, "baseline: the OLD committee (running code) releases the app's secrets");
  const original = await policyOf(idA);

  // the guest refuses BEFORE the owner admits its image, and nothing changes
  let pl = await plan(idA);
  let before = [await policyOf(idA), await bundleOf(idA)];
  assert.equal((await runGuest({ authorization: { ...pl.authorization, sourcePolicyRev: String(original.policyRev) }, signature: await sign(A, { ...pl.authorization, sourcePolicyRev: String(original.policyRev) }) })).error,
    "not_admitted", "the rules do not admit the rewrap image yet");
  await unchanged(idA, before, "not admitted");

  // 1. the owner's explicit admission: the rewrap image is ADDED (appId, app image, committee, bundle untouched)
  await A.apply(idA, pl.admit);
  const admitted = await policyOf(idA);
  assert.equal(admitted.policyRev, original.policyRev + 1n);
  assert.deepEqual([admitted.committeeId, admitted.secretRev, (await bundleOf(idA)).data], [original.committeeId, original.secretRev, (await bundleOf(idA)).data]);
  assert.deepEqual((await unlock(idA)).env, ENV_A, "the OLD custodian code still parses the rules and releases to the app");
  const authA = pl.authorization, sigA = await sign(A, authA);
  before = [await policyOf(idA), await bundleOf(idA)];

  // 2. every substitution or stale input is refused by the guest; nothing changes on chain
  const refusals = [
    ["a host swaps in another destination under the owner's signature", { authorization: { ...authA, destCommitteeId: OTHER.cid, destKeyHash: keccak256(OTHER.Y) }, signature: sigA }, "bad_signature"],
    ["a stranger signs", { authorization: authA, signature: await sign(eoaOwner(stranger), authA) }, "bad_signature"],
    ["the owner pinned another key than the destination's", { authorization: { ...authA, destKeyHash: keccak256(OTHER.Y) }, signature: await sign(A, { ...authA, destKeyHash: keccak256(OTHER.Y) }) }, "destination_key"],
    ["signed for another chain", { authorization: authA, signature: await sign(A, authA, 8453) }, "bad_signature"],
    ["a stale policy revision", { authorization: { ...authA, sourcePolicyRev: String(original.policyRev) }, signature: await sign(A, { ...authA, sourcePolicyRev: String(original.policyRev) }) }, "stale_revision"],
    ["another bundle than the stored one", { authorization: { ...authA, sourceBundleHash: keccak256("0x1234") }, signature: await sign(A, { ...authA, sourceBundleHash: keccak256("0x1234") }) }, "bundle_mismatch"],
    ["a destination running other code", { authorization: { ...authA, destCodeMeasurement: sha(OLD_MEAS) }, signature: await sign(A, { ...authA, destCodeMeasurement: sha(OLD_MEAS) }) }, "destination_code"],
    ["the source committee as destination", { authorization: { ...authA, destCommitteeId: OLDC.cid, destKeyHash: keccak256(OLDC.Y) }, signature: sigA }, "bad_authorization"],
    ["an expired authorization", { authorization: { ...authA, expiry: await expiryIn(-5) }, signature: await sign(A, { ...authA, expiry: await expiryIn(-5) }) }, "expired"],
    ["a guest launched for another deployment (HOST_DATA)", { authorization: authA, signature: sigA, hostData: randomBytes(32).toString("hex") }, "wrong_deployment"],
    ["another image than the authorized", { authorization: authA, signature: sigA, measurement: "6f".repeat(48) }, "wrong_image"],
    ["a lease host whose operator would not sign", { authorization: authA, signature: sigA, operator: stranger }, "release_refused"],
  ];
  for (const [what, run, code] of refusals) {
    assert.equal((await runGuest(run)).error, code, what);
    await unchanged(idA, before, what);
  }
  assert.ok(!posted.some((p) => p.result), "no refused run produced a result");
  assert.ok(posted.filter((p) => p.error).length >= refusals.length - 1, "refusals reach the host as codes");

  // 3. the admin bans the lease host: the guest refuses to run there (the old image cannot enforce it); unban proceeds
  await publishPolicy([]);                                             // the admin activates an (empty) policy first
  await publishPolicy([banApp]);
  assert.equal((await runGuest({ authorization: authA, signature: sigA })).error, "host_refused", "a banned lease host gets no rewrap");
  await unchanged(idA, before, "banned host");
  await publishPolicy([]);

  // 4. an INTERRUPTED run (the result is lost on the way back): nothing changed; a second run gives another valid result
  const lost = await runGuest({ authorization: authA, signature: sigA });
  assert.ok(lost.result, `the run succeeds (${lost.error})`);
  await unchanged(idA, before, "a lost result");
  assert.deepEqual((await unlock(idA)).env, ENV_A, "the old policy keeps working until the explicit switch");
  const run2 = await runGuest({ authorization: authA, signature: sigA });
  assert.ok(run2.result && run2.result.bundle !== lost.result.bundle, "a retry re-encrypts (fresh randomness), same destination and revision");
  assert.deepEqual([run2.result.destination, run2.result.authorizationDigest], [lost.result.destination, lost.result.authorizationDigest]);

  // 5. the owner checks the result and signs ONE switch; a mismatched result or revision never commits
  const otherExpiry = await expiryIn(99);
  assert.throws(() => checkResultAndSwitch({ chainId, vault, authorization: { ...authA, expiry: otherExpiry }, result: run2.result, originalRules: pl.originalRules }), /another authorization/);
  const { switchUpdate } = checkResultAndSwitch({ chainId, vault, authorization: authA, result: run2.result, originalRules: pl.originalRules });
  const reqs = ownerUpdateRequests({ chainId, vault, id: idA, update: switchUpdate, deadline: 1n });
  assert.equal(reqs.update.to, vault);
  await A.apply(idA, switchUpdate);
  const switched = await policyOf(idA);
  assert.deepEqual([switched.committeeId, switched.secretRev, switched.policyRev, switched.rules], [NEWC.cid, original.secretRev + 1n, original.policyRev + 2n, original.rules],
    "the switch: destination committee, secretRev + 1, the ORIGINAL rules restored byte for byte");
  await reverts(ownerA, vault, UPDATE_V2_ABI, "update", [idA, switchUpdate], /StaleRevision|revert/i);   // a replayed switch
  const { switchUpdate: lostSwitch } = checkResultAndSwitch({ chainId, vault, authorization: authA, result: lost.result, originalRules: pl.originalRules });
  await reverts(ownerA, vault, UPDATE_V2_ABI, "update", [idA, lostSwitch], /StaleRevision|revert/i);      // the lost result, later
  const out = await unlock(idA);
  assert.deepEqual(out.env, ENV_A, "the NEW committee releases exactly the same payload");
  assert.equal(out.configSha256, createHash("sha256").update(CONFIG).digest("hex"), "and the same config commitment");
  {                                                                     // the OLD committee no longer releases this deployment
    const c = await route(`${OLDC.machine.endpoint}/v2/custody/challenge`, {});
    await assert.rejects(route(`${OLDC.machine.endpoint}/v2/custody/release`, { v: 2, id: idA, endpoint: hosts.app.endpoint, committeeId: OLDC.cid, epoch: 1,
      policyRev: String(switched.policyRev), secretRev: String(switched.secretRev), recipientKey: "11".repeat(32), challenges: [{ encKey: c.encKey, nonce: c.nonce }],
      operator: { sig: "0x", expiry: Math.floor(Date.now() / 1000) + 60 }, evidence: { format: OLD_FORMAT } }), /wrong_committee/);
  }
  assert.equal((await runGuest({ authorization: authA, signature: sigA })).error, "stale_revision", "the used authorization can never run again");

  // 6. the corrected runtime enforces the admin's ban; the old ciphertext opens nowhere under the new committee
  await publishPolicy([banApp]);
  await assert.rejects(unlock(idA), /host_refused/, "a blocked host is denied by the new runtime");
  await publishPolicy([]);
  assert.deepEqual((await unlock(idA)).env, ENV_A);

  // ======================================================================== B. a SessionVault-held deployment: rollback before the switch, then migration and back
  const sessionFactory = await deploy(admin, C.sessionFactory);
  await send(admin, book, C.book.abi, "set", [key("sessionVaultFactory"), sessionFactory]);
  const ownerB = await acct(), B = eoaOwner(ownerB);
  const created = await send(ownerB, sessionFactory, C.sessionFactory.abi, "create", [ownerB.address]);
  const sv = decodeEventLog({ abi: C.sessionFactory.abi, ...created.logs[0] }).args.vault;
  const idB = await deployment(sv);
  assert.equal((await read(vault, VAULT_V2_ABI, "beneficialOwnerOf", [idB])).toLowerCase(), ownerB.address.toLowerCase(), "the vault answers to the SessionVault's owner");
  const ENV_B = Object.fromEntries(Array.from({ length: 64 }, (_, i) => [`K_${i}`, `v${i}-${randomBytes(8).toString("hex")}`]));
  await publish(B, idB, ENV_B, OLDC.cid, OLDC.Y);
  const origB = await policyOf(idB);
  let plB = await plan(idB);
  await B.apply(idB, plB.admit);
  // rollback BEFORE the switch: the original rules come back byte for byte; the authorization is dead
  await B.apply(idB, plB.rollback);
  const rolled = await policyOf(idB);
  assert.deepEqual([rolled.rules, rolled.committeeId, rolled.secretRev], [origB.rules, origB.committeeId, origB.secretRev], "rollback restores the original policy");
  assert.equal((await runGuest({ authorization: plB.authorization, signature: await sign(B, plB.authorization) })).error, "stale_revision");
  assert.deepEqual((await unlock(idB)).env, ENV_B);
  plB = await plan(idB); await B.apply(idB, plB.admit);
  const runB = await runGuest({ authorization: plB.authorization, signature: await sign(B, plB.authorization) });
  assert.ok(runB.result, runB.error);
  await B.apply(idB, checkResultAndSwitch({ chainId, vault, authorization: plB.authorization, result: runB.result, originalRules: plB.originalRules }).switchUpdate);
  assert.deepEqual((await unlock(idB)).env, ENV_B, "64 keys survive the move");
  // rollback AFTER the switch: the same mechanism in reverse (the corrected custodian releases, the old committee receives)
  const back = planRewrap({ policy: await policyOf(idB), bundle: await bundleOf(idB), dest: { committeeId: OLDC.cid, Y: OLDC.Y }, destCodeMeasurement: sha(OLD_MEAS),
    leaseEndpoint: hosts.app.endpoint, rewrapMeasurement: REWRAP_MEAS, expiry: await expiryIn(3600) });
  await B.apply(idB, back.admit);
  const runBack = await runGuest({ authorization: back.authorization, signature: await sign(B, back.authorization) });
  assert.ok(runBack.result, runBack.error);
  await B.apply(idB, checkResultAndSwitch({ chainId, vault, authorization: back.authorization, result: runBack.result, originalRules: back.originalRules }).switchUpdate);
  assert.equal((await policyOf(idB)).committeeId, OLDC.cid);
  assert.deepEqual((await unlock(idB)).env, ENV_B, "rolled back to the old committee: same payload");

  // ======================================================================== C. an ERC-1271 contract-wallet owner (updateBySig)
  const keyC = await acct();
  const walletC = await deploy(keyC, W1271, [keyC.address]);
  const Cw = walletOwner(walletC, keyC);
  const idC = await deployment(walletC);
  const ENV_C = { TOKEN: "tok-" + randomBytes(16).toString("hex"), CERT_B64: randomBytes(1500).toString("base64") };
  await publish(Cw, idC, ENV_C, OLDC.cid, OLDC.Y);
  assert.equal((await policyOf(idC)).owner, walletC.toLowerCase(), "the policy owner is the contract wallet");
  const plC = await plan(idC); await Cw.apply(idC, plC.admit);
  const sigC = await sign(Cw, plC.authorization);
  // the wallet withdraws (its key rotates away): its ERC-1271 answer at the agreed block now refuses
  const keyC2 = await acct();
  await send(keyC, walletC, W1271.abi, "setOwner", [keyC2.address]);
  assert.equal((await runGuest({ authorization: plC.authorization, signature: sigC })).error, "bad_signature", "a withdrawn ERC-1271 approval refuses");
  await send(keyC2, walletC, W1271.abi, "setOwner", [keyC.address]);
  const runC = await runGuest({ authorization: plC.authorization, signature: sigC });
  assert.ok(runC.result, runC.error);
  await Cw.apply(idC, checkResultAndSwitch({ chainId, vault, authorization: plC.authorization, result: runC.result, originalRules: plC.originalRules }).switchUpdate);
  assert.deepEqual((await unlock(idC)).env, ENV_C);

  // ======================================================================== D. the old ciphertext is useless to the new committee
  const oldBundleA = (await bundleOf(idB)).data;                       // idB is back under the old committee: its bundle is an old-Y ciphertext
  const idD = await deployment(ownerA.address);
  await publish(A, idD, { X: "y" }, NEWC.cid, NEWC.Y);
  const pD = await policyOf(idD);
  await A.apply(idD, makeUpdateV2({ expectPolicyRev: pD.policyRev, bundle: Buffer.from(oldBundleA.slice(2), "hex") }));
  await assert.rejects(unlock(idD), /bad_label_proof/, "an old-committee ciphertext is refused by the new committee");

  // ======================================================================== E. nothing secret left any process
  const everything = JSON.stringify(posted) + "\n" + logs.join("\n");
  for (const [k, v] of Object.entries({ ...ENV_A, ...ENV_B, ...ENV_C })) if (v.length >= 12) assert.ok(!everything.includes(v), `${k}'s value appears in a result, a host message or a log`);
  for (const p of posted.filter((x) => x.result)) assert.deepEqual(Object.keys(p.result).sort(),
    ["authorization", "authorizationDigest", "bundle", "bundleBytes", "bundleHash", "chainId", "checkedAtBlock", "destination", "format", "vault"]);
  assert.equal(REWRAP_RUNTIME_ID, runtimeId((await import("../custody/v2/rewrap.mjs")).REWRAP_RUNTIME).toString("hex"));
  assert.ok(rewrapDigest({ chainId, vault, authorization: authA }));
  assert.ok(canonicalRules(RULES).length > 0);
});
