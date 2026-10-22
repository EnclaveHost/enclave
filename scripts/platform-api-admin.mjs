#!/usr/bin/env node
// scripts/platform-api-admin.mjs -- the Enclave admin's tool for the platform API role (docs/network/hosted-platform-api.md).
// Every package it makes is SIGNED by an admin wallet the group's bound config names (platformApi.admins) and SEALED to one
// attested boot. Before sealing anything it verifies that boot (metal/guest/platform-api-verify.mjs: verifyMeasuredControl
// against the group's measurements, HOST_DATA-bound config and the original registry). It never prints the state key,
// state or credentials.
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
//   status       --target <controlUrl>
// --print-message writes the exact text to sign (EIP-191 personal_sign) and the unsigned package to --package-out; re-run
// with --package FILE --signature 0x… to send it. A hardware wallet signs; this tool never needs the admin's key on disk.
import fs from "node:fs";
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
const readMaybeUrl = async (v) => (/^https?:/.test(v) ? Buffer.from(await (await fetch(v)).arrayBuffer()) : fs.readFileSync(v));
async function main(argv) {
  const cmd = argv[2], flag = (n) => { const i = argv.indexOf("--" + n); return i > 0 ? argv[i + 1] : null; };
  const target = flag("target");
  if (!target) throw new Error("--target <controlUrl> is required");
  if (cmd === "status") { const r = await postJson(target + STATUS_PATH); console.log(JSON.stringify(r.body, null, 1)); return; }
  const { canonicalDirectConfig } = await import("../metal/guest/measured-control.mjs");
  const config = canonicalDirectConfig(JSON.parse(fs.readFileSync(flag("target-config"), "utf8")));
  if (!config.platformApi) throw new Error("the target config has no platformApi member");
  const pa = config.platformApi;
  // 1. verify the target boot BEFORE anything is sealed to it
  const { productionVerifier } = await import("../metal/guest/platform-api-verify.mjs");
  const v = await productionVerifier({ config })({ url: target, config, measurements: pa.measurements, minTcb: pa.minTcb });
  if (!v.ok) throw new Error(`the target did not verify: ${v.reason}`);
  console.error(`[admin] target verified: operator ${v.identity.operator}, measurement ${String(v.identity.measurement).slice(0, 16)}…, boot ${v.identity.bootId}`);
  // 2. the package
  let pkg;
  if (flag("package")) pkg = JSON.parse(fs.readFileSync(flag("package"), "utf8"));
  else if (cmd === "genesis") {
    const files = flag("import-dir") ? readAll(flag("import-dir")) : {};
    const out = await genesis({ platformApi: pa, targetStatementText: v.statementText, files, credentials: flag("credentials") ? JSON.parse(fs.readFileSync(flag("credentials"), "utf8")) : null });
    pkg = out.package;
    fs.writeFileSync(flag("envelope-out") || "platform-api-recovery.json", JSON.stringify(out.envelope, null, 1), { mode: 0o600 });
    console.error(`[admin] group ${pkg.groupId}: ${Object.keys(files).length} imported file(s); recovery envelope written (ciphertext to ${pa.recovery.length} recovery key(s))`);
  } else if (cmd === "recover") {
    const envelope = JSON.parse((await readMaybeUrl(flag("envelope"))).toString("utf8"));
    const priv = Buffer.from(fs.readFileSync(flag("recovery-key"), "utf8").trim(), "hex");
    pkg = (await recover({ platformApi: pa, targetStatementText: v.statementText, envelope, recoveryPrivateKey: priv, archive: await readMaybeUrl(flag("archive")) })).package;
  } else if (cmd === "credentials") {
    pkg = buildPackage({ kind: "credentials", platformApi: pa, targetStatementText: v.statementText, credentials: JSON.parse(fs.readFileSync(flag("credentials"), "utf8")) });
  } else throw new Error("commands: genesis | recover | credentials | status");
  // 3. the admin's signature
  if (argv.includes("--print-message")) {
    fs.writeFileSync(flag("package-out") || "platform-api-package.json", JSON.stringify(pkg), { mode: 0o600 });
    process.stdout.write(packageMessage(pkg));
    return;
  }
  if (flag("signature")) pkg = { ...pkg, signature: flag("signature") };
  else if (flag("admin-key")) {
    const { privateKeyToAccount } = await import("viem/accounts");
    let k = fs.readFileSync(flag("admin-key"), "utf8").trim(); if (!k.startsWith("0x")) k = "0x" + k;
    pkg = await signPackage(pkg, privateKeyToAccount(k));
  } else throw new Error("sign with --admin-key FILE, or --print-message and later --package FILE --signature 0x…");
  const r = await postJson(target + (cmd === "credentials" ? CREDENTIALS_PATH : BOOTSTRAP_PATH), pkg);
  console.log(JSON.stringify({ status: r.status, ...(typeof r.body === "object" ? r.body : { body: r.body }) }));
  if (r.status !== 200) process.exitCode = 1;
}
if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) main(process.argv).catch((e) => { console.error(`[admin] ${e.message}`); process.exit(1); });
export { canonicalJson };
