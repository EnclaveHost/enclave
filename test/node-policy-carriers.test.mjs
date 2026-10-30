// Platform host policy CARRIERS for the HOST runtimes (windows/node/host-admission.bundle.mjs createHostServiceGate, as imported by
// the deployed windows/node/host.mjs 9634cb40 and by supervisor.js), on a local policy world (test/helpers/platform-policy-world.mjs:
// three loopback JSON-RPC origins answering the book owner/anchor/registry, the registry row and host ownership; the admin's
// key signs real EIP-712 policies; "anchoring" sets the book's two anchor values). No real chain, key, mirror or Enclave
// service; no DigitalOcean origin anywhere. Run inside tools/make-testtree.sh's tree with --preserve-symlinks.
//   BUNDLE_UNDER_TEST=live  -> the same file against the INSTALLED bundle 6bef372d: the delivery tests must FAIL (old control)
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { keccak256, toBytes } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { platformPolicyWorld, BOOK, REGISTRY, OWNERSHIP } from "./helpers/platform-policy-world.mjs";
import { POLICY_FORMAT, policyTypedData, policyDigest, encodeAnchor } from "../network/platform-host-policy.mjs";
import * as B from "../windows/node/host-admission.bundle.mjs";

const EP = "https://api.enclave.host/t/carrier-test", HOST = keccak256(toBytes(EP)).toLowerCase();
const OP = "0x" + "44".repeat(20), Z32 = "0x" + "00".repeat(32), ZA = "0x" + "00".repeat(20);
const CARRIER_MIRROR = "https://policy-carriers.invalid/platform-policy";
const tmp = (p) => fs.mkdtempSync(path.join(os.tmpdir(), p));
const now = () => Math.floor(Date.now() / 1000);

async function world(t) { return platformPolicyWorld(t, { hosts: { [HOST]: { endpoint: EP, operator: OP, owner: "0x" + "55".repeat(20), active: true } } }); }
/** the admin's document: { digest, entry: {document, signature}, policy }; anchor=true sets the book's anchor to it */
async function sign(w, { sequence, deny = [], mode = "denylist", admit = [], issuedAt = now() - 5, expiresAt = 0, maxStaleSec = 0, signer = w.admin, anchor = true }) {
  const p = { format: POLICY_FORMAT, chainId: 8453, book: BOOK, registry: REGISTRY, hostOwnership: OWNERSHIP, sequence, issuedAt, expiresAt, maxStaleSec, previousDigest: Z32, mode, deny, admit };
  const digest = policyDigest(p), entry = { document: JSON.stringify(p), signature: await signer.signTypedData(policyTypedData(p)) };
  if (anchor) { const a = encodeAnchor(digest); w.state.hi = a.hi; w.state.lo = a.lo; }
  return { digest, entry, policy: p };
}
const put = (dir, name, entry) => { fs.mkdirSync(dir, { recursive: true }); fs.writeFileSync(path.join(dir, `${name}.json`), JSON.stringify(entry)); };
// the node's environment: the explicit policy (the world's book), NO mirror at all, the world's RPC quorum, and the carriers
const envOf = (w, carriers, extra = {}) => ({ ENCLAVE_PLATFORM_HOST_POLICY: JSON.stringify({ book: BOOK, hostOwnership: OWNERSHIP, mirrors: [] }),
  ENCLAVE_PLATFORM_HOST_POLICY_RPCS: w.rpcs.join(","), ...(carriers ? { ENCLAVE_PLATFORM_HOST_POLICY_CARRIERS: JSON.stringify(carriers) } : {}), ...extra });
const gateOf = (env, stateDir = tmp("gate-state-"), log = () => {}) => B.createHostServiceGate({ env, chainId: 8453, book: null, endpoint: EP, stateDir, log });
// the test world's loopback RPCs can refuse one read at a wall-clock second boundary ("rpc_refused"): a check is repeated ONLY
// while its outcome is that transient one, so no assertion below is ever satisfied by an unreadable chain
const TRANSIENT = /^(unreadable|undecided|refused-unreadable)$/;
async function settled(g, tries = 15) { let s; for (let i = 0; i < tries; i++) { s = await g.check(); if (!TRANSIENT.test(String(s.status))) return s; await new Promise((r) => setTimeout(r, 400)); } return s; }
const persisted = (dir) => { try { return JSON.parse(fs.readFileSync(path.join(dir, "platform-host-admission.json"), "utf8")); } catch { return null; } };

test("unset: the gate is the base gate (no carrier origin, same quorum) and an ANCHORED policy is unreachable without a mirror (the outage)", async (t) => {
  const w = await world(t); const d = await sign(w, { sequence: 1 });
  const g = gateOf(envOf(w, null));
  assert.deepEqual(g.runtime.config.mirrors, [], "no mirror, no carrier origin");
  assert.equal(g.status().carriers, undefined);
  const s = await settled(g);
  assert.equal(s.serving, false, "a fresh host behind an anchor it cannot load never serves"); assert.equal(s.status, "behind");
  assert.match(String(g.runtime.status().problems?.join?.(" ") ?? "") + " " + s.reason, /behind|not available|not loaded/);
  assert.equal(g.runtime.status().accepted, null); assert.ok(d.digest);
});

test("importDir: the ANCHORED policy is delivered, verified at the gate's own quorum and ADMITS this host; restart reloads it from the store", async (t) => {
  const w = await world(t), imp = tmp("import-"), st = tmp("state-"); const d = await sign(w, { sequence: 1 }); put(imp, d.digest, d.entry);
  const logs = []; const g = gateOf(envOf(w, { importDir: imp }), st, (m) => logs.push(m));
  assert.deepEqual(g.runtime.config.mirrors, [CARRIER_MIRROR], "exactly the reserved carrier origin; never a fleet mirror");
  assert.equal(g.runtime.config.minAgree, null); assert.deepEqual(g.runtime.config.rpcs, w.rpcs, "the gate's own RPC set, majority unchanged");
  assert.deepEqual(g.status().carriers, { importDir: true, policyMirrorStateDir: false, peers: 0, serviceIndex: false });
  const s = await settled(g);
  assert.equal(s.serving, true, s.reason); assert.equal(g.runtime.status().accepted.digest, d.digest); assert.equal(g.runtime.status().anchor, "anchored");
  assert.ok(logs.some((l) => /policy carriers: importDir/.test(l)));
  fs.rmSync(imp, { recursive: true, force: true });                       // the import is gone: a restart uses the accepted store
  const g2 = gateOf(envOf(w, { importDir: imp }), st); assert.equal((await settled(g2)).serving, true, "restart: the persisted accepted policy (verified again) admits");
});

test("ban delivered by the carrier: refused and PERSISTED; a restart without the document stays refused; the admin's next anchored document unbans", async (t) => {
  const w = await world(t), imp = tmp("import-"), st = tmp("state-");
  let d = await sign(w, { sequence: 1 }); put(imp, d.digest, d.entry);
  const g = gateOf(envOf(w, { importDir: imp }), st); assert.equal((await settled(g)).serving, true);
  d = await sign(w, { sequence: 2, deny: [{ kind: "registryId", value: HOST, reason: "abuse" }] }); put(imp, d.digest, d.entry);
  const s = await settled(g); assert.equal(s.serving, false); assert.equal(s.banned, true); assert.match(s.reason, /banned by platform policy #2 \(registryId\): abuse/);
  assert.match(g.newWorkRefusal(), /banned/); assert.match(g.serviceRefusal(), /banned/);
  assert.equal(persisted(st).knownRefusal.status, "current", "the refusal is persisted (sticky across restarts)");
  fs.rmSync(path.join(imp, `${d.digest}.json`));
  const g2 = gateOf(envOf(w, { importDir: imp }), st); const s2 = await settled(g2);
  assert.equal(s2.serving, false, "a restarted host keeps the admin's refusal"); assert.equal(s2.banned, true);
  d = await sign(w, { sequence: 3 }); put(imp, d.digest, d.entry);
  assert.equal((await settled(g2)).serving, true, "the admin's unban (a newer anchored document) restores"); assert.equal(persisted(st).knownRefusal, null);
});

test("wrong digest / substituted content under the anchored name: never served, the host is not admitted", async (t) => {
  const w = await world(t);
  const other = await sign(w, { sequence: 7, anchor: false }), d = await sign(w, { sequence: 1 });
  const imp1 = tmp("import-"); put(imp1, d.digest, other.entry);           // a valid admin document, but another digest
  const s1 = await settled(gateOf(envOf(w, { importDir: imp1 }))); assert.equal(s1.serving, false, "wrong digest refused"); assert.equal(s1.status, "behind");
  const tampered = { ...d.entry, document: JSON.stringify({ ...d.policy, deny: [{ kind: "registryId", value: "0x" + "99".repeat(32), reason: "x" }] }) };
  const imp2 = tmp("import-"); put(imp2, d.digest, tampered);               // edited content under the real signature
  const g2 = gateOf(envOf(w, { importDir: imp2 })); const s2 = await settled(g2);
  assert.equal(s2.serving, false, "substituted content refused"); assert.equal(s2.status, "behind"); assert.equal(g2.runtime.status().accepted, null);
});

test("wrong signer: refused; a lying FIRST carrier cannot shadow an honest peer carrier", async (t) => {
  const w = await world(t); const d = await sign(w, { sequence: 1 });
  const mallory = privateKeyToAccount(generatePrivateKey());
  const forged = await sign(w, { sequence: 1, signer: mallory, anchor: false });
  assert.equal(forged.digest, d.digest, "the same document, signed by a non-owner");
  const imp = tmp("import-"); put(imp, d.digest, forged.entry);
  const sf = await settled(gateOf(envOf(w, { importDir: imp }))); assert.equal(sf.serving, false, "a non-owner signature never admits"); assert.equal(sf.status, "behind");
  // an honest policy-mirror PEER (http, loopback) after the lying importDir
  const served = [];
  const peer = http.createServer((req, res) => { served.push(req.url); const m = /^\/platform-policy\/(0x[0-9a-f]{64})\.json$/.exec(req.url || "");
    if (!m || m[1] !== d.digest) { res.writeHead(404); return res.end(); } res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify(d.entry)); });
  await new Promise((r) => peer.listen(0, "127.0.0.1", r)); t.after(() => peer.close());
  const base = `http://127.0.0.1:${peer.address().port}/platform-policy`;
  const g = gateOf(envOf(w, { importDir: imp, peers: [base] }));
  assert.deepEqual(g.status().carriers, { importDir: true, policyMirrorStateDir: false, peers: 1, serviceIndex: false });
  const s = await settled(g); assert.equal(s.serving, true, s.reason); assert.ok(served.includes(`/platform-policy/${d.digest}.json`));
});

test("expiry: a validly signed but STALE anchored policy refuses this (new) host, persisted; a policy-mirror role's store is a carrier too", async (t) => {
  const w = await world(t), st = tmp("state-"), mirrorState = tmp("pm-");
  const d = await sign(w, { sequence: 1, issuedAt: now() - 300, expiresAt: now() - 200, maxStaleSec: 60 });
  put(path.join(mirrorState, "documents"), d.digest, d.entry);
  const g = gateOf(envOf(w, { policyMirrorStateDir: mirrorState }), st); const s = await settled(g);
  assert.equal(g.runtime.status().accepted?.digest, d.digest, "delivered and accepted (signature, digest, anchor)");
  assert.equal(s.serving, false); assert.equal(s.status, "stale"); assert.match(s.reason, /stale/); assert.equal(persisted(st).knownRefusal.status, "stale");
});

test("rollback: after accepting #5, an anchored OLDER #4 (served by the carrier) is refused; the accepted policy stays #5", async (t) => {
  const w = await world(t), imp = tmp("import-"), st = tmp("state-");
  const d5 = await sign(w, { sequence: 5 }); put(imp, d5.digest, d5.entry);
  const g = gateOf(envOf(w, { importDir: imp }), st); assert.equal((await settled(g)).serving, true);
  const d4 = await sign(w, { sequence: 4 }); put(imp, d4.digest, d4.entry);
  const s = await settled(g);
  assert.equal(g.runtime.status().accepted.sequence, 5, "never rolled back to #4");
  assert.equal(s.status, "behind", "the #4 anchor is never accepted: the host is only inside its bounded grace");
});

test("quorum: carriers never lower it - an RPC outage leaves a fresh host refused even with the document imported", async (t) => {
  const w = await world(t), imp = tmp("import-"); const d = await sign(w, { sequence: 1 }); put(imp, d.digest, d.entry);
  w.setDown(true);
  const g = gateOf(envOf(w, { importDir: imp })); const s = await g.check();  // direct: the outage itself is under test
  assert.equal(s.serving, false); assert.match(s.reason, /unreadable|RPC/i);
  w.setDown(false); assert.equal((await settled(g)).serving, true, "the same document admits once the quorum answers");
});

test("configuration: malformed / unknown key / relative path / empty / policy off / with a caller's fetch are REFUSED; operator mirrors kept", async (t) => {
  const w = await world(t);
  for (const bad of ["{", "[]", '{"importDir":"rel/dir"}', '{"other":1}', "{}", '{"peers":["ftp://x"]}', '{"serviceIndex":{"chainId":8453}}'])
    assert.throws(() => gateOf({ ...envOf(w, null), ENCLAVE_PLATFORM_HOST_POLICY_CARRIERS: bad }), /ENCLAVE_PLATFORM_HOST_POLICY_CARRIERS|index pin|base URLs/, bad);
  assert.throws(() => gateOf({ ENCLAVE_PLATFORM_HOST_POLICY: "off", ENCLAVE_PLATFORM_HOST_POLICY_CARRIERS: JSON.stringify({ importDir: tmp("x-") }) }), /policy is off/);
  assert.throws(() => B.createHostServiceGate({ env: envOf(w, { importDir: tmp("x-") }), chainId: 8453, endpoint: EP, fetch: globalThis.fetch, log: () => {} }), /one transport only/);
  const op = "https://policy.operator.example/platform-policy";
  const g = gateOf(envOf(w, { importDir: tmp("x-") }, { ENCLAVE_PLATFORM_HOST_POLICY_MIRRORS: op }));
  assert.deepEqual(g.runtime.config.mirrors, [op, CARRIER_MIRROR]);
  assert.equal(typeof B.hostPolicyCarriersFromEnv, "function"); assert.equal(B.hostPolicyCarriersFromEnv({}), null);
});

test("Windows node: the DEPLOYED host.mjs takes the carriers from process.env; admitted -> work proceeds; banned -> no claims, app traffic 403", async (t) => {
  const w = await world(t), imp = tmp("import-"), dir = tmp("win-");
  let d = await sign(w, { sequence: 1 }); put(imp, d.digest, d.entry);
  const saved = { ...process.env }; t.after(() => { for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k]; Object.assign(process.env, saved); });
  Object.assign(process.env, envOf(w, { importDir: imp }));
  const { Host } = await import("../windows/node/host.mjs");
  const h = new Host({ dir, endpoint: EP, name: "carrier-test", appsEnabled: true, cpuPricePerSec6: 12, log: () => {} });
  assert.equal(h.platformPolicy.enabled, true); assert.equal(h.platformPolicy.hostId, HOST); assert.equal(h.platformPolicy.status().carriers.importDir, true);
  assert.equal(h.hostAdmission, null, "wallet admission is untouched (not configured here, exactly as before)");
  const id = "0x" + "ab".repeat(32);
  await settled(h.platformPolicy);
  assert.doesNotMatch((await h.consider(id)).reason || "", /platform host policy/, "admitted: the claim proceeds to its normal checks");
  d = await sign(w, { sequence: 2, deny: [{ kind: "operator", value: OP, reason: "abuse" }] }); put(imp, d.digest, d.entry);
  await settled(h.platformPolicy);
  assert.match((await h.consider(id)).reason, /platform host policy: banned by platform policy #2 \(operator\): abuse/);
  const p = await h.proxy(id, { method: "GET", pathRest: "/", headers: {}, body: null });
  assert.equal(p.status, 403); assert.equal(JSON.parse(Buffer.from(p.body).toString()).error, "host_policy_refused");
  assert.equal(persisted(dir).knownRefusal.status, "current", "persisted in NODE_DIR exactly as the base gate does");
});

test("Linux: the ACTUAL supervisor.js (same bundle) with ONLY the carrier: admitted -> ban stops app service -> unban restores", { timeout: 180_000 }, async (t) => {
  const { startActualSupervisor } = await import("./helpers/management-supervisor.mjs");
  const publicUrl = "https://host.policy.example", hostId = keccak256(toBytes(publicUrl)).toLowerCase();
  const w = await platformPolicyWorld(t, { hosts: { [hostId]: { endpoint: publicUrl, operator: OP, owner: "0x" + "55".repeat(20), active: true } } });
  const imp = tmp("import-"); let d = await sign(w, { sequence: 1 }); put(imp, d.digest, d.entry);
  const id = "0x" + "ab".repeat(32), owner = "0x" + "66".repeat(20);
  const pins = { registry: "0x" + "06".repeat(20), deployments: "0x" + "05".repeat(20), appCatalog: "0x" + "08".repeat(20), proofOfTime: "0x" + "09".repeat(20),
                 enclavePay: ZA, verificationFees: ZA, sessionVaultFactory: "0x" + "07".repeat(20), secretVaultV2: ZA };
  const sup = await startActualSupervisor(t, { chain: { factory: pins.sessionVaultFactory, vaults: {} }, deployment: { id, owner }, pins, publicUrl,
    env: { ...envOf(w, { importDir: imp }), ENCLAVE_PLATFORM_HOST_POLICY_INTERVAL_SEC: "1", ENCLAVE_PLATFORM_HOST_POLICY_GRACE_SEC: "6", NODE_OPTIONS: "--preserve-symlinks --preserve-symlinks-main" } });
  const base = `http://127.0.0.1:${sup.port}`;
  const health = async () => (await (await fetch(`${base}/v1/health`)).json()).platformHostPolicy;
  const app = async () => { const r = await fetch(`${base}/x/${id}/`); const b = await r.text(); let j = null; try { j = JSON.parse(b); } catch {} return { status: r.status, error: j?.code || j?.error || null }; };
  const until = async (fn, ms = 20000) => { const end = Date.now() + ms; while (Date.now() < end) { if (await fn()) return true; await new Promise((r) => setTimeout(r, 250)); } return false; };
  assert.ok(await until(async () => (await health())?.serving === true), "admitted through the carrier: serving\n" + sup.stdout().slice(-1500));
  assert.match(sup.stdout(), /\[host-policy\] policy carriers: importDir/);
  assert.notEqual((await app()).error, "host_policy_refused");
  d = await sign(w, { sequence: 2, deny: [{ kind: "operator", value: OP, reason: "abuse" }] }); put(imp, d.digest, d.entry);
  assert.ok(await until(async () => (await health())?.banned === true), "the carrier-delivered ban is seen");
  assert.deepEqual(await app(), { status: 403, error: "host_policy_refused" });
  d = await sign(w, { sequence: 3 }); put(imp, d.digest, d.entry);
  assert.ok(await until(async () => (await health())?.serving === true), "the carrier-delivered unban restores");
});

test("parity: with NO carrier setting the candidate resolves exactly what the installed bundle 6bef372d resolves (config, mirrors, quorum, off reasons)", async (t) => {
  const live = await import(process.env.LIVE_BUNDLE || '../ops/unified-funding-20261028/operator-durability-delivery-r2/candidate/control/windows/node/host-admission.bundle.mjs');
  const w = await world(t);
  const envs = [{}, { ENCLAVE_PLATFORM_HOST_POLICY: "production" }, { ENCLAVE_PLATFORM_HOST_POLICY: "off" },
    { ENCLAVE_PLATFORM_HOST_POLICY: "production", ENCLAVE_PLATFORM_HOST_POLICY_RPCS: "https://base-rpc.publicnode.com,https://base.gateway.tenderly.co,https://base-public.nodies.app,https://base.drpc.org,https://mainnet.base.org" },
    envOf(w, null), envOf(w, null, { ENCLAVE_PLATFORM_HOST_POLICY_MIRRORS: "https://policy.operator.example/platform-policy" })];
  for (const env of envs) {
    const a = B.createHostServiceGate({ env, chainId: 8453, book: null, endpoint: EP, log: () => {} }), b = live.createHostServiceGate({ env, chainId: 8453, book: null, endpoint: EP, log: () => {} });
    assert.equal(a.enabled, b.enabled); assert.deepEqual(a.runtime?.config ?? null, b.runtime?.config ?? null);
    // the one additive status field: 14d1e495 (A 437d6ced6) reports which chain authority the gate reads through; with no
    // verifier configured it must say the legacy provider quorum, and everything the installed bundle reports is identical
    const sa = a.status(), sb = b.status();
    if (sa?.runtime) { assert.equal(sb.runtime.chainAuthority, undefined); assert.equal(sa.runtime.chainAuthority, "provider-quorum"); const { chainAuthority, ...rest } = sa.runtime; sa.runtime = rest; }
    assert.deepEqual(sa, sb);
    assert.deepEqual(Object.keys(a).sort(), Object.keys(b).sort());
  }
});

test("RPC budget: a carrier adds ZERO requests to the routine check, and one fresh-verification snapshot only when a new anchor is delivered", async (t) => {
  const w = await world(t);
  const counts = [], servers = await Promise.all(w.rpcs.map((u, i) => new Promise((ok) => { counts[i] = 0;
    const s = http.createServer((req, res) => { const c = []; req.on("data", (d) => c.push(d)); req.on("end", async () => { const body = Buffer.concat(c);
      try { counts[i] += [].concat(JSON.parse(body)).length; } catch {}
      const r = await fetch(u, { method: "POST", headers: { "content-type": "application/json" }, body }); res.writeHead(r.status, { "content-type": "application/json" }); res.end(Buffer.from(await r.arrayBuffer())); }); });
    s.listen(0, "127.0.0.1", () => ok(s)); })));
  t.after(() => servers.forEach((s) => { s.closeAllConnections?.(); s.close(); }));
  const rpcs = servers.map((s) => `http://127.0.0.1:${s.address().port}`), total = () => counts.reduce((a, b) => a + b, 0), reset = () => counts.fill(0);
  const env = (carriers) => ({ ...envOf(w, carriers), ENCLAVE_PLATFORM_HOST_POLICY_RPCS: rpcs.join(",") });
  const imp = tmp("import-"), stC = tmp("state-"), stP = tmp("state-"); const d = await sign(w, { sequence: 1 }); put(imp, d.digest, d.entry);
  const gc = gateOf(env({ importDir: imp }), stC);
  reset(); assert.equal((await settled(gc)).serving, true); const deliver = total();
  // the same accepted policy for a carrier-less gate: copy the accepted store (what any restart reuses)
  fs.copyFileSync(path.join(stC, "platform-host-policy.json"), path.join(stP, "platform-host-policy.json"));
  const gp = gateOf(env(null), stP);
  reset(); assert.equal((await settled(gp)).serving, true); const fromStore = total();
  const steady = async (g) => { const n = []; for (let i = 0; i < 4; i++) { reset(); const s = await g.check(); if (!TRANSIENT.test(String(s.status))) n.push(total()); } return Math.min(...n); };
  const sc = await steady(gc), sp = await steady(gp);
  t.diagnostic(`requests: delivery-with-carrier ${deliver}, first-check-from-store ${fromStore}, routine check carrier ${sc} / no carrier ${sp}`);
  assert.equal(sc, sp, "the routine 60-s check costs the same with or without carriers");
  assert.ok(deliver > fromStore, "delivery pays one extra fresh-verification snapshot (bounded: only when a new anchor is fetched)");
});

test("today's state (book UNANCHORED): with carriers configured the gate admits as not-activated, exactly like the base gate, and asks no carrier", async (t) => {
  const w = await world(t); w.unanchor();
  const asked = []; const peer = http.createServer((req, res) => { asked.push(req.url); res.writeHead(404); res.end(); });
  await new Promise((r) => peer.listen(0, "127.0.0.1", r)); t.after(() => peer.close());
  const imp = tmp("import-"); fs.writeFileSync(path.join(imp, "junk.json"), "{}");
  const gc = gateOf(envOf(w, { importDir: imp, peers: [`http://127.0.0.1:${peer.address().port}/platform-policy`] })), gp = gateOf(envOf(w, null));
  const sc = await settled(gc), sp = await settled(gp);
  assert.equal(sc.serving, true); assert.equal(sc.status, "not-activated"); assert.deepEqual([sc.serving, sc.status], [sp.serving, sp.status]);
  assert.deepEqual(asked, [], "no carrier is consulted while nothing is anchored");
  assert.equal(gc.runtime.status().anchor, "unanchored");
});
