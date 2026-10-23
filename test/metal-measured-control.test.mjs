// The measured independent control guest (metal/guest/measured-control.mjs, metal/measured-control-verify.mjs, the
// direct branch of metal/guest/gsup.mjs and the launcher/builder hooks). What runs here, and what it can and cannot show:
//   * the guest helper and the verifier are the ACTUAL source;
//   * the SEV-SNP evidence is SYNTHETIC: test/helpers/snp-synth.mjs builds an AMD-SHAPED chain whose ARK this test pins
//     explicitly (the real AMD pin refuses it). It exercises every verifier branch end to end, and proves nothing about a
//     real guest measurement, which needs SEV-SNP hardware;
//   * the supervisor in the end-to-end case is the REAL supervisor.js, started with the environment planDirectBoot
//     derives and the keys mintControlKeys wrote, behind the real control front;
//   * the launcher is the REAL metal/enclave-metal.mjs, with a fake QEMU that records its arguments and the fw_cfg file.
// Every generated key is disposable. Nothing leaves 127.0.0.1 (the supervisor runs under the loopback-only fetch hook).
import test, { after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import net from "node:net";
import http from "node:http";
import path from "node:path";
import { spawn, execFileSync } from "node:child_process";
import { createHash, generateKeyPairSync, randomBytes, X509Certificate, createPrivateKey } from "node:crypto";
import { fileURLToPath } from "node:url";
import * as viem from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { synthChain, synthReport } from "./helpers/snp-synth.mjs";
import { memoryCollateral } from "../verifier/collateral.mjs";
import { TCB_FLOORS } from "../verifier/metal-box.mjs";
import * as MC from "../metal/guest/measured-control.mjs";
import { verifyMeasuredControl, registryIdOf } from "../metal/measured-control-verify.mjs";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "measured-control-"));
const children = [], servers = [];
after(() => { for (const c of children) try { c.kill("SIGKILL"); } catch {} for (const s of servers) { try { s.closeAllConnections?.(); s.close(); } catch {} } fs.rmSync(tmp, { recursive: true, force: true }); });
const freePort = () => new Promise((ok) => { const s = net.createServer(); s.listen(0, "127.0.0.1", () => { const p = s.address().port; s.close(() => ok(p)); }); });
const sha = (...b) => createHash("sha256").update(Buffer.concat(b.map((x) => Buffer.from(x)))).digest();

// ---- a disposable owner configuration ---------------------------------------------------------------------------------------
const OPERATOR_KEY = "0x" + randomBytes(32).toString("hex");                 // disposable, generated per run
const OPERATOR = privateKeyToAccount(OPERATOR_KEY).address.toLowerCase();
const PAIR = randomBytes(32).toString("hex");
const a = (n) => "0x" + n.toString(16).padStart(40, "0");
const RAW = () => ({
  format: MC.CONFIG_FORMAT, chainId: 8453,
  contracts: { registry: a(0x11), deployments: a(0x12), appCatalog: a(0x13), proofOfTime: a(0x14), enclavePay: a(0), verificationFees: a(0), sessionVaultFactory: a(0), secretVaultV2: a(0) },
  profileDigest: null, rpcs: ["https://rpc-a.example/v1", "https://rpc-b.example"], quorum: 2, releaseId: "ab".repeat(32),
  replicas: { gateways: ["http://192.0.2.10:8189", "https://replica.example"], storagePlan: null },
  identity: { publicUrl: "https://host.example.org", repo: "owner/enclave", operator: OPERATOR },
  selling: { cpuPrice6: 14, payout: null }, isolation: { managerUrl: "http://10.0.2.2:8095", dataAddr: "10.0.2.2:8096" },
  hostAdmissionSha256: null, controlPort: 8444,
});
const CMDLINE = "console=ttyS0 root=/dev/ram0 rootfstype=ramfs quiet metal.mode=snp metal.isolation=snp-guest-per-app metal.control=direct";
const CONFIG = MC.canonicalDirectConfig(RAW()), DIGEST = MC.configDigest(CONFIG), HOST_DATA = MC.hostDataHex(DIGEST);
const fwFor = (over = {}) => ({ mode: "snp", name: "ctl", direct: RAW(), isolation: { managerUrl: "http://10.0.2.2:8095", dataAddr: "10.0.2.2:8096", pairingKey: PAIR }, registryKey: OPERATOR_KEY, ...over });
let pathN = 0;
const guestPaths = () => { const d = path.join(tmp, `guest-${++pathN}`); fs.mkdirSync(d);
  return { ...MC.GUEST_PATHS, runDir: d, pins: path.join(d, "pins.json"), storagePlan: path.join(d, "plan.json"), pairKey: path.join(d, "pair.key"), sessionDir: path.join(d, "session"),
    acmeDir: path.join(d, "acme"), statement: path.join(d, "statement.json"), tlsKey: path.join(d, "tls-key.pem"), tlsCert: path.join(d, "tls-cert.pem"), serveConfig: path.join(d, "serve.json"), status: path.join(d, "status.json") }; };

// ---- 1. the owner's config and its binding ----------------------------------------------------------------------------------
test("the direct config is strict and canonical; its digest names it exactly and HOST_DATA derives from it", () => {
  const reverse = (v) => Array.isArray(v) ? v.map(reverse) : v && typeof v === "object" ? Object.fromEntries(Object.keys(v).reverse().map((k) => [k, reverse(v[k])])) : v;
  const shuffled = reverse(RAW());
  assert.notDeepEqual(Object.keys(shuffled), Object.keys(RAW()));
  assert.equal(MC.configDigest(MC.canonicalDirectConfig(shuffled)), DIGEST, "key order is not identity");
  assert.equal(HOST_DATA, MC.sha256Hex(`enclave-measured-control/v1\nconfig ${DIGEST}\n`));
  const refuse = (mut, re) => { const r = RAW(); mut(r); assert.throws(() => MC.canonicalDirectConfig(r), re); };
  refuse((r) => { r.extra = 1; }, /unknown field/);
  refuse((r) => { r.rpcs[0] = "http://rpc-a.example/v1"; }, /must be https/);
  refuse((r) => { r.rpcs[1] = "https://RPC-A.example./x"; }, /repeats a host/);
  refuse((r) => { r.rpcs = [r.rpcs[0]]; }, /2 to 8/);
  refuse((r) => { r.rpcs[1] = "https://rpc-b.example/"; }, /normalized form \(https:\/\/rpc-b\.example\)/);
  refuse((r) => { r.quorum = 3; }, /quorum/);
  refuse((r) => { r.contracts.registry = a(0); }, /nonzero/);
  refuse((r) => { r.identity.publicUrl = "https://metal0.enclave.host"; }, /Enclave relay name/);
  refuse((r) => { r.replicas.gateways[0] = "http://replica.example:8189"; }, /literal IPv4/);
  refuse((r) => { r.isolation.managerUrl = "http://guestd.local:8095"; }, /IPv4/);
  refuse((r) => { r.controlPort = 8080; }, /another guest service/);
  refuse((r) => { r.chainId = 1; }, /chainId/);
  const changed = RAW(); changed.selling.cpuPrice6 = 15;
  assert.notEqual(MC.configDigest(MC.canonicalDirectConfig(changed)), DIGEST, "every field is bound");
});

test("planDirectBoot: a bound config yields the direct-only supervisor; the real supervisor's rules accept its environment", async () => {
  const flavorEnv = { ADDRESS_BOOK_ADDRESS: "0xab214342d5A490150A4A977063A2f88E21F80907", PAYOUT_ADDRESS: "0x0b2d009c0c9Af05b12100D77F3c815fea822eE61",
    SIWE_DOMAIN: "enclave.host", CHAIN_ID: "8453", USDC_ADDRESS: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913" };
  const p = await MC.planDirectBoot({ cmdline: CMDLINE, fw: fwFor(), reportHostData: HOST_DATA, flavorEnv, viem });
  assert.equal(p.ok, true, p.reasons?.join("; "));
  assert.equal(p.bound, true); assert.equal(p.operator, OPERATOR); assert.equal(p.digest, DIGEST);
  assert.deepEqual(MC.directEnvProblems(p.env), []);
  const { directOnlyEnvProblems } = await import("../cli/host-independent-lifecycle.mjs");
  assert.deepEqual(directOnlyEnvProblems(p.env), [], "the lifecycle tool's mirror of supervisor.js directOnlyProblems agrees");
  assert.equal(p.env.ISOLATION_DIRECT_ONLY, "1"); assert.equal(p.env.BASE_RPCS, "https://rpc-a.example/v1,https://rpc-b.example");
  assert.equal(p.env.REGISTRY_PRIVATE_KEY, OPERATOR_KEY); assert.equal(p.env.PUBLIC_URL, "https://host.example.org");
  for (const k of ["ADDRESS_BOOK_ADDRESS", "PAYOUT_ADDRESS"]) assert.notEqual(p.env[k], flavorEnv[k], `${k} of the hosted flavor is not inherited`);
  assert.equal(p.env.ADDRESS_BOOK_ADDRESS, ""); assert.equal(p.env.SIWE_DOMAIN, undefined); assert.equal(p.env.CHAIN_ID, "8453");
  assert.deepEqual(JSON.parse(p.files[MC.GUEST_PATHS.pins]).contracts, CONFIG.contracts);
});

test("planDirectBoot refuses, listing why: wrong HOST_DATA, legacy inputs, another operator, unbound policy, missing measured tokens", async () => {
  const reasons = async (over, { cmdline = CMDLINE, hd = HOST_DATA } = {}) => { const p = await MC.planDirectBoot({ cmdline, fw: fwFor(over), reportHostData: hd, viem }); assert.equal(p.ok, false); return p.reasons.join("\n"); };
  assert.match(await reasons({}, { hd: MC.hostDataHex("00".repeat(32)) }), /does not bind this config/);
  assert.match(await reasons({}, { hd: "" }), /HOST_DATA \(unreadable\)/);
  const other = RAW(); other.rpcs = ["https://rpc-x.example", "https://rpc-y.example"];
  assert.match(await reasons({ direct: other }), /does not bind this config/, "a host swapping the RPCs is caught by HOST_DATA");
  assert.match(await reasons({ relayUrl: "wss://api.enclave.host/v1/fleet-tunnel", tunnelToken: "t", fleetSecret: "s" }), /relayUrl is set[\s\S]*tunnelToken[\s\S]*fleetSecret/);
  assert.match(await reasons({ volumes: [{ name: "m" }] }), /mounts no model volumes/);
  assert.match(await reasons({ registryKey: "0x" + "22".repeat(32) }), /not the bound operator/);
  assert.match(await reasons({ hostAdmission: { policy: 1 } }), /hostAdmission digest/);
  assert.match(await reasons({ isolation: { managerUrl: "http://10.0.2.2:9999", dataAddr: "10.0.2.2:8096", pairingKey: PAIR } }), /isolation endpoints differ/);
  assert.match(await reasons({ isolation: { managerUrl: "http://10.0.2.2:8095", dataAddr: "10.0.2.2:8096", pairingKey: PAIR, release: true } }), /no relay ticket/);
  assert.match(await reasons({ mode: "dev" }), /differs from the measured mode/);
  assert.match(await reasons({}, { cmdline: CMDLINE.replace(" metal.control=direct", "") }), /not direct/);
  assert.match(await reasons({}, { cmdline: CMDLINE.replace(" metal.isolation=snp-guest-per-app", "") }), /metal\.isolation=snp-guest-per-app/);
  assert.match(await reasons({}, { cmdline: CMDLINE.replace("metal.mode=snp", "metal.mode=tdx") }), /SEV-SNP only/);
  // no operator key: a direct host that does not sell, never a guessed one
  const ns = await MC.planDirectBoot({ cmdline: CMDLINE, fw: fwFor({ registryKey: "" }), reportHostData: HOST_DATA, viem });
  assert.equal(ns.ok, true); assert.equal(ns.env.REGISTRY_ENABLED, "0"); assert.equal(ns.env.REGISTRY_PRIVATE_KEY, undefined);
});

test("gsup: the legacy path is untouched; the direct branch runs only for metal.control=direct", () => {
  const now = fs.readFileSync(path.join(REPO, "metal/guest/gsup.mjs"), "utf8");
  // The REFERENCE is the reviewed main release before the direct-control composition (7752a423), not HEAD: HEAD already
  // carries every reviewed change listed below, so comparing against it could never hold (and only passed where HEAD was
  // that base). It must be an ancestor of the tree under test: the invariant is "the legacy launch of the reviewed base,
  // changed only by these reviewed wrappers".
  const BASE = "7752a4239b3bec2cf452491cd1b95164a8c2bdb8";
  execFileSync("git", ["merge-base", "--is-ancestor", BASE, "HEAD"], { cwd: REPO });
  const head = execFileSync("git", ["show", `${BASE}:metal/guest/gsup.mjs`], { cwd: REPO, encoding: "utf8" });
  const legacy = (s) => s.slice(s.indexOf("const supEnv = {"), s.indexOf("// --- shielded GPU"));
  // the one reviewed change inside it: the supervisor gets its lease-gas names from the conduit only (lease-gas-conduit.mjs)
  const LEASED = "withLeaseGasEnv(supEnv, LEASE_GAS)";
  assert.equal(legacy(now).split(LEASED).length, 2, "the legacy supervisor starts with the conduit's lease-gas environment, once");
  // and the second reviewed change: the operator's checked owner nomination name, from fw_cfg only (owner-nomination.mjs)
  const NOMINATED = "withOwnerNominationEnv(" + LEASED + ", OWNER_NOMINATION.nomination)";
  assert.equal(legacy(now).split(NOMINATED).length, 2, "...wrapped once by the owner nomination's env");
  // and the third: the platform policy carriers' name, from fw_cfg only, applied last (measured-control.mjs withPolicyCarriersEnv)
  const CARRIED = "MC_LEGACY.withPolicyCarriersEnv(" + NOMINATED + ", POLICY_CARRIERS)";
  assert.equal(legacy(now).split(CARRIED).length, 2, "...wrapped once by the policy carriers' env");
  // and the fourth: the local chain verifier's two names, from fw_cfg only, applied last (metal/guest/chain-verifier.mjs)
  const VERIFIED = "withChainVerifierEnv(" + CARRIED + ", CHAIN_VERIFIER)";
  assert.equal(legacy(now).split(VERIFIED).length, 2, "...wrapped once, last, by the chain verifier's env");
  // and the reviewed metal host policy (6f2c7da4, network/metal-host-policy.mjs): the fw_cfg wallet-policy names, after the flavor
  const HOSTED = "  ...HOST_POLICY_ENV,\n";
  assert.equal(legacy(now).split(HOSTED).length, 2, "...the metal host policy's names, once, right after the flavor");
  assert.equal(legacy(now).replace(/\n}\n\n$/, "\n\n").replace(VERIFIED, "supEnv").replace(HOSTED, ""), legacy(head), "the legacy supervisor and agent launch is otherwise byte-identical to the reviewed base, only wrapped in if (!CONTROL)");
  assert.match(now, /if \(CONTROL === 'direct'\) await startDirectControl\(\)/);
  assert.match(now, /if \(!CONTROL\) \{\nconst supEnv = \{/);
  assert.match(now, /const MODE {9}= CONTROL \? \(cmdMode \|\| 'snp'\) : \(fw\.mode \|\| cmdMode \|\| 'snp'\);/);
  assert.match(now, /if \(!ISO_BACKEND && !CONTROL\) start\('wasm-manager'/);
  assert.match(now, /reportHostData: MODE === 'snp' \? snpHostData\(\) : ''/, "HOST_DATA comes from the guest's own report");
});

// ---- 2. keys, statement, binding ---------------------------------------------------------------------------------------------
test("keys are minted in the guest where the supervisor reuses them; the statement is canonical and bound with the role", () => {
  const P = guestPaths(); const k = MC.mintControlKeys({ paths: P });
  const proofFile = path.join(P.sessionDir, "proof-secp256k1.hex");
  for (const f of [proofFile, path.join(P.sessionDir, "session-ec-p256.pkcs8.pem"), P.tlsKey]) assert.equal(fs.statSync(f).mode & 0o777, 0o600, f);
  assert.match(fs.readFileSync(proofFile, "utf8"), /^0x[0-9a-f]{64}$/, "supervisor.js initProofKey's format");
  assert.equal(MC.addressOfPublicKey(k.proof.publicKey, viem.keccak256), privateKeyToAccount(fs.readFileSync(proofFile, "utf8")).address.toLowerCase());
  createPrivateKey(fs.readFileSync(path.join(P.sessionDir, "session-ec-p256.pkcs8.pem"), "utf8"));
  const cert = new X509Certificate(k.controlTls.certPem);
  assert.equal(MC.sha256Hex(cert.publicKey.export({ type: "spki", format: "der" })), k.controlTls.spkiSha256);
  assert.ok(cert.verify(cert.publicKey), "self-signed");
  const st = MC.controlStatement({ config: CONFIG, digest: DIGEST, hostData: HOST_DATA, mode: "snp", keys: k });
  assert.deepEqual(MC.parseStatement(st.text), st.obj);
  assert.throws(() => MC.parseStatement(JSON.stringify(st.obj, null, 1)), /canonical/);
  assert.throws(() => MC.parseStatement(st.text.replace('"direct-control"', '"app"')), /not a direct control statement/);
  const nonce = randomBytes(32), rd = MC.reportDataFor(st.text, nonce);
  assert.deepEqual(rd.subarray(32), MC.CONTROL_ROLE);
  assert.deepEqual(rd.subarray(0, 32), sha("enclave-measured-control/v1\n", sha(st.text), nonce));
  assert.notDeepEqual(MC.reportDataFor(st.text, randomBytes(32)).subarray(0, 32), rd.subarray(0, 32), "fresh per nonce");
});

// ---- 3. the front and the verifier, end to end (SYNTHETIC SNP chain, REAL supervisor) ---------------------------------------
const S = synthChain();
const COL = memoryCollateral({ chains: { Genoa: S.chainPem }, vceks: { Genoa: S.vcekDer }, crls: { Genoa: S.crlDer } });
const MEAS = "77".repeat(48);
const EXPECT = { config: RAW(), measurements: [MEAS], minTcb: TCB_FLOORS, roots: new Map([["Genoa", S.arkFp]]) };
/** A reporter that signs with the synthetic chain: what configfs-tsm returns on the guest, with HOST_DATA as launched. */
const synthReporter = ({ hostData = HOST_DATA, chain = S, rewrite = null } = {}) => async (reportData) => {
  const rd = rewrite ? rewrite(reportData) : reportData;
  return { report: synthReport(chain, { reportData: rd, hostData: Buffer.from(hostData, "hex") }), certs: null };
};
async function front({ keys, statementText, reporter, upstreamPort, mode = "snp", tlsKeyPem = null, certPem = null }) {
  const s = MC.createControlFront({ statementText, keyPem: tlsKeyPem || fs.readFileSync(keys.tlsKeyFile, "utf8"), certPem: certPem || keys.controlTls.certPem, reporter, upstream: { host: "127.0.0.1", port: upstreamPort }, mode });
  servers.push(s);
  await new Promise((r) => s.listen(0, "127.0.0.1", r));
  return `https://127.0.0.1:${s.address().port}`;
}
async function realSupervisor(plan, P) {
  const port = await freePort(), closed = await freePort();
  for (const [f, text] of Object.entries(plan.files)) fs.writeFileSync(f, text, { mode: 0o600 });
  // the plan's environment, with every network target moved to a CLOSED loopback port so this test reaches nothing
  // outside 127.0.0.1 (http.request is not covered by the fetch hook); the mode, pins, keys and services stay as derived
  const dead = `127.0.0.1:${closed}`;
  const env = { ...plan.env, PORT: String(port), STATE_FILE: path.join(P.runDir, "state.json"), HOME: P.runDir, NODE_EXTRA_CA_CERTS: "",
    PATH: process.env.PATH, ATTESTATION_URL: `http://${dead}/.well-known/enclave-attestation`, VMMGR_URL: `http://${dead}`, GUESTD_DATA_ADDR: dead,
    BASE_RPC: `http://${dead}`, BASE_RPCS: `http://${dead}`, GUEST_BOOTSTRAP_GATEWAYS: `http://${dead}/ipfs`, IPFS_GATEWAY: JSON.stringify([`http://${dead}`]) };
  assert.deepEqual(MC.directEnvProblems(env), [], "still the direct-only environment");
  const c = spawn(process.execPath, ["--max-old-space-size=160", "--import", path.join(REPO, "test/helpers/loopback-only-fetch.mjs"), path.join(REPO, "supervisor.js")],
    { cwd: REPO, env, stdio: ["ignore", "pipe", "pipe"] });
  children.push(c);
  let log = ""; c.stdout.on("data", (b) => { log += b; }); c.stderr.on("data", (b) => { log += b; });
  for (let i = 0; i < 200; i++) {
    if (c.exitCode !== null) throw new Error(`supervisor exited ${c.exitCode}:\n${log.slice(-2000)}`);
    try { const r = await fetch(`http://127.0.0.1:${port}/v1/health`); if (r.ok) return { port, log: () => log, child: c }; } catch {}
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`supervisor did not answer:\n${log.slice(-2000)}`);
}
const registryOk = (st, over = {}) => async (id) => { assert.equal(id, registryIdOf(st.identity.publicUrl)); return { operator: OPERATOR, proofKey: MC.addressOfPublicKey(st.keys.proof.publicKey, viem.keccak256), active: true, ...over }; };

let E2E = null;   // the booted guest stand-in shared by the cases below
async function e2e() {
  if (E2E) return E2E;
  const P = guestPaths();
  // the boot exactly as gsup does it: plan (selling off: no chain writes from this test), mint, statement, supervisor, front
  const plan = await MC.planDirectBoot({ cmdline: CMDLINE, fw: fwFor({ registryKey: "" }), reportHostData: HOST_DATA, viem, paths: P });
  assert.equal(plan.ok, true, plan.reasons?.join("; "));
  const keys = { ...MC.mintControlKeys({ paths: P }), tlsKeyFile: P.tlsKey };
  const st = MC.controlStatement({ config: plan.config, digest: plan.digest, hostData: plan.hostData, mode: "snp", keys });
  fs.writeFileSync(P.pairKey, PAIR + "\n", { mode: 0o600 });
  const sup = await realSupervisor(plan, P);
  const url = await front({ keys, statementText: st.text, reporter: synthReporter(), upstreamPort: sup.port });
  E2E = { P, plan, keys, st, sup, url, stObj: MC.parseStatement(st.text) };
  return E2E;
}

test("end to end: the real supervisor adopts the minted keys, and the verifier accepts the guest only through every check", async () => {
  const { url, stObj, sup } = await e2e();
  assert.match(sup.log(), /\[direct\] direct-only host control/);
  const v = await verifyMeasuredControl({ url, expect: EXPECT, collateral: COL, registry: registryOk(stObj) });
  assert.equal(v.status, "verified", v.reasons.join("\n"));
  assert.equal(v.ready, true);
  for (const c of ["statement", "config", "endpoint key", "report", "supervisor", "registry"]) assert.equal(v.checks[c], true, c);
  assert.equal(v.identity.measurement, MEAS);
  assert.equal(v.identity.proofKey, MC.addressOfPublicKey(stObj.keys.proof.publicKey, viem.keccak256));
  // the same guest through the plain proxy path: the front forwards path and query only
  const r = await fetch(`http://127.0.0.1:${sup.port}/v1/health`); assert.equal(r.status, 200);
});

test("registry through the owner's quorum: unregistered or not-yet-republished is PENDING, another operator REJECTED, disagreement UNKNOWN", async () => {
  const { url, stObj } = await e2e();
  const run = (registry) => verifyMeasuredControl({ url, expect: EXPECT, collateral: COL, registry });
  assert.equal((await run(async () => null)).status, "pending");
  assert.equal((await run(registryOk(stObj, { proofKey: a(0x99) }))).status, "pending");
  assert.equal((await run(registryOk(stObj, { operator: a(0x98) }))).status, "rejected");
  assert.equal((await run(registryOk(stObj, { active: false }))).status, "rejected");
  assert.equal((await run(null)).status, "pending", "without a quorum reader the result is never verified");
  // a REAL QuorumChain whose two peers disagree on the registry entry: the read fails, so the answer is UNKNOWN
  const { QuorumChain } = await import("../cli/independent.mjs");
  const peer = (proofKey) => ({ getChainId: async () => 8453, getBlockNumber: async () => 100n, getBlock: async ({ blockNumber }) => ({ number: blockNumber, hash: "0x" + "ab".repeat(32), timestamp: BigInt(Math.floor(Date.now() / 1000)) }),
    readContract: async () => ({ operator: OPERATOR, proofKey, active: true }) });
  const chain = new QuorumChain({ clients: [{ origin: "https://a.example", client: peer(a(1)) }, { origin: "https://b.example", client: peer(a(2)) }], quorum: 2, confirmations: 0, chainId: 8453 });
  const quorumRegistry = async () => (await chain.snapshot((c, blockNumber) => c.readContract({ blockNumber }))).value;
  const u = await run(quorumRegistry);
  assert.equal(u.status, "unknown"); assert.match(u.reasons.at(-1), /quorum did not agree/);
});

test("refused: forged signature, foreign or replayed binding, an app guest's report, wrong measurement, wrong HOST_DATA, an unattested launch", async () => {
  const { keys, st, sup, stObj } = await e2e();
  const verifyWith = async (reporter, { expect = EXPECT, statementText = st.text, mode = "snp" } = {}) => {
    const url = await front({ keys, statementText, reporter, upstreamPort: sup.port, mode });
    return verifyMeasuredControl({ url, expect, collateral: COL, registry: registryOk(stObj) });
  };
  const forger = { ...S, vcekKey: generateKeyPairSync("ec", { namedCurve: "secp384r1" }).privateKey.export({ type: "pkcs8", format: "pem" }) };
  let v = await verifyWith(synthReporter({ chain: forger }));
  assert.equal(v.status, "rejected"); assert.equal(v.checks.hardware.signature, false, v.reasons.join("\n"));
  const stale = randomBytes(32);   // a genuine report for ANOTHER nonce (replay) or another statement (foreign guest)
  v = await verifyWith(synthReporter({ rewrite: () => MC.reportDataFor(st.text, stale) }));
  assert.equal(v.status, "rejected"); assert.equal(v.checks.hardware.binding, false);
  const otherStatement = MC.controlStatement({ config: CONFIG, digest: DIGEST, hostData: HOST_DATA, mode: "snp", keys }).text;   // a different boot id
  v = await verifyWith(synthReporter({ rewrite: (rd) => Buffer.concat([MC.reportDataFor(otherStatement, rd.subarray(0, 32)).subarray(0, 32), MC.CONTROL_ROLE]) }));
  assert.equal(v.status, "rejected"); assert.equal(v.checks.hardware.binding, false);
  v = await verifyWith(synthReporter({ rewrite: (rd) => Buffer.concat([rd.subarray(0, 32), randomBytes(32)]) }));   // an app guest's AppID in [32:64]
  assert.equal(v.status, "rejected"); assert.equal(v.checks.hardware["app id"], false);
  v = await verifyWith(synthReporter(), { expect: { ...EXPECT, measurements: ["66".repeat(48)] } });
  assert.equal(v.status, "rejected"); assert.equal(v.checks.hardware.measurement, false);
  v = await verifyWith(synthReporter({ hostData: MC.hostDataHex("11".repeat(32)) }));   // launched with another config than it claims
  assert.equal(v.status, "rejected"); assert.equal(v.checks.hardware["host data"], false);
  v = await verifyWith(synthReporter(), { expect: { ...EXPECT, crl: "none" } });   // an omitted security check is not readiness
  assert.equal(v.status, "rejected"); assert.match(v.reasons.join("\n"), /crl-revocation-unchecked/);
  v = await verifyWith(synthReporter(), { mode: "dev" });
  assert.equal(v.status, "rejected"); assert.match(v.reasons.at(-1), /no hardware report/);
  const other = RAW(); other.selling.cpuPrice6 = 99;   // the owner expects another config than the guest runs
  v = await verifyWith(synthReporter(), { expect: { ...EXPECT, config: other } });
  assert.equal(v.status, "rejected"); assert.equal(v.checks.config, false);
});

test("refused: a TLS endpoint that is not the attested key, and a supervisor process that does not hold the minted keys", async () => {
  const { keys, st, sup, stObj } = await e2e();
  // a relay/MITM: it serves the genuine statement (and could relay genuine reports) but terminates TLS with its own key
  const mitm = generateKeyPairSync("ec", { namedCurve: "P-256" });
  const url1 = await front({ keys, statementText: st.text, reporter: synthReporter(), upstreamPort: sup.port,
    tlsKeyPem: mitm.privateKey.export({ type: "pkcs8", format: "pem" }), certPem: MC.selfSignedCert(mitm.privateKey, mitm.publicKey) });
  let v = await verifyMeasuredControl({ url: url1, expect: EXPECT, collateral: COL, registry: registryOk(stObj) });
  assert.equal(v.status, "rejected"); assert.equal(v.checks["endpoint key"], false);
  // the attested front, but the process behind it signs with a key the guest did not mint (e.g. a host-run supervisor)
  const impostor = http.createServer((req, res) => { res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ proofKey: { address: privateKeyToAccount("0x" + "33".repeat(32)).address }, sessionKey: { kid: "x" } })); });
  servers.push(impostor); await new Promise((r) => impostor.listen(0, "127.0.0.1", r));
  const url2 = await front({ keys, statementText: st.text, reporter: synthReporter(), upstreamPort: impostor.address().port });
  v = await verifyMeasuredControl({ url: url2, expect: EXPECT, collateral: COL, registry: registryOk(stObj) });
  assert.equal(v.status, "rejected"); assert.equal(v.checks.supervisor, false); assert.match(v.reasons.at(-1), /not the minted/);
  // nothing listening: unreachable is UNKNOWN, never ready
  v = await verifyMeasuredControl({ url: `https://127.0.0.1:${await freePort()}`, expect: EXPECT, collateral: COL, registry: registryOk(stObj) });
  assert.equal(v.status, "unknown");
});

test("the front: nonce is required and fresh, only path and query reach the supervisor", async () => {
  const { url } = await e2e();
  const { tlsGet } = await import("../metal/measured-control-verify.mjs");
  assert.equal((await tlsGet(url, MC.EVIDENCE_PATH)).status, 400);
  assert.equal((await tlsGet(url, `${MC.EVIDENCE_PATH}?nonce=${"AB".repeat(32)}`)).status, 400);
  const n1 = randomBytes(32).toString("hex"), n2 = randomBytes(32).toString("hex");
  const e1 = JSON.parse((await tlsGet(url, `${MC.EVIDENCE_PATH}?nonce=${n1}`)).body), e2 = JSON.parse((await tlsGet(url, `${MC.EVIDENCE_PATH}?nonce=${n2}`)).body);
  assert.notEqual(e1.report, e2.report, "a report per nonce");
  const abs = await tlsGet(url, "//169.254.169.254/latest/meta-data"); assert.equal(abs.status, 400);
  assert.equal((await tlsGet(url, "/v1/health")).status, 200);
});

// ---- 4. the real launcher (fake QEMU) and the builder ---------------------------------------------------------------------
function launch(cfgOver, { configFile = null } = {}) {
  const t = fs.mkdtempSync(path.join(tmp, "launch-"));
  fs.mkdirSync(path.join(t, "dist")); fs.mkdirSync(path.join(t, "tmp"));
  fs.writeFileSync(path.join(t, "dist", "vmlinuz"), "k"); fs.writeFileSync(path.join(t, "dist", "initramfs.cpio.gz"), "i");
  fs.writeFileSync(path.join(t, "pair.key"), PAIR + "\n", { mode: 0o600 });
  fs.writeFileSync(path.join(t, "operator.key"), OPERATOR_KEY + "\n", { mode: 0o600 });
  fs.writeFileSync(path.join(t, "direct.json"), JSON.stringify(configFile || RAW()));
  fs.writeFileSync(path.join(t, "fake-qemu"), ["#!/bin/sh", 'printf "%s\\n" "$@" > "$FAKE_QEMU_ARGS"',
    "while [ $# -gt 0 ]; do", '  if [ "$1" = -fw_cfg ]; then case "$2" in name=opt/org.enclave.metal,file=*) cp "${2#name=opt/org.enclave.metal,file=}" "$FAKE_QEMU_OUT";; esac; fi', "  shift", "done", "exec sleep 30"].join("\n") + "\n", { mode: 0o755 });
  const cfg = { mode: "snp", name: "ctl", cpus: 1, memMiB: 512, measureGflops: false, dist: path.join(t, "dist"), ovmf: path.join(t, "ovmf.fd"), qemu: path.join(t, "fake-qemu"),
    control: "direct", direct: path.join(t, "direct.json"), registryKeyFile: path.join(t, "operator.key"), hostfwd: [{ host: 18444, guest: 8444 }],
    isolation: { backend: "snp-guest-per-app", managerUrl: "http://10.0.2.2:8095", dataAddr: "10.0.2.2:8096", pairingKeyFile: path.join(t, "pair.key") }, ...cfgOver };
  for (const k of Object.keys(cfg)) if (cfg[k] === undefined) delete cfg[k];
  fs.writeFileSync(path.join(t, "config.json"), JSON.stringify(cfg));
  const out = path.join(t, "fw.json"), args = path.join(t, "args.txt");
  const p = spawn(process.execPath, [path.join(REPO, "metal/enclave-metal.mjs"), "--config", path.join(t, "config.json")],
    { env: { ...process.env, TMPDIR: path.join(t, "tmp"), FAKE_QEMU_OUT: out, FAKE_QEMU_ARGS: args }, stdio: ["ignore", "pipe", "pipe"] });
  children.push(p);
  let log = ""; p.stdout.on("data", (d) => { log += d; }); p.stderr.on("data", (d) => { log += d; });
  const exited = new Promise((r) => p.on("exit", (code) => r(code)));
  return { out, args, exited, p, log: () => log };
}
async function launched(cfgOver = {}, o = {}) {
  const run = launch(cfgOver, o);
  try {
    for (let i = 0; i < 200 && !fs.existsSync(run.out); i++) { if (run.p.exitCode !== null) break; await new Promise((r) => setTimeout(r, 50)); }
    if (!fs.existsSync(run.out)) return { refused: true, code: await Promise.race([run.exited, new Promise((r) => setTimeout(() => r("running"), 3000))]), log: run.log() };
    await new Promise((r) => setTimeout(r, 100));
    return { fw: JSON.parse(fs.readFileSync(run.out, "utf8")), args: fs.readFileSync(run.args, "utf8").split("\n"), log: run.log() };
  } finally { run.p.kill("SIGTERM"); await run.exited; }
}

test("the real launcher: measured token, the owner's config in fw_cfg, HOST_DATA binding it, the operator key checked", async () => {
  const r = await launched();
  assert.ok(!r.refused, r.log);
  const append = r.args[r.args.indexOf("-append") + 1];
  assert.equal(append, CMDLINE, "the measured cmdline the builder's template produces");
  assert.deepEqual(r.fw.direct, JSON.parse(JSON.stringify(CONFIG)));
  assert.equal(r.fw.registryKey, OPERATOR_KEY); assert.equal(r.fw.publicUrl, CONFIG.identity.publicUrl);
  assert.equal(r.fw.relayUrl, ""); assert.equal(r.fw.tunnelToken, ""); assert.equal(r.fw.fleetSecret, "");
  const obj = r.args[r.args.findIndex((x) => x.startsWith("sev-snp-guest,"))];
  assert.match(obj, new RegExp(`host-data=${Buffer.from(HOST_DATA, "hex").toString("base64").replace(/[+/=]/g, (c) => "\\" + c)}`));
  // what the guest then decides with that fw_cfg and that HOST_DATA
  const p = await MC.planDirectBoot({ cmdline: append, fw: r.fw, reportHostData: HOST_DATA, viem });
  assert.equal(p.ok, true, p.reasons?.join("; "));
});

test("the real launcher refuses legacy inputs, a bypassing port forward, another operator's key, and an unbound policy", async () => {
  for (const [over, re] of [[{ relayUrl: "wss://api.enclave.host/v1/fleet-tunnel" }, /refuses relayUrl/], [{ hostfwd: [{ host: 18080, guest: 8080 }] }, /bypass the attested channel/],
    [{ registryKey: OPERATOR_KEY }, /registryKeyFile/], [{ isolation: undefined }, /per-app SEV-SNP tier/], [{ mode: "tdx" }, /HOST_DATA/], [{ control: "relay" }, /control must be "direct"/]]) {
    const r = await launched(over);
    assert.equal(r.refused, true, `${JSON.stringify(over)} must refuse:\n${r.log}`); assert.match(r.log, re);
  }
  const other = RAW(); other.identity.operator = a(0x77);
  const r = await launched({}, { configFile: other });
  assert.equal(r.refused, true); assert.match(r.log, /not the bound operator/);
});

test("builder and overlay carry the helper and the measured token", () => {
  const b = fs.readFileSync(path.join(REPO, "metal/build-image.mjs"), "utf8");
  assert.match(b, /'shielded-shm\.mjs', 'measured-control\.mjs', 'owner-nomination\.mjs', 'chain-verifier\.mjs'\]\)/);
  assert.match(b, /\+ \(CONTROL \? ` metal\.control=\$\{CONTROL\}` : ''\);/);
  assert.match(b, /--control direct needs --isolation snp-guest-per-app/);
  const tpl = 'console=ttyS0 root=/dev/ram0 rootfstype=ramfs quiet metal.mode=${MODE}' + ' metal.isolation=snp-guest-per-app' + ' metal.control=direct';
  assert.equal(tpl.replace('${MODE}', 'snp'), CMDLINE, "builder template == launcher cmdline");
  const o = fs.readFileSync(path.join(REPO, "metal/overlay-control-image.py"), "utf8");
  assert.match(o, /OPTIONAL_GUEST_FILES = \['measured-control\.mjs', 'lease-gas-conduit\.bundle\.mjs', 'owner-nomination\.mjs', 'chain-verifier\.mjs'\]/);
});

// ---- the bound local chain verifier (metal/guest/chain-verifier.mjs, network/chain-authority.mjs) -----------------------------
const CV = () => ({ format: "enclave-chain-verifier/v1", unsafeSigner: "0x" + "9a".repeat(20), proofSources: ["https://holder.example.net/"], port: 50546,
  txBackend: "http://10.0.2.2:8545" });
test("chainVerifier in the bound direct config: optional (absent keeps every earlier digest), checked, bound by HOST_DATA, distinct ports", () => {
  assert.equal(MC.configDigest(MC.canonicalDirectConfig(RAW())), DIGEST, "absent: the exact earlier canonical bytes and digest");
  const cfg = MC.canonicalDirectConfig({ ...RAW(), chainVerifier: CV() });
  assert.notEqual(MC.configDigest(cfg), DIGEST, "present: part of the bound config (HOST_DATA names it)");
  assert.deepEqual(cfg.chainVerifier, { format: "enclave-chain-verifier/v1", unsafeSigner: "0x" + "9a".repeat(20), proofSources: ["https://holder.example.net/"], port: 50546,
    txBackend: "http://10.0.2.2:8545/" });
  const refuse = (cv, re) => assert.throws(() => MC.canonicalDirectConfig({ ...RAW(), chainVerifier: cv }), re);
  refuse({ ...CV(), port: 8444 }, /guest's own ports/);
  refuse({ ...CV(), port: 49999 }, /50000\.\.57999/);
  refuse({ ...CV(), port: 58000 }, /50000\.\.57999/);
  refuse({ ...CV(), txBackend: "https://mainnet.base.org" }, /txBackend must be a loopback or private/);
  refuse({ ...CV(), witnessArchive: {} }, /witnessArchive is not offered/);
  refuse({ ...CV(), proofSources: [] }, /explicit proof source/);
  assert.throws(() => MC.canonicalDirectConfig({ ...RAW(), controlPort: 50546, chainVerifier: CV() }), /differ from every other port/);
});

test("planDirectBoot with a bound chainVerifier: the image's pinned runtime is started before the supervisor, whose ONLY chain authority names come from it; no runtime in the image refuses the boot", async () => {
  const raw = { ...RAW(), chainVerifier: CV() }, cfg = MC.canonicalDirectConfig(raw), hd = MC.hostDataHex(MC.configDigest(cfg));
  const P = guestPaths(), imageFile = path.join(P.runDir, "IMAGE.json");
  fs.copyFileSync(path.join(REPO, "metal/chain-verifier-image.json"), imageFile);
  const plan = await MC.planDirectBoot({ cmdline: CMDLINE, fw: fwFor({ direct: raw }), reportHostData: hd, viem, paths: { ...P, chainVerifierImage: imageFile } });
  assert.equal(plan.ok, true, plan.reasons?.join("; "));
  assert.equal(plan.chainVerifier.ok, true);
  assert.deepEqual(plan.chainVerifier.argv("/c/rpc-runtime.json"), ["/usr/local/bin/node", "/app/network/rpc-runtime-main.mjs", "run", "/c/rpc-runtime.json"]);
  assert.equal(plan.chainVerifier.runtimeConfig.verifier.port, 50546);
  assert.equal(plan.chainVerifier.runtimeConfig.binaryStaging, "copy");
  assert.equal(plan.env.ENCLAVE_CHAIN_AUTHORITY, "verifier");
  assert.equal(plan.env.ENCLAVE_CHAIN_VERIFIER, "http://127.0.0.1:50546/");
  assert.equal(plan.env.ENCLAVE_CHAIN_TX_BACKEND, "http://10.0.2.2:8545/");
  assert.deepEqual(MC.directEnvProblems(plan.env), []);
  const { directOnlyEnvProblems } = await import("../cli/host-independent-lifecycle.mjs");
  assert.deepEqual(directOnlyEnvProblems(plan.env), [], "the real supervisor's direct-only rules accept it");
  // the derived env is the bound member's alone: a flavor or host-policy value for these names never survives
  const sneaky = MC.directSupervisorEnv(cfg, { flavorEnv: { ENCLAVE_CHAIN_TX_BACKEND: "https://mainnet.base.org/" }, hostPolicyEnv: { ENCLAVE_CHAIN_VERIFIER: "http://127.0.0.1:1/" } });
  assert.equal(sneaky.ENCLAVE_CHAIN_VERIFIER, "http://127.0.0.1:50546/"); assert.equal(sneaky.ENCLAVE_CHAIN_TX_BACKEND, "http://10.0.2.2:8545/");
  const none = MC.directSupervisorEnv(CONFIG, { hostPolicyEnv: { ENCLAVE_CHAIN_AUTHORITY: "verifier", ENCLAVE_CHAIN_VERIFIER: "http://127.0.0.1:1/" } });
  for (const k of ["ENCLAVE_CHAIN_AUTHORITY", "ENCLAVE_CHAIN_VERIFIER", "ENCLAVE_CHAIN_TX_BACKEND"]) assert.equal(k in none, false, `${k}: no bound member, no such name`);
  // the hosted MCP adapter's profile is decided by the same verifier (mcp/independent.mjs chainVerifier)
  const mcp = { port: 8710, managementDirectories: [], capacityDirectories: [], capacityCold: [], maxHosts: 8, sessionScan: { fromBlock: 1 } };
  const launch = MC.directMcpLaunch({ ...cfg, mcp });
  assert.equal(JSON.parse(launch.files[MC.GUEST_PATHS.mcpConfig]).profiles.host.chainVerifier, "http://127.0.0.1:50546/");
  assert.equal("chainVerifier" in JSON.parse(MC.directMcpLaunch({ ...CONFIG, mcp }).files[MC.GUEST_PATHS.mcpConfig]).profiles.host, false);
  // an image that carries no verifier runtime cannot start the bound verifier: the boot refuses (never the rpcs)
  const refused = await MC.planDirectBoot({ cmdline: CMDLINE, fw: fwFor({ direct: raw }), reportHostData: hd, viem, paths: { ...guestPaths(), chainVerifierImage: path.join(P.runDir, "absent.json") } });
  assert.equal(refused.ok, false); assert.match(refused.reasons.join("\n"), /chainVerifier: chain verifier REFUSED \(this image carries no chain verifier runtime\)/);
  // the statement names the image's runtime record it runs (the existing runtime-hash convention); parsers accept it
  const keys = MC.mintControlKeys({ paths: guestPaths() });
  const st = MC.controlStatement({ config: cfg, digest: plan.digest, hostData: hd, mode: "snp", keys, runtime: { chainVerifierImageSha256: "cd".repeat(32) } });
  assert.equal(MC.parseStatement(st.text).runtime.chainVerifierImageSha256, "cd".repeat(32));
  // gsup's direct branch starts it as a supervised child BEFORE the supervisor, from the plan
  const g = fs.readFileSync(path.join(REPO, "metal/guest/gsup.mjs"), "utf8");
  const d = g.slice(g.indexOf("async function startDirectControl"), g.indexOf("if (CONTROL === 'direct') await startDirectControl()"));
  const cvAt = d.indexOf("start('chain-verifier', plan.chainVerifier.argv(writeChainVerifierConfig(plan.chainVerifier)), plan.chainVerifier.env, { cwd: '/app' });");
  const supAt = d.indexOf("start('supervisor', ['/usr/local/bin/node', '/app/supervisor.js'], plan.env, { cwd: '/app' });");
  assert.ok(cvAt > 0 && supAt > cvAt, "the verifier starts before the direct supervisor");
  assert.match(d, /\.\.\.\(plan\.chainVerifier \? \{ chainVerifierImageSha256: fileSha\(P\.chainVerifierImage\) \} : \{\}\)/);
});
