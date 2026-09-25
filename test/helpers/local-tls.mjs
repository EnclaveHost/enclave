// test/helpers/local-tls.mjs: a throwaway CA and a leaf for "localhost", minted with openssl at test time, and an HTTPS
// server that serves what a test hands it. The CA's PEM is what a test passes as `ca` (or NODE_EXTRA_CA_CERTS for a child
// process), so nothing under test ever turns certificate validation off. Nothing here is a fixture: every run mints new
// keys, and the directory is removed by the caller.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import https from "node:https";
import { execFileSync } from "node:child_process";

export function mintLocalCa({ cn = "enclave-verifier test CA", host = "localhost" } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "local-tls-"));
  const o = (args) => execFileSync("openssl", args, { cwd: dir, stdio: ["ignore", "pipe", "pipe"] });
  o(["req", "-x509", "-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:P-256", "-nodes", "-keyout", "ca.key", "-out", "ca.pem", "-subj", `/CN=${cn}`, "-days", "2", "-addext", "basicConstraints=critical,CA:TRUE", "-addext", "keyUsage=critical,keyCertSign,cRLSign"]);
  o(["req", "-new", "-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:P-256", "-nodes", "-keyout", "leaf.key", "-out", "leaf.csr", "-subj", `/CN=${host}`, "-addext", `subjectAltName=DNS:${host}`, "-addext", "keyUsage=critical,digitalSignature", "-addext", "extendedKeyUsage=serverAuth"]);
  o(["x509", "-req", "-in", "leaf.csr", "-CA", "ca.pem", "-CAkey", "ca.key", "-CAcreateserial", "-days", "2", "-copy_extensions", "copy", "-out", "leaf.pem"]);
  const read = (f) => fs.readFileSync(path.join(dir, f), "utf8");
  return { dir, host, caPem: read("ca.pem"), caFile: path.join(dir, "ca.pem"), leafPem: read("leaf.pem"), leafKey: read("leaf.key"), cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

// handler(req, res) answers; returns { port, close }
export async function serveTls(ca, handler) {
  const srv = https.createServer({ key: ca.leafKey, cert: ca.leafPem }, handler);
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  return { port: srv.address().port, close: () => new Promise((r) => srv.close(() => r())) };
}
