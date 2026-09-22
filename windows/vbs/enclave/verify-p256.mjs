// Independent check of the ES256 key-custody spike (p256kern.h says what it is for).
//
//   ssh minipc-zt 'cmd /c C:\Users\claude\vbs\raw\p256-build.cmd' | tail -1 > spike.json
//   node verify-p256.mjs spike.json
//
// The question is whether a signature made INSIDE VTL1 verifies out here, against a public key
// that also came from inside, over a digest this side chose. @noble/curves is the second
// implementation, and it is the right one rather than node:crypto: node's `verify(null, data, …)`
// HASHES data with SHA-256 for an EC key, so passing a digest to it checks a signature over
// sha256(digest) and reports a perfectly good signature as invalid. (It did, and the enclave was
// not at fault.) p256.verify takes the message hash directly, which is what an ES256 signer signs.
import { p256 } from "@noble/curves/nist";
import fs from "node:fs";

const j = JSON.parse(fs.readFileSync(process.argv[2], "utf8").trim().split("\n").pop());
const b = (h) => Buffer.from(h, "hex");
const sec1 = (xy) => Buffer.concat([Buffer.from([4]), b(xy)]);   // X||Y -> uncompressed point
const ok = (pub, digest, sig) => p256.verify(b(sig), b(digest), sec1(pub));

const r = {
  enclaveReportedOk: j.ok === true && j.step === 0,
  firstSignature: ok(j.pub, j.digest, j.sig),
  secondSignature: ok(j.pub2, j.digest2, j.sig2),
  // A per-boot session key must survive between calls, or every token minted before the last
  // signature stops verifying.
  keyIsPerEnclaveNotPerCall: j.pub === j.pub2 && j.reused[0] === 0 && j.reused[1] === 1,
  // …and the checks above mean nothing unless a signature fails for the digest it was not made for.
  wrongDigestRejected: !ok(j.pub, j.digest2, j.sig),
  crossSignatureRejected: !ok(j.pub, j.digest, j.sig2),
  // R||S, 64 bytes: exactly what an ES256 JWT carries, so this key could sign session tokens with
  // no re-encoding at all.
  signatureIsP1363: b(j.sig).length === 64 && b(j.sig2).length === 64,
  publicBlobLen: j.pubLen,
  mintAndSignMs: j.mintAndSignMs,
  signMs: j.signMs,
  // Recorded, not asserted: the enclave CAN export its own private half (0x00000000 = success).
  // The claim is that nothing crosses the gate - the request struct has no field for it - not that
  // the platform would refuse. Worth knowing, and worth not overstating.
  privateExportInsideEnclave: j.privExport,
};
console.log(JSON.stringify(r, null, 1));
const bools = Object.entries(r).filter(([, v]) => typeof v === "boolean");
process.exit(bools.every(([, v]) => v) ? 0 : 1);
