// Synthetic tests of the activation helpers (no network, no production input: every value is fake and generated here).
//   run: ENCLAVE_TREE=<tree> node --test --test-concurrency=1 test/closeout-helpers.test.mjs
import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { load, walk, treeManifest, CREDENTIAL_NAMES, PUBLIC_NAMES, GUEST_DATA } from "../helpers/common.mjs";
import { checkConfigs } from "../helpers/pa-config-check.mjs";
import { preflight } from "../helpers/pa-preflight.mjs";
import { openNewest, materialize } from "../helpers/pa-archive-open.mjs";

const H = path.join(path.dirname(fileURLToPath(import.meta.url)), "../helpers");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pa-closeout-"));
after(() => fs.rmSync(tmp, { recursive: true, force: true }));
const node = (script, args) => spawnSync(process.execPath, [path.join(H, script), ...args], { encoding: "utf8", env: process.env });
const MC = await load("metal/guest/measured-control.mjs");
const R = await load("metal/guest/platform-api-role.mjs");
const S = await load("relay/state-replica.mjs");
const hpke = await load("custody/hpke.mjs");
const admin = await load("scripts/platform-api-admin.mjs");

function relayDir(name, extra = {}) {
  const d = path.join(tmp, name);
  fs.mkdirSync(path.join(d, "accounts"), { recursive: true });
  fs.writeFileSync(path.join(d, "accounts", "0xsecretuser.json"), JSON.stringify({ passkey: "fake" }));
  fs.writeFileSync(path.join(d, "orders.json"), "[]");
  fs.writeFileSync(path.join(d, "session-key.json"), "fake-signing-key");
  for (const [k, v] of Object.entries(extra)) v === "symlink" ? fs.symlinkSync("/etc/hostname", path.join(d, k)) : fs.writeFileSync(path.join(d, k), v);
  return d;
}

test("export-check: frozen copy with out-of-directory route-state imported, opaque manifest, verify mode; refuses what the replica would drop", () => {
  const d = relayDir("old");
  fs.mkdirSync(path.join(tmp, "var-route-state")); fs.writeFileSync(path.join(tmp, "var-route-state", "route-mem.json"), "{\"seq\":7}");
  fs.writeFileSync(path.join(tmp, "imports.json"), JSON.stringify([{ rel: "route-state", src: path.join(tmp, "var-route-state") }, { rel: "lease-generation-state.json", src: path.join(tmp, "absent") }]));
  const r = node("pa-export-check.mjs", ["--data-dir", d, "--imports", path.join(tmp, "imports.json"), "--manifest-out", path.join(tmp, "m.json"), "--copy-to", path.join(tmp, "copy")]);
  assert.equal(r.status, 0, r.stderr);
  const out = JSON.parse(r.stdout);
  assert.equal(out.files, 4); assert.equal(out.copy, "EQUAL"); assert.deepEqual(out.refusals, []); assert.deepEqual(out.imported, ["route-state"]);
  assert.equal(fs.readFileSync(path.join(tmp, "copy", "route-state", "route-mem.json"), "utf8"), "{\"seq\":7}");
  fs.writeFileSync(path.join(tmp, "imports-clash.json"), JSON.stringify([{ rel: "orders.json", src: path.join(tmp, "var-route-state", "route-mem.json") }]));
  assert.equal(node("pa-export-check.mjs", ["--data-dir", d, "--imports", path.join(tmp, "imports-clash.json"), "--manifest-out", path.join(tmp, "mc.json")]).status, 2, "an import never overwrites a data-directory file");
  assert.ok(!/secretuser|orders|session-key|fake/.test(r.stdout + fs.readFileSync(path.join(tmp, "m.json"), "utf8")), "no file name or content in any output");
  assert.equal(fs.statSync(path.join(tmp, "m.json")).mode & 0o777, 0o600);
  assert.equal(fs.statSync(path.join(tmp, "copy", "accounts", "0xsecretuser.json")).mode & 0o777, 0o600);
  assert.equal(node("pa-export-check.mjs", ["--verify", path.join(tmp, "copy"), "--manifest", path.join(tmp, "m.json")]).status, 0);
  fs.writeFileSync(path.join(tmp, "copy", "orders.json"), "[1]");
  assert.equal(node("pa-export-check.mjs", ["--verify", path.join(tmp, "copy"), "--manifest", path.join(tmp, "m.json")]).status, 1);
  for (const [i, extra] of [{ "link.json": "symlink" }, { "inflight.json.tmp": "x" }, { "platform-credentials.json": "{}" }, { "bad name.json": "x" }].entries()) {
    const bad = node("pa-export-check.mjs", ["--data-dir", relayDir(`bad${i}`, extra), "--manifest-out", path.join(tmp, `bad${i}.json`)]);
    assert.equal(bad.status, 2, `case ${i} must be refused`); assert.ok(!fs.existsSync(path.join(tmp, `bad${i}.json`)));
  }
  assert.notEqual(node("pa-export-check.mjs", ["--data-dir", d, "--manifest-out", path.join(tmp, "m.json")]).status, 0, "never overwrites a manifest");
});

test("credentials-assemble: one rule for every name; *_FILE as content; state paths rewritten into the data dir; 0600; no value printed", () => {
  fs.writeFileSync(path.join(tmp, "signing.pem"), "FAKE-PEM-CONTENT");
  const lines = CREDENTIAL_NAMES.map((k) => (k.endsWith("_FILE") ? `${k}=${path.join(tmp, "signing.pem")}` : `${k}="fakevalue-${k}"`));
  lines.push("# comment", "SIWE_DOMAIN=enclave.host", "PASSKEY_RP_ID=enclave.host", "PASSKEY_ORIGINS=https://enclave.host", "CORS_ORIGINS=https://enclave.host",
    "METAL_TUNNEL_TOKENS=fakevalue-tunnel", "PADS_MASTER_SEED=fakevalue-seed", "INTERNAL_TOKEN=fakevalue-internal", "ALERT_WEBHOOK_URL=https://hooks.example/fakevalue-hook",
    "BASE_RPC=https://rpc.example/v2/abcdefghijklmnopqrstuvwxyz012345", "SECRETS_RELEASE_PREDICT_WORK=/var/lib/predict", "AUTH_DATA_DIR=/var/lib/enclave-relay",
    "RELAY_VERIFIER_CACHE_DIR=/var/cache/v", "LEASE_GENERATION_STATE=/var/lib/enclave-relay/lease-gen.json", "FEATURED_VIEWS_FILE=featured-views.json", "SOMETHING_ELSE=1");
  fs.writeFileSync(path.join(tmp, "env"), lines.join("\n"));
  const outs = (n) => ["--creds-out", path.join(tmp, `creds${n}.json`), "--public-out", path.join(tmp, `pub${n}.json`), "--imports-out", path.join(tmp, `imp${n}.json`)];
  const r = node("pa-credentials-assemble.mjs", ["--env-file", path.join(tmp, "env"), ...outs(1)]);
  assert.equal(r.status, 0, r.stderr);
  assert.ok(!/fakevalue|FAKE-PEM|abcdefghij|hooks\.example/.test(r.stdout + r.stderr), "no value printed");
  const creds = JSON.parse(fs.readFileSync(path.join(tmp, "creds1.json"), "utf8"));
  assert.deepEqual(Object.keys(creds).sort(), [...CREDENTIAL_NAMES, "METAL_TUNNEL_TOKENS", "PADS_MASTER_SEED", "INTERNAL_TOKEN", "ALERT_WEBHOOK_URL"].sort());
  assert.equal(creds.SECRETS_RELEASE_SIGNING_KEY_FILE, "FAKE-PEM-CONTENT");
  for (const f of ["creds1", "pub1", "imp1"]) assert.equal(fs.statSync(path.join(tmp, `${f}.json`)).mode & 0o777, 0o600);
  const pub = JSON.parse(fs.readFileSync(path.join(tmp, "pub1.json"), "utf8"));
  assert.ok(Object.keys(pub).every((k) => PUBLIC_NAMES.includes(k)), "relayEnv only carries public names the relay reads");
  for (const k of ["SIWE_DOMAIN", "PASSKEY_RP_ID", "PASSKEY_ORIGINS", "CORS_ORIGINS"]) assert.ok(k in pub, `${k} kept (origin/passkeys)`);
  assert.equal(pub.ROUTE_STATE_DIR, `${GUEST_DATA}/route-state`); assert.equal(pub.LEASE_GENERATION_STATE, `${GUEST_DATA}/lease-generation-state.json`);
  assert.equal(pub.FEATURED_VIEWS_FILE, "featured-views.json"); assert.ok(!("AUTH_DATA_DIR" in pub) && !("RELAY_VERIFIER_CACHE_DIR" in pub));
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(tmp, "imp1.json"), "utf8")).map((x) => x.rel).sort(), ["lease-generation-state.json", "route-state"]);
  const rep = JSON.parse(r.stdout);
  assert.deepEqual(rep.droppedNotRead, ["SOMETHING_ELSE"]); assert.deepEqual(rep.droppedRoleOwned, ["AUTH_DATA_DIR"]);
  assert.ok(rep.review.some((x) => x.startsWith("BASE_RPC")) && rep.review.some((x) => x.startsWith("SECRETS_RELEASE_PREDICT_WORK")));
  const names = node("pa-credentials-assemble.mjs", ["--env-file", path.join(tmp, "env"), "--names-only"]);
  assert.equal(names.status, 0); assert.ok(!/fakevalue|FAKE-PEM|abcdefghij|hooks\.example/.test(names.stdout));
  assert.deepEqual(JSON.parse(names.stdout).credentials.sort(), Object.keys(creds).sort());
  fs.writeFileSync(path.join(tmp, "env2"), lines.filter((l) => !l.startsWith("STRIPE_SECRET_KEY")).join("\n"));
  assert.equal(node("pa-credentials-assemble.mjs", ["--env-file", path.join(tmp, "env2"), ...outs(2)]).status, 2);
  assert.equal(node("pa-credentials-assemble.mjs", ["--env-file", path.join(tmp, "env2"), ...outs(3), "--allow-missing", "STRIPE_SECRET_KEY"]).status, 0);
});

// direct configs (same fixture shape as test/platform-api-config.test.mjs)
const a = (n) => "0x" + n.toString(16).padStart(40, "0");
const rec = hpke.generateKeyPair();
const PA = () => ({ apiPort: 8098, peerPort: 8099, hostname: "api.enclave.host",
  members: [0, 1, 2].map((i) => ({ operator: a(0xb0 + i), publicUrl: `https://host-${i}.example.org`, controlUrl: `https://198.51.100.${10 + i}:8444` })),
  measurements: ["77".repeat(48)], minTcb: null, admins: [a(0xad)], recovery: [Buffer.from(rec.publicKey).toString("hex"), "22".repeat(32)], archives: ["https://archive.example"], archiveMs: 30000,
  relayEnv: { ADDRESS_BOOK_ADDRESS: "0xab214342d5a490150a4a977063a2f88e21f80907", SESSIONS_SITE: "https://enclave.host", ROUTE_STATE_DIR: `${GUEST_DATA}/route-state` }, leaseMs: 10000 });
const CFG = (i, pa = PA()) => ({ format: MC.CONFIG_FORMAT, chainId: 8453,
  contracts: { registry: a(0x11), deployments: a(0x12), appCatalog: a(0x13), proofOfTime: a(0x14), enclavePay: a(0), verificationFees: a(0), sessionVaultFactory: a(0), secretVaultV2: a(0) },
  profileDigest: null, rpcs: ["https://rpc-a.example/v1", "https://rpc-b.example"], quorum: 2, releaseId: "ab".repeat(32),
  replicas: { gateways: ["http://192.0.2.10:8189"], storagePlan: null },
  identity: { publicUrl: `https://host-${i}.example.org`, repo: "owner/enclave", operator: a(0xb0 + i) },
  selling: { cpuPrice6: null, payout: null }, isolation: { managerUrl: "http://10.0.2.2:8095", dataAddr: "10.0.2.2:8096" }, hostAdmissionSha256: null, controlPort: 8444, platformApi: pa });

test("config-check: identical member, own identities, production hostname, archives, old public values kept", async () => {
  const ok = await checkConfigs([0, 1, 2].map((i) => CFG(i)), { relayEnv: { ADDRESS_BOOK_ADDRESS: "0xab214342d5a490150a4a977063a2f88e21f80907" } });
  assert.deepEqual(ok.refusals, []); assert.equal(ok.members.length, 3); assert.equal(ok.majority, 2);
  assert.equal(new Set(ok.members.map((m) => m.hostData)).size, 3, "each member binds its own config");
  const diff = PA(); diff.leaseMs = 12000;
  assert.match((await checkConfigs([CFG(0), CFG(1), CFG(2, diff)])).refusals.join(), /differs from config 0/);
  assert.match((await checkConfigs([CFG(0), CFG(1)])).refusals.join(), /3 members listed, 2 member config/);
  const host = PA(); host.hostname = "api2.enclave.host";
  assert.match((await checkConfigs([0, 1, 2].map((i) => CFG(i, host)))).refusals.join(), /production origin/);
  const noArch = PA(); noArch.archives = [];
  assert.match((await checkConfigs([0, 1, 2].map((i) => CFG(i, noArch)))).refusals.join(), /no archives/);
  assert.match((await checkConfigs([0, 1, 2].map((i) => CFG(i)), { relayEnv: { SIWE_URI: "https://enclave.host" } })).refusals.join(), /SIWE_URI differs/);
  const tok = PA(); tok.relayEnv.METAL_TUNNEL_TOKENS = "x";
  assert.doesNotThrow(() => MC.canonicalDirectConfig(CFG(0, tok)), "the bound-config validator lets plural TOKENS through (finding for root)");
  assert.match((await checkConfigs([0, 1, 2].map((i) => CFG(i, tok)))).refusals.join(), /METAL_TUNNEL_TOKENS is credential-shaped/);
  const rs = PA(); delete rs.relayEnv.ROUTE_STATE_DIR;
  assert.match((await checkConfigs([0, 1, 2].map((i) => CFG(i, rs)))).refusals.join(), /ROUTE_STATE_DIR must be/);
  const r = node("pa-config-check.mjs", []); assert.equal(r.status, 2);
});

function fakeReport(chipByte) {
  const r = Buffer.alloc(0x4a0); r.writeUInt32LE(2, 0); r.writeBigUInt64LE(1n << 17n, 8); r.writeUInt32LE(1, 0x34); r.fill(chipByte, 0x1a0, 0x1e0); return r;
}
test("preflight: refuses unverified members and members sharing one SNP chip; after genesis needs a keyed majority and one leader", async () => {
  const cfgs = [0, 1, 2].map((i) => CFG(i));
  const run = (chips, { verified = [true, true, true], status = null, afterGenesis = false } = {}) => preflight(cfgs, { afterGenesis,
    verifierFor: () => async ({ url }) => { const i = Number(url.split(".")[3].split(":")[0]) - 10; return verified[i] ? { ok: true, identity: { bootId: `boot${i}`, measurement: "77".repeat(48), controlTlsSpkiSha256: "00" } } : { ok: false, reason: "pending: PENDING (registry)" }; },
    tlsGet: async (url) => { const i = Number(url.split(".")[3].split(":")[0]) - 10; return { status: 200, body: Buffer.from(JSON.stringify({ statement: `boot${i}`, report: fakeReport(chips[i]).toString("base64") })) }; },
    parseStatement: (s) => ({ bootId: s }),
    readStatus: async (url) => (status ? status[Number(url.split(".")[3].split(":")[0]) - 10] : { haveKey: false }) });
  assert.deepEqual((await run([1, 2, 3])).refusals, []);
  assert.match((await run([1, 1, 3])).refusals.join(), /share an SEV-SNP chip/);
  assert.match((await run([1, 1, 1])).refusals.join(), /1 distinct physical SEV-SNP host/);
  assert.match((await run([1, 2, 3], { verified: [true, false, true] })).refusals.join(), /did not verify \(pending/);
  const L = a(0xb0);
  assert.deepEqual((await run([1, 2, 3], { afterGenesis: true, status: [{ haveKey: true, leader: L }, { haveKey: true, leader: L }, { haveKey: false }] })).refusals, []);
  assert.match((await run([1, 2, 3], { afterGenesis: true, status: [{ haveKey: true, leader: L }, { haveKey: false }, { haveKey: false }] })).refusals.join(), /majority \(2\) must/);
});

test("archive-open: genesis archive round trip under the recovery key; newest head wins; tampered or foreign copies refused", async () => {
  const pa = MC.canonicalDirectConfig(CFG(0)).platformApi, gid = R.groupIdOf(pa);
  const d = relayDir("cutover"), want = treeManifest(walk(d).files);
  const target = hpke.generateKeyPair();
  const st = JSON.stringify({ keys: { platformApi: { publicKey: Buffer.from(target.publicKey).toString("hex") } } });
  const g = await admin.genesis({ platformApi: pa, targetStatementText: st, files: S.readAll(d), credentials: { STRIPE_SECRET_KEY: "fake" } });
  const genesisArchive = Buffer.from(g.package.state, "base64");
  const older = genesisArchive, newer = S.sealMessage(g.key, "archive", { format: S.REPLICA_FORMAT, group: gid, head: { epoch: 2, seq: 9 }, at: Date.now(), files: { ...S.readAll(d), "orders.json": Buffer.from("[42]").toString("base64") } });
  const tampered = Buffer.from(newer); tampered[40] ^= 1;
  const foreign = S.sealMessage(Buffer.alloc(32, 7), "archive", { format: S.REPLICA_FORMAT, group: gid, head: { epoch: 9, seq: 9 }, at: 0, files: {} });
  const r = await openNewest({ platformApi: pa, envelope: g.envelope, recoveryPrivateKey: Buffer.from(rec.privateKey), archives: [older, tampered, foreign, newer] });
  assert.deepEqual(r.newest.head, { epoch: 2, seq: 9 }); assert.equal(r.from, 3); assert.equal(r.refused.length, 2);
  const only = await openNewest({ platformApi: pa, envelope: g.envelope, recoveryPrivateKey: Buffer.from(rec.privateKey), archives: [older] });
  assert.ok(Object.hasOwn(only.newest.files, "platform-credentials.json"), "genesis carried the credentials file");
  const m = materialize(path.join(tmp, "restored"), only.newest.files);
  assert.equal(m.treeSha256, want.treeSha256, "restored genesis state equals the cutover manifest (credentials file excluded)");
  assert.ok(!fs.existsSync(path.join(tmp, "restored", "platform-credentials.json")));
  await assert.rejects(openNewest({ platformApi: pa, envelope: g.envelope, recoveryPrivateKey: Buffer.alloc(32, 1), archives: [older] }));
  assert.throws(() => materialize(path.join(tmp, "restored"), {}), /exists/);
});

test("cutover.sh prints the plan by default and refuses production steps without CUTOVER_ACK", () => {
  const sh = path.join(H, "..", "cutover.sh");
  assert.match(execFileSync("bash", [sh], { encoding: "utf8" }), /3  FENCE \(production\)/);
  const r = spawnSync("bash", [sh, "run", "3"], { encoding: "utf8", env: { ...process.env, TREE: process.env.ENCLAVE_TREE, GENESIS_CFG: "/nonexistent", OLD_STOP_CMD: "touch " + path.join(tmp, "MUST-NOT-RUN") } });
  assert.notEqual(r.status, 0); assert.ok(!fs.existsSync(path.join(tmp, "MUST-NOT-RUN")));
  fs.writeFileSync(path.join(tmp, "g.json"), JSON.stringify(CFG(0)));
  const r2 = spawnSync("bash", [sh, "run", "3"], { encoding: "utf8", env: { ...process.env, TREE: process.env.ENCLAVE_TREE, GENESIS_CFG: path.join(tmp, "g.json"), OLD_STOP_CMD: "touch " + path.join(tmp, "MUST-NOT-RUN"), CUTOVER_ACK: "wrong" } });
  assert.equal(r2.status, 3); assert.match(r2.stderr, /CUTOVER_ACK=[0-9a-f]{32}/); assert.ok(!fs.existsSync(path.join(tmp, "MUST-NOT-RUN")));
  assert.match(execFileSync("bash", [path.join(H, "..", "rollback.sh"), "after-switch"], { encoding: "utf8", env: { ...process.env, ARCHIVES: "x y" } }), /--archive x --archive y/);
});
