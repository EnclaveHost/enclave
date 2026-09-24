// judge-run.mjs <evidence.json> -- the verdict on one run's attestation document, by the package's pinned judge
// (control/windows/vbslike/verify/judge-hv.mjs, enclave-d1's, with its imports laid out as in the repository).
// smoke-hcs.ps1 writes the evidence: the document it fetched for ITS nonce, the certificate of THAT TLS session, and
// the launcher's own words (its key, the partition's vmId, the image it booted). The SPKI is taken from the
// certificate the handshake saw, never from the document. Prints one JSON line; exit 0 only for monitor-signed, which
// on this tier (T0-hv) is the best there is: signed by a launcher in the root partition, host NOT excluded.
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const { judge } = await import(pathToFileURL(path.join(HERE, "../control/windows/vbslike/verify/judge-hv.mjs")).href);

let out;
try {
  const e = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
  const spki = new crypto.X509Certificate(Buffer.from(e.certB64, "base64")).publicKey.export({ type: "spki", format: "der" });
  if (!/^[0-9a-f]{64}$/.test(e.nonceHex || "")) throw new Error("the evidence has no 32-byte nonce");
  // the document and the runtime identity arrive as the exact text received / pinned, parsed only here
  const doc = JSON.parse(e.docRaw), expectRuntime = JSON.parse(e.runtimeRaw);
  const r = judge({ doc, spki, nonce: Buffer.from(e.nonceHex, "hex"), expectedAppSha256: e.expectedAppSha256,
                    launcherKey: e.launcherKey, expectedVmId: e.expectedVmId, expectedImageSha256: e.expectedImageSha256,
                    expectRuntime });
  out = { verdict: r.verdict, reasons: r.reasons, spkiSha256: crypto.createHash("sha256").update(spki).digest("hex"), checks: r.checks };
} catch (err) {
  out = { verdict: "reject", reasons: [`judge-run: ${err.message}`] };
}
console.log(JSON.stringify(out));
process.exitCode = out.verdict === "monitor-signed" ? 0 : 1;
