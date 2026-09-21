// A synthetic Windows VBS node, built from generated keys: a TCG measured-boot
// log with the SIPA records the verifier reads (and a VSM_IDKS_INFO carrying a
// generated RSA key), a VBS_ENCLAVE_REPORT package signed by that key, a TPM
// quote by a generated quoting key over the replayed PCRs, and an EK
// certificate chain (openssl) with the TCG tpmManufacturer SAN. Shared by the
// verifier test and the tunnel handshake test. Nothing here is a real TPM or
// enclave; the fixture under fixtures/vbs/boot64-evidence.json is the real
// thing, and the tests pin the SYNTHETIC root only where they want acceptance.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { createHash, generateKeyPairSync, sign as cryptoSign, constants, X509Certificate } from "node:crypto";
import { SIPA_ID } from "../../relay/vbs-tcglog.mjs";
import { vbsBinding } from "../../relay/vbs-verify.mjs";

export const haveOpenssl = (() => { try { execFileSync("openssl", ["version"], { stdio: "pipe" }); return true; } catch { return false; } })();
export const tmpdir = (prefix = "vbs-") => fs.mkdtempSync(path.join(os.tmpdir(), prefix));
export const fp = (c) => c.fingerprint256.replace(/:/g, "").toLowerCase();
export const sha256 = (...p) => { const h = createHash("sha256"); for (const x of p) h.update(x); return h.digest(); };
const u16be = (n) => { const b = Buffer.alloc(2); b.writeUInt16BE(n); return b; };
const u32be = (n) => { const b = Buffer.alloc(4); b.writeUInt32BE(n >>> 0); return b; };
const u64be = (n) => { const b = Buffer.alloc(8); b.writeBigUInt64BE(BigInt(n)); return b; };
const u32le = (n) => { const b = Buffer.alloc(4); b.writeUInt32LE(n >>> 0); return b; };
const le = (n, size) => { const b = Buffer.alloc(size); if (size === 8) b.writeBigUInt64LE(BigInt(n)); else if (size === 4) b.writeUInt32LE(n); else if (size === 2) b.writeUInt16LE(n); else b[0] = n; return b; };

// ---- TPM structures ------------------------------------------------------------
export const EK_POLICY = Buffer.from("837197674484b3f81a90cc8d46a5d724fd52d76e06520b64f2a1da1b331469aa", "hex");   // the default EK policy digest
export const modulusOf = (pub) => Buffer.from(pub.export({ format: "jwk" }).n, "base64url");
// TPMT_PUBLIC for an RSA-2048 key: the AIK template (restricted signing,
// RSASSA/SHA-256, no symmetric) or the default EK template (restricted decrypt,
// AES-128-CFB, the EK policy).
export function tpmtPublicOf(pub, { ek = false, attributes = ek ? 0x000300b2 : 0x00050072 } = {}) {
  const n = modulusOf(pub);
  const parms = ek ? Buffer.concat([u16be(0x0006), u16be(128), u16be(0x0043), u16be(0x0010)]) : Buffer.concat([u16be(0x0010), u16be(0x0014), u16be(0x000b)]);
  const authPolicy = ek ? EK_POLICY : Buffer.alloc(0);
  return Buffer.concat([u16be(0x0001), u16be(0x000b), u32be(attributes), u16be(authPolicy.length), authPolicy, parms, u16be(n.length * 8), u32be(0), u16be(n.length), n]);
}
export const nameOf = (tpmt) => Buffer.concat([Buffer.from([0, 0x0b]), sha256(tpmt)]);

// ---- the measured-boot log --------------------------------------------------------
const EFI_GLOBAL_VARIABLE = Buffer.from("61dfe48bca93d211aa0d00e098032b8c", "hex");
const tlv = (id, value) => Buffer.concat([u32le(id), u32le(value.length), value]);
export const REQUIRED_FIELDS = { VSM_LAUNCH_TYPE: 1, HYPERVISOR_LAUNCH_TYPE: 1, VBS_VSM_REQUIRED: 1, VBS_HVCI_POLICY: 1, CODEINTEGRITY: 1,
                                 BOOTDEBUGGING: 0, OSKERNELDEBUG: 0, HYPERVISOR_DEBUG: 0, SAFEMODE: 0, WINPE: 0, FLIGHTSIGNING: 0, TESTSIGNING: 0,
                                 HYPERVISOR_BOOT_DMA_PROTECTION: 1, VBS_IOMMU_REQUIRED: 1 };
// { log, pcrs, offsets }: offsets lets a test edit an event's data or digest in place.
export function buildLog({ idksPub, fields = {}, secureBoot = 1, bootCounter = 228, extraPcr12 = [] } = {}) {
  const f = { ...REQUIRED_FIELDS, ...fields };
  const events = [];
  const ev = (pcr, type, data, digest = sha256(data)) => events.push({ pcr, type, data, digest });
  const hdr = Buffer.concat([Buffer.from("Spec ID Event03\0", "latin1"), u32le(0), Buffer.from([0, 2, 0, 2]), u32le(1), le(0x000b, 2), le(32, 2), Buffer.from([0])]);
  ev(0, 8, Buffer.from("synthetic firmware 1.0\0", "utf16le"));                       // PCR 0 is pinned by policy, never replayed
  const sbName = Buffer.from("SecureBoot", "utf16le");
  ev(7, 0x80000001, Buffer.concat([EFI_GLOBAL_VARIABLE, le(10, 8), le(1, 8), sbName, Buffer.from([secureBoot])]));
  ev(7, 4, Buffer.alloc(4, 0));
  const scalars = Object.entries(f).map(([k, v]) => { const id = SIPA_ID[k]; if (id == null) throw new Error(`unknown SIPA field ${k}`); return tlv(id, le(v, /LAUNCH_TYPE|POLICY/.test(k) ? 4 : 1)); });
  const n = modulusOf(idksPub), e = Buffer.from([1, 0, 1]);
  const idks = tlv(0x50023, Buffer.concat([u32le(1), u32le(n.length * 8), u32le(e.length), u32le(n.length), e, n]));
  ev(12, 6, Buffer.concat([tlv(0x40010001, Buffer.concat([...scalars, idks, ...extraPcr12])), tlv(0x20001, tlv(0x20002, le(bootCounter, 8)))]));
  const mod = (p) => tlv(0x40010002, tlv(0x70001, Buffer.from(p, "utf16le")));
  ev(13, 6, mod("\\Windows\\System32\\winload.efi"));
  ev(14, 6, mod("\\Windows\\System32\\ci.dll"));
  const parts = [Buffer.concat([u32le(0), u32le(3), Buffer.alloc(20, 0), u32le(hdr.length), hdr])];
  const offsets = [];
  let off = parts[0].length;
  for (const x of events) {
    const head = Buffer.concat([u32le(x.pcr), u32le(x.type), u32le(1), le(0x000b, 2), x.digest, u32le(x.data.length)]);
    offsets.push({ pcr: x.pcr, type: x.type, digestAt: off + 14, dataAt: off + head.length, dataEnd: off + head.length + x.data.length });
    parts.push(head, x.data); off += head.length + x.data.length;
  }
  const pcrs = new Map();
  for (const x of events) pcrs.set(x.pcr, sha256(pcrs.get(x.pcr) || Buffer.alloc(32, 0), x.digest));
  return { log: Buffer.concat(parts), pcrs, offsets };
}

// ---- the quote ----------------------------------------------------------------------
export function buildQuote({ aikPriv, aikName, pcrs, pcr0, extraData, select = [0, 7, 12, 13, 14], resetCount = 228 }) {
  const bits = Buffer.alloc(3, 0);
  for (const p of select) bits[p >> 3] |= 1 << (p & 7);
  const values = select.map((p) => (p === 0 ? pcr0 : pcrs.get(p)) || Buffer.alloc(32, 0));
  const attest = Buffer.concat([u32be(0xff544347), u16be(0x8018), u16be(aikName.length), aikName, u16be(extraData.length), extraData,
                                u64be(123456789n), u32be(resetCount), u32be(0), Buffer.from([1]), u64be(0x2026092100000001n),
                                u32be(1), u16be(0x000b), Buffer.from([3]), bits, u16be(32), sha256(...values)]);
  const sig = cryptoSign("sha256", attest, { key: aikPriv, padding: constants.RSA_PKCS1_PADDING });
  return { attest, sig };
}

// ---- the enclave report package ---------------------------------------------------------
export function buildReport({ idksPriv, enclaveData, identity, modules = [{ name: "enclave-engine.dll" }, { name: "vertdll.dll" }, { name: "ucrtbase_enclave.dll" }] }) {
  const id = Buffer.concat([identity.ownerId || Buffer.alloc(32, 0x42), identity.uniqueId, identity.authorId, identity.familyId, identity.imageId,
                            u32le(identity.svn), u32le(identity.secureKernelSvn ?? 0), u32le(identity.platformSvn ?? 2), u32le(identity.flags ?? 0),
                            u32le(identity.signingLevel ?? 0), u32le(identity.enclaveType ?? 0x10)]);
  const mods = modules.map((m) => {
    const body = Buffer.concat([m.uniqueId || identity.uniqueId, m.authorId || identity.authorId, m.familyId || identity.familyId, m.imageId || identity.imageId,
                                u32le(m.svn ?? identity.svn), Buffer.from(`${m.name}\0`, "utf16le")]);
    return Buffer.concat([u32le(1), u32le(8 + body.length), body]);
  });
  const ed = Buffer.alloc(64, 0); enclaveData.copy(ed, 0, 0, Math.min(64, enclaveData.length));
  const statement = Buffer.concat([u32le(224 + mods.reduce((a, m) => a + m.length, 0)), u32le(1), ed, id, ...mods]);
  const signature = cryptoSign("sha256", statement, { key: idksPriv, padding: constants.RSA_PKCS1_PSS_PADDING, saltLength: 32 });
  return Buffer.concat([u32le(24 + statement.length + signature.length), u32le(1), u32le(1), u32le(statement.length), u32le(signature.length), u32le(0), statement, signature]);
}

// ---- the EK certificate chain (openssl) ---------------------------------------------------
const ssl = (dir) => (...a) => execFileSync("openssl", a, { cwd: dir, stdio: "pipe" });
const derOf = (dir, n) => new X509Certificate(fs.readFileSync(path.join(dir, `${n}.pem`))).raw;
export function makeTpmCa(dir) {
  const x = ssl(dir);
  fs.writeFileSync(path.join(dir, "ca.cnf"), "[ca]\nbasicConstraints=critical,CA:TRUE\nkeyUsage=critical,keyCertSign,cRLSign\nsubjectKeyIdentifier=hash\nauthorityKeyIdentifier=keyid\n");
  x("ecparam", "-name", "prime256v1", "-genkey", "-noout", "-out", "root.key");
  x("req", "-x509", "-new", "-key", "root.key", "-sha256", "-days", "30", "-subj", "/CN=Synthetic TPM Root", "-addext", "basicConstraints=critical,CA:TRUE", "-addext", "keyUsage=critical,keyCertSign,cRLSign", "-out", "root.pem");
  x("ecparam", "-name", "prime256v1", "-genkey", "-noout", "-out", "inter.key");
  x("req", "-new", "-key", "inter.key", "-subj", "/CN=Synthetic TPM Intermediate", "-out", "inter.csr");
  x("x509", "-req", "-in", "inter.csr", "-CA", "root.pem", "-CAkey", "root.key", "-CAcreateserial", "-days", "30", "-sha256", "-extfile", "ca.cnf", "-extensions", "ca", "-out", "inter.pem");
  const rootPem = fs.readFileSync(path.join(dir, "root.pem"), "utf8"), interPem = fs.readFileSync(path.join(dir, "inter.pem"), "utf8");
  const root = derOf(dir, "root");
  return { root, inter: derOf(dir, "inter"), rootPem, interPem, bundlePem: rootPem + interPem, rootPin: fp(new X509Certificate(root)) };
}
let ekSeq = 0;
// An RSA-2048 EK under the intermediate, with the TCG SAN (empty subject, like the real one).
export function issueEk(dir, { manufacturer = "414D4400" } = {}) {
  const x = ssl(dir), n = `ek-${++ekSeq}`;
  const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  fs.writeFileSync(path.join(dir, `${n}.key`), privateKey.export({ type: "pkcs8", format: "pem" }));
  fs.writeFileSync(path.join(dir, `${n}.cnf`), `oid_section = oids\n[oids]\ntcg-at-tpmManufacturer = 2.23.133.2.1\ntcg-at-tpmModel = 2.23.133.2.2\ntcg-at-tpmVersion = 2.23.133.2.3\n`
    + `[ek]\nbasicConstraints=CA:FALSE\nsubjectAltName=critical,dirName:tpm_dn\n[tpm_dn]\ntcg-at-tpmManufacturer = id:${manufacturer}\ntcg-at-tpmModel = SYNTH\ntcg-at-tpmVersion = id:00030001\n`);
  x("req", "-new", "-key", `${n}.key`, "-subj", "/", "-out", `${n}.csr`);
  x("x509", "-req", "-in", `${n}.csr`, "-CA", "inter.pem", "-CAkey", "inter.key", "-CAcreateserial", "-days", "30", "-sha256", "-extfile", `${n}.cnf`, "-extensions", "ek", "-out", `${n}.pem`);
  return { cert: derOf(dir, n), privateKey, publicKey, tpmtPublic: tpmtPublicOf(publicKey, { ek: true }) };
}

// ---- a whole node --------------------------------------------------------------------------
export function makeVbsWorld(dir, { manufacturer } = {}) {
  const ca = makeTpmCa(dir), ek = issueEk(dir, { manufacturer });
  const aik = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const tpmtPublic = tpmtPublicOf(aik.publicKey);
  const idks = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const transport = generateKeyPairSync("ed25519");
  const padKey = generateKeyPairSync("x25519").publicKey.export({ type: "spki", format: "der" }).subarray(-32).toString("hex");
  const identity = { uniqueId: sha256("synthetic enclave image"), authorId: sha256("Enclave Host, Inc. VBS signer"),
                     familyId: Buffer.from("ec1a5e00000000010000000000000001", "hex"), imageId: Buffer.from("ec1a5e00000000020000000000000001", "hex"), svn: 3 };
  return { dir, ca, ek, aik: { ...aik, tpmtPublic, name: nameOf(tpmtPublic) }, idks, transport: { ...transport, spki: transport.publicKey.export({ type: "spki", format: "der" }) },
           padKey, identity, measurementKey: sha256(identity.familyId, identity.imageId, identity.authorId).toString("hex"), pcr0: sha256("synthetic firmware PCR0") };
}
// The attest body this node would send for the hub's `nonce`, with the
// credential its TPM recovered. Hooks let a test bend any one input.
export function evidenceFor(w, { nonce, credential = Buffer.alloc(32, 0), log = {}, quote = {}, report = {}, bound: boundOverride = null, chain } = {}) {
  const bound = boundOverride || vbsBinding(w.transport.spki, w.padKey, nonce);
  const challenge = sha256(bound);
  const L = buildLog({ idksPub: w.idks.publicKey, ...log });
  const Q = buildQuote({ aikPriv: w.aik.privateKey, aikName: w.aik.name, pcrs: L.pcrs, pcr0: w.pcr0, extraData: challenge, ...quote });
  const R = buildReport({ idksPriv: w.idks.privateKey, enclaveData: report.enclaveData || challenge, identity: { ...w.identity, ...(report.identity || {}) }, ...(report.modules ? { modules: report.modules } : {}) });
  const signature = cryptoSign(null, bound, w.transport.privateKey);
  const b64 = (b) => b.toString("base64");
  return { body: { report: b64(R), signature: b64(signature), log: b64(L.log), quote: { attest: b64(Q.attest), sig: b64(Q.sig), aikPub: b64(w.aik.tpmtPublic) },
                   credential: b64(credential), ek: { cert: b64(w.ek.cert), chain: chain || [b64(w.ca.inter)] }, pcr0: w.pcr0.toString("hex"),
                   platform: { osBuild: "26200.8875", edition: "Pro", testSigning: false, secureBoot: true, vbsRunning: true } },
           bound, challenge, log: L, quote: Q, report: R };
}
export const policyFor = (w, extra = {}) => ({ measurements: [w.measurementKey], minSvn: 1, pcr0: [w.pcr0.toString("hex")], ekRoots: w.ca.bundlePem, allowTestSigning: false, ...extra });
