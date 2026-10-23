// Custody v2 end to end on a REAL chain (anvil) with the ORIGINAL book-bound EnclaveSecretVaultV2 (contracts/, the source of
// the deployed 0xE48699B8… vault: constructor (book, enclaveOwner); its ledger and host registry are the admin's address-book
// entries), the deployed schema-4 EnclaveRegistry source, EnclaveHostOwnership and EnclaveAddressBook
// (test/helpers/original-vault-rig.mjs), driven by the candidate reader (vaultKind "book") and member:
//   1. the Enclave seat creates the committee (genesis); a non-Enclave host cannot, by the member or by the contract;
//   2. an owner encrypts to the committee key and an attested guest unlocks at t = 1;
//   3. candidates join (a second Enclave machine, two capacity-proven hosts) and a handover runs through the contract
//      (proposal, deals, acks, activation); the guest then unlocks at t = 2 with EXACTLY ONE Enclave machine's partial;
//   4. the address book is the release authority: only its admin edits it, a cleared registry fails closed, a restore recovers;
//   5. the relay's v2 pointer reads the vault.
// Every machine persists through the daemon's REAL sealed-state writer (custody/v2/sealed-state.mjs: member store and the
// chain reader's checkpoint over one state) to a host disk this test can fail, and every createCommittee/ackHandover
// records what that machine had DURABLY when it was submitted. Genesis faults, each followed by a restart from the disk:
// a failed share write sends nothing; a createCommittee that fails before reaching the chain is re-sent as the SAME durable
// intent; one that lands but whose answer is lost is confirmed from the chain without a second genesis; an unreachable RPC
// sends nothing; a committee created without an intent (the live shape) is served as before, and an orphan share with no
// intent is reported, kept and never re-created. An ack submission fails once and that machine restarts from its durable
// state and re-acks the same share, which the contract accepts.
// Every custodian signature (genesis, approvals, deals, acks) is checked by the contract, so this also pins
// custody/v2/digests.mjs to the Solidity. Attestation of app guests is SIMULATED (synthetic AMD chain, real verifier);
// custodian self-evidence is stubbed (the hardware path is exercised on warden-host).
//   run: node --test test/custody-v2-e2e.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import net from "node:net";
import { spawn, spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { createPublicClient, createWalletClient, http, keccak256, toBytes, parseEther, stringToHex } from "viem";
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
import { createSealedStateWriter } from "../custody/v2/sealed-state.mjs";
import { buildBundleV2, makeUpdateV2, UPDATE_V2_ABI } from "../custody/v2/owner.mjs";
import { runtimeId } from "../isolation/contract/runtime.mjs";
import { createCustodyReader } from "../relay/custody-state.mjs";

const anvilAvailable = () => spawnSync("anvil", ["--version"], { stdio: "ignore" }).status === 0;
const freePort = () => new Promise((resolve) => { const s = net.createServer(); s.listen(0, "127.0.0.1", () => { const p = s.address().port; s.close(() => resolve(p)); }); });
// one block per second, so a fresh-block quorum (and its sealed checkpoint) stays fresh while the test is idle
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

test("custody v2 end to end on the original book-bound vault: genesis, release at t=1, join + handover through the contract with durable shares, release at t=2 with exactly one Enclave partial",
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
      return hash;
    };
    const reverts = (a, address, abi, functionName, args, re, msg) => assert.rejects(pub.simulateContract({ account: a, address, abi, functionName, args }), re, msg);
    const deploy = async (a, c, args = []) => (await pub.waitForTransactionReceipt({ hash: await wallet(a).deployContract({ abi: c.abi, bytecode: c.bytecode, args }) })).contractAddress;

    // ---- contracts: the admin owns the book; the vault's immutables are (book, Enclave wallet), as deployed ----
    const admin = await acct(), enclaveWallet = await acct(), enclaveOwner = enclaveWallet.address, outsider = await acct();
    const book = await deploy(admin, C.book), ledger = await deploy(admin, C.ledger), registry = await deploy(admin, C.registry);
    await send(admin, book, C.book.abi, "set", [key("deployments"), ledger]);
    await send(admin, book, C.book.abi, "set", [key("registry"), registry]);
    const ownership = await deploy(admin, C.ownership, [registry]);
    assert.deepEqual(C.vault.abi.find((x) => x.type === "constructor").inputs.map((i) => i.name), ["book_", "enclaveOwner_"], "the original vault's constructor");
    const vault = (await deploy(admin, C.vault, [book, enclaveOwner])).toLowerCase();
    assert.equal((await pub.readContract({ address: vault, abi: VAULT_V2_ABI, functionName: "book" })).toLowerCase(), book.toLowerCase());
    await assert.rejects(pub.readContract({ address: vault, abi: VAULT_V2_ABI, functionName: "hostOwnership" }), "the original vault has no pinned authority getters");
    const nowBlock = async () => Number((await pub.getBlock()).timestamp);
    // simulated clock for the engine's batching/liveness windows
    let skew = 0; const now = () => Date.now() + skew;

    // ---- hosts on the real registry: Enclave payout declared by the Enclave wallet itself; ownership via the extension ----
    const hosts = {};
    for (const [name, enclave] of [["ea", true], ["eb", true], ["nb", false], ["nc", false], ["app", false]]) {
      const op = await acct(), endpoint = `https://${name}.host.test`, registryId = keccak256(toBytes(endpoint));
      await send(op, registry, C.registry.abi, "register", [endpoint, "repo", "0x" + "11".repeat(32), 1n, 0n, ZERO]);
      if (enclave) await send(enclaveWallet, registry, C.registry.abi, "setPayoutWallet", [registryId]);
      const owner = enclave ? enclaveWallet : op;
      await send(op, ownership, C.ownership.abi, "proposeOwner", [registryId, owner.address]);
      await send(owner, ownership, C.ownership.abi, "acceptOwner", [registryId]);
      hosts[name] = { op, endpoint, registryId };
    }
    const readerOpts = { rpcs: [anvil.url], vault, minAgree: 1, vaultKind: "book", book, hostOwnership: ownership };

    // ---- custodian machines (in-process), routed by endpoint, each persisting through the real writer ----
    const submitter = await acct();
    const submitTx = (fn, args) => send(submitter, vault, VAULT_V2_ABI, fn, args);
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
    const capacityOk = new Set();
    const barrier = [];                                // every createCommittee/ackHandover: what its machine had durably
    const failSubmit = new Set();                      // "<machine>:<fn>": the next such submission fails before the chain;
                                                       // "<machine>:<fn>:lost": it lands, then its answer is lost
    const newIdentity = (name, h) => {
      const identity = privateKeyToAccount(generatePrivateKey()), kp = hpke.generateKeyPair(), chip = randomBytes(64);
      return { identity, kp, chip, machine: { identity: identity.address.toLowerCase(), encKey: "0x" + Buffer.from(kp.publicKey).toString("hex"),
        endpoint: `https://custody-${name}.test`, chipId: sha(chip), registryId: h.registryId, measurement: sha(CUSTODIAN_MEAS) } };
    };
    // durable: the sealed blob a (re)started machine finds on its host disk (null = fresh)
    const makeMachine = async (name, host, { id = newIdentity(name, host), durable = null, rpcs = readerOpts.rpcs } = {}) => {
      const disk = { durable, failIf: null };          // failIf(state): the next write it matches fails (host /state 500)
      const state = durable ? JSON.parse(durable) : {};
      const writer = createSealedStateWriter({ seal: (s) => JSON.stringify(s), state, log: () => {}, put: async (blob) => {
        if (disk.failIf && disk.failIf(JSON.parse(blob))) { disk.failIf = null; throw new Error("host /state: 500"); }
        disk.durable = blob; } });
      const chain = createChainReaderV2({ ...readerOpts, rpcs, checkpoint: writer.checkpoint });   // the daemon's wiring
      const submit = async (fn, args) => {
        if (fn === "createCommittee" || fn === "ackHandover") barrier.push({ name, fn, args, durable: disk.durable && JSON.parse(disk.durable) });
        if (failSubmit.delete(`${name}:${fn}`)) throw new Error(`submit ${fn}: rpc down`);
        if (failSubmit.delete(`${name}:${fn}:lost`)) { await submitTx(fn, args); throw new Error(`submit ${fn}: receipt lost`); }
        return submitTx(fn, args);
      };
      const member = createMember({ chainId, vault, identity: id.identity, encPrivateKey: id.kp.privateKey, machine: id.machine, chain, store: writer.memberStore,
        submit, fetchJson: route, now, log: () => {}, enclaveOwner,
        // custodian self-evidence (stub): the binding is carried through and checked; measurement and chip from the record
        attestSelf: async (binding) => ({ report: Buffer.concat([Buffer.from(binding), CUSTODIAN_MEAS, id.chip]), auxblob: null }),
        verifyPeerQuote: async (report, { binding }) => (Buffer.compare(report.subarray(0, 32), Buffer.from(binding)) === 0
          ? { ok: true, measurement: report.subarray(32, 80).toString("hex"), chipId: report.subarray(80, 144).toString("hex") } : { ok: false, reason: "binding" }),
        capacityCheck: async ({ machine: m }) => (capacityOk.has(m.identity) ? { ok: true } : { ok: false, reason: "no receipts" }) });
      const custodian = createCustodianV2({ chainId, vault, encPrivateKey: id.kp.privateKey, shares: member.shares, chain, verifiers, log: () => {} });
      if (!durable) await member.setHostSig(await D.signDigest(host.op, D.hostDigest({ chainId, vault, machine: id.machine })));
      return (machines[name] = { name, host, id, endpoint: id.machine.endpoint, machine: id.machine, member, custodian, disk, committeeId: machines[name]?.committeeId ?? null });
    };
    // a restart: the process is gone; a new one opens what the host disk holds
    const restart = (m) => makeMachine(m.name, m.host, { id: m.id, durable: m.disk.durable });

    // ---- 1. genesis by an Enclave machine; a non-Enclave machine cannot ----
    const E1 = await makeMachine("e1", hosts.ea);
    const N0 = await makeMachine("n0", hosts.nb);
    await assert.rejects(N0.member.genesis({ salt: "0x" + "01".repeat(32), codeSet: [N0.machine.measurement] }), /genesis needs a host the vault seats as Enclave/);
    {   // ...and the contract itself refuses it (its Enclave flag is the registry payout)
      const g0 = v2.genesis(), salt = "0x" + "01".repeat(32), codeSet = [N0.machine.measurement];
      const cid0 = D.committeeIdOf({ chainId, vault, salt, Y: g0.Y });
      await reverts(submitter, vault, VAULT_V2_ABI, "createCommittee", [salt, N0.machine, "0x" + Buffer.from(g0.Y).toString("hex"), codeSet,
        await D.signDigest(N0.id.identity, D.genesisDigest({ chainId, vault, committeeId: cid0, Y: g0.Y, machine: N0.machine, codeSet })), N0.member._state().hostSig], /revert/i,
        "genesis by a non-Enclave host is refused by the contract");
    }
    delete machines.n0;
    const reader = createChainReaderV2(readerOpts);
    const durableOf = (m) => JSON.parse(m.disk.durable).member;
    const createsBy = (name) => barrier.filter((b) => b.name === name && b.fn === "createCommittee");
    // the first share write fails: nothing reaches the chain and nothing is durable
    E1.disk.failIf = (s) => Object.keys(s.member?.epochs || {}).length > 0;
    await assert.rejects(E1.member.genesis({ salt: "0x" + "02".repeat(32), codeSet: [E1.machine.measurement] }), /state not persisted/);
    assert.equal(barrier.length, 0, "no createCommittee after a failed share write");
    assert.deepEqual([durableOf(E1).epochs, durableOf(E1).genesis], [{}, undefined]);
    // createCommittee fails before it reaches the chain; the machine restarts and re-sends the SAME durable intent
    failSubmit.add("e1:createCommittee");
    await assert.rejects(E1.member.genesis({ salt: "0x" + "03".repeat(32), codeSet: [E1.machine.measurement] }), /outcome unknown/);
    const intent = durableOf(E1).genesis, cid = intent.committeeId, share1 = JSON.stringify(durableOf(E1).epochs[`${cid}:1`]);
    assert.equal(createsBy("e1")[0].durable.member.epochs[`${cid}:1`].length, 1, "the genesis share was durable when createCommittee was submitted");
    assert.deepEqual(createsBy("e1")[0].durable.member.genesis.args, intent.args, "...and so was the intent");
    assert.equal((await reader.readCommittee({ committeeId: cid })).committee, null, "nothing reached the chain");
    const E1r = await restart(E1); E1r.committeeId = cid;
    assert.deepEqual(E1r.member.committees(), [cid]);
    assert.equal((await E1r.member.tick(cid)).state, "genesis_submitted");
    assert.equal(createsBy("e1").length, 2);
    assert.deepEqual(createsBy("e1")[1].args, createsBy("e1")[0].args, "the same transaction: salt, machine, Y, code set, signatures");
    assert.equal((await E1r.member.tick(cid)).state, "steady", "confirmed from the chain, then served");
    assert.equal(durableOf(E1r).genesis.confirmed, true);
    assert.equal(JSON.stringify(durableOf(E1r).epochs[`${cid}:1`]), share1, "the same share");
    assert.equal(createsBy("e1").length, 2, "one committee, no further genesis");
    let { committee } = await reader.readCommittee({ committeeId: cid });
    assert.deepEqual([committee.epoch, committee.t, committee.W, committee.machines[0].enclave], [1, 1, 1, true]);
    assert.equal("0x" + Buffer.from(committee.Y).toString("hex"), intent.args[2], "the committee key is the intent's");

    // createCommittee lands but its answer is lost: the restarted machine confirms it without a second genesis
    const X = await makeMachine("x", hosts.eb);
    failSubmit.add("x:createCommittee:lost");
    await assert.rejects(X.member.genesis({ salt: "0x" + "05".repeat(32), codeSet: [X.machine.measurement] }), /outcome unknown/);
    const xcid = durableOf(X).genesis.committeeId;
    assert.ok((await reader.readCommittee({ committeeId: xcid })).committee, "it landed");
    const Xr = await restart(X);
    assert.equal((await Xr.member.tick(xcid)).state, "steady", "confirmed from the chain, then served");
    assert.equal(createsBy("x").length, 1, "no second createCommittee");
    assert.equal(durableOf(Xr).genesis.confirmed, true);

    // an unreachable RPC (the real quorum reader): nothing is sent and nothing is invented; once it answers, the same intent
    const Z = await makeMachine("z", hosts.eb);
    failSubmit.add("z:createCommittee");
    await assert.rejects(Z.member.genesis({ salt: "0x" + "06".repeat(32), codeSet: [Z.machine.measurement] }), /outcome unknown/);
    const zcid = durableOf(Z).genesis.committeeId, zBlob = Z.disk.durable;
    const Zdown = await makeMachine("z", hosts.eb, { id: Z.id, durable: zBlob, rpcs: [`http://127.0.0.1:${await freePort()}`] });
    await assert.rejects(Zdown.member.tick(zcid), "an unreadable chain is never read as 'absent'");
    await assert.rejects(Zdown.member.genesis({ salt: "0x" + "07".repeat(32), codeSet: [Z.machine.measurement] }));
    assert.equal(createsBy("z").length, 1, "nothing sent while the chain is unreadable");
    assert.equal(Zdown.disk.durable, zBlob, "nothing changed on disk");
    const Zup = await restart(Zdown);
    assert.equal((await Zup.member.tick(zcid)).state, "genesis_submitted");
    assert.deepEqual(createsBy("z")[1].args, createsBy("z")[0].args, "the same intent");

    // legacy state (an image without intents): a committee created like the live one is served as before; an orphan share is
    // reported with a diagnostic, kept, and never re-created
    const Lid = newIdentity("legacy", hosts.ea), gl = v2.genesis(), lsalt = "0x" + "08".repeat(32), lcodes = [Lid.machine.measurement];
    const lcid = D.committeeIdOf({ chainId, vault, salt: lsalt, Y: gl.Y }).toLowerCase();
    const lHostSig = await D.signDigest(hosts.ea.op, D.hostDigest({ chainId, vault, machine: Lid.machine }));
    await submitTx("createCommittee", [lsalt, Lid.machine, "0x" + Buffer.from(gl.Y).toString("hex"), lcodes,
      await D.signDigest(Lid.identity, D.genesisDigest({ chainId, vault, committeeId: lcid, Y: gl.Y, machine: Lid.machine, codeSet: lcodes })), lHostSig]);
    const legacyState = (k, shares) => JSON.stringify({ member: { epochs: { [`${k}:1`]: shares }, pending: {}, hostSig: lHostSig, candidates: {} } });
    const L = await makeMachine("legacy", hosts.ea, { id: Lid, durable: legacyState(lcid, gl.shares.map((x) => ({ k: x.k, x: x.x.toString(16).padStart(64, "0") }))) });
    assert.equal((await L.member.tick(lcid)).state, "steady", "the legacy committee is served");
    assert.equal(durableOf(L).genesis, undefined, "no intent invented");
    const orphan = sha("orphan committee");
    const O = await makeMachine("orphan", hosts.ea, { durable: legacyState(orphan, [{ k: 1, x: "44".repeat(32) }]) });
    const ro = await O.member.tick(orphan);
    assert.equal(ro.state, "no_committee"); assert.match(ro.reason, /LEGACY ORPHAN/);
    assert.deepEqual(Object.keys(durableOf(O).epochs), [`${orphan}:1`], "the orphan share is kept");
    assert.equal(createsBy("legacy").length + createsBy("orphan").length, 0, "nothing re-sent");
    for (const n of ["x", "z", "legacy", "orphan"]) delete machines[n];

    // ---- 2. an owner publishes, and an app guest unlocks at t = 1 ----
    const owner = await acct();
    const id = "0x" + randomBytes(32).toString("hex");
    await send(admin, ledger, C.ledger.abi, "set", [id, owner.address, hosts.app.registryId, hosts.app.op.address, BigInt((await nowBlock()) + 7200)]);
    const env = { API_KEY: "v2-secret", DB: "postgres://x" };
    const bundle = buildBundleV2({ chainId, vault, id, secretRev: 1, committeeId: cid, Y: committee.Y, env, configText: "" });
    await send(owner, vault, UPDATE_V2_ABI, "update", [id, makeUpdateV2({ expectPolicyRev: 0, policy: { committeeId: cid, paused: false, rules: RULES }, bundle })]);

    const unlock = async (useMachines, { expectEnclaveRule = true } = {}) => {
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
      // the guest's choice: exactly ONE Enclave machine's partials (if any answered), then other seats
      const encl = got.filter((x) => x.enclave), others = got.filter((x) => !x.enclave);
      const chosen = expectEnclaveRule && encl.length ? [...encl[0].parts] : [];
      for (const o of (expectEnclaveRule ? others : got)) for (const p of o.parts) if (chosen.length < com.t && !chosen.some((c) => c.k === p.k)) chosen.push(p);
      const S2 = v2.combine(chosen.slice(0, com.t), com.t);
      return v2.decryptBundle({ S: S2, label: v2.labelOf({ chainId, vault, id, secretRev: st.policy.secretRev, committeeId: cid }), bundle: st.bundle.data }).env;
    };
    assert.deepEqual(await unlock([E1r]), env, "t = 1: the (restarted) Enclave seat alone unlocks");

    // ---- 3. candidates join; the Enclave seat coordinates a handover through the contract ----
    const E1x = E1r;
    let E2 = await makeMachine("e2", hosts.eb), NB = await makeMachine("nb", hosts.nb), NC = await makeMachine("nc", hosts.nc);
    for (const m of [E2, NB, NC]) m.committeeId = cid;
    await assert.rejects(E1x.member.join({ machine: NB.machine }, cid), /proof of capacity/, "a non-Enclave candidate without capacity proof is refused");
    capacityOk.add(NB.machine.identity); capacityOk.add(NC.machine.identity);
    for (const m of [E2, NB, NC]) assert.ok((await E1x.member.join({ machine: m.machine }, cid)).ok);
    let r = await E1x.member.tick(cid);
    assert.equal(r.state, "batching", "changes wait for the batching window");
    skew += BATCH_MS + 1000;
    r = await E1x.member.tick(cid);
    assert.equal(r.state, "proposed", JSON.stringify(r));
    // deals, then every new machine verifies, persists and acks; the last ack activates the epoch. NC's first ack
    // submission fails AFTER its share is durable; NC then restarts from its disk and acks the same share again.
    failSubmit.add("nc:ackHandover");
    let ncFailed = null;
    for (let i = 0; i < 8 && (await reader.readCommittee({ committeeId: cid })).committee.epoch === 1; i++) {
      for (const m of [E1x, E2, NB, NC]) {
        try { await m.member.tick(cid); }
        catch (e) {
          if (m === NC && !ncFailed && /rpc down/.test(e.message)) { ncFailed = JSON.parse(NC.disk.durable); NC = await restart(NC); continue; }
          throw new Error(`${m.name}: ${e.message}`);
        }
      }
    }
    assert.ok(ncFailed, "NC's first ack failed");
    ({ committee } = await reader.readCommittee({ committeeId: cid }));
    assert.equal(committee.epoch, 2, "the handover activated (the restarted NC's re-sent ack was accepted)");
    const toEpoch = 2, pkey = `${cid}:${toEpoch}`;
    const ncAcks = barrier.filter((b) => b.name === "nc" && b.fn === "ackHandover");
    assert.equal(ncAcks.length, 2, "NC acked twice: the failed submission and the re-sent one");
    assert.deepEqual(ncAcks[1].durable.member.pending[pkey], ncFailed.member.pending[pkey], "the re-sent ack is for the SAME durable share");
    assert.equal(ncAcks[0].args[2], ncAcks[1].args[2], "...and the same new commitments");
    for (const b of barrier.filter((x) => x.fn === "ackHandover"))
      assert.ok(b.durable?.member?.pending?.[pkey]?.length > 0, `${b.name}: its new share was durable when its ack was submitted`);
    assert.deepEqual(barrier.filter((x) => x.fn === "ackHandover").map((b) => b.name).sort(), ["e1", "e2", "nb", "nc", "nc"]);
    for (const m of [E1x, E2, NB, NC]) await m.member.tick(cid);
    assert.equal(committee.machines.length, 4);
    assert.deepEqual([committee.t, committee.W], [2, 3], "3 seats (one Enclave seat for two Enclave machines): t = 2");
    assert.equal(Buffer.from(committee.Y).toString("hex"), Buffer.from(intent.args[2].slice(2), "hex").toString("hex"), "the committee key never changed");
    assert.deepEqual(E1x.member.shares.get(cid, 1), [], "old-epoch shares are erased after activation");
    assert.deepEqual(JSON.parse(E1x.disk.durable).member.epochs[`${cid}:1`], undefined, "...durably");
    assert.deepEqual(E1x.member.shares.get(cid, committee.epoch).map((s) => s.k), E2.member.shares.get(cid, committee.epoch).map((s) => s.k), "Enclave replicas hold the same index");
    assert.equal(E1x.member.shares.get(cid, committee.epoch)[0].x, E2.member.shares.get(cid, committee.epoch)[0].x, "...and the same share");

    // ---- t = 2: exactly one Enclave machine + one other host unlock ----
    assert.deepEqual(await unlock([E1x, NB]), env);
    assert.deepEqual(await unlock([E2, NC]), env, "the restarted NC releases from its durable, activated share");
    assert.deepEqual(await unlock([E1x, E2, NB, NC]), env, "all answer: one Enclave partial used");
    await assert.rejects(unlock([E1x, E2], { expectEnclaveRule: false }), /exactly 2 distinct/, "two Enclave machines are ONE seat: they cannot reach t");
    assert.deepEqual(await unlock([NB, NC]), env, "no Enclave machine online: the other seats suffice");

    // ---- 4. the address book is the original vault's release authority ----
    await reverts(outsider, book, C.book.abi, "set", [key("registry"), ZERO], /!owner|revert/i, "only the book's admin edits it");
    await send(admin, book, C.book.abi, "set", [key("registry"), ZERO]);
    await assert.rejects(unlock([NB, NC]), /address book has no|release_authority|only 0 RPCs/, "a cleared registry entry fails release closed");
    await send(admin, book, C.book.abi, "set", [key("registry"), registry]);
    assert.deepEqual(await unlock([NB, NC]), env, "restored by the admin");

    // ---- 5. the relay's v2 pointer for the guest's signed release (relay/custody-state.mjs) ----
    const relayReader = createCustodyReader({ vault2: vault, chainId, rpcs: [anvil.url], minAgree: 1, maxAgeSec: null });
    const ptr = await relayReader.custodyStateFor(id);
    assert.equal(ptr.v, 2); assert.equal(ptr.vault, vault); assert.equal(ptr.committeeId, cid); assert.equal(ptr.t, 2); assert.equal(ptr.epoch, committee.epoch);
    assert.equal(typeof ptr.policyRev, "string"); assert.equal(ptr.commitments.length, 2 * 33 * 2);
    assert.deepEqual(ptr.machines.map((m) => [m.enclave, m.indices]), committee.machines.map((m) => [m.enclave, m.enclave ? [1] : null]).map(([e, k], i) => [e, k || ptr.machines[i].indices]));
    assert.deepEqual(new Set(ptr.machines.filter((m) => !m.enclave).flatMap((m) => m.indices)), new Set([2, 3]));
    assert.equal(await relayReader.custodyHeld(id), true);
    assert.equal(await relayReader.custodyHeld("0x" + "ab".repeat(32)), false);
  } finally { anvil.stop(); }
});
