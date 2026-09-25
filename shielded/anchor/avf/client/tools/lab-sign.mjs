#!/usr/bin/env node
// lab-sign.mjs -- LAB signing for the pVM client's policy and update manifests (client/DESIGN.md). NOT a release
// process: the keys it makes are lab test keys, kept in a directory OUTSIDE the repository (0700, files 0600), never
// committed; production policy and release keys (and a Sigstore-based manifest) are the owner's, not built here.
//   lab-sign.mjs keygen --keys DIR --name policy|release           -> DIR/<name>.key (PKCS#8 PEM), prints the fingerprint
//   lab-sign.mjs policy --keys DIR --body FILE [--out FILE]         -> { policy: base64(exact bytes), sig }, written ONLY if
//                                                                      the client's own verifyPolicy accepts it (below)
//   lab-sign.mjs update --keys DIR --artifact FILE --version V --source-commit C --not-after ISO [--artifact-name N] [--out FILE]
// A policy body's "key" is filled in from DIR/policy.key; an update's releaseKey and policyKey from DIR/release.key and
// DIR/policy.key (both sign: release, then the policy countersignature).
import fs from "node:fs";
import path from "node:path";
import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, sign } from "node:crypto";
import { verifyPolicy } from "../src/trust.js";

const argv = process.argv.slice(2), cmd = argv[0];
const arg = (k, d = null) => { const i = argv.indexOf(k); return i > 0 ? argv[i + 1] : d; };
const keysDir = arg("--keys");
if (!keysDir) { console.error("--keys DIR (outside the repository) is required"); process.exit(2); }
if (path.resolve(keysDir).startsWith(path.resolve(new URL("../../../../..", import.meta.url).pathname))) { console.error("refusing: the keys directory is inside the repository"); process.exit(2); }
const load = (n) => createPrivateKey(fs.readFileSync(path.join(keysDir, `${n}.key`)));
const pubHex = (k) => createPublicKey(k).export({ type: "spki", format: "der" }).subarray(12).toString("hex");
const fp = (hex) => createHash("sha256").update(Buffer.from(hex, "hex")).digest("hex");
const edsig = (k, domain, text) => sign(null, Buffer.concat([Buffer.from(domain), Buffer.from(text)]), k).toString("hex");
const emit = (o) => { const s = JSON.stringify(o) + "\n"; if (arg("--out")) fs.writeFileSync(arg("--out"), s); else process.stdout.write(s); };

if (cmd === "keygen") {
  const n = arg("--name"); if (!/^(policy|release)$/.test(n || "")) { console.error("--name policy|release"); process.exit(2); }
  fs.mkdirSync(keysDir, { recursive: true, mode: 0o700 });
  const f = path.join(keysDir, `${n}.key`);
  if (fs.existsSync(f)) { console.error(`${f} exists: not overwritten`); process.exit(2); }
  const { privateKey } = generateKeyPairSync("ed25519");
  fs.writeFileSync(f, privateKey.export({ type: "pkcs8", format: "pem" }), { mode: 0o600 });
  console.log(JSON.stringify({ name: n, key: pubHex(privateKey), fingerprint: fp(pubHex(privateKey)), lab: "LAB TEST KEY, not a release key" }));
} else if (cmd === "policy") {
  const k = load("policy");
  const body = { ...JSON.parse(fs.readFileSync(arg("--body"), "utf8")), key: pubHex(k) };
  const text = JSON.stringify(body);
  const env = { policy: Buffer.from(text).toString("base64"), sig: edsig(k, "enclave-pvm-client-policy-v1\n", text) };
  // the signer checks what it signs with the CLIENT's own rules (a client anchored on this key, below the serial, now):
  // a policy every client would refuse -- a malformed deployment table, an unknown format, an expired window -- is an
  // outage for everyone on this key, so it is never written
  const v = await verifyPolicy(env, { state: { policyFp: fp(pubHex(k)), nextPolicyFp: null, serial: 1, digest: null }, clientVersion: "999.0.0" });
  if (!v.ok) { console.error(`refusing to write a policy the client would refuse: ${v.reasons[0]}`); process.exit(2); }
  emit(env);
} else if (cmd === "update") {
  const r = load("release"), p = load("policy"), bytes = fs.readFileSync(arg("--artifact"));
  const body = { type: "enclave-pvm-client-update", artifact: arg("--artifact-name", "pvm-client.mjs"), version: arg("--version"),
                 artifactSha256: createHash("sha256").update(bytes).digest("hex"), size: bytes.length, sourceCommit: arg("--source-commit"),
                 notAfter: arg("--not-after"), releaseKey: pubHex(r), policyKey: pubHex(p), nextReleaseKey: null };
  const text = JSON.stringify(body);
  emit({ manifest: Buffer.from(text).toString("base64"), releaseSig: edsig(r, "enclave-pvm-client-update-v1\n", text),
         policySig: edsig(p, "enclave-pvm-client-update-countersign-v1\n", text) });
} else { console.error("keygen | policy | update"); process.exit(2); }
