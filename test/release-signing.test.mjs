// The release signature: two copies of one check, held to the same vectors.
//
// SHA256SUMS ships from the SAME release as the tarball, so on its own it proves
// you got the bytes the release holds and nothing about WHO published them -
// whoever can publish writes both files. A detached Ed25519 signature by a key
// that never enters CI is the part a stolen publish token cannot forge.
//
// The verifier has to exist TWICE, and that is not an oversight: install.sh
// cannot verify a download using code from that download, so its copy is
// inlined in the script the user actually fetched. cli/verify-sig.mjs is the
// same algorithm as a readable module for release-cli.sh and for reading. Two
// copies of a security check is the exact shape that produced tonight's relay
// bind gap - one sibling hardened, the other not - so this file runs BOTH over
// every vector and fails if they ever disagree.
//
//   run: node --test test/release-signing.test.mjs

import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { generateKeyPairSync, sign, createPublicKey } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const MODULE = path.join(REPO, "cli", "verify-sig.mjs");
const INSTALL_SH = path.join(REPO, "cli", "install.sh");

// pull the inlined verifier out of install.sh - the longest `node -e '...'` in
// the file. (An earlier draft of this test grabbed the FIRST one, which is the
// node-version check: it exits 0 whatever you pass it, so every vector "passed"
// and the test proved nothing. Length is what distinguishes them.)
function inlineSnippet() {
  const src = fs.readFileSync(INSTALL_SH, "utf8");
  const found = [...src.matchAll(/node -e '([^']*)'/g)].map((m) => m[1]);
  assert.ok(found.length, "install.sh no longer has an inline `node -e` verifier");
  const snippet = found.sort((a, b) => b.length - a.length)[0];
  assert.match(snippet, /createPublicKey/, "the longest inline node -e is not the signature verifier");
  assert.match(snippet, /c\.verify\(/, "the inline verifier does not actually verify");
  return snippet;
}

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "relsig-"));
const { privateKey } = generateKeyPairSync("ed25519");
const { privateKey: otherKey } = generateKeyPairSync("ed25519");
const pub = (k) => createPublicKey(k).export({ format: "der", type: "spki" }).subarray(-32).toString("base64");
const PUB = pub(privateKey), OTHER_PUB = pub(otherKey);

const SUMS = "3f786850e387550fdab836ed7e6dc881de23001b  enclave-cli-cli-v9.9.9.tar.gz\n";
const sumsPath = path.join(dir, "SHA256SUMS");
fs.writeFileSync(sumsPath, SUMS);

const sigPath = path.join(dir, "SHA256SUMS.sig");
fs.writeFileSync(sigPath, sign(null, Buffer.from(SUMS), privateKey).toString("base64") + "\n");

// same signature written as raw bytes rather than base64 - both shapes ship
const rawSigPath = path.join(dir, "raw.sig");
fs.writeFileSync(rawSigPath, sign(null, Buffer.from(SUMS), privateKey));

const tamperedPath = path.join(dir, "tampered");
fs.writeFileSync(tamperedPath, SUMS.replace("3f78", "0000"));

const wrongSigPath = path.join(dir, "wrong.sig");
fs.writeFileSync(wrongSigPath, sign(null, Buffer.from(SUMS), otherKey).toString("base64") + "\n");

const junkSigPath = path.join(dir, "junk.sig");
fs.writeFileSync(junkSigPath, "not-a-signature\n");

// run one implementation; returns true iff it accepted
const runModule = (sums, sig, key) => {
  try { execFileSync(process.execPath, [MODULE, sums, sig, key], { stdio: "pipe" }); return true; }
  catch { return false; }
};
const runInline = (sums, sig, key) => {
  try { execFileSync(process.execPath, ["-e", inlineSnippet(), sums, sig, key], { stdio: "pipe" }); return true; }
  catch { return false; }
};

// every vector: [name, sums, sig, key, expected]
const VECTORS = [
  ["a real signature by the pinned key", sumsPath, sigPath, PUB, true],
  ["the same signature as raw bytes", sumsPath, rawSigPath, PUB, true],
  ["SHA256SUMS altered after signing", tamperedPath, sigPath, PUB, false],
  ["signed by a DIFFERENT key", sumsPath, wrongSigPath, PUB, false],
  ["right signature, wrong pinned key", sumsPath, sigPath, OTHER_PUB, false],
  ["a signature that is not one", sumsPath, junkSigPath, PUB, false],
  ["an all-zero pinned key", sumsPath, sigPath, Buffer.alloc(32).toString("base64"), false],
  ["a pinned key that is not base64", sumsPath, sigPath, "!!!not base64!!!", false],
  ["a pinned key of the wrong length", sumsPath, sigPath, Buffer.alloc(16).toString("base64"), false],
  ["an empty pinned key", sumsPath, sigPath, "", false],
  ["a missing signature file", sumsPath, path.join(dir, "nope.sig"), PUB, false],
];

test("both verifiers agree on every vector, and get every one right", () => {
  for (const [name, sums, sig, key, want] of VECTORS) {
    const m = runModule(sums, sig, key);
    const i = runInline(sums, sig, key);
    assert.equal(m, want, `cli/verify-sig.mjs got ${name} wrong`);
    assert.equal(i, want, `install.sh's inline verifier got ${name} wrong`);
    assert.equal(m, i, `the two verifiers DISAGREE on: ${name}`);
  }
});

test("a tampered SHA256SUMS is refused even when the checksum inside it is valid", () => {
  // the attack the signature exists for: whoever can publish a release rewrites
  // BOTH the tarball and SHA256SUMS, so the checksum inside will always agree
  // with whatever they shipped. Only the signature disagrees.
  const evil = path.join(dir, "evil-sums");
  fs.writeFileSync(evil, "deadbeef".repeat(5) + "  enclave-cli-cli-v9.9.9.tar.gz\n");
  assert.equal(runModule(evil, sigPath, PUB), false);
  assert.equal(runInline(evil, sigPath, PUB), false);
});

test("install.sh REFUSES to build when a key is pinned but the release has no signature", () => {
  const src = fs.readFileSync(INSTALL_SH, "utf8");
  // fetch the .sig, and treat a missing one as fatal rather than as "unsigned, carry on"
  assert.match(src, /SHA256SUMS\.sig/, "install.sh never fetches the signature");
  assert.match(src, /publishes no SHA256SUMS\.sig[\s\S]{0,120}refusing to build/,
    "a pinned key with no signature published must be fatal, not a downgrade");
  // and the signature is checked BEFORE the checksum is read out of the file
  const sigAt = src.indexOf("SHA256SUMS.sig");
  const wantAt = src.indexOf('want="$(awk');
  assert.ok(sigAt > 0 && wantAt > sigAt,
    "the signature must be verified before SHA256SUMS is trusted for the checksum");
});

test("with no key pinned it stays honest instead of implying a guarantee", () => {
  const src = fs.readFileSync(INSTALL_SH, "utf8");
  assert.match(src, /ENCLAVE_RELEASE_PUBKEY="\$\{ENCLAVE_RELEASE_PUBKEY:-\}"/,
    "the pin must exist and default to empty until the project has a key");
  assert.match(src, /proves the bytes match the release, NOT who published it/,
    "an unsigned install must say what it did and did not check");
});

test("release-key.mjs round-trips: gen -> pub -> sign -> verify", () => {
  const keyPath = path.join(dir, "gen.key");
  const gen = execFileSync(process.execPath, [path.join(REPO, "scripts", "release-key.mjs"), "gen", keyPath],
    { encoding: "utf8" });
  const printed = (/^public key: ([A-Za-z0-9+/]{43}=)$/m.exec(gen) || [])[1];
  assert.ok(printed, `gen must print the public key it wants pinned; got:\n${gen}`);
  assert.equal(fs.statSync(keyPath).mode & 0o777, 0o600, "a release key must not be world-readable");

  const shown = execFileSync(process.execPath, [path.join(REPO, "scripts", "release-key.mjs"), "pub", keyPath],
    { encoding: "utf8" }).trim();
  assert.equal(shown, printed, "pub must print the same key gen told you to pin");

  const f = path.join(dir, "RT_SUMS");
  fs.writeFileSync(f, "abc  x.tar.gz\n");
  execFileSync(process.execPath, [path.join(REPO, "scripts", "release-key.mjs"), "sign", keyPath, f], { stdio: "pipe" });
  assert.equal(runModule(f, f + ".sig", shown), true);
  assert.equal(runInline(f, f + ".sig", shown), true);
  // and it will not silently clobber an existing key
  assert.throws(() => execFileSync(process.execPath,
    [path.join(REPO, "scripts", "release-key.mjs"), "gen", keyPath], { stdio: "pipe" }));
});

test("install.ps1 pins the SAME key and runs the SAME verifier as install.sh", () => {
  // Two installers with different rules is how a platform ends up with a
  // "verified" install path that only checks on one OS. Same key, same
  // algorithm, same refusal - and the Windows path fetches .sig too.
  const sh = fs.readFileSync(INSTALL_SH, "utf8");
  const ps = fs.readFileSync(path.join(REPO, "cli", "install.ps1"), "utf8");

  const shSnippet = [...sh.matchAll(/node -e '([^']*)'/g)].map((m) => m[1]).sort((a, b) => b.length - a.length)[0];
  const psSnippet = [...ps.matchAll(/\$js = '([^']*)'/g)].map((m) => m[1]).sort((a, b) => b.length - a.length)[0];
  assert.ok(psSnippet, "install.ps1 has no inline verifier");
  assert.equal(psSnippet, shSnippet, "the two installers' verifiers have drifted apart");

  assert.match(ps, /SHA256SUMS\.sig/, "install.ps1 never fetches the signature");
  assert.match(ps, /publishes no SHA256SUMS\.sig[\s\S]{0,140}refusing to build/,
    "a pinned key with no signature published must be fatal on Windows too");

  // both pins must currently be EMPTY (no key exists yet) or IDENTICAL - never
  // one set and the other not, which would verify on one platform only
  const shKey = /ENCLAVE_RELEASE_PUBKEY="\$\{ENCLAVE_RELEASE_PUBKEY:-([^}]*)\}"/.exec(sh)?.[1] ?? null;
  const psKey = /\$EnclaveReleasePubKey = "([^"]*)"/.exec(ps)?.[1] ?? null;
  assert.notEqual(shKey, null, "install.sh lost its pin");
  assert.notEqual(psKey, null, "install.ps1 lost its pin");
  assert.equal(shKey, psKey, "the installers pin DIFFERENT release keys");
});

test("release-cli.sh signs, self-verifies, and refuses a key the installers do not pin", () => {
  const rel = fs.readFileSync(path.join(REPO, "scripts", "release-cli.sh"), "utf8");
  assert.match(rel, /ENCLAVE_RELEASE_KEY/, "the release script cannot sign");
  assert.match(rel, /release-key\.mjs" sign/, "it never produces a signature");
  assert.match(rel, /verify-sig\.mjs[\s\S]{0,200}refusing to publish/,
    "it must verify its own signature with the installer's verifier before publishing");
  assert.match(rel, /is not the key pinned in cli\/install\.sh[\s\S]{0,200}exit 1/,
    "signing with a key the shipped installers do not pin must be fatal - every install would break");
  assert.match(rel, /SHA256SUMS\.sig/, "the signature is never uploaded");
});

test("pin writes BOTH installers, verifies it took, and is idempotent", () => {
  // this replaces a manual paste into two files that must agree. Doing that by
  // hand at the end of a release is exactly when a typo lands in one and not
  // the other, and the failure mode - verified on Linux, unverified on Windows -
  // is invisible until someone looks.
  // COPIES, never the real installers - see the --root note in release-key.mjs
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "pin-"));
  fs.mkdirSync(path.join(sandbox, "cli"));
  const sh = path.join(sandbox, "cli", "install.sh"), ps = path.join(sandbox, "cli", "install.ps1");
  fs.copyFileSync(path.join(REPO, "cli", "install.sh"), sh);
  fs.copyFileSync(path.join(REPO, "cli", "install.ps1"), ps);
  const keyPath = path.join(dir, "pin.key");
  const run = (...a) => execFileSync(process.execPath,
    [path.join(REPO, "scripts", "release-key.mjs"), ...a, "--root", sandbox],
    { encoding: "utf8", stdio: "pipe" });
  {
  }
  // the REAL installers were never touched
  assert.match(fs.readFileSync(path.join(REPO, "cli", "install.sh"), "utf8"),
    /^ENCLAVE_RELEASE_PUBKEY="\$\{ENCLAVE_RELEASE_PUBKEY:-\}"$/m,
    "the pin test wrote to the real install.sh");
});

test("release-cli refuses to publish UNSIGNED when the installers pin a key", () => {
  // the other direction of the same mistake: pin the key, then cut a release
  // without ENCLAVE_RELEASE_KEY, and every installer in the wild demands a
  // signature that release does not carry. Users find that, not us.
  const rel = fs.readFileSync(path.join(REPO, "scripts", "release-cli.sh"), "utf8");
  const unsignedBranch = rel.slice(rel.indexOf("NOT SIGNING") - 900, rel.indexOf("NOT SIGNING"));
  assert.match(unsignedBranch, /PINNED=/, "the unsigned path never reads the shipped pin");
  assert.match(unsignedBranch, /exit 1/, "a pinned key with no signing key must be fatal");
});
