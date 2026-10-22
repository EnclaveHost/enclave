// Custody v2 on a REAL chain (anvil) with the ORIGINAL book-bound EnclaveSecretVaultV2 (the source that fully matches the
// deployed 0xE48699B8… runtime), the deployed schema-4 EnclaveRegistry source, EnclaveHostOwnership and EnclaveAddressBook,
// driven by the candidate reader (vaultKind "book") and member. Every custodian signature, host binding, deal, ack and
// owner update is checked by the contract; the app guest's attestation is the synthetic SEV-SNP chain with the real
// verifier; custodian self-evidence is stubbed exactly as in custody-v2-e2e.test.mjs.
//   1. a committee founded like the live one (an Enclave-paid host with NO accepted owner, t = 1) keeps releasing;
//   2. the candidate refuses genesis/admission without accepted ownership and refuses payout/owner mismatches;
//   3. a handover is BLOCKED (no eviction) until the live seat's host enrolls ownership with the existing extension;
//   4. after enrollment: join, threshold handover (proposal, deals, acks, activation), same Y, t = 2 release rules;
//   5. a formerly Enclave host whose accepted owner changes is dropped from the next epoch; release continues;
//   6. production-SessionVault owners: refused while the book names no factory; after the ADMIN sets it, the vault owner
//      authorizes, and existing EOA policies are unaffected; an outsider cannot set the book;
//   7. admin book changes: a ledger migration is followed; a registry swap fails closed (release and membership) and
//      recovers when restored; a pinned-kind reader never falls back to the book;
//   8. platform host policy (admin-signed, anchored as a full 32-byte digest in two book keys with the exact setMany
//      calldata): a banned custodian host is dropped at the next threshold handover, a banned lease host gets no release,
//      a torn anchor refuses, a later policy lifts the ban; an outsider cannot anchor. (The gate is switched on for
//      phase 8 only through a test-only reference; production enables it in the measured config.)
//   run: node --test test/custody-v2-original-vault-e2e.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import net from "node:net";
import { spawn, spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { createPublicClient, createWalletClient, http, keccak256, toBytes, parseEther, stringToHex, decodeEventLog } from "viem";
import { privateKeyToAccount, generatePrivateKey } from "viem/accounts";
import { foundry } from "viem/chains";
import { snpAttester, RUNTIME, MEASUREMENT, FLOOR } from "./helpers/custody-rig.mjs";
import { originalVaultRig } from "./helpers/original-vault-rig.mjs";
import { synthChain } from "./helpers/snp-synth.mjs";
import { memoryCollateral } from "../verifier/index.mjs";
import { snpVerifier, SNP_GUEST_FORMAT } from "../custody/verifiers.mjs";
import * as hpke from "../custody/hpke.mjs";
import * as v2 from "../custody/v2/protocol.mjs";
import * as D from "../custody/v2/digests.mjs";
import { createChainReaderV2, VAULT_V2_ABI } from "../custody/v2/chain.mjs";
import { createCustodianV2 } from "../custody/v2/custodian.mjs";
import { createMember, BATCH_MS } from "../custody/v2/member.mjs";
import { buildBundleV2, makeUpdateV2, UPDATE_V2_ABI, updateTypedDataV2 } from "../custody/v2/owner.mjs";
import { runtimeId } from "../isolation/contract/runtime.mjs";
import { createCustodyReader } from "../relay/custody-state.mjs";
import { checkCustodyVaultIdentity } from "../network/custody-vaults.mjs";
import { createPlatformHostGate, policyTypedData, policyDigest, anchorTransaction, POLICY_FORMAT } from "../network/platform-host-policy.mjs";

const anvilAvailable = () => spawnSync("anvil", ["--version"], { stdio: "ignore" }).status === 0;
const freePort = () => new Promise((resolve) => { const s = net.createServer(); s.listen(0, "127.0.0.1", () => { const p = s.address().port; s.close(() => resolve(p)); }); });
// one block per second, so a fresh-block quorum stays fresh while the test is idle (the reader's 120 s freshness is kept)
async function startAnvil(chainId) {
  const port = await freePort();
  const p = spawn("anvil", ["--port", String(port), "--silent", "--chain-id", String(chainId), "--block-time", "1"], { stdio: "ignore" });
  const url = `http://127.0.0.1:${port}`, chain = { ...foundry, id: chainId };
  const client = createPublicClient({ chain, transport: http(url), pollingInterval: 250 });
  for (let i = 0; i < 100; i++) { try { await client.getChainId(); return { url, client, chain, stop: () => p.kill("SIGTERM") }; } catch { await new Promise((r) => setTimeout(r, 100)); } }
  p.kill("SIGKILL"); throw new Error("anvil did not start");
}
const sha = (b) => "0x" + createHash("sha256").update(b).digest("hex");
const key = (s) => stringToHex(s, { size: 32 });
const ZERO = "0x" + "00".repeat(20);
const APP = Buffer.alloc(32, 0xa7);
const RULES = { v: 1, appId: APP.toString("hex"), images: [{ platform: "sev-snp", measurement: MEASUREMENT, runtimeId: runtimeId(RUNTIME).toString("hex") }], minTcb: FLOOR, vmpl: 0 };
const CUSTODIAN_MEAS = Buffer.alloc(48, 0x5c);

test("original book-bound vault: grandfathered live epoch, ownership-gated admission, threshold handover, SessionVault owners and admin book changes",
  { skip: anvilAvailable() ? false : "anvil not installed", timeout: 600_000 }, async () => {
  const C = originalVaultRig();                      // compiled in a child process before anvil starts
  const chainId = 31337;
  const anvil = await startAnvil(chainId);
  try {
    const pub = anvil.client;
    const fund = (a) => pub.request({ method: "anvil_setBalance", params: [a, "0x" + parseEther("100").toString(16)] });
    const acct = async () => { const a = privateKeyToAccount(generatePrivateKey()); await fund(a.address); return a; };
    const wallet = (a) => createWalletClient({ account: a, chain: anvil.chain, transport: http(anvil.url) });
    const send = async (a, address, abi, functionName, args) => {
      const hash = await wallet(a).writeContract({ address, abi, functionName, args, gas: 15_000_000n });
      const r = await pub.waitForTransactionReceipt({ hash });
      if (r.status !== "success") throw new Error(`${functionName} reverted`);
      return r;
    };
    const reverts = async (a, address, abi, functionName, args, re) => {
      await assert.rejects(pub.simulateContract({ account: a, address, abi, functionName, args }), re, `${functionName} must revert`);
    };
    const deploy = async (a, c, args = []) => (await pub.waitForTransactionReceipt({ hash: await wallet(a).deployContract({ abi: c.abi, bytecode: c.bytecode, args }) })).contractAddress;
    const read = (address, abi, functionName, args = []) => pub.readContract({ address, abi, functionName, args });

    // ---- contracts: the admin owns the book; the vault's immutables are (book, Enclave wallet) as on Base ----
    const admin = await acct(), enclaveWallet = await acct(), enclaveOwner = enclaveWallet.address.toLowerCase(), outsider = await acct();
    const book = await deploy(admin, C.book), ledger = await deploy(admin, C.ledger), registry = await deploy(admin, C.registry);
    await send(admin, book, C.book.abi, "set", [key("deployments"), ledger]);
    await send(admin, book, C.book.abi, "set", [key("registry"), registry]);
    const ownership = await deploy(admin, C.ownership, [registry]);
    const vault = (await deploy(admin, C.vault, [book, enclaveWallet.address])).toLowerCase();
    assert.equal((await read(vault, VAULT_V2_ABI, "book")).toLowerCase(), book.toLowerCase());
    await assert.rejects(read(vault, VAULT_V2_ABI, "hostOwnership"), "the original vault has no pinned authority getters");

    // ---- hosts on the real registry; Enclave payout declared by the Enclave wallet itself; ownership via the extension ----
    const hosts = {};
    const host = async (name, { payoutEnclave = false, owner = null } = {}) => {
      const op = await acct(), endpoint = `https://${name}.host.test`, registryId = keccak256(toBytes(endpoint));
      await send(op, registry, C.registry.abi, "register", [endpoint, "repo", "0x" + "11".repeat(32), 1n, 0n, ZERO]);
      if (payoutEnclave) await send(enclaveWallet, registry, C.registry.abi, "setPayoutWallet", [registryId]);
      if (owner) { await send(op, ownership, C.ownership.abi, "proposeOwner", [registryId, owner.address]); await send(owner, ownership, C.ownership.abi, "acceptOwner", [registryId]); }
      return (hosts[name] = { op, endpoint, registryId, owner });
    };
    const ownerB = await acct(), ownerC = await acct(), stranger = await acct();
    await host("metal0", { payoutEnclave: true });                     // the live shape: Enclave-paid, NO accepted owner
    await host("ea", { payoutEnclave: true, owner: enclaveWallet });   // enrolled Enclave host
    await host("nb", { owner: ownerB }); await host("nc", { owner: ownerC });
    await host("nd");                                                  // unknown owner
    await host("ex", { owner: enclaveWallet });                        // Enclave-owned but no Enclave payout (vault: independent seat)
    await host("ey", { payoutEnclave: true, owner: stranger });        // Enclave-paid but another wallet owns it
    await host("app", { owner: await acct() });

    const readerOpts = { rpcs: [anvil.url], vault, minAgree: 1, vaultKind: "book", book, hostOwnership: ownership, hostPolicy: { book, hostOwnership: ownership } };
    const gateRef = { current: null };      // test-only switch: enforcement OFF until phase 8, then the real gate
    const hostGate = { decideHost: (...a) => (gateRef.current ? gateRef.current.decideHost(...a) : { admit: true, status: "off" }),
                       refresh: () => (gateRef.current ? gateRef.current.refresh() : Promise.resolve()) };
    const reader = createChainReaderV2(readerOpts);
    const idn = await reader.readVaultIdentity();
    assert.deepEqual([idn.book, idn.enclaveOwner, idn.runtimeBytes > 19000], [book.toLowerCase(), enclaveOwner, true], "the identity read sees the vault's own immutables");
    assert.throws(() => checkCustodyVaultIdentity(vault, idn), /not a reviewed/, "a rig vault is never mistaken for the reviewed production vault");
    const flags = async (name) => { const { entry } = await reader.readRegistryEntry({ registryId: hosts[name].registryId }); return [entry.vaultEnclave, entry.owner, entry.ownerConflict]; };
    assert.deepEqual(await flags("metal0"), [true, ZERO, false]);
    assert.deepEqual(await flags("ey"), [true, stranger.address.toLowerCase(), true]);
    assert.deepEqual(await flags("ex"), [false, enclaveOwner, false]);

    // ---- custodian machines (in-process, routed by endpoint) ----
    const submitter = await acct();
    const submit = async (fn, args) => (await send(submitter, vault, VAULT_V2_ABI, fn, args)).transactionHash;
    const S = synthChain();
    const collateral = memoryCollateral({ chains: { Genoa: S.chainPem }, vceks: { Genoa: S.vcekDer }, crls: { Genoa: S.crlDer } });
    const verifiers = Object.freeze({ [SNP_GUEST_FORMAT]: snpVerifier({ collateral, roots: new Map([["Genoa", S.arkFp]]) }) });
    const machines = {};
    const route = async (url, body) => {
      const m = Object.values(machines).find((x) => url.startsWith(x.endpoint + "/"));
      if (!m) throw new Error(`no machine at ${url}`);
      const p = url.slice(m.endpoint.length);
      if (p === "/v2/custody/info") return m.member.info();
      if (p === "/v2/custody/evidence") return m.member.evidence(body.nonce);
      if (p === "/v2/custody/approve") return m.member.approve(body);
      if (p === "/v2/custody/join") return m.member.join(body, m.committeeId);
      throw new Error(`no route ${p}`);
    };
    let skew = 0; const now = () => Date.now() + skew;
    const capacityOk = new Set();
    const newIdentity = (name, h) => {
      const identity = privateKeyToAccount(generatePrivateKey()), kp = hpke.generateKeyPair(), chip = randomBytes(64);
      return { identity, kp, chip, machine: { identity: identity.address.toLowerCase(), encKey: "0x" + Buffer.from(kp.publicKey).toString("hex"),
        endpoint: `https://custody-${name}.test`, chipId: sha(chip), registryId: h.registryId, measurement: sha(CUSTODIAN_MEAS) } };
    };
    const makeMachine = async (name, h, { id = newIdentity(name, h), state = null, bind = true } = {}) => {
      let st = state;
      const chain = createChainReaderV2(readerOpts);
      const member = createMember({ chainId, vault, identity: id.identity, encPrivateKey: id.kp.privateKey, machine: id.machine, chain,
        store: { load: () => st, save: (s) => { st = JSON.parse(JSON.stringify(s)); } }, submit, fetchJson: route, now, log: () => {}, enclaveOwner,
        attestSelf: async (binding) => ({ report: Buffer.concat([Buffer.from(binding), CUSTODIAN_MEAS, id.chip]), auxblob: null }),
        verifyPeerQuote: async (report, { binding }) => (Buffer.compare(report.subarray(0, 32), Buffer.from(binding)) === 0
          ? { ok: true, measurement: report.subarray(32, 80).toString("hex"), chipId: report.subarray(80, 144).toString("hex") } : { ok: false, reason: "binding" }),
        capacityCheck: async ({ machine: m }) => (capacityOk.has(m.identity) ? { ok: true } : { ok: false, reason: "no receipts" }), hostGate });
      const custodian = createCustodianV2({ chainId, vault, encPrivateKey: id.kp.privateKey, shares: member.shares, chain, verifiers, log: () => {}, hostGate });
      const bound = bind ? await member.setHostSig(await D.signDigest(h.op, D.hostDigest({ chainId, vault, machine: id.machine }))) : null;
      machines[name] = { name, endpoint: id.machine.endpoint, machine: id.machine, member, custodian, committeeId: null, bound };
      return machines[name];
    };

    // ---- 1. fresh genesis needs an Enclave-OWNED, Enclave-seated host; the contract alone accepts payout ----
    const probe = await makeMachine("probe", hosts.metal0);
    assert.equal(probe.bound.admissible, false, "an unenrolled Enclave-paid host binds but is not admissible");
    await assert.rejects(probe.member.genesis({ salt: "0x" + "01".repeat(32), codeSet: [probe.machine.measurement] }), /genesis: host wallet ownership has not been accepted/);
    const nbProbe = await makeMachine("nbprobe", hosts.nb);
    await assert.rejects(nbProbe.member.genesis({ salt: "0x" + "02".repeat(32), codeSet: [nbProbe.machine.measurement] }), /genesis needs a host the vault seats as Enclave/);
    delete machines.probe; delete machines.nbprobe;

    // ---- the live shape: the committee founded on the unenrolled Enclave-paid host (as the deployed runtime did) ----
    const euId = newIdentity("metal0", hosts.metal0);
    const g = v2.genesis(), salt = "0x" + "03".repeat(32), codeSet = [euId.machine.measurement];
    const Yhex = "0x" + Buffer.from(g.Y).toString("hex");
    const cid = D.committeeIdOf({ chainId, vault, salt, Y: g.Y });
    const euHostSig = await D.signDigest(hosts.metal0.op, D.hostDigest({ chainId, vault, machine: euId.machine }));
    await submit("createCommittee", [salt, euId.machine, Yhex, codeSet, await D.signDigest(euId.identity, D.genesisDigest({ chainId, vault, committeeId: cid, Y: g.Y, machine: euId.machine, codeSet })), euHostSig]);
    const preState = { epochs: { [`${cid.toLowerCase()}:1`]: g.shares.map((s) => ({ k: s.k, x: s.x.toString(16).padStart(64, "0") })) }, pending: {}, hostSig: euHostSig, candidates: {} };
    const EU = await makeMachine("metal0", hosts.metal0, { id: euId, state: preState });
    EU.committeeId = cid;
    let { committee } = await reader.readCommittee({ committeeId: cid });
    assert.deepEqual([committee.epoch, committee.t, committee.W, committee.machines[0].enclave], [1, 1, 1, true]);

    // ---- an owner publishes; an attested app guest unlocks ----
    const appOwner = await acct();
    const id1 = "0x" + randomBytes(32).toString("hex");
    const leaseUntil = async () => BigInt(Number((await pub.getBlock()).timestamp) + 7200);
    await send(admin, ledger, C.ledger.abi, "set", [id1, appOwner.address, hosts.app.registryId, hosts.app.op.address, await leaseUntil()]);
    const env1 = { API_KEY: "v2-secret", DB: "postgres://x" };
    const publish = async (signer, id, env, { bySig = false } = {}) => {
      const [, policyRev, secretRev] = await read(vault, VAULT_V2_ABI, "policyOf", [id]);
      const { committee: com } = await reader.readCommittee({ committeeId: cid });
      const bundle = buildBundleV2({ chainId, vault, id, secretRev: secretRev + 1n, committeeId: cid, Y: com.Y, env, configText: "" });
      const u = makeUpdateV2({ expectPolicyRev: policyRev, policy: { committeeId: cid, paused: false, rules: RULES }, bundle });
      if (!bySig) return send(signer, vault, UPDATE_V2_ABI, "update", [id, u]);
      const deadline = BigInt(Number((await pub.getBlock()).timestamp) + 600);
      const sig = await signer.signTypedData(updateTypedDataV2({ chainId, vault, id, update: u, deadline }));
      return { u, deadline, sig };
    };
    await publish(appOwner, id1, env1);
    const unlock = async (id, useMachines, { expectEnclaveRule = true } = {}) => {
      const st = await reader.readRelease({ id, endpoint: hosts.app.endpoint });
      const com = st.committee;
      const at = snpAttester(S, { appId: APP, hostData: Buffer.from(id.slice(2), "hex") });
      const recipient = hpke.generateKeyPair();
      const challenges = useMachines.map((m) => { const c = m.custodian.challenge(); return { m, encKey: c.encKey, nonce: c.nonce }; });
      const chs = challenges.map((c) => ({ encKey: Buffer.from(c.encKey, "hex"), nonce: Buffer.from(c.nonce, "hex") }));
      const binding = v2.releaseBinding({ chainId, vault, id, policyRev: st.policy.policyRev, secretRev: st.policy.secretRev, committeeId: cid, epoch: com.epoch,
        challenges: chs, runtimeId: new Uint8Array(runtimeId(RUNTIME)), transportSpki: at.transportSpki, recipientKey: recipient.publicKey });
      const expiry = Math.floor(Date.now() / 1000) + 300;
      const sig = await hosts.app.op.signMessage({ message: v2.operatorMessage({ chainId, vault, id, endpoint: hosts.app.endpoint, binding, expiry }) });
      const evidence = await at.evidence(binding);
      const commitments = []; for (let i = 0; i < com.commitments.length; i += 33) commitments.push(com.commitments.subarray(i, i + 33));
      const R = v2.parseBundle(st.bundle.data).R;
      const got = [];
      for (const c of challenges) {
        const r = await c.m.custodian.release({ v: 2, id, endpoint: hosts.app.endpoint, committeeId: cid, epoch: com.epoch, policyRev: String(st.policy.policyRev), secretRev: String(st.policy.secretRev),
          recipientKey: Buffer.from(recipient.publicKey).toString("hex"), challenges: challenges.map((x) => ({ encKey: x.encKey, nonce: x.nonce })), operator: { sig, expiry }, evidence });
        const recs = v2.openPartials({ recipientPrivate: recipient.privateKey, binding, encKey: Buffer.from(r.encKey, "hex"), count: r.count, sealed: Buffer.from(r.sealed, "base64") });
        const mm = com.machines.find((x) => x.encKey === "0x" + r.encKey);
        got.push({ enclave: mm.enclave, parts: recs.map((record) => v2.verifyPartial({ record, R, binding, commitments })) });
      }
      const encl = got.filter((x) => x.enclave), others = got.filter((x) => !x.enclave);
      const chosen = expectEnclaveRule && encl.length ? [...encl[0].parts] : [];
      for (const o of (expectEnclaveRule ? others : got)) for (const p of o.parts) if (chosen.length < com.t && !chosen.some((c) => c.k === p.k)) chosen.push(p);
      const S2 = v2.combine(chosen.slice(0, com.t), com.t);
      return v2.decryptBundle({ S: S2, label: v2.labelOf({ chainId, vault, id, secretRev: st.policy.secretRev, committeeId: cid }), bundle: st.bundle.data }).env;
    };
    assert.deepEqual(await unlock(id1, [EU]), env1, "the grandfathered live epoch releases");

    // ---- 2. future admission: accepted ownership that agrees with the vault's seat flag ----
    const EA = await makeMachine("ea", hosts.ea), NB = await makeMachine("nb", hosts.nb), NC = await makeMachine("nc", hosts.nc);
    for (const m of [EA, NB, NC]) m.committeeId = cid;
    capacityOk.add(NB.machine.identity); capacityOk.add(NC.machine.identity);
    // a fresh, attested, capacity-proven candidate on host h: join must be refused for its ownership alone
    const refusedJoin = async (name, h, re) => {
      const x = newIdentity(name, h);
      const hostSig = await D.signDigest(h.op, D.hostDigest({ chainId, vault, machine: x.machine }));
      machines[name] = { endpoint: x.machine.endpoint, member: { evidence: async (nonce) => ({ machine: x.machine, hostSig, report: Buffer.concat([v2Binding(x.machine, nonce), CUSTODIAN_MEAS, x.chip]).toString("base64") }) } };
      capacityOk.add(x.machine.identity);
      await assert.rejects(EU.member.join({ machine: x.machine, hostSig }, cid), re, `${name} is refused`);
      delete machines[name];
    };
    await refusedJoin("nd", hosts.nd, /ownership has not been accepted/);       // unknown owner
    await refusedJoin("ex", hosts.ex, /independent seat/);                     // Enclave-owned, vault would not seat it as Enclave
    await refusedJoin("ey", hosts.ey, /another wallet accepted/);              // Enclave-paid, owned by another wallet
    for (const m of [EA, NB, NC]) assert.ok((await EU.member.join({ machine: m.machine }, cid)).ok);

    // ---- 3. no handover (and no eviction) while the live seat's host has no accepted owner ----
    let r = await EU.member.tick(cid);
    assert.equal(r.state, "invalid_next"); assert.match(r.reason, /blocked: .*must enroll ownership before any handover/);
    assert.equal((await reader.readCommittee({ committeeId: cid })).committee.epoch, 1);
    assert.deepEqual(await unlock(id1, [EU]), env1, "still releasing while blocked");

    // the prepared pre-handover action, executed here on the rig: operator proposes the Enclave wallet, which accepts
    await send(hosts.metal0.op, ownership, C.ownership.abi, "proposeOwner", [hosts.metal0.registryId, enclaveWallet.address]);
    await send(enclaveWallet, ownership, C.ownership.abi, "acceptOwner", [hosts.metal0.registryId]);
    assert.deepEqual(await flags("metal0"), [true, enclaveOwner, false]);

    // ---- 4. threshold handover through the contract: Enclave seat {metal0, ea}, nb, nc -> n = 3, t = 2, W = 3 ----
    const runHandover = async (members, target) => {
      for (let i = 0; i < 16; i++) {
        const states = [];
        for (const m of members) states.push((await m.member.tick(cid).catch((e) => { throw new Error(`${m.name}: ${e.message}`); })).state);
        if ((await reader.readCommittee({ committeeId: cid })).committee.epoch >= target) break;
        if (states.includes("batching")) skew += BATCH_MS + 1000;      // only the batching window is skipped
        if (states.some((x) => ["invalid_next", "unapproved", "stuck"].includes(x))) throw new Error("handover stalled: " + states.join(","));
      }
      for (const m of members) await m.member.tick(cid);
      return (await reader.readCommittee({ committeeId: cid })).committee;
    };
    committee = await runHandover([EU, EA, NB, NC], 2);
    assert.equal(committee.epoch, 2, "the handover activated");
    assert.deepEqual([committee.machines.length, committee.t, committee.W], [4, 2, 3]);
    assert.equal(Buffer.from(committee.Y).toString("hex"), Buffer.from(g.Y).toString("hex"), "the committee key never changed");
    assert.deepEqual(EU.member.shares.get(cid, 1), [], "old-epoch shares erased after activation");
    assert.deepEqual(await unlock(id1, [EU, NB]), env1);
    assert.deepEqual(await unlock(id1, [EA, NC]), env1);
    await assert.rejects(unlock(id1, [EU, EA], { expectEnclaveRule: false }), /exactly 2 distinct/, "two Enclave machines are one seat");
    assert.deepEqual(await unlock(id1, [NB, NC]), env1);
    const relayReader = createCustodyReader({ vault2: vault, chainId, rpcs: [anvil.url], minAgree: 1, maxAgeSec: null });
    const ptr = await relayReader.custodyStateFor(id1);
    assert.deepEqual([ptr.v, ptr.committeeId, ptr.t, ptr.epoch], [2, cid.toLowerCase(), 2, 2], "the relay pointer reads the original vault");

    // ---- 5. a formerly Enclave host whose accepted owner changes leaves at the next epoch ----
    await send(enclaveWallet, ownership, C.ownership.abi, "proposeOwner", [hosts.ea.registryId, stranger.address]);
    await send(stranger, ownership, C.ownership.abi, "acceptOwner", [hosts.ea.registryId]);
    assert.deepEqual(await flags("ea"), [true, stranger.address.toLowerCase(), true], "the vault would still seat it as Enclave (payout): a mismatch");
    await refusedJoin("ea2", hosts.ea, /another wallet accepted/);
    await assert.rejects(EA.member.genesis({ salt: "0x" + "04".repeat(32), codeSet }), /another wallet accepted/);
    committee = await runHandover([EU, EA, NB, NC], 3);
    assert.equal(committee.epoch, 3);
    assert.deepEqual(committee.machines.map((m) => m.identity).sort(), [EU, NB, NC].map((m) => m.machine.identity).sort(), "the mismatched host was dropped");
    assert.deepEqual([committee.t, committee.W], [2, 3]);
    assert.deepEqual(EA.member.shares.get(cid, 3), []);
    assert.deepEqual(await unlock(id1, [EU, NC]), env1);

    // ---- 6. production SessionVault owners: the book's factory decides; only the admin sets it ----
    const sessOwner = await acct();
    const rc = await send(admin, (await deploy(admin, C.sessionFactory)), C.sessionFactory.abi, "create", [sessOwner.address]).catch((e) => { throw e; });
    const factory = rc.to;
    const sv = decodeEventLog({ abi: C.sessionFactory.abi, ...rc.logs[0] }).args.vault;
    const id2 = "0x" + randomBytes(32).toString("hex");
    await send(admin, ledger, C.ledger.abi, "set", [id2, sv, hosts.app.registryId, hosts.app.op.address, await leaseUntil()]);
    assert.equal((await read(vault, VAULT_V2_ABI, "beneficialOwnerOf", [id2])).toLowerCase(), sv.toLowerCase(), "no factory in the book: the SessionVault itself is the owner");
    let p = await publish(sessOwner, id2, { K: "session" }, { bySig: true });
    await reverts(submitter, vault, UPDATE_V2_ABI, "updateBySig", [id2, p.u, p.deadline, p.sig], /BadSignature|reverted/);
    await reverts(sessOwner, vault, UPDATE_V2_ABI, "update", [id2, p.u], /NotOwner|reverted/);
    await reverts(outsider, book, C.book.abi, "set", [key("sessionVaultFactory"), factory], /!owner|reverted/);
    await send(admin, book, C.book.abi, "set", [key("sessionVaultFactory"), factory]);
    assert.equal((await read(vault, VAULT_V2_ABI, "beneficialOwnerOf", [id2])).toLowerCase(), sessOwner.address.toLowerCase());
    p = await publish(sessOwner, id2, { K: "session" }, { bySig: true });
    await send(submitter, vault, UPDATE_V2_ABI, "updateBySig", [id2, p.u, p.deadline, p.sig]);
    assert.deepEqual(await unlock(id2, [EU, NB]), { K: "session" }, "a SessionVault-held deployment releases to its attested guest");
    assert.deepEqual(await unlock(id1, [NB, NC]), env1, "the EOA-owned policy is unaffected by the factory entry");

    // ---- 7. admin book changes ----
    const ledger2 = await deploy(admin, C.ledger);
    for (const [id, o] of [[id1, appOwner.address], [id2, sv]]) await send(admin, ledger2, C.ledger.abi, "set", [id, o, hosts.app.registryId, hosts.app.op.address, await leaseUntil()]);
    await reverts(outsider, book, C.book.abi, "set", [key("deployments"), ledger2], /!owner|reverted/);
    await send(admin, book, C.book.abi, "set", [key("deployments"), ledger2]);
    assert.deepEqual(await unlock(id1, [EU, NC]), env1, "an admin ledger migration is followed by vault and custodians alike");
    const registry2 = await deploy(admin, C.registry);
    await send(admin, book, C.book.abi, "set", [key("registry"), registry2]);
    await assert.rejects(unlock(id1, [EU, NC]), /not_registered|registry/, "the app host is not in the new registry: release fails closed");
    await assert.rejects(reader.readRegistryEntry({ registryId: hosts.nb.registryId }), /host_authority_mismatch|only 0 RPCs/, "membership fails closed on an extension bound elsewhere");
    await send(admin, book, C.book.abi, "set", [key("registry"), registry]);
    assert.deepEqual(await unlock(id1, [EU, NC]), env1, "restored");
    const pinned = createChainReaderV2({ rpcs: [anvil.url], vault, minAgree: 1 });
    await assert.rejects(pinned.readRelease({ id: id1, endpoint: null }), /only 0 RPCs|revert/i, "a pinned-kind reader never falls back to the book");

    // ---- 8. platform host policy ----
    const signed = new Map();
    const publishPolicy = async (seq, deny) => {
      const t = Math.floor(Date.now() / 1000);
      const p = { format: POLICY_FORMAT, chainId: 8453, book: book.toLowerCase(), registry: registry.toLowerCase(), hostOwnership: ownership.toLowerCase(), sequence: seq,
                  issuedAt: t - 60, expiresAt: t + 3600, maxStaleSec: 3600, previousDigest: "0x" + "00".repeat(32), mode: "denylist", deny, admit: [] };
      const d = policyDigest(p);
      signed.set(d, { document: JSON.stringify(p), signature: await admin.signTypedData(policyTypedData(p)) });
      const tx = anchorTransaction(book, d);                       // the exact unsigned admin transaction, sent here on the rig only
      await assert.rejects(pub.call({ account: outsider.address, to: book, data: tx.data }), /!owner|revert/i, "an outsider cannot anchor");
      const r = await pub.waitForTransactionReceipt({ hash: await wallet(admin).sendTransaction({ to: book, data: tx.data }) });
      assert.equal(r.status, "success");
      return d;
    };
    const gate = createPlatformHostGate({ book, hostOwnership: ownership, snapshot: reader.snapshot, mirrors: [async (digest) => (signed.has(digest) ? [signed.get(digest)] : [])] });
    const ban = (h, why) => ({ kind: "operator", value: h.op.address.toLowerCase(), reason: why });
    await publishPolicy(1, [ban(hosts.nc, "custodian abuse")]);
    gateRef.current = gate;
    assert.equal((await gate.refresh()).policy.sequence, 1);
    assert.deepEqual(await unlock(id1, [EU, NB]), env1, "an admitted lease host still releases");
    await refusedJoin("nc2", hosts.nc, /platform host policy: banned/);
    committee = await runHandover([EU, NB, NC], 4);
    assert.equal(committee.epoch, 4);
    assert.deepEqual(committee.machines.map((m) => m.identity).sort(), [EU, NB].map((m) => m.machine.identity).sort(), "the banned custodian host was dropped");
    assert.deepEqual([committee.t, committee.W], [2, 3], "two seats: the Enclave seat holds t shares");
    assert.deepEqual(await unlock(id1, [EU]), env1);
    await publishPolicy(2, [ban(hosts.nc, "custodian abuse"), ban(hosts.app, "malicious app host")]);
    await assert.rejects(unlock(id1, [EU]), /Platform host policy|host_refused/, "a banned lease host gets no partials (first answer may be 'behind', then refused)");
    await gate.refresh();
    await assert.rejects(unlock(id1, [EU]), /banned by platform policy #2 \(operator\): malicious app host/);
    await send(admin, book, C.book.abi, "set", [key("hostPolicyDigestLo"), ZERO]);
    await assert.rejects(unlock(id1, [EU]), /torn|Platform host policy/, "a torn anchor refuses");
    await publishPolicy(3, [ban(hosts.nc, "custodian abuse")]);
    await gate.refresh();
    assert.deepEqual(await unlock(id1, [EU]), env1, "a later anchored policy lifts the app host ban");
  } finally { anvil.stop(); }
});

// the custodian evidence binding used by member.attest (member.mjs machineBinding)
function v2Binding(machine, nonceHex) {
  return createHash("sha256").update(Buffer.from("enclave-custody-v2 machine\n")).update(Buffer.from(D.machineHash(machine).slice(2), "hex")).update(Buffer.from(nonceHex, "hex")).digest();
}
