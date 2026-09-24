// test/helpers/snp-synth.mjs: a SYNTHETIC AMD-shaped chain (own ARK/ASK/VCEK, ARK-signed CRL) so the verifier's branches run
// end to end offline. Moved verbatim from test/verifier-fail-closed.test.mjs (2026-09-24); the CRL window is configurable
// (crlDays) and extra CRLs under the same ARK can be produced (extraCrlDays) for freshness tests. It is synthetic and
// proves nothing about AMD, only about this verifier's branches; the real AMD pin refuses it.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { randomBytes, sign, X509Certificate } from "node:crypto";

export function synthChain({ crlDays = 30, extraCrlDays = [], revokeAsk = false, extraVceks = 0 } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "synth-amd-"));
  const o = (args, input) => execFileSync("openssl", args, { cwd: dir, stdio: ["pipe", "pipe", "pipe"], input });
  const pss = ["-sha384", "-sigopt", "rsa_padding_mode:pss", "-sigopt", "rsa_pss_saltlen:48"];
  o(["req", "-x509", "-newkey", "rsa:4096", "-nodes", "-keyout", "ark.key", "-out", "ark.pem", "-days", "3650", "-subj", "/O=SYNTHETIC not AMD/CN=ARK-Genoa", ...pss, "-addext", "basicConstraints=critical,CA:TRUE", "-addext", "keyUsage=critical,keyCertSign,cRLSign"]);
  o(["req", "-new", "-newkey", "rsa:4096", "-nodes", "-keyout", "ask.key", "-out", "ask.csr", "-subj", "/O=SYNTHETIC not AMD/CN=SEV-Genoa"]);
  fs.writeFileSync(path.join(dir, "ca.ext"), "basicConstraints=critical,CA:TRUE\nkeyUsage=critical,keyCertSign,cRLSign\n");
  o(["x509", "-req", "-in", "ask.csr", "-CA", "ark.pem", "-CAkey", "ark.key", "-set_serial", "0x020002", "-days", "3650", ...pss, "-extfile", "ca.ext", "-out", "ask.pem"]);
  const chip = randomBytes(64);
  fs.writeFileSync(path.join(dir, "vcek.ext"), ["1.3.6.1.4.1.3704.1.3.1=DER:02:01:0a", "1.3.6.1.4.1.3704.1.3.2=DER:02:01:00", "1.3.6.1.4.1.3704.1.3.3=DER:02:01:17", "1.3.6.1.4.1.3704.1.3.8=DER:02:01:54",
    "1.3.6.1.4.1.3704.1.4=DER:" + chip.toString("hex").match(/../g).join(":"), ""].join("\n"));
  o(["ecparam", "-name", "secp384r1", "-genkey", "-noout", "-out", "vcek.key"]);
  o(["req", "-new", "-key", "vcek.key", "-out", "vcek.csr", "-subj", "/O=SYNTHETIC not AMD/CN=SEV-VCEK"]);
  o(["x509", "-req", "-in", "vcek.csr", "-CA", "ask.pem", "-CAkey", "ask.key", "-set_serial", "0", "-days", "3650", ...pss, "-extfile", "vcek.ext", "-out", "vcek.pem"]);
  // an ARK-signed, empty CRL (RSASSA-PSS), via openssl ca -gencrl with a minimal database; more under the same ARK on request
  const read = (f) => fs.readFileSync(path.join(dir, f));
  const crlFor = (days, name) => {
    fs.mkdirSync(path.join(dir, "db"), { recursive: true }); fs.writeFileSync(path.join(dir, "db/index.txt"), ""); fs.writeFileSync(path.join(dir, "db/crlnumber"), "01\n");
    fs.writeFileSync(path.join(dir, "ca.cnf"), `[ca]\ndefault_ca=x\n[x]\ndatabase=db/index.txt\ncrlnumber=db/crlnumber\ndefault_md=sha384\ndefault_crl_days=${days}\n`);
    o(["ca", "-gencrl", "-config", "ca.cnf", "-keyfile", "ark.key", "-cert", "ark.pem", "-md", "sha384", "-sigopt", "rsa_padding_mode:pss", "-sigopt", "rsa_pss_saltlen:48", "-out", `${name}.pem`]);
    o(["crl", "-in", `${name}.pem`, "-outform", "DER", "-out", `${name}.der`]);
    return fs.readFileSync(path.join(dir, `${name}.der`));
  };
  // more VCEKs under the same ASK for OTHER chips (the same SPLs): a cache must never serve one in another chip's slot
  const others = [];
  for (let i = 0; i < extraVceks; i++) {
    const c2 = randomBytes(64);
    fs.writeFileSync(path.join(dir, `vcek${i}.ext`), ["1.3.6.1.4.1.3704.1.3.1=DER:02:01:0a", "1.3.6.1.4.1.3704.1.3.2=DER:02:01:00", "1.3.6.1.4.1.3704.1.3.3=DER:02:01:17", "1.3.6.1.4.1.3704.1.3.8=DER:02:01:54",
      "1.3.6.1.4.1.3704.1.4=DER:" + c2.toString("hex").match(/../g).join(":"), ""].join("\n"));
    o(["ecparam", "-name", "secp384r1", "-genkey", "-noout", "-out", `vcek${i}.key`]);
    o(["req", "-new", "-key", `vcek${i}.key`, "-out", `vcek${i}.csr`, "-subj", "/O=SYNTHETIC not AMD/CN=SEV-VCEK"]);
    o(["x509", "-req", "-in", `vcek${i}.csr`, "-CA", "ask.pem", "-CAkey", "ask.key", "-set_serial", "0", "-days", "3650", ...pss, "-extfile", `vcek${i}.ext`, "-out", `vcek${i}.pem`]);
    others.push({ chip: c2, der: Buffer.from(read(`vcek${i}.pem`).toString().replace(/-----[^-]+-----|\s/g, ""), "base64"), key: read(`vcek${i}.key`) });
  }
  const crlDer = crlFor(crlDays, "crl");
  const crls = Object.fromEntries(extraCrlDays.map((d) => [d, crlFor(d, `crl-${d}`)]));
  // and, on request, a CRL under the same ARK that REVOKES the ASK (serial 0x020002): the database gets the ASK as valid,
  // `openssl ca -revoke` marks it, and gencrl lists it
  let crlRevokingAsk = null;
  if (revokeAsk) {
    const askCert = new X509Certificate(read("ask.pem")); const exp = askCert.validTo;   // e.g. "Sep 22 12:00:00 2036 GMT"
    const d = new Date(exp), z = (n) => String(n).padStart(2, "0"), stamp = `${String(d.getUTCFullYear()).slice(2)}${z(d.getUTCMonth() + 1)}${z(d.getUTCDate())}${z(d.getUTCHours())}${z(d.getUTCMinutes())}${z(d.getUTCSeconds())}Z`;
    fs.writeFileSync(path.join(dir, "db/index.txt"), `V\t${stamp}\t\t020002\tunknown\t/O=SYNTHETIC not AMD/CN=SEV-Genoa\n`);
    fs.writeFileSync(path.join(dir, "db/index.txt.attr"), "unique_subject = no\n");
    o(["ca", "-config", "ca.cnf", "-keyfile", "ark.key", "-cert", "ark.pem", "-md", "sha384", "-revoke", "ask.pem"]);
    o(["ca", "-gencrl", "-config", "ca.cnf", "-keyfile", "ark.key", "-cert", "ark.pem", "-md", "sha384", "-sigopt", "rsa_padding_mode:pss", "-sigopt", "rsa_pss_saltlen:48", "-out", "crl-revoked.pem"]);
    o(["crl", "-in", "crl-revoked.pem", "-outform", "DER", "-out", "crl-revoked.der"]);
    crlRevokingAsk = read("crl-revoked.der");
  }
  const out = { crlRevokingAsk, otherVceks: others, chainPem: read("ask.pem").toString() + read("ark.pem").toString(), vcekDer: Buffer.from(read("vcek.pem").toString().replace(/-----[^-]+-----|\s/g, ""), "base64"), vcekKey: read("vcek.key"), crlDer, crls, chip,
    arkFp: new X509Certificate(read("ark.pem")).fingerprint256.replace(/:/g, "").toLowerCase() };
  fs.rmSync(dir, { recursive: true, force: true }); return out;
}
export function synthReport(S, { reportData, version = 3, hostData = null }) {
  const r = Buffer.alloc(0x4a0);
  if (hostData) Buffer.from(hostData).copy(r, 0xc0);   // HOST_DATA: the host's launch-time word (deployment binding tests)
  r.writeUInt32LE(version, 0); r.writeBigUInt64LE(0x30000n, 8); r.writeUInt32LE(1, 0x34);
  const tcb = Buffer.from("0a00000000001754", "hex"); tcb.copy(r, 0x38); tcb.copy(r, 0x180); tcb.copy(r, 0x1e0); tcb.copy(r, 0x1f0);
  reportData.copy(r, 0x50); Buffer.from("77".repeat(48), "hex").copy(r, 0x90);
  r[0x188] = 0x19; r[0x189] = 0x11; r[0x18a] = 1; S.chip.copy(r, 0x1a0);
  r[0x1e8] = 40; r[0x1e9] = 55; r[0x1ea] = 1; r[0x1ec] = 40; r[0x1ed] = 55; r[0x1ee] = 1;
  const sig = sign("sha384", r.subarray(0, 0x2a0), { key: S.vcekKey, dsaEncoding: "ieee-p1363" });
  Buffer.from(sig.subarray(0, 48)).reverse().copy(r, 0x2a0); Buffer.from(sig.subarray(48, 96)).reverse().copy(r, 0x2a0 + 0x48);
  return r;
}
