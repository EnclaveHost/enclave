#!/usr/bin/env node
// Generate, inspect, or use the CLI release signing key.
//
//   node scripts/release-key.mjs gen [path]     create an Ed25519 private key
//   node scripts/release-key.mjs pub <path>     print the base64 to PIN in the installers
//   node scripts/release-key.mjs sign <path> <file>   write <file>.sig
//
// THE POINT OF THE KEY. Release assets and their SHA256SUMS come from the same
// release, so the checksum proves you got the bytes the release holds and
// nothing about who put them there - whoever can publish writes both files. A
// signature by a key that never enters CI is what a stolen publish token cannot
// forge.
//
// SO: THIS KEY MUST NOT LIVE IN CI. No GitHub secret, no runner, no container
// image. It belongs on a machine a release is cut from deliberately, and the
// only thing that ever leaves is the PUBLIC half, pasted into install.sh and
// install.ps1 where it is pinned rather than fetched. A key downloaded from the
// same host as the artifact proves nothing.
//
// Rotation: pin the new public key, cut one release signed by BOTH keys if you
// want a window, then drop the old pin. Installers verify against what they
// carry, so an old installer keeps trusting the old key until it is replaced -
// which is the correct behaviour, and the reason to keep the key long-lived and
// well-protected rather than rotating it casually.

import { generateKeyPairSync, createPrivateKey, createPublicKey, sign } from "node:crypto";
import { readFileSync, writeFileSync, existsSync, chmodSync } from "node:fs";

const [cmd, ...rest] = process.argv.slice(2);
const die = (m) => { console.error(m); process.exit(1); };
const pubB64 = (keyObj) =>
  createPublicKey(keyObj).export({ format: "der", type: "spki" }).subarray(-32).toString("base64");

if (cmd === "gen") {
  const out = rest[0] || "enclave-release.key";
  if (existsSync(out)) die(`refusing to overwrite ${out} - a lost release key means every installer pin is dead`);
  const { privateKey } = generateKeyPairSync("ed25519");
  writeFileSync(out, privateKey.export({ format: "pem", type: "pkcs8" }), { mode: 0o600 });
  try { chmodSync(out, 0o600); } catch {}
  console.log(`wrote ${out} (mode 0600)\n`);
  console.log("PIN THIS in cli/install.sh and cli/install.ps1 as ENCLAVE_RELEASE_PUBKEY:\n");
  console.log("  " + pubB64(privateKey) + "\n");
  console.log("Keep the private half OFF CI - back it up somewhere a release machine can reach and nothing else can.");
} else if (cmd === "pub") {
  const p = rest[0] || die("usage: release-key.mjs pub <private-key.pem>");
  console.log(pubB64(createPrivateKey(readFileSync(p, "utf8"))));
} else if (cmd === "sign") {
  const [p, file] = rest;
  if (!p || !file) die("usage: release-key.mjs sign <private-key.pem> <file>");
  const key = createPrivateKey(readFileSync(p, "utf8"));
  if (key.asymmetricKeyType !== "ed25519") die(`${p} is ${key.asymmetricKeyType}, expected ed25519`);
  const sig = sign(null, readFileSync(file), key);
  writeFileSync(`${file}.sig`, sig.toString("base64") + "\n");
  console.log(`wrote ${file}.sig (${sig.length} bytes, base64)`);
  console.log(`verify: node cli/verify-sig.mjs ${file} ${file}.sig ${pubB64(key)}`);
} else {
  die("usage: release-key.mjs gen [path] | pub <path> | sign <path> <file>");
}
