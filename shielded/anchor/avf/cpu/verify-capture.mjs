#!/usr/bin/env node
// verify-capture.mjs -- a pVM CPU run's evidence, checked offline with the RELAY's own verifiers (PVM-CPU.md):
//   1. the AVF chain in the capture verifies to a pinned Google attestation root, the challenge is the one the owner sent,
//      isVmSecure is true, and the APK component is the given build (relay/avf-verify.mjs, verifyAvfEvidence);
//   2. the CAPS report is signed by the transport key the VM announced (its SPKI line), is well-formed, and passes the
//      admission rules against the given policy (relay/pvm-cpu-tier.mjs, admitPvmCpu), with the capture's challenge as
//      the nonce: a local run is not relay-bound, so this checks the report and the rules, not a relay's freshness.
//
//   node cpu/verify-capture.mjs --log run.log --code-hash H --authority A --model-sha S --selftest-sha R --min-tok-s F [--min-mem-mib M]
// Exit 0 only when both pass. Prints both verdicts.
import fs from "node:fs";
import { evidenceFromLog, verifyAvfEvidence } from "../../../../relay/avf-verify.mjs";
import { admitPvmCpu, pvmCpuPolicy } from "../../../../relay/pvm-cpu-tier.mjs";

const arg = (k) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : null; };
const log = arg("--log");
if (!log || !arg("--code-hash") || !arg("--authority")) { console.error("usage: verify-capture.mjs --log FILE --code-hash H --authority A --model-sha S --selftest-sha R --min-tok-s F"); process.exit(2); }
const text = fs.readFileSync(log, "utf8");
const ev = evidenceFromLog(text);
const chalLine = /CONTROL challenge=([0-9a-f]{64})/.exec(text);
const challenge = chalLine ? chalLine[1] : null;
const avf = verifyAvfEvidence({ chain: ev.chain, challenge: challenge || "" },
  { allowedCodeHashes: [arg("--code-hash")], allowedAuthorityHashes: [arg("--authority")] });
console.log(JSON.stringify({ attestation: { ok: avf.ok, certs: ev.chain.length, isVmSecure: avf.isVmSecure ?? null, codeHash: avf.measurement, reasons: avf.reasons } }));

const spkiLine = /SPKI ([0-9a-f]{88})/.exec(text);
const caps = /VSOCK CAPS ([0-9a-f]+) ([0-9a-f]{128})/.exec(text);
let admission = { eligible: false, reasons: [] };
if (!spkiLine) admission.reasons.push("no SPKI line in the capture");
else if (!caps) admission.reasons.push("no CAPS report in the capture");
else {
  const policy = pvmCpuPolicy({ codeHashes: [arg("--code-hash")], authorityHashes: [arg("--authority")],
    models: [{ sha256: arg("--model-sha"), name: "model", selftestSha256: arg("--selftest-sha"), minDecodeTokS: Number(arg("--min-tok-s")), minMemMib: Number(arg("--min-mem-mib") || 0) }] });
  const attach = { ok: avf.ok, rootVerified: avf.rootVerified, isVmSecure: avf.isVmSecure, measurement: avf.measurement,
                   component: avf.component, transportSpki: Buffer.from(spkiLine[1], "hex") };
  const report = Buffer.from(caps[1], "hex");
  admission = admitPvmCpu({ attach, reportBytes: report, signature: caps[2], nonce: challenge }, policy);
  console.log(JSON.stringify({ report: JSON.parse(report.toString("utf8")) }));
}
console.log(JSON.stringify({ admission: { eligible: admission.eligible, tier: admission.tier ?? null, reasons: admission.reasons, capability: admission.capability ?? null } }));
process.exit(avf.ok && admission.eligible ? 0 : 1);
