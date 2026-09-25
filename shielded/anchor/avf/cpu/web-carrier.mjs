// web-carrier.mjs -- the LAB browser channel's carrier (PVM-CPU.md, SEALED-STREAMING.md; NOT production). A page cannot open a raw stream, so
// the relay offers two POST endpoints that carry a body to the VM and the VM's answer back, as bytes: /evidence (a nonce line
// in, evidence out) and /sealed (a sealed request in, a sealed response out), each over one raw stream on the hub's local
// ports (hub.spliceRaw kinds pvm-evidence, pvm-app-sealed). Nothing is parsed or kept; sizes are logged -- except that a
// LAB run may pass recordEvidence (a directory): each /evidence exchange is then also written there as received, the
// request (the client's nonce line) and the VM's answer, byte for byte, with their UTC times, so the evidence can be
// re-verified offline at the time it was served. Evidence is public;
// sealed traffic is never recorded. CORS only for `origin`, the page's site -- which is NOT the relay: the relay never
// serves the code that verifies it.
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import path from "node:path";

export function createWebCarrier({ port, origin, evidencePort, sealedPort, emit = () => {}, host = "127.0.0.1", recordEvidence = null }) {
  let seq = 0;
  if (recordEvidence) fs.mkdirSync(recordEvidence, { recursive: true });
  const up = { "/evidence": [evidencePort, 256, 256 << 10], "/sealed": [sealedPort, (1 << 20) + 4, (16 << 20) + 64] };
  const web = http.createServer((req, res) => {
    const cors = origin ? { "access-control-allow-origin": origin, vary: "origin" } : {};
    if (req.method === "OPTIONS") { res.writeHead(204, { ...cors, "access-control-allow-methods": "POST", "access-control-allow-headers": "content-type", "access-control-max-age": "60" }); return res.end(); }
    const u = up[req.url];
    if (req.method !== "POST" || !u || !u[0]) { res.writeHead(404, cors); return res.end(); }
    const [upPort, maxIn, maxOut] = u;
    const inb = []; let nIn = 0;
    // over the bound: the 413 goes out first, and the connection closes after it (destroying first reset the socket)
    req.on("data", (d) => { if (res.headersSent) return; nIn += d.length; if (nIn > maxIn) { res.writeHead(413, { ...cors, connection: "close" }); res.end(); res.on("finish", () => req.destroy()); } else inb.push(d); });
    req.on("end", () => {
      if (res.headersSent) return;
      // bytes to the VM, then its answer back AS IT ARRIVES (a streamed sealed answer shows token by token): the first byte
      // sends the headers; a page that does not read pauses the upstream (bounded); a page that goes away closes the
      // upstream, which is how a cancel reaches the VM
      const c = net.connect(upPort, host, () => c.write(Buffer.concat(inb)));
      let nOut = 0, started = false;
      const t0 = Date.now(), rec = recordEvidence && req.url === "/evidence" ? [] : null, sentAt = new Date().toISOString();
      c.on("data", (d) => {
        nOut += d.length;
        if (rec) rec.push(d);
        if (nOut > maxOut) { c.destroy(); return; }
        if (!started) { started = true; res.writeHead(200, { ...cors, "content-type": req.url === "/evidence" ? "application/json" : "application/octet-stream", "cache-control": "no-store", "x-content-type-options": "nosniff" }); }
        if (!res.write(d)) { c.pause(); res.once("drain", () => c.resume()); }
      });
      c.on("close", () => {
        emit({ web: req.url, bytesIn: nIn, bytesOut: nOut, ms: Date.now() - t0 });
        if (rec && nOut <= maxOut) {   // as received: the nonce line in, the VM's evidence out
          const n = String(++seq).padStart(3, "0");
          fs.writeFileSync(path.join(recordEvidence, `evidence-${n}.request`), Buffer.concat(inb));
          fs.writeFileSync(path.join(recordEvidence, `evidence-${n}.json`), Buffer.concat(rec));
          fs.writeFileSync(path.join(recordEvidence, `evidence-${n}.meta.json`), JSON.stringify({ n: Number(n), sentToVmAt: sentAt, answeredAt: new Date().toISOString(),
            bytesIn: nIn, bytesOut: nOut, recorded: "as received: nothing parsed, stripped or reordered" }) + "\n");
        }
        if (!started) { if (!res.headersSent) res.writeHead(502, cors); return res.end(); }
        res.end();
      });
      res.on("close", () => { if (!res.writableFinished) { emit({ web: req.url, cancelled: "the page went away", bytesOut: nOut }); c.destroy(); } });
      c.on("error", () => {});
      c.setTimeout(120000, () => c.destroy());
    });
  });
  web.listen(port, host, () => emit({ webListening: `http://${host}:${web.address().port} (POST /evidence, /sealed) for ${origin || "no origin"}` }));
  return web;
}
