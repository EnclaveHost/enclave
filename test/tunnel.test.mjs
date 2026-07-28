// Fleet tunnel attach (relay/tunnel.js) + SEV-SNP quote verification
// (relay/snp-verify.mjs) — the trust boundary a self-hosted seller box crosses.
//
// Why these cases exist. The tunnel decides ROUTING, and routing is authority
// enough to matter: a tunnel row's `publicUrl` becomes its registry id upstream
// (keccak of the URL) and a row with a known id DISPLACES the discovered
// on-chain row, so whoever can name another enclave's endpoint inherits that
// enclave's /x data path and /v1 control path. Meanwhile the permissionless
// attach path authenticates a MEASUREMENT, not a box — every seller runs the
// same published image — so the name in the handshake is a request, never an
// identity. And a launch measurement says nothing about the POLICY the guest
// was launched under: the same image booted with DEBUG on is a transparent box
// whose memory the host reads at will, with a bit-identical measurement.

import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { createHash } from "node:crypto";
import { WebSocket } from "ws";
import { createTunnelHub } from "../relay/tunnel.js";
import { verifyQuote } from "../relay/snp-verify.mjs";

// ---------- SEV-SNP quote gate ------------------------------------------------

const MEAS = "ab".repeat(48);
function report({ version = 2, policy = 0x30000n, vmpl = 0, measurement = MEAS, reportData = null } = {}) {
  const r = Buffer.alloc(0x2a0 + 0x90);
  r.writeUInt32LE(version, 0x00);
  r.writeBigUInt64LE(BigInt(policy), 0x08);
  r.writeUInt32LE(vmpl, 0x30);
  if (reportData) reportData.copy(r, 0x50);
  Buffer.from(measurement, "hex").copy(r, 0x90);
  return r;
}
const SPKI = Buffer.from("30599999", "hex");
const NONCE = Buffer.alloc(32, 7);
const bind32 = () => createHash("sha256").update(Buffer.concat([SPKI, NONCE])).digest();
const verify = (r, extra = {}) => verifyQuote(r, {
  challenge: NONCE, transportKeySpki: SPKI, allowedMeasurements: [MEAS], requireVcek: false, ...extra });

test("snp: a well-formed quote over the challenge passes (measurement-only mode)", async () => {
  const res = await verify(report({ reportData: bind32() }));
  assert.equal(res.ok, true);
  assert.equal(res.measurement, MEAS);
  assert.equal(res.vcekVerified, false);
});

test("snp: DEBUG in the guest policy is refused — same measurement, transparent box", async () => {
  const res = await verify(report({ policy: 0x30000n | (1n << 19n), reportData: bind32() }));
  assert.equal(res.ok, false);
  assert.match(res.reasons.at(-1), /DEBUG/);
});

test("snp: MIGRATE_MA in the guest policy is refused", async () => {
  const res = await verify(report({ policy: 0x30000n | (1n << 18n), reportData: bind32() }));
  assert.equal(res.ok, false);
  assert.match(res.reasons.at(-1), /MIGRATE_MA/);
});

test("snp: non-zero VMPL, old report version, off-allowlist measurement, stale challenge all fail", async () => {
  assert.equal((await verify(report({ vmpl: 1, reportData: bind32() }))).ok, false);
  assert.equal((await verify(report({ version: 1, reportData: bind32() }))).ok, false);
  assert.equal((await verify(report({ measurement: "cd".repeat(48), reportData: bind32() }))).ok, false);
  // report_data over a DIFFERENT challenge: a replayed quote proves no freshness
  const stale = createHash("sha256").update(Buffer.concat([SPKI, Buffer.alloc(32, 9)])).digest();
  const res = await verify(report({ reportData: stale }));
  assert.equal(res.ok, false);
  assert.match(res.reasons.at(-1), /report_data does not bind/);
});

// ---------- tunnel attach -----------------------------------------------------

const TOKEN = "s3cret-token";
const TOKEN_SHA = createHash("sha256").update(TOKEN).digest("hex");

async function hubServer({ attest = null, operatorFor = null } = {}) {
  const hub = createTunnelHub({ allow: [{ name: "metal0", tokenSha256: TOKEN_SHA }], attest, operatorFor });
  const server = http.createServer((_req, res) => res.end("ok"));
  server.on("upgrade", (req, socket, head) => hub.handleUpgrade(req, socket, head));
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const url = `ws://127.0.0.1:${server.address().port}/v1/fleet-tunnel`;
  return { hub, server, url, close: () => new Promise((r) => server.close(r)) };
}
// resolves "open" when the handshake completes, or the refusal status code.
// Frames are collected from the socket itself: the hub's challenge is sent the
// instant the handshake lands, before a caller could attach a listener.
const dial = (url, headers) => new Promise((resolve) => {
  const ws = new WebSocket(url, { headers });
  const frames = [];
  ws.on("message", (d) => { try { frames.push(JSON.parse(d)); } catch {} });
  ws.on("open", () => resolve({ state: "open", ws, frames }));
  ws.on("unexpected-response", (_req, res) => { try { ws.terminate(); } catch {} resolve({ state: res.statusCode }); });
  ws.on("error", () => resolve({ state: "error" }));
});
const settle = () => new Promise((r) => setTimeout(r, 60));

test("tunnel: the token binds a name; a wrong token or a bad name never attaches", async () => {
  const h = await hubServer();
  try {
    assert.equal((await dial(h.url, { "x-metal-name": "metal0", "x-metal-token": "wrong" })).state, 401);
    assert.equal((await dial(h.url, { "x-metal-name": "other", "x-metal-token": TOKEN })).state, 401);
    // a name is a routing key (tunnel://<name>, /t/<name>/…): only plain labels
    assert.equal((await dial(h.url, { "x-metal-name": "me/../tal", "x-metal-token": TOKEN })).state, 400);
    assert.equal((await dial(h.url, { "x-metal-name": "", "x-metal-token": TOKEN })).state, 400);
    const ok = await dial(h.url, { "x-metal-name": "metal0", "x-metal-token": TOKEN });
    assert.equal(ok.state, "open");
    await settle();
    assert.equal(h.hub.count(), 1);
    ok.ws.close();
  } finally { await h.close(); }
});

test("tunnel: only a SELF-ROUTED publicUrl is honored — a box cannot claim another enclave's endpoint", async () => {
  const h = await hubServer();
  try {
    const { ws } = await dial(h.url, { "x-metal-name": "metal0", "x-metal-token": TOKEN });
    await settle();
    const pub = () => h.hub.origins()[0].publicUrl;

    // the shape a CGNAT seller registers on chain (`enclave host`)
    ws.send(JSON.stringify({ t: "hello", publicUrl: "https://api.enclave.host/t/metal0" }));
    await settle();
    assert.equal(pub(), "https://api.enclave.host/t/metal0");

    // …and everything that would let it stand in for somebody else
    for (const claim of ["https://kryptos.enclave.host",            // a first-party enclave
                         "https://api.enclave.host/t/other",        // another tunnel's route
                         "https://api.enclave.host/t/metal0/../x",  // path games
                         "http://api.enclave.host/t/metal0",        // downgrade
                         "https://api.enclave.host/t/metal0?a=1"]) {
      ws.send(JSON.stringify({ t: "hello", publicUrl: claim }));
      await settle();
      assert.equal(pub(), "", `claimed ${claim}`);
      ws.send(JSON.stringify({ t: "hello", publicUrl: "https://api.enclave.host/t/metal0" }));
      await settle();
    }
    ws.close();
  } finally { await h.close(); }
});

test("tunnel: attestation attach cannot take a token-reserved name", async () => {
  const h = await hubServer({ attest: { allowedMeasurements: [MEAS], requireVcek: false } });
  try {
    // no token + attest mode on = the attestation path; metal0 belongs to the token
    assert.equal((await dial(h.url, { "x-metal-name": "metal0" })).state, 401);
    assert.equal((await dial(h.url, { "x-metal-name": "metal0", "x-metal-attest": "1" })).state, 401);
    // an unreserved name still gets its challenge (and attaches only after a quote)
    const r = await dial(h.url, { "x-metal-name": "seller7", "x-metal-attest": "1" });
    assert.equal(r.state, "open");
    await settle();
    assert.equal(r.frames[0]?.t, "challenge");
    assert.equal(typeof r.frames[0].nonce, "string");
    assert.equal(h.hub.count(), 0, "unverified peer must not be in the fleet");
    r.ws.close();
  } finally { await h.close(); }
});

// ---------- a name belongs to the key that registered it ----------------------
// A quote proves the IMAGE, never which box it is - every seller runs the same
// published release - and the metal transport key is minted PER BOOT, so
// neither is an identity that survives a reboot. That left a window: while a
// seller was down, another box running the same release could take its name and
// inherit the routing for keccak(https://<relay>/t/<name>), the id its own
// on-chain registration carries. The registry OPERATOR key is what survives, so
// a registered name now demands a signature from it.
// A RAD document the hub will accept: a quote whose report_data binds the
// transport key to THIS attach's nonce, i.e. what a real agent sends.
const radFor = (nonce) => ({
  format: "sev-snp-guest/v2",
  body: report({ reportData: createHash("sha256").update(Buffer.concat([SPKI, nonce])).digest() }).toString("base64"),
  transportKey: SPKI.toString("base64"),
});

const { privateKeyToAccount } = await import("viem/accounts");
const OWNER = privateKeyToAccount("0x" + "11".repeat(32));
const OTHER = privateKeyToAccount("0x" + "22".repeat(32));

// Drive a full attest handshake: dial, read the challenge, answer with a quote
// (+ optional operator signature), and report the hub's verdict.
async function attestAttach(h, name, { signer = null, quoteNonceFrom = (n) => n } = {}) {
  const r = await dial(h.url, { "x-metal-name": name, "x-metal-attest": "1" });
  if (r.state !== "open") return { state: r.state };
  await settle();
  const ch = r.frames.find((f) => f.t === "challenge");
  const nonce = Buffer.from(ch.nonce, "base64");
  const rad = radFor(quoteNonceFrom(nonce));
  const frame = { t: "attest", rad };
  if (signer) frame.operatorSig = await signer.signMessage({
    message: `enclave-tunnel-attach:${name}:${nonce.toString("base64")}` });
  r.ws.send(JSON.stringify(frame));
  const res = await waitResult(r.frames);
  try { r.ws.close(); } catch {}
  return { state: "open", ok: !!res?.ok, reason: res?.reason || "(no verdict)" };
}

// Wait for the hub's verdict rather than sleeping at it: the owner check runs a
// dynamic `import("viem")`, and the FIRST one in a process is slow enough that a
// fixed settle() read an empty frame list and called it a refusal.
async function waitResult(frames, ms = 8000) {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    const f = frames.find((x) => x.t === "attest-result");
    if (f) return f;
    await new Promise((r) => setTimeout(r, 25));
  }
  return null;
}

test("tunnel: a REGISTERED name demands the operator key that registered it", async () => {
  const h = await hubServer({ attest: { allowedMeasurements: [MEAS], requireVcek: false },
                              operatorFor: async (n) => (n === "seller7" ? OWNER.address : null) });
  try {
    // the owner attaches: image proven by the quote, identity by the signature
    const good = await attestAttach(h, "seller7", { signer: OWNER });
    assert.equal(good.ok, true, `owner must attach: ${good.reason}`);
    assert.equal(h.hub.count(), 1);
    await settle();

    // a stranger running the SAME published image cannot take the name
    const thief = await attestAttach(h, "seller7", { signer: OTHER });
    assert.equal(thief.ok, false);
    assert.match(thief.reason, /registered on chain to/i);

    // ...nor by simply omitting the proof
    const silent = await attestAttach(h, "seller7");
    assert.equal(silent.ok, false);
    assert.match(silent.reason, /operatorSig/i);
  } finally { await h.close(); }
});

test("tunnel: an UNREGISTERED name stays first-come (nothing to take yet)", async () => {
  const h = await hubServer({ attest: { allowedMeasurements: [MEAS], requireVcek: false },
                              operatorFor: async () => null });
  try {
    const r = await attestAttach(h, "brand-new");
    assert.equal(r.ok, true, `an unowned name needs no signature: ${r.reason}`);
  } finally { await h.close(); }
});

test("tunnel: a lookup failure fails CLOSED against a name we have seen owned", async () => {
  // An RPC blip must not become the way in. Once the hub has resolved an owner
  // for a name, a later failure falls back to it rather than opening the name.
  let mode = "ok";
  const h = await hubServer({ attest: { allowedMeasurements: [MEAS], requireVcek: false },
                              operatorFor: async (n) => {
                                if (mode === "down") throw new Error("rpc down");
                                return n === "seller7" ? OWNER.address : null;
                              } });
  try {
    assert.equal((await attestAttach(h, "seller7", { signer: OWNER })).ok, true);
    await settle();
    mode = "down";
    const thief = await attestAttach(h, "seller7", { signer: OTHER });
    assert.equal(thief.ok, false, "a known owner must survive an unreadable registry");
    // and a name we have never resolved is still first-come while the chain is out
    const fresh = await attestAttach(h, "never-seen");
    assert.equal(fresh.ok, true);
  } finally { await h.close(); }
});

test("tunnel: the signature is bound to THIS attach's nonce and name", async () => {
  const h = await hubServer({ attest: { allowedMeasurements: [MEAS], requireVcek: false },
                              operatorFor: async () => OWNER.address });
  try {
    // a signature over another name's message is not this name's proof
    const r = await dial(h.url, { "x-metal-name": "seller7", "x-metal-attest": "1" });
    await settle();
    const ch = r.frames.find((f) => f.t === "challenge");
    const nonce = Buffer.from(ch.nonce, "base64");
    const wrongName = await OWNER.signMessage({
      message: `enclave-tunnel-attach:someone-else:${nonce.toString("base64")}` });
    r.ws.send(JSON.stringify({ t: "attest", rad: radFor(nonce), operatorSig: wrongName }));
    const res = await waitResult(r.frames);
    assert.equal(res?.ok, false, "a signature for another name must not attach this one");
    try { r.ws.close(); } catch {}

    // a signature over a STALE nonce likewise (replay of an old attach)
    const stale = await attestAttach(h, "seller7", {
      signer: { signMessage: () => OWNER.signMessage({
        message: `enclave-tunnel-attach:seller7:${Buffer.alloc(32, 9).toString("base64")}` }) } });
    assert.equal(stale.ok, false, "a replayed signature must not attach");
  } finally { await h.close(); }
});
