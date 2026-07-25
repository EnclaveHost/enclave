// relay/snp-verify.mjs — first-party SEV-SNP quote verification for the fleet
// tunnel's attestation-gated attach (the permissionless-seller path). No Tinfoil,
// no third party: AMD KDS direct for the VCEK→ARK chain, a measurement allowlist
// of published Metal releases, and a per-attach freshness challenge.
//
// verifyQuote(report, { challenge, transportKeySpki, allowedMeasurements, requireVcek })
//   -> { ok, measurement, reasons: [...] }
import { createHash, X509Certificate, createPublicKey, createVerify } from "node:crypto";

const KDS = "https://kdsintf.amd.com";
const VCEK_GUID = "63da758de6644564adc5f4b93be8accd";

export function parseSnpReport(r) {
  if (r.length < 0x2a0 + 0x90) throw new Error(`report too short: ${r.length}`);
  return {
    version: r.readUInt32LE(0x00),
    vmpl: r.readUInt32LE(0x30),
    reportData: r.subarray(0x50, 0x50 + 64),
    measurement: r.subarray(0x90, 0x90 + 48),
    reportedTcb: r.subarray(0x180, 0x188),
    chipId: r.subarray(0x1a0, 0x1a0 + 64),
    signature: r.subarray(0x2a0, 0x2a0 + 0x90),
    signedRegion: r.subarray(0x0, 0x2a0),
  };
}

function rawSigToDer(sig) {
  const r = Buffer.from(sig.subarray(0, 48)).reverse(), s = Buffer.from(sig.subarray(0x48, 0x48 + 48)).reverse();
  const trim = (b) => { let i = 0; while (i < b.length - 1 && b[i] === 0) i++; b = b.subarray(i); return b[0] & 0x80 ? Buffer.concat([Buffer.from([0]), b]) : b; };
  const R = trim(r), S = trim(s), seq = Buffer.concat([Buffer.from([0x02, R.length]), R, Buffer.from([0x02, S.length]), S]);
  return Buffer.concat([Buffer.from([0x30, seq.length]), seq]);
}

async function fetchBuf(url) { const r = await fetch(url); if (!r.ok) throw new Error(`${url}: ${r.status}`); return Buffer.from(await r.arrayBuffer()); }

function vcekFromAuxblob(aux) {
  try {
    for (let o = 0; o + 24 <= aux.length; o += 24) {
      const guid = aux.subarray(o, o + 16).toString("hex");
      if (/^0+$/.test(guid)) break;
      const off = aux.readUInt32LE(o + 16), len = aux.readUInt32LE(o + 20);
      if (guid === VCEK_GUID && off + len <= aux.length) return aux.subarray(off, off + len);
    }
  } catch {}
  return null;
}

export async function verifyQuote(report, { challenge, transportKeySpki, allowedMeasurements, auxblob = null, requireVcek = true } = {}) {
  const reasons = [];
  const fail = (m) => { reasons.push(m); return { ok: false, measurement: null, reasons }; };
  let p;
  try { p = parseSnpReport(report); } catch (e) { return fail(`unparseable report: ${e.message}`); }

  if (p.vmpl !== 0) return fail(`VMPL ${p.vmpl} != 0`);
  const measurement = p.measurement.toString("hex");

  // 1. measurement ∈ allowlist of published Metal releases
  const allow = new Set((allowedMeasurements || []).map((m) => m.toLowerCase()));
  if (!allow.has(measurement)) return fail(`measurement ${measurement.slice(0, 16)}… not on the Metal release allowlist`);
  reasons.push("measurement on Metal release allowlist");

  // 2. freshness + key binding: report_data == sha256(transportKeySpki || challenge)
  if (transportKeySpki && challenge) {
    const want = createHash("sha256").update(Buffer.concat([transportKeySpki, challenge])).digest();
    if (Buffer.compare(want, p.reportData.subarray(0, 32)) !== 0) return fail("report_data does not bind (transport key || challenge)");
    reasons.push("report_data binds transport key + fresh challenge");
  } else return fail("missing challenge or transport key for freshness check");

  // 3. AMD hardware-signature chain (VCEK → ASK → ARK). Required in production;
  // on unprovisioned parts (no KDS VCEK) it is inconclusive.
  let vcek = auxblob ? vcekFromAuxblob(auxblob) : null;
  let src = vcek ? "auxblob" : null;
  if (!vcek) for (const prod of ["Turin", "Genoa", "Milan"]) {
    try {
      const bl = p.reportedTcb[0], tee = p.reportedTcb[1], snp = p.reportedTcb[6], uc = p.reportedTcb[7];
      vcek = await fetchBuf(`${KDS}/vcek/v1/${prod}/${p.chipId.toString("hex")}?blSPL=${bl}&teeSPL=${tee}&snpSPL=${snp}&ucodeSPL=${uc}`);
      src = `KDS/${prod}`; var product = prod; break;
    } catch {}
  }
  if (!vcek) {
    if (requireVcek) return fail("no VCEK available (auxblob empty, KDS has none for this chip/TCB) — cannot verify the AMD signature chain");
    reasons.push("WARN: AMD signature chain inconclusive (no VCEK); measurement+binding only");
    return { ok: true, measurement, reasons, vcekVerified: false };
  }
  try {
    const vcekCert = new X509Certificate(vcek);
    const v = createVerify("sha384"); v.update(p.signedRegion); v.end();
    if (!v.verify({ key: createPublicKey(vcekCert.publicKey), dsaEncoding: "der" }, rawSigToDer(p.signature)))
      return fail("VCEK signature over the report is invalid");
    const which = src.startsWith("KDS/") ? src.slice(4) : (product || "Milan");
    const pem = (await fetchBuf(`${KDS}/vcek/v1/${which}/cert_chain`)).toString("utf8");
    const [ask, ark] = pem.split(/(?=-----BEGIN CERTIFICATE-----)/).filter((s) => s.includes("CERTIFICATE")).map((s) => new X509Certificate(s));
    if (!(ask && vcekCert.verify(ask.publicKey))) return fail("VCEK does not chain to ASK");
    if (!(ark && ask.verify(ark.publicKey))) return fail("ASK does not chain to ARK");
    if (!(ark && ark.verify(ark.publicKey))) return fail("ARK not self-signed");
    reasons.push(`AMD signature chain verified (VCEK ${src} → ASK → ARK)`);
    return { ok: true, measurement, reasons, vcekVerified: true };
  } catch (e) { return fail(`cert-chain verification error: ${e.message}`); }
}
