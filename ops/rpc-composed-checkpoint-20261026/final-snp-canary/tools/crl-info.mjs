// crl-info.mjs: read-only - the cached public AMD Turin CRL's thisUpdate/nextUpdate and the chain's validity (no write, no network).
import fs from "node:fs"; import { X509Certificate } from "node:crypto";
const { parseCrl } = await import(new URL("../tree/verifier/der.mjs", import.meta.url));
const dir = "/home/steven/enclave-prod/capacity-audit/state/amd/Turin";
const crl = parseCrl(fs.readFileSync(`${dir}/crl.der`));
const certs = fs.readFileSync(`${dir}/chain.pem`, "utf8").match(/-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/g).map((p) => new X509Certificate(p));
console.log(JSON.stringify({ crl: { thisUpdate: crl.thisUpdate, nextUpdate: crl.nextUpdate, pastNextUpdate: new Date() > new Date(crl.nextUpdate) },
  chain: certs.map((c) => ({ subject: c.subject.split("\n").find((l) => l.startsWith("CN=")), validTo: c.validTo })),
  vceks: fs.readdirSync(`${dir}/vcek`).filter((f) => f.endsWith(".der")).length }, null, 1));
