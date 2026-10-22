// The REAL supervisor.js (candidate) in independent direct mode, deciding from REAL contracts on anvil (chain 8453, the
// shared rig: schema-16 ledger, schema-4 registry, catalog) through the operator's RPC quorum (network/direct-chain.mjs),
// behind three JSON-RPC proxies this test controls: any of them can lie about one contract call (by selector and target),
// about the pending nonce, or about contract code. Only guestd, the package replicas and the final send of the operator's
// transactions are scripted (DIRECT_CLAIM_SELFTEST "chain":"quorum"); every chain READ is real and agreed.
//   * honest quorum: the direct deployment is claimed and launched;
//   * a liar listed FIRST beside an honest majority (2 of 3): the same outcome, which no first-answer fallback would give;
//   * for EVERY contract call the claim path reads (found from the honest run, not hand-listed): one liar with a
//     unanimous quorum (3 of 3) refuses the claim, before any transaction;
//   * pending-nonce disagreement: the boot fence stays unknown and a live lease is not resumed;
//   * the host owner's wallet veto (EnclaveHostOwnership, deployed here): deny, owner choice over Enclave catalog refusal,
//     no owner, stale revision / replayed old policy, wrong code, another host's config, disagreeing peers, and an
//     independent host without a wallet policy that keeps accepting.
// Only anvil's published dev keys are used. Nothing leaves 127.0.0.1.
import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { keccak256, toFunctionSelector, parseUnits, encodeDeployData, getAddress, toHex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { startRig, haveTools, KEYS, freePort } from "./helpers/cli-independent-rig.mjs";
import { startLyingPeers } from "./helpers/lying-peers.mjs";
import { preparePackage } from "../sdk/bootstrap/package.mjs";
import { hostAdmissionPolicyHash } from "../network/host-admission-policy.mjs";
import { artifactIdentity } from "../sdk/storage/unixfs.mjs";
const cidOf = (text) => artifactIdentity(new Uint8Array(Buffer.from(text))).cid;

const exec = promisify(execFile);
const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const skip = haveTools();
const T = skip ? { skip } : { timeout: 600000 };
const OUT = path.join(REPO, "contracts", "foundry", "out");
const art = (file, name) => { const j = JSON.parse(fs.readFileSync(path.join(OUT, file, name + ".json"), "utf8")); return { abi: j.abi, bytecode: j.bytecode.object, runtime: j.deployedBytecode.object }; };
const ZERO = "0x" + "00".repeat(20), tier = "snp-guest-per-app", RUNTIME = "55".repeat(32);
const A = "http://192.0.2.10:8189/ipfs", B = "http://192.0.2.11:8189/ipfs";
const health = { backend: tier, catalog: { runtimeId: RUNTIME, derivations: ["enclave-catalog-bundle/1"] }, supports: { directBootstrap: true, gpu: false, protectedPorts: true },
  pool: { budget: { memMiB: 32768, cpuPct: 800 }, allocated: { memMiB: 0, cpuPct: 0 }, free: { memMiB: 32768, cpuPct: 800 }, guests: 0, overcommitted: false,
    perGuest: { floorMiB: 1024, runtimeMiB: 384, unitOverheadMiB: 768 }, hostAvailableMiB: 65536, hostFloorMiB: 16384 } };

let rig, tmp, peers, ownership, ownershipCode;
const sel = (sig) => toFunctionSelector(sig).toLowerCase();

// ---- a funded, owner-committed direct deployment on the real ledger ----------------------------------------------------
async function directDeployment({ appRef = rig.directRef } = {}) {
  const L = rig.addresses.ledger, abi = rig.A.ledger.abi, ownerW = rig.wc(KEYS.owner);
  const rc = await rig.write(ownerW, L, abi, "create", [appRef, 0, 100, 8080, "http:8080", true, "", ZERO, 0n, 100000n]);
  const id = rig.createdId(rc);
  const manifest = { version: 1, chainId: 8453, ledger: L.toLowerCase(), deployment: id.toLowerCase(), owner: rig.owner, appRef,
    appId: "45".repeat(32), runtimeId: RUNTIME, configText: '{"endpoint":"https://owner-chosen.example"}', secretsMode: "public" };
  const pkg = preparePackage(manifest);
  await rig.write(ownerW, L, abi, "setConfig", [id, JSON.stringify({ guestBootstrap: pkg.intent })]);
  await rig.write(ownerW, rig.addresses.usdc, rig.A.usdc.abi, "approve", [L, parseUnits("1", 6)]);
  await rig.write(ownerW, L, abi, "fund", [id, parseUnits("1", 6)]);
  return { id, pkg };
}

function env(extra = {}) {
  const dir = fs.mkdtempSync(path.join(tmp, "sup-"));
  const pins = path.join(dir, "pins.json"); fs.writeFileSync(pins, JSON.stringify(rig.pins));
  return { PATH: process.env.PATH, HOME: dir, SECRET: "ab".repeat(32), ENABLE_MPS: "0", STATE_FILE: path.join(dir, "state.json"), SESSION_KEY_DIR: path.join(dir, "session"),
    ISOLATION_DIRECT_ONLY: "1", ISOLATION_BACKEND: tier, PROVISION_BACKEND: "vm", ENCLAVE_CONTRACT_PINS_FILE: pins, ADDRESS_BOOK_ADDRESS: "",
    SECRETS_API: "", DOMAINS_API: "", CERTS_API: "", DNS_API: "", APP_CERT_DOMAIN: "", ISOLATION_RELEASE: "",
    GUEST_BOOTSTRAP_GATEWAYS: `${A},${B}`, IPFS_GATEWAY: JSON.stringify([A, B].map((g) => new URL(g).origin)),
    REGISTRY_ENABLED: "1", REGISTRY_PRIVATE_KEY: KEYS.operator, ENCLAVE_REPO: "independent/host", CLAIM_ENABLED: "1", SELL_CPU_PRICE6: "1000",
    BASE_RPCS: peers.map((p) => p.url).join(","), CHAIN_QUORUM: "2", CHAIN_CONFIRMATIONS: "0", CHAIN_MAX_BLOCK_AGE_SEC: "60", ...extra };
}
async function sweep(ids, { extra = {}, bytes } = {}) {
  const config = { chain: "quorum", hint: true, ids, health, appId: "45".repeat(32), bytes, enclaveId: rig.runner, endpoint: rig.endpoint,
    leaseUntil: Math.floor(Date.now() / 1000) + 3600, replicas: { [A]: "serve", [B]: "serve" } };
  const e = env(extra); for (const k of Object.keys(e)) if (e[k] === undefined) delete e[k];
  const { stdout, stderr } = await exec(process.execPath, ["supervisor.js"], { cwd: REPO, timeout: 120000, maxBuffer: 8 << 20,
    env: { ...e, DIRECT_CLAIM_SELFTEST: JSON.stringify(config) } }).catch((x) => { throw new Error((x.stderr || x.message).slice(-4000)); });
  const line = stdout.trim().split("\n").reverse().find((l) => l.startsWith('{"calls"'));
  if (!line) throw new Error("the supervisor printed no result:\n" + (stdout + stderr).slice(-3000));
  return { ...JSON.parse(line), log: stdout + stderr };
}
const claimed = (out, id) => out.txs.some((t) => t.functionName === "claim" && t.args[0].toLowerCase() === id.toLowerCase());

before(async () => {
  if (skip) return;
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "direct-quorum-"));
  rig = await startRig();
  peers = await startLyingPeers(rig.rpc, { stops: rig.stops });
  // the host-ownership contract, on the rig's registry; its code hash is what an operator pins from the reviewed profile
  const O = art("EnclaveHostOwnership.sol", "EnclaveHostOwnership");
  ownership = await rig.deploy({ abi: O.abi, bytecode: O.bytecode, linkReferences: {} }, [rig.addresses.registry]);
  ownershipCode = keccak256(await rig.pc.getCode({ address: ownership }));
  rig.O = O;
  // the direct app: published by the catalog owner (approved on publish), on a port this supervisor serves
  await rig.write(rig.wc(KEYS.deployer), rig.addresses.catalog, rig.A.catalog.abi, "publishVersion", ["directapp", "Direct app", "a direct test app", "1",
    cidOf("direct app component"), [0, 0, 64, 1], "", "{}", 0n]);
  const directId = await rig.pc.readContract({ address: rig.addresses.catalog, abi: rig.A.catalog.abi, functionName: "appIdOf", args: [privateKeyToAccount(KEYS.deployer).address, "directapp"] });
  rig.directRef = `catalog://${directId}/0`;
});
after(async () => { await rig?.stop(); if (tmp) fs.rmSync(tmp, { recursive: true, force: true }); });

let authoritySelectors = null;
test("honest quorum: the direct deployment is claimed and launched; every read is agreed, only pinned contracts are read", T, async () => {
  peers.honest();
  const { id, pkg } = await directDeployment();
  const out = await sweep([id], { bytes: pkg.bytes.toString("base64"), extra: { CHAIN_QUORUM: "3" } });
  assert.equal(out.fence, "clear", JSON.stringify(out));
  assert.ok(claimed(out, id), JSON.stringify(out.declines));
  assert.equal(out.records[id]?.status, "running", JSON.stringify(out));
  assert.ok(out.calls.every((u) => u.startsWith(A + "/") || u.startsWith(B + "/")), "no fetch but the operator's replicas: " + JSON.stringify(out.calls));
  const pinned = new Set([rig.addresses.ledger, rig.addresses.catalog, rig.addresses.registry].map((x) => x.toLowerCase()));
  const calls = peers.flatMap((p) => p.ctl.calls.filter((c) => c.method === "eth_call"));
  assert.ok(calls.length > 0 && calls.every((c) => pinned.has(c.to)), JSON.stringify([...new Set(calls.map((c) => c.to))]));
  // every peer answered the same calls: three votes per read, nothing asked of one RPC alone
  const per = peers.map((p) => p.ctl.calls.filter((c) => c.method === "eth_call").length);
  assert.ok(per.every((n) => n > 0), JSON.stringify(per));
  authoritySelectors = [...new Map(calls.map((c) => [c.to + c.sel, c])).values()];
});

test("a liar listed FIRST beside an honest majority (2 of 3) cannot change the outcome: no first-answer read", T, async () => {
  peers.honest(); peers[0].ctl.lies = [{}];            // peer 0 lies on EVERY eth_call
  const { id, pkg } = await directDeployment();
  const out = await sweep([id], { bytes: pkg.bytes.toString("base64"), extra: { CHAIN_QUORUM: "2" } });
  assert.ok(claimed(out, id), JSON.stringify(out.declines));
  assert.equal(out.records[id]?.status, "running");
});

test("every contract call the claim path makes, contradicted by one peer under a unanimous quorum, refuses the claim before any transaction", T, async () => {
  assert.ok(authoritySelectors?.length >= 5, "the honest run found the claim path's reads");
  const failures = [];
  for (const call of authoritySelectors) {
    peers.honest(); peers[1].ctl.lies = [{ to: call.to, sel: call.sel }];
    const { id, pkg } = await directDeployment();
    const out = await sweep([id], { bytes: pkg.bytes.toString("base64"), extra: { CHAIN_QUORUM: "3" } });
    if (claimed(out, id) || out.posted.length) failures.push(`${call.to}:${call.sel} still claimed`);
    // the reason is the sweep's decline, or (the claim-bond gate, which refuses inside tryClaim) the supervisor's log line
    else assert.ok(out.declines[id] || /\[bond\] cannot satisfy the claim bond .*not claiming/.test(out.log), `${call.to}:${call.sel} has a stated reason`);
  }
  assert.deepEqual(failures, [], `authority reads covered: ${authoritySelectors.map((c) => c.sel).join(",")}`);
});

test("pending-nonce disagreement: the boot fence stays unknown and this host's live lease is not resumed", T, async () => {
  peers.honest();
  const { id, pkg } = await directDeployment();
  // this operator holds a live lease on chain (a previous life of the host)
  await rig.write(rig.wc(KEYS.operator), rig.addresses.ledger, rig.A.ledger.abi, "claim", [id, rig.runner]);
  peers[2].ctl.nonce = true;
  const out = await sweep([id], { bytes: pkg.bytes.toString("base64"), extra: { CHAIN_QUORUM: "3" } });
  assert.equal(out.fence, "unknown");
  assert.match(out.declines[id] || "", /not resolved yet \(unknown\); not resuming/);
  assert.equal(out.posted.length, 0); assert.equal(out.txs.length, 0);
  // with agreement the same lease IS resumed (no transaction: it is already this host's)
  peers.honest();
  const ok = await sweep([id], { bytes: pkg.bytes.toString("base64"), extra: { CHAIN_QUORUM: "3" } });
  assert.equal(ok.fence, "clear"); assert.equal(ok.records[id]?.status, "running", JSON.stringify(ok)); assert.equal(ok.txs.length, 0);
});

// ---- the host owner's wallet veto --------------------------------------------------------------------------------------
const policy = (o = {}) => ({ version: 1, chainId: 8453, ownershipContract: ownership.toLowerCase(), hostId: rig.runner.toLowerCase(),
  requireCatalogApproval: false, denyDeployments: [], denyAppRefs: [], ...o });
function policyDir(docs) {
  const d = fs.mkdtempSync(path.join(tmp, "pol-"));
  for (const p of docs) fs.writeFileSync(path.join(d, hostAdmissionPolicyHash(p) + ".json"), JSON.stringify(p));
  return d;
}
const walletEnv = (dir, o = {}) => ({ ENCLAVE_HOST_OWNERSHIP: ownership.toLowerCase(), ENCLAVE_HOST_REGISTRY_PIN: rig.pins.contracts.registry,
  ENCLAVE_HOST_CATALOG_PIN: rig.pins.contracts.appCatalog, ENCLAVE_HOST_POLICY_DIR: dir, ENCLAVE_HOST_ID: rig.runner.toLowerCase(),
  ENCLAVE_HOST_OWNERSHIP_CODEHASH: ownershipCode, CHAIN_QUORUM: "3", ...o });
const ownWrite = (who, fn, args) => rig.write(rig.wc(who), ownership, rig.O.abi, fn, args);

test("wallet veto: no owner refuses everything; the owner's committed policy decides; the CURRENT revision only", T, async () => {
  peers.honest();
  const { id, pkg } = await directDeployment();
  const deny = policy({ denyDeployments: [id.toLowerCase()] }), open = policy();
  const run = (dir, o) => sweep([id], { bytes: pkg.bytes.toString("base64"), extra: walletEnv(dir, o) });
  // nominated but not accepted: no owner on chain -> every deployment refused, stated
  await ownWrite(KEYS.operator, "proposeOwner", [rig.runner, privateKeyToAccount(KEYS.other).address]);
  let out = await run(policyDir([deny, open]));
  assert.ok(!claimed(out, id)); assert.match(out.declines[id], /host wallet policy unavailable/);
  // the wallet accepts; no policy committed (hash 0): accepted, nothing denied
  await ownWrite(KEYS.other, "acceptOwner", [rig.runner]);
  out = await run(policyDir([]));
  assert.ok(claimed(out, id), JSON.stringify(out.declines));
  // the owner commits the deny policy: refused by the owner's word
  await ownWrite(KEYS.other, "setPolicy", [rig.runner, hostAdmissionPolicyHash(deny)]);
  out = await run(policyDir([deny]));
  assert.ok(!claimed(out, id)); assert.match(out.declines[id], /this host owner declines this deployment/);
  // a new revision (the open policy) while the guest still holds only the OLD document: refused until the current one is there
  await ownWrite(KEYS.other, "setPolicy", [rig.runner, hostAdmissionPolicyHash(open)]);
  out = await run(policyDir([deny]));
  assert.ok(!claimed(out, id)); assert.match(out.declines[id], /host wallet policy unavailable/);
  out = await run(policyDir([deny, open]));
  assert.ok(claimed(out, id), "the current revision's document applies, the replayed old one is ignored: " + JSON.stringify(out.declines));
});

test("wallet veto fails closed on wrong code, another host's config and disagreeing peers; Enclave catalog refusal is the owner's to override", T, async () => {
  peers.honest();
  const { id, pkg } = await directDeployment();
  const dir = policyDir([policy()]);
  const run = (o, ids = [id], b = pkg) => sweep(ids, { bytes: b.bytes.toString("base64"), extra: walletEnv(dir, o) });
  assert.ok(claimed(await run({}), id), "baseline: the open policy accepts");
  let out = await run({ ENCLAVE_HOST_OWNERSHIP_CODEHASH: keccak256("0x00") });
  assert.ok(!claimed(out, id)); assert.match(out.declines[id], /does not carry the reviewed code/);
  out = await run({ ENCLAVE_HOST_ID: "0x" + "77".repeat(32) });
  assert.ok(!claimed(out, id)); assert.match(out.declines[id], /belongs to another host/);
  peers[0].ctl.lies = [{ to: ownership.toLowerCase() }];
  out = await run({});
  assert.ok(!claimed(out, id)); assert.match(out.declines[id], /host wallet policy unavailable/);
  peers.honest(); peers[2].ctl.code = true;
  out = await run({});
  assert.ok(!claimed(out, id), "a peer reporting other code is a disagreement, refused");
  peers.honest();
  // an app the Enclave catalog has NOT approved (published by someone other than the catalog owner: pending)
  await rig.write(rig.wc(KEYS.other), rig.addresses.catalog, rig.A.catalog.abi, "publishVersion", ["pendingapp", "Pending", "unapproved", "1",
    cidOf("pending app component"), [0, 0, 64, 1], "", "{}", 0n]);
  const pendingId = await rig.pc.readContract({ address: rig.addresses.catalog, abi: rig.A.catalog.abi, functionName: "appIdOf", args: [privateKeyToAccount(KEYS.other).address, "pendingapp"] });
  const pend = await directDeployment({ appRef: `catalog://${pendingId}/0` });
  out = await run({}, [pend.id], pend.pkg);
  assert.ok(claimed(out, pend.id), "the owner's policy (no catalog requirement) accepts what Enclave's catalog has not approved: " + JSON.stringify(out.declines));
  const strict = policyDir([policy({ requireCatalogApproval: true })]);
  await ownWrite(KEYS.other, "setPolicy", [rig.runner, hostAdmissionPolicyHash(policy({ requireCatalogApproval: true }))]);
  out = await sweep([pend.id], { bytes: pend.pkg.bytes.toString("base64"), extra: walletEnv(strict) });
  assert.ok(!claimed(out, pend.id)); assert.match(out.declines[pend.id], /requires current catalog approval/);
  // without any wallet policy, catalog approval governs as it always has
  out = await sweep([pend.id], { bytes: pend.pkg.bytes.toString("base64"), extra: { CHAIN_QUORUM: "3" } });
  assert.ok(!claimed(out, pend.id)); assert.match(out.declines[pend.id], /not_approved|approv/i);
  await ownWrite(KEYS.other, "setPolicy", [rig.runner, hostAdmissionPolicyHash(policy())]);
});

test("an independent host with no wallet policy keeps accepting what another host's owner denies", T, async () => {
  peers.honest();
  const { id, pkg } = await directDeployment();
  // a SECOND host, with its own owner who denies this deployment there
  const other = "https://second.independent.test", otherId = keccak256(toHex(other));
  await rig.write(rig.wc(KEYS.deployer), rig.addresses.registry, rig.A.registry4.abi, "register", [other, "independent/host", "0x" + "00".repeat(32), 1000n, 0n, ZERO]);
  await ownWrite(KEYS.deployer, "proposeOwner", [otherId, privateKeyToAccount(KEYS.owner).address]);
  await ownWrite(KEYS.owner, "acceptOwner", [otherId]);
  const theirs = { ...policy({ denyDeployments: [id.toLowerCase()] }), hostId: otherId.toLowerCase() };
  await ownWrite(KEYS.owner, "setPolicy", [otherId, hostAdmissionPolicyHash(theirs)]);
  // this host: no wallet configuration at all -> unaffected by any wallet
  const out = await sweep([id], { bytes: pkg.bytes.toString("base64"), extra: { CHAIN_QUORUM: "3" } });
  assert.ok(claimed(out, id), JSON.stringify(out.declines));
  // and a local file cannot import that policy into this host: it is committed for another host id
  const out2 = await sweep([id], { bytes: pkg.bytes.toString("base64"), extra: walletEnv(policyDir([theirs, policy()])) });
  assert.ok(claimed(out2, id), "this host's own owner commitment decides, not a file naming another host: " + JSON.stringify(out2.declines));
});

test("direct mode refuses to start without a quorum of the operator's RPCs or an ownership code pin", T, async () => {
  for (const [extra, why] of [[{ BASE_RPCS: "" }, /BASE_RPCS/], [{ BASE_RPCS: peers[0].url }, /BASE_RPCS/], [{ CHAIN_QUORUM: "4" }, /CHAIN_QUORUM 4 exceeds/],
    [{ ENCLAVE_HOST_OWNERSHIP: ownership.toLowerCase(), ENCLAVE_HOST_REGISTRY_PIN: rig.pins.contracts.registry, ENCLAVE_HOST_CATALOG_PIN: rig.pins.contracts.appCatalog, ENCLAVE_HOST_POLICY_DIR: tmp }, /ENCLAVE_HOST_OWNERSHIP_CODEHASH must pin/]]) {
    const e = env(extra);
    const r = await exec(process.execPath, ["supervisor.js"], { cwd: REPO, env: { ...e, DIRECT_CLAIM_SELFTEST: "{}" }, timeout: 60000 }).then(() => null, (x) => x);
    assert.equal(r?.code, 2, why.source); assert.match(r.stderr, why);
  }
});
