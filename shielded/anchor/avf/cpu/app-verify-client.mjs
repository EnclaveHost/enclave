#!/usr/bin/env node
// app-verify-client.mjs -- the LAB client-verified channel (PVM-CPU.md; NOT production): the client verifies the pVM
// ITSELF before it sends a request, and takes nothing from the relay but bytes.
//   1. a fresh 32-byte nonce of its own -> the VM's evidence endpoint (through whatever carries the bytes: the relay's
//      hub, the phone's Android app) -> an envelope (enclave-pvm-app-evidence/v1);
//   2. relay/pvm-app-attest.mjs verifyPvmAppEvidence with THIS client's nonce and pins: Google's attestation roots, the
//      build's code hash (pins.py), the APK signing authority, the pVM runtime ID, the app it expects -- none from the relay;
//   3. TLS 1.3 to the app, the peer's key must be the attested transport key (the handshake signature proves the peer
//      holds it); only then is the request written.
// Every outcome is one JSON line; refusals say which step refused and that nothing was sent.
//   node cpu/app-verify-client.mjs --evidence HOST:PORT --app-endpoint HOST:PORT --app <sha256> --code-hash <hex>
//        --authority <hex> [--runtime-id <hex>] [--path P] [--label L] [--save-evidence F]
import net from "node:net";
import tls from "node:tls";
import fs from "node:fs";
import { randomBytes, createHash } from "node:crypto";
import { verifyPvmAppEvidence } from "../../../../relay/pvm-app-attest.mjs";

const arg = (k, d = null) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : d; };
const PIXEL = '{"cache":"none","cpuFeatures":"baseline","execution":"interpreter","hostIsa":"aarch64","name":"wasmtime","targetIsa":"pulley64","version":"49.0.0","wx":"enforced"}';
const hp = (s) => { const [h, p] = String(s).split(":"); return { host: h, port: Number(p) }; };
const ev = hp(arg("--evidence")), appEp = hp(arg("--app-endpoint"));
const label = arg("--label", "ok"), path = arg("--path", "/ping");
const out = (o) => { process.stdout.write(JSON.stringify({ label, ...o }) + "\n"); };

function askEvidence(nonceHex) {
  return new Promise((resolve) => {
    const c = net.connect(ev.port, ev.host);
    let buf = Buffer.alloc(0), done = false;
    const finish = (r) => { if (done) return; done = true; c.destroy(); resolve(r); };
    c.setTimeout(30000, () => finish({ error: "evidence timeout" }));
    c.on("connect", () => c.write(`EVIDENCE ${nonceHex}\n`));
    c.on("data", (d) => { buf = Buffer.concat([buf, d]); if (buf.length > 256 * 1024) return finish({ error: "evidence too large" });
      const i = buf.indexOf(10); if (i >= 0) { try { finish({ env: JSON.parse(buf.subarray(0, i).toString("utf8")) }); } catch { finish({ error: "evidence is not JSON" }); } } });
    c.on("end", () => finish({ error: buf.length ? "evidence ended without a line" : "no evidence (the carrier gave nothing)" }));
    c.on("error", (e) => finish({ error: `evidence connection: ${e.code || e.message}` }));
  });
}

function request(spkiHex) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    const s = tls.connect({ host: appEp.host, port: appEp.port, rejectUnauthorized: false, minVersion: "TLSv1.3", maxVersion: "TLSv1.3", ALPNProtocols: ["http/1.1"] });
    let data = Buffer.alloc(0), sent = false, done = false;
    const finish = (o) => { if (done) return; done = true; try { s.destroy(); } catch {} resolve({ ms: Date.now() - t0, sent, ...o }); };
    s.setTimeout(60000, () => finish({ error: "timeout" }));
    s.on("secureConnect", () => {
      const got = s.getPeerX509Certificate().publicKey.export({ type: "spki", format: "der" }).toString("hex");
      if (s.getProtocol() !== "TLSv1.3") return finish({ refused: `protocol ${s.getProtocol()}`, step: "tls" });
      if (got !== spkiHex) return finish({ refused: "the TLS server's key is not the key the VM's evidence attests", step: "tls", serverKey: got.slice(-16) });
      sent = true;
      s.write(`GET ${path} HTTP/1.1\r\nHost: pvm-app\r\nConnection: close\r\n\r\n`);
    });
    s.on("data", (d) => { data = Buffer.concat([data, d]); });
    s.on("end", () => {
      const txt = data.toString("utf8"), head = txt.split("\r\n\r\n")[0];
      let body = txt.slice(head.length + 4);
      if (/transfer-encoding: chunked/i.test(head)) { let o = "", rest = body; for (;;) { const i = rest.indexOf("\r\n"); if (i < 0) break; const n = parseInt(rest.slice(0, i), 16); if (!n) break; o += rest.slice(i + 2, i + 2 + n); rest = rest.slice(i + 2 + n + 2); } body = o; }
      finish({ status: Number((head.match(/^HTTP\/1\.1 (\d{3})/) || [])[1]) || null, body });
    });
    s.on("error", (e) => finish({ error: e.code || e.message, step: "tls" }));
  });
}

const nonce = randomBytes(32);
const t0 = Date.now();
const got = await askEvidence(nonce.toString("hex"));
if (!got.env) { out({ refused: got.error, step: "evidence", sent: false }); process.exit(1); }
if (arg("--save-evidence")) fs.writeFileSync(arg("--save-evidence"), JSON.stringify(got.env) + "\n");
const v = verifyPvmAppEvidence(got.env, { nonce, appId: arg("--app"), allowedRuntimeIds: [arg("--runtime-id") || createHash("sha256").update(PIXEL).digest("hex")],
                                          allowedCodeHashes: [arg("--code-hash")], allowedAuthorityHashes: [arg("--authority")] });
const verifyMs = Date.now() - t0;
if (!v.ok) { out({ refused: v.reasons[v.reasons.length - 1], step: "verify", sent: false, verifyMs, freshness: v.freshness }); process.exit(1); }
const r = await request(v.transportSpki);
out({ verified: { app: v.appId, runtime: v.runtimeId, codeHash: v.measurement, freshness: v.freshness, key: v.transportSpki.slice(-16), nonce: nonce.toString("hex").slice(0, 16) }, verifyMs, ...r });
process.exit(r.status === 200 ? 0 : 1);
