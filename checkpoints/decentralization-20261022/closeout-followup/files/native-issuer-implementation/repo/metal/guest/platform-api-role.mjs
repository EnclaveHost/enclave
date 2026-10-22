#!/usr/bin/env node
// metal/guest/platform-api-role.mjs -- the PLATFORM API as a measured host role (docs/network/hosted-platform-api.md).
// Shipped bundled (metal/guest/platform-api.bundle.mjs, scripts/build-platform-api-guest-bundle.mjs) inside the measured
// control guest image, so its bytes, and the unchanged relay/api-relay.js it runs, are covered by the launch measurement.
// gsup starts it only for a bound direct config with a `platformApi` member (measured-control.mjs directPlatformApiLaunch).
//
// One role process per member guest:
//   - holds the group's state key K, received ONLY sealed to this boot's handoff key (named in the attested statement):
//       - from the admin's signed bootstrap (genesis, import or recovery: scripts/platform-api-admin.mjs);
//       - or from a member that verified this guest first (verifyMeasuredControl: measurement, HOST_DATA-bound config with
//         the identical platformApi member, registry operator).
//   - replicates the relay's data directory with relay/state-replica.mjs (majority commit, lease, epochs, AEAD under K),
//     and pushes encrypted snapshots, plus K escrowed to the admin recovery keys, to the archive sinks.
//   - on the PRIMARY only, runs the unchanged relay (this file with --relay-child: api-relay.js on the guest RAM fs, the
//     platform credentials in its environment) behind a response barrier: no HTTP response leaves the relay before what
//     it wrote is on a majority of members. The relay is killed the moment the lease cannot be renewed.
//   - on a standby, forwards API requests to the primary's control front, pinned to its attested TLS key.
// Nothing here reads or prints state, credentials or K.
import fs from "node:fs";
import path from "node:path";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import { spawn } from "node:child_process";
import { createHash, createHmac, timingSafeEqual, X509Certificate } from "node:crypto";
import { fileURLToPath } from "node:url";
import * as hpke from "../../custody/hpke.mjs";
import { ReplicaNode, sealMessage, openArchive, replaceAll, REPLICA_FORMAT } from "../../relay/state-replica.mjs";
import { createNativeIssuer, nativeCaCredentials, isNativeCaCredential, CONFIG_PATH } from "./native-issuer.mjs";

export const ROLE_FORMAT = "enclave-platform-api-role/v1";
export const PACKAGE_FORMAT = "enclave-platform-api-package/v1";
export const RECOVERY_FORMAT = "enclave-platform-api-recovery/v1";
export const HANDOFF_INFO = Buffer.from("enclave-platform-api handoff v1");
export const CREDENTIALS_INFO = Buffer.from("enclave-platform-api credentials v1");
export const RECOVERY_INFO = Buffer.from("enclave-platform-api recovery v1");
export const CREDENTIALS_FILE = "platform-credentials.json";
export const CREDENTIALS_FORMAT = "enclave-platform-api-credentials/v1";
/** the credentials document in the replicated state: { format, at (the admin package time, strictly increasing), credentials } */
export function readCredentials(file) {
  try { const o = JSON.parse(fs.readFileSync(file, "utf8")); if (o && o.format === CREDENTIALS_FORMAT && o.credentials && typeof o.credentials === "object") return o; } catch {}
  return { format: CREDENTIALS_FORMAT, at: 0, credentials: {} };
}
export const PEER_PATH = "/platform-api/peer", HANDOFF_PATH = "/platform-api/handoff", BOOTSTRAP_PATH = "/platform-api/bootstrap",
  CREDENTIALS_PATH = "/platform-api/credentials", STATUS_PATH = "/platform-api/status";
export const HOP_HEADER = "x-enclave-platform-api-hop";
export const HOP_CLIENT_HEADER = "x-enclave-platform-api-client";
const FORWARDING = ["x-forwarded-for", "x-forwarded-host", "x-forwarded-proto", "x-enclave-client-ip", HOP_HEADER, HOP_CLIENT_HEADER];
const sha256Hex = (...parts) => { const h = createHash("sha256"); for (const p of parts) h.update(p); return h.digest("hex"); };
const lc = (s) => String(s || "").toLowerCase();

// ---- canonical JSON (the same rule as measured-control.mjs canonicalJson) -----------------------------------------------
export function canonicalJson(v) {
  if (v === null || typeof v === "boolean" || typeof v === "string") return JSON.stringify(v);
  if (typeof v === "number") { if (!Number.isSafeInteger(v)) throw new Error("canonical JSON carries only safe integers"); return String(v); }
  if (Array.isArray(v)) return "[" + v.map(canonicalJson).join(",") + "]";
  if (v && typeof v === "object") return "{" + Object.keys(v).sort().map((k) => JSON.stringify(k) + ":" + canonicalJson(v[k])).join(",") + "}";
  throw new Error(`canonical JSON cannot carry ${typeof v}`);
}
/** the group's identity: every member carries the identical platformApi member */
export const groupIdOf = (platformApi) => sha256Hex("enclave-platform-api group v1\n", canonicalJson(platformApi)).slice(0, 32);

// ---- admin-signed packages (bootstrap, recovery, credentials) ------------------------------------------------------------
/** the digest an admin wallet signs (EIP-191 personal_sign over this text): binds the kind, the group and the target boot */
export function packageMessage(pkg) {
  const { signature, ...body } = pkg;
  return `enclave-platform-api package v1\ngroup ${body.groupId}\nkind ${body.kind}\ntarget ${body.targetStatementSha256}\nbody ${sha256Hex(canonicalJson(body))}\n`;
}
/** -> the lowercase admin address that signed `pkg`, or throws */
export async function packageSigner(pkg, admins, { recoverMessageAddress }) {
  if (!pkg || pkg.format !== PACKAGE_FORMAT || typeof pkg.signature !== "string") throw new Error("not a signed platform-api package");
  const who = lc(await recoverMessageAddress({ message: packageMessage(pkg), signature: pkg.signature }));
  if (!admins.map(lc).includes(who)) throw new Error(`the package is signed by ${who}, not by one of this group's admins`);
  return who;
}
/** K escrowed to every admin recovery key (any one recovers); stored beside every archive */
export function recoveryEnvelope({ key, groupId, recovery }) {
  return { format: RECOVERY_FORMAT, groupId, recipients: recovery.map((pub) => ({ pub,
    sealed: Buffer.from(hpke.seal(Buffer.from(pub, "hex"), RECOVERY_INFO, Buffer.from(groupId), key)).toString("base64") })) };
}
export function openRecovery(env, { groupId, privateKey }) {
  if (!env || env.format !== RECOVERY_FORMAT || env.groupId !== groupId) throw new Error("not this group's recovery envelope");
  const pub = Buffer.from(hpke.publicKeyOf(privateKey)).toString("hex");
  const r = env.recipients.find((x) => x.pub === pub);
  if (!r) throw new Error("this recovery key is not a recipient");
  return Buffer.from(hpke.open(privateKey, RECOVERY_INFO, Buffer.from(groupId), Buffer.from(r.sealed, "base64")));
}

// ---- the role --------------------------------------------------------------------------------------------------------------
/**
 * startRole(opts) -> { status(), stop(), node(), servers }
 *   cfg          the role file PID 1 wrote: { format, platformApi, identity, self, statementFile, handoffKeyFile, dirs }
 *   verifyPeer   async ({ url, config }) -> { ok, statementText, reason }: the newcomer's attestation (production:
 *                metal/measured-control-verify.mjs verifyMeasuredControl with the group's measurements and the registry)
 *   recoverMessageAddress  viem's (the admin package signer check)
 *   relayArgv    how to start the relay child (argv for node), default: this file with --relay-child
 *   transport    { post(url, Buffer|object, {pin}) -> Buffer|object } overridable for tests; default https/http
 */
export async function startRole({ cfg, verifyPeer, recoverMessageAddress, relayArgv = null, log = (m) => console.log(`[platform-api] ${m}`),
                                  now = Date.now, postImpl = null, archivePut = null, nativeIssuer = null }) {
  const pa = cfg.platformApi, groupId = groupIdOf(pa), self = cfg.self, members = pa.members;
  const dirs = cfg.dirs, dataDir = dirs.data;
  for (const d of [dirs.root, dataDir]) fs.mkdirSync(d, { recursive: true, mode: 0o700 });
  const statementText = fs.readFileSync(cfg.statementFile, "utf8");
  const statement = JSON.parse(statementText);
  const handoffPriv = Buffer.from(fs.readFileSync(cfg.handoffKeyFile, "utf8").trim(), "hex");
  const myPub = Buffer.from(hpke.publicKeyOf(handoffPriv)).toString("hex");
  if (statement.keys?.platformApi?.publicKey !== myPub) throw new Error("the attested statement does not name this boot's platform-api handoff key");
  const statementSha = sha256Hex(statementText);
  const post = postImpl || defaultPost;
  let key = null, node = null, child = null, childPort = 0, childBackoff = 500, stopped = false;
  const info = { controlUrl: members[self].controlUrl, spki: statement.keys.controlTls.spkiSha256 };

  // K survives a restart of this process within the boot (RAM fs), never a reboot
  const kFile = path.join(dirs.root, "k");
  try { const k = Buffer.from(fs.readFileSync(kFile, "utf8").trim(), "hex"); if (k.length === 32) key = k; } catch {}
  const haveKey = (k, why) => {
    key = k;
    fs.writeFileSync(kFile, k.toString("hex"), { mode: 0o600 });
    log(`state key received (${why}); joining group ${groupId} as member ${self} of ${members.length}`);
    startNode();
  };

  // ---- the relay child (primary only) ----
  const pending = new Map();
  function startRelay() {
    if (child || stopped) return;
    const creds = readCredentials(path.join(dataDir, CREDENTIALS_FILE)).credentials;
    // a credential the relay reads from a FILE (NAME_FILE: e.g. the release signing seed) is written to the RAM fs, 0600
    const credEnv = {};
    // the credential files are exactly the CURRENT set: a replaced or removed credential leaves no file behind
    fs.rmSync(path.join(dirs.root, "creds"), { recursive: true, force: true });
    for (const [k, v] of Object.entries(creds)) {
      if (isNativeCaCredential(k)) continue;             // the native CA is the issuer's alone: never in the relay's environment or files
      if (!k.endsWith("_FILE")) { credEnv[k] = v; continue; }
      const f = path.join(dirs.root, "creds", k);
      fs.mkdirSync(path.dirname(f), { recursive: true, mode: 0o700 }); fs.writeFileSync(f, v, { mode: 0o600 }); credEnv[k] = f;
    }
    const env = { PATH: process.env.PATH || "/usr/local/bin:/usr/bin:/bin", ...(cfg.relayEnvBase || {}), ...pa.relayEnv, ...credEnv, AUTH_DATA_DIR: dataDir,
                  API_RELAY_BIND: "127.0.0.1", API_RELAY_PORT: "0", PLATFORM_API_ROLE: "relay-child", NODE_EXTRA_CA_CERTS: process.env.NODE_EXTRA_CA_CERTS || "" };
    // the final boundary: whatever source a NATIVE_CA_* name came from (base, bound relayEnv, credentials), the relay never has it
    for (const k of Object.keys(env)) if (isNativeCaCredential(k)) delete env[k];
    const argv = relayArgv || [process.execPath, fileURLToPath(import.meta.url), "--relay-child"];
    const c = spawn(argv[0], argv.slice(1), { env, cwd: dataDir, stdio: ["ignore", "inherit", "inherit", "ipc"] });
    child = c; childPort = 0;
    c.on("message", (m) => {
      if (m && m.t === "listening" && Number.isInteger(m.port)) { childPort = m.port; childBackoff = 500; log(`relay serving (primary, epoch ${node.promised})`); }
      if (m && m.t === "barrier" && Number.isInteger(m.id))
        Promise.resolve(node && node.role === "leader" ? node.commit() : false).then((ok) => { try { c.send({ t: "barrier", id: m.id, ok: ok === true }); } catch {} });
    });
    c.on("exit", (code, sig) => {
      if (child === c) { child = null; childPort = 0; }
      if (!stopped && node && node.role === "leader") {
        log(`relay exited (code ${code} sig ${sig}); restarting in ${childBackoff} ms`);
        setTimeout(() => { if (node && node.role === "leader") startRelay(); }, childBackoff);
        childBackoff = Math.min(childBackoff * 2, 15000);
      }
    });
  }
  function stopRelay(why) {
    if (!child) return;
    log(`relay stopped (${why})`);
    try { child.kill("SIGKILL"); } catch {}
    child = null; childPort = 0;
  }

  // ---- the native CA issuer (primary only; metal/guest/native-issuer.mjs) ----
  // It runs while this member is the primary AND the group holds the admin's NATIVE_CA_* credentials. Leadership loss,
  // stop, or a credentials package that removes or replaces them stops the current run (its timer and connections) at once.
  const credentialsFile = path.join(dataDir, CREDENTIALS_FILE);
  const issuer = nativeIssuer ? createNativeIssuer({ ...nativeIssuer, members, self, platformApi: pa, ownConfig: cfg.config,
    selfUrl: `https://127.0.0.1:${cfg.listen?.control ?? cfg.config.controlPort}`,       // this guest's own front: no public hairpin
    barrier: async () => !!node && node.role === "leader" && (await node.commit()) === true && node.role === "leader" && node.leaseValid(),
    credentialsDigest: () => nativeCaCredentials(readCredentials(credentialsFile).credentials)?.digest ?? null,
    log: (m) => log(m), now }) : null;
  function syncIssuer(why) {
    if (!issuer) return;
    if (stopped || !node || node.role !== "leader") return issuer.stop(why);
    const c = nativeCaCredentials(readCredentials(credentialsFile).credentials);
    if (!c) return issuer.stop("the group holds no native CA credentials");
    issuer.start(c, why);
  }

  // ---- the replica member ----
  function startNode() {
    if (node) return;
    node = new ReplicaNode({ self, n: members.length, key, group: groupId, dir: dataDir, metaFile: path.join(dirs.root, "meta.json"), leaseMs: pa.leaseMs, now, info,
      log: (m) => log(m),
      send: async (i, buf) => Buffer.from(await post(members[i].controlUrl + PEER_PATH, buf, { binary: true })),
      onLeader: () => { startRelay(); syncIssuer("primary"); }, onFollower: (why) => { issuer?.stop(why); stopRelay(why); },
      archive: pa.archives.length ? archive : null, archiveMs: pa.archiveMs ?? 30000 });
    node.start();
  }
  const recovery = () => recoveryEnvelope({ key, groupId, recovery: pa.recovery });
  // a sink holds a RECOVERABLE archive only with both halves of this write: the snapshot sealed under K and K escrowed to the
  // admin recovery keys. Half of one sink and the other half of another recover nothing, so only complete pairs count.
  let lastArchive = null;
  async function archive(blob, head) {
    const put = archivePut || defaultPut, envelope = Buffer.from(JSON.stringify(recovery()));
    const paired = await Promise.all(pa.archives.map((sink) => Promise.allSettled([put(`${sink}/platform-api/${groupId}/latest`, blob),
      put(`${sink}/platform-api/${groupId}/recovery.json`, envelope)]).then((r) => r.every((x) => x.status === "fulfilled"))));
    const okSinks = paired.filter(Boolean).length;
    if (!okSinks) throw new Error(`no archive sink took both the snapshot and the recovery envelope (${pa.archives.length} tried)`);
    lastArchive = { head: { ...head }, at: new Date(now()).toISOString(), sinks: okSinks, of: pa.archives.length };
    log(`archived snapshot ${head.epoch}.${head.seq} to ${okSinks} of ${pa.archives.length} sink(s), each with its recovery envelope`);
  }

  // ---- the peer/control listener (the front routes /platform-api/* here) ----
  const readBody = (req, max) => new Promise((ok, no) => { const c = []; let n = 0;
    req.on("data", (d) => { n += d.length; if (n > max) { no(new Error("too large")); req.destroy(); } else c.push(d); });
    req.on("end", () => ok(Buffer.concat(c))); req.on("error", no); });
  const send = (res, status, body, type = "application/json") => {
    const b = Buffer.isBuffer(body) ? body : Buffer.from(JSON.stringify(body));
    res.writeHead(status, { "content-type": type, "content-length": b.length, "cache-control": "no-store" }); res.end(b);
  };
  const peerServer = http.createServer(async (req, res) => {
    const u = new URL("http://x" + (req.url || "/"));
    try {
      if (u.pathname === STATUS_PATH && req.method === "GET")
        return send(res, 200, { format: ROLE_FORMAT, groupId, self, haveKey: !!key, ...(node ? node.status() : { role: "waiting-for-key" }), relay: !!childPort });
      // this boot's bound config: public by construction (relayEnv refuses secret names); a reader trusts it only after
      // verifyMeasuredControl binds it through HOST_DATA (the primary's native issuer)
      if (u.pathname === CONFIG_PATH && req.method === "GET") return send(res, 200, { format: ROLE_FORMAT, groupId, config: cfg.config });
      if (req.method !== "POST") return send(res, 405, { error: "method" });
      if (u.pathname === PEER_PATH) {
        if (!node) return send(res, 503, { error: "no_key" });
        const body = await readBody(req, 64 * 1024 * 1024);
        try { return send(res, 200, await node.handle(body), "application/octet-stream"); }
        catch { return send(res, 403, { error: "refused" }); }
      }
      const body = JSON.parse((await readBody(req, 64 * 1024 * 1024)).toString("utf8") || "{}");
      if (u.pathname === HANDOFF_PATH) return send(res, ...(await handoff(body)));
      if (u.pathname === BOOTSTRAP_PATH) return send(res, ...(await bootstrap(body)));
      if (u.pathname === CREDENTIALS_PATH) return send(res, ...(await credentials(body)));
      return send(res, 404, { error: "not_found" });
    } catch (e) { return send(res, 400, { error: "bad_request", message: String(e.message).slice(0, 200) }); }
  });

  /** a member that holds K seals it to a verified newcomer of this group */
  async function handoff(body) {
    if (!key) return [503, { error: "no_key" }];
    const config = body.config;
    if (!config || typeof config !== "object" || canonicalJson(config.platformApi ?? null) !== canonicalJson(pa))
      return [403, { error: "not_this_group", message: "the requester's bound config does not carry this group's platformApi member" }];
    const idx = members.findIndex((m) => lc(m.operator) === lc(config.identity?.operator) && m.publicUrl === config.identity?.publicUrl);
    if (idx < 0 || idx === self) return [403, { error: "not_a_member" }];
    const v = await verifyPeer({ url: members[idx].controlUrl, config, measurements: pa.measurements, minTcb: pa.minTcb ?? null });
    if (!v || !v.ok) return [403, { error: "not_verified", message: String(v?.reason || "the newcomer did not verify").slice(0, 300) }];
    const st = JSON.parse(v.statementText);
    const pub = st.keys?.platformApi?.publicKey;
    if (!/^[0-9a-f]{64}$/.test(String(pub))) return [403, { error: "no_handoff_key" }];
    if (lc(st.identity?.operator) !== lc(members[idx].operator)) return [403, { error: "wrong_operator" }];
    log(`state key handed to member ${idx} after verifying its attestation (boot ${st.bootId})`);
    return [200, { format: ROLE_FORMAT, groupId, sealed: Buffer.from(hpke.seal(Buffer.from(pub, "hex"), HANDOFF_INFO, Buffer.from(sha256Hex(v.statementText)), key)).toString("base64") }];
  }
  /** the admin's signed genesis / import / recovery: K sealed to this boot, optionally a sealed state to start from */
  async function bootstrap(pkg) {
    if (key) return [409, { error: "have_key", message: "this member already holds the group key" }];
    let who; try { who = await packageSigner(pkg, pa.admins, { recoverMessageAddress }); } catch (e) { return [403, { error: "not_admin", message: e.message }]; }
    if (pkg.groupId !== groupId || pkg.targetStatementSha256 !== statementSha || !["genesis", "recover"].includes(pkg.kind)) return [403, { error: "wrong_target" }];
    let k; try { k = Buffer.from(hpke.open(handoffPriv, HANDOFF_INFO, Buffer.from(statementSha), Buffer.from(pkg.sealedKey, "base64"))); } catch { return [403, { error: "not_for_this_boot" }]; }
    if (k.length !== 32) return [403, { error: "bad_key" }];
    if (pkg.state) {
      let o; try { o = openArchive(k, Buffer.from(pkg.state, "base64")); } catch (e) { return [403, { error: "bad_state", message: e.message }]; }
      if (o.group !== groupId) return [403, { error: "bad_state", message: "the state is another group's" }];
      replaceAll(dataDir, o.files);
      // the seeded state ranks above any empty member, so the next election carries it
      fs.writeFileSync(path.join(dirs.root, "meta.json"), JSON.stringify({ format: REPLICA_FORMAT, promised: o.head.epoch, voted: null, head: o.head, leaderOf: null }), { mode: 0o600 });
    }
    log(`${pkg.kind} package from admin ${who} accepted`);
    haveKey(k, `${pkg.kind} by admin ${who}`);
    return [200, { ok: true, groupId }];
  }
  /** the admin's signed platform credentials, sealed to the PRIMARY's boot: written into the replicated state */
  async function credentials(pkg) {
    if (!node || node.role !== "leader") return [409, { error: "not_primary", leader: node ? node.status().leader : null }];
    let who; try { who = await packageSigner(pkg, pa.admins, { recoverMessageAddress }); } catch (e) { return [403, { error: "not_admin", message: e.message }]; }
    if (pkg.kind !== "credentials" || pkg.groupId !== groupId || pkg.targetStatementSha256 !== statementSha) return [403, { error: "wrong_target" }];
    let creds; try { creds = JSON.parse(Buffer.from(hpke.open(handoffPriv, CREDENTIALS_INFO, Buffer.from(statementSha), Buffer.from(pkg.sealed, "base64"))).toString("utf8")); }
    catch { return [403, { error: "not_for_this_boot" }]; }
    if (!creds || typeof creds !== "object" || Array.isArray(creds) || Object.entries(creds).some(([k, v]) => !/^[A-Z][A-Z0-9_]{1,63}$/.test(k) || typeof v !== "string"))
      return [422, { error: "bad_credentials" }];
    // strictly newer than what the group holds: an earlier admin package, replayed, cannot undo a rotation
    const held = readCredentials(path.join(dataDir, CREDENTIALS_FILE));
    if (!Number.isSafeInteger(pkg.at) || pkg.at <= held.at) return [409, { error: "not_newer", message: "these credentials are not newer than the group's (a replayed or out-of-order package)" }];
    fs.writeFileSync(path.join(dataDir, CREDENTIALS_FILE + ".tmp"), JSON.stringify({ format: CREDENTIALS_FORMAT, at: pkg.at, credentials: creds }), { mode: 0o600 });
    fs.renameSync(path.join(dataDir, CREDENTIALS_FILE + ".tmp"), path.join(dataDir, CREDENTIALS_FILE));
    if (!(await node.commit())) return [503, { error: "not_committed" }];
    log(`platform credentials updated by admin ${who} (${Object.keys(creds).length} names); restarting the relay`);
    stopRelay("credentials updated"); startRelay();
    syncIssuer("credentials updated");
    return [200, { ok: true, names: Object.keys(creds).sort() }];
  }

  // ---- the API listener (the front routes Host = platformApi.hostname here) ----
  // The client's address, which the relay keys its rate limits and abuse checks on (TRUSTED_PROXY: the LAST
  // x-forwarded-for entry): from this guest's front (the TCP peer it saw), or, on a request a standby forwarded, from that
  // member, proven by an HMAC under K over the time, the address, the method and the path. Client-written forwarding
  // headers are dropped, as Caddy overwrote them before.
  const hopTag = (ts, ip, method, target) => createHmac("sha256", key).update(`enclave-platform-api hop v1\n${groupId}\n${ts}\n${ip}\n${method}\n${target}`).digest("hex");
  const clientOf = (req, target) => {
    const hop = String(req.headers[HOP_HEADER] || ""), m = /^(\d{10,16})\.([0-9a-f]{64})$/.exec(hop), ip = String(req.headers[HOP_CLIENT_HEADER] || "");
    if (m && key && Math.abs(now() - Number(m[1])) < 30000 && /^[0-9a-f:.]{2,64}$/i.test(ip)) {
      const want = Buffer.from(hopTag(m[1], ip, req.method, target), "hex");
      if (timingSafeEqual(want, Buffer.from(m[2], "hex"))) return { ip, hop: true };
    }
    return { ip: String(req.headers["x-enclave-client-ip"] || req.socket.remoteAddress || "").replace(/^::ffff:/, ""), hop: !!hop };
  };
  const forwardHeaders = (req, ip) => { const h = { ...req.headers }; for (const k of FORWARDING) delete h[k];
    return { ...h, "x-forwarded-for": ip, "x-forwarded-host": pa.hostname, "x-forwarded-proto": "https" }; };
  const apiServer = http.createServer((req, res) => {
    const target = String(req.url || "/");
    const client = clientOf(req, target);
    const fail = (status, error, message) => { if (!res.headersSent) { res.writeHead(status, { "content-type": "application/json", "retry-after": "2", "cache-control": "no-store" }); res.end(JSON.stringify({ error, message })); } };
    if (node && node.role === "leader") {
      if (!childPort) return fail(503, "platform_api_starting", "The platform API is starting; retry shortly.");
      const up = http.request({ host: "127.0.0.1", port: childPort, method: req.method, path: target, headers: forwardHeaders(req, client.ip) }, (r) => { res.writeHead(r.statusCode || 502, r.headers); r.pipe(res); });
      up.on("error", () => fail(502, "platform_api_unavailable", "The platform API did not answer."));
      return req.pipe(up);
    }
    const li = node && node.leaderInfo;
    if (!li || client.hop) return fail(503, "platform_api_electing", "The platform API is electing its primary; retry shortly.");
    const to = new URL(li.controlUrl), ts = String(now());
    const hopped = { ...forwardHeaders(req, client.ip), host: pa.hostname, [HOP_HEADER]: `${ts}.${hopTag(ts, client.ip, req.method, target)}`, [HOP_CLIENT_HEADER]: client.ip };
    delete hopped["x-forwarded-for"]; delete hopped["x-forwarded-host"]; delete hopped["x-forwarded-proto"];
    const up = https.request({ host: to.hostname, port: to.port || 443, method: req.method, path: target, headers: hopped,
      rejectUnauthorized: false, checkServerIdentity: (_h, cert) => (sha256Hex(spkiOf(cert)) === li.spki ? undefined : new Error("the primary is not the attested key")) },
      (r) => { res.writeHead(r.statusCode || 502, r.headers); r.pipe(res); });
    up.on("error", () => fail(503, "platform_api_unreachable", "The platform API primary could not be reached; retry shortly."));
    req.pipe(up);
  });
  // websocket and other upgrades (the fleet tunnel): to the local relay on the primary only
  apiServer.on("upgrade", (req, socket, head) => {
    if (!(node && node.role === "leader" && childPort)) { socket.end("HTTP/1.1 503 Service Unavailable\r\nretry-after: 2\r\n\r\n"); return; }
    const up = net.connect(childPort, "127.0.0.1", () => {
      up.write(`${req.method} ${req.url} HTTP/1.1\r\n` + Object.entries(forwardHeaders(req, clientOf(req, String(req.url || "/")).ip)).map(([k, v]) => `${k}: ${v}`).join("\r\n") + "\r\n\r\n");
      if (head && head.length) up.write(head);
      socket.pipe(up); up.pipe(socket);
    });
    up.on("error", () => socket.destroy()); socket.on("error", () => up.destroy());
  });

  // ---- K from a member, when this boot has none ----
  let askTimer = null;
  async function askForKey() {
    if (key || stopped) return;
    for (let i = 0; i < members.length && !key; i++) {
      if (i === self) continue;
      try {
        const r = await post(members[i].controlUrl + HANDOFF_PATH, { config: cfg.config });
        if (r && r.sealed && r.groupId === groupId) {
          const k = Buffer.from(hpke.open(handoffPriv, HANDOFF_INFO, Buffer.from(statementSha), Buffer.from(r.sealed, "base64")));
          if (k.length === 32) { haveKey(k, `handed over by member ${i}`); return; }
        }
      } catch {}
    }
  }

  // cfg.listen exists only for members co-located in one test process; a guest always listens on the bound ports
  await new Promise((ok) => peerServer.listen(cfg.listen?.peer ?? pa.peerPort, "127.0.0.1", ok));
  await new Promise((ok) => apiServer.listen(cfg.listen?.api ?? pa.apiPort, "127.0.0.1", ok));
  if (key) startNode(); else { askTimer = setInterval(() => askForKey().catch(() => {}), cfg.askMs || 5000); askTimer.unref?.(); askForKey().catch(() => {}); }
  log(`member ${self} of group ${groupId}: peer :${peerServer.address().port}, api :${apiServer.address().port}${key ? "" : "; waiting for the state key"}`);
  return {
    groupId, statementSha, handoffPublicKey: myPub,
    status: () => ({ haveKey: !!key, relay: !!childPort, childPid: child ? child.pid : null, ...(node ? node.status() : { role: "waiting-for-key" }),
      archive: lastArchive, nativeIssuer: issuer ? issuer.status() : null }),
    node: () => node, recovery: () => (key ? recovery() : null),
    ports: { peer: peerServer.address().port, api: apiServer.address().port },
    async stop() {
      stopped = true; if (askTimer) clearInterval(askTimer);
      issuer?.stop("stopped");
      if (node) node.stop(); stopRelay("stopped");
      for (const s of [peerServer, apiServer]) { s.closeAllConnections?.(); await new Promise((ok) => s.close(() => ok())); }
    },
  };
}
/** the SPKI (DER) of a peer certificate, as the attested statement's controlTls.spkiSha256 hashes it */
const spkiOf = (cert) => { try { return new X509Certificate(cert.raw).publicKey.export({ type: "spki", format: "der" }); } catch { return Buffer.alloc(0); } };

/** POST JSON (object body) or bytes (binary) to a peer; the front's self-signed TLS key is not WebPKI, so it is not checked
 *  here: integrity and confidentiality of peer traffic come from AEAD under K and HPKE to attested keys */
async function defaultPost(url, body, { binary = false } = {}) {
  const u = new URL(url), data = binary ? body : Buffer.from(JSON.stringify(body));
  const lib = u.protocol === "https:" ? https : http;
  return new Promise((ok, no) => {
    const r = lib.request({ host: u.hostname, port: u.port || (u.protocol === "https:" ? 443 : 80), method: "POST", path: u.pathname + u.search,
      headers: { "content-type": binary ? "application/octet-stream" : "application/json", "content-length": data.length }, rejectUnauthorized: false, timeout: 15000 }, (res) => {
      const c = []; let n = 0;
      res.on("data", (d) => { n += d.length; if (n > 64 * 1024 * 1024) res.destroy(); else c.push(d); });
      res.on("end", () => {
        const b = Buffer.concat(c);
        if (res.statusCode !== 200) return no(Object.assign(new Error(`HTTP ${res.statusCode}`), { status: res.statusCode, body: b.toString("utf8").slice(0, 300) }));
        if (binary) return ok(b);
        try { ok(JSON.parse(b.toString("utf8"))); } catch { no(new Error("not JSON")); }
      });
    });
    r.on("timeout", () => r.destroy(new Error("timeout"))); r.on("error", no); r.end(data);
  });
}
async function defaultPut(url, blob) {
  const u = new URL(url), lib = u.protocol === "https:" ? https : http;
  return new Promise((ok, no) => {
    const r = lib.request({ host: u.hostname, port: u.port || (u.protocol === "https:" ? 443 : 80), method: "PUT", path: u.pathname, timeout: 30000,
      headers: { "content-type": "application/octet-stream", "content-length": blob.length } }, (res) => { res.resume(); res.on("end", () => (res.statusCode >= 200 && res.statusCode < 300 ? ok() : no(new Error(`HTTP ${res.statusCode}`)))); });
    r.on("timeout", () => r.destroy(new Error("timeout"))); r.on("error", no); r.end(blob);
  });
}

// ---- the relay child: the unchanged api-relay.js behind the response barrier -----------------------------------------------
/**
 * OUTPUT COMMIT: nothing the relay does leaves the guest before what it wrote first is on a majority of members.
 *   - every HTTP response is held at end() until the role confirms that a majority holds the data directory as it is at that
 *     moment (state-replica commit); a response whose write could not be committed is never sent: the connection is reset,
 *     so a client never sees "done" for a write a failover could lose;
 *   - every OUTBOUND request the relay makes through fetch (chain RPC and transaction submission through viem, Stripe, ACME,
 *     DNS, screening lists) waits for the same commit first, and fails if it cannot be committed: a Stripe call, a credit or
 *     a relayer transaction is never sent ahead of the journal entry or order record written before it.
 * What this does NOT cover is in docs/network/hosted-platform-api.md (in-memory state, the RPO of a whole-group loss).
 */
export function installResponseBarrier(proc = process) {
  if (!proc.send) throw new Error("the relay child runs only under the platform-api role (IPC)");
  let seq = 0;
  const waiting = new Map();
  proc.on("message", (m) => { if (m && m.t === "barrier" && waiting.has(m.id)) { waiting.get(m.id)(m.ok === true); waiting.delete(m.id); } });
  const barrier = () => new Promise((ok) => { const id = ++seq; waiting.set(id, ok); proc.send({ t: "barrier", id }); });
  const realFetch = globalThis.fetch;
  globalThis.fetch = async function (...args) {
    if (!(await barrier())) throw new Error("platform-api: the state this request follows could not be committed to a majority; not sent");
    return realFetch.apply(this, args);
  };
  const create = http.createServer;
  http.createServer = function (...args) {
    const i = args.findIndex((a) => typeof a === "function");
    if (i >= 0) {
      const listener = args[i];
      args[i] = function (req, res) {
        const end = res.end;
        res.end = function (...endArgs) {
          barrier().then((ok) => { if (ok) end.apply(res, endArgs); else { try { res.socket?.destroy(); } catch {} } });
          return res;
        };
        return listener.call(this, req, res);
      };
    }
    const server = create.apply(http, args);
    const listen = server.listen;
    server.listen = function (...la) {
      server.once("listening", () => { const a = server.address(); if (a && typeof a === "object") proc.send({ t: "listening", port: a.port }); });
      return listen.apply(server, la);
    };
    return server;
  };
}

// ---- entry points ------------------------------------------------------------------------------------------------------------
export async function main(argv) {
  if (argv.includes("--relay-child")) {
    installResponseBarrier();
    await import("../../relay/api-relay.js");
    return;
  }
  const i = argv.indexOf("--config");
  const cfg = JSON.parse(fs.readFileSync(i > 0 ? argv[i + 1] : "/run/measured-control/platform-api.json", "utf8"));
  if (cfg.format !== ROLE_FORMAT) throw new Error(`role config format must be ${ROLE_FORMAT}`);
  const viem = await import("viem");
  const { productionVerifier } = await import("./platform-api-verify.mjs");
  // the native CA issuer's dependencies, built only when this member first issues: the unchanged verifier and original
  // registry reader, AMD collateral (KDS, cached on this boot's RAM fs), and the platform host policy resolved from the relay's
  // own NON-credential environment (relayEnvBase + platformApi.relayEnv; the sealed credentials are never part of it)
  const nativeIssuer = { deps: async () => {
    const { issuerDeps } = await import("./native-issuer.mjs");
    const { cachedCollateral } = await import("../../verifier/collateral-cache.mjs");
    const { httpCollateral } = await import("../../verifier/collateral.mjs");
    return issuerDeps({ platformApi: cfg.platformApi, ownConfig: cfg.config, policyEnv: { ...(cfg.relayEnvBase || {}), ...cfg.platformApi.relayEnv },
      collateral: cachedCollateral({ dir: path.join(cfg.dirs.root, "collateral"), upstream: httpCollateral() }), log: (m) => console.log(`[platform-api] ${m}`) });
  } };
  const role = await startRole({ cfg, recoverMessageAddress: viem.recoverMessageAddress, verifyPeer: productionVerifier(cfg), nativeIssuer });
  for (const sig of ["SIGTERM", "SIGINT"]) process.on(sig, () => role.stop().finally(() => process.exit(0)));
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  main(process.argv).catch((e) => { console.error(`[platform-api] ${e.message}`); process.exit(1); });
