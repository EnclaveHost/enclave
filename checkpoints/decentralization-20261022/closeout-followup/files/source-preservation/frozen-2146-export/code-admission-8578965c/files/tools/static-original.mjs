// static-original.mjs <out.json>: READ-ONLY static facts about the ORIGINAL custodian code.
//   - the running image's embedded /opt/custodian/custodian.mjs as extracted by root (work/custody-runtime-provenance/
//     embedded-bundle.mjs; sha256 must be 7c2cd000…, outputs/custody-existing-contracts/runtime-image-provenance.json);
//   - the 9d43e63e8 source snapshot in orig-9d43/ (git archive; every file's git blob id recorded).
// Which digests the code can SIGN (signDigest call sites) and which HTTP routes it serves.
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
const HERE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const BUNDLE = "/home/steven/Documents/Codex/2026-10-18/wo/work/custody-runtime-provenance/embedded-bundle.mjs";
const b = fs.readFileSync(BUNDLE), s = b.toString("utf8"), sha = createHash("sha256").update(b).digest("hex");
const count = (t, x) => t.split(x).length - 1;
const facts = (t) => ({
  signDigestCallSites: [...t.matchAll(/signDigest\(\s*identity\s*,\s*(?:D\.)?(\w+)\(/g)].map((m) => m[1]),
  // approve()/coordinate() sign a precomputed handoverDigest held in a variable (digest / digest2 in the bundle)
  signDigestOnVariable: [...t.matchAll(/signDigest\(\s*identity\s*,\s*(digest\w*)\s*\)/g)].map((m) => m[1]),
  handoverDigestComputed: count(t, "handoverDigest("),
  routes: [...new Set([...t.matchAll(/case "(\/v2\/custody\/[a-z-]+)"/g)].map((m) => m[1]))].sort(),
  strings: Object.fromEntries(["enclave-custody-v2 code", "code-approve", "approveCode", "owner-read", "enclave-custody-v2 handover"].map((x) => [x, count(t, x)])),
  peerQuoteAllowsThePeersOwnMeasurement: /allowedMeasurements: \[p\.measurement\.toString\("hex"\)\]/.test(t),
  candidateNeedsActiveCode: /custodian code not active in the committee's code set/.test(t),
  genesisCodeSetIsOwnMeasurement: /codeSet: \[machine\.measurement\]/.test(t),
});
const src = ["custody/v2/daemon.mjs", "custody/v2/member.mjs", "custody/v2/custodian.mjs"].map((f) => fs.readFileSync(path.join(HERE, "orig-9d43", f), "utf8")).join("\n");
const files = execFileSync("git", ["-C", "/home/steven/Projects/enclave", "ls-tree", "-r", "9d43e63e8", "--", "contracts/EnclaveSecretVaultV2.sol", "custody/v2", "docs/security/secret-custody-v2-spec.md"], { encoding: "utf8" })
  .trim().split("\n").map((l) => { const [meta, f] = l.split("\t"); const blob = meta.split(" ")[2];
    const local = execFileSync("git", ["hash-object", path.join(HERE, "orig-9d43", f)], { encoding: "utf8" }).trim(); return { file: f, blob, snapshotMatches: local === blob }; });
const out = { at: new Date().toISOString(), runningBundle: { path: BUNDLE, sha256: sha, isRunningImageFile: sha === "7c2cd000f5e57d9c5bf8a9e28985b7950ad912ea0deef721bdaabc7a479715a5", ...facts(s) },
  source9d43: { commit: "9d43e63e84e1799467a0202c0cf1cdc5a8aabca5", ...facts(src), files } };
out.ok = out.runningBundle.isRunningImageFile && files.every((f) => f.snapshotMatches) && out.runningBundle.strings["enclave-custody-v2 code"] === 0
  && !out.runningBundle.routes.includes("/v2/custody/code-approve") && JSON.stringify(out.runningBundle.routes) === JSON.stringify(out.source9d43.routes);
fs.writeFileSync(process.argv[2], JSON.stringify(out, null, 1) + "\n");
console.log(JSON.stringify({ ok: out.ok, bundle: out.runningBundle, source: { ...out.source9d43, files: files.length } }, null, 1));
process.exit(out.ok ? 0 : 1);
