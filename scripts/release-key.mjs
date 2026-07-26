#!/usr/bin/env node
// Generate, inspect, or use the CLI release signing key.
//
//   node scripts/release-key.mjs gen [path]           create an Ed25519 private key
//   node scripts/release-key.mjs pub <path>           print the base64 public key
//   node scripts/release-key.mjs pin <path|base64>    write that key into BOTH installers
//   node scripts/release-key.mjs sign <path> <file>   write <file>.sig
//
// ORDER MATTERS, and `pin` is the step that arms everything. Once a key is
// pinned, the installers REQUIRE a SHA256SUMS.sig on whatever release they
// resolve - so pinning before a signed release exists breaks installs of every
// release already published. Do it in this order:
//   1. gen                          (key exists, nothing checks it yet)
//   2. release with ENCLAVE_RELEASE_KEY set    (that release carries a .sig)
//   3. pin                          (installers now demand what step 2 produced)
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
  console.log("public key: " + pubB64(privateKey) + "\n");
  console.log("Next, in this order:");
  console.log(`  1. keep ${out} OFF CI - a release machine can reach it, nothing else`);
  console.log(`  2. ENCLAVE_RELEASE_KEY=${out} ./scripts/release-cli.sh <tag>   (that release gets a .sig)`);
  console.log(`  3. node scripts/release-key.mjs pin ${out}                     (installers start requiring it)`);
  console.log("\nPinning first would break installs of every release published so far,");
  console.log("because the installers would demand a signature those releases do not carry.");
} else if (cmd === "pub") {
  const p = rest[0] || die("usage: release-key.mjs pub <private-key.pem>");
  console.log(pubB64(createPrivateKey(readFileSync(p, "utf8"))));
} else if (cmd === "pin") {
  // The manual-paste step this replaces was two files that MUST agree - a test
  // pins that they do, because a "verified" install path that only checks on
  // one OS is worse than an honest unverified one. Doing it by hand at the end
  // of a release is exactly when a typo lands in one and not the other.
  const arg = rest[0] || die("usage: release-key.mjs pin <private-key.pem | base64-public-key>");
  let pubB64Val;
  if (existsSync(arg)) pubB64Val = pubB64(createPrivateKey(readFileSync(arg, "utf8")));
  else if (/^[A-Za-z0-9+/]{43}=$/.test(arg.trim())) pubB64Val = arg.trim();
  else die(`"${arg}" is neither a readable key file nor a 32-byte base64 public key`);

  const edits = [
    { file: "cli/install.sh",
      find: /^(ENCLAVE_RELEASE_PUBKEY=")\$\{ENCLAVE_RELEASE_PUBKEY:-[^}]*\}(")$/m,
      to: (k) => `ENCLAVE_RELEASE_PUBKEY="\${ENCLAVE_RELEASE_PUBKEY:-${k}}"`,
      read: (t) => (/^ENCLAVE_RELEASE_PUBKEY="\$\{ENCLAVE_RELEASE_PUBKEY:-([^}]*)\}"$/m.exec(t) || [])[1] },
    { file: "cli/install.ps1",
      find: /^(\$EnclaveReleasePubKey = ")[^"]*(")$/m,
      to: (k) => `$EnclaveReleasePubKey = "${k}"`,
      read: (t) => (/^\$EnclaveReleasePubKey = "([^"]*)"$/m.exec(t) || [])[1] },
  ];
  // --root lets the tests pin COPIES. A test that edits the real installers is
  // one crash away from leaving a bogus key pinned in tracked files, and a
  // bogus pin committed means every installer in the wild demands a signature
  // by a key that exists in someone's temp dir. (That is not hypothetical: the
  // first version of that test did exactly this, and its restore-on-exit
  // "recovered" by writing the leaked pin back.)
  const rootFlag = rest.indexOf("--root");
  const root = rootFlag >= 0 && rest[rootFlag + 1]
    ? rest[rootFlag + 1].replace(/\/*$/, "") + "/"
    : new URL("..", import.meta.url).pathname;
  for (const e of edits) {
    const path = root + e.file;
    const before = readFileSync(path, "utf8");
    if (!e.find.test(before)) die(`${e.file}: could not find the pin line - has it been edited by hand?`);
    const after = before.replace(e.find, e.to(pubB64Val));
    writeFileSync(path, after);
    // read it BACK: a regex that silently matched nothing would leave the
    // installers unpinned while this script claimed success, and release-cli.sh
    // would then cheerfully ship unsigned
    const got = e.read(readFileSync(path, "utf8"));
    if (got !== pubB64Val) die(`${e.file}: pin did not take (read back ${JSON.stringify(got)})`);
    console.log(`pinned in ${e.file}`);
  }
  console.log(`\npublic key: ${pubB64Val}\n`);
  console.log("Both installers now REQUIRE a SHA256SUMS.sig by this key. Make sure the");
  console.log("release they resolve actually has one - cut a signed release BEFORE pinning,");
  console.log("or installs of the current latest release will refuse to build.");
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
  die("usage: release-key.mjs gen [path] | pub <path> | pin <path|base64> | sign <path> <file>");
}
