// rs-6's precondition, CHIP-VERIFIED (enclave-bf's should-fix; enclave-87: a script guard, not a process step): every canary
// runs on 52156652 at the pinned measurement. Read from each guest ITSELF over its public TLS (the M2 front's
// /.well-known/enclave-attestation?nonce=), never from guestd or any host's word, and with no key of ours:
//   - the report is AMD-signed (VCEK from KDS -> ASK -> the pinned ARK; chip and TCB match: relay/snp-verify.mjs);
//   - HOST_DATA is the deployment id; report_data[0:32] = the ABI/2 binding (isolation/contract Bind2: sha256("enclave-bind-v2\n"
//     || the SPKI of the TLS handshake WE just made || our fresh nonce || the pinned runtime id ccadb38a…)), so the report
//     is from THIS serving guest, now, on the admitted runtime; report_data[32:64] = the pinned AppID;
//   - the launch MEASUREMENT equals the pinned 52156652 value (63's independent expected-measurement.sh = the relay's).
// Exit 0 only if all three canaries pass.   usage: node canary-attest.mjs [relay dir, default ../../../../relay]
import https from "node:https";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createHash, createVerify, randomBytes, X509Certificate } from "node:crypto";

const here = path.dirname(fileURLToPath(import.meta.url));
const relayDir = path.resolve(process.argv[2] || path.join(here, "../../../../relay"));
const { parseSnpReport, snpProductHint, kdsVcekUrl, certChain, vcekMatchesReport } = await import(path.join(relayDir, "snp-verify.mjs"));

const RID = Buffer.from("ccadb38a6779615597f0614311a631c70810916c1bbeb9f5706ee3a637fd90c8", "hex");   // the admitted runtime
const bind2 = (spki, nonce) => createHash("sha256").update(Buffer.concat([Buffer.from("enclave-bind-v2\n"), spki, nonce, RID])).digest();
const MN = { 0x0ddbd824: "f4fb208aedddf04b29f65039f9f86008c7c65e4fd69bdb59fce6ffc3c9aa3c1d5e3ed14558f9728e0799357ab91dc11f",
             0x395bed3e: "5f2f238c88e1ae555e3aa0e5ec8d240e202089a23a7a896b8912e616efb66c5125aab1204a2e1925a5db6f888f5b5e8e",
             0x4e62e60d: "5f2f238c88e1ae555e3aa0e5ec8d240e202089a23a7a896b8912e616efb66c5125aab1204a2e1925a5db6f888f5b5e8e" };
const CANARIES = [
  ["0x0ddbd82423a22883aca0862dc30f7320337e451bc126455cbe4d7846972c2e76", "d2c4dfc0ec475910aa509d1045ae4f2997346c1cd666a167cd5fc959c036aa24"],
  ["0x395bed3e2e24efa02ba9dfed4aa8e081b064e7b5652b3e6474f11c21ae7f1595", "9c3d10f1450e17bc6a21478723193ef7e3da409afe353e264714cb801d180d45"],
  ["0x4e62e60da567ca6c0b35f818192813e082149e738ad27204b5f074ed8adc6c1e", "9c3d10f1450e17bc6a21478723193ef7e3da409afe353e264714cb801d180d45"],
];

// AMD KDS rate-limits: one fetch per distinct VCEK URL (the canaries share a chip), a status check, and backoff retries
const _vcek = new Map();
async function vcekOf(url) {
  if (_vcek.has(url)) return _vcek.get(url);
  let last = "";
  for (let i = 0; i < 5; i++) {
    const r = await fetch(url);
    if (r.ok) { const b = Buffer.from(await r.arrayBuffer()); _vcek.set(url, b); return b; }
    last = `KDS ${r.status}`; await new Promise((ok) => setTimeout(ok, 3000 * (i + 1)));
  }
  throw new Error(`the VCEK could not be fetched (${last})`);
}
async function amdVerified(report) {
  const p = parseSnpReport(report), product = snpProductHint(p);
  if (!product) return "the report names no product line";
  const vcek = new X509Certificate(await vcekOf(kdsVcekUrl(product, p)));
  const [ask, ark] = await certChain(product);
  if (!vcek.verify(ask.publicKey) || !ask.verify(ark.publicKey)) return "the VCEK does not chain to the pinned ARK";
  const r = Buffer.from(p.signature.subarray(0, 48)).reverse(), s = Buffer.from(p.signature.subarray(0x48, 0x48 + 48)).reverse();
  const int = (b) => { let i = 0; while (i < b.length - 1 && b[i] === 0) i++; b = b.subarray(i); return b[0] & 0x80 ? Buffer.concat([Buffer.from([0]), b]) : b; };
  const R = int(r), S = int(s), seq = Buffer.concat([Buffer.from([2, R.length]), R, Buffer.from([2, S.length]), S]);
  const v = createVerify("sha384"); v.update(p.signedRegion); v.end();
  if (!v.verify({ key: vcek.publicKey, dsaEncoding: "der" }, Buffer.concat([Buffer.from([0x30, seq.length]), seq]))) return "the VCEK signature does not verify";
  return vcekMatchesReport(vcek.raw, product, p) || null;
}
// GET over public TLS (normal WebPKI verification), returning the body AND the handshake's SPKI
function attest(label, nonceHex) {
  return new Promise((resolve, reject) => {
    const req = https.get({ host: `${label}.app.enclave.host`, path: `/.well-known/enclave-attestation?nonce=${nonceHex}`, timeout: 20000, agent: false }, (res) => {
      const spki = new X509Certificate(res.socket.getPeerCertificate(false).raw).publicKey.export({ type: "spki", format: "der" });
      let b = ""; res.on("data", (c) => (b += c)); res.on("end", () => resolve({ status: res.statusCode, body: b, spki }));
    });
    req.on("timeout", () => req.destroy(new Error("timeout"))); req.on("error", reject);
  });
}

let all = true;
for (const [id, appId] of CANARIES) {
  const label = id.slice(2, 10), want = MN[Number(id.slice(0, 10))], nonce = randomBytes(32);
  let why = null, meas = "";
  try {
    const r = await attest(label, nonce.toString("hex"));
    if (r.status !== 200) throw new Error(`attestation answered ${r.status}`);
    const d = JSON.parse(r.body);
    if (!d.report) throw new Error(`no hardware report (tier ${d.tier}: ${d.reason || "none"})`);
    const report = Buffer.from(d.report, "base64"), p = parseSnpReport(report);
    meas = Buffer.from(p.measurement).toString("hex");
    const amd = await amdVerified(report);
    if (amd) why = `not AMD-verified: ${amd}`;
    else if ("0x" + Buffer.from(report.subarray(0xc0, 0xe0)).toString("hex") !== id) why = "HOST_DATA is not this deployment";
    else if (!Buffer.from(p.reportData.subarray(0, 32)).equals(bind2(r.spki, nonce)))
      why = "report_data is not the ABI/2 binding of this TLS handshake's key, our nonce and the admitted runtime";
    else if (Buffer.from(p.reportData.subarray(32, 64)).toString("hex") !== appId) why = "report_data[32:64] is not the pinned AppID";
    else if (meas !== want) why = `measurement ${meas.slice(0, 12)} is not 52156652's ${want.slice(0, 12)} (still on another release?)`;
  } catch (e) { why = e.message; }
  console.log(`${why ? "FAIL" : "ok  "} ${label}: ${why || `AMD-verified report of the serving guest (fresh nonce, TLS key bound), measurement ${meas.slice(0, 12)} = 52156652's`}`);
  if (why) all = false;
}
console.log(all ? "ALL 3 CANARIES chip-verified on 52156652" : "NOT all canaries on 52156652: rs-6 must not run");
process.exit(all ? 0 : 1);
