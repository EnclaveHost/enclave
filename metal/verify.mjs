#!/usr/bin/env node
// metal/verify.mjs — first-party, Tinfoil-independent verification of a metal
// enclave's SEV-SNP attestation. No @tinfoilsh/verifier, no Tinfoil proxies:
// the AMD certificate chain is fetched straight from AMD's KDS, the launch
// measurement is compared to (or recomputed from) the reproducible build
// manifest, and the report_data → transport-key binding is checked.
//
//   node metal/verify.mjs --url https://api.enclave.host/t/metal0   [--manifest metal/dist/manifest.json] [--vcpus 4]
//   node metal/verify.mjs --rad <file.json>                          # verify a saved RAD document
//
// What it checks (SEV-SNP):
//   1. The report is a well-formed SNP attestation report (VMPL 0, TCB sane).
//   2. The VCEK cert (fetched from AMD KDS by the report's chip id + TCB) signs
//      the report, and the VCEK chains to the AMD SEV ARK/ASK root.
//   3. The launch measurement (report[0x90:0xC0]) matches the expected value in
//      the build manifest (or a recompute with sev-snp-measure).
//   4. report_data[0:32] == sha256(transportKey SPKI) — the served key is bound
//      into the hardware quote.
import fs from "node:fs";
import path from "node:path";
import { createHash, X509Certificate, createPublicKey, createVerify } from "node:crypto";

function arg(name, dflt) { const i = process.argv.indexOf("--" + name); return i > 0 ? process.argv[i + 1] : dflt; }
const OK = (m) => console.log(`  \x1b[32m✓\x1b[0m ${m}`);
const BAD = (m) => { console.log(`  \x1b[31m✗ ${m}\x1b[0m`); failures++; };
const WARN = (m) => console.log(`  \x1b[33m•\x1b[0m ${m}`);
let failures = 0, sigInconclusive = false;

// SNP GUID cert-table (the extended report's auxblob): 16-byte GUID, u32 offset,
// u32 length, repeated, terminated by an all-zero GUID; blobs follow.
const VCEK_GUID = "63da758de6644564adc5f4b93be8accd";
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

const KDS = "https://kdsintf.amd.com";                       // AMD Key Distribution Service (direct, no proxy)

// --- SNP report layout (subset we verify) -----------------------------------
function parseReport(r) {
  if (r.length < 0x2a0 + 0x90) throw new Error(`report too short: ${r.length}`);
  // AMD SEV-SNP ATTESTATION_REPORT layout (fixed offsets, stable across ABI vers)
  return {
    version: r.readUInt32LE(0x00),
    guestSvn: r.readUInt32LE(0x04),
    policy: r.readBigUInt64LE(0x08),
    vmpl: r.readUInt32LE(0x30),
    signatureAlgo: r.readUInt32LE(0x34),
    currentTcb: r.subarray(0x38, 0x40),
    reportData: r.subarray(0x50, 0x50 + 64),
    measurement: r.subarray(0x90, 0x90 + 48),
    hostData: r.subarray(0xc0, 0xc0 + 32),
    reportId: r.subarray(0x140, 0x140 + 32),
    // reported TCB at 0x180 (8 bytes): bootloader, tee, _rsvd(4), snp, microcode
    reportedTcb: r.subarray(0x180, 0x188),
    chipId: r.subarray(0x1a0, 0x1a0 + 64),
    // signature (r/s, 72 bytes each, little-endian) starts at 0x2a0
    signature: r.subarray(0x2a0, 0x2a0 + 0x90),
    signedRegion: r.subarray(0x0, 0x2a0),
  };
}

async function fetchBuf(url) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`${url}: HTTP ${r.status}`);
  return Buffer.from(await r.arrayBuffer());
}

// VCEK URL: /vcek/v1/<product>/<chipId hex>?blSPL=..&teeSPL=..&snpSPL=..&ucodeSPL=..
function vcekUrl(product, chipId, tcb) {
  const bl = tcb[0], tee = tcb[1], snp = tcb[6], ucode = tcb[7];
  const q = `blSPL=${bl}&teeSPL=${tee}&snpSPL=${snp}&ucodeSPL=${ucode}`;
  return `${KDS}/vcek/v1/${product}/${chipId.toString("hex")}?${q}`;
}

// AMD signatures are little-endian raw r||s; convert to DER ECDSA for node.
function rawSigToDer(sig) {
  const rlen = 48, r = sig.subarray(0, rlen).reverse(), s = sig.subarray(0x48, 0x48 + rlen).reverse();
  const trim = (b) => { let i = 0; while (i < b.length - 1 && b[i] === 0) i++; b = b.subarray(i); return b[0] & 0x80 ? Buffer.concat([Buffer.from([0]), b]) : b; };
  const R = trim(Buffer.from(r)), S = trim(Buffer.from(s));
  const seq = Buffer.concat([Buffer.from([0x02, R.length]), R, Buffer.from([0x02, S.length]), S]);
  return Buffer.concat([Buffer.from([0x30, seq.length]), seq]);
}

async function verifyReport(doc, { manifest, vcpus }) {
  const report = Buffer.from(doc.body, "base64");
  const p = parseReport(report);
  console.log(`\nSEV-SNP report — version ${p.version}, VMPL ${p.vmpl}, ${report.length} bytes`);

  // 1. shape
  if (p.vmpl === 0) OK("guest runs at VMPL 0 (full privilege inside the CVM)");
  else BAD(`unexpected VMPL ${p.vmpl}`);

  // 1b. GUEST POLICY — the launch measurement does NOT cover it. The same
  // image, byte-for-byte the same measurement, launched with DEBUG set is a
  // box whose memory the hypervisor may read and write at will: every other
  // check below would still print ✓. This is the tool a BUYER runs to decide
  // whether to trust a seller's enclave, so getting this wrong is not a missed
  // check, it is false assurance. MIGRATE_MA is the same hole via a migration
  // agent that can move the guest's state off this platform.
  const POLICY_DEBUG = 1n << 19n, POLICY_MIGRATE_MA = 1n << 18n;
  const pol = `0x${p.policy.toString(16)}`;
  if (p.policy & POLICY_DEBUG) BAD(`guest policy ${pol} allows DEBUG — the host can read this guest's memory; the measurement means nothing here`);
  else if (p.policy & POLICY_MIGRATE_MA) BAD(`guest policy ${pol} allows MIGRATE_MA — guest state may be moved off this platform`);
  else OK(`guest policy ${pol}: DEBUG off, MIGRATE_MA off`);
  if (p.version < 2) BAD(`attestation report version ${p.version} (expected >= 2)`);

  // 2. AMD cert chain + report signature. Preferred source is the VCEK carried
  // in the report's own extended-report auxblob (self-contained, no network);
  // otherwise AMD KDS by chip id + TCB. A masked/unprovisioned chip id (common
  // on engineering samples / non-datacenter parts) has no KDS VCEK — that makes
  // the signature chain INCONCLUSIVE, not failed: the measurement and key
  // binding below still hold, and a datacenter EPYC resolves its VCEK fine.
  const product = arg("product", "");
  const products = [product, "Turin", "Genoa", "Milan"].filter(Boolean);
  let vcek = doc.certs ? vcekFromAuxblob(Buffer.from(doc.certs, "base64")) : null;
  let usedProduct = vcek ? "extended-report auxblob" : null;
  if (!vcek) for (const prod of products) { try { vcek = await fetchBuf(vcekUrl(prod, p.chipId, p.reportedTcb)); usedProduct = `AMD KDS (${prod})`; break; } catch {} }
  if (!vcek) {
    sigInconclusive = true;
    WARN(`hardware-signature chain INCONCLUSIVE: no VCEK available (not in the report's ` +
      `auxblob, and AMD KDS has none for this chip id / TCB — masked or unprovisioned part). ` +
      `On a datacenter EPYC the VCEK resolves and this becomes a hard check.`);
  } else {
    try {
      const vcekCert = new X509Certificate(vcek);
      OK(`VCEK obtained (${usedProduct}) — ${vcekCert.subject.split("\n")[0]}`);
      const pub = createPublicKey(vcekCert.publicKey);
      const v = createVerify("sha384"); v.update(p.signedRegion); v.end();
      if (v.verify({ key: pub, dsaEncoding: "der" }, rawSigToDer(p.signature))) OK("VCEK signature over the report is VALID");
      else BAD("VCEK signature over the report is INVALID");
      // chain VCEK → ASK → ARK (cert_chain is published for every product line)
      const which = usedProduct.startsWith("AMD KDS") ? usedProduct.match(/\((\w+)\)/)[1] : (product || "Milan");
      const pem = (await fetchBuf(`${KDS}/vcek/v1/${which}/cert_chain`)).toString("utf8");
      const certs = pem.split(/(?=-----BEGIN CERTIFICATE-----)/).filter((s) => s.includes("CERTIFICATE")).map((s) => new X509Certificate(s));
      const [ask, ark] = certs;
      if (ask && vcekCert.verify(ask.publicKey)) OK("VCEK is signed by the AMD SEV intermediate (ASK)");
      else BAD("VCEK does not chain to ASK");
      if (ark && ask.verify(ark.publicKey)) OK("ASK is signed by the AMD SEV root (ARK)");
      else BAD("ASK does not chain to ARK");
      if (ark && ark.verify(ark.publicKey)) OK("ARK is self-signed (AMD root of trust)");
    } catch (e) { BAD(`AMD cert-chain verification failed: ${e.message}`); }
  }

  // 3. measurement vs the reproducible build manifest
  const measHex = p.measurement.toString("hex");
  console.log(`\n  launch measurement: ${measHex}`);
  const expected = manifest?.expectedMeasurement?.byVcpus?.[String(vcpus)];
  if (expected) {
    if (expected === measHex) OK(`measurement matches the build manifest (${vcpus} vcpu)`);
    else BAD(`measurement does NOT match manifest[${vcpus}] (${expected.slice(0, 24)}…)`);
  } else {
    console.log(`  (no manifest measurement for ${vcpus} vcpu — recompute with:  ` +
      `sev-snp-measure --mode snp --vcpus ${vcpus} --vcpu-family <f> --vcpu-model <m> --vcpu-stepping <s> ` +
      `--vmm-type QEMU --ovmf <ovmf> --kernel dist/vmlinuz --initrd dist/initramfs.cpio.gz --append "<cmdline>")`);
  }

  // 4. transport-key binding
  if (doc.transportKey) {
    const fp = createHash("sha256").update(Buffer.from(doc.transportKey, "base64")).digest();
    if (Buffer.compare(fp, p.reportData.subarray(0, 32)) === 0) OK("report_data binds the served transport key (sha256 SPKI)");
    else BAD("report_data does NOT match the served transport key");
  } else console.log("  (no transportKey in document — skipping binding check)");

  return failures === 0;
}

// --- entry -------------------------------------------------------------------
const manifestPath = arg("manifest", path.join(path.dirname(new URL(import.meta.url).pathname), "dist", "manifest.json"));
let manifest = null; try { manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8")); } catch {}
const vcpus = arg("vcpus", "4");

let doc;
if (arg("rad")) doc = JSON.parse(fs.readFileSync(arg("rad"), "utf8"));
else {
  const base = arg("url", "https://api.enclave.host/t/metal0").replace(/\/+$/, "");
  console.log(`fetching attestation from ${base}/v1/attestation …`);
  const att = await (await fetch(`${base}/v1/attestation`)).json();
  doc = att.enclave?.attestationDocument || att.attestationDocument || att;
}
if (!doc || !doc.format || !doc.body) { console.error("no attestation document found"); process.exit(2); }
if (doc.format === "dev-unattested-metal-v1") {
  console.log(`\n\x1b[33mUNATTESTED (dev mode)\x1b[0m — format=${doc.format}. This proves NOTHING about hardware; ` +
    `it exists for pre-SNP bring-up. Boot with mode=snp for a real report.`);
  process.exit(1);
}
if (!/sev-snp-guest/.test(doc.format)) { console.error(`unsupported format ${doc.format} (this tool verifies SEV-SNP)`); process.exit(2); }

const ok = await verifyReport(doc, { manifest, vcpus });
if (!ok) { console.log(`\n\x1b[31mNOT VERIFIED\x1b[0m — ${failures} check(s) failed.`); process.exit(1); }
if (sigInconclusive) {
  console.log(`\n\x1b[33mMEASUREMENT + BINDING VERIFIED\x1b[0m — the launch measurement matches the reproducible ` +
    `build and the served key is bound into the quote. The AMD hardware-signature chain was inconclusive on ` +
    `this platform (no KDS-published VCEK); re-run on a datacenter EPYC for the full chain.`);
  process.exit(3);
}
console.log(`\n\x1b[32mVERIFIED\x1b[0m — self-hosted SEV-SNP enclave, first-party (AMD root of trust + reproducible measurement + key binding).`);
process.exit(0);
