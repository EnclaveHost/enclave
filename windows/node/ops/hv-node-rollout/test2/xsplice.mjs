// xsplice.mjs <deployment id> - READ-ONLY: reach a test-2 deployment's OWN HTTPS the way the SNI relay does, but from here,
// through nan's data plane instead of us-west's SNI daemon (enclave-d1's M1: B's step 1b on us-west is held, so the public
// name reads 000 whatever the node does). It opens the WebSocket the relay would (relay.js spliceRaw):
//   wss://api.enclave.host/t/nucbox-k11/x/<id>/https
// with no credentials. nan's api-relay admits it only while its owner-only row serves the deployment NOW (B's
// ownerOnlySplice -> servesDeploymentUntil: the lease, the served owner and the delegation's expiry, at decision time).
// Then TLS runs INSIDE that stream to the partition, once with CA verification (M4) and once without (-k).
// One line: `x=<open|refused(<HTTP status>)|error(<why>)> ca=<code> k=<code> spki=<sha256[0:16]|none>`.
// Run from a checkout with `ws` (module resolution is the cwd's): cd ~/Projects/enclave && node --input-type=module - <id> < xsplice.mjs
import tls from "node:tls";
import crypto from "node:crypto";
import { WebSocket, createWebSocketStream } from "ws";

const id = String(process.argv[2] || "").toLowerCase();
if (!/^0x[0-9a-f]{64}$/.test(id)) { console.log("x=error(usage: xsplice.mjs <0x…64 id>) ca=000 k=000 spki=none"); process.exit(2); }
const BOX = process.env.XSPLICE_BOX || "https://api.enclave.host/t/nucbox-k11";
const host = `${id.slice(2, 10)}.app.enclave.host`;
const url = BOX.replace(/^http/, "ws") + `/x/${id}/https`;

// one GET / over TLS inside the splice -> { x, code, spki }
function once(verify) {
  return new Promise((resolve) => {
    let done = false, spki = null;
    const finish = (r) => { if (!done) { done = true; clearTimeout(t); try { ws.terminate(); } catch {} resolve({ spki, ...r }); } };
    const t = setTimeout(() => finish({ x: "error(timeout)", code: "000" }), 20_000);
    const ws = new WebSocket(url, { perMessageDeflate: false, handshakeTimeout: 15_000 });
    ws.on("unexpected-response", (_q, res) => finish({ x: `refused(${res.statusCode})`, code: "000" }));
    ws.on("error", (e) => finish({ x: `error(${String(e.code || e.message).slice(0, 40)})`, code: "000" }));
    ws.on("open", () => {
      const s = tls.connect({ socket: createWebSocketStream(ws), servername: host, rejectUnauthorized: verify, ALPNProtocols: ["http/1.1"] });
      s.on("secureConnect", () => {
        // the SubjectPublicKeyInfo DER, as test2-watch.sh and R4 hash it (`openssl pkey -pubin -outform DER`); the
        // certificate's `pubkey` field is NOT that for an EC key (it is the bare point)
        const raw = s.getPeerCertificate(false)?.raw;
        if (raw) spki = crypto.createHash("sha256")
          .update(new crypto.X509Certificate(raw).publicKey.export({ type: "spki", format: "der" })).digest("hex").slice(0, 16);
        s.write(`GET / HTTP/1.1\r\nHost: ${host}\r\nConnection: close\r\n\r\n`);
      });
      let buf = "";
      s.on("data", (d) => { buf += d; });
      s.on("end", () => finish({ x: "open", code: (/^HTTP\/1\.[01] (\d{3})/.exec(buf) || [])[1] || "000" }));
      s.on("error", (e) => finish({ x: "open", code: "000", tls: String(e.code || e.message).slice(0, 40) }));
    });
  });
}
const ca = await once(true), k = await once(false);
console.log(`x=${k.x} ca=${ca.code}${ca.tls ? `(${ca.tls})` : ""} k=${k.code} spki=${k.spki || ca.spki || "none"}`);
