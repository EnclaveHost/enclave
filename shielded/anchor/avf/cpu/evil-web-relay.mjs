#!/usr/bin/env node
// evil-web-relay.mjs -- a MALICIOUS relay for the LAB browser channel (PVM-CPU.md; test only). It stands where the relay's
// browser endpoints stand (POST /evidence, POST /sealed), in front of the honest hub's carrier (cpu/web-carrier.mjs), and
// does what a relay could do to a page. A page that verifies the VM itself must refuse, or get nothing it did not ask for,
// in every mode but `pass`.
//   pass              forward both, untouched (the control); records the envelope (--record-evidence) and the sealed
//                     request (--record-sealed) for later modes
//   replay            answer /evidence with a recorded envelope (--replay FILE)
//   swap-appkey       genuine evidence with THIS relay's own X25519 key as appKey
//   downgrade         genuine evidence stripped to v1 (no app key: nothing a page can seal to)
//   own-ca            a well-formed v2 envelope for the page's nonce over this relay's own keys (a valid appKeySig), the
//                     pinned code hash and app, chained to this relay's own CA
//   tamper-request    forward, with one bit of the sealed request's ciphertext flipped
//   tamper-response   forward, with one bit of the VM's sealed response flipped
//   replay-sealed     forward, then send the page's sealed request to the VM AGAIN and log the VM's answer
//   replay-old-sealed send a recorded sealed request (--replay-sealed FILE, another boot's) instead of the page's
// Any /sealed that reaches this relay in swap-appkey or own-ca mode is logged "a page SENT a request sealed to the relay's
// key (it was fooled)".
//   node cpu/evil-web-relay.mjs --mode M --listen P --up http://127.0.0.1:18447 --origin http://127.0.0.1:18450
//        [--replay FILE] [--replay-sealed FILE] [--record-evidence FILE] [--record-sealed FILE] [--code-hash H] [--app H]
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash, generateKeyPairSync, sign as edSign } from "node:crypto";
import { bind2, appKeyMessage } from "../../../../relay/pvm-app-attest.mjs";
import { makeCa, issueLeaf, extension, AUTH } from "../../../../test/fixtures/avf-synthetic.mjs";

const arg = (k, d = null) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : d; };
const mode = arg("--mode", "pass"), UP = arg("--up"), origin = arg("--origin");
const log = (o) => process.stdout.write(JSON.stringify({ t: new Date().toISOString(), evil: mode, ...o }) + "\n");
const PIXEL = '{"cache":"none","cpuFeatures":"baseline","execution":"interpreter","hostIsa":"aarch64","name":"wasmtime","targetIsa":"pulley64","version":"49.0.0","wx":"enforced"}';
const ed = generateKeyPairSync("ed25519"), x = generateKeyPairSync("x25519");
const relaySpki = ed.publicKey.export({ type: "spki", format: "der" }), relayAppKey = x.publicKey.export({ type: "spki", format: "der" }).subarray(12).toString("hex");
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "evil-web-"));
const ca = mode === "own-ca" ? makeCa(dir) : null;
log({ relaySpkiTail: relaySpki.toString("hex").slice(-16), relayX25519Head: relayAppKey.slice(0, 16) });

const upstream = async (p, body) => { const r = await fetch(`${UP}${p}`, { method: "POST", body }); return { status: r.status, bytes: Buffer.from(await r.arrayBuffer()) }; };
const flip = (b, at) => { const c = Buffer.from(b); c[at] ^= 1; return c; };
http.createServer((req, res) => {
  const cors = { "access-control-allow-origin": origin, vary: "origin" };
  if (req.method === "OPTIONS") { res.writeHead(204, { ...cors, "access-control-allow-methods": "POST", "access-control-allow-headers": "content-type" }); return res.end(); }
  const chunks = [];
  req.on("data", (d) => chunks.push(d));
  req.on("end", async () => {
    const body = Buffer.concat(chunks);
    const send = (status, bytes) => { res.writeHead(status, { ...cors, "cache-control": "no-store" }); res.end(bytes); };
    try {
      if (req.url === "/evidence") {
        const nonce = (/^EVIDENCE ([0-9a-f]{64})/.exec(body.toString("latin1")) || [])[1];
        if (mode === "replay") { log({ evidence: "answered with a RECORDED envelope", forNonce: nonce?.slice(0, 16) }); return send(200, fs.readFileSync(arg("--replay"))); }
        if (mode === "own-ca") {
          const app = arg("--app");
          const challenge = Buffer.concat([bind2(relaySpki, Buffer.from(nonce, "hex"), createHash("sha256").update(PIXEL).digest()), Buffer.from(app, "hex")]);
          const leaf = issueLeaf(dir, { ext: extension({ challenge, code: Buffer.from(arg("--code-hash"), "hex"), auth: AUTH }) });
          const env = { format: "enclave-pvm-app-evidence/v2", nonce, app, spki: relaySpki.toString("hex"), appKey: relayAppKey,
                        appKeySig: edSign(null, appKeyMessage(Buffer.from(nonce, "hex"), app, relayAppKey), ed.privateKey).toString("hex"),
                        identity: PIXEL, selftest: "exec_pages=refused:EACCES wx=clean maps=1 scope=self", chain: [leaf.leaf, ca.inter, ca.root].map((c) => c.toString("base64")) };
          log({ evidence: "answered with a FORGED v2 envelope from its own CA over its own keys", forNonce: nonce.slice(0, 16) });
          return send(200, JSON.stringify(env) + "\n");
        }
        const u = await upstream("/evidence", body);
        if (u.status !== 200) return send(u.status, u.bytes);
        let env = JSON.parse(u.bytes.toString("utf8").split("\n")[0]);
        if (mode === "pass" && arg("--record-evidence")) fs.writeFileSync(arg("--record-evidence"), JSON.stringify(env) + "\n");
        if (mode === "swap-appkey") { env.appKey = relayAppKey; log({ evidence: "forwarded the GENUINE envelope with ITS OWN app key swapped in" }); }
        else if (mode === "downgrade") { const { appKey, appKeySig, ...v1 } = env; env = { ...v1, format: "enclave-pvm-app-evidence/v1" }; log({ evidence: "forwarded the GENUINE envelope DOWNGRADED to v1 (no app key)" }); }
        else log({ evidence: "forwarded untouched", format: env.format });
        return send(200, JSON.stringify(env) + "\n");
      }
      if (req.url === "/sealed") {
        if (mode === "swap-appkey" || mode === "own-ca") { log({ sealed: "a page SENT a request sealed to the relay's key (it was fooled)", bytes: body.length }); return send(200, Buffer.from([1, 0x78])); }
        if (mode === "replay-old-sealed") {
          const old = fs.readFileSync(arg("--replay-sealed"));
          const u = await upstream("/sealed", old);
          log({ sealed: "sent ANOTHER BOOT's recorded sealed request instead of the page's", vmAnswer: u.bytes[0] === 1 ? `refused: ${u.bytes.subarray(1, 200).toString()}` : `status byte ${u.bytes[0]}` });
          return send(u.status, u.bytes);
        }
        const fwd = mode === "tamper-request" ? flip(body, body.length - 20) : body;
        if (mode === "tamper-request") log({ sealed: "flipped one bit of the request's ciphertext" });
        if (mode === "pass" && arg("--record-sealed")) fs.writeFileSync(arg("--record-sealed"), body);
        const u = await upstream("/sealed", fwd);
        if (mode === "replay-sealed") {
          const again = await upstream("/sealed", body);
          log({ sealed: "sent the page's sealed request to the VM AGAIN", vmAnswer: again.bytes[0] === 1 ? `refused: ${again.bytes.subarray(1, 200).toString()}` : `status byte ${again.bytes[0]} (${again.bytes.length} bytes)` });
        }
        if (mode === "tamper-response" && u.bytes.length > 40) { log({ sealed: "flipped one bit of the VM's sealed response" }); return send(u.status, flip(u.bytes, 30)); }
        if (mode !== "replay-sealed" && mode !== "tamper-request") log({ sealed: "forwarded", bytesIn: body.length, bytesOut: u.bytes.length });
        return send(u.status, u.bytes);
      }
      send(404, "");
    } catch (e) { log({ error: e.message }); send(502, ""); }
  });
}).listen(Number(arg("--listen")), "127.0.0.1", () => log({ listening: Number(arg("--listen")) }));
process.on("SIGTERM", () => { fs.rmSync(dir, { recursive: true, force: true }); process.exit(0); });
