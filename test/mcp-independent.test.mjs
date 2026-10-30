// The independent MCP server (mcp/server.mjs) end to end, over the REAL MCP stdio protocol, against the ORIGINAL contracts
// on anvil (test/helpers/mcp-independent-rig.mjs: the rev-16d ledger, the schema-4 registry, the admin AddressBook, the
// production SessionVaultFactory, catalog, reviews), three scriptable RPC proxies, the real management plane (directory,
// operator-signed record, gateway with the session verifier) and HTTPS storage adapters that verify upload signatures.
//
// The MCP process runs under test/helpers/cli-network-guard.mjs: every non-loopback connection is refused and logged, and
// so is any connection to the stand-in Enclave API's port (also handed to it as API_RELAY_PORT, the hosted backend's
// gateway). The tests require both logs to stay empty, and the CONTROL runs the very same tools over the hosted backend to
// show it does reach the gateway and public RPCs: the independence is measured, not assumed.
//
// The test plays the user's side: it holds the wallet keys and the session key, signs what the server prepared, and sends
// the unsigned transactions itself. The server is never given a private key.
import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { spawn } from "node:child_process";
import { createPrivateKey, createPublicKey, sign as signBytes } from "node:crypto";
import { fileURLToPath, pathToFileURL } from "node:url";
import { privateKeyToAccount } from "viem/accounts";
import { decodeFunctionData, getAddress, parseUnits, toHex } from "viem";
import { haveTools, startManagement, openSession, startStorage, KEYS } from "./helpers/cli-independent-rig.mjs";
import { startOriginalRig, stdioClient, startCustody } from "./helpers/mcp-independent-rig.mjs";
import { platformPolicyWorld, BOOK as POLICY_BOOK, OWNERSHIP as POLICY_OWNERSHIP } from "./helpers/platform-policy-world.mjs";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const GUARD = pathToFileURL(path.join(REPO, "test/helpers/cli-network-guard.mjs")).href;
const skip = haveTools();
const T = skip ? { skip, timeout: 240000 } : { timeout: 240000 };
let r, tmp, netLog, routeLog, m, storage, custody, sess, sessKey, sess2, sess2Key, vaultId, newId, mcp, child, cfgFile, stderr = "";

function writeConfig(file, profiles) { fs.writeFileSync(file, JSON.stringify({ format: "enclave-mcp-independent/v1", profiles })); }
const profileFor = (pins, extra = {}) => ({ contractPins: pins, usdc: r.addresses.usdc, rpcs: r.rpcs, quorum: 2, confirmations: 1, maxBlockAgeSec: 120,
  managementDirectories: [m.directoryOrigin], storagePlan: storage.planFile, grantFrontend: "https://frontend.example",
  sessionScan: { fromBlock: 0, chunk: 500, maxChunks: 40 }, stateDir: path.join(tmp, "state-" + Math.random().toString(16).slice(2)), ...extra });
function spawnServer(args, extraEnv = {}) {
  const p = spawn(process.execPath, [path.join(REPO, "mcp/server.mjs"), ...args], { cwd: tmp, stdio: ["pipe", "pipe", "pipe"], env: {
    PATH: process.env.PATH, HOME: tmp, NODE_OPTIONS: `--import=${GUARD}`, ENCLAVE_TEST_NET_LOG: netLog, ENCLAVE_TEST_DENY_PORT: String(r.apiPort),
    API_RELAY_PORT: String(r.apiPort), ENCLAVE_TEST_ROUTE: `${m.route},${custody.route}`, ENCLAVE_TEST_ROUTE_LOG: routeLog, NODE_EXTRA_CA_CERTS: custody.caFile, ...extraEnv } });
  p.stderr.on("data", (d) => { stderr += d; });
  return p;
}
const settle = async () => { await r.mine(); await r.mine(); await r.mine(); };
function noEnclave() {
  assert.deepEqual(r.apiHits, [], "the stand-in Enclave API was called");
  assert.equal(fs.readFileSync(netLog, "utf8"), "", "a non-loopback or Enclave connection was attempted");
}
// the user's side: wallet keys sign and send what the server prepared
async function send(key, t) {
  const rc = await r.pc.waitForTransactionReceipt({ hash: await r.wc(key).sendTransaction({ to: t.to, data: t.data, value: BigInt(t.value) }) });
  assert.equal(rc.status, "success", t.function); return rc;
}
// typed data travels as JSON (integers as strings); a wallet takes them as numbers again
function typedForWallet(td) {
  const conv = (type, v) => {
    if (/^u?int\d*$/.test(type)) return BigInt(v);
    if (type.endsWith("[]")) return v.map((x) => conv(type.slice(0, -2), x));
    if (td.types[type]) return Object.fromEntries(td.types[type].map((f) => [f.name, conv(f.type, v[f.name])]));
    return v;
  };
  return { domain: { ...td.domain, chainId: Number(td.domain.chainId) }, types: td.types, primaryType: td.primaryType, message: conv(td.primaryType, td.message) };
}
const p256 = (key, bytes) => "0x" + signBytes("sha256", bytes, { key, dsaEncoding: "ieee-p1363" }).toString("hex");
const pubOf = (key) => { const j = createPublicKey(key).export({ format: "jwk" }); return { x: j.x, y: j.y }; };
async function signedCall(name, args) {
  const first = await mcp.call(name, { ...args, session: sess });
  assert.equal(first.ok, true, first.text); assert.equal(first.value.prepared, true, JSON.stringify(first.value).slice(0, 300));
  const s = first.value.sign;
  return mcp.call(name, { ...args, ...(first.value.repeat || {}), session: sess, publicKey: pubOf(sessKey), signature: p256(sessKey, Buffer.from(s.message)), ts: s.ts, n: s.n });
}

before(async () => {
  if (skip) return;
  r = await startOriginalRig();
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-independent-"));
  netLog = path.join(tmp, "net.log"); routeLog = path.join(tmp, "route.log"); fs.writeFileSync(netLog, "");
  // an EXISTING wallet session on the production (address-book) factory, opened by the owner
  const sessionDir = path.join(tmp, "sessions");
  const opened = await openSession(r, { sessionDir, actions: ["api.status", "api.logs", "api.restart", "deploy.setActive", "deploy.fund", "api.placement"] });
  sess = { vault: opened.vault, sid: opened.sid };
  const S = await import("../sdk/sessions/dist/node.mjs");
  const rec = await new S.FileStore(sessionDir).load(opened.sid);
  sessKey = createPrivateKey({ key: Buffer.from(rec.pkcs8, "base64url"), format: "der", type: "pkcs8" });
  vaultId = await opened.createViaVault();
  const owner = r.wc(KEYS.owner);
  await r.write(owner, r.addresses.usdc, r.A.usdc.abi, "approve", [r.addresses.ledger, parseUnits("1", 6)]);
  await r.write(owner, r.addresses.ledger, r.A.ledger.abi, "fund", [vaultId, parseUnits("1", 6)]);
  await r.write(r.wc(KEYS.operator), r.addresses.ledger, r.A.ledger.abi, "claim", [vaultId, r.runner]);
  await settle();
  m = await startManagement(r, { id: vaultId, dir: tmp });
  storage = await startStorage(r, { dir: tmp });
  custody = await startCustody(r, { dir: tmp });
  r.pins.contracts.secretVaultV2 = custody.vault;   // the ORIGINAL book-bound vault, as production's 0xE486
  const pins = path.join(tmp, "pins.json"); fs.writeFileSync(pins, JSON.stringify(r.pins));
  cfgFile = path.join(tmp, "mcp.json"); writeConfig(cfgFile, { local: profileFor(pins) });
  child = spawnServer(["--config", cfgFile, "--profile", "local"]);
  mcp = stdioClient(child);
  const init = await mcp.request("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "1" } });
  assert.equal(init.result.serverInfo.title, "Enclave (independent)", JSON.stringify(init) + stderr);
  mcp.notify("notifications/initialized");
});
after(async () => { try { child?.kill("SIGKILL"); } catch {} if (r) await r.stop(); if (tmp) fs.rmSync(tmp, { recursive: true, force: true }); });

test("tools/list: the hosted tool set, name for name and argument for argument; independent additions are optional", T, async () => {
  const { createTools } = await import("../relay/mcp.js");
  const legacy = createTools({ read() {}, addresses() {}, depRev() {}, catRev() {}, catalogApps() {} }).tools;
  const list = (await mcp.request("tools/list")).result.tools;
  assert.deepEqual(list.map((t) => t.name), legacy.map((t) => t.name));
  assert.equal(list.length, 41);
  const relaxed = { upload_token: ["expiry", "signature"], session_request: ["label"], get_secrets: ["expiry", "signature"], set_secrets: ["expiry", "signature", "payload"] };
  for (const [i, t] of list.entries()) {
    const o = legacy[i];
    assert.ok(t.description.startsWith(o.description), `${t.name}: the original description is kept`);
    for (const [k, v] of Object.entries(o.inputSchema.properties)) assert.deepEqual(t.inputSchema.properties[k], v, `${t.name}.${k} unchanged`);
    assert.deepEqual(t.inputSchema.required, (o.inputSchema.required || []).filter((x) => !(relaxed[t.name] || []).includes(x)), `${t.name} required`);
  }
  noEnclave();
});

test("catalog reads and platform moderation: delisting, rejection and pending-public refusals hold without the gateway", T, async () => {
  await settle();
  const apps = await mcp.call("list_apps");
  assert.equal(apps.ok, true, apps.text);
  assert.deepEqual(apps.value.apps.map((a) => a.slug).sort(), ["hello", "thirdparty"]);
  assert.ok(apps.value.authority.blockNumber && apps.value.authority.agreeing >= 2, "every answer names its agreed block");
  assert.equal(apps.value.authority.bindings.addressBook.toLowerCase(), r.addresses.book.toLowerCase(), "the admin AddressBook resolved the bindings");
  const third = await mcp.call("get_app", { app: "thirdparty" });
  assert.deepEqual(third.value.versions.map((v) => v.approval), ["pending", "rejected"]);
  const rejected = await mcp.call("plan_deploy", { app: "thirdparty:2", gpuShare: 0, cpuShare: 0.1 });
  assert.equal(rejected.ok, false); assert.match(rejected.text, /rejected by the catalog owner/);
  const pendingPublic = await mcp.call("plan_deploy", { app: "thirdparty:1", gpuShare: 0, cpuShare: 0.1 });
  assert.equal(pendingPublic.ok, false); assert.match(pendingPublic.text, /awaiting|pending/);
  // a private dev deploy of a pending version needs fleet devDeploy; no verified capacity record says so: refused, fail closed
  const pendingPrivate = await mcp.call("plan_deploy", { app: "thirdparty:1", gpuShare: 0, cpuShare: 0.1, public: false });
  assert.equal(pendingPrivate.ok, false); assert.match(pendingPrivate.text, /devDeploy/);
  noEnclave();
});

test("a NEW user deploys with no gateway: plan, sign, create, fund, then the host claims it - each step from the quorum", T, async () => {
  await settle();
  const user = privateKeyToAccount(KEYS.other).address;
  const noShares = await mcp.call("plan_deploy", { app: "hello:2", fundUsd: 1 });
  assert.equal(noShares.ok, false); assert.match(noShares.text, /hardware sizes are not on chain.*gpuShare and cpuShare explicitly/);
  const plan = await mcp.call("plan_deploy", { app: "hello:2", gpuShare: 0, cpuShare: 0.1, fundUsd: 1 });
  assert.equal(plan.ok, true, plan.text);
  assert.equal(plan.value.pricedBy, "the cheapest live enclave");
  assert.ok(plan.value.authority.revalidatedAt, "the builder re-checked its snapshot at a fresh block before answering");
  const create = plan.value.transactions[0];
  assert.equal(create.to.toLowerCase(), r.addresses.ledger.toLowerCase());
  const args = decodeFunctionData({ abi: r.A.ledger.abi, data: create.data }).args;
  assert.equal(args[0], `catalog://${r.appId}/1`); assert.equal(args[1], 0); assert.equal(args[2], 100);
  const id = r.createdId(await send(KEYS.other, create)); newId = id;
  await settle();
  const fund = await mcp.call("build_fund", { id, usd: 1 });
  assert.equal(fund.ok, true, fund.text); assert.equal(fund.value.transactions.length, 2);
  assert.equal(fund.value.transactions[0].to.toLowerCase(), r.addresses.usdc.toLowerCase(), "the approve names the token the bound contracts take, read with the bindings");
  for (const t of fund.value.transactions) await send(KEYS.other, t);
  await settle();
  const q = await mcp.call("get_deployment", { id: id.slice(0, 14) });   // a unique id prefix resolves on the ledger itself
  assert.equal(q.ok, true, q.text); assert.equal(q.value.id, id); assert.equal(q.value.status, "queued"); assert.equal(q.value.owner, user);
  await r.write(r.wc(KEYS.operator), r.addresses.ledger, r.A.ledger.abi, "claim", [id, r.runner]);
  await settle();
  const c = await mcp.call("get_deployment", { id });
  assert.equal(c.value.status, "claimed"); assert.equal(c.value.runner.endpoint, r.endpoint); assert.equal(c.value.runner.operatorMatchesLease, true);
  const mine = await mcp.call("list_deployments", { owner: user });
  assert.deepEqual(mine.value.deployments.map((d) => d.id), [id]);
  const acct = await mcp.call("account", { owner: user });
  assert.equal(acct.ok, true, acct.text); assert.equal(acct.value.deployments.total, 1);
  const stop = await mcp.call("build_stop", { id });
  await send(KEYS.other, stop.value.transactions[0]);
  await settle();
  assert.equal((await mcp.call("get_deployment", { id })).value.status, "stopped");
  noEnclave();
});

test("an EXISTING session on the production factory: found on chain, host reached by client-signed requests, session-signed stop sent by any gas payer", T, async () => {
  await settle();
  const st = await mcp.call("session_status", { owner: r.owner });
  assert.equal(st.ok, true, st.text);
  assert.equal(st.value.vault.toLowerCase(), sess.vault.toLowerCase());
  const s = st.value.sessions.find((x) => x.sid === sess.sid.toLowerCase());
  assert.ok(s && s.live === true && s.actions.includes("api.logs"), JSON.stringify(st.value.sessions));
  const byKey = await mcp.call("session_status", { publicKey: pubOf(sessKey) });
  assert.deepEqual(byKey.value.sessions.map((x) => x.sid), [sess.sid.toLowerCase()]);
  // owner management through the signed host endpoint: status, logs, restart - each request signed by the session key here
  const live = await signedCall("get_deployment", { id: vaultId });
  assert.equal(live.ok, true, live.text); assert.equal(live.value.live.status.status, "running");
  const logs = await signedCall("deployment_logs", { id: vaultId, tail: 20 });
  assert.equal(logs.ok, true, logs.text); assert.match(logs.text, /line two/);
  const restarts = m.restarts();
  const rs = await signedCall("restart_deployment", { id: vaultId });
  assert.equal(rs.ok, true, rs.text); assert.equal(m.restarts(), restarts + 1);
  // a forged signature is refused before anything reaches the host
  const before = m.hits.length;
  const prep = await mcp.call("deployment_logs", { id: vaultId, session: sess });
  const bad = await mcp.call("deployment_logs", { id: vaultId, session: sess, publicKey: pubOf(sessKey), signature: "0x" + "11".repeat(64), ts: prep.value.sign.ts, n: prep.value.sign.n });
  assert.equal(bad.ok, false); assert.match(bad.text, /did not sign exactly this request|signer/); assert.equal(m.hits.length, before);
  // a session-signed stop of the vault-held record: digests prepared from the vault itself, signed here, executed by a gas payer
  const stop = await mcp.call("build_stop", { id: vaultId, session: sess });
  assert.equal(stop.ok, true, stop.text); assert.equal(stop.value.calls.length, 1); assert.equal(stop.value.calls[0].fee, "0");
  const calls = stop.value.calls.map((c) => ({ ...c, signature: p256(sessKey, Buffer.from(c.digest.slice(2), "hex")) }));
  const ex = await mcp.call("session_execute", { vault: sess.vault, sid: sess.sid, publicKey: pubOf(sessKey), calls });
  assert.equal(ex.ok, true, ex.text);
  await send(KEYS.other, ex.value.transactions[0]);   // the gas payer is NOT the owner and holds no authority
  await settle();
  const row = await r.pc.readContract({ address: r.addresses.ledger, abi: r.A.ledger.abi, functionName: "get", args: [vaultId] });
  assert.equal(row.active, false, "the session's stop landed through the vault");
  noEnclave();
  assert.ok(fs.readFileSync(routeLog, "utf8").length > 0, "the host was reached at the address its operator signed");
});

test("a new session: the owner signs the grant, any gas payer opens it, and the server never sees a private key", T, async () => {
  await settle();
  const { generateKeyPairSync } = await import("node:crypto");
  const { privateKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
  const pk = pubOf(privateKey);
  const req = await mcp.call("session_request", { publicKey: pk, label: "mcp test", preset: "agent", budgetUsd: 0, owner: r.owner });
  assert.equal(req.ok, true, req.text); assert.ok(req.value.link.startsWith("https://frontend.example/grant#"));
  const td = typedForWallet(req.value.typedData);
  const ownerSig = await privateKeyToAccount(KEYS.owner).signTypedData(td);
  const forged = await privateKeyToAccount(KEYS.other).signTypedData(td);
  const refused = await mcp.call("session_request", { publicKey: pk, owner: r.owner, grantRequest: req.value.grantRequest, ownerSignature: forged });
  assert.equal(refused.ok, false); assert.match(refused.text, /not .*SessionGrant signature/);
  const open = await mcp.call("session_request", { publicKey: pk, owner: r.owner, grantRequest: req.value.grantRequest, ownerSignature: ownerSig });
  assert.equal(open.ok, true, open.text);
  await send(KEYS.other, open.value.transactions[0]);
  await settle();
  const st = await mcp.call("session_status", { publicKey: pk });
  assert.equal(st.value.sessions[0]?.sid, open.value.sid.toLowerCase()); assert.equal(st.value.sessions[0].live, true);
  sess2 = { vault: open.value.vault, sid: open.value.sid }; sess2Key = privateKey;   // the agent preset: api.placement included
  noEnclave();
});

test("uploads: per-adapter messages signed by the wallet; the bytes go from the client to each adapter and read back", T, async () => {
  const bytes = Buffer.from(JSON.stringify({ app: "config", n: 1 }));
  const hash = (await import("node:crypto")).createHash("sha256").update(bytes).digest("hex");
  const publisher = privateKeyToAccount(KEYS.owner);
  const prep = await mcp.call("upload_token", { hash, size: bytes.length, kind: "json", address: publisher.address });
  assert.equal(prep.ok, true, prep.text); assert.equal(prep.value.replicas.length, 3);
  const signatures = await Promise.all(prep.value.replicas.map((x) => publisher.signMessage({ message: x.message })));
  const wrong = await mcp.call("upload_token", { hash, size: bytes.length, kind: "json", address: publisher.address, expiry: prep.value.expiry, signatures: [...signatures].reverse() });
  assert.equal(wrong.ok, false);
  const ok = await mcp.call("upload_token", { hash, size: bytes.length, kind: "json", address: publisher.address, expiry: prep.value.expiry, signatures });
  assert.equal(ok.ok, true, ok.text);
  const https = await import("node:https"), ca = fs.readFileSync(storage.caFile);
  const post = (url, headers) => new Promise((ok2, no) => { const q = https.request(url, { method: "POST", ca, headers: { ...headers, "content-length": bytes.length } }, (res) => {
    let d = ""; res.on("data", (c) => (d += c)); res.on("end", () => ok2({ status: res.statusCode, body: d })); }); q.on("error", no); q.end(bytes); });
  const cids = new Set();
  for (const u of ok.value.uploads) {
    const res = await post(u.url, u.headers);
    assert.equal(res.status, 200, res.body); cids.add(JSON.parse(res.body).cid);
  }
  assert.equal(cids.size, 1, "every adapter computed the same CID");
  assert.equal(storage.uploads.filter((x) => x.signer === publisher.address.toLowerCase()).length, 3);
  noEnclave();
});

test("every other tool answers from independent sources: reads, host requests, builders decoded and sent, the session ended", T, async () => {
  await settle();
  const ok = async (name, args = {}) => { const x = await mcp.call(name, args); assert.equal(x.ok, true, `${name}: ${x.text}`); return x.value; };
  const refused = async (name, args, re) => { const x = await mcp.call(name, args); assert.equal(x.ok, false, `${name} should refuse`); assert.match(x.text, re); };
  const decode = (t) => decodeFunctionData({ abi: t.to.toLowerCase() === r.addresses.ledger.toLowerCase() ? r.A.ledger.abi
    : t.to.toLowerCase() === r.addresses.catalog.toLowerCase() ? r.A.catalog.abi : r.A.reviews.abi, data: t.data });
  assert.match(await ok("guide", { topic: "getting-started" }), /wallet on Base/);
  const ps = await ok("platform_status");
  assert.equal(ps.registeredHosts, 2, "the compute host and the custody seat's host"); assert.equal(ps.liveHosts, 2); assert.match(ps.gateway, /^none/);
  const pr = await ok("pricing");
  assert.equal(pr.cheapestLive.cpuNodePerSec6, "1000"); assert.equal(pr.hardware, null);
  const av = await ok("availability");
  assert.equal(av.aggregate, false); assert.equal(av.cheapestCpuPricePerSec6, "1000"); assert.equal(av.liveHosts, 2);
  assert.deepEqual((await ok("gpu_capacity")).gpuHosts, []);
  assert.ok((await ok("fleet_attestation")).hosts.some((h) => h.endpoint === r.endpoint));
  assert.equal((await ok("deployment_attestation", { id: vaultId })).runner.endpoint, r.endpoint);
  assert.equal((await ok("auth_nonce", { address: r.owner })).message, null);
  await refused("auth_login", { message: "m", signature: "0x00" }, /mints no session tokens/);
  await refused("get_secrets", { id: vaultId }, /no custody v2 policy .*--owner-read on/);   // the owner's opt-in policy comes first
  // reviews: the EnclaveReviews the admin's book names; the new user's funded deployment is the receipt
  assert.equal((await ok("app_reviews", { app: "hello" })).count, 0);
  const rv = await ok("build_review", { app: "hello", reviewer: privateKeyToAccount(KEYS.other).address, stars: 5, comment: "ran it" });
  assert.equal(rv.receipt, newId); assert.equal(decode(rv.transactions[0]).functionName, "post");
  await send(KEYS.other, rv.transactions[0]); await settle();
  const after = await ok("app_reviews", { app: "hello" });
  assert.equal(after.count, 1); assert.equal(after.average, 5); assert.equal(after.reviews[0].body, "ran it");
  // the shared builders over the new user's record, each decoded against the ledger ABI and the cheap ones sent
  const up = await ok("build_upgrade", { id: newId, version: "1" });
  assert.equal(decode(up.transactions[0]).functionName, "setAppRef"); assert.equal(decode(up.transactions[0]).args[1], `catalog://${r.appId}/0`);
  assert.match(up.notice, /share floors were not checked/);
  await send(KEYS.other, up.transactions[0]); await settle();
  assert.equal((await ok("get_deployment", { id: newId })).appRef, `catalog://${r.appId}/0`);
  // the original rate-cap gate: a bigger slice above the owner's ceiling is refused until the ceiling moves
  await refused("build_resize", { id: newId, cpuShare: 0.2 }, /above the deployment's rate cap/);
  const cap = await ok("build_set_max_rate", { id: newId, maxRatePerHour: 1 });
  assert.equal(decode(cap.transactions[0]).functionName, "setMaxRate");
  await send(KEYS.other, cap.transactions[0]); await settle();
  const rz = await ok("build_resize", { id: newId, cpuShare: 0.2 });
  assert.deepEqual(decode(rz.transactions[0]).args.slice(1), [0, 200]);
  const resume = await ok("build_resume", { id: newId });
  assert.deepEqual(decode(resume.transactions[0]).args.slice(1), [true]);
  const cfg0 = await ok("get_config", { id: newId });
  assert.equal(cfg0.envelope, ""); assert.equal(cfg0.waf, null);
  const sc = await ok("build_set_config", { id: newId, waf: { rps: 10 } });
  assert.equal(decode(sc.transactions[0]).args[1], '{"waf":{"rps":10}}');
  await send(KEYS.other, sc.transactions[0]); await settle();
  assert.deepEqual((await ok("get_config", { id: newId })).waf, { rps: 10 });
  const rf = await mcp.call("build_refund", { id: newId });
  if (rf.ok) assert.equal(decode(rf.value.transactions[0]).functionName, "refund"); else assert.match(rf.text, /nothing (refundable yet|to refund)/);
  const tr = await ok("build_transfer", { id: newId, to: r.owner });
  assert.equal(decode(tr.transactions.at(-1)).functionName, "transferDeployment");
  const hf = await ok("build_host_fund", { address: r.operator, eth: 0.001 });
  assert.equal(BigInt(hf.transactions[0].value), 10n ** 15n);
  // publish: a new version from a new publisher, sent, then read back as pending
  const cid = (await import("../sdk/storage/unixfs.mjs")).artifactIdentity(new Uint8Array(Buffer.from("published through mcp"))).cid;
  const pb = await ok("build_publish", { publisher: privateKeyToAccount(KEYS.other).address, slug: "mcpapp", cid, ports: "http:8080" });
  assert.equal(decode(pb.transactions[0]).functionName, "publishVersion");
  await send(KEYS.other, pb.transactions[0]); await settle();
  assert.deepEqual((await ok("get_app", { app: `${privateKeyToAccount(KEYS.other).address}/mcpapp` })).versions.map((v) => v.approval), ["pending"]);
  // the delegation grant, sent by the owner
  const dg = await ok("build_delegate", { owner: r.owner });
  await send(KEYS.owner, dg.transactions[0]);
  // host requests on the vault's record: resume it through the session, then a claim hint and a hosted teardown (release)
  const res = await ok("build_resume", { id: vaultId, session: sess });
  const ex = await ok("session_execute", { vault: sess.vault, sid: sess.sid, publicKey: pubOf(sessKey),
    calls: res.calls.map((c) => ({ ...c, signature: p256(sessKey, Buffer.from(c.digest.slice(2), "hex")) })) });
  await send(KEYS.other, ex.transactions[0]); await settle();
  assert.equal((await ok("claim_hint", { id: vaultId })).sent, false, "no session: nothing is sent");
  const hint = await signedCall("claim_hint", { id: vaultId, enclave: r.runner });
  assert.equal(hint.ok, true, hint.text); assert.equal(hint.value.sent, true); assert.equal(typeof hint.value.answer.accepted, "boolean");
  const att = await signedCall("deployment_attestation", { id: vaultId });
  assert.equal(att.ok, true, att.text); assert.match(att.value.verdict, /NOT VERIFIED/);
  const td = await signedCall("terminate_hosted", { id: vaultId });
  assert.equal(td.ok, true, td.text); assert.equal(td.value.released.released, true); assert.ok(m.chainEffects.includes("release"));
  // the session ends itself: digest, signature, a transaction any gas payer sends
  const e1 = await ok("session_end", { vault: sess.vault, sid: sess.sid });
  const e2 = await ok("session_end", { vault: sess.vault, sid: sess.sid, publicKey: pubOf(sessKey), deadline: e1.deadline,
    signature: p256(sessKey, Buffer.from(e1.digest.slice(2), "hex")) });
  await send(KEYS.other, e2.transactions[0]); await settle();
  assert.equal((await ok("session_status", { owner: r.owner })).sessions.find((x) => x.sid === sess.sid.toLowerCase()).live, false);
  noEnclave();
});

test("secrets through custody v2: the owner's own client reads, merges, removes, replaces and clears; opt-in, pause, revision and transfer guards hold; a remote adapter never sees plaintext", T, async () => {
  await settle();
  const owner = privateKeyToAccount(KEYS.owner);
  const id = r.createdId(await r.create(KEYS.owner)); await settle();
  // a deployment with no custody policy: the owner's own policy (rules, committee, opt-in) comes first
  const none = await mcp.call("get_secrets", { id });
  assert.equal(none.ok, false); assert.match(none.text, /no custody v2 policy .* --owner-read on/);
  await custody.createPolicy(KEYS.owner, id, { env: { A: "1", B: "two" } }); await settle();
  // the hosted relay's signature form is not accepted: there is no relay copy
  const hosted = await mcp.call("get_secrets", { id, expiry: 1, signature: "0x11" });
  assert.equal(hosted.ok, false); assert.match(hosted.text, /no relay copy/);
  const read = async (key = KEYS.owner) => {
    const p1 = await mcp.call("get_secrets", { id });
    assert.equal(p1.ok, true, p1.text); assert.equal(p1.value.prepared, true); assert.equal(p1.value.owner, owner.address);
    const signature = await privateKeyToAccount(key).signTypedData(typedForWallet(p1.value.typedData));
    return mcp.call("get_secrets", { id, readToken: p1.value.readToken, signature });
  };
  let g = await read();
  assert.equal(g.ok, true, g.text); assert.deepEqual(g.value.env, { A: "1", B: "two" }); assert.ok(g.value.answered >= 1);
  assert.ok(custody.hits.some((h) => /owner-read\/challenge/.test(h)) && custody.hits.some((h) => /\/v2\/custody\/owner-read$/.test(h.split(" ")[1])), "the committee itself answered");
  // another wallet's signature: the custodians refuse (it is not the policy owner's)
  const forged = await read(KEYS.other);
  assert.equal(forged.ok, false); assert.match(forged.text, /insufficient custodians|owner/);
  // a merge: read at revision N, edit, the vault update under N for the OWNER to send
  const edit = async (payload) => {
    const p1 = await mcp.call("set_secrets", { id, payload: JSON.stringify(payload) });
    assert.equal(p1.ok, true, p1.text);
    if (!p1.value.prepared) return p1;
    const signature = await owner.signTypedData(typedForWallet(p1.value.typedData));
    return mcp.call("set_secrets", { id, payload: JSON.stringify(payload), readToken: p1.value.readToken, signature });
  };
  let e = await edit({ set: { C: "3", B: "bee-secret-value" } });
  assert.equal(e.ok, true, e.text); assert.deepEqual(e.value.names, ["A", "B", "C"]); assert.ok(!JSON.stringify(e.value).includes("bee-secret-value"), "an edit answer carries names, never values");
  await send(KEYS.owner, e.value.transactions[0]); await settle();
  assert.deepEqual((await read()).value.env, { A: "1", B: "bee-secret-value", C: "3" });
  e = await edit({ del: ["A"] });
  await send(KEYS.owner, e.value.transactions[0]); await settle();
  assert.deepEqual((await read()).value.env, { B: "bee-secret-value", C: "3" });
  const missing = await edit({ del: ["NOPE"] });
  assert.equal(missing.ok, false); assert.match(missing.text, /not stored: NOPE/);
  // two editors: the stale one's update is refused by the vault's revision guard; nothing is lost
  const stale = await edit({ set: { D: "4" } });
  const repl = await edit({ set: { ONLY: "x" }, clear: true });
  assert.equal(repl.value.prepared, undefined, "a replace needs no read");
  assert.match(repl.value.configFrom, /catalog version record \(on chain/, "its config commitment comes from chain authority, never a gateway");
  await send(KEYS.owner, repl.value.transactions[0]); await settle();
  await assert.rejects(send(KEYS.owner, stale.value.transactions[0]), /revert/i);
  assert.deepEqual((await read()).value.env, { ONLY: "x" }, "the stale editor wrote nothing");
  // paused: nothing is released, the owner included; a clear still writes
  await custody.setPaused(KEYS.owner, id, true); await settle();
  const paused = await mcp.call("get_secrets", { id });
  assert.equal(paused.ok, false); assert.match(paused.text, /paused/);
  const cl = await edit({ clear: true });
  await send(KEYS.owner, cl.value.transactions[0]); await settle();
  assert.equal((await custody.state(id)).data, "0x");
  // ownerRead off (the default): reads and merges refused, a replace allowed
  const id2 = r.createdId(await r.create(KEYS.owner)); await settle();
  await custody.createPolicy(KEYS.owner, id2, { env: { A: "1" }, ownerRead: false }); await settle();
  const off = await mcp.call("get_secrets", { id: id2 });
  assert.equal(off.ok, false); assert.match(off.text, /do not allow an owner read/);
  const offRepl = await mcp.call("set_secrets", { id: id2, payload: JSON.stringify({ set: { B: "2" }, clear: true }) });
  assert.equal(offRepl.ok, true, offRepl.text); assert.equal(offRepl.value.transactions.length, 1);
  // ---- the remote adapter: ciphertext only, sealed BEFORE transmission (mcp/remote-secrets-client.mjs) ----------------
  // Every byte between this client and the adapter passes a recording proxy; the representative secret must never appear.
  const { sealForRemote } = await import("../mcp/remote-secrets-client.mjs");
  const SECRET = "remote-canary-" + Math.random().toString(36).slice(2), PLAIN = "plaintext-canary-" + Math.random().toString(36).slice(2);
  const id3 = r.createdId(await r.create(KEYS.owner)); await settle();
  await custody.createPolicy(KEYS.owner, id3, { env: { A: "1" } }); await settle();
  const remoteCfg = path.join(tmp, "remote-secrets.json");
  writeConfig(remoteCfg, { base: profileFor(path.join(tmp, "pins.json")) });
  const srv = spawnServer(["--config", remoteCfg, "--remote", "--listen", "127.0.0.1:0"]);
  const wire = [];
  let proxy;
  try {
    const port = await new Promise((ok, no) => { let x = ""; srv.stderr.on("data", (d) => { x += d; const mm = /on 127\.0\.0\.1:(\d+)/.exec(x); if (mm) ok(Number(mm[1])); }); setTimeout(() => no(new Error(x)), 20000); });
    proxy = http.createServer(async (q, res) => {
      const c = []; for await (const d of q) c.push(d); const req = Buffer.concat(c).toString();
      const f = await fetch(`http://127.0.0.1:${port}${q.url}`, { method: q.method, headers: { "content-type": "application/json" }, body: req });
      const out = await f.text(); wire.push({ req, res: out }); res.writeHead(f.status, { "content-type": "application/json" }); res.end(out);
    });
    await new Promise((ok) => proxy.listen(0, "127.0.0.1", ok));
    const rpc = (method, params) => fetch(`http://127.0.0.1:${proxy.address().port}/p/base`, { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) }).then((x) => x.json()).then((j) => j.result);
    const rcall = (name, args) => rpc("tools/call", { name, arguments: args });
    // its tools/list: the secrets tools take ciphertext and public preparation only; every other tool is the shared one
    const rtools = (await rpc("tools/list", {})).tools;
    assert.equal(rtools.length, 41);
    assert.deepEqual(Object.keys(rtools.find((t) => t.name === "set_secrets").inputSchema.properties), ["id", "action", "sealedBundle", "expectPolicyRev"]);
    assert.deepEqual(Object.keys(rtools.find((t) => t.name === "get_secrets").inputSchema.properties), ["id", "action"]);
    assert.ok(!JSON.stringify(rtools.filter((t) => /secrets/.test(t.name))).match(/"(payload|signature|readToken|configText)"/), "no plaintext or owner-read argument is advertised");
    const hits = custody.hits.length, before = await custody.state(id3);
    const rg = await rcall("get_secrets", { id: id3, action: "prepare" });
    assert.equal(rg.structuredContent.handoff, true); assert.match(rg.structuredContent.local, /secrets ls --show/); assert.equal(rg.structuredContent.policy.ownerRead, true);
    // the supported client path: prepare (public) -> seal HERE -> write (ciphertext)
    const prep = await rcall("set_secrets", { id: id3, action: "prepare" });
    assert.equal(prep.isError, undefined, prep.content[0].text);
    assert.equal(prep.structuredContent.sealing.committeeY, custody.Y); assert.match(prep.structuredContent.sealing.configFrom, /catalog version record/);
    // the recipient is the OWNER's own read (this local server: its reviewed profile and quorum), never the adapter's word
    const own = await mcp.call("set_secrets", { id: id3, action: "prepare" });
    assert.equal(own.ok, true, own.text); assert.equal(own.value.local, true); assert.equal(own.value.sealing.committeeY, custody.Y);
    assert.throws(() => sealForRemote(prep.structuredContent, { SEALED: SECRET }), /needs the sealing facts the owner's own client read/);
    const sealed = sealForRemote(prep.structuredContent, { SEALED: SECRET }, { expected: own.value, id: id3 });
    const wr = await rcall("set_secrets", { id: id3, action: "write", ...sealed });
    assert.equal(wr.isError, undefined, wr.content[0].text);
    const { verifyRemoteUpdate } = await import("../mcp/remote-secrets-client.mjs");
    verifyRemoteUpdate(wr.structuredContent, { expected: own.value, sealedBundle: sealed.sealedBundle });
    await send(KEYS.owner, wr.structuredContent.transactions[0]); await settle();
    // a stale guard is refused; a plaintext-shaped call is refused with ONE static message, nothing parsed, echoed or forwarded
    const stale = await rcall("set_secrets", { id: id3, action: "write", ...sealed });
    assert.equal(stale.isError, true); assert.match(stale.content[0].text, /prepare and seal again/);
    const plain = await rcall("set_secrets", { id: id3, action: "write", payload: JSON.stringify({ set: { X: PLAIN } }) });
    assert.equal(plain.isError, true); assert.match(plain.content[0].text, /accepts no plaintext values/);
    const legacy = await rcall("set_secrets", { id: id3, payload: JSON.stringify({ set: { X: PLAIN } }), expiry: 1, signature: "0x11" });
    assert.equal(legacy.isError, true); assert.match(legacy.content[0].text, /accepts no plaintext values/);
    assert.equal(custody.hits.length, hits, "the remote adapter contacted no custodian");
    assert.ok(wire.every((w) => !w.req.includes(SECRET) && !w.res.includes(SECRET)), "the representative secret never left the owner's process");
    assert.ok(wire.every((w) => !w.res.includes(PLAIN)), "unexpected plaintext is never echoed");
    assert.equal(wire.filter((w) => w.req.includes(PLAIN)).length, 2, "only the two deliberate refusal probes carried it");
    // the owner's own LOCAL client reads back exactly what was sealed remotely
    const p1 = await mcp.call("get_secrets", { id: id3 });
    const back = await mcp.call("get_secrets", { id: id3, readToken: p1.value.readToken, signature: await owner.signTypedData(typedForWallet(p1.value.typedData)) });
    assert.equal(back.ok, true, back.text); assert.deepEqual(back.value.env, { SEALED: SECRET });
    assert.notEqual((await custody.state(id3)).data, before.data);
    const rc = await rcall("set_secrets", { id: id3, action: "clear" });
    await send(KEYS.owner, rc.structuredContent.transactions[0]); await settle();
    assert.equal((await custody.state(id3)).data, "0x");
  } finally { srv.kill("SIGKILL"); proxy?.close(); }
  // after a ledger transfer the previous owner reads nothing: the new owner claims first
  await r.write(r.wc(KEYS.owner), r.addresses.ledger, r.A.ledger.abi, "transferDeployment", [id2, privateKeyToAccount(KEYS.other).address]); await settle();
  const moved = await mcp.call("set_secrets", { id: id2, payload: JSON.stringify({ clear: true }) });
  assert.equal(moved.ok, false); assert.match(moved.text, /custody claim/);
  noEnclave();
});

test("RPC faults: one lying, dead or wrong-chain RPC is outvoted; too few honest peers refuse and never answer empty", T, async () => {
  await settle();
  const want = (await mcp.call("list_deployments", { owner: r.owner })).value.deployments.map((d) => d.id).sort();
  for (const mode of ["lie", "down", "wrongchain"]) {
    r.rpcModes[0] = mode;
    const x = await mcp.call("list_deployments", { owner: r.owner });
    assert.equal(x.ok, true, `${mode}: ${x.text}`); assert.deepEqual(x.value.deployments.map((d) => d.id).sort(), want);
    delete r.rpcModes[0];
  }
  r.rpcModes[0] = "lie"; r.rpcModes[1] = "down";
  const refused = await mcp.call("list_deployments", { owner: r.owner });
  delete r.rpcModes[0]; delete r.rpcModes[1];
  assert.equal(refused.ok, false); assert.match(refused.text, /no 2 RPCs agreed|quorum unavailable/);
  assert.doesNotMatch(refused.text, /"deployments": \[\]/);
  noEnclave();
});

test("an administrator's AddressBook change refuses stale pins before anything is built, and the restored binding answers again", T, async () => {
  await settle();
  const key = toHex("appCatalog", { size: 32 });
  await r.write(r.wc(KEYS.deployer), r.addresses.book, r.A.book.abi, "set", [key, r.addresses.reviews]);   // a "migrated" catalog
  await settle();
  const x = await mcp.call("plan_deploy", { app: "hello:2", gpuShare: 0, cpuShare: 0.1 });
  assert.equal(x.ok, false); assert.match(x.text, /differs from the reviewed selection/);
  await r.write(r.wc(KEYS.deployer), r.addresses.book, r.A.book.abi, "set", [key, r.addresses.catalog]);
  await settle();
  assert.equal((await mcp.call("plan_deploy", { app: "hello:2", gpuShare: 0, cpuShare: 0.1 })).ok, true);
  noEnclave();
});

test("the remote adapter serves each reviewed profile at its own path with no state shared between concurrent requests", T, async () => {
  const stalePins = path.join(tmp, "pins-stale.json");
  fs.writeFileSync(stalePins, JSON.stringify({ ...r.pins, contracts: { ...r.pins.contracts, appCatalog: r.addresses.reviews.toLowerCase() } }));
  const remoteCfg = path.join(tmp, "remote.json");
  writeConfig(remoteCfg, { good: profileFor(path.join(tmp, "pins.json")), stale: profileFor(stalePins) });
  const srv = spawnServer(["--config", remoteCfg, "--remote", "--listen", "127.0.0.1:0"]);
  const port = await new Promise((ok, no) => { let e = ""; srv.stderr.on("data", (d) => { e += d; const mm = /on 127\.0\.0\.1:(\d+)/.exec(e); if (mm) ok(Number(mm[1])); });
    setTimeout(() => no(new Error("remote adapter did not start: " + e)), 20000); });
  const post = (p, msg) => new Promise((ok, no) => { const b = JSON.stringify(msg);
    const q = http.request({ host: "127.0.0.1", port, path: p, method: "POST", headers: { "content-type": "application/json", "content-length": Buffer.byteLength(b) } }, (res) => {
      let d = ""; res.on("data", (c) => (d += c)); res.on("end", () => ok({ status: res.statusCode, body: d ? JSON.parse(d) : null })); }); q.on("error", no); q.end(b); });
  try {
    await settle();
    const call = (p, i) => post(p, { jsonrpc: "2.0", id: i, method: "tools/call", params: { name: "list_apps", arguments: {} } });
    const out = await Promise.all(Array.from({ length: 12 }, (_, i) => call(i % 2 ? "/p/stale" : "/p/good", i)));
    for (const [i, x] of out.entries()) {
      if (i % 2) { assert.equal(x.body.result.isError, true); assert.match(x.body.result.content[0].text, /differs from the reviewed selection/); }
      else { assert.equal(x.body.result.isError, undefined, x.body.result.content[0].text);
        const slugs = x.body.result.structuredContent.apps.map((p) => p.slug); assert.ok(slugs.includes("hello") && slugs.includes("thirdparty"), slugs.join()); }
    }
    assert.equal((await post("/p/nope", { jsonrpc: "2.0", id: 1, method: "ping" })).status, 404);
    const sec = await post("/p/good", { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "set_secrets", arguments: { id: vaultId, payload: "{}", expiry: 1, signature: "0x" } } });
    assert.equal(sec.body.result.isError, true); assert.match(sec.body.result.content[0].text, /accepts no plaintext values/);   // the original plaintext form, refused unread
  } finally { srv.kill("SIGKILL"); }
  noEnclave();
});

test("an admin host ban (an anchored platform host policy) removes the host from listings and prices and blocks contacting it", T, async (t) => {
  await settle();
  const world = await platformPolicyWorld(t, { hosts: { [r.runner.toLowerCase()]: { active: true, operator: r.operator.toLowerCase(), owner: r.owner.toLowerCase(), endpoint: r.endpoint },
    [custody.host.registryId.toLowerCase()]: { active: true, operator: custody.host.operator, owner: custody.enclaveOwner.address.toLowerCase(), endpoint: custody.host.endpoint } } });
  const policyCfg = path.join(tmp, "policy.json");
  writeConfig(policyCfg, { banned: profileFor(path.join(tmp, "pins.json"), { hostPolicy: { book: POLICY_BOOK, hostOwnership: POLICY_OWNERSHIP, mirrors: [world.mirrorOrigin], rpcs: world.rpcs } }) });
  const fresh = async () => { const p = spawnServer(["--config", policyCfg, "--profile", "banned"], { NODE_EXTRA_CA_CERTS: world.ca }); const c = stdioClient(p);
    await c.request("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "1" } }); return { p, c }; };
  // before the admin anchors anything: not activated, today's behaviour
  let s = await fresh();
  try {
    const ps = await s.c.call("platform_status");
    assert.equal(ps.ok, true, ps.text); assert.equal(ps.value.liveHosts, 2); assert.equal(ps.value.bannedOrRefused, 0);
  } finally { s.p.kill("SIGKILL"); }
  await world.publish({ deny: [{ kind: "operator", value: r.operator.toLowerCase(), reason: "abuse" }, { kind: "operator", value: custody.host.operator, reason: "abuse" }] });
  s = await fresh();
  try {
    const ps = await s.c.call("platform_status");
    assert.equal(ps.ok, true, ps.text); assert.equal(ps.value.liveHosts, 0); assert.equal(ps.value.bannedOrRefused, 2);
    const plan = await s.c.call("plan_deploy", { app: "hello:2", gpuShare: 0, cpuShare: 0.1 });
    assert.equal(plan.ok, false); assert.match(plan.text, /no live enclave is posting a price/);
    const before = m.hits.length;
    const hint = await s.c.call("claim_hint", { id: vaultId, enclave: r.runner, session: sess2 });
    assert.equal(hint.ok, false); assert.match(hint.text, /refused by the platform host policy/); assert.equal(m.hits.length, before, "nothing reached the banned host");
    assert.ok(world.served.length > 0, "the admin-signed policy came from the operator's mirror");
  } finally { s.p.kill("SIGKILL"); }
  noEnclave();
});

test("CONTROL: the same tools over the hosted backend reach the Enclave gateway and public RPCs (which the guard blocks)", T, async () => {
  // relay/mcp.js handleMcp, as api-relay serves it, in a child under the same guard; its gateway is the stand-in API
  const ctlLog = path.join(tmp, "control-net.log"); fs.writeFileSync(ctlLog, "");
  const script = `import http from "node:http"; import { handleMcp } from ${JSON.stringify(pathToFileURL(path.join(REPO, "relay/mcp.js")).href)};
    const s = http.createServer((q, res) => handleMcp(q, res)); s.listen(0, "127.0.0.1", () => process.stdout.write("port " + s.address().port + "\\n"));`;
  const p = spawn(process.execPath, ["--input-type=module", "-e", script], { cwd: path.join(REPO, "relay"), stdio: ["ignore", "pipe", "pipe"],
    env: { PATH: process.env.PATH, HOME: tmp, NODE_OPTIONS: `--import=${GUARD}`, ENCLAVE_TEST_NET_LOG: ctlLog, API_RELAY_PORT: String(r.apiPort) } });
  try {
    const port = await new Promise((ok, no) => { let o = ""; p.stdout.on("data", (d) => { o += d; const mm = /port (\d+)/.exec(o); if (mm) ok(Number(mm[1])); }); setTimeout(() => no(new Error("control did not start")), 20000); });
    const call = (name, args = {}) => fetch(`http://127.0.0.1:${port}/`, { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }) }).then((x) => x.json());
    const hits = r.apiHits.length;
    await call("pricing");
    assert.ok(r.apiHits.length > hits && r.apiHits.slice(hits).some((h) => /\/v1\/pricing/.test(h)), "the hosted backend calls its gateway");
    await call("list_apps");
    assert.match(fs.readFileSync(ctlLog, "utf8"), /base-rpc\.publicnode\.com|mainnet\.base\.org|base\.drpc\.org|1rpc\.io/, "and first-answer public RPCs");
  } finally { p.kill("SIGKILL"); r.apiHits.length = 0; }
  noEnclave();   // the independent server, meanwhile, never did
});
