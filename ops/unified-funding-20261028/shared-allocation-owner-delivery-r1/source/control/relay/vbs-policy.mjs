// relay/vbs-policy.mjs — the relay's admission policy for Windows VBS-enclave
// nodes (tunnel mode "vbs"), from the environment. EVIDENCE.md "Policy":
//   METAL_VBS_ENCLAVE_MEASUREMENTS  comma list of allowed sha256(FamilyId||ImageId||AuthorId)
//                                   hex; EMPTY = vbs attach off (this returns null)
//   METAL_VBS_MIN_SVN               default 1
//   METAL_VBS_PCR0                  comma list of allowed PCR 0 values (one per firmware
//                                   version); PCR 0 is pinned, never replayed (REPORT.md 3)
//   METAL_VBS_EK_ROOTS              PEM bundle of pinned TPM roots (+ their intermediates);
//                                   default relay/fixtures/tpm-roots.pem = AMD's fTPM chain
//   METAL_VBS_ALLOW_TESTSIGNING=1   admit TESTSIGNING=1 logs, Secure Boot off, debuggable
//                                   enclaves and unpinned PCR 0 as tier "vbs-dev". Never on
//                                   the hosted relay outside a lab window.
// Sibling of avf-policy.mjs. Malformed values throw: a relay with a broken VBS
// policy must fail to start, not silently admit or silently refuse.
import fs from "node:fs";
import { fileURLToPath } from "node:url";

export const VBS_DEFAULT_EK_ROOTS = fileURLToPath(new URL("./fixtures/tpm-roots.pem", import.meta.url));

export function vbsPolicyFromEnv(env = {}, { readFile = (p) => fs.readFileSync(p, "utf8") } = {}) {
  const list = (key) => String(env[key] || "").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
  const hex64 = (key, xs) => { for (const x of xs) if (!/^[0-9a-f]{64}$/.test(x)) throw new Error(`${key}: "${x}" is not 32 bytes of hex`); return xs; };
  const measurements = hex64("METAL_VBS_ENCLAVE_MEASUREMENTS", list("METAL_VBS_ENCLAVE_MEASUREMENTS"));
  if (!measurements.length) return null;
  const svnRaw = String(env.METAL_VBS_MIN_SVN ?? "").trim();
  const minSvn = svnRaw === "" ? 1 : Number(svnRaw);
  if (!Number.isInteger(minSvn) || minSvn < 0) throw new Error(`METAL_VBS_MIN_SVN: "${svnRaw}" is not a non-negative integer`);
  const pcr0 = hex64("METAL_VBS_PCR0", list("METAL_VBS_PCR0"));
  const ekRootsPath = String(env.METAL_VBS_EK_ROOTS || "").trim() || VBS_DEFAULT_EK_ROOTS;
  let ekRoots;
  try { ekRoots = readFile(ekRootsPath); } catch (e) { throw new Error(`METAL_VBS_EK_ROOTS: cannot read ${ekRootsPath}: ${e.message}`); }
  if (!/-----BEGIN CERTIFICATE-----/.test(ekRoots)) throw new Error(`METAL_VBS_EK_ROOTS: ${ekRootsPath} holds no PEM certificate`);
  const allowTestSigning = /^(1|true|yes|on)$/i.test(String(env.METAL_VBS_ALLOW_TESTSIGNING || "").trim());
  return { measurements, minSvn, pcr0, ekRootsPath, ekRoots, allowTestSigning };
}
