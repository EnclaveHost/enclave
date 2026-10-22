#!/usr/bin/env node
// scripts/platform-api-admin.mjs -- the Enclave admin's tool for the platform API role (docs/network/hosted-platform-api.md).
// Every package it makes is SIGNED by an admin wallet the group's bound config names (platformApi.admins) and SEALED to one
// attested boot. Before sealing anything it verifies that boot (metal/guest/platform-api-verify.mjs: verifyMeasuredControl
// against the group's measurements, HOST_DATA-bound config and the original registry, with AMD collateral from KDS kept in
// a local cache that is authenticated against the pinned AMD roots on every read). It never prints the state key, state or
// credentials, and it sends a package ONLY to the boot it verified: over a connection pinned to that boot's attested control
// key (nothing is sent to another key), and only a package naming that boot's statement and this group.
//
//   genesis      --target <controlUrl> --target-config <direct-config.json> (--admin-key FILE | --signature 0x… | --print-message)
//                [--credentials creds.json] [--import-dir <the existing relay data directory>] [--collateral-dir D]
//                  a NEW group key; optionally the existing relay state (cutover import, opaque: read and sealed, never shown)
//                  and the platform credentials. The recovery envelope (the key escrowed to platformApi.recovery) is written
//                  to --envelope-out; members also publish it beside every archive.
//   recover      --target … --target-config … --recovery-key FILE --envelope FILE|URL --archive FILE|URL (signing as above)
//                  total loss: the admin opens the escrowed key OFFLINE, verifies a fresh guest and seals it the key plus the
//                  latest archive (already ciphertext under that key)
//   credentials  --target <the primary's controlUrl> --target-config … --credentials creds.json (signing as above)
//   status       --target <controlUrl>   (an unauthenticated read: nothing is verified or sent)
// --collateral-dir D: the AMD collateral cache (public data: the ASK/ARK chain, VCEKs, CRLs); default
// $XDG_CACHE_HOME/enclave/amd-collateral (~/.cache/enclave/amd-collateral).
// --print-message writes the exact text to sign (EIP-191 personal_sign) and the unsigned package to --package-out; re-run
// with --package FILE --signature 0x… to send it. A hardware wallet signs; this tool never needs the admin's key on disk.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import https from "node:https";
import http from "node:http";
import { createHash, randomBytes } from "node:crypto";
import * as hpke from "../custody/hpke.mjs";
import { sealMessage, readAll, REPLICA_FORMAT } from "../relay/state-replica.mjs";
import { PACKAGE_FORMAT, HANDOFF_INFO, CREDENTIALS_INFO, CREDENTIALS_FILE, CREDENTIALS_FORMAT, BOOTSTRAP_PATH, CREDENTIALS_PATH, STATUS_PATH,
  groupIdOf, packageMessage, recoveryEnvelope, openRecovery, canonicalJson } from "../metal/guest/platform-api-role.mjs";

const sha256Hex = (b) => createHash("sha256").update(b).digest("hex");

/** the platform credentials document: NAME -> string (NAME_FILE values are file contents the role writes to the RAM fs) */
export function checkCredentials(creds) {
  if (!creds || typeof creds !== "object" || Array.isArray(creds)) throw new Error("credentials must be a JSON object of NAME: string");
  for (const [k, v] of Object.entries(creds)) if (!/^[A-Z][A-Z0-9_]{1,63}$/.test(k) || typeof v !== "string") throw new Error(`credentials: ${k.slice(0, 40)} is not NAME: string`);
  return creds;
}
/** the sealed starting state of a group: the existing relay files (cutover import) plus the credentials file */
export function initialState(key, { groupId, files = {}, credentials = null, at = Date.now() } = {}) {
  const all = { ...files };
  if (credentials) all[CREDENTIALS_FILE] = Buffer.from(JSON.stringify({ format: CREDENTIALS_FORMAT, at, credentials: checkCredentials(credentials) })).toString("base64");
  return sealMessage(key, "archive", { format: REPLICA_FORMAT, group: groupId, head: { epoch: 0, seq: 1 }, at, files: all });
}
/**
 * buildPackage({ kind, platformApi, targetStatementText, key, state, credentials }) -> the UNSIGNED package
 *   genesis | recover: the group key sealed to the target boot's handoff key (+ an optional sealed state)
 *   credentials:       the credentials sealed to the target boot (the primary writes them into the replicated state)
 */
export function buildPackage({ kind, platformApi, targetStatementText, key = null, state = null, credentials = null }) {
  const st = JSON.parse(targetStatementText), pub = st.keys?.platformApi?.publicKey;
  if (!/^[0-9a-f]{64}$/.test(String(pub))) throw new Error("the target's statement names no platform API handoff key (is platformApi in its config?)");
  const aad = Buffer.from(sha256Hex(targetStatementText));
  const base = { format: PACKAGE_FORMAT, kind, groupId: groupIdOf(platformApi), targetStatementSha256: sha256Hex(targetStatementText), at: Date.now() };
  if (kind === "genesis" || kind === "recover") {
    if (!Buffer.isBuffer(key) || key.length !== 32) throw new Error("a bootstrap package carries the 32-byte group key");
    return { ...base, sealedKey: Buffer.from(hpke.seal(Buffer.from(pub, "hex"), HANDOFF_INFO, aad, key)).toString("base64"),
             ...(state ? { state: Buffer.from(state).toString("base64") } : {}) };
  }
  if (kind === "credentials")
    return { ...base, sealed: Buffer.from(hpke.seal(Buffer.from(pub, "hex"), CREDENTIALS_INFO, aad, Buffer.from(JSON.stringify(checkCredentials(credentials))))).toString("base64") };
  throw new Error(`unknown package kind ${kind}`);
}
export const signPackage = async (pkg, account) => ({ ...pkg, signature: await account.signMessage({ message: packageMessage(pkg) }) });

/** a new group: K, the recovery envelope, and the signed genesis package for one verified boot */
export async function genesis({ platformApi, targetStatementText, account = null, files = {}, credentials = null }) {
  const key = randomBytes(32);
  const pkg = buildPackage({ kind: "genesis", platformApi, targetStatementText, key, state: initialState(key, { groupId: groupIdOf(platformApi), files, credentials }) });
  return { key, envelope: recoveryEnvelope({ key, groupId: groupIdOf(platformApi), recovery: platformApi.recovery }), package: account ? await signPackage(pkg, account) : pkg };
}
/** total loss: open the escrow offline, seal the key and the latest archive to a fresh verified boot */
export async function recover({ platformApi, targetStatementText, account = null, envelope, recoveryPrivateKey, archive }) {
  const key = openRecovery(envelope, { groupId: groupIdOf(platformApi), privateKey: recoveryPrivateKey });
  const pkg = buildPackage({ kind: "recover", platformApi, targetStatementText, key, state: archive });
  return { package: account ? await signPackage(pkg, account) : pkg };
}

// ---- the command line ------------------------------------------------------------------------------------------------------
function postJson(url, body) {
  const u = new URL(url), data = Buffer.from(JSON.stringify(body)), lib = u.protocol === "https:" ? https : http;
  return new Promise((ok, no) => {
    const r = lib.request({ host: u.hostname, port: u.port, method: body === undefined ? "GET" : "POST", path: u.pathname, rejectUnauthorized: false, timeout: 30000,
      headers: body === undefined ? {} : { "content-type": "application/json", "content-length": data.length } }, (res) => {
      const c = []; res.on("data", (d) => c.push(d)); res.on("end", () => { const t = Buffer.concat(c).toString("utf8"); let j = null; try { j = JSON.parse(t); } catch {} ok({ status: res.statusCode, body: j ?? t.slice(0, 300) }); });
    });
    r.on("timeout", () => r.destroy(new Error("timeout"))); r.on("error", no); r.end(body === undefined ? undefined : data);
  });
}
/** POST JSON to the VERIFIED boot only: pinnedSocket compares the attested control key on the secure socket before any byte */
async function pinnedPostJson(url, body, spkiSha256, { timeoutMs = 30000, maxBytes = 1024 * 1024 } = {}) {
  const { pinnedSocket } = await import("../metal/guest/native-certificate.mjs");
  const u = new URL(url), data = Buffer.from(JSON.stringify(body));
  const sock = await pinnedSocket(u.origin, spkiSha256, { timeoutMs });
  return new Promise((ok, no) => {
    let settled = false;
    const settle = (e, v) => { if (settled) return; settled = true; clearTimeout(t); sock.destroy(); if (e) no(e); else ok(v); };
    const t = setTimeout(() => settle(new Error(`no complete answer within ${timeoutMs} ms`)), timeoutMs);
    const r = http.request({ createConnection: () => sock, host: u.hostname, port: u.port || 443, method: "POST", path: u.pathname,
      headers: { host: u.host, "content-type": "application/json", "content-length": data.length } }, (res) => {
      const c = []; let n = 0;
      res.on("data", (d) => { n += d.length; if (n > maxBytes) settle(new Error("answer too large")); else c.push(d); });
      res.on("end", () => { const x = Buffer.concat(c).toString("utf8"); let j = null; try { j = JSON.parse(x); } catch {} settle(null, { status: res.statusCode, body: j ?? x.slice(0, 300) }); });
      res.on("error", settle); res.on("close", () => { if (!res.complete) settle(new Error("the answer was cut off")); });
    });
    r.on("error", settle); r.on("close", () => settle(new Error("the connection closed before a complete answer")));
    r.end(data);
  });
}
export const defaultCollateralDir = (env = process.env) => path.join(env.XDG_CACHE_HOME || path.join(os.homedir(), ".cache"), "enclave", "amd-collateral");
const readMaybeUrl = async (v) => (/^https?:/.test(v) ? Buffer.from(await (await fetch(v)).arrayBuffer()) : fs.readFileSync(v));
const KIND_OF = { genesis: "genesis", recover: "recover", credentials: "credentials" };
/**
 * The command line -> exit code. The second argument is for IN-PROCESS tests only (the command line never sets it): an AMD
 * collateral upstream instead of KDS, the roots that upstream chains to, a registry reader, a hook after the verification,
 * and the output streams.
 */
export async function main(argv, { upstream = null, roots = null, registry = null, afterVerify = null,
  io = { out: (s) => process.stdout.write(s), err: (s) => process.stderr.write(`${s}\n`) } } = {}) {
  const cmd = argv[2], flag = (n) => { const i = argv.indexOf("--" + n); return i > 0 ? argv[i + 1] : null; };
  const target = flag("target");
  if (!target) throw new Error("--target <controlUrl> is required");
  if (cmd === "status") { const r = await postJson(target + STATUS_PATH); io.out(JSON.stringify(r.body, null, 1) + "\n"); return 0; }
  if (!KIND_OF[cmd]) throw new Error("commands: genesis | recover | credentials | status");
  const { canonicalDirectConfig } = await import("../metal/guest/measured-control.mjs");
  const config = canonicalDirectConfig(JSON.parse(fs.readFileSync(flag("target-config"), "utf8")));
  if (!config.platformApi) throw new Error("the target config has no platformApi member");
  const pa = config.platformApi;
  // 1. verify the target boot BEFORE anything is sealed to it: AMD collateral from KDS through the local cache (the pinned AMD
  //    roots authenticate every entry), the group's measurements and TCB floor, and the original registry
  const { productionVerifier } = await import("../metal/guest/platform-api-verify.mjs");
  const { cachedCollateral } = await import("../verifier/collateral-cache.mjs");
  const { httpCollateral } = await import("../verifier/collateral.mjs");
  const collateral = cachedCollateral({ dir: flag("collateral-dir") || defaultCollateralDir(), upstream: upstream || httpCollateral(), ...(roots ? { roots } : {}) });
  const v = await productionVerifier({ config }, { collateral, registry, roots })({ url: target, config, measurements: pa.measurements, minTcb: pa.minTcb });
  if (!v.ok) throw new Error(`the target did not verify: ${v.reason}`);
  io.err(`[admin] target verified: operator ${v.identity.operator}, measurement ${String(v.identity.measurement).slice(0, 16)}…, boot ${v.identity.bootId}`);
  if (afterVerify) await afterVerify(v);
  // 2. the package
  let pkg;
  if (flag("package")) pkg = JSON.parse(fs.readFileSync(flag("package"), "utf8"));
  else if (cmd === "genesis") {
    const files = flag("import-dir") ? readAll(flag("import-dir")) : {};
    const out = await genesis({ platformApi: pa, targetStatementText: v.statementText, files, credentials: flag("credentials") ? JSON.parse(fs.readFileSync(flag("credentials"), "utf8")) : null });
    pkg = out.package;
    fs.writeFileSync(flag("envelope-out") || "platform-api-recovery.json", JSON.stringify(out.envelope, null, 1), { mode: 0o600 });
    io.err(`[admin] group ${pkg.groupId}: ${Object.keys(files).length} imported file(s); recovery envelope written (ciphertext to ${pa.recovery.length} recovery key(s))`);
  } else if (cmd === "recover") {
    const envelope = JSON.parse((await readMaybeUrl(flag("envelope"))).toString("utf8"));
    const priv = Buffer.from(fs.readFileSync(flag("recovery-key"), "utf8").trim(), "hex");
    pkg = (await recover({ platformApi: pa, targetStatementText: v.statementText, envelope, recoveryPrivateKey: priv, archive: await readMaybeUrl(flag("archive")) })).package;
  } else {
    pkg = buildPackage({ kind: "credentials", platformApi: pa, targetStatementText: v.statementText, credentials: JSON.parse(fs.readFileSync(flag("credentials"), "utf8")) });
  }
  // a package (also one prepared earlier) goes only to the boot just verified, of this group, for this command
  if (!pkg || pkg.kind !== KIND_OF[cmd] || pkg.groupId !== groupIdOf(pa) || pkg.targetStatementSha256 !== sha256Hex(v.statementText))
    throw new Error(`the package is not a ${KIND_OF[cmd]} package for this group and the boot just verified (boot ${v.identity.bootId}): nothing sent`);
  // 3. the admin's signature
  if (argv.includes("--print-message")) {
    fs.writeFileSync(flag("package-out") || "platform-api-package.json", JSON.stringify(pkg), { mode: 0o600 });
    io.out(packageMessage(pkg));
    return 0;
  }
  if (flag("signature")) pkg = { ...pkg, signature: flag("signature") };
  else if (flag("admin-key")) {
    const { privateKeyToAccount } = await import("viem/accounts");
    let k = fs.readFileSync(flag("admin-key"), "utf8").trim(); if (!k.startsWith("0x")) k = "0x" + k;
    pkg = await signPackage(pkg, privateKeyToAccount(k));
  } else throw new Error("sign with --admin-key FILE, or --print-message and later --package FILE --signature 0x…");
  // 4. the submission, to the attested key only; success is the verified boot's own answer
  const r = await pinnedPostJson(target + (cmd === "credentials" ? CREDENTIALS_PATH : BOOTSTRAP_PATH), pkg, v.identity.controlTlsSpkiSha256);
  const b = r.body && typeof r.body === "object" ? r.body : { body: r.body };
  io.out(JSON.stringify({ status: r.status, ...b }) + "\n");
  return r.status === 200 && b.ok === true && (cmd === "credentials" || b.groupId === pkg.groupId) ? 0 : 1;
}
if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`)
  main(process.argv).then((code) => { process.exitCode = code; }).catch((e) => { console.error(`[admin] ${e.message}`); process.exit(1); });
export { canonicalJson };
