// Verify the detached Ed25519 signature over a release's SHA256SUMS.
//
//   node verify-sig.mjs <SHA256SUMS> <SHA256SUMS.sig> <pubkey-base64>
//   exit 0 = the signature is by the pinned key over exactly these bytes
//
// WHY THIS EXISTS. SHA256SUMS ships from the SAME release as the tarball, so on
// its own it proves you got the bytes the release holds - transport corruption,
// a lying mirror, a truncated download - and nothing about WHO published them.
// Whoever can publish a release writes both files. A signature by a key that
// never touches CI is the part a stolen token cannot forge.
//
// WHY NODE. The installer already requires node >= 20 before it does anything,
// so this adds no dependency, and Node's Ed25519 is the same everywhere. openssl
// would have been the obvious choice except macOS ships LibreSSL, whose raw
// Ed25519 support varies - a verification step that is skipped on some platforms
// is worse than none, because it reads as covered.
//
// The key is pinned in install.sh / install.ps1, NOT fetched. A key downloaded
// from the same host as the artifact proves nothing.

import { readFileSync } from "node:fs";
import { verify, createPublicKey } from "node:crypto";

const [sumsPath, sigPath, pubB64] = process.argv.slice(2);
const die = (m) => { console.error(`signature check FAILED: ${m}`); process.exit(1); };

if (!sumsPath || !sigPath || !pubB64) die("usage: verify-sig.mjs <SHA256SUMS> <SHA256SUMS.sig> <pubkey-base64>");

let raw;
try { raw = Buffer.from(pubB64.trim(), "base64"); } catch { die("pinned public key is not base64"); }
// 32 raw bytes = an Ed25519 public key; anything else is a DER/SPKI blob, which
// we accept too so the pin can be pasted in either shape
let key;
try {
  key = raw.length === 32
    ? createPublicKey({ key: Buffer.concat([Buffer.from("302a300506032b6570032100", "hex"), raw]), format: "der", type: "spki" })
    : createPublicKey({ key: raw, format: "der", type: "spki" });
} catch (e) { die(`pinned public key is not a usable Ed25519 key (${e.message})`); }
if (key.asymmetricKeyType !== "ed25519") die(`pinned key is ${key.asymmetricKeyType}, expected ed25519`);

let sums, sig;
try { sums = readFileSync(sumsPath); } catch (e) { die(`cannot read ${sumsPath}: ${e.message}`); }
try {
  const t = readFileSync(sigPath);
  // accept raw 64 bytes or base64 text, so the release can carry either
  sig = t.length === 64 ? t : Buffer.from(t.toString("utf8").trim(), "base64");
} catch (e) { die(`cannot read ${sigPath}: ${e.message}`); }
if (sig.length !== 64) die(`signature is ${sig.length} bytes, expected 64`);

// verify over the EXACT bytes of the file - no trimming, no re-serialising.
// The checksum line the installer then greps out comes from these same bytes.
if (!verify(null, sums, key, sig)) die("SHA256SUMS is not signed by the pinned release key");
process.exit(0);
