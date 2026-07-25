// relay/tunnel.js — fleet tunnel hub.
//
// Self-hosted enclaves (e.g. Enclave Metal boxes) live behind CGNAT: they have
// no public endpoint the relay can dial. So they dial OUT to the relay and hold
// a persistent WebSocket; the relay forwards their public HTTP surface (/v1/*,
// /availability, /x/*) back over it. To the rest of api-relay a tunnel enclave
// looks like any other fleet member — it shows up in readRegistry() as a synthetic
// row with a `tunnel://<name>` endpoint, and proxyTo()/pollAvailability() route
// to it through here instead of dialing.
//
// Trust: the tunnel only decides ROUTING, never trust. Clients still verify the
// enclave's attestation end-to-end (the metal RAD carries a real SEV-SNP report;
// nothing here vouches for it). Attach auth just stops a random peer from
// claiming a fleet name: the enclave presents a token whose sha256 is on a
// committed allowlist (the token itself never enters the repo), so no on-box
// secret and no secret-in-code is required.
import { WebSocketServer } from "ws";
import { createHash, timingSafeEqual, randomBytes } from "node:crypto";
import { verifyQuote } from "./snp-verify.mjs";

const sha256Hex = (s) => createHash("sha256").update(String(s)).digest("hex");
const eqHex = (a, b) => { const x = Buffer.from(String(a), "hex"), y = Buffer.from(String(b), "hex"); return x.length === y.length && timingSafeEqual(x, y); };

// allow:  [{ name, tokenSha256 }]                       — bootstrap / first-party boxes
// attest: { allowedMeasurements: [hex], requireVcek }   — permissionless sellers:
//   attach is granted to ANY enclave that proves, with a fresh SEV-SNP quote over
//   a relay-chosen challenge, that it runs a published Metal release (measurement
//   on the allowlist). No token, no per-seller identity. See metal/PROTOCOL.md.
export function createTunnelHub({ allow = [], attest = null, reqTimeoutMs = 30000, onChange = () => {} } = {}) {
  const allowByName = new Map(allow.filter((a) => a && a.name && a.tokenSha256).map((a) => [a.name, a.tokenSha256.toLowerCase()]));
  const attestOn = !!(attest && attest.allowedMeasurements && attest.allowedMeasurements.length);
  const wss = new WebSocketServer({ noServer: true });
  const tunnels = new Map();                                  // name -> { ws, pending, lastSeen, mode, publicUrl }

  function tokenOk(name, token) {
    const want = allowByName.get(name);
    if (!want || !token) return false;
    return eqHex(sha256Hex(token), want);
  }

  // Register an authorized socket as the tunnel for `name` and wire its frames.
  function bind(name, ws, meta = {}) {
    const prev = tunnels.get(name);
    if (prev && prev.ws !== ws) { try { prev.ws.terminate(); } catch {} }   // newest wins
    const t = { ws, pending: new Map(), lastSeen: Date.now(), mode: meta.mode || "", publicUrl: "", measurement: meta.measurement || null };
    tunnels.set(name, t);
    console.log(`[tunnel] ${name} attached via ${meta.via || "token"} (${tunnels.size} enclave${tunnels.size === 1 ? "" : "s"})`);
    try { onChange("attach", name); } catch {}   // refresh discovery so it lands in `live` now, not on the next slow poll
    ws.on("message", (data) => {
      t.lastSeen = Date.now();
      let f; try { f = JSON.parse(data); } catch { return; }
      if (f.t === "hello") { t.mode = f.mode || t.mode; t.publicUrl = f.publicUrl || ""; t.transportKeyFp = f.transportKeyFp || ""; return; }
      if (f.t === "pong") return;
      if (f.t === "res" && f.id != null) { const p = t.pending.get(f.id); if (p) { t.pending.delete(f.id); p.resolve(f); } }
    });
    const bye = () => { if (tunnels.get(name) === t) tunnels.delete(name); for (const p of t.pending.values()) p.reject(new Error("tunnel closed")); console.log(`[tunnel] ${name} detached`); try { onChange("detach", name); } catch {} };
    ws.on("close", bye);
    ws.on("error", () => { try { ws.terminate(); } catch {} });
  }

  function handleUpgrade(req, socket, head) {
    const name = String(req.headers["x-metal-name"] || "").slice(0, 64);
    const token = String(req.headers["x-metal-token"] || "");
    const wantsAttest = req.headers["x-metal-attest"] === "1" || (!token && attestOn);
    if (!name) { socket.write("HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n"); return socket.destroy(); }

    // Token path (bootstrap / first-party): authorize before the handshake.
    if (tokenOk(name, token)) return wss.handleUpgrade(req, socket, head, (ws) => bind(name, ws, { via: "token" }));

    // Attestation path (permissionless): complete the handshake unauthorized, run
    // a challenge → quote → verify exchange, and only then bind (or close).
    if (wantsAttest && attestOn) {
      return wss.handleUpgrade(req, socket, head, (ws) => {
        const nonce = randomBytes(32);
        let settled = false;
        const deny = (why) => { if (settled) return; settled = true; console.log(`[tunnel] ${name} attest REJECTED: ${why}`); try { ws.send(JSON.stringify({ t: "attest-result", ok: false, reason: why })); } catch {} setTimeout(() => { try { ws.close(); } catch {} }, 100); };
        const timer = setTimeout(() => deny("attestation timeout"), 15000);
        ws.on("message", async (data) => {
          if (settled) return;
          let f; try { f = JSON.parse(data); } catch { return; }
          if (f.t !== "attest" || !f.rad || !f.rad.body) return;
          try {
            if (!/sev-snp-guest/.test(f.rad.format || "")) return deny(`format ${f.rad.format} not SEV-SNP`);
            const report = Buffer.from(f.rad.body, "base64");
            const spki = f.rad.transportKey ? Buffer.from(f.rad.transportKey, "base64") : null;
            const aux = f.rad.certs ? Buffer.from(f.rad.certs, "base64") : null;
            const res = await verifyQuote(report, { challenge: nonce, transportKeySpki: spki, auxblob: aux,
              allowedMeasurements: attest.allowedMeasurements, requireVcek: !!attest.requireVcek });
            if (!res.ok) return deny(res.reasons[res.reasons.length - 1] || "quote invalid");
            clearTimeout(timer); settled = true;
            try { ws.send(JSON.stringify({ t: "attest-result", ok: true, measurement: res.measurement })); } catch {}
            bind(name, ws, { via: res.vcekVerified ? "attestation" : "attestation(measurement-only)", measurement: res.measurement, mode: "snp" });
          } catch (e) { deny(`verify error: ${e.message}`); }
        });
        ws.on("error", () => { try { ws.terminate(); } catch {} });
        try { ws.send(JSON.stringify({ t: "challenge", nonce: nonce.toString("base64") })); } catch {}
      });
    }

    socket.write("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n");
    socket.destroy();
  }

  let seq = 1;
  function send(name, method, path, headers, body) {
    const t = tunnels.get(name);
    if (!t) return Promise.reject(new Error(`no tunnel for ${name}`));
    const id = seq++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { t.pending.delete(id); reject(new Error("tunnel request timeout")); }, reqTimeoutMs);
      t.pending.set(id, { resolve: (f) => { clearTimeout(timer); resolve(f); }, reject: (e) => { clearTimeout(timer); reject(e); } });
      try { t.ws.send(JSON.stringify({ t: "req", id, method, path, headers, body: body ? body.toString("base64") : null })); }
      catch (e) { clearTimeout(timer); t.pending.delete(id); reject(e); }
    });
  }

  const NAME_RE = /^tunnel:\/\/(.+)$/;
  return {
    handleUpgrade,
    isTunnel: (origin) => NAME_RE.test(String(origin || "")),
    nameOf: (origin) => (String(origin || "").match(NAME_RE) || [])[1] || null,
    // synthetic registry rows for the attached tunnels (bypass the dial-based
    // discovery filters; auth already happened at attach time)
    origins: () => [...tunnels.entries()].map(([name, t]) => ({
      endpoint: `tunnel://${name}`, id: `tunnel:${name}`, repo: "EnclaveHost/enclave",
      lastSeen: Math.floor(t.lastSeen / 1000), tunnel: true, mode: t.mode, publicUrl: t.publicUrl,
      measurement: t.measurement || undefined,
    })),
    // fetch JSON (availability polling)
    fetchJson: async (origin, path) => {
      const name = (String(origin).match(NAME_RE) || [])[1];
      const r = await send(name, "GET", path, {}, null);
      if (r.status !== 200) return null;
      try { return JSON.parse(Buffer.from(r.body || "", "base64").toString("utf8")); } catch { return null; }
    },
    // full request/response for proxyTo (buffered)
    request: async (origin, { method, path, headers, body }) => {
      const name = (String(origin).match(NAME_RE) || [])[1];
      const r = await send(name, method || "GET", path, headers || {}, body);
      return { status: r.status || 502, headers: r.headers || {}, body: Buffer.from(r.body || "", "base64") };
    },
    count: () => tunnels.size,
  };
}
