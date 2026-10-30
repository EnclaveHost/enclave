// The platform API as a measured host role (metal/guest/platform-api-role.mjs, relay/state-replica.mjs, the platformApi
// member of metal/guest/measured-control.mjs, metal/guest/platform-api-verify.mjs, scripts/platform-api-admin.mjs), end to
// end on loopback. What runs here, and what it can and cannot show:
//   * three member "guests", each with the REAL control front (createControlFront with the platform API host and prefix
//     routes), a statement minted by the REAL mintControlKeys / mintPlatformApiKey / controlStatement, and the REAL role;
//   * the relay is the UNCHANGED relay/api-relay.js, started by the role as its child behind the response barrier;
//   * a newcomer receives the state key only after the REAL verifyMeasuredControl accepted it. The SEV-SNP evidence is
//     SYNTHETIC (test/helpers/snp-synth.mjs: an AMD-shaped chain whose ARK this test pins; the real AMD pin refuses it), the
//     registry is a stand-in function and the "supervisor" behind each front is a stand-in that serves only the minted-key
//     attestation the verifier's step 6 asks for. None of this proves a real guest measurement, which needs SNP hardware;
//   * accounts are real relay accounts (SIWE with a real signature); the API is reached through each member's front with the
//     platform API Host header, so a standby forwards to the primary exactly as on the network (pinned to its attested key).
// Every key is disposable; nothing leaves 127.0.0.1.
//   run: node --test --test-concurrency=1 test/platform-api-hosted.test.mjs
import test, { after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import net from "node:net";
import http from "node:http";
import https from "node:https";
import path from "node:path";
import { randomBytes } from "node:crypto";
import * as viem from "viem";
import { privateKeyToAccount, generatePrivateKey } from "viem/accounts";
import { synthChain, synthReport } from "./helpers/snp-synth.mjs";
import { memoryCollateral } from "../verifier/collateral.mjs";
import { TCB_FLOORS } from "../verifier/metal-box.mjs";
import * as MC from "../metal/guest/measured-control.mjs";
import { registryIdOf } from "../metal/measured-control-verify.mjs";
import * as hpke from "../custody/hpke.mjs";
import { startRole, groupIdOf, CREDENTIALS_FILE, BOOTSTRAP_PATH, CREDENTIALS_PATH, HANDOFF_PATH } from "../metal/guest/platform-api-role.mjs";
import { productionVerifier } from "../metal/guest/platform-api-verify.mjs";
import { genesis, recover, buildPackage, signPackage } from "../scripts/platform-api-admin.mjs";
import { openArchive } from "../relay/state-replica.mjs";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "platform-api-hosted-"));
const servers = [];
let roles = [];
after(async () => { for (const r of roles) { try { await r.stop(); } catch {} } for (const s of servers) { try { s.closeAllConnections?.(); s.close(); } catch {} } fs.rmSync(tmp, { recursive: true, force: true }); });
const freePort = () => new Promise((ok) => { const s = net.createServer(); s.listen(0, "127.0.0.1", () => { const p = s.address().port; s.close(() => ok(p)); }); });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const waitFor = async (what, fn, ms = 30000) => { const until = Date.now() + ms; let last; while (Date.now() < until) { try { last = await fn(); if (last) return last; } catch (e) { last = e.message; } await sleep(100); } throw new Error(`timed out waiting for ${what} (${JSON.stringify(last)?.slice(0, 300)})`); };

// ---- the group ------------------------------------------------------------------------------------------------------------
const S = synthChain();
const COL = memoryCollateral({ chains: { Genoa: S.chainPem }, vceks: { Genoa: S.vcekDer }, crls: { Genoa: S.crlDer } });
const ROOTS = new Map([["Genoa", S.arkFp]]);
const MEAS = "77".repeat(48), HOSTNAME = "api.platform.test";
const ADMIN = privateKeyToAccount(generatePrivateKey()), STRANGER = privateKeyToAccount(generatePrivateKey());
const REC = hpke.generateKeyPair();
const N = 3;
const OPS = [...Array(N)].map(() => privateKeyToAccount(generatePrivateKey()).address.toLowerCase());
const FRONT_PORTS = [], ROLE_PORTS = [];
const a = (n) => "0x" + n.toString(16).padStart(40, "0");
let PA = null, archivePort = 0;
const archive = new Map();                                  // the archive sink: path -> bytes (what storage would hold)
function platformApiMember() {
  return { apiPort: 8098, peerPort: 8099, hostname: HOSTNAME,
    members: OPS.map((op, i) => ({ operator: op, publicUrl: `https://host-${i}.example.org`, controlUrl: `https://127.0.0.1:${FRONT_PORTS[i]}` })),
    measurements: [MEAS], minTcb: TCB_FLOORS, admins: [ADMIN.address], recovery: [Buffer.from(REC.publicKey).toString("hex")],
    archives: [`http://127.0.0.1:${archivePort}`], archiveMs: 5000,
    relayEnv: { ENCLAVES: "http://127.0.0.1:1", OFAC_SDN_URLS: "http://127.0.0.1:1/x", RPC_FALLBACKS: "0", SIWE_DOMAIN: "enclave.host", SIWE_URI: "https://enclave.host",
                BASE_RPC: "http://127.0.0.1:1/rpc" },
    leaseMs: 2000 };
}
const rawFor = (i, pa = PA) => ({ format: MC.CONFIG_FORMAT, chainId: 8453,
  contracts: { registry: a(0x11), deployments: a(0x12), appCatalog: a(0x13), proofOfTime: a(0x14), enclavePay: a(0), verificationFees: a(0), sessionVaultFactory: a(0), secretVaultV2: a(0) },
  profileDigest: null, rpcs: ["https://rpc-a.example/v1", "https://rpc-b.example"], quorum: 2, releaseId: "ab".repeat(32),
  replicas: { gateways: ["http://192.0.2.10:8189"], storagePlan: null },
  identity: { publicUrl: `https://host-${i}.example.org`, repo: "owner/enclave", operator: OPS[i] },
  selling: { cpuPrice6: null, payout: null }, isolation: { managerUrl: "http://10.0.2.2:8095", dataAddr: "10.0.2.2:8096" },
  hostAdmissionSha256: null, controlPort: 8444, platformApi: pa });
const registryRows = new Map();                             // registryId -> the stand-in registry row (operator, proof key)
const registry = async (id) => registryRows.get(id) || null;

/** boot one member guest stand-in: keys, statement, front, supervisor stand-in, role. `badHostData`: a guest the host
 *  launched with another config than it presents (its reports carry another HOST_DATA) */
async function bootMember(i, { badHostData = false } = {}) {
  const d = fs.mkdtempSync(path.join(tmp, `m${i}-`));
  const P = { ...MC.GUEST_PATHS, runDir: d, sessionDir: path.join(d, "session"), statement: path.join(d, "statement.json"), tlsKey: path.join(d, "tls-key.pem"),
              tlsCert: path.join(d, "tls-cert.pem"), platformApiConfig: path.join(d, "platform-api.json"), platformApiHandoffKey: path.join(d, "handoff.key"), platformApiDir: path.join(d, "pa") };
  const config = MC.canonicalDirectConfig(rawFor(i)), digest = MC.configDigest(config), hostData = MC.hostDataHex(digest);
  const keys = MC.mintControlKeys({ paths: P });
  keys.platformApi = { publicKey: MC.mintPlatformApiKey({ paths: P }) };
  const st = MC.controlStatement({ config, digest, hostData, mode: "snp", keys, runtime: { platformApiSha256: "00".repeat(32) } });
  fs.writeFileSync(P.statement, st.text);
  registryRows.set(registryIdOf(config.identity.publicUrl), { operator: OPS[i], active: true, proofKey: MC.addressOfPublicKey(keys.proof.publicKey, viem.keccak256) });
  const sup = http.createServer((req, res) => { res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ proofKey: { address: MC.addressOfPublicKey(keys.proof.publicKey, viem.keccak256) }, sessionKey: { kid: MC.jwkThumbprint(keys.session.jwk) } })); });
  await new Promise((r) => sup.listen(0, "127.0.0.1", r)); servers.push(sup);
  const launch = MC.directPlatformApiLaunch(config, { paths: P });
  const roleCfg = { ...JSON.parse(launch.files[P.platformApiConfig]), listen: ROLE_PORTS[i], askMs: 300 };
  const reporter = async (rd) => ({ report: synthReport(S, { reportData: rd, hostData: Buffer.from(badHostData ? "ee".repeat(32) : hostData, "hex") }), certs: null });
  const front = MC.createControlFront({ statementText: st.text, keyPem: fs.readFileSync(P.tlsKey, "utf8"), certPem: keys.controlTls.certPem, reporter, mode: "snp",
    upstream: { host: "127.0.0.1", port: sup.address().port },
    hostRoutes: [{ host: HOSTNAME, upstream: { host: "127.0.0.1", port: ROLE_PORTS[i].api } }],
    prefixRoutes: [{ prefix: MC.PLATFORM_API_PREFIX, upstream: { host: "127.0.0.1", port: ROLE_PORTS[i].peer } }] });
  await new Promise((r) => front.listen(FRONT_PORTS[i], "127.0.0.1", r)); servers.push(front);
  const role = await startRole({ cfg: roleCfg, recoverMessageAddress: viem.recoverMessageAddress, log: () => {},
    verifyPeer: productionVerifier(roleCfg, { registry, collateral: COL, roots: ROOTS }),
    archivePut: async (url, blob) => { archive.set(new URL(url).pathname, Buffer.from(blob)); } });
  return { i, P, config, st, keys, front, sup, role, url: `https://127.0.0.1:${FRONT_PORTS[i]}`, dataDir: roleCfg.dirs.data,
    async kill() { await role.stop(); for (const s of [front, sup]) { s.closeAllConnections?.(); await new Promise((r) => s.close(() => r())); } } };
}

/** an API request through a member's front, with the platform API Host header (the front routes it to the role) */
function api(m, method, p, { body, token } = {}) {
  const data = body ? Buffer.from(JSON.stringify(body)) : null;
  return new Promise((ok, no) => {
    const r = https.request({ host: "127.0.0.1", port: FRONT_PORTS[m.i], method, path: p, rejectUnauthorized: false, servername: HOSTNAME,
      headers: { host: HOSTNAME, ...(data ? { "content-type": "application/json", "content-length": data.length } : {}), ...(token ? { authorization: "Bearer " + token } : {}) } }, (res) => {
      const c = []; res.on("data", (x) => c.push(x)); res.on("end", () => { const t = Buffer.concat(c).toString("utf8"); let j = null; try { j = JSON.parse(t); } catch {} ok({ status: res.statusCode, body: j, text: t }); });
    });
    r.on("error", no); r.end(data || undefined);
  });
}
const peerPost = (m, p, body) => new Promise((ok, no) => {
  const data = Buffer.from(JSON.stringify(body));
  const r = https.request({ host: "127.0.0.1", port: FRONT_PORTS[m.i], method: "POST", path: p, rejectUnauthorized: false, headers: { "content-type": "application/json", "content-length": data.length } }, (res) => {
    const c = []; res.on("data", (x) => c.push(x)); res.on("end", () => { let j = null; try { j = JSON.parse(Buffer.concat(c).toString("utf8")); } catch {} ok({ status: res.statusCode, body: j }); });
  });
  r.on("error", no); r.end(data);
});
const WALLET = privateKeyToAccount(generatePrivateKey());
async function siwe(m) {
  const n = await api(m, "GET", `/v1/account/siwe/nonce?address=${WALLET.address}`);
  assert.equal(n.status, 200, n.text);
  const signature = await WALLET.signMessage({ message: n.body.message });
  return api(m, "POST", "/v1/account/siwe/verify", { body: { message: n.body.message, signature } });
}
const leaderOf = (ms) => ms.find((m) => m.role.status().role === "leader" && m.role.status().relay);
const accountsHave = (m, id) => { try { return fs.readFileSync(path.join(m.dataDir, "accounts.json"), "utf8").includes(id); } catch { return false; } };

let M = [];
test("setup: three member guests; genesis by the admin to member 0; members 1 and 2 receive the key only after the REAL verifier accepted them; one primary runs the relay", { timeout: 120000 }, async () => {
  for (let i = 0; i < N; i++) { FRONT_PORTS.push(await freePort()); ROLE_PORTS.push({ api: await freePort(), peer: await freePort() }); }
  archivePort = await freePort();
  PA = MC.canonicalDirectConfig(rawFor(0, platformApiMember())).platformApi;
  for (let i = 0; i < N; i++) M.push(await bootMember(i));
  roles = M.map((m) => m.role);
  for (const m of M) assert.equal(m.role.status().haveKey, false, "no member holds a key before genesis");
  // the admin: a new group key, sealed to member 0's attested boot, signed by the admin wallet
  const g = await genesis({ platformApi: PA, targetStatementText: M[0].st.text, account: ADMIN });
  assert.equal(g.package.groupId, groupIdOf(PA));
  const r = await peerPost(M[0], BOOTSTRAP_PATH, g.package);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  await waitFor("every member holds the key", () => M.every((m) => m.role.status().haveKey));
  const lead = await waitFor("a primary running the relay", () => leaderOf(M), 60000);
  assert.ok(lead);
  assert.equal(M.filter((m) => m.role.status().role === "leader").length, 1);
});

let ACCOUNT = null, TOKEN = null;
test("the relay's accounts through ANY member's front (standbys forward to the primary); a write is on a majority BEFORE its response is released", { timeout: 60000 }, async () => {
  const lead = leaderOf(M), standby = M.find((m) => m !== lead);
  const login = await siwe(standby);
  assert.equal(login.status, 200, login.text);
  assert.match(login.body.accountId, /^acct_[0-9a-f]{24}$/);
  ACCOUNT = login.body.accountId; TOKEN = login.body.token;
  // the response barrier: when the client has its answer, a majority of members already hold the new account
  assert.ok(M.filter((m) => accountsHave(m, ACCOUNT)).length >= 2, "a majority holds the account the moment the response arrived");
  const me = await api(lead, "GET", "/v1/account/me", { token: TOKEN });
  assert.equal(me.status, 200); assert.deepEqual(me.body.wallets, [WALLET.address.toLowerCase()]);
  const health = await api(standby, "GET", "/health");
  assert.equal(health.status, 200, "the relay's own routes, unchanged, through a standby");
});

test("the primary's host is lost: the others elect a successor within a few leases; the same wallet gets the SAME account and the old session token still verifies", { timeout: 90000 }, async () => {
  const lead = leaderOf(M);
  await lead.kill();
  const rest = M.filter((m) => m !== lead);
  const next = await waitFor("a new primary", () => leaderOf(rest), 60000);
  assert.ok(next && next !== lead);
  const again = await siwe(rest.find((m) => m !== next));
  assert.equal(again.status, 200, again.text);
  assert.equal(again.body.accountId, ACCOUNT, "the account survived the loss of its primary's host");
  const me = await api(next, "GET", "/v1/account/me", { token: TOKEN });
  assert.equal(me.status, 200, "a token signed before the failover verifies after it: the account-session signing key is replicated state");
  // the lost host comes back as a NEW boot (new keys): it is verified and handed the key again, and catches up
  const back = await bootMember(lead.i);
  M = M.map((m) => (m === lead ? back : m)); roles = M.map((m) => m.role);
  await waitFor("the rebooted member holds the key and the state", () => back.role.status().haveKey && accountsHave(back, ACCOUNT), 60000);
});

test("platform credentials: only an admin-signed package sealed to the primary's boot; replicated as state; the relay restarts with them; archives and replicas see ciphertext only", { timeout: 90000 }, async () => {
  const lead = leaderOf(M);
  const canary = "whsec_canary_" + randomBytes(8).toString("hex");
  const unsigned = buildPackage({ kind: "credentials", platformApi: PA, targetStatementText: lead.st.text, credentials: { STRIPE_WEBHOOK_SECRET: canary } });
  let r = await peerPost(lead, CREDENTIALS_PATH, await signPackage(unsigned, STRANGER));
  assert.equal(r.status, 403, "a stranger's signature is refused"); assert.equal(r.body.error, "not_admin");
  const standby = M.find((m) => m !== lead);
  r = await peerPost(standby, CREDENTIALS_PATH, await signPackage(unsigned, ADMIN));
  assert.equal(r.status, 409, "only the primary takes credentials");
  const signed = await signPackage(unsigned, ADMIN);
  r = await peerPost(lead, CREDENTIALS_PATH, signed);
  assert.equal(r.status, 200, JSON.stringify(r.body)); assert.deepEqual(r.body.names, ["STRIPE_WEBHOOK_SECRET"]);
  r = await peerPost(lead, CREDENTIALS_PATH, signed);
  assert.equal(r.status, 409, "the same admin package replayed later cannot roll credentials back"); assert.equal(r.body.error, "not_newer");
  await waitFor("the credentials on a majority", () => M.filter((m) => fs.existsSync(path.join(m.dataDir, CREDENTIALS_FILE))).length >= 2);
  const pid = await waitFor("the relay restarted", () => lead.role.status().relay && lead.role.status().childPid);
  assert.ok(fs.readFileSync(`/proc/${pid}/environ`, "utf8").split("\0").includes(`STRIPE_WEBHOOK_SECRET=${canary}`), "the relay runs with the credential in its environment");
  // the next archive carries the state, and holds neither the canary nor the account in plaintext
  const before = archive.get(`/platform-api/${groupIdOf(PA)}/latest`);
  await waitFor("a newer archive", () => { const b = archive.get(`/platform-api/${groupIdOf(PA)}/latest`); return b && b !== before; }, 30000);
  const blob = archive.get(`/platform-api/${groupIdOf(PA)}/latest`);
  for (const plain of [canary, ACCOUNT, WALLET.address.toLowerCase(), "accounts.json"]) assert.ok(!blob.includes(plain), `no plaintext ${plain.slice(0, 12)}… in the archive`);
  const rec = JSON.parse(archive.get(`/platform-api/${groupIdOf(PA)}/recovery.json`).toString("utf8"));
  assert.ok(!JSON.stringify(rec).includes(canary));
});

test("refused: a bootstrap not signed by an admin, one meant for another boot, a handoff to a config of another group, and a newcomer whose report does not bind its config", { timeout: 90000 }, async () => {
  const lead = leaderOf(M);
  // a fresh, key-less boot of member 0's host (its old boot is replaced), so bootstrap is attempted on a member without a key
  const target = M.find((m) => m !== lead);
  const stray = await genesis({ platformApi: PA, targetStatementText: target.st.text, account: STRANGER });
  let r = await peerPost(target, BOOTSTRAP_PATH, stray.package);
  assert.ok([403, 409].includes(r.status), JSON.stringify(r.body));                   // 409 if it already holds the key
  // a handoff for another group's config is refused before any verification
  const other = { ...rawFor(target.i), platformApi: { ...rawFor(target.i).platformApi, hostname: "api.other.test" } };
  r = await peerPost(lead, HANDOFF_PATH, { config: other });
  assert.equal(r.status, 403); assert.equal(r.body.error, "not_this_group");
  // a newcomer whose hardware report names another HOST_DATA than its presented config: the real verifier rejects it
  await target.kill();
  const rogue = await bootMember(target.i, { badHostData: true });
  M = M.map((m) => (m === target ? rogue : m)); roles = M.map((m) => m.role);
  await sleep(3000);
  assert.equal(rogue.role.status().haveKey, false, "the key is never handed to a guest whose report does not bind its config");
  // the admin's genesis to a key-holding member is refused too, signed or not
  r = await peerPost(lead, BOOTSTRAP_PATH, (await genesis({ platformApi: PA, targetStatementText: lead.st.text, account: ADMIN })).package);
  assert.equal(r.status, 409);
  await rogue.kill();
  const good = await bootMember(target.i);
  M = M.map((m) => (m === rogue ? good : m)); roles = M.map((m) => m.role);
  await waitFor("the honest reboot is handed the key", () => good.role.status().haveKey, 60000);
});

test("total loss: every member gone; the admin opens the escrowed key OFFLINE and seals it with the latest archive to a fresh boot; the group comes back with the same account", { timeout: 120000 }, async () => {
  for (const m of M) await m.kill();
  const blob = archive.get(`/platform-api/${groupIdOf(PA)}/latest`), envelope = JSON.parse(archive.get(`/platform-api/${groupIdOf(PA)}/recovery.json`).toString("utf8"));
  // three new boots (new keys): none holds anything
  const fresh = [];
  for (let i = 0; i < N; i++) fresh.push(await bootMember(i));
  M = fresh; roles = M.map((m) => m.role);
  const { package: pkg } = await recover({ platformApi: PA, targetStatementText: M[0].st.text, account: ADMIN, envelope, recoveryPrivateKey: Buffer.from(REC.privateKey), archive: blob });
  const r = await peerPost(M[0], BOOTSTRAP_PATH, pkg);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  await waitFor("every fresh member holds the key", () => M.every((m) => m.role.status().haveKey), 60000);
  await waitFor("a primary", () => leaderOf(M), 60000);
  const login = await siwe(M[2]);
  assert.equal(login.status, 200, login.text);
  assert.equal(login.body.accountId, ACCOUNT, "the account came back from the encrypted archive");
  // the recovered state is what the archive holds: the recovery key opens it, nothing else does
  const k = (await import("../metal/guest/platform-api-role.mjs")).openRecovery(envelope, { groupId: groupIdOf(PA), privateKey: Buffer.from(REC.privateKey) });
  assert.ok(Object.keys(openArchive(k, blob).files).includes("accounts.json"));
});
