// QUOTE-ONLY hardware canary verifier for the RELEASE custodian image (no committee, no registration, no keys).
// Verifies the guest's /v2/custody/evidence answer for a FRESH nonce exactly as the custodian daemon verifies a peer
// (custody/v2/daemon.mjs verifyPeerQuote -> relay/snp-verify.mjs verifyQuote: VCEK chain to AMD's pinned roots, AMD KDS
// collateral, TCB floor, VMPL0, report_data = machineBinding(machine, nonce)), and additionally that:
//   - the report's launch measurement == the RELEASE manifest's measurement (and nothing else),
//   - the machine record's measurement == sha256(that measurement) (what the vault would record at genesis),
//   - the guest's HOST_DATA, policy and chip id are reported (not judged: quote-only).
//   node verify-custodian-quote.mjs --manifest <release dir>/manifest.json (--url http://127.0.0.1:<mgmtPort> | --evidence ev.json --nonce <hex>) [--out verdict.json]
// --url: asks the guest for evidence over the host's LOOPBACK port forward with a fresh random nonce (nothing else).
import fs from "node:fs";
import path from "node:path";
import { createHash, randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
const arg = (n, d) => { const i = process.argv.indexOf("--" + n); return i > 0 ? process.argv[i + 1] : d; };
const SRC = path.resolve(arg("source", path.join(path.dirname(fileURLToPath(import.meta.url)), "../repo")));
const { verifyQuote, parseSnpReport } = await import(path.join(SRC, "relay/snp-verify.mjs"));
const { machineBinding } = await import(path.join(SRC, "custody/v2/member.mjs"));
const { DEFAULT_MIN_TCB } = await import(path.join(SRC, "custody/rules.mjs"));
const sha = (b) => "0x" + createHash("sha256").update(b).digest("hex");

export async function verifyCustodianQuote({ manifest, evidence, nonce, verify = verifyQuote }) {
  const out = { ok: false, reasons: [], expected: { measurement: manifest.measurement, measurementSha256: manifest.measurementSha256, commit: manifest.commit } };
  if (manifest.role !== "enclave-custodian-v2" || !/^[0-9a-f]{96}$/.test(String(manifest.measurement))) { out.reasons.push("not a measured custodian release manifest"); return out; }
  if (!/^[0-9a-f]{64}$/.test(String(nonce))) { out.reasons.push("nonce: 32 bytes hex"); return out; }
  if (!evidence || !evidence.machine || typeof evidence.report !== "string") { out.reasons.push("evidence: {machine, report} required"); return out; }
  let report; try { report = Buffer.from(evidence.report, "base64"); parseSnpReport(report); } catch (e) { out.reasons.push(`report: ${e.message}`); return out; }
  const binding = machineBinding(evidence.machine, Buffer.from(nonce, "hex"));
  const v = await verify(report, { challenge: Buffer.alloc(32, 1), transportKeySpki: Buffer.alloc(32, 1), expectedBinding: Buffer.from(binding),
    allowedMeasurements: [manifest.measurement], auxblob: evidence.auxblob ? Buffer.from(evidence.auxblob, "base64") : null, requireVcek: true, minTcb: DEFAULT_MIN_TCB, expectedVmpl: 0 });
  out.verifier = { ok: v.ok, reasons: v.reasons };
  if (!v.ok) { out.reasons.push(`verifyQuote: ${v.reasons.at(-1)}`); return out; }
  const p = parseSnpReport(report);
  out.observed = { measurement: p.measurement.toString("hex"), hostData: report.subarray(0xc0, 0xe0).toString("hex"), policy: "0x" + p.policy.toString(16), vmpl: p.vmpl,
                   chipIdSha256: sha(p.chipId), machine: evidence.machine };
  if (out.observed.measurement !== manifest.measurement) out.reasons.push("the quoted launch measurement is not the release measurement");
  if (String(evidence.machine.measurement).toLowerCase() !== sha(p.measurement)) out.reasons.push("the machine record's measurement is not sha256 of the quoted one");
  if ((p.policy >> 19n) & 1n) out.reasons.push("the guest policy allows DEBUG");
  out.ok = out.reasons.length === 0;
  return out;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const manifest = JSON.parse(fs.readFileSync(arg("manifest"), "utf8"));
  let nonce = arg("nonce"), evidence;
  if (arg("url")) {
    const u = new URL(arg("url"));
    if (!["127.0.0.1", "localhost", "[::1]"].includes(u.hostname)) throw new Error("--url must be the host's loopback port forward");
    nonce = randomBytes(32).toString("hex");
    const r = await fetch(`${u.origin}/v2/custody/evidence`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ nonce }), signal: AbortSignal.timeout(20000) });
    evidence = await r.json();
    if (!r.ok) throw new Error(`evidence: ${r.status} ${JSON.stringify(evidence).slice(0, 200)}`);
  } else evidence = JSON.parse(fs.readFileSync(arg("evidence"), "utf8"));
  const verdict = await verifyCustodianQuote({ manifest, evidence, nonce });
  verdict.nonce = nonce; verdict.checkedAt = new Date().toISOString();
  if (arg("out")) fs.writeFileSync(arg("out"), JSON.stringify(verdict, null, 1) + "\n", { flag: "wx" });
  console.log(JSON.stringify({ ok: verdict.ok, reasons: verdict.reasons, measurement: verdict.observed?.measurement }, null, 1));
  process.exit(verdict.ok ? 0 : 1);
}
