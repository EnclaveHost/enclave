// The box zone's dns-01 gate. A self-hosted enclave answers ACME for its OWN
// hostname so that its certificate is minted in-CVM and the client's TLS
// terminates at the box — the thing that makes the attestation quote's
// reportData match the certificate a browser actually saw. That authority is
// therefore worth exactly one name, and these pin that it cannot be widened:
// wrong shape, wrong signer, or no registration at all must all be refused.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createHmac } from "node:crypto";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const KEY = "ab".repeat(32);
const APP_ZONE = "app.test", IP_ZONE = "ip.test", BOX_ZONE = "box.test";
const MINTED = "e0123456789abcdef";                  // e + 16 hex, the minted shape
const SIG = "0x" + "11".repeat(65);                  // well-formed, recovers to nobody in particular

let proc, apiPort;
const freePort = () => new Promise((res) => {
  const s = net.createServer().listen(0, "127.0.0.1", () => { const p = s.address().port; s.close(() => res(p)); });
});

// Same identity-not-just-liveness boot as dns-relay.test.mjs: /health echoes
// our zone names, so a stranger holding a recycled port can't pass for us.
async function boot() {
  const dnsPort = await freePort(); apiPort = await freePort();
  const p = spawn(process.execPath, [path.join(ROOT, "relay", "dns-relay.js")], {
    env: { ...process.env, IP_ZONE, APP_ZONE, BOX_ZONE, NS_NAME: "ns1.test", ENCLAVES: "https://example.invalid",
           DNS_PORT: String(dnsPort), DNS_API_PORT: String(apiPort), DNS_API_BIND: "127.0.0.1",
           DNS_TXT_KEY: KEY, APP_A: "203.0.113.7", BOX_A: "203.0.113.9" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let log = ""; p.stdout.on("data", (d) => (log += d)); p.stderr.on("data", (d) => (log += d));
  for (let i = 0; i < 100; i++) {
    if (p.exitCode != null) break;
    try {
      const r = await fetch(`http://127.0.0.1:${apiPort}/health`);
      const j = r.ok ? await r.json().catch(() => null) : null;
      if (j && j.zones && j.zones.box === BOX_ZONE) return { p, log: () => log };
    } catch {}
    await new Promise((r) => setTimeout(r, 100));
  }
  try { p.kill("SIGKILL"); } catch {}
  return { p: null, log: () => log };
}

before(async () => {
  for (let attempt = 0; attempt < 3; attempt++) {
    const r = await boot();
    if (r.p) { proc = r.p; return; }
    if (attempt === 2) throw new Error(`dns-relay did not come up:\n${r.log()}`);
  }
});
after(() => { try { proc.kill("SIGKILL"); } catch {} });

async function push(body, headers = {}) {
  const raw = JSON.stringify(body);
  const r = await fetch(`http://127.0.0.1:${apiPort}/v1/txt`, {
    method: "POST", headers: { "content-type": "application/json", ...headers }, body: raw });
  return { status: r.status, body: await r.json().catch(() => null) };
}
const opPush = (name) => push({ name, value: "v", ts: Math.floor(Date.now() / 1000) }, { "x-operator-sig": SIG });
const hmacPush = (body) => push(body, { "x-relay-sig": createHmac("sha256", KEY).update(JSON.stringify(body)).digest("hex") });

test("the box zone is served, and the fleet key can still push for it", async () => {
  const r = await hmacPush({ name: `_acme-challenge.${MINTED}.${BOX_ZONE}`, value: "v" });
  assert.equal(r.status, 200, "a box name must be inside the accepted zone set");
});

test("only a MINTED label is a box name — word-shaped labels are not", async () => {
  // The zone answers a wildcard, so every name under it "exists" in DNS. That
  // must not be mistaken for authority: only e<16hex> is a name we minted, and
  // support./admin./www. must never be issuable even by a real operator.
  for (const label of ["support", "admin", "www", "metal0", "e0123", "e" + "f".repeat(17)]) {
    const r = await opPush(`_acme-challenge.${label}.${BOX_ZONE}`);
    assert.equal(r.status, 403, `${label} must not be treated as a box name`);
    assert.match(r.body.message || "", /not a minted box name/);
  }
});

test("a minted name with no on-chain registration is refused, not defaulted open", async () => {
  // Fail-closed is the whole point: authority comes from the registry entry for
  // THIS host. No entry (or an RPC that told us nothing) means no authority --
  // never "nobody owns it, so anyone may".
  const r = await opPush(`_acme-challenge.${MINTED}.${BOX_ZONE}`);
  assert.equal(r.status, 403);
  assert.match(r.body.message || "", /no live registry entry/);
});

test("box authority does not leak into the app zone, or nesting", async () => {
  // A box proves it owns one hostname. It must not thereby answer for a
  // deployment name, nor for a label nested under its own.
  const app = await opPush(`_acme-challenge.${MINTED}.${APP_ZONE}`);
  assert.equal(app.status, 403, "the box rule must not apply outside the box zone");
  assert.doesNotMatch(app.body.message || "", /minted box name/, "the app zone keeps its own deployment rule");

  const nested = await opPush(`_acme-challenge.sub.${MINTED}.${BOX_ZONE}`);
  assert.equal(nested.status, 403, "no nesting under a minted label");
});
