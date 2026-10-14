// The genuine AMD Genoa report the SNP suites run on (test/fixtures/verifier/genoa-tinfoil/: captured 2026-09-24 from a
// public host's attestation document, with its VCEK from AMD KDS; see that set's SOURCES entries). The host's own document
// format is no longer one this verifier judges, so the report is presented here as a sev-snp-guest-domain-v1 document under
// ABI/2, whose binding is CALLER-supplied bytes: the context names the report's own report_data[0:32] as the expected
// binding and report_data[32:64] as the app id. That makes the binding check pass by construction, which is the point: these
// suites exercise what is genuine about the report (the PSP signature, the VCEK -> ASK -> pinned ARK chain, the CRL, the TCB,
// the policy bits, every single-field forgery). The binding rules themselves are tested on evidence produced FOR this
// verifier (test/verifier-snp-turin.test.mjs, test/verifier-metal-box.test.mjs, test/verifier-linux-canary.test.mjs).
import fs from "node:fs";
import { gunzipSync } from "node:zlib";
import { X509Certificate } from "node:crypto";

const F = new URL("../fixtures/verifier/", import.meta.url), A = new URL("../fixtures/amd/", import.meta.url);
const read = (u) => fs.readFileSync(u), text = (u) => fs.readFileSync(u, "utf8");
const captured = JSON.parse(text(new URL("genoa-tinfoil/rad.json", F)));
export const report = gunzipSync(Buffer.from(captured.body, "base64"));
export const MEAS = report.subarray(0x90, 0xc0).toString("hex");
export const BINDING = Buffer.from(report.subarray(0x50, 0x70)), APP_ID = Buffer.from(report.subarray(0x70, 0x90));
// any well-formed SPKI: under ABI/2 the key is inside the caller's binding, not hashed here (the served certificate's key)
export const certPem = text(new URL("genoa-tinfoil/tls-cert.pem", F));
export const spki = new X509Certificate(certPem).publicKey.export({ type: "spki", format: "der" });
export const docWith = (r) => ({ format: "sev-snp-guest-domain-v1", report: Buffer.from(r).toString("base64"), abi: "enclave-domain-abi/2" });
export const doc = docWith(report);
export const context = (over = {}) => ({ transportKeySpki: spki, expectedBinding: BINDING, expectedAppId: APP_ID, now: "2026-09-24T05:00:00Z", ...over });
export const chains = { Genoa: text(new URL("Genoa-cert_chain.pem", A)), Milan: text(new URL("Milan-cert_chain.pem", A)), Turin: text(new URL("Turin-cert_chain.pem", A)) };
export const vcekAmd = read(new URL("genoa-tinfoil/vcek-kds-amd.der", F)), vcekProxy = read(new URL("genoa-tinfoil/vcek-kds-proxy-tinfoil.der", F));
export const crl = read(new URL("amd/Genoa-crl.der", F));
export const FLOOR = { Genoa: { bootloader: 10, tee: 0, snp: 23, microcode: 84 } };   // the part's own TCB: an admission-safe run needs a floor
