#!/usr/bin/env node
// evil-relay.mjs -- a MALICIOUS relay for the LAB client-verified channel (PVM-CPU.md; test only): it sits where the
// relay sits, between the client and the honest hub's evidence and app ports, and does what a relay could do to a client
// that trusted it. A client that verifies the VM itself must refuse every mode but `pass`, before it sends a request.
//   --mode pass       forward both ports untouched (the control)
//   --mode replay     answer every evidence request with a recorded envelope (--replay FILE: an earlier session's)
//   --mode swap-key   forward the genuine evidence but put THIS relay's own key in it; terminate TLS with that key
//   --mode own-ca     answer with a well-formed envelope for the client's nonce over THIS relay's key, the pinned code
//                     hash and the pinned app, chained to this relay's own CA; terminate TLS with that key
//   --mode mitm-tls   forward the genuine evidence, but terminate TLS with this relay's own key
// Where it terminates TLS it answers any request with a fake 200 ("evil"): a client that trusted it would be fooled.
//   node cpu/evil-relay.mjs --mode M --evidence-listen P --app-listen P --evidence-up HOST:PORT --app-up HOST:PORT
//        [--replay FILE] [--code-hash HEX] [--app HEX]
import net from "node:net";
import tls from "node:tls";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { createHash, X509Certificate } from "node:crypto";
import { bind2 } from "../../../../relay/pvm-app-attest.mjs";
import { makeCa, issueLeaf, extension, AUTH } from "../../../../test/fixtures/avf-synthetic.mjs";

const arg = (k, d = null) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : d; };
const mode = arg("--mode", "pass");
const hp = (s) => { const [h, p] = String(s).split(":"); return { host: h, port: Number(p) }; };
const evUp = hp(arg("--evidence-up")), appUp = hp(arg("--app-up"));
const log = (o) => process.stdout.write(JSON.stringify({ t: new Date().toISOString(), evil: mode, ...o }) + "\n");
const PIXEL = '{"cache":"none","cpuFeatures":"baseline","execution":"interpreter","hostIsa":"aarch64","name":"wasmtime","targetIsa":"pulley64","version":"49.0.0","wx":"enforced"}';

// this relay's own Ed25519 key and a self-signed certificate for it (never the VM's)
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "evil-relay-"));
execFileSync("openssl", ["genpkey", "-algorithm", "ED25519", "-out", path.join(dir, "k.pem")], { stdio: "pipe" });
execFileSync("openssl", ["req", "-new", "-x509", "-key", path.join(dir, "k.pem"), "-subj", "/CN=evil-relay", "-days", "1", "-out", path.join(dir, "c.pem")], { stdio: "pipe" });
const key = fs.readFileSync(path.join(dir, "k.pem")), cert = fs.readFileSync(path.join(dir, "c.pem"));
const evilSpki = new X509Certificate(cert).publicKey.export({ type: "spki", format: "der" });
const ca = mode === "own-ca" ? makeCa(dir) : null;
log({ relaySpkiTail: evilSpki.toString("hex").slice(-16) });

const pipe = (a, b) => { a.pipe(b); b.pipe(a); a.on("error", () => b.destroy()); b.on("error", () => a.destroy()); };
// the evidence port
net.createServer((c) => {
  let req = Buffer.alloc(0);
  c.on("error", () => {});
  c.on("data", (d) => {
    req = Buffer.concat([req, d]);
    const i = req.indexOf(10); if (i < 0) return;
    const line = req.subarray(0, i).toString("latin1"); const nonce = (line.match(/^EVIDENCE ([0-9a-f]{64})$/) || [])[1];
    if (mode === "replay") { const env = fs.readFileSync(arg("--replay"), "utf8").trim(); log({ evidence: "answered with a RECORDED envelope", forNonce: nonce?.slice(0, 16) }); return c.end(env + "\n"); }
    if (mode === "own-ca") {
      const challenge = Buffer.concat([bind2(evilSpki, Buffer.from(nonce, "hex"), createHash("sha256").update(PIXEL).digest()), Buffer.from(arg("--app"), "hex")]);
      const leaf = issueLeaf(dir, { ext: extension({ challenge, code: Buffer.from(arg("--code-hash"), "hex"), auth: AUTH }) });
      const env = { format: "enclave-pvm-app-evidence/v1", nonce, app: arg("--app"), spki: evilSpki.toString("hex"), identity: PIXEL,
                    selftest: "exec_pages=refused:EACCES wx=clean maps=1 scope=self", chain: [leaf.leaf, ca.inter, ca.root].map((x) => x.toString("base64")) };
      log({ evidence: "answered with a FORGED envelope from its own CA over its own key", forNonce: nonce.slice(0, 16) });
      return c.end(JSON.stringify(env) + "\n");
    }
    // pass / swap-key / mitm-tls: ask the real VM (through the honest hub)
    const up = net.connect(evUp.port, evUp.host, () => up.write(line + "\n"));
    let resp = Buffer.alloc(0);
    up.on("data", (d2) => { resp = Buffer.concat([resp, d2]); });
    up.on("end", () => {
      let s = resp.toString("utf8").trim();
      if (mode === "swap-key") { try { const env = JSON.parse(s); env.spki = evilSpki.toString("hex"); s = JSON.stringify(env); log({ evidence: "forwarded the GENUINE envelope with ITS OWN key swapped in" }); } catch {} }
      else log({ evidence: "forwarded untouched" });
      c.end(s + "\n");
    });
    up.on("error", () => c.destroy());
  });
}).listen(Number(arg("--evidence-listen")), "127.0.0.1", () => log({ listening: "evidence", port: Number(arg("--evidence-listen")) }));

// the app port
const mitm = mode !== "pass" && mode !== "replay";
const evilTls = tls.createServer({ key, cert, minVersion: "TLSv1.3" }, (s) => {
  s.on("error", () => {});
  s.once("data", () => { log({ app: "a client SENT a request to the relay's own TLS (it was fooled)" }); s.end("HTTP/1.1 200 OK\r\ncontent-length: 4\r\nconnection: close\r\n\r\nevil"); });
});
net.createServer((c) => {
  c.on("error", () => {});
  if (mitm) { log({ app: "terminating TLS with the relay's own key" }); evilTls.emit("connection", c); return; }
  pipe(c, net.connect(appUp.port, appUp.host));
}).listen(Number(arg("--app-listen")), "127.0.0.1", () => log({ listening: "app", port: Number(arg("--app-listen")), mitm }));
process.on("SIGTERM", () => { fs.rmSync(dir, { recursive: true, force: true }); process.exit(0); });
